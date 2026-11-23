// server.js: the main program. It starts the web server, serves every page and answers every request.
// Read it top to bottom: settings, then the public chat API, WhatsApp/Instagram, invite pages, static pages,
// sign-in, the dashboard API, error handling, and finally starting the server.
// Express is the web framework: it turns "someone opened /admin" into a call to our code.
import express from 'express';
// fs = Node's built-in file tool, used here to read admin.html once at startup.
import fs from 'node:fs';
// path = Node's built-in tool for building file paths that work on Windows and Linux.
import path from 'node:path';
// Business profiles: read, list and save each client business.
import { getBusiness, listBusinesses, saveBusiness, publicProfile, isValidId } from './lib/businesses.js';
// Storage: conversations, inquiries (leads), referrals and follow-ups.
import { initStore, getConversation, appendMessages, listConversations, upsertLead, listLeads, updateLeadStatus, addReferralLead, referralCounts, getLead, markFollowedUp } from './lib/store.js';
// The AI: chat replies, message drafts and campaign goals.
import { chatReply, draftMessage, draftKinds, aiInfo, CAMPAIGN_GOALS } from './lib/ai.js';
// The text of the privacy policy and terms pages.
import { privacyBody, termsBody } from './lib/legal.js';
// Customer contact lists: CSV import, delete, unsubscribe and invite (referral) codes.
import { importContacts, listContacts, deleteContact, deleteContacts, unsubscribeByToken, getContactByReferralCode, backfillReferralCodes } from './lib/contacts.js';
// Email campaigns: pick the audience, write emails, approve and send them.
import { previewAudience, createCampaign, listCampaigns, getCampaign, getMessage, updateMessage, approveAll, startSending } from './lib/campaigns.js';
// Email sending (test mode saves emails to a file instead of sending them).
import { mailerInfo, sendEmail } from './lib/mailer.js';
// WhatsApp and Instagram: check Meta's webhook, read incoming messages, send replies.
import { socialInfo, verifyChallenge, isValidSignature, extractMessages, isDuplicate, sendReply } from './lib/social.js';
// Security helpers: password checks, login lockout, sessions (cookies), rate limits and safety headers.
import {
  safeEqual,
  isWeakPassword,
  loginLockStatus,
  recordLoginFailure,
  recordLoginSuccess,
  createSession,
  getSessionUser,
  destroySession,
  destroySessionsWhere,
  readCookie,
  sessionCookie,
  SESSION_COOKIE,
  rateLimiter,
  securityHeaders,
} from './lib/security.js';
// Business-owner logins: check passwords, create/delete logins, password resets.
import { authenticate, listLogins, getLogin, createLogin, setPassword, deleteLogin, checkCurrentPassword, sessionUserForEmail, createResetToken, resetPasswordWithToken } from './lib/accounts.js';
// Google sign-in: checks the token Google gives the browser is genuine.
import { GOOGLE_CLIENT_ID, verifyGoogleCredential } from './lib/google.js';
// The sample hotel used by "Try the demo", and the tools that reset it.
import { DEMO_ID, isDemoBusiness, resetDemo, ensureFreshDemo, demoActivity } from './lib/demo.js';

// The port the server listens on (Render sets PORT; locally it is 3000).
const PORT = Number(process.env.PORT) || 3000;
// The main admin password from the settings ("changeme" only if none is set).
// The main admin password comes only from the environment (.env locally, Render's settings live). No fallback is written in the code.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// The main admin signs in with this username (or an empty username) + ADMIN_PASSWORD.
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
// Optional: the main admin's own email, so they can also sign in with it (password or Google).
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
// The site's public address, without a trailing slash (used in links, emails and previews).
const APP_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// True when running on the live server, where extra safety checks apply.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
// The folder with the files the browser downloads directly (admin.html, images, scripts).
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
// How many hours an inquiry can wait before the dashboard suggests a follow-up (at least 1, default 24).
const FOLLOW_UP_AFTER_HOURS = Math.max(1, Number(process.env.FOLLOW_UP_AFTER_HOURS) || 24);

// Refuse to go live with a guessable password.
// If this is the live server and the password is weak, print a warning and stop.
if (IS_PRODUCTION && isWeakPassword(ADMIN_PASSWORD)) {
  console.error('Refusing to start: set a strong ADMIN_PASSWORD (10+ characters, not "changeme") in .env.');
  // Exit with an error code so the hosting service shows the deploy failed.
  process.exit(1);
}

// Create the web app.
const app = express();
app.disable('x-powered-by'); // don't advertise what the server runs on
// Behind a hosting proxy (Render, Railway…), trust it so we see visitors' real IPs.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
// Add safety headers (block framing, sniffing, etc.) to every response.

app.use(securityHeaders);
// Sample sites, invite links, unsubscribe pages and the API should never appear in Google.
app.use(['/demo', '/r', '/u', '/api'], (req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });

// ---------- Public (widget) API ----------
// The chat widget runs on client websites, so this API allows other origins.
// It never uses cookies, and bodies are kept small.

// For every public API request: allow any website to call it (needed for the chat widget).
app.use('/api/public', (req, res, next) => {
  // Any origin may read the answer.
  res.set('Access-Control-Allow-Origin', '*');
  // The browser may send a Content-Type header.
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  // Only these methods are allowed.
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // Browsers first send an OPTIONS "may I?" check: answer yes with no body.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  // Otherwise carry on to the real route.
  next();
});
// Read JSON request bodies, but refuse anything bigger than 16 KB.
app.use('/api/public', express.json({ limit: '16kb' }));

// The chat widget asks for a business's public profile (name, colour, greeting, services).
app.get('/api/public/business/:id', (req, res) => {
  // Look the business up by the id in the address.
  const biz = getBusiness(req.params.id);
  // Unknown business: answer 404 Not found.
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  // Send only the safe, public fields (never the owner's private settings).
  res.json(publicProfile(biz));
});

// Stops one visitor (or a bot) from spamming the chat and running up AI costs.
// At most 30 chat messages per visitor IP every 5 minutes.
const chatPerIp = rateLimiter({ windowMs: 5 * 60_000, max: 30 });
// At most 150 messages per chat session per day.
const chatPerSession = rateLimiter({ windowMs: 24 * 60 * 60_000, max: 150 });

// A visitor sent a chat message from the widget.
app.post('/api/public/chat', async (req, res) => {
  // Pull the three fields out of the request body (empty object if there is none).
  const { businessId, sessionId, message } = req.body || {};
  // Reject a missing or badly formed business id.
  if (!isValidId(businessId)) return res.status(400).json({ error: 'Bad business id' });
  // The session id must be 8-64 letters, digits, _ or -.
  if (typeof sessionId !== 'string' || !/^[\w-]{8,64}$/.test(sessionId)) return res.status(400).json({ error: 'Bad session id' });
  // Reject empty messages.
  if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'Empty message' });

  // Count this message against the visitor's IP limit...
  const ipLimit = chatPerIp(req.ip);
  // ...and against this chat session's daily limit.
  const sessionLimit = chatPerSession(`${businessId}:${sessionId}`);
  // If either limit is used up...
  if (!ipLimit.allowed || !sessionLimit.allowed) {
    // ...tell the browser how many seconds to wait...
    res.set('Retry-After', String(ipLimit.allowed ? sessionLimit.retryAfterSec : ipLimit.retryAfterSec));
    // ...and answer 429 "too many requests" with a friendly message.
    return res.status(429).json({ reply: "You're sending messages very quickly. Please wait a few minutes and try again." });
  }

  // Load the business profile.
  const biz = getBusiness(businessId);
  if (!biz) return res.status(404).json({ error: 'Business not found' });

  // Trim spaces and cut the message to 1000 characters.
  const text = message.trim().slice(0, 1000);
  // Load the earlier messages in this chat so the AI has context.
  const { messages: history } = getConversation(businessId, sessionId);
  // Ask the AI for a reply (it also spots a name, phone, email or interest).
  const result = await chatReply(biz, history, text);

  // Save both the customer's message and the AI's reply to the conversation.
  appendMessages(businessId, sessionId, [
    { role: 'user', content: text },
    { role: 'assistant', content: result.reply },
  ]);
  // Create or update the inquiry (lead) with any details the AI found.
  const { lead, created } = upsertLead(businessId, sessionId, result.lead || {});
  // If this is a brand-new inquiry, alert the owner.
  if (created) notifyOwner(biz, lead);

  // Send the AI's reply back to the widget.
  res.json({ reply: result.reply });
});

