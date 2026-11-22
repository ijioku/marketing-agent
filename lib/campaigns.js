// Campaigns: pick an audience, let the AI write one email per person,
// the owner reviews/edits/approves, then approved emails are sent.
// Nothing is ever sent without approval.
// crypto: random ids.
import crypto from 'node:crypto';
// load/save: read and write stored data.
import { load, save } from './store.js';
// Read a business profile.
import { getBusiness } from './businesses.js';
// Contact helpers: pick the audience, list contacts, check who may be emailed.
import { selectAudience, listContacts, canEmail } from './contacts.js';
// The AI that writes each email, and the list of campaign goals.
import { writeCampaignEmail, CAMPAIGN_GOALS } from './ai.js';
// Email sending, the legal footer and the email settings.
import { sendEmail, withFooter, mailerInfo } from './mailer.js';
// To recognise the sample hotel (never really emails anyone).
import { isDemoBusiness } from './demo.js';

// The site's address, used in invite and unsubscribe links.
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
// At most this many emails per business per day (default 100).
const DAILY_LIMIT = Number(process.env.SEND_DAILY_LIMIT) || 100;
// Wait this long between emails (default 1.5 seconds).
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS ?? 1500);

// The time now as text.
const now = () => new Date().toISOString();
// Wait for ms milliseconds.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Change some fields of a campaign.
function updateCampaign(id, patch) {
  // Load all campaigns.
  const all = load('campaigns', []);
  // Find this one.
  const c = all.find((x) => x.id === id);
  // Unknown: null.
  if (!c) return null;
  // Apply the changes and note the time.
  Object.assign(c, patch, { updatedAt: now() });
  // Save.
  save('campaigns', all);
  // Hand it back.
  return c;
}

// Save one campaign email (replace it if it exists, otherwise add it).
function saveMessage(message) {
  // Load all emails.
  const all = load('campaign_messages', []);
  // Find its position.
  const i = all.findIndex((m) => m.id === message.id);
  // Found: replace it.
  if (i >= 0) all[i] = message;
  // Not found: add it.
  else all.push(message);
  // Save.
  save('campaign_messages', all);
}

// How many contacts match the chosen filters.
export function previewAudience(businessId, audience) {
  return selectAudience(businessId, audience).length;
}

// Referral emails end with the customer's personal invite link plus a one-tap
// WhatsApp share, so passing it on takes seconds.
// A customer's personal invite link.
export function inviteUrl(code) {
  return `${PUBLIC_URL}/r/${code}`;
}

// The invite text added to the end of referral emails.
function referralBlock(biz, contact) {
  // Their invite link.
  const url = inviteUrl(contact.referralCode);
  // A ready-made WhatsApp message they can share.
  const shareText = `I love ${biz.name}! Use my invite link${biz.referralOffer ? ` (${biz.referralOffer.replace(/\.$/, '').toLowerCase()})` : ''}: ${url}`;
  // The link, plus a WhatsApp link that opens with that message filled in.
  return `\n\n${url}\n\nShare it on WhatsApp in one tap: https://wa.me/?text=${encodeURIComponent(shareText)}`;
}

// Start a campaign.
export function createCampaign(businessId, { name, goal, notes, audience = {} }) {
  // The goal must be one we know.
  if (!CAMPAIGN_GOALS[goal]) throw new Error('Pick a campaign goal.');
  // Referral campaigns need an offer first...
  if (goal === 'referral' && !getBusiness(businessId)?.referralOffer) {
    throw new Error('Add a referral offer in Business setup first (what the customer and their friend get).');
  }
  // Clean filters:
  const clean = {
    // an optional tag (max 40 characters),
    tag: String(audience.tag || '').trim().slice(0, 40),
    // and "away for at least N days" (0 to 10 years).
    inactiveDays: Math.max(0, Math.min(3650, Number(audience.inactiveDays) || 0)),
  };
  // The contacts who match (unsubscribed or no consent are left out).
  const recipients = selectAudience(businessId, clean);
  // Nobody matches: say why.
  if (!recipients.length) throw new Error('No contacts match this audience (people who unsubscribed or have no consent are excluded).');

  // The campaign record:
  const campaign = {
    id: crypto.randomUUID(),
    businessId,
    name: String(name || CAMPAIGN_GOALS[goal].label).slice(0, 120),
    goal,
    notes: String(notes || '').slice(0, 1000),
    audience: clean,
    // Writing emails now.
    status: 'generating',
    // How many emails it will write.
    total: recipients.length,
    createdAt: now(),
  };
  // Load campaigns, add this one, save.
  const all = load('campaigns', []);
  all.push(campaign);
  save('campaigns', all);

  // Write emails in the background; the dashboard polls for progress.
  // Start writing in the background; if it fails, log it and show the error in the dashboard.
  generateDrafts(campaign, recipients).catch((err) => {
    console.error('[campaign] generation failed:', err);
    updateCampaign(campaign.id, { status: 'review', error: err.message });
  });
  // Hand back the campaign right away.
  return campaign;
}

