// WhatsApp + Instagram auto-replies through Meta's official APIs
// (WhatsApp Cloud API and the Instagram Messaging API).
//
// How it works: Meta sends every new customer message to our webhook
// (/webhooks/meta). We check Meta's signature, let the same AI that powers the
// website chat write a reply from the business profile, and send it back.
//
// Until real tokens are added to .env, replies are saved to
// data/social_outbox.json instead of being sent (test mode), the same way email works.
// crypto: checks Meta's signatures and compares tokens safely.
import crypto from 'node:crypto';
// load/save: store replies in test mode.
import { load, save } from './store.js';

// Meta's API address, including the version number.
const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v21.0'}`;
// Our Meta app secret: used to check that webhook calls really come from Meta.
const APP_SECRET = process.env.META_APP_SECRET || '';
// A word we choose and give Meta, so Meta can prove the webhook is ours.
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
// The token that lets us send WhatsApp messages (empty = test mode).
const WA_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
// The token that lets us send Instagram messages (empty = test mode).
const IG_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || '';

// "id:business-id,id2:business-id2" → Map. Which business owns which WhatsApp
// number / Instagram account.
// Turn the settings text into a lookup table.
function parseRoutes(text) {
  // An empty table.
  const map = new Map();
  // Split the text at commas into pairs.
  for (const pair of String(text || '').split(',')) {
    // Split each pair at the colon: account id and business id.
    const [id, biz] = pair.split(':').map((s) => s?.trim());
    // Keep only complete pairs.
    if (id && biz) map.set(id, biz);
  }
  // Hand back the table.
  return map;
}
// WhatsApp number id -> business.
const WA_ROUTES = parseRoutes(process.env.WHATSAPP_ROUTES);
// Instagram account id -> business.
const IG_ROUTES = parseRoutes(process.env.INSTAGRAM_ROUTES);

// Connection status for the dashboard.
export function socialInfo() {
  return {
    // The webhook works once both the app secret and verify token are set.
    webhookReady: Boolean(APP_SECRET && VERIFY_TOKEN),
    // How many WhatsApp numbers are connected, and whether replies really send.
    whatsapp: { numbers: WA_ROUTES.size, live: Boolean(WA_TOKEN) },
    // The same for Instagram.
    instagram: { accounts: IG_ROUTES.size, live: Boolean(IG_TOKEN) },
  };
}

// ---------- Webhook security ----------

// Meta's one-time check when you register the webhook URL.
// Check Meta's setup request.
export function verifyChallenge(query) {
  // No verify token set: can't confirm anything.
  if (!VERIFY_TOKEN) return null;
  // The token Meta sent...
  const given = Buffer.from(String(query['hub.verify_token'] || ''));
  // ...and ours, as bytes.
  const expected = Buffer.from(VERIFY_TOKEN);
  // Meta must be subscribing, and the tokens must match (compared in constant time).
  if (query['hub.mode'] === 'subscribe' && given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
    // Hand back the challenge text Meta wants echoed.
    return String(query['hub.challenge'] || '');
  }
  // Anything else: refuse.
  return null;
}

