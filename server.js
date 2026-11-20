import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getBusiness, listBusinesses, saveBusiness, publicProfile, isValidId } from './lib/businesses.js';
import { initStore, getConversation, appendMessages, listConversations, upsertLead, listLeads, updateLeadStatus, addReferralLead, referralCounts, getLead, markFollowedUp } from './lib/store.js';
import { chatReply, draftMessage, draftKinds, aiInfo, CAMPAIGN_GOALS } from './lib/ai.js';
import { privacyBody, termsBody } from './lib/legal.js';
import { importContacts, listContacts, deleteContact, deleteContacts, unsubscribeByToken, getContactByReferralCode, backfillReferralCodes } from './lib/contacts.js';
import { previewAudience, createCampaign, listCampaigns, getCampaign, getMessage, updateMessage, approveAll, startSending } from './lib/campaigns.js';
import { mailerInfo, sendEmail } from './lib/mailer.js';
import { socialInfo, verifyChallenge, isValidSignature, extractMessages, isDuplicate, sendReply } from './lib/social.js';
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
import { authenticate, listLogins, getLogin, createLogin, setPassword, deleteLogin, checkCurrentPassword, sessionUserForEmail, createResetToken, resetPasswordWithToken } from './lib/accounts.js';
import { GOOGLE_CLIENT_ID, verifyGoogleCredential } from './lib/google.js';
import { DEMO_ID, isDemoBusiness, resetDemo, ensureFreshDemo, demoActivity } from './lib/demo.js';

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
// The main admin signs in with this username (or an empty username) + ADMIN_PASSWORD.
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
// Optional: the main admin's own email, so they can also sign in with it (password or Google).
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const APP_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
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
// Sample sites, invite links, unsubscribe pages and the API should never appear in Google.
app.use(['/demo', '/r', '/u', '/api'], (req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });

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
  if (!biz.email || isDemoBusiness(biz.id)) return; // the sample business never emails anyone
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

// Shared look for the small server-made pages (invite, unsubscribe): same font, light/dark
// theme (following the saved System/Dark/Light choice) and the interactive dot background.
const DARK_TOKENS = 'color-scheme:dark;--bg:#0d0e11;--card:#16181d;--text:#eceef2;--muted:#9aa1ad;--line:#262a31;--dot:rgba(236,238,242,.2)';
// `meta` = { description, url, image } for search results and WhatsApp/Facebook link previews.
const metaTags = ({ title, description, url, image = `${APP_URL}/og.png` }) =>
  description
    ? `<meta name="description" content="${escapeHtml(description)}">${url ? `<link rel="canonical" href="${escapeHtml(url)}"><meta property="og:url" content="${escapeHtml(url)}">` : ''}
<meta property="og:type" content="website"><meta property="og:site_name" content="Marketing Agent"><meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}"><meta property="og:image" content="${escapeHtml(image)}"><meta name="twitter:card" content="summary_large_image">`
    : '';