// Write one email per recipient.
async function generateDrafts(campaign, recipients) {
  // Load the business profile.
  const biz = getBusiness(campaign.businessId);
  // For each recipient:
  for (const contact of recipients) {
    // ask the AI for a personal email.
    const email = await writeCampaignEmail(biz, campaign.goal, contact, campaign.notes);
    // Referral campaign:
    if (campaign.goal === 'referral') {
      // Strip any link the AI wrote anyway, then add the real personal one.
      email.body = email.body.replace(/https?:\/\/\S+/g, '').trim() + referralBlock(biz, contact);
    }
    // Save the email, waiting for review:
    saveMessage({
      // referral emails remember the invite code.
      referralCode: campaign.goal === 'referral' ? contact.referralCode : undefined,
      id: crypto.randomUUID(),
      campaignId: campaign.id,
      businessId: campaign.businessId,
      contactId: contact.id,
      to: contact.email,
      // Full name.
      toName: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
      subject: email.subject,
      body: email.body,
      status: 'review',
      createdAt: now(),
    });
  }
  // All written: ready for review.
  updateCampaign(campaign.id, { status: 'review' });
}

// All emails of a campaign.
function messagesFor(campaignId) {
  return load('campaign_messages', []).filter((m) => m.campaignId === campaignId);
}

// Count emails by status.
function countBy(messages) {
  // Start every status at zero.
  const counts = { review: 0, approved: 0, skipped: 0, sent: 0, failed: 0 };
  // Add one per email.
  for (const m of messages) counts[m.status] = (counts[m.status] || 0) + 1;
  // Hand back the counts.
  return counts;
}

// A business's campaigns, newest first, each with its counts.
export function listCampaigns(businessId) {
  // Load all emails once.
  const messages = load('campaign_messages', []);
  // Load campaigns...
  return load('campaigns', [])
    // ...only this business's...
    .filter((c) => c.businessId === businessId)
    // ...newest first...
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    // ...with counts added.
    .map((c) => ({ ...c, counts: countBy(messages.filter((m) => m.campaignId === c.id)) }));
}

// One campaign with its emails and counts.
export function getCampaign(id) {
  // Find it.
  const c = load('campaigns', []).find((x) => x.id === id);
  // Unknown: null.
  if (!c) return null;
  // Its emails.
  const messages = messagesFor(id);
  // Everything together.
  return { ...c, counts: countBy(messages), messages };
}

// One email by id (null if unknown).
export function getMessage(id) {
  return load('campaign_messages', []).find((m) => m.id === id) || null;
}

// Edit an email or change its status.
export function updateMessage(id, { subject, body, status }) {
  // Load all emails.
  const all = load('campaign_messages', []);
  // Find this one.
  const m = all.find((x) => x.id === id);
  // Unknown: error.
  if (!m) throw new Error('Message not found');
  // Sent emails can't be changed.
  if (m.status === 'sent') throw new Error('Already sent');
  // New subject (max 120 characters), if given.
  if (typeof subject === 'string' && subject.trim()) m.subject = subject.trim().slice(0, 120);
  // New text (max 3000 characters), if given.
  if (typeof body === 'string' && body.trim()) m.body = body.trim().slice(0, 3000);
  // New status, if given:
  if (status) {
    // only review, approved or skipped.
    if (!['review', 'approved', 'skipped'].includes(status)) throw new Error('Bad status');
    // Set it.
    m.status = status;
  }
  // Note the change.
  m.updatedAt = now();
  // Save.
  save('campaign_messages', all);
  // Hand it back.
  return m;
}

// Approve every email still waiting for review.
export function approveAll(campaignId) {
  // Load all emails.
  const all = load('campaign_messages', []);
  // How many were approved.
  let n = 0;
  // For each email:
  for (const m of all) {
    // this campaign's emails that are waiting:
    if (m.campaignId === campaignId && m.status === 'review') {
      // approve,
      m.status = 'approved';
      // note the time,
      m.updatedAt = now();
      // count it.
      n++;
    }
  }
  // Save.
  save('campaign_messages', all);
  // Report the number.
  return n;
}