// Stops one visitor (or a bot) from flooding a business with fake booking requests.
// At most 5 booking requests per visitor IP every 15 minutes.
const bookingPerIp = rateLimiter({ windowMs: 15 * 60_000, max: 5 });

// A visitor sent the booking form on a business's sample page (/demo/<id>#booking).
// It becomes an inquiry in the owner's dashboard, just like a chat that left contact details.
app.post('/api/public/booking', (req, res) => {
  // Count this request against the visitor's IP limit.
  const limit = bookingPerIp(req.ip);
  // Too many: ask them to wait.
  if (!limit.allowed) {
    // Tell the browser how many seconds to wait...
    res.set('Retry-After', String(limit.retryAfterSec));
    // ...and say so politely.
    return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
  }
  // Pull out only the fields we expect (never save the whole body).
  const { businessId, name, phone, when, guests, service, note, website } = req.body || {};
  // Hidden "website" field: real people leave it empty, spam bots fill it in. Pretend it worked.
  if (website) return res.json({ ok: true });
  // The business id must be valid and exist.
  if (!isValidId(businessId)) return res.status(400).json({ error: 'Bad business id' });
  // Look the business up.
  const biz = getBusiness(businessId);
  // Unknown business: 404.
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  // Turn any value into trimmed text no longer than max characters.
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  // The visitor's name (required, 2-80 characters).
  const cleanName = text(name, 80);
  if (cleanName.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
  // The phone number (required): digits, spaces, +, -, brackets, with 7 to 15 digits.
  const cleanPhone = text(phone, 30);
  const digits = cleanPhone.replace(/\D/g, '');
  if (!/^[\d\s+()-]+$/.test(cleanPhone) || digits.length < 7 || digits.length > 15) return res.status(400).json({ error: 'Please enter a valid phone number.' });
  // The date (optional): must look like 2026-12-24 and not be in the past.
  const cleanWhen = text(when, 10);
  if (cleanWhen && (!/^\d{4}-\d{2}-\d{2}$/.test(cleanWhen) || cleanWhen < new Date().toISOString().slice(0, 10))) return res.status(400).json({ error: 'Please choose a date from today onwards.' });
  // Number of people (optional): a whole number from 1 to 500.
  const people = guests === undefined || guests === '' ? 0 : Number(guests);
  if (people && (!Number.isInteger(people) || people < 1 || people > 500)) return res.status(400).json({ error: 'Please enter how many people (1 to 500).' });
  // The chosen service and the note (optional, kept short).
  const cleanService = text(service, 100);
  const cleanNote = text(note, 400);
  // One line describing what they want, for the owner's inquiry list.
  const interest = [cleanService || 'Booking request', cleanWhen && `on ${cleanWhen}`, people && `for ${people}`, cleanNote && `(${cleanNote})`].filter(Boolean).join(' ');
  // Save it as a new inquiry with its own random id (each form send is separate).
  const { lead, created } = upsertLead(businessId, `booking-${crypto.randomUUID()}`, { name: cleanName, phone: cleanPhone, interest }, 'booking');
  // Alert the owner about the new inquiry.
  if (created) notifyOwner(biz, lead);
  // Done.
  res.json({ ok: true });
});

// ---------- WhatsApp & Instagram auto-replies ----------
// Meta calls this webhook for every new message. See lib/social.js and README.

// Meta calls this once when you connect the webhook, to check it is really ours.
app.get('/webhooks/meta', (req, res) => {
  // Compare the verify token Meta sent with ours; get back the challenge text or null.
  const challenge = verifyChallenge(req.query);
  // Wrong token: refuse with 403 Forbidden.
  if (challenge === null) return res.sendStatus(403);
  // Right token: echo the challenge back as plain text, which completes the setup.
  res.type('text/plain').send(challenge);
});

// At most 20 messages per WhatsApp/Instagram sender every 5 minutes.
const socialPerSender = rateLimiter({ windowMs: 5 * 60_000, max: 20 });

// Meta sends every new WhatsApp/Instagram message here. Read the raw body (needed to check the signature).
app.post('/webhooks/meta', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  // Reject anything not signed by Meta with our app secret.
  if (!Buffer.isBuffer(req.body) || !isValidSignature(req.body, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  let payload;
  // Turn the raw bytes into a JavaScript object.
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  // If the JSON is broken...
  } catch {
    // ...answer 400 Bad request.
    return res.sendStatus(400);
  }
  res.sendStatus(200); // answer Meta right away; reply to customers in the background
  // Go through every message in the delivery.
  for (const msg of extractMessages(payload)) {
    // Meta sometimes delivers the same message twice: skip repeats.
    if (isDuplicate(msg.id)) continue;
    // Reply in the background; if it fails, only log the error.
    handleSocialMessage(msg).catch((err) => console.error(`[${msg.channel}] reply failed:`, err.message));
  }
});

// Handle one WhatsApp/Instagram message: get an AI reply, save the inquiry, send the reply.
async function handleSocialMessage(msg) {
  // Find the business this WhatsApp number / Instagram page belongs to.
  const biz = getBusiness(msg.businessId);
  // Not one of ours: ignore it.
  if (!biz) return;
  // Make a session id like "wa-2348035550199" or "ig-12345" so each sender has one conversation.
  const sessionId = `${msg.channel === 'whatsapp' ? 'wa' : 'ig'}-${msg.from}`;
  if (!socialPerSender(`${msg.businessId}:${sessionId}`).allowed) return; // ignore floods
  // Photos, voice notes and stickers have no text...
  if (!msg.text.trim()) {
    // ...so ask them to type instead.
    return sendReply(msg, "Thanks for your message! I can only read text right now. Please type your question and I'll help.");
  }
  // Trim the text and cut it to 1000 characters.
  const text = msg.text.trim().slice(0, 1000);
  // Load this sender's earlier messages for context.
  const { messages: history } = getConversation(biz.id, sessionId);
  // Ask the AI for a reply.
  const result = await chatReply(biz, history, text);
  // Save the message and the reply, marked with the channel (whatsapp or instagram).
  appendMessages(biz.id, sessionId, [{ role: 'user', content: text }, { role: 'assistant', content: result.reply }], msg.channel);

  // Save the inquiry BEFORE replying, so it's never lost if Meta's API fails.
  // On WhatsApp we already know their number, but a lone "hi" or spam shouldn't
  // alert the owner: wait until they say something meaningful (the AI found an
  // interest, name or email) or send a second message.
  // Copy any customer details the AI picked out of the message.
  const fields = { ...(result.lead || {}) };
  // Count it as a real inquiry if the AI found details, or if this is not their first message.
  const meaningful = Boolean(fields.interest || fields.name || fields.email || fields.phone) || history.some((m) => m.role === 'user');
  // On WhatsApp we already know the sender's number and profile name...
  if (msg.channel === 'whatsapp' && meaningful) {
    // ...so use the number (with +) if the AI didn't find one...
    fields.phone = fields.phone || `+${msg.from}`;
    // ...and their WhatsApp name if the AI didn't find one.
    fields.name = fields.name || msg.name;
  }
  // Create or update the inquiry.
  const { lead, created } = upsertLead(biz.id, sessionId, fields, msg.channel);
  // Alert the owner about brand-new inquiries.
  if (created) notifyOwner(biz, lead);

  // Finally send the AI's reply to the customer through Meta.
  await sendReply(msg, result.reply);
}

// ---------- Instant owner alerts ----------
// The faster a business replies to a new inquiry, the more likely it becomes a
// customer, so the owner is emailed the moment someone leaves their details.
// (In test mode the alert is saved to data/outbox.json like every other email.)

// Tell the owner about a new inquiry.
function notifyOwner(biz, lead) {
  // Friendly names for where an inquiry came from.
  const SOURCES = { referral: 'referral', whatsapp: 'WhatsApp', instagram: 'Instagram', chat: 'website chat', booking: 'website booking form' };
  // Always write a line to the server log.
  console.log(`[inquiry] ${biz.name}: new ${SOURCES[lead.source] || 'website chat'} inquiry`);
  if (!biz.email || isDemoBusiness(biz.id)) return; // the sample business never emails anyone
  // A sentence explaining how this person found the business, based on the source.
  const how = {
    referral: `They were invited by your customer ${lead.referredByName}.`,
    whatsapp: 'They messaged you on WhatsApp and the assistant replied.',
    instagram: 'They messaged you on Instagram and the assistant replied.',
    booking: 'They sent the booking form on your website.',
  // Website chat is the default when the source isn't one of the three above.
  }[lead.source] || 'They chatted with your website assistant.';
  // The lines of the alert email.
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
  // Send the email; if sending fails, only log it (the inquiry is already saved).
  sendEmail({ to: biz.email, toName: biz.name, fromName: 'Marketing Agent', subject: `New inquiry: ${lead.name || lead.phone || lead.email}`, text: lines.join('\n') }).catch((err) =>
    console.error('[inquiry] owner alert failed:', err.message)
  );
}

// ---------- Referral invite page ----------
// A customer's personal link: /r/ADAEZE-K7Q2. Their friend sees the offer and
// leaves their details; the business gets a new inquiry marked "referred by Adaeze".

// Make text safe to put inside HTML by replacing the 5 special characters (stops HTML injection).
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Shared look for the small server-made pages (invite, unsubscribe): same font, light/dark
// theme (following the saved System/Dark/Light choice) and the interactive dot background.
const DARK_TOKENS = 'color-scheme:dark;--bg:#0d0e11;--card:#16181d;--text:#eceef2;--muted:#9aa1ad;--line:#262a31;--dot:rgba(236,238,242,.2)';
// `meta` = { description, url, image } for search results and WhatsApp/Facebook link previews.
// Build the search and link-preview tags (description, canonical address, Open Graph, Twitter card).
const metaTags = ({ title, description, url, image = `${APP_URL}/og.png` }) =>
  // Only add them when a description was given; otherwise return nothing.
  description
    ? `<meta name="description" content="${escapeHtml(description)}">${url ? `<link rel="canonical" href="${escapeHtml(url)}"><meta property="og:url" content="${escapeHtml(url)}">` : ''}
<meta property="og:type" content="website"><meta property="og:site_name" content="Marketing Agent"><meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}"><meta property="og:image" content="${escapeHtml(image)}"><meta name="twitter:card" content="summary_large_image">`
    : '';
// The start of every small server-made page: doctype, title, preview tags, icon, font, theme and base styles.
const pageHead = (title, meta = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${metaTags({ title, ...meta })}<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&display=swap">
<script src="/theme-init.js"></script>
<style>
:root{color-scheme:light;--bg:#fff;--card:#fff;--text:#1b1c1f;--muted:#5e6470;--line:#e6e8ec;--dot:rgba(27,28,31,.16)}
:root[data-theme=dark]{${DARK_TOKENS}}
@media (prefers-color-scheme:dark){:root[data-theme=system]{${DARK_TOKENS}}}
*{box-sizing:border-box}body{margin:0;font-family:'Bricolage Grotesque',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:grid;place-items:center;padding:16px;line-height:1.5}
#field{position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none}
h1,h2{letter-spacing:-.03em}`;
// The animated dot background: a canvas plus the scripts that draw on it, in the given colours.
// The colours travel in a data-colors attribute (escaped), and /motion-start.js reads them,
// so no inline script is needed and the Content-Security-Policy can block inline code.
const motionBackground = (colors) =>
  `<canvas id="field" aria-hidden="true" data-colors="${escapeHtml(JSON.stringify(colors))}"></canvas><script src="/motion.js"></script><script src="/motion-start.js"></script>`;

// The referral invite page: the business's colour, "X invited you to ...", and whatever body is passed in.
function invitePage(biz, referrer, { body, title, description }) {
  // Use the business's brand colour if it's a valid #rrggbb colour, otherwise a default blue.
  const color = /^#[0-9a-fA-F]{6}$/.test(biz.brandColor || '') ? biz.brandColor : '#2563eb';
  // Return the full HTML page (head, styles, card, background).
  return `${pageHead(title, { description })}
:root{--brand:${color}}
.c{background:var(--card);border:1px solid var(--line);border-radius:28px;max-width:440px;width:100%;overflow:hidden;box-shadow:0 20px 60px -30px color-mix(in srgb,var(--brand) 55%,transparent)}
.top{background:var(--brand);color:#fff;padding:26px 24px}.top small{opacity:.85}.top h1{margin:6px 0 0;font-size:28px;line-height:1.1;font-weight:700}
.in{padding:22px 24px}.offer{border:2px dashed var(--brand);border-radius:18px;padding:14px 16px;margin:0 0 16px;font-weight:600;font-size:17px}
label{display:block;font-weight:600;margin:12px 0 6px;font-size:14px}input{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:14px;font:inherit;font-size:16px;background:var(--bg);color:var(--text)}
button,.btn{display:block;width:100%;text-align:center;background:var(--brand);color:#fff;border:0;border-radius:999px;padding:14px;font:inherit;font-size:16px;font-weight:600;margin-top:18px;cursor:pointer;text-decoration:none}
.muted{color:var(--muted);font-size:13px}.hp{position:absolute;left:-9999px}.err{color:#dc2626;font-weight:600}
</style></head><body><div class="c"><div class="top"><small>${escapeHtml(referrer.firstName || 'A friend')} invited you to</small><h1>${escapeHtml(biz.name)}</h1></div><div class="in">${body}</div></div>${motionBackground([color])}</body></html>`;
}

// At most 20 invite form submissions per IP every 15 minutes.
const referralLimit = rateLimiter({ windowMs: 15 * 60_000, max: 20 });
// Read normal HTML form posts on /r pages (max 4 KB).
app.use('/r', express.urlencoded({ extended: false, limit: '4kb' }));

// ?preview=1 = the owner opened it from the dashboard: show a way back.
const previewBar = (on) => (on ? '<p class="muted" style="margin:0 0 14px">👀 Preview: this is what your customer\'s friend sees. <a href="/admin#leads">← Back to dashboard</a></p>' : '');

// Someone opened an invite link like /r/TUNDE-DEMO.
app.get('/r/:code', (req, res) => {
  // ?preview=1 means the owner opened it from the dashboard.
  const preview = req.query.preview === '1';
  // Find the customer whose invite code this is.
  const referrer = getContactByReferralCode(req.params.code);
  // ...and the business they belong to.
  const biz = referrer && getBusiness(referrer.businessId);
  // No such code: show a friendly "not found" page with status 404.
  if (!biz) return res.status(404).send(page('Invite not found', '<h2>Invite link not found</h2><p>Please check the link and try again.</p>'));
  // Up to 4 services as "Name · Price", one per line.
  const services = (biz.services || []).slice(0, 4).map((s) => `${escapeHtml(s.name)}${s.price ? ` · ${escapeHtml(s.price)}` : ''}`).join('<br>');
  // Send the invite page.
  res.send(
    invitePage(biz, referrer, {
      // Page title, also used in WhatsApp/Facebook link previews.
      title: `${referrer.firstName || 'A friend'} invited you to ${biz.name}`,
      // The preview description: the offer, a call to action and the tagline.
      description: `🎁 ${biz.referralOffer || 'A special welcome offer'}. Tap to claim it. ${biz.tagline || ''}`.trim(),
      // The visible page: optional preview bar, the offer, tagline, services and the claim form.
      body: `${previewBar(preview)}<div class="offer">🎁 ${escapeHtml(biz.referralOffer || 'A special welcome offer')}</div>
<p>${escapeHtml(biz.tagline || '')}</p>
${services ? `<p class="muted">${services}</p>` : ''}
<form method="post" action="/r/${escapeHtml(referrer.referralCode)}">
<label for="name">Your name</label><input id="name" name="name" required maxlength="80" autocomplete="name">
<label for="phone">Phone or WhatsApp number</label><input id="phone" name="phone" maxlength="40" autocomplete="tel" inputmode="tel">
<label for="email">Email <span class="muted">(optional if you gave a phone)</span></label><input id="email" name="email" type="email" maxlength="120" autocomplete="email">
<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">${preview ? '<input type="hidden" name="preview" value="1">' : ''}
<button>Claim my offer</button>
<p class="muted">${escapeHtml(biz.name)} will contact you to book. Your details are only shared with them. <a href="/privacy" style="color:inherit">Privacy</a></p>
</form>`,
    })
  );
});

// The friend submitted the invite form.
app.post('/r/:code', (req, res) => {
  // Find who invited them and the business, as above.
  const referrer = getContactByReferralCode(req.params.code);
  const biz = referrer && getBusiness(referrer.businessId);
  if (!biz) return res.status(404).send(page('Invite not found', '<h2>Invite link not found</h2>'));
  // Too many submissions from this IP: answer 429.
  if (!referralLimit(req.ip).allowed) return res.status(429).send(page('Slow down', '<h2>Too many requests</h2><p>Please try again later.</p>'));

  // Read the form fields (empty strings if missing).
  const { name = '', phone = '', email = '', website = '', preview = '' } = req.body || {};
  // Did the owner submit this from the preview?
  const isPreview = preview === '1';
  // Is the email shaped like name@site.tld?
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
  // A phone number needs at least 7 digits.
  const validPhone = String(phone).replace(/\D/g, '').length >= 7;
  // "website" is an invisible field: humans leave it empty, spam bots fill it in.
  // Save only if the hidden field is empty, there's a name, and a valid phone or email.
  if (!website && String(name).trim() && (validPhone || validEmail)) {
    // Save the new inquiry marked "invited by" this customer (only valid details are kept).
    const lead = addReferralLead(biz.id, referrer, { name: String(name), phone: validPhone ? String(phone) : '', email: validEmail ? String(email) : '' });
    if (lead) notifyOwner(biz, lead); // null = already an inquiry; still show the friendly page
  // Something is missing (and it's not a bot): show the form error page.
  } else if (!website) {
    return res.status(400).send(
      // Same invite look, with an error message and a "Go back" button.
      invitePage(biz, referrer, {
        title: 'Please check your details',
        body: `<p class="err">Please enter your name and a phone number or email.</p><a class="btn" href="/r/${escapeHtml(referrer.referralCode)}${isPreview ? '?preview=1' : ''}">Go back</a>`,
      })
    );
  }
  // Success: show the "You're in!" page.
  res.send(
    invitePage(biz, referrer, {
      title: 'Offer claimed',
      // The thank-you message, a "Book now" button if there is a booking link, and a way back for previews.
      body: `<h2 style="margin-top:0">You're in! 🎉</h2><p>${escapeHtml(biz.name)} has your details and will contact you to book. Your offer: <b>${escapeHtml(biz.referralOffer || 'welcome offer')}</b>.</p>
${/^https?:\/\//i.test(biz.bookingLink || '') ? `<a class="btn" href="${escapeHtml(biz.bookingLink)}" rel="noopener">Book now</a>` : ''}
${isPreview ? '<a class="btn" href="/admin#leads" style="background:transparent;color:var(--text);border:1px solid var(--line)">← Back to dashboard: see the new inquiry</a>' : ''}`,
    })
  );
});

// ---------- Static files and pages ----------

// The sign-in page carries search and link-preview tags that need the site's full address
// (WhatsApp and Google ignore relative links), so the server fills in __APP_URL__.
// Read admin.html once when the server starts and fill in the real site address.
const adminHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8').replaceAll('__APP_URL__', APP_URL);
// Old address /admin.html permanently redirects to /admin.
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));

// Search engines: list the public pages, keep private and one-off pages out of results.
// robots.txt tells search engines which pages they may list and where the sitemap is.
app.get('/robots.txt', (req, res) =>
  res.type('text/plain').send(['User-agent: *', 'Allow: /admin', 'Allow: /privacy', 'Allow: /terms', 'Disallow: /api/', 'Disallow: /u/', 'Disallow: /demo', '', `Sitemap: ${APP_URL}/sitemap.xml`, ''].join('\n'))
);
// sitemap.xml lists the public pages (and their images) for Google.
app.get('/sitemap.xml', (req, res) => {
  // Image sitemap entries help Google Images find the pictures on each page.
  // Each entry: [page address, importance from 0 to 1, pictures on that page].
  const pages = [['/admin', '1.0', ['/og.png', '/icon-512.png']], ['/privacy', '0.3', []], ['/terms', '0.3', []]];
  // Build the XML: one <url> per page, with <image:image> entries for its pictures.
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${pages.map(([p, pr, imgs]) => `  <url><loc>${APP_URL}${p}</loc><priority>${pr}</priority>${imgs.map((i) => `<image:image><image:loc>${APP_URL}${i}</image:loc></image:image>`).join('')}</url>`).join('\n')}
</urlset>`);
});
// Serve files in /public as they are (images, scripts, styles); no automatic index page.
app.use(express.static(PUBLIC_DIR, { index: false }));
// A sample customer website with the chat bubble, e.g. /demo/lagoon-breeze-hotel.
app.get('/demo/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'demo.html')));
// A bare /demo link opens the first business's demo instead of a "Not found" error.
app.get('/demo', (req, res) => {
  // Take the first business in the list (sorted by name).
  const first = listBusinesses()[0];
  // No businesses at all: answer 404.
  if (!first) return res.status(404).json({ error: 'Not found' });
  // Otherwise send the visitor to that business's demo page.
  res.redirect(`/demo/${first.id}`);
});
// The sign-in page and dashboard (the copy read at startup).
app.get('/admin', (req, res) => res.type('html').send(adminHtml));
// The home page just sends people to the sign-in page.
app.get('/', (req, res) => res.redirect('/admin'));
// Hosting platforms ping this to check the app is alive.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- Privacy policy and terms ----------

// Use SUPPORT_EMAIL only if it is a plain, valid email address (it gets shown on the pages).
const SUPPORT_EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(process.env.SUPPORT_EMAIL || '') ? process.env.SUPPORT_EMAIL : '';
// The layout for the privacy and terms pages: top bar with theme switch, the text, links and background.
const docPage = (title, body, meta) => `${pageHead(title, meta)}
body{display:block;padding:0}
.doc{max-width:700px;margin:0 auto;padding:28px 16px 64px}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:28px}
.bar a.home{color:var(--text);font-weight:700;text-decoration:none;letter-spacing:-.02em}
.sw{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:3px;background:var(--card)}
.sw button{border:0;background:none;color:var(--muted);font:inherit;font-size:13px;padding:6px 12px;border-radius:999px;cursor:pointer}
.sw button[aria-pressed=true]{background:var(--text);color:var(--bg)}
article{background:color-mix(in srgb,var(--card) 90%,transparent);border:1px solid var(--line);border-radius:28px;padding:clamp(22px,5vw,44px)}
article h1{font-size:clamp(32px,6vw,46px);line-height:1.05;margin:0 0 6px;font-weight:750}
article h2{font-size:21px;margin:34px 0 8px;font-weight:700}
article p,article li{color:var(--text);font-size:16px}article ul{padding-left:20px}article li{margin:6px 0}
article a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}
.meta{color:var(--muted);margin:0 0 22px}
.links{margin-top:22px;text-align:center;color:var(--muted);font-size:14px}.links a{color:inherit;margin:0 8px}
:focus-visible{outline:2px solid #6d5efc;outline-offset:2px}
</style></head><body><div class="doc">
<div class="bar"><a class="home" href="/admin">Marketing Agent</a>
<div class="sw" role="group" aria-label="Theme"><button data-t="system">System</button><button data-t="dark">Dark</button><button data-t="light">Light</button></div></div>
<article>${body}</article>
<p class="links"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/admin">Sign in</a></p></div>
<script src="/theme-switch.js"></script>
${motionBackground(['#6d5efc', '#12b5a5', '#f4b13e', '#ff6b3d'])}</body></html>`;

// The privacy policy page.
app.get('/privacy', (req, res) =>
  // Fill the layout with the policy text, plus a description and address for Google.
  res.send(docPage('Privacy policy · Marketing Agent', privacyBody({ supportEmail: SUPPORT_EMAIL }), {
    description: 'What information Marketing Agent holds for businesses and their customers, who handles it, how it is protected and your rights under the Nigeria Data Protection Act.',
    url: `${APP_URL}/privacy`,
  }))
);
// The terms of service page, built the same way.
app.get('/terms', (req, res) =>
  res.send(docPage('Terms of service · Marketing Agent', termsBody({ supportEmail: SUPPORT_EMAIL }), {
    description: 'The rules for businesses using Marketing Agent: accounts, customer data, the AI assistant, payment and ending the service.',
    url: `${APP_URL}/terms`,
  }))
);

// Unsubscribe link in every campaign email. GET shows a confirm button
// (so link scanners can't unsubscribe people by accident); POST does it,
// which also supports one-click unsubscribe from Gmail/Outlook.
// `body` must be trusted HTML (only fixed text is passed in); the title is always escaped.
// The layout for small message pages (unsubscribe, errors).
const page = (title, body) => `${pageHead(title)}
.c{background:var(--card);border:1px solid var(--line);border-radius:28px;padding:30px;max-width:420px;text-align:center}
.c h2{margin-top:0;font-weight:700}
button{background:var(--text);color:var(--bg);border:0;border-radius:999px;padding:0 22px;font:inherit;font-size:15px;font-weight:600;cursor:pointer;min-height:46px}
</style></head><body><div class="c">${body}</div>${motionBackground(['#6d5efc', '#12b5a5', '#f4b13e', '#ff6b3d'])}</body></html>`;

// At most 60 unsubscribe requests per IP every 15 minutes.
const unsubscribeLimit = rateLimiter({ windowMs: 15 * 60_000, max: 60 });
// For every /u page: read form posts, then check the rate limit.
app.use('/u', express.urlencoded({ extended: false, limit: '4kb' }), (req, res, next) => {
  // Too many requests: answer 429.
  if (!unsubscribeLimit(req.ip).allowed) return res.status(429).send(page('Slow down', '<h2>Too many requests</h2><p>Please try again later.</p>'));
  // Under the limit: carry on.
  next();
});

// Someone clicked the unsubscribe link in an email.
app.get('/u/:token', (req, res) => {
  // Keep only the hex characters of the token (max 32), so nothing harmful reaches the page.
  const token = String(req.params.token).replace(/[^a-f0-9]/g, '').slice(0, 32);
  // Show the "Unsubscribe?" page with a confirm button.
  res.send(page('Unsubscribe', `<h2>Unsubscribe?</h2><p>You'll stop getting marketing emails from this business.</p>
    <form method="post" action="/u/${token}"><button>Yes, unsubscribe me</button></form>`));
});

// They pressed "Yes, unsubscribe me" (or their email app did one-click unsubscribe).
app.post('/u/:token', (req, res) => {
  // Mark the contact as unsubscribed; returns null if the token is unknown.
  const contact = unsubscribeByToken(req.params.token);
  // Show "You're unsubscribed" or "Link not found".
  res.send(page('Unsubscribed', contact ? `<h2>You're unsubscribed</h2><p>You won't get any more marketing emails from us. Sorry to see you go!</p>` : `<h2>Link not found</h2><p>This unsubscribe link is invalid or expired.</p>`));
});

// ---------- Owner dashboard: login ----------

app.use('/api/admin', express.json({ limit: '2mb' })); // room for contact CSV uploads

// Sign-in with username/email and password.
app.post('/api/admin/login', (req, res) => {
  // The visitor's IP address (used for the lockout).
  const ip = req.ip;
  // Is this IP locked out after too many wrong passwords?
  const lock = loginLockStatus(ip);
  // If so...
  if (lock.locked) {
    // ...say when to try again...
    res.set('Retry-After', String(lock.retryAfterSec));
    // ...and refuse with 429.
    return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute(s).`, retryAfterSec: lock.retryAfterSec });
  }

  // Empty username or "admin" = the main admin; anything else is a business owner's email.
  // Read the username (lower case, max 120 characters).
  const username = String(req.body?.username ?? '').trim().toLowerCase().slice(0, 120);
  // Read the password.
  const password = String(req.body?.password ?? '');
  // Nobody is signed in yet.
  let user = null;
  // Empty username, "admin" or the admin's email: check against the main admin password.
  if (!username || username === ADMIN_USERNAME || (ADMIN_EMAIL && username === ADMIN_EMAIL)) {
    // safeEqual compares in constant time, so timing can't reveal the password.
    // (An empty ADMIN_PASSWORD never matches, so a missing setting can't let anyone in.)
    if (ADMIN_PASSWORD && safeEqual(password, ADMIN_PASSWORD)) user = { id: 'admin', role: 'admin', name: 'Admin' };
  // Anything else is a business owner's email.
  } else {
    // Check the owner's email and password (scrypt hash).
    user = authenticate(username, password);
  }

  // Wrong details:
  if (!user) {
    // Count the failure for this IP.
    const r = recordLoginFailure(ip);
    // Log it (so attacks show up in the server log).
    console.warn(`[security] failed login from ${ip}${r.locked ? ' (now locked)' : ''}`);
    // If that failure triggered the lock...
    if (r.locked) {
      // ...say when to try again...
      res.set('Retry-After', String(r.retryAfterSec));
      // ...and refuse with 429.
      return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(r.retryAfterSec / 60)} minute(s).`, retryAfterSec: r.retryAfterSec });
    }
    // Otherwise say how many tries are left.
    return res.status(401).json({ error: `Wrong email or password. ${r.attemptsLeft} attempt(s) left before a 15-minute lock.` });
  }

  // Correct: clear this IP's failure count.
  recordLoginSuccess(ip);
  // Start a session and get its secret token.
  const { token, maxAgeSec } = createSession(user);
  // Store the token in a secure, HTTP-only cookie.
  res.set('Set-Cookie', sessionCookie(token, maxAgeSec, req.secure));
  // Tell the page it worked and which role the person has.
  res.json({ ok: true, role: user.role });
});

// What the sign-in page needs to know (no secrets): is Google sign-in switched on?
app.get('/api/admin/auth-config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID || null }));

// True if a request came from our own site (or the browser didn't say where it came from).
const sameSite = (req) => {
  // The Origin header says which website sent the request.
  const origin = req.get('origin');
  // No origin, or exactly our own address: allowed.
  return !origin || origin === `${req.protocol}://${req.get('host')}`;
};

// ----- Continue with Google -----
// Google proves who the person is; they still need an existing login (or to be the admin).
// At most 30 Google sign-in attempts per IP every 15 minutes.
const googleLimit = rateLimiter({ windowMs: 15 * 60_000, max: 30 });
// The browser sends the token Google gave it.
app.post('/api/admin/google', async (req, res) => {
  // Block requests made by other websites.
  if (!sameSite(req)) return res.status(403).json({ error: 'Blocked: request came from another website.' });
  // Too many attempts: answer 429.
  if (!googleLimit(req.ip).allowed) return res.status(429).json({ error: 'Too many sign-in attempts. Please try again later.' });
  // Will hold the verified email and name.
  let who;
  try {
    // Check the token's signature, app id, expiry and verified email.
    who = await verifyGoogleCredential(req.body?.credential);
  } catch (err) {
    // Fake or expired token: refuse with 401.
    return res.status(401).json({ error: err.message });
  }
  // The admin's own email signs in as admin; any other email must belong to an owner login.
  const user = ADMIN_EMAIL && who.email === ADMIN_EMAIL ? { id: 'admin', role: 'admin', name: who.name || 'Admin', email: who.email } : sessionUserForEmail(who.email);
  // No login for that email: explain who can add it.
  if (!user) return res.status(403).json({ error: `There's no account for ${who.email}. Ask the person who set up your business to add this email.` });
  // Start a session, set the cookie and report success, as in password sign-in.
  const { token, maxAgeSec } = createSession(user);
  res.set('Set-Cookie', sessionCookie(token, maxAgeSec, req.secure));
  res.json({ ok: true, role: user.role });
});

// ----- Forgot password -----
// Always answers the same way, so nobody can use this to find out who has an account.
// At most 5 reset requests per IP every 15 minutes (stops email flooding).
const forgotLimit = rateLimiter({ windowMs: 15 * 60_000, max: 5 });
// "Forgot password": email a one-time reset link.
app.post('/api/admin/forgot', (req, res) => {
  // Block other websites.
  if (!sameSite(req)) return res.status(403).json({ error: 'Blocked: request came from another website.' });
  // Too many requests: answer 429.
  if (!forgotLimit(req.ip).allowed) return res.status(429).json({ error: 'Too many requests. Please try again in 15 minutes.' });
  // Read the email (lower case, max 120 characters).
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 120);
  // The same answer is given whether or not the account exists.
  const reply = { ok: true, message: 'If that email has an account, a reset link is on its way. It works for 30 minutes.' };
  // Make a reset token if a login has this email (null otherwise).
  const reset = email && createResetToken(email);
  // If there is such a login...
  if (reset) {
    // ...build the link; the token goes after # so it never reaches server logs.
    const link = `${APP_URL}/admin#reset=${reset.token}`;
    // ...and email it (in test mode it's saved to data/outbox.json).
    sendEmail({
      to: reset.user.email,
      toName: reset.user.name,
      fromName: 'Marketing Agent',
      subject: 'Reset your password',
      text: [`Hi${reset.user.name ? ' ' + reset.user.name.split(' ')[0] : ''},`, '', 'Someone (hopefully you) asked to reset your dashboard password. Open this link to choose a new one:', '', link, '', 'It works once, for 30 minutes. If you did not ask for this, ignore this email: your password stays the same.'].join('\n'),
    // If the email fails, only log it.
    }).catch((err) => console.error('[auth] reset email failed:', err.message));
    // Log that a link was made (never the link itself).
    console.log(`[auth] password reset link created for ${reset.user.email}`);
  }
  // Always send the same reply.
  res.json(reply);
});

// At most 10 reset attempts per IP every 15 minutes.
const resetLimit = rateLimiter({ windowMs: 15 * 60_000, max: 10 });
// The person chose a new password from the reset link.
app.post('/api/admin/reset', (req, res) => {
  // Block other websites.
  if (!sameSite(req)) return res.status(403).json({ error: 'Blocked: request came from another website.' });
  // Too many attempts: answer 429.
  if (!resetLimit(req.ip).allowed) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  // Will hold the user whose password changed.
  let u;
  try {
    // Check the token and set the new password (throws if the password is too short).
    u = resetPasswordWithToken(req.body?.token, req.body?.password);
  } catch (err) {
    // Password too short or too long: show why.
    return res.status(400).json({ error: err.message });
  }
  // Token unknown, used or expired: say so.
  if (!u) return res.status(400).json({ error: 'This reset link is invalid, already used or expired. Ask for a new one.' });
  destroySessionsWhere((s) => s.id === u.id); // sign out everywhere with the old password
  // Tell the page it worked, and which email to sign in with.
  res.json({ ok: true, email: u.email });
});

// "Try the demo": prospects sign into the sample business with one click, no password.
// They can only ever see and change the sample business, which resets itself.
// At most 20 demo sign-ins per IP every 15 minutes.
const demoLoginLimit = rateLimiter({ windowMs: 15 * 60_000, max: 20 });
// "Try the demo" button.
app.post('/api/admin/demo-login', (req, res) => {
  // Where the request came from.
  const origin = req.get('origin');
  // Block other websites.
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Blocked: request came from another website.' });
  // Too many demo sign-ins: answer 429.
  if (!demoLoginLimit(req.ip).allowed) return res.status(429).json({ error: 'Too many demo sign-ins. Please try again later.' });
  // Reset the sample hotel if nobody has used it for 30 minutes.
  ensureFreshDemo();
  // Start a session that can only see the demo business.
  const { token, maxAgeSec } = createSession({ id: 'demo', role: 'demo', businessId: DEMO_ID, name: 'Demo visitor' });
  // Set the session cookie.
  res.set('Set-Cookie', sessionCookie(token, maxAgeSec, req.secure));
  // Tell the page it worked.
  res.json({ ok: true, role: 'demo' });
});

// Sign out.
app.post('/api/admin/logout', (req, res) => {
  // Delete the session on the server.
  destroySession(readCookie(req, SESSION_COOKIE));
  // Clear the cookie in the browser.
  res.set('Set-Cookie', sessionCookie('', 0, req.secure));
  // Confirm.
  res.json({ ok: true });
});

// ---------- Owner dashboard API (signed in only) ----------

// A group of routes that all need a signed-in user (mounted at /api/admin further down).
const admin = express.Router();

// Runs before every dashboard route:
admin.use((req, res, next) => {
  // Find who is signed in from the session cookie.
  const user = getSessionUser(readCookie(req, SESSION_COOKIE));
  // No valid session: answer 401 "Please sign in".
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  // Remember the user for the route that runs next.
  req.user = user;
  // Demo activity resets the 30-minute idle timer.
  if (user.role === 'demo') demoActivity();
  // Extra CSRF guard: changes must come from this site, as JSON.
  // Only for requests that change something (not plain reads):
  if (req.method !== 'GET') {
    // Where the request came from.
    const origin = req.get('origin');
    // Refuse requests sent by other websites.
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Blocked: request came from another website.' });
    // Refuse changes that aren't JSON (except DELETE, which has no body).
    if (req.method !== 'DELETE' && !req.is('application/json')) return res.status(415).json({ error: 'Expected JSON.' });
  }
  // All checks passed: run the route.
  next();
});

// ----- Who can see what -----
// The admin sees every business. An owner (or the demo visitor) only ever sees their own:
// asking for another business's data answers "Not found", as if it didn't exist.
// True if the signed-in person is the main admin.
const isAdmin = (req) => req.user.role === 'admin';
// True if they may see this business: the admin always, others only their own.
const canSee = (req, businessId) => isAdmin(req) || (Boolean(businessId) && req.user.businessId === businessId);
// Route guard: only the main admin may continue.
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: 'Only the main admin can do this.' }));
// Route guard: blocked for demo visitors.
const noDemo = (req, res, next) => (req.user.role === 'demo' ? res.status(403).json({ error: 'This is turned off in the demo.' }) : next());