const pageHead = (title, meta = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${metaTags({ title, ...meta })}<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&display=swap">
<script>try{document.documentElement.dataset.theme=localStorage.getItem('ma-theme')||'system'}catch(e){document.documentElement.dataset.theme='system'}</script>
<style>
:root{color-scheme:light;--bg:#fff;--card:#fff;--text:#1b1c1f;--muted:#5e6470;--line:#e6e8ec;--dot:rgba(27,28,31,.16)}
:root[data-theme=dark]{${DARK_TOKENS}}
@media (prefers-color-scheme:dark){:root[data-theme=system]{${DARK_TOKENS}}}
*{box-sizing:border-box}body{margin:0;font-family:'Bricolage Grotesque',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:grid;place-items:center;padding:16px;line-height:1.5}
#field{position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none}
h1,h2{letter-spacing:-.03em}`;
const motionBackground = (colors) =>
  `<canvas id="field" aria-hidden="true"></canvas><script src="/motion.js"></script><script>window.MotionField&&MotionField.start(document.getElementById('field'),{density:5200,colors:${JSON.stringify(colors)}})</script>`;

function invitePage(biz, referrer, { body, title, description }) {
  const color = /^#[0-9a-fA-F]{6}$/.test(biz.brandColor || '') ? biz.brandColor : '#2563eb';
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

const referralLimit = rateLimiter({ windowMs: 15 * 60_000, max: 20 });
app.use('/r', express.urlencoded({ extended: false, limit: '4kb' }));

// ?preview=1 = the owner opened it from the dashboard: show a way back.
const previewBar = (on) => (on ? '<p class="muted" style="margin:0 0 14px">👀 Preview: this is what your customer\'s friend sees. <a href="/admin#leads">← Back to dashboard</a></p>' : '');

app.get('/r/:code', (req, res) => {
  const preview = req.query.preview === '1';
  const referrer = getContactByReferralCode(req.params.code);
  const biz = referrer && getBusiness(referrer.businessId);
  if (!biz) return res.status(404).send(page('Invite not found', '<h2>Invite link not found</h2><p>Please check the link and try again.</p>'));
  const services = (biz.services || []).slice(0, 4).map((s) => `${escapeHtml(s.name)}${s.price ? ` · ${escapeHtml(s.price)}` : ''}`).join('<br>');
  res.send(
    invitePage(biz, referrer, {
      title: `${referrer.firstName || 'A friend'} invited you to ${biz.name}`,
      description: `🎁 ${biz.referralOffer || 'A special welcome offer'}. Tap to claim it. ${biz.tagline || ''}`.trim(),
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

app.post('/r/:code', (req, res) => {
  const referrer = getContactByReferralCode(req.params.code);
  const biz = referrer && getBusiness(referrer.businessId);
  if (!biz) return res.status(404).send(page('Invite not found', '<h2>Invite link not found</h2>'));
  if (!referralLimit(req.ip).allowed) return res.status(429).send(page('Slow down', '<h2>Too many requests</h2><p>Please try again later.</p>'));

  const { name = '', phone = '', email = '', website = '', preview = '' } = req.body || {};
  const isPreview = preview === '1';
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
        body: `<p class="err">Please enter your name and a phone number or email.</p><a class="btn" href="/r/${escapeHtml(referrer.referralCode)}${isPreview ? '?preview=1' : ''}">Go back</a>`,
      })
    );
  }
  res.send(
    invitePage(biz, referrer, {
      title: 'Offer claimed',
      body: `<h2 style="margin-top:0">You're in! 🎉</h2><p>${escapeHtml(biz.name)} has your details and will contact you to book. Your offer: <b>${escapeHtml(biz.referralOffer || 'welcome offer')}</b>.</p>
${/^https?:\/\//i.test(biz.bookingLink || '') ? `<a class="btn" href="${escapeHtml(biz.bookingLink)}" rel="noopener">Book now</a>` : ''}
${isPreview ? '<a class="btn" href="/admin#leads" style="background:transparent;color:var(--text);border:1px solid var(--line)">← Back to dashboard: see the new inquiry</a>' : ''}`,
    })
  );
});

// ---------- Static files and pages ----------

// The sign-in page carries search and link-preview tags that need the site's full address
// (WhatsApp and Google ignore relative links), so the server fills in __APP_URL__.
const adminHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8').replaceAll('__APP_URL__', APP_URL);
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));

// Search engines: list the public pages, keep private and one-off pages out of results.
app.get('/robots.txt', (req, res) =>
  res.type('text/plain').send(['User-agent: *', 'Allow: /admin', 'Allow: /privacy', 'Allow: /terms', 'Disallow: /api/', 'Disallow: /u/', 'Disallow: /demo', '', `Sitemap: ${APP_URL}/sitemap.xml`, ''].join('\n'))
);
app.get('/sitemap.xml', (req, res) => {
  // Image sitemap entries help Google Images find the pictures on each page.
  const pages = [['/admin', '1.0', ['/og.png', '/icon-512.png']], ['/privacy', '0.3', []], ['/terms', '0.3', []]];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${pages.map(([p, pr, imgs]) => `  <url><loc>${APP_URL}${p}</loc><priority>${pr}</priority>${imgs.map((i) => `<image:image><image:loc>${APP_URL}${i}</image:loc></image:image>`).join('')}</url>`).join('\n')}
</urlset>`);
});
app.use(express.static(PUBLIC_DIR, { index: false }));
app.get('/demo/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'demo.html')));
// A bare /demo link opens the first business's demo instead of a "Not found" error.
app.get('/demo', (req, res) => {
  const first = listBusinesses()[0];
  if (!first) return res.status(404).json({ error: 'Not found' });
  res.redirect(`/demo/${first.id}`);
});
app.get('/admin', (req, res) => res.type('html').send(adminHtml));
app.get('/', (req, res) => res.redirect('/admin'));
// Hosting platforms ping this to check the app is alive.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- Privacy policy and terms ----------

const SUPPORT_EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(process.env.SUPPORT_EMAIL || '') ? process.env.SUPPORT_EMAIL : '';
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
<script>(function(){var r=document.documentElement,b=document.querySelectorAll('.sw button');function s(t){r.dataset.theme=t;try{localStorage.setItem('ma-theme',t)}catch(e){}b.forEach(function(x){x.setAttribute('aria-pressed',String(x.dataset.t===t))})}b.forEach(function(x){x.onclick=function(){s(x.dataset.t)}});s(r.dataset.theme||'system')})()</script>
${motionBackground(['#6d5efc', '#12b5a5', '#f4b13e', '#ff6b3d'])}</body></html>`;

app.get('/privacy', (req, res) =>
  res.send(docPage('Privacy policy · Marketing Agent', privacyBody({ supportEmail: SUPPORT_EMAIL }), {
    description: 'What information Marketing Agent holds for businesses and their customers, who handles it, how it is protected and your rights under the Nigeria Data Protection Act.',
    url: `${APP_URL}/privacy`,
  }))
);
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
const page = (title, body) => `${pageHead(title)}
.c{background:var(--card);border:1px solid var(--line);border-radius:28px;padding:30px;max-width:420px;text-align:center}
.c h2{margin-top:0;font-weight:700}
button{background:var(--text);color:var(--bg);border:0;border-radius:999px;padding:0 22px;font:inherit;font-size:15px;font-weight:600;cursor:pointer;min-height:46px}
</style></head><body><div class="c">${body}</div>${motionBackground(['#6d5efc', '#12b5a5', '#f4b13e', '#ff6b3d'])}</body></html>`;

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

  // Empty username or "admin" = the main admin; anything else is a business owner's email.
  const username = String(req.body?.username ?? '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body?.password ?? '');
  let user = null;
  if (!username || username === ADMIN_USERNAME || (ADMIN_EMAIL && username === ADMIN_EMAIL)) {
    if (safeEqual(password, ADMIN_PASSWORD)) user = { id: 'admin', role: 'admin', name: 'Admin' };
  } else {
    user = authenticate(username, password);
  }

  if (!user) {
    const r = recordLoginFailure(ip);
    console.warn(`[security] failed login from ${ip}${r.locked ? ' (now locked)' : ''}`);
    if (r.locked) {
      res.set('Retry-After', String(r.retryAfterSec));
      return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil(r.retryAfterSec / 60)} minute(s).`, retryAfterSec: r.retryAfterSec });
    }
    return res.status(401).json({ error: `Wrong email or password. ${r.attemptsLeft} attempt(s) left before a 15-minute lock.` });
  }

  recordLoginSuccess(ip);
  const { token, maxAgeSec } = createSession(user);
  res.set('Set-Cookie', sessionCookie(token, maxAgeSec, req.secure));
  res.json({ ok: true, role: user.role });
});

