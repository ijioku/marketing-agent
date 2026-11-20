// Campaigns: pick an audience, let the AI write one email per person,
// the owner reviews/edits/approves, then approved emails are sent.
// Nothing is ever sent without approval.
import crypto from 'node:crypto';
import { load, save } from './store.js';
import { getBusiness } from './businesses.js';
import { selectAudience, listContacts, canEmail } from './contacts.js';
import { writeCampaignEmail, CAMPAIGN_GOALS } from './ai.js';
import { sendEmail, withFooter, mailerInfo } from './mailer.js';

const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const DAILY_LIMIT = Number(process.env.SEND_DAILY_LIMIT) || 100;
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS ?? 1500);

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function updateCampaign(id, patch) {
  const all = load('campaigns', []);
  const c = all.find((x) => x.id === id);
  if (!c) return null;
  Object.assign(c, patch, { updatedAt: now() });
  save('campaigns', all);
  return c;
}

function saveMessage(message) {
  const all = load('campaign_messages', []);
  const i = all.findIndex((m) => m.id === message.id);
  if (i >= 0) all[i] = message;
  else all.push(message);
  save('campaign_messages', all);
}

export function previewAudience(businessId, audience) {
  return selectAudience(businessId, audience).length;
}

// Referral emails end with the customer's personal invite link plus a one-tap
// WhatsApp share, so passing it on takes seconds.
export function inviteUrl(code) {
  return `${PUBLIC_URL}/r/${code}`;
}

function referralBlock(biz, contact) {
  const url = inviteUrl(contact.referralCode);
  const shareText = `I love ${biz.name}! Use my invite link${biz.referralOffer ? ` (${biz.referralOffer.replace(/\.$/, '').toLowerCase()})` : ''}: ${url}`;
  return `\n\n${url}\n\nShare it on WhatsApp in one tap: https://wa.me/?text=${encodeURIComponent(shareText)}`;
}

export function createCampaign(businessId, { name, goal, notes, audience = {} }) {
  if (!CAMPAIGN_GOALS[goal]) throw new Error('Pick a campaign goal.');
  if (goal === 'referral' && !getBusiness(businessId)?.referralOffer) {
    throw new Error('Add a referral offer in Business setup first (what the customer and their friend get).');
  }
  const clean = {
    tag: String(audience.tag || '').trim().slice(0, 40),
    inactiveDays: Math.max(0, Math.min(3650, Number(audience.inactiveDays) || 0)),
  };
  const recipients = selectAudience(businessId, clean);
  if (!recipients.length) throw new Error('No contacts match this audience (people who unsubscribed or have no consent are excluded).');

  const campaign = {
    id: crypto.randomUUID(),
    businessId,
    name: String(name || CAMPAIGN_GOALS[goal].label).slice(0, 120),
    goal,
    notes: String(notes || '').slice(0, 1000),
    audience: clean,
    status: 'generating',
    total: recipients.length,
    createdAt: now(),
  };
  const all = load('campaigns', []);
  all.push(campaign);
  save('campaigns', all);

  // Write emails in the background; the dashboard polls for progress.
  generateDrafts(campaign, recipients).catch((err) => {
    console.error('[campaign] generation failed:', err);
    updateCampaign(campaign.id, { status: 'review', error: err.message });
  });
  return campaign;
}

async function generateDrafts(campaign, recipients) {
  const biz = getBusiness(campaign.businessId);
  for (const contact of recipients) {
    const email = await writeCampaignEmail(biz, campaign.goal, contact, campaign.notes);
    if (campaign.goal === 'referral') {
      // Strip any link the AI wrote anyway, then add the real personal one.
      email.body = email.body.replace(/https?:\/\/\S+/g, '').trim() + referralBlock(biz, contact);
    }
    saveMessage({
      referralCode: campaign.goal === 'referral' ? contact.referralCode : undefined,
      id: crypto.randomUUID(),
      campaignId: campaign.id,
      businessId: campaign.businessId,
      contactId: contact.id,
      to: contact.email,
      toName: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
      subject: email.subject,
      body: email.body,
      status: 'review',
      createdAt: now(),
    });
  }
  updateCampaign(campaign.id, { status: 'review' });
}

function messagesFor(campaignId) {
  return load('campaign_messages', []).filter((m) => m.campaignId === campaignId);
}

function countBy(messages) {
  const counts = { review: 0, approved: 0, skipped: 0, sent: 0, failed: 0 };
  for (const m of messages) counts[m.status] = (counts[m.status] || 0) + 1;
  return counts;
}