// Every /businesses/:id/... route checks the business belongs to the signed-in user.
// Whenever a route has :id in its address, check access first; otherwise pretend it doesn't exist.
admin.param('id', (req, res, next, id) => (canSee(req, id) ? next() : res.status(404).json({ error: 'Not found' })));

// Who am I? Used by the dashboard to show the right screens.
admin.get('/me', (req, res) => {
  // Pick only the safe fields from the session.
  const { id, role, businessId, email, name } = req.user;
  // Send them.
  res.json({ id, role, businessId, email, name });
});

// "Start over" in the demo: puts the sample hotel back to its starting state (for video
// retakes and new prospects). Only ever touches the demo business; owners can't call it.
// At most 30 demo resets per IP every 15 minutes.
const demoResetLimit = rateLimiter({ windowMs: 15 * 60_000, max: 30 });
// "Start over" button in the demo banner.
admin.post('/demo/reset', (req, res) => {
  // Only the demo visitor or the main admin may reset.
  if (req.user.role !== 'demo' && !isAdmin(req)) return res.status(403).json({ error: 'Only the demo can be reset.' });
  // Too many resets: answer 429.
  if (!demoResetLimit(req.ip).allowed) return res.status(429).json({ error: 'Too many resets. Please wait a few minutes.' });
  // Put the sample hotel back to its starting data.
  resetDemo();
  // Confirm.
  res.json({ ok: true });
});

