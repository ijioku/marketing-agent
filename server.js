import express from 'express';
import path from 'node:path';
import { getBusiness, listBusinesses, saveBusiness, publicProfile, isValidId } from './lib/businesses.js';
import { getConversation, appendMessages, listConversations, upsertLead, listLeads, updateLeadStatus } from './lib/store.js';
import { chatReply, draftMessage, draftKinds, aiInfo, CAMPAIGN_GOALS } from './lib/ai.js';
import { importContacts, listContacts, deleteContacts, unsubscribeByToken } from './lib/contacts.js';
import { previewAudience, createCampaign, listCampaigns, getCampaign, updateMessage, approveAll, startSending } from './lib/campaigns.js';
import { mailerInfo } from './lib/mailer.js';
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
  const lead = upsertLead(businessId, sessionId, result.lead || {});
  if (lead) console.log(`[lead] ${biz.name}: new or updated lead`);

  res.json({ reply: result.reply });
});

// ---------- Static files and pages ----------

app.use(express.static(PUBLIC_DIR, { index: false }));
app.get('/demo/:id', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'demo.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/', (req, res) => res.redirect('/admin'));

// Unsubscribe link in every campaign email. GET shows a confirm button
// (so link scanners can't unsubscribe people by accident); POST does it,
// which also supports one-click unsubscribe from Gmail/Outlook.
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
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

admin.get('/businesses/:id/contacts', withBiz((biz) => listContacts(biz.id)));
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

app.listen(PORT, () => {
  const ai = aiInfo();
  console.log(`\nMarketing agent running → http://localhost:${PORT}/admin`);
  console.log(`AI mode: ${ai.enabled ? `ON (${ai.model})` : 'OFFLINE rules (add AI_API_KEY to .env for real AI)'}`);
  const mail = mailerInfo();
  console.log(`Email: ${mail.live ? `LIVE via ${mail.provider}` : mail.provider === 'log' ? 'TEST mode, emails saved to data/outbox.json, nothing is sent' : `${mail.provider} NOT configured`}`);
  if (isWeakPassword(ADMIN_PASSWORD)) console.log(`Dashboard password is weak${ADMIN_PASSWORD === 'changeme' ? ' (changeme)' : ''}. Set a strong ADMIN_PASSWORD in .env before going live.\n`);
});
