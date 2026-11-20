import express from 'express';
import path from 'node:path';
import { getBusiness, listBusinesses, saveBusiness, publicProfile, isValidId } from './lib/businesses.js';
import { getConversation, appendMessages, listConversations, upsertLead, listLeads, updateLeadStatus, addReferralLead, referralCounts, getLead, markFollowedUp } from './lib/store.js';
import { chatReply, draftMessage, draftKinds, aiInfo, CAMPAIGN_GOALS } from './lib/ai.js';
import { importContacts, listContacts, deleteContacts, unsubscribeByToken, getContactByReferralCode, backfillReferralCodes } from './lib/contacts.js';
import { previewAudience, createCampaign, listCampaigns, getCampaign, updateMessage, approveAll, startSending } from './lib/campaigns.js';
import { mailerInfo, sendEmail } from './lib/mailer.js';
import { socialInfo, verifyChallenge, isValidSignature, extractMessages, isDuplicate, sendReply } from './lib/social.js';
import {
  safeEqual,
  isWeakPassword,
  loginLockStatus,
  recordLoginFailure,
  recordLoginSuccess,
  createSession,
  isValidSession,
  destroySession,
  readCookie,
  sessionCookie,
  SESSION_COOKIE,
  rateLimiter,
  securityHeaders,
} from './lib/security.js';

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const FOLLOW_UP_AFTER_HOURS = Math.max(1, Number(process.env.FOLLOW_UP_AFTER_HOURS) || 24);

// Refuse to go live with a guessable password.
if (IS_PRODUCTION && isWeakPassword(ADMIN_PASSWORD)) {
  console.error('Refusing to start: set a strong ADMIN_PASSWORD (10+ characters, not "changeme") in .env.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by'); // don't advertise what the server runs on
// Behind a hosting proxy (Render, Railway…), trust it so we see visitors' real IPs.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

app.use(securityHeaders);

// ---------- Public (widget) API ----------
// The chat widget runs on client websites, so this API allows other origins.
// It never uses cookies, and bodies are kept small.

app.use('/api/public', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/api/public', express.json({ limit: '16kb' }));

app.get('/api/public/business/:id', (req, res) => {
  const biz = getBusiness(req.params.id);
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  res.json(publicProfile(biz));
});

// Stops one visitor (or a bot) from spamming the chat and running up AI costs.
const chatPerIp = rateLimiter({ windowMs: 5 * 60_000, max: 30 });
const chatPerSession = rateLimiter({ windowMs: 24 * 60 * 60_000, max: 150 });

app.post('/api/public/chat', async (req, res) => {
  const { businessId, sessionId, message } = req.body || {};
  if (!isValidId(businessId)) return res.status(400).json({ error: 'Bad business id' });
  if (typeof sessionId !== 'string' || !/^[\w-]{8,64}$/.test(sessionId)) return res.status(400).json({ error: 'Bad session id' });
  if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'Empty message' });

  const ipLimit = chatPerIp(req.ip);
  const sessionLimit = chatPerSession(`${businessId}:${sessionId}`);
  if (!ipLimit.allowed || !sessionLimit.allowed) {
    res.set('Retry-After', String(ipLimit.allowed ? sessionLimit.retryAfterSec : ipLimit.retryAfterSec));
    return res.status(429).json({ reply: "You're sending messages very quickly. Please wait a few minutes and try again." });
  }

  const biz = getBusiness(businessId);
  if (!biz) return res.status(404).json({ error: 'Business not found' });

  const text = message.trim().slice(0, 1000);
  const { messages: history } = getConversation(businessId, sessionId);
  const result = await chatReply(biz, history, text);

  appendMessages(businessId, sessionId, [
    { role: 'user', content: text },
    { role: 'assistant', content: result.reply },
  ]);
  const { lead, created } = upsertLead(businessId, sessionId, result.lead || {});
  if (created) notifyOwner(biz, lead);

  res.json({ reply: result.reply });
});