export function listCampaigns(businessId) {
  const messages = load('campaign_messages', []);
  return load('campaigns', [])
    .filter((c) => c.businessId === businessId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((c) => ({ ...c, counts: countBy(messages.filter((m) => m.campaignId === c.id)) }));
}

export function getCampaign(id) {
  const c = load('campaigns', []).find((x) => x.id === id);
  if (!c) return null;
  const messages = messagesFor(id);
  return { ...c, counts: countBy(messages), messages };
}

export function updateMessage(id, { subject, body, status }) {
  const all = load('campaign_messages', []);
  const m = all.find((x) => x.id === id);
  if (!m) throw new Error('Message not found');
  if (m.status === 'sent') throw new Error('Already sent');
  if (typeof subject === 'string' && subject.trim()) m.subject = subject.trim().slice(0, 120);
  if (typeof body === 'string' && body.trim()) m.body = body.trim().slice(0, 3000);
  if (status) {
    if (!['review', 'approved', 'skipped'].includes(status)) throw new Error('Bad status');
    m.status = status;
  }
  m.updatedAt = now();
  save('campaign_messages', all);
  return m;
}

export function approveAll(campaignId) {
  const all = load('campaign_messages', []);
  let n = 0;
  for (const m of all) {
    if (m.campaignId === campaignId && m.status === 'review') {
      m.status = 'approved';
      m.updatedAt = now();
      n++;
    }
  }
  save('campaign_messages', all);
  return n;
}

// Each business sends from its own address, so the daily limit is per business.
function sentToday(businessId) {
  const today = new Date().toISOString().slice(0, 10);
  return load('campaign_messages', []).filter((m) => m.businessId === businessId && m.status === 'sent' && (m.sentAt || '').startsWith(today)).length;
}

export function startSending(campaignId) {
  const campaign = load('campaigns', []).find((c) => c.id === campaignId);
  if (!campaign) throw new Error('Campaign not found');
  if (campaign.status === 'sending') throw new Error('Already sending');
  if (!mailerInfo().ready) throw new Error('Email provider is not configured yet. See .env.example.');
  const approved = messagesFor(campaignId).filter((m) => m.status === 'approved');
  if (!approved.length) throw new Error('Approve at least one email first.');
  const remaining = DAILY_LIMIT - sentToday(campaign.businessId);
  if (remaining <= 0) throw new Error(`Daily sending limit (${DAILY_LIMIT}) reached. This protects your sender reputation. Try again tomorrow.`);

  updateCampaign(campaignId, { status: 'sending' });
  sendApproved(campaign, approved.slice(0, remaining)).catch((err) => {
    console.error('[campaign] send failed:', err);
    updateCampaign(campaignId, { status: 'review', error: err.message });
  });
  return { queued: Math.min(approved.length, remaining), limitedBy: approved.length > remaining ? DAILY_LIMIT : null };
}

async function sendApproved(campaign, messages) {
  const biz = getBusiness(campaign.businessId);
  const live = mailerInfo().live;
  const contacts = new Map(listContacts(campaign.businessId).map((c) => [c.id, c])); // read once, not per email
  for (const queued of messages) {
    // Re-read the message right before sending: the owner may have edited or skipped it meanwhile.
    const m = messagesFor(campaign.id).find((x) => x.id === queued.id);
    if (!m || m.status !== 'approved') continue;
    const contact = contacts.get(m.contactId);
    // Re-check right before sending: they may have unsubscribed since the draft was written.
    if (!contact || !canEmail(contact)) {
      saveMessage({ ...m, status: 'skipped', error: 'Unsubscribed or no consent', updatedAt: now() });
      continue;
    }
    const unsubscribeUrl = `${PUBLIC_URL}/u/${contact.unsubscribeToken}`;
    try {
      const providerId = await sendEmail({
        to: m.to,
        toName: m.toName,
        fromName: biz.name,
        replyTo: biz.email,
        subject: m.subject,
        text: withFooter(m.body, biz, unsubscribeUrl),
        unsubscribeUrl,
      });
      saveMessage({ ...m, status: 'sent', sentAt: now(), providerId, error: undefined });
    } catch (err) {
      saveMessage({ ...m, status: 'failed', error: err.message, updatedAt: now() });
    }
    if (live) await sleep(SEND_DELAY_MS); // go slow so providers don't flag you as spam
  }
  const counts = countBy(messagesFor(campaign.id));
  updateCampaign(campaign.id, { status: counts.approved || counts.review ? 'review' : 'done' });
}