// Each business sends from its own address, so the daily limit is per business.
// How many emails a business sent today.
function sentToday(businessId) {
  // Today's date.
  const today = new Date().toISOString().slice(0, 10);
  // Count this business's emails sent today.
  return load('campaign_messages', []).filter((m) => m.businessId === businessId && m.status === 'sent' && (m.sentAt || '').startsWith(today)).length;
}

// Start sending a campaign's approved emails.
export function startSending(campaignId) {
  // Find the campaign.
  const campaign = load('campaigns', []).find((c) => c.id === campaignId);
  // Unknown: error.
  if (!campaign) throw new Error('Campaign not found');
  // Already sending: error.
  if (campaign.status === 'sending') throw new Error('Already sending');
  // Is it the sample hotel?
  const demo = isDemoBusiness(campaign.businessId);
  // Real businesses need email set up.
  if (!mailerInfo().ready && !demo) throw new Error('Email provider is not configured yet. See .env.example.');
  // The approved emails.
  const approved = messagesFor(campaignId).filter((m) => m.status === 'approved');
  // None approved: error.
  if (!approved.length) throw new Error('Approve at least one email first.');
  // How many more can be sent today.
  const remaining = DAILY_LIMIT - sentToday(campaign.businessId);
  // Limit reached: error.
  if (remaining <= 0) throw new Error(`Daily sending limit (${DAILY_LIMIT}) reached. This protects your sender reputation. Try again tomorrow.`);

  // Mark it as sending.
  updateCampaign(campaignId, { status: 'sending' });
  // Send in the background (up to today's limit); on failure log it and show the error.
  sendApproved(campaign, approved.slice(0, remaining)).catch((err) => {
    console.error('[campaign] send failed:', err);
    updateCampaign(campaignId, { status: 'review', error: err.message });
  });
  // Report how many were queued, and whether the daily limit cut it short.
  return { queued: Math.min(approved.length, remaining), limitedBy: approved.length > remaining ? DAILY_LIMIT : null };
}

// Send emails one by one.
async function sendApproved(campaign, messages) {
  // Load the business.
  const biz = getBusiness(campaign.businessId);
  const demo = isDemoBusiness(campaign.businessId); // sample business: pretend to send, never email anyone
  // Really sending? (email live and not the demo)
  const live = mailerInfo().live && !demo;
  const contacts = new Map(listContacts(campaign.businessId).map((c) => [c.id, c])); // read once, not per email
  // Each queued email:
  for (const queued of messages) {
    // Re-read the message right before sending: the owner may have edited or skipped it meanwhile.
    // the latest version of it,
    const m = messagesFor(campaign.id).find((x) => x.id === queued.id);
    // skip it unless it's still approved,
    if (!m || m.status !== 'approved') continue;
    // the contact it's for.
    const contact = contacts.get(m.contactId);
    // Re-check right before sending: they may have unsubscribed since the draft was written.
    // Gone, unsubscribed or no consent:
    if (!contact || !canEmail(contact)) {
      // mark it skipped,
      saveMessage({ ...m, status: 'skipped', error: 'Unsubscribed or no consent', updatedAt: now() });
      // and move on.
      continue;
    }
    // Their unsubscribe link.
    const unsubscribeUrl = `${PUBLIC_URL}/u/${contact.unsubscribeToken}`;
    try {
      // Demo: a fake id. Otherwise really send it with the footer and unsubscribe headers.
      const providerId = demo ? `demo-${crypto.randomUUID()}` : await sendEmail({
        to: m.to,
        toName: m.toName,
        fromName: biz.name,
        replyTo: biz.email,
        subject: m.subject,
        text: withFooter(m.body, biz, unsubscribeUrl),
        unsubscribeUrl,
      });
      // Sent: record it.
      saveMessage({ ...m, status: 'sent', sentAt: now(), providerId, error: undefined });
    } catch (err) {
      // Failed: record the error.
      saveMessage({ ...m, status: 'failed', error: err.message, updatedAt: now() });
    }
    if (live) await sleep(SEND_DELAY_MS); // go slow so providers don't flag you as spam
  }
  // Count the results.
  const counts = countBy(messagesFor(campaign.id));
  // Anything still waiting means "review"; otherwise the campaign is done.
  updateCampaign(campaign.id, { status: counts.approved || counts.review ? 'review' : 'done' });
}