// Owners change their own password (they must know the current one).
// An owner changes their own password (blocked in the demo).
admin.post('/me/password', noDemo, (req, res) => {
  // The admin's password lives in the server settings, not here.
  if (req.user.role !== 'owner') return res.status(400).json({ error: 'The admin password is set in the server settings (ADMIN_PASSWORD).' });
  // They must type their current password correctly first.
  if (!checkCurrentPassword(req.user.id, req.body?.current)) return res.status(400).json({ error: 'Your current password is wrong.' });
  try {
    // Save the new password (throws if it's too short or too long).
    setPassword(req.user.id, req.body?.password);
  } catch (err) {
    // Show the problem.
    return res.status(400).json({ error: err.message });
  }
  // Sign out every other device; this one gets a fresh session.
  destroySessionsWhere((u) => u.id === req.user.id);
  // Create a new session for this device...
  const { token, maxAgeSec } = createSession(req.user);
  // ...and send its cookie.
  res.set('Set-Cookie', sessionCookie(token, maxAgeSec, req.secure));
  // Confirm.
  res.json({ ok: true });
});

// ----- Owner logins (main admin only) -----
// List the logins for one business (admin only).
admin.get('/businesses/:id/logins', adminOnly, (req, res) => res.json(listLogins(req.params.id)));
// Create a new owner login for a business (admin only).
admin.post('/businesses/:id/logins', adminOnly, (req, res) => {
  // The business must exist.
  if (!getBusiness(req.params.id)) return res.status(404).json({ error: 'Business not found' });
  // The demo business has no owner logins.
  if (isDemoBusiness(req.params.id)) return res.status(400).json({ error: 'The demo business uses the one-click demo login instead.' });
  try {
    // Create the login and send it back (never the password).
    res.json(createLogin(req.params.id, req.body || {}));
  } catch (err) {
    // Bad email, duplicate email or short password: show why.
    res.status(400).json({ error: err.message });
  }
});
// The admin sets a new password for an owner login.
admin.post('/logins/:uid/password', adminOnly, (req, res) => {
  try {
    // Save the new password.
    const u = setPassword(req.params.uid, req.body?.password);
    // Unknown login: 404.
    if (!u) return res.status(404).json({ error: 'Login not found' });
    destroySessionsWhere((s) => s.id === u.id); // the old password stops working everywhere
    // Send the updated login (no password).
    res.json(u);
  } catch (err) {
    // Password too short or too long: show why.
    res.status(400).json({ error: err.message });
  }
});
// The admin deletes an owner login.
admin.delete('/logins/:uid', adminOnly, (req, res) => {
  // Look the login up first.
  const u = getLogin(req.params.uid);
  // Unknown login (or delete failed): 404.
  if (!u || !deleteLogin(u.id)) return res.status(404).json({ error: 'Login not found' });
  // Sign that person out everywhere.
  destroySessionsWhere((s) => s.id === u.id);
  // Confirm.
  res.json({ ok: true });
});