// ---------- WhatsApp & Instagram auto-replies ----------
// Meta calls this webhook for every new message. See lib/social.js and README.

app.get('/webhooks/meta', (req, res) => {
  const challenge = verifyChallenge(req.query);
  if (challenge === null) return res.sendStatus(403);
  res.type('text/plain').send(challenge);
});

const socialPerSender = rateLimiter({ windowMs: 5 * 60_000, max: 20 });

app.post('/webhooks/meta', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  // Reject anything not signed by Meta with our app secret.
  if (!Buffer.isBuffer(req.body) || !isValidSignature(req.body, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }
  res.sendStatus(200); // answer Meta right away; reply to customers in the background
  for (const msg of extractMessages(payload)) {
    if (isDuplicate(msg.id)) continue;
    handleSocialMessage(msg).catch((err) => console.error(`[${msg.channel}] reply failed:`, err.message));
  }
});

async function handleSocialMessage(msg) {
  const biz = getBusiness(msg.businessId);
  if (!biz) return;
  const sessionId = `${msg.channel === 'whatsapp' ? 'wa' : 'ig'}-${msg.from}`;
  if (!socialPerSender(`${msg.businessId}:${sessionId}`).allowed) return; // ignore floods
  if (!msg.text.trim()) {
    return sendReply(msg, "Thanks for your message! I can only read text right now. Please type your question and I'll help.");
  }
  const text = msg.text.trim().slice(0, 1000);
  const { messages: history } = getConversation(biz.id, sessionId);
  const result = await chatReply(biz, history, text);
  appendMessages(biz.id, sessionId, [{ role: 'user', content: text }, { role: 'assistant', content: result.reply }], msg.channel);

  // Save the inquiry BEFORE replying, so it's never lost if Meta's API fails.
  // On WhatsApp we already know their number, but a lone "hi" or spam shouldn't
  // alert the owner: wait until they say something meaningful (the AI found an
  // interest, name or email) or send a second message.
  const fields = { ...(result.lead || {}) };
  const meaningful = Boolean(fields.interest || fields.name || fields.email || fields.phone) || history.some((m) => m.role === 'user');
  if (msg.channel === 'whatsapp' && meaningful) {
    fields.phone = fields.phone || `+${msg.from}`;
    fields.name = fields.name || msg.name;
  }
  const { lead, created } = upsertLead(biz.id, sessionId, fields, msg.channel);
  if (created) notifyOwner(biz, lead);

  await sendReply(msg, result.reply);
}

// ---------- Instant owner alerts ----------
// The faster a business replies to a new inquiry, the more likely it becomes a
// customer, so the owner is emailed the moment someone leaves their details.
// (In test mode the alert is saved to data/outbox.json like every other email.)

function notifyOwner(biz, lead) {
  const SOURCES = { referral: 'referral', whatsapp: 'WhatsApp', instagram: 'Instagram', chat: 'website chat' };
  console.log(`[inquiry] ${biz.name}: new ${SOURCES[lead.source] || 'website chat'} inquiry`);
  if (!biz.email) return;
  const how = {
    referral: `They were invited by your customer ${lead.referredByName}.`,
    whatsapp: 'They messaged you on WhatsApp and the assistant replied.',
    instagram: 'They messaged you on Instagram and the assistant replied.',
  }[lead.source] || 'They chatted with your website assistant.';
  const lines = [
    `New inquiry for ${biz.name}! ${how}`,
    '',
    `Name: ${lead.name || '(not given)'}`,
    `Phone: ${lead.phone || '(not given)'}`,
    `Email: ${lead.email || '(not given)'}`,
    `Interested in: ${lead.interest || '(not given)'}`,
    '',
    'Reply quickly: people who hear back within minutes are far more likely to book.',
  ];
  sendEmail({ to: biz.email, toName: biz.name, fromName: 'Marketing Agent', subject: `New inquiry: ${lead.name || lead.phone || lead.email}`, text: lines.join('\n') }).catch((err) =>
    console.error('[inquiry] owner alert failed:', err.message)
  );
}