// Every webhook call is signed by Meta with our app secret. Anything unsigned or
// wrongly signed is a fake and is rejected, so nobody can make the bot talk by
// sending us made-up messages.
// Check a webhook call's signature.
export function isValidSignature(rawBody, header) {
  // No secret, or a missing/badly formed signature header: reject.
  if (!APP_SECRET || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  // Work out what the signature should be: an HMAC-SHA256 of the raw body using our secret.
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`);
  // The signature Meta sent.
  const given = Buffer.from(header);
  // They must be the same length and match (constant-time comparison).
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// ---------- Parse incoming messages ----------

// Turns Meta's nested payloads into simple { channel, businessId, from, name, text, id } items.
// Collect messages into this list.
export function extractMessages(payload) {
  const out = [];
  // A WhatsApp delivery:
  if (payload?.object === 'whatsapp_business_account') {
    // Go through each entry...
    for (const entry of payload.entry || []) {
      // ...and each change in it.
      for (const change of entry.changes || []) {
        // The change's details.
        const v = change.value || {};
        // Which of our businesses owns the WhatsApp number that got the message.
        const businessId = WA_ROUTES.get(String(v.metadata?.phone_number_id || ''));
        // Not a message, or not our number: skip.
        if (change.field !== 'messages' || !businessId) continue;
        // Senders' WhatsApp profile names, by their number.
        const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
        // Each message in the change:
        for (const m of v.messages || []) {
          // Add a simplified message to the list.
          out.push({
            channel: 'whatsapp',
            businessId,
            accountId: String(v.metadata.phone_number_id),
            from: String(m.from || ''),
            name: names[m.from] || '',
            // Only text messages have text; photos, voice notes etc. get empty text.
            text: m.type === 'text' ? String(m.text?.body || '') : '',
            id: String(m.id || ''),
          });
        }
      }
    }
  // An Instagram delivery:
  } else if (payload?.object === 'instagram') {
    // Go through each entry (one per Instagram account).
    for (const entry of payload.entry || []) {
      // Which of our businesses owns this Instagram account.
      const businessId = IG_ROUTES.get(String(entry.id || ''));
      // Not ours: skip.
      if (!businessId) continue;
      // Each messaging event:
      for (const ev of entry.messaging || []) {
        if (!ev.message || ev.message.is_echo) continue; // skip our own replies
        // Add a simplified message to the list.
        out.push({
          channel: 'instagram',
          businessId,
          accountId: String(entry.id),
          from: String(ev.sender?.id || ''),
          // Instagram doesn't send the sender's name here.
          name: '',
          text: String(ev.message.text || ''),
          id: String(ev.message.mid || ''),
        });
      }
    }
  }
  // Keep only messages with a sane sender id and a message id.
  return out.filter((m) => /^[\w.:-]{1,80}$/.test(m.from) && m.id);
}

// Meta may deliver the same message more than once; remember recent ids.
// Message ids we've already handled.
const seen = new Set();
// True if we've seen this message id before.
export function isDuplicate(id) {
  // Seen it: it's a duplicate.
  if (seen.has(id)) return true;
  // Remember it.
  seen.add(id);
  // Keep at most 5000 ids by forgetting the oldest.
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  // New message.
  return false;
}

// ---------- Send replies ----------

// Send a request to Meta's API with our token.
async function postGraph(url, token, body) {
  // POST the request.
  const res = await fetch(url, {
    method: 'POST',
    // JSON body, signed with the token.
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    // The request itself.
    body: JSON.stringify(body),
    // Give up after 20 seconds.
    signal: AbortSignal.timeout(20_000),
  });
  // Read Meta's answer (empty if it isn't JSON).
  const data = await res.json().catch(() => ({}));
  // Meta refused: stop with its error message.
  if (!res.ok) throw new Error(data.error?.message || `Meta API error ${res.status}`);
  // Hand back Meta's answer.
  return data;
}

// Test mode: save the reply instead of sending it.
function saveTestReply(entry) {
  // Load the saved test replies.
  const box = load('social_outbox', []);
  // Add this one with the time.
  box.push({ ...entry, savedAt: new Date().toISOString() });
  // Keep the newest 500.
  save('social_outbox', box.slice(-500));
}

// Send the AI's reply back on the channel the customer used.
export async function sendReply(msg, text) {
  // WhatsApp:
  if (msg.channel === 'whatsapp') {
    // WhatsApp's message format (max 4000 characters, with link previews).
    const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: msg.from, type: 'text', text: { body: text.slice(0, 4000), preview_url: true } };
    // No token: test mode, save it.
    if (!WA_TOKEN) return saveTestReply({ channel: 'whatsapp', to: msg.from, text });
    // Send through the business's WhatsApp number.
    return postGraph(`${GRAPH}/${msg.accountId}/messages`, WA_TOKEN, body);
  }
  // Instagram:
  if (msg.channel === 'instagram') {
    // Instagram's message format.
    const body = { recipient: { id: msg.from }, message: { text: text.slice(0, 990) } }; // Instagram limit ~1000 chars
    // No token: test mode, save it.
    if (!IG_TOKEN) return saveTestReply({ channel: 'instagram', to: msg.from, text });
    // Send through the Instagram account.
    return postGraph(`${GRAPH}/me/messages`, IG_TOKEN, body);
  }
  // Any other channel is a mistake.
  throw new Error('Unknown channel');
}
