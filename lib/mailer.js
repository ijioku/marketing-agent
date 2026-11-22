// Email sending. Three modes:
//   log    (default) — nothing leaves your computer; emails are saved to data/outbox.json. Safe for demos.
//   resend — https://resend.com  (free tier, needs a verified domain)
//   brevo  — https://brevo.com   (free tier, can verify a single sender address)
// crypto: used to make unique ids for test-mode emails.
import crypto from 'node:crypto';
// load/save: read and write stored data (the test outbox).
import { load, save } from './store.js';

// Which provider to use: log (test), resend or brevo.
const PROVIDER = (process.env.EMAIL_PROVIDER || 'log').toLowerCase();
// The address emails come from (must be verified with the provider).
const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || '';
// The provider's secret API key.
const API_KEY = process.env.EMAIL_API_KEY || '';

// Tell the dashboard which email mode is active.
export function mailerInfo() {
  // Ready = test mode, or a provider with both a key and a from-address.
  const ready = PROVIDER === 'log' || Boolean(API_KEY && FROM_ADDRESS);
  // live = really sending emails to inboxes.
  return { provider: PROVIDER, ready, live: PROVIDER !== 'log' && ready };
}

// Footer required by anti-spam laws (CAN-SPAM, GDPR): who it's from, a physical address,
// and a working unsubscribe link.
// Add the legally required footer to an email.
export function withFooter(body, biz, unsubscribeUrl) {
  // A blank line, a dash and the business name.
  const lines = ['', '—', biz.name];
  // Add the business address if there is one.
  if (biz.address) lines.push(biz.address);
  // Add the unsubscribe link.
  lines.push('', `Don't want these emails? Unsubscribe: ${unsubscribeUrl}`);
  // The email text plus the footer.
  return `${body.trim()}\n${lines.join('\n')}`;
}

// Send one email through Resend's API.
async function sendResend(msg) {
  // POST the email to Resend.
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    // JSON body, signed with our secret key.
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    // The email itself:
    body: JSON.stringify({
      // "Business Name <from@address>"
      from: `${msg.fromName} <${FROM_ADDRESS}>`,
      // One recipient.
      to: [msg.to],
      // Replies go to the business (left out if not set).
      reply_to: msg.replyTo || undefined,
      subject: msg.subject,
      text: msg.text,
      headers: msg.headers,
    }),
    // Give up after 20 seconds.
    signal: AbortSignal.timeout(20_000),
  });
  // Read Resend's answer (empty if it isn't JSON).
  const data = await res.json().catch(() => ({}));
  // Resend refused: stop with its error message.
  if (!res.ok) throw new Error(data.message || `Resend error ${res.status}`);
  // Hand back Resend's id for the email.
  return data.id;
}

// Send one email through Brevo's API (same idea as Resend, different field names).
async function sendBrevo(msg) {
  // POST the email to Brevo.
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    // JSON body, signed with our API key.
    headers: { 'Content-Type': 'application/json', 'api-key': API_KEY },
    // The email itself:
    body: JSON.stringify({
      sender: { name: msg.fromName, email: FROM_ADDRESS },
      // Recipient's email and name.
      to: [{ email: msg.to, name: msg.toName || undefined }],
      // Replies go to the business, if set.
      replyTo: msg.replyTo ? { email: msg.replyTo } : undefined,
      subject: msg.subject,
      textContent: msg.text,
      headers: msg.headers,
    }),
    // Give up after 20 seconds.
    signal: AbortSignal.timeout(20_000),
  });
  // Read Brevo's answer.
  const data = await res.json().catch(() => ({}));
  // Brevo refused: stop with its error message.
  if (!res.ok) throw new Error(data.message || `Brevo error ${res.status}`);
  // Hand back Brevo's id for the email.
  return data.messageId;
}

// Test mode: save the email to the outbox instead of sending it.
function sendLog(msg) {
  // Load the saved outbox.
  const outbox = load('outbox', []);
  // A unique id for this email.
  const id = `log-${crypto.randomUUID()}`;
  // Add the email with the time it was saved.
  outbox.push({ id, ...msg, savedAt: new Date().toISOString() });
  // Keep only the newest 500 emails.
  save('outbox', outbox.slice(-500));
  // Hand back the id.
  return id;
}

/**
 * @param {{to:string,toName?:string,fromName:string,replyTo?:string,subject:string,text:string,unsubscribeUrl:string}} msg
 */
export async function sendEmail(msg) {
  // Marketing emails get one-click unsubscribe headers; internal alerts to the
  // business owner (no unsubscribeUrl) don't need them.
  // Copy the message and add the unsubscribe headers when there is an unsubscribe link.
  const full = {
    ...msg,
    headers: msg.unsubscribeUrl
      ? { 'List-Unsubscribe': `<${msg.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      : undefined,
  };
  // Test mode: just save it.
  if (PROVIDER === 'log') return sendLog(full);
  // A real provider needs both settings.
  if (!API_KEY || !FROM_ADDRESS) throw new Error('Email provider not configured: set EMAIL_API_KEY and EMAIL_FROM_ADDRESS in .env');
  // Send through Resend...
  if (PROVIDER === 'resend') return sendResend(full);
  // ...or Brevo.
  if (PROVIDER === 'brevo') return sendBrevo(full);
  // Any other provider name is a settings mistake.
  throw new Error(`Unknown EMAIL_PROVIDER "${PROVIDER}"`);
}