// Dashboard status: is the AI on, is email live, what can be drafted, etc.
admin.get('/status', (req, res) =>
  res.json({
    // AI on/off and the model name.
    ai: aiInfo(),
    // Email provider and whether it's live.
    email: mailerInfo(),
    // The kinds of messages the AI can draft.
    draftKinds,
    // Campaign goals as { key: label }.
    campaignGoals: Object.fromEntries(Object.entries(CAMPAIGN_GOALS).map(([k, v]) => [k, v.label])),
    // Warn the admin (only) if the admin password is weak.
    weakPassword: isAdmin(req) && isWeakPassword(ADMIN_PASSWORD),
    // WhatsApp/Instagram connection status.
    social: socialInfo(),
    // How long before an inquiry needs a follow-up.
    followUpAfterHours: FOLLOW_UP_AFTER_HOURS,
  })
);
// The list of businesses this person may see.
admin.get('/businesses', (req, res) => res.json(listBusinesses().filter((b) => canSee(req, b.id))));

// One business's full profile (access already checked by the :id guard).
admin.get('/businesses/:id', (req, res) => {
  // Load it.
  const biz = getBusiness(req.params.id);
  // Missing: 404.
  if (!biz) return res.status(404).json({ error: 'Not found' });
  // Send it.
  res.json(biz);
});