// ---------- Referral invite page ----------
// A customer's personal link: /r/ADAEZE-K7Q2. Their friend sees the offer and
// leaves their details; the business gets a new inquiry marked "referred by Adaeze".

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function invitePage(biz, referrer, { body, title }) {
  const color = /^#[0-9a-fA-F]{6}$/.test(biz.brandColor || '') ? biz.brandColor : '#2563eb';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--text:#111827;--muted:#6b7280;--line:#e5e7eb;--brand:${color}}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f17;--card:#131a24;--text:#e6e9ef;--muted:#8b95a7;--line:#263042}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:grid;place-items:center;padding:16px}
.c{background:var(--card);border:1px solid var(--line);border-radius:16px;max-width:440px;width:100%;overflow:hidden}
.top{background:var(--brand);color:#fff;padding:24px 22px}.top small{opacity:.85}.top h1{margin:6px 0 0;font-size:24px;line-height:1.2}
.in{padding:20px 22px}.offer{border:2px dashed var(--brand);border-radius:12px;padding:14px;margin:0 0 16px;font-weight:600;font-size:17px}
label{display:block;font-weight:600;margin:12px 0 4px;font-size:14px}input{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:16px;background:var(--bg);color:var(--text)}
button,.btn{display:block;width:100%;text-align:center;background:var(--brand);color:#fff;border:0;border-radius:10px;padding:14px;font-size:16px;font-weight:700;margin-top:16px;cursor:pointer;text-decoration:none}
.muted{color:var(--muted);font-size:13px}.hp{position:absolute;left:-9999px}.err{color:#dc2626;font-weight:600}
</style></head><body><div class="c"><div class="top"><small>${escapeHtml(referrer.firstName || 'A friend')} invited you to</small><h1>${escapeHtml(biz.name)}</h1></div><div class="in">${body}</div></div></body></html>`;
}

const referralLimit = rateLimiter({ windowMs: 15 * 60_000, max: 20 });
app.use('/r', express.urlencoded({ extended: false, limit: '4kb' }));

app.get('/r/:code', (req, res) => {
  const referrer = getContactByReferralCode(req.params.code);
  const biz = referrer && getBusiness(referrer.businessId);
  if (!biz) return res.status(404).send(page('Invite not found', '<h2>Invite link not found</h2><p>Please check the link and try again.</p>'));
  const services = (biz.services || []).slice(0, 4).map((s) => `${escapeHtml(s.name)}${s.price ? ` · ${escapeHtml(s.price)}` : ''}`).join('<br>');
  res.send(
    invitePage(biz, referrer, {
      title: `${referrer.firstName || 'A friend'} invited you to ${biz.name}`,
      body: `<div class="offer">🎁 ${escapeHtml(biz.referralOffer || 'A special welcome offer')}</div>
<p>${escapeHtml(biz.tagline || '')}</p>
${services ? `<p class="muted">${services}</p>` : ''}
<form method="post" action="/r/${escapeHtml(referrer.referralCode)}">
<label for="name">Your name</label><input id="name" name="name" required maxlength="80" autocomplete="name">
<label for="phone">Phone or WhatsApp number</label><input id="phone" name="phone" maxlength="40" autocomplete="tel" inputmode="tel">
<label for="email">Email <span class="muted">(optional if you gave a phone)</span></label><input id="email" name="email" type="email" maxlength="120" autocomplete="email">
<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<button>Claim my offer</button>
<p class="muted">${escapeHtml(biz.name)} will contact you to book. Your details are only shared with them.</p>
</form>`,
    })
  );
});

app.post('/r/:code', (req, res) => {
  const referrer = getContactByReferralCode(req.params.code);
  const biz = referrer && getBusiness(referrer.businessId);
  if (!biz) return res.status(404).send(page('Invite not found', '<h2>Invite link not found</h2>'));
  if (!referralLimit(req.ip).allowed) return res.status(429).send(page('Slow down', '<h2>Too many requests</h2><p>Please try again later.</p>'));

  const { name = '', phone = '', email = '', website = '' } = req.body || {};
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
  const validPhone = String(phone).replace(/\D/g, '').length >= 7;
  // "website" is an invisible field: humans leave it empty, spam bots fill it in.
  if (!website && String(name).trim() && (validPhone || validEmail)) {
    const lead = addReferralLead(biz.id, referrer, { name: String(name), phone: validPhone ? String(phone) : '', email: validEmail ? String(email) : '' });
    if (lead) notifyOwner(biz, lead); // null = already an inquiry; still show the friendly page
  } else if (!website) {
    return res.status(400).send(
      invitePage(biz, referrer, {
        title: 'Please check your details',
        body: `<p class="err">Please enter your name and a phone number or email.</p><a class="btn" href="/r/${escapeHtml(referrer.referralCode)}">Go back</a>`,
      })
    );
  }
  res.send(
    invitePage(biz, referrer, {
      title: 'Offer claimed',
      body: `<h2 style="margin-top:0">You're in! 🎉</h2><p>${escapeHtml(biz.name)} has your details and will contact you to book. Your offer: <b>${escapeHtml(biz.referralOffer || 'welcome offer')}</b>.</p>
${/^https?:\/\//i.test(biz.bookingLink || '') ? `<a class="btn" href="${escapeHtml(biz.bookingLink)}" rel="noopener">Book now</a>` : ''}`,
    })
  );
});