// What the sign-in page needs to know (no secrets): is Google sign-in switched on?
app.get('/api/admin/auth-config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID || null }));

const sameSite = (req) => {
  const origin = req.get('origin');
  return !origin || origin === `${req.protocol}://${req.get('host')}`;
};

// ----- Continue with Google -----
// Google proves who the person is; they still need an existing login (or to be the admin).
const googleLimit = rateLimiter({ windowMs: 15 * 60_000, max: 30 });
app.post('/api/admin/google', async (req, res) => {
  if (!sameSite(req)) return res.status(403).json({ error: 'Blocked: request came from another website.' });
  if (!googleLimit(req.ip).allowed) return res.status(429).json({ error: 'Too many sign-in attempts. Please try again later.' });
  let who;
  try {
    who = await verifyGoogleCredential(req.body?.credential);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
  const user = ADMIN_EMAIL && who.email === ADMIN_EMAIL ? { id: 'admin', role: 'admin', name: who.name || 'Admin', email: who.email } : sessionUserForEmail(who.email);
  if (!user) return res.status(403).json({ error: `There's no account for ${who.email}. Ask the person who set up your business to add this email.` });
  const { token, maxAgeSec } = createSession(user);
  res.set('Set-Cookie', sessionCookie(token, maxAgeSec, req.secure));
  res.json({ ok: true, role: user.role });
});

// ----- Forgot password -----
// Always answers the same way, so nobody can use this to find out who has an account.
const forgotLimit = rateLimiter({ windowMs: 15 * 60_000, max: 5 });
app.post('/api/admin/forgot', (req, res) => {
  if (!sameSite(req)) return res.status(403).json({ error: 'Blocked: request came from another website.' });
  if (!forgotLimit(req.ip).allowed) return res.status(429).json({ error: 'Too many requests. Please try again in 15 minutes.' });
  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 120);
  const reply = { ok: true, message: 'If that email has an account, a reset link is on its way. It works for 30 minutes.' };
  const reset = email && createResetToken(email);
  if (reset) {
    const link = `${APP_URL}/admin#reset=${reset.token}`;
    sendEmail({
      to: reset.user.email,
      toName: reset.user.name,
      fromName: 'Marketing Agent',
      subject: 'Reset your password',
      text: [`Hi${reset.user.name ? ' ' + reset.user.name.split(' ')[0] : ''},`, '', 'Someone (hopefully you) asked to reset your dashboard password. Open this link to choose a new one:', '', link, '', 'It works once, for 30 minutes. If you did not ask for this, ignore this email: your password stays the same.'].join('\n'),
    }).catch((err) => console.error('[auth] reset email failed:', err.message));
    console.log(`[auth] password reset link created for ${reset.user.email}`);
  }
  res.json(reply);
});

const resetLimit = rateLimiter({ windowMs: 15 * 60_000, max: 10 });
app.post('/api/admin/reset', (req, res) => {
  if (!sameSite(req)) return res.status(403).json({ error: 'Blocked: request came from another website.' });
  if (!resetLimit(req.ip).allowed) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  let u;
  try {
    u = resetPasswordWithToken(req.body?.token, req.body?.password);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!u) return res.status(400).json({ error: 'This reset link is invalid, already used or expired. Ask for a new one.' });
  destroySessionsWhere((s) => s.id === u.id); // sign out everywhere with the old password
  res.json({ ok: true, email: u.email });
});

// "Try the demo": prospects sign into the sample business with one click, no password.
// They can only ever see and change the sample business, which resets itself.
const demoLoginLimit = rateLimiter({ windowMs: 15 * 60_000, max: 20 });
app.post('/api/admin/demo-login', (req, res) => {
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Blocked: request came from another website.' });
  if (!demoLoginLimit(req.ip).allowed) return res.status(429).json({ error: 'Too many demo sign-ins. Please try again later.' });
  ensureFreshDemo();
  const { token, maxAgeSec } = createSession({ id: 'demo', role: 'demo', businessId: DEMO_ID, name: 'Demo visitor' });
  res.set('Set-Cookie', sessionCookie(token, maxAgeSec, req.secure));
  res.json({ ok: true, role: 'demo' });
});

app.post('/api/admin/logout', (req, res) => {
  destroySession(readCookie(req, SESSION_COOKIE));
  res.set('Set-Cookie', sessionCookie('', 0, req.secure));
  res.json({ ok: true });
});

// ---------- Owner dashboard API (signed in only) ----------

const admin = express.Router();

admin.use((req, res, next) => {
  const user = getSessionUser(readCookie(req, SESSION_COOKIE));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  req.user = user;
  if (user.role === 'demo') demoActivity();
  // Extra CSRF guard: changes must come from this site, as JSON.
  if (req.method !== 'GET') {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Blocked: request came from another website.' });
    if (req.method !== 'DELETE' && !req.is('application/json')) return res.status(415).json({ error: 'Expected JSON.' });
  }
  next();
});

// ----- Who can see what -----
// The admin sees every business. An owner (or the demo visitor) only ever sees their own:
// asking for another business's data answers "Not found", as if it didn't exist.
const isAdmin = (req) => req.user.role === 'admin';
const canSee = (req, businessId) => isAdmin(req) || (Boolean(businessId) && req.user.businessId === businessId);
const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: 'Only the main admin can do this.' }));
const noDemo = (req, res, next) => (req.user.role === 'demo' ? res.status(403).json({ error: 'This is turned off in the demo.' }) : next());