// Save a business profile (blocked in the demo).
admin.post('/businesses', noDemo, (req, res) => {
  // Owners may edit their own profile, but not create or overwrite another business.
  if (!isAdmin(req) && req.body?.id !== req.user.businessId) return res.status(403).json({ error: 'You can only edit your own business.' });
  try {
    // Clean up and save the profile, then send back the saved version.
    res.json(saveBusiness(req.body || {}));
  } catch (err) {
    // Missing name, etc.: show why.
    res.status(400).json({ error: err.message });
  }
});

// All inquiries (leads) for a business.
admin.get('/businesses/:id/leads', (req, res) => res.json(listLeads(req.params.id)));
// All chat conversations for a business.
admin.get('/businesses/:id/conversations', (req, res) => res.json(listConversations(req.params.id)));

// Routes that look a record up by its own id check its business before touching it.
// Guard: the lead in the address must belong to a business this person can see.
const ownLead = (req, res, next) => (canSee(req, getLead(req.params.leadId)?.businessId) ? next() : res.status(404).json({ error: 'Not found' }));
// Guard: same for a campaign.
const ownCampaign = (req, res, next) => (canSee(req, getCampaign(req.params.cid)?.businessId) ? next() : res.status(404).json({ error: 'Not found' }));
// Guard: same for one campaign email.
const ownMessage = (req, res, next) => (canSee(req, getMessage(req.params.mid)?.businessId) ? next() : res.status(404).json({ error: 'Not found' }));