// ---------- Static files and pages ----------

app.use(express.static(PUBLIC_DIR, { index: false }));
app.get('/demo/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'demo.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/', (req, res) => res.redirect('/admin'));

// Unsubscribe link in every campaign email. GET shows a confirm button
// (so link scanners can't unsubscribe people by accident); POST does it,
// which also supports one-click unsubscribe from Gmail/Outlook.
// `body` must be trusted HTML (only fixed text is passed in); the title is always escaped.
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;background:#f5f6f8;color:#111827;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}
.c{background:#fff;border-radius:14px;padding:28px;max-width:420px;text-align:center;box-shadow:0 4px 18px rgba(0,0,0,.08)}
button{background:#111827;color:#fff;border:0;border-radius:8px;padding:11px 20px;font-size:15px;cursor:pointer;min-height:44px}
@media (prefers-color-scheme:dark){body{background:#0b0f17;color:#e6e9ef}.c{background:#131a24}button{background:#3b82f6}}</style></head>
<body><div class="c">${body}</div></body></html>`;

const unsubscribeLimit = rateLimiter({ windowMs: 15 * 60_000, max: 60 });
app.use('/u', express.urlencoded({ extended: false, limit: '4kb' }), (req, res, next) => {
  if (!unsubscribeLimit(req.ip).allowed) return res.status(429).send(page('Slow down', '<h2>Too many requests</h2><p>Please try again later.</p>'));
  next();
});

app.get('/u/:token', (req, res) => {
  const token = String(req.params.token).replace(/[^a-f0-9]/g, '').slice(0, 32);
  res.send(page('Unsubscribe', `<h2>Unsubscribe?</h2><p>You'll stop getting marketing emails from this business.</p>
    <form method="post" action="/u/${token}"><button>Yes, unsubscribe me</button></form>`));
});

app.post('/u/:token', (req, res) => {
  const contact = unsubscribeByToken(req.params.token);
  res.send(page('Unsubscribed', contact ? `<h2>You're unsubscribed</h2><p>You won't get any more marketing emails from us. Sorry to see you go!</p>` : `<h2>Link not found</h2><p>This unsubscribe link is invalid or expired.</p>`));
});

// ---------- Owner dashboard: login ----------

app.use('/api/admin', express.json({ limit: '2mb' })); // room for contact CSV uploads

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  const lock = loginLockStatus(ip);
  if (lock.locked) {
    res.set('Retry-After', String(lock.retryAfterSec));
    return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute(s).`, retryAfterSec: lock.retryAfterSec });
  }

  if (!safeEqual(req.body?.password ?? '', ADMIN_PASSWORD)) {
    const r = recordLoginFailure(ip);
    console.warn(`[security] failed login from ${ip}${r.locked ? ' (now locked)' : ''}`);
    if (r.locked) {
      res.set('Retry-After', String(r.retryAfterSec));
      return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(r.retryAfterSec / 60)} minute(s).`, retryAfterSec: r.retryAfterSec });
    }
    return res.status(401).json({ error: `Wrong password. ${r.attemptsLeft} attempt(s) left before a 15-minute lock.` });
  }

  recordLoginSuccess(ip);
  const { token, maxAgeSec } = createSession();
  res.set('Set-Cookie', sessionCookie(token, maxAgeSec, req.secure));
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  destroySession(readCookie(req, SESSION_COOKIE));
  res.set('Set-Cookie', sessionCookie('', 0, req.secure));
  res.json({ ok: true });
});

// ---------- Owner dashboard API (signed in only) ----------

const admin = express.Router();

admin.use((req, res, next) => {
  if (!isValidSession(readCookie(req, SESSION_COOKIE))) return res.status(401).json({ error: 'Please sign in.' });
  // Extra CSRF guard: changes must come from this site, as JSON.
  if (req.method !== 'GET') {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Blocked: request came from another website.' });
    if (req.method !== 'DELETE' && !req.is('application/json')) return res.status(415).json({ error: 'Expected JSON.' });
  }
  next();
});

admin.get('/status', (req, res) =>
  res.json({
    ai: aiInfo(),
    email: mailerInfo(),
    draftKinds,
    campaignGoals: Object.fromEntries(Object.entries(CAMPAIGN_GOALS).map(([k, v]) => [k, v.label])),
    weakPassword: isWeakPassword(ADMIN_PASSWORD),
    social: socialInfo(),
    followUpAfterHours: FOLLOW_UP_AFTER_HOURS,
  })
);
admin.get('/businesses', (req, res) => res.json(listBusinesses()));

admin.get('/businesses/:id', (req, res) => {
  const biz = getBusiness(req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  res.json(biz);
});

admin.post('/businesses', (req, res) => {
  try {
    res.json(saveBusiness(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

admin.get('/businesses/:id/leads', (req, res) => res.json(listLeads(req.params.id)));
admin.get('/businesses/:id/conversations', (req, res) => res.json(listConversations(req.params.id)));

admin.patch('/leads/:id', (req, res) => {
  const lead = updateLeadStatus(req.params.id, req.body?.status);
  if (!lead) return res.status(400).json({ error: 'Could not update lead' });
  res.json(lead);
});

// ----- Follow-ups for inquiries who haven't booked -----
// Many people ask once and never hear back. The dashboard flags inquiries that
// have waited too long; the owner gets an AI-written follow-up to send by email
// (from here) or by WhatsApp (opens their own WhatsApp with the message ready).

// Turn "0803 555 0199" into "2348035550199" for WhatsApp links, using the
// business's own country code ("+234 800 ...") when the number starts with 0.
function whatsappNumber(phone, biz) {
  const raw = String(phone || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (!raw.startsWith('+') && digits.startsWith('0')) {
    const cc = String(biz.phone || '').match(/^\+(\d{1,3})[\s-]/)?.[1];
    if (!cc) return '';
    digits = cc + digits.slice(1);
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

admin.post('/leads/:id/follow-up/draft', async (req, res) => {
  const lead = getLead(req.params.id);
  const biz = lead && getBusiness(lead.businessId);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  try {
    const d = await draftMessage(biz, 'lead_follow_up', { customerName: (lead.name || '').split(' ')[0], notes: lead.interest || '' });
    const wa = whatsappNumber(lead.phone, biz);
    res.json({ ...d, whatsappUrl: wa ? `https://wa.me/${wa}?text=${encodeURIComponent(d.sms)}` : '', canEmail: Boolean(lead.email) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

admin.post('/leads/:id/follow-up/send', async (req, res) => {
  const lead = getLead(req.params.id);
  const biz = lead && getBusiness(lead.businessId);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  const channel = req.body?.channel === 'whatsapp' ? 'whatsapp' : 'email';
  if (channel === 'email') {
    const subject = String(req.body?.subject || `Following up from ${biz.name}`).slice(0, 120);
    const text = String(req.body?.text || '').trim().slice(0, 3000);
    if (!lead.email) return res.status(400).json({ error: 'This person has no email address.' });
    if (!text) return res.status(400).json({ error: 'Write a message first.' });
    try {
      const signature = [`— ${biz.name}`, biz.address].filter(Boolean).join('\n');
      await sendEmail({ to: lead.email, toName: lead.name, fromName: biz.name, replyTo: biz.email, subject, text: `${text}\n\n${signature}` });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  // For WhatsApp the owner sends it from their own phone; we just record it.
  res.json(markFollowedUp(lead.id, channel));
});

admin.post('/businesses/:id/draft', async (req, res) => {
  const biz = getBusiness(req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  try {
    const { kind, customerName, notes } = req.body || {};
    res.json(await draftMessage(biz, kind, { customerName: String(customerName || '').slice(0, 80), notes: String(notes || '').slice(0, 500) }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----- Contacts -----

const withBiz = (handler) => (req, res) => {
  const biz = getBusiness(req.params.id);
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  try {
    res.json(handler(biz, req));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

admin.get(
  '/businesses/:id/contacts',
  withBiz((biz) => {
    const counts = referralCounts(biz.id);
    return listContacts(biz.id).map((c) => ({ ...c, referrals: counts[c.id] || 0 }));
  })
);
admin.post('/businesses/:id/contacts/import', withBiz((biz, req) => importContacts(biz.id, String(req.body?.csv || ''))));
admin.delete('/businesses/:id/contacts', withBiz((biz) => (deleteContacts(biz.id), { ok: true })));

// ----- Campaigns -----

admin.get('/businesses/:id/audience', withBiz((biz, req) => ({ count: previewAudience(biz.id, req.query) })));
admin.get('/businesses/:id/campaigns', withBiz((biz) => listCampaigns(biz.id)));
admin.post('/businesses/:id/campaigns', withBiz((biz, req) => createCampaign(biz.id, req.body || {})));

const handle = (fn) => (req, res) => {
  try {
    const out = fn(req);
    if (out == null) return res.status(404).json({ error: 'Not found' });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

admin.get('/campaigns/:cid', handle((req) => getCampaign(req.params.cid)));
admin.post('/campaigns/:cid/approve-all', handle((req) => ({ approved: approveAll(req.params.cid) })));
admin.post('/campaigns/:cid/send', handle((req) => startSending(req.params.cid)));
admin.patch('/messages/:mid', handle((req) => updateMessage(req.params.mid, req.body || {})));

app.use('/api/admin', admin);

// ---------- Errors ----------

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Never show internal error details (file paths, stack traces) to visitors.
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

backfillReferralCodes(); // contacts imported before referrals existed get an invite code

app.listen(PORT, () => {
  const ai = aiInfo();
  console.log(`\nMarketing agent running → http://localhost:${PORT}/admin`);
  console.log(`AI mode: ${ai.enabled ? `ON (${ai.model})` : 'OFFLINE rules (add AI_API_KEY to .env for real AI)'}`);
  const mail = mailerInfo();
  console.log(`Email: ${mail.live ? `LIVE via ${mail.provider}` : mail.provider === 'log' ? 'TEST mode, emails saved to data/outbox.json, nothing is sent' : `${mail.provider} NOT configured`}`);
  if (isWeakPassword(ADMIN_PASSWORD)) console.log(`Dashboard password is weak${ADMIN_PASSWORD === 'changeme' ? ' (changeme)' : ''}. Set a strong ADMIN_PASSWORD in .env before going live.\n`);
});
