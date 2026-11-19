// Email sending. Three modes:
//   log    (default) — nothing leaves your computer; emails are saved to data/outbox.json. Safe for demos.
//   resend — https://resend.com  (free tier, needs a verified domain)
//   brevo  — https://brevo.com   (free tier, can verify a single sender address)
import crypto from 'node:crypto';
import { load, save } from './store.js';

const PROVIDER = (process.env.EMAIL_PROVIDER || 'log').toLowerCase();
const FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || '';
const API_KEY = process.env.EMAIL_API_KEY || '';

export function mailerInfo() {
  const ready = PROVIDER === 'log' || Boolean(API_KEY && FROM_ADDRESS);
  return { provider: PROVIDER, ready, live: PROVIDER !== 'log' && ready };
}

// Footer required by anti-spam laws (CAN-SPAM, GDPR): who it's from, a physical address,
// and a working unsubscribe link.
export function withFooter(body, biz, unsubscribeUrl) {
  const lines = ['', '—', biz.name];
  if (biz.address) lines.push(biz.address);
  lines.push('', `Don't want these emails? Unsubscribe: ${unsubscribeUrl}`);
  return `${body.trim()}\n${lines.join('\n')}`;
}

async function sendResend(msg) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      from: `${msg.fromName} <${FROM_ADDRESS}>`,
      to: [msg.to],
      reply_to: msg.replyTo || undefined,
      subject: msg.subject,
      text: msg.text,
      headers: msg.headers,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Resend error ${res.status}`);
  return data.id;
}

async function sendBrevo(msg) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': API_KEY },
    body: JSON.stringify({
      sender: { name: msg.fromName, email: FROM_ADDRESS },
      to: [{ email: msg.to, name: msg.toName || undefined }],
      replyTo: msg.replyTo ? { email: msg.replyTo } : undefined,
      subject: msg.subject,
      textContent: msg.text,
      headers: msg.headers,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Brevo error ${res.status}`);
  return data.messageId;
}

function sendLog(msg) {
  const outbox = load('outbox', []);
  const id = `log-${crypto.randomUUID()}`;
  outbox.push({ id, ...msg, savedAt: new Date().toISOString() });
  save('outbox', outbox.slice(-500));
  return id;
}

/**
 * @param {{to:string,toName?:string,fromName:string,replyTo?:string,subject:string,text:string,unsubscribeUrl:string}} msg
 */
export async function sendEmail(msg) {
  const full = {
    ...msg,
    headers: {
      'List-Unsubscribe': `<${msg.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
  if (PROVIDER === 'log') return sendLog(full);
  if (!API_KEY || !FROM_ADDRESS) throw new Error('Email provider not configured: set EMAIL_API_KEY and EMAIL_FROM_ADDRESS in .env');
  if (PROVIDER === 'resend') return sendResend(full);
  if (PROVIDER === 'brevo') return sendBrevo(full);
  throw new Error(`Unknown EMAIL_PROVIDER "${PROVIDER}"`);
}
