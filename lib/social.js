// WhatsApp + Instagram auto-replies through Meta's official APIs
// (WhatsApp Cloud API and the Instagram Messaging API).
//
// How it works: Meta sends every new customer message to our webhook
// (/webhooks/meta). We check Meta's signature, let the same AI that powers the
// website chat write a reply from the business profile, and send it back.
//
// Until real tokens are added to .env, replies are saved to
// data/social_outbox.json instead of being sent (test mode), the same way email works.
import crypto from 'node:crypto';
import { load, save } from './store.js';

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v21.0'}`;
const APP_SECRET = process.env.META_APP_SECRET || '';
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const WA_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const IG_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || '';

// "id:business-id,id2:business-id2" → Map. Which business owns which WhatsApp
// number / Instagram account.
function parseRoutes(text) {
  const map = new Map();
  for (const pair of String(text || '').split(',')) {
    const [id, biz] = pair.split(':').map((s) => s?.trim());
    if (id && biz) map.set(id, biz);
  }
  return map;
}
const WA_ROUTES = parseRoutes(process.env.WHATSAPP_ROUTES);
const IG_ROUTES = parseRoutes(process.env.INSTAGRAM_ROUTES);

export function socialInfo() {
  return {
    webhookReady: Boolean(APP_SECRET && VERIFY_TOKEN),
    whatsapp: { numbers: WA_ROUTES.size, live: Boolean(WA_TOKEN) },
    instagram: { accounts: IG_ROUTES.size, live: Boolean(IG_TOKEN) },
  };
}

// ---------- Webhook security ----------

// Meta's one-time check when you register the webhook URL.
export function verifyChallenge(query) {
  if (!VERIFY_TOKEN) return null;
  const given = Buffer.from(String(query['hub.verify_token'] || ''));
  const expected = Buffer.from(VERIFY_TOKEN);
  if (query['hub.mode'] === 'subscribe' && given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
    return String(query['hub.challenge'] || '');
  }
  return null;
}

// Every webhook call is signed by Meta with our app secret. Anything unsigned or
// wrongly signed is a fake and is rejected, so nobody can make the bot talk by
// sending us made-up messages.
export function isValidSignature(rawBody, header) {
  if (!APP_SECRET || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// ---------- Parse incoming messages ----------

// Turns Meta's nested payloads into simple { channel, businessId, from, name, text, id } items.
export function extractMessages(payload) {
  const out = [];
  if (payload?.object === 'whatsapp_business_account') {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        const businessId = WA_ROUTES.get(String(v.metadata?.phone_number_id || ''));
        if (change.field !== 'messages' || !businessId) continue;
        const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
        for (const m of v.messages || []) {
          out.push({
            channel: 'whatsapp',
            businessId,
            accountId: String(v.metadata.phone_number_id),
            from: String(m.from || ''),
            name: names[m.from] || '',
            text: m.type === 'text' ? String(m.text?.body || '') : '',
            id: String(m.id || ''),
          });
        }
      }
    }
  } else if (payload?.object === 'instagram') {
    for (const entry of payload.entry || []) {
      const businessId = IG_ROUTES.get(String(entry.id || ''));
      if (!businessId) continue;
      for (const ev of entry.messaging || []) {
        if (!ev.message || ev.message.is_echo) continue; // skip our own replies
        out.push({
          channel: 'instagram',
          businessId,
          accountId: String(entry.id),
          from: String(ev.sender?.id || ''),
          name: '',
          text: String(ev.message.text || ''),
          id: String(ev.message.mid || ''),
        });
      }
    }
  }
  return out.filter((m) => /^[\w.:-]{1,80}$/.test(m.from) && m.id);
}

// Meta may deliver the same message more than once; remember recent ids.
const seen = new Set();
export function isDuplicate(id) {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  return false;
}

// ---------- Send replies ----------

async function postGraph(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Meta API error ${res.status}`);
  return data;
}

function saveTestReply(entry) {
  const box = load('social_outbox', []);
  box.push({ ...entry, savedAt: new Date().toISOString() });
  save('social_outbox', box.slice(-500));
}

export async function sendReply(msg, text) {
  if (msg.channel === 'whatsapp') {
    const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: msg.from, type: 'text', text: { body: text.slice(0, 4000), preview_url: true } };
    if (!WA_TOKEN) return saveTestReply({ channel: 'whatsapp', to: msg.from, text });
    return postGraph(`${GRAPH}/${msg.accountId}/messages`, WA_TOKEN, body);
  }
  if (msg.channel === 'instagram') {
    const body = { recipient: { id: msg.from }, message: { text: text.slice(0, 990) } }; // Instagram limit ~1000 chars
    if (!IG_TOKEN) return saveTestReply({ channel: 'instagram', to: msg.from, text });
    return postGraph(`${GRAPH}/me/messages`, IG_TOKEN, body);
  }
  throw new Error('Unknown channel');
}