// Every /businesses/:id/... route checks the business belongs to the signed-in user.
admin.param('id', (req, res, next, id) => (canSee(req, id) ? next() : res.status(404).json({ error: 'Not found' })));

admin.get('/me', (req, res) => {
  const { id, role, businessId, email, name } = req.user;
  res.json({ id, role, businessId, email, name });
});

// "Start over" in the demo: puts the sample hotel back to its starting state (for video
// retakes and new prospects). Only ever touches the demo business; owners can't call it.
const demoResetLimit = rateLimiter({ windowMs: 15 * 60_000, max: 30 });
admin.post('/demo/reset', (req, res) => {
  if (req.user.role !== 'demo' && !isAdmin(req)) return res.status(403).json({ error: 'Only the demo can be reset.' });
  if (!demoResetLimit(req.ip).allowed) return res.status(429).json({ error: 'Too many resets. Please wait a few minutes.' });
  resetDemo();
  res.json({ ok: true });
});

// Owners change their own password (they must know the current one).
admin.post('/me/password', noDemo, (req, res) => {
  if (req.user.role !== 'owner') return res.status(400).json({ error: 'The admin password is set in the server settings (ADMIN_PASSWORD).' });
  if (!checkCurrentPassword(req.user.id, req.body?.current)) return res.status(400).json({ error: 'Your current password is wrong.' });
  try {
    setPassword(req.user.id, req.body?.password);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  // Sign out every other device; this one gets a fresh session.
  destroySessionsWhere((u) => u.id === req.user.id);
  const { token, maxAgeSec } = createSession(req.user);
  res.set('Set-Cookie', sessionCookie(token, maxAgeSec, req.secure));
  res.json({ ok: true });
});

// ----- Owner logins (main admin only) -----
admin.get('/businesses/:id/logins', adminOnly, (req, res) => res.json(listLogins(req.params.id)));
admin.post('/businesses/:id/logins', adminOnly, (req, res) => {
  if (!getBusiness(req.params.id)) return res.status(404).json({ error: 'Business not found' });
  if (isDemoBusiness(req.params.id)) return res.status(400).json({ error: 'The demo business uses the one-click demo login instead.' });
  try {
    res.json(createLogin(req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
admin.post('/logins/:uid/password', adminOnly, (req, res) => {
  try {
    const u = setPassword(req.params.uid, req.body?.password);
    if (!u) return res.status(404).json({ error: 'Login not found' });
    destroySessionsWhere((s) => s.id === u.id); // the old password stops working everywhere
    res.json(u);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
admin.delete('/logins/:uid', adminOnly, (req, res) => {
  const u = getLogin(req.params.uid);
  if (!u || !deleteLogin(u.id)) return res.status(404).json({ error: 'Login not found' });
  destroySessionsWhere((s) => s.id === u.id);
  res.json({ ok: true });
});

admin.get('/status', (req, res) =>
  res.json({
    ai: aiInfo(),
    email: mailerInfo(),
    draftKinds,
    campaignGoals: Object.fromEntries(Object.entries(CAMPAIGN_GOALS).map(([k, v]) => [k, v.label])),
    weakPassword: isAdmin(req) && isWeakPassword(ADMIN_PASSWORD),
    social: socialInfo(),
    followUpAfterHours: FOLLOW_UP_AFTER_HOURS,
  })
);
admin.get('/businesses', (req, res) => res.json(listBusinesses().filter((b) => canSee(req, b.id))));

admin.get('/businesses/:id', (req, res) => {
  const biz = getBusiness(req.params.id);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  res.json(biz);
});

admin.post('/businesses', noDemo, (req, res) => {
  // Owners may edit their own profile, but not create or overwrite another business.
  if (!isAdmin(req) && req.body?.id !== req.user.businessId) return res.status(403).json({ error: 'You can only edit your own business.' });
  try {
    res.json(saveBusiness(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

admin.get('/businesses/:id/leads', (req, res) => res.json(listLeads(req.params.id)));
admin.get('/businesses/:id/conversations', (req, res) => res.json(listConversations(req.params.id)));

// Routes that look a record up by its own id check its business before touching it.
const ownLead = (req, res, next) => (canSee(req, getLead(req.params.leadId)?.businessId) ? next() : res.status(404).json({ error: 'Not found' }));
const ownCampaign = (req, res, next) => (canSee(req, getCampaign(req.params.cid)?.businessId) ? next() : res.status(404).json({ error: 'Not found' }));
const ownMessage = (req, res, next) => (canSee(req, getMessage(req.params.mid)?.businessId) ? next() : res.status(404).json({ error: 'Not found' }));

admin.patch('/leads/:leadId', ownLead, (req, res) => {
  const lead = updateLeadStatus(req.params.leadId, req.body?.status);
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

admin.post('/leads/:leadId/follow-up/draft', ownLead, async (req, res) => {
  const lead = getLead(req.params.leadId);
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

admin.post('/leads/:leadId/follow-up/send', ownLead, async (req, res) => {
  const lead = getLead(req.params.leadId);
  const biz = lead && getBusiness(lead.businessId);
  if (!biz) return res.status(404).json({ error: 'Not found' });
  const channel = req.body?.channel === 'whatsapp' ? 'whatsapp' : 'email';
  if (channel === 'email') {
    const subject = String(req.body?.subject || `Following up from ${biz.name}`).slice(0, 120);
    const text = String(req.body?.text || '').trim().slice(0, 3000);
    if (!lead.email) return res.status(400).json({ error: 'This person has no email address.' });
    if (!text) return res.status(400).json({ error: 'Write a message first.' });
    if (isDemoBusiness(biz.id)) return res.json(markFollowedUp(lead.id, channel)); // demo: pretend, never email
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
admin.post('/businesses/:id/contacts/import', noDemo, withBiz((biz, req) => importContacts(biz.id, String(req.body?.csv || ''))));
admin.delete('/businesses/:id/contacts', withBiz((biz) => (deleteContacts(biz.id), { ok: true })));
admin.delete(
  '/businesses/:id/contacts/:contactId',
  withBiz((biz, req) => {
    if (!deleteContact(biz.id, req.params.contactId)) throw new Error('Contact not found');
    return { ok: true };
  })
);

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

admin.get('/campaigns/:cid', ownCampaign, handle((req) => getCampaign(req.params.cid)));
admin.post('/campaigns/:cid/approve-all', ownCampaign, handle((req) => ({ approved: approveAll(req.params.cid) })));
admin.post('/campaigns/:cid/send', ownCampaign, handle((req) => startSending(req.params.cid)));
admin.patch('/messages/:mid', ownMessage, handle((req) => updateMessage(req.params.mid, req.body || {})));

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

// Connect storage (files locally, Postgres when DATABASE_URL is set) before serving.
const storage = await initStore();
backfillReferralCodes(); // contacts imported before referrals existed get an invite code
resetDemo(); // the sample business starts fresh after every restart

app.listen(PORT, () => {
  const ai = aiInfo();
  console.log(`\nMarketing agent running → http://localhost:${PORT}/admin`);
  console.log(`Storage: ${storage === 'database' ? 'Postgres database (DATABASE_URL)' : 'local files'}`);
  console.log(`AI mode: ${ai.enabled ? `ON (${ai.model})` : 'OFFLINE rules (add AI_API_KEY to .env for real AI)'}`);
  const mail = mailerInfo();
  console.log(`Email: ${mail.live ? `LIVE via ${mail.provider}` : mail.provider === 'log' ? 'TEST mode, emails saved to data/outbox.json, nothing is sent' : `${mail.provider} NOT configured`}`);
  if (isWeakPassword(ADMIN_PASSWORD)) console.log(`Dashboard password is weak${ADMIN_PASSWORD === 'changeme' ? ' (changeme)' : ''}. Set a strong ADMIN_PASSWORD in .env before going live.\n`);
});