// Change an inquiry's status (new, contacted, booked...).
admin.patch('/leads/:leadId', ownLead, (req, res) => {
  // Save the new status.
  const lead = updateLeadStatus(req.params.leadId, req.body?.status);
  // Invalid status: 400.
  if (!lead) return res.status(400).json({ error: 'Could not update lead' });
  // Send back the updated inquiry.
  res.json(lead);
});

// ----- Follow-ups for inquiries who haven't booked -----
// Many people ask once and never hear back. The dashboard flags inquiries that
// have waited too long; the owner gets an AI-written follow-up to send by email
// (from here) or by WhatsApp (opens their own WhatsApp with the message ready).

// Turn "0803 555 0199" into "2348035550199" for WhatsApp links, using the
// business's own country code ("+234 800 ...") when the number starts with 0.
// Turn a phone number into WhatsApp format.
function whatsappNumber(phone, biz) {
  // The number as typed, without outer spaces.
  const raw = String(phone || '').trim();
  // Keep only the digits.
  let digits = raw.replace(/\D/g, '');
  // No digits: no WhatsApp link.
  if (!digits) return '';
  // A local number (starts with 0, no +)...
  if (!raw.startsWith('+') && digits.startsWith('0')) {
    // ...take the country code from the business's own phone number, e.g. "+234 ..." gives 234...
    const cc = String(biz.phone || '').match(/^\+(\d{1,3})[\s-]/)?.[1];
    // ...if the business number has no country code, we can't build a link.
    if (!cc) return '';
    // ...replace the leading 0 with the country code.
    digits = cc + digits.slice(1);
  }
  // Real phone numbers have 8 to 15 digits; anything else gets no link.
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

// Ask the AI to write a follow-up message for an inquiry.
admin.post('/leads/:leadId/follow-up/draft', ownLead, async (req, res) => {
  // Load the inquiry...
  const lead = getLead(req.params.leadId);
  // ...and its business.
  const biz = lead && getBusiness(lead.businessId);
  // Missing: 404.
  if (!biz) return res.status(404).json({ error: 'Not found' });
  try {
    // Draft a follow-up using their first name and what they were interested in.
    const d = await draftMessage(biz, 'lead_follow_up', { customerName: (lead.name || '').split(' ')[0], notes: lead.interest || '' });
    // Their number in WhatsApp format (empty if unusable).
    const wa = whatsappNumber(lead.phone, biz);
    // Send the draft, a WhatsApp link with the message filled in, and whether email is possible.
    res.json({ ...d, whatsappUrl: wa ? `https://wa.me/${wa}?text=${encodeURIComponent(d.sms)}` : '', canEmail: Boolean(lead.email) });
  } catch (err) {
    // AI or input problem: show why.
    res.status(400).json({ error: err.message });
  }
});

// Send (or record) a follow-up.
admin.post('/leads/:leadId/follow-up/send', ownLead, async (req, res) => {
  // Load the inquiry and its business.
  const lead = getLead(req.params.leadId);
  const biz = lead && getBusiness(lead.businessId);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  // WhatsApp or email (email is the default).
  const channel = req.body?.channel === 'whatsapp' ? 'whatsapp' : 'email';
  // For email:
  if (channel === 'email') {
    // The subject the owner chose (max 120 characters).
    const subject = String(req.body?.subject || `Following up from ${biz.name}`).slice(0, 120);
    // The message the owner approved (max 3000 characters).
    const text = String(req.body?.text || '').trim().slice(0, 3000);
    // Can't email someone with no email address.
    if (!lead.email) return res.status(400).json({ error: 'This person has no email address.' });
    // Can't send an empty message.
    if (!text) return res.status(400).json({ error: 'Write a message first.' });
    // Demo: mark it as followed up without sending any email.
    if (isDemoBusiness(biz.id)) return res.json(markFollowedUp(lead.id, channel)); // demo: pretend, never email
    try {
      // Sign off with the business name and address.
      const signature = [`— ${biz.name}`, biz.address].filter(Boolean).join('\n');
      // Send it from the business name; replies go to the business's own email.
      await sendEmail({ to: lead.email, toName: lead.name, fromName: biz.name, replyTo: biz.email, subject, text: `${text}\n\n${signature}` });
    } catch (err) {
      // Sending failed: show why.
      return res.status(400).json({ error: err.message });
    }
  }
  // For WhatsApp the owner sends it from their own phone; we just record it.
  // Mark the inquiry as followed up on this channel and send it back.
  res.json(markFollowedUp(lead.id, channel));
});

// Ask the AI to draft a one-off message (thank-you, review request, etc.).
admin.post('/businesses/:id/draft', async (req, res) => {
  // Load the business.
  const biz = getBusiness(req.params.id);
  // Missing: 404.
  if (!biz) return res.status(404).json({ error: 'Not found' });
  try {
    // Read what kind of message, the customer's name and notes.
    const { kind, customerName, notes } = req.body || {};
    // Draft it (name max 80 characters, notes max 500) and send it back.
    res.json(await draftMessage(biz, kind, { customerName: String(customerName || '').slice(0, 80), notes: String(notes || '').slice(0, 500) }));
  } catch (err) {
    // Unknown kind or AI problem: show why.
    res.status(400).json({ error: err.message });
  }
});

// ----- Contacts -----

// Helper: load the business, run the route's code, send the result as JSON, and turn errors into 400s.
const withBiz = (handler) => (req, res) => {
  // Load the business in the address.
  const biz = getBusiness(req.params.id);
  // Missing: 404.
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  try {
    // Run the route's code and send what it returns.
    res.json(handler(biz, req));
  } catch (err) {
    // Errors become friendly 400 answers.
    res.status(400).json({ error: err.message });
  }
};

// The business's contact list, each with how many friends they referred.
admin.get(
  '/businesses/:id/contacts',
  withBiz((biz) => {
    // Count referrals per contact once.
    const counts = referralCounts(biz.id);
    // Add the count to each contact.
    return listContacts(biz.id).map((c) => ({ ...c, referrals: counts[c.id] || 0 }));
  })
);
// Import contacts from a pasted/uploaded CSV (blocked in the demo).
admin.post('/businesses/:id/contacts/import', noDemo, withBiz((biz, req) => importContacts(biz.id, String(req.body?.csv || ''))));
// Delete every contact of a business.
admin.delete('/businesses/:id/contacts', withBiz((biz) => (deleteContacts(biz.id), { ok: true })));
// Delete one contact.
admin.delete(
  '/businesses/:id/contacts/:contactId',
  withBiz((biz, req) => {
    // Unknown contact: becomes a 400 error.
    if (!deleteContact(biz.id, req.params.contactId)) throw new Error('Contact not found');
    // Confirm.
    return { ok: true };
  })
);

// ----- Campaigns -----

// How many contacts match the chosen campaign filters.
admin.get('/businesses/:id/audience', withBiz((biz, req) => ({ count: previewAudience(biz.id, req.query) })));
// All campaigns of a business.
admin.get('/businesses/:id/campaigns', withBiz((biz) => listCampaigns(biz.id)));
// Create a campaign: the AI writes one personal email per contact, waiting for approval.
admin.post('/businesses/:id/campaigns', withBiz((biz, req) => createCampaign(biz.id, req.body || {})));

// Helper: run a route's code, 404 when it returns nothing, 400 on errors.
const handle = (fn) => (req, res) => {
  try {
    // Run the code.
    const out = fn(req);
    // Nothing found: 404.
    if (out == null) return res.status(404).json({ error: 'Not found' });
    // Send the result.
    res.json(out);
  } catch (err) {
    // Errors become 400 answers.
    res.status(400).json({ error: err.message });
  }
};

// One campaign with all its emails.
admin.get('/campaigns/:cid', ownCampaign, handle((req) => getCampaign(req.params.cid)));
// Approve every email still waiting.
admin.post('/campaigns/:cid/approve-all', ownCampaign, handle((req) => ({ approved: approveAll(req.params.cid) })));
// Start sending the approved emails.
admin.post('/campaigns/:cid/send', ownCampaign, handle((req) => startSending(req.params.cid)));
// Edit or approve/skip one email.
admin.patch('/messages/:mid', ownMessage, handle((req) => updateMessage(req.params.mid, req.body || {})));

// Attach all the dashboard routes under /api/admin.
app.use('/api/admin', admin);

// ---------- Errors ----------

// Any address nothing else answered: 404 Not found.
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Never show internal error details (file paths, stack traces) to visitors.
// The error handler (Express knows it by its 4 arguments).
app.use((err, req, res, next) => {
  // Body bigger than the limit: 413.
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  // Broken JSON: 400.
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  // Anything else: log the full details on the server only...
  console.error('[error]', err);
  // ...and give visitors a plain message.
  res.status(500).json({ error: 'Something went wrong.' });
});

// Connect storage (files locally, Postgres when DATABASE_URL is set) before serving.
// Open storage before answering requests (await waits for it to finish).
const storage = await initStore();
backfillReferralCodes(); // contacts imported before referrals existed get an invite code
resetDemo(); // the sample business starts fresh after every restart

// Start listening for visitors on the port.
app.listen(PORT, () => {
  // Read the AI settings for the start-up message.
  const ai = aiInfo();
  // Print the address to open.
  console.log(`\nMarketing agent running → http://localhost:${PORT}/admin`);
  // Print which storage is in use.
  console.log(`Storage: ${storage === 'database' ? 'Postgres database (DATABASE_URL)' : 'local files'}`);
  // Print whether real AI is on.
  console.log(`AI mode: ${ai.enabled ? `ON (${ai.model})` : 'OFFLINE rules (add AI_API_KEY to .env for real AI)'}`);
  // Read the email settings.
  const mail = mailerInfo();
  // Print whether email is live or in test mode.
  console.log(`Email: ${mail.live ? `LIVE via ${mail.provider}` : mail.provider === 'log' ? 'TEST mode, emails saved to data/outbox.json, nothing is sent' : `${mail.provider} NOT configured`}`);
  // Warn if the admin password is weak.
  if (isWeakPassword(ADMIN_PASSWORD)) console.log(`Dashboard password is weak${ADMIN_PASSWORD === 'changeme' ? ' (changeme)' : ''}. Set a strong ADMIN_PASSWORD in .env before going live.\n`);
});
