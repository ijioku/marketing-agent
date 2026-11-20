// Storage with two modes:
//  - Files (default, local): each collection is a JSON file in ./data (or DATA_DIR).
//  - Database (DATABASE_URL set, e.g. a free Neon Postgres): needed on free hosts,
//    which wipe files on every restart. All collections are loaded into memory at
//    startup and every change is written back to Postgres in the background.
//    This works because the app runs as a single server process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(import.meta.dirname, '..', 'data');

let pool = null; // Postgres connection pool when DATABASE_URL is set
const cache = new Map(); // collection name -> value (database mode)
const dirty = new Set(); // collections changed but not yet written
let flushTimer = null;

export async function initStore() {
  if (!process.env.DATABASE_URL) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    return 'files';
  }
  const { default: pg } = await import('pg');
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  await pool.query('CREATE TABLE IF NOT EXISTS app_data (name text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
  const { rows } = await pool.query('SELECT name, value FROM app_data');
  for (const r of rows) cache.set(r.name, r.value);
  // Write everything before the host stops the server (deploys, sleeping).
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => flush().finally(() => process.exit(0)));
  return 'database';
}

export const storageMode = () => (pool ? 'database' : 'files');

export function load(name, fallback) {
  if (pool) return cache.has(name) ? structuredClone(cache.get(name)) : fallback;
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf8'));
  } catch {
    return fallback;
  }
}

export function save(name, value) {
  if (pool) {
    cache.set(name, structuredClone(value));
    dirty.add(name);
    flushTimer ??= setTimeout(() => flush().catch((err) => console.error('[store] database write failed:', err.message)), 250);
    return;
  }
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

async function flush() {
  flushTimer = null;
  if (!pool) return;
  for (const name of [...dirty]) {
    dirty.delete(name);
    try {
      await pool.query(
        'INSERT INTO app_data (name, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        [name, JSON.stringify(cache.get(name))]
      );
    } catch (err) {
      dirty.add(name); // keep it and retry shortly
      flushTimer ??= setTimeout(() => flush().catch(() => {}), 5000);
      throw err;
    }
  }
}

// ---------- Conversations ----------

export function getConversation(businessId, sessionId) {
  const all = load('conversations', {});
  return all[`${businessId}:${sessionId}`] || { businessId, sessionId, messages: [] };
}

export function appendMessages(businessId, sessionId, newMessages, channel = 'website') {
  const all = load('conversations', {});
  const key = `${businessId}:${sessionId}`;
  const convo = all[key] || { businessId, sessionId, channel, startedAt: new Date().toISOString(), messages: [] };
  for (const m of newMessages) convo.messages.push({ ...m, at: new Date().toISOString() });
  convo.updatedAt = new Date().toISOString();
  all[key] = convo;
  save('conversations', all);
  return convo;
}

export function listConversations(businessId) {
  const all = load('conversations', {});
  return Object.values(all)
    .filter((c) => c.businessId === businessId)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// ---------- Leads ----------

export function upsertLead(businessId, sessionId, fields, source = 'chat') {
  // Only these keys are accepted. Lead data partly comes from AI output that a
  // chat visitor can influence, so never copy arbitrary keys (e.g. "__proto__").
  const ALLOWED = ['name', 'phone', 'email', 'interest'];
  const clean = {};
  for (const k of ALLOWED) {
    const v = fields?.[k];
    if (typeof v === 'string' && v.trim()) clean[k] = v.trim().replace(k === 'email' ? /[.,;:]+$/ : /$^/, '').slice(0, 200);
  }
  if (!Object.keys(clean).length) return { lead: null, created: false };

  const leads = load('leads', []);
  let lead = leads.find((l) => l.businessId === businessId && l.sessionId === sessionId);
  let created = false;
  if (!lead) {
    // Someone is only a lead once the business can reach them. An "interest" alone
    // (e.g. they asked about braids but left no details) is not a lead yet.
    if (!clean.phone && !clean.email) return { lead: null, created: false };
    lead = { id: crypto.randomUUID(), businessId, sessionId, source: ['chat', 'whatsapp', 'instagram'].includes(source) ? source : 'chat', status: 'new', createdAt: new Date().toISOString() };
    leads.push(lead);
    created = true;
  }
  Object.assign(lead, clean, { updatedAt: new Date().toISOString() });
  save('leads', leads);
  return { lead, created };
}

// A friend who claimed a customer's referral offer on the invite page.
const digitsOf = (p) => String(p || '').replace(/\D/g, '').slice(-9); // last 9 digits: ignores 0 / +234 prefixes

// Returns null if this person (same phone or email) is already an inquiry for the
// business, so one friend can't be counted, or rewarded, more than once.
export function addReferralLead(businessId, referrer, { name, phone, email }) {
  const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const em = clean(email, 120).toLowerCase();
  const ph = digitsOf(phone);
  const dup = load('leads', []).some((l) => l.businessId === businessId && ((ph && digitsOf(l.phone) === ph) || (em && (l.email || '').toLowerCase() === em)));
  if (dup) return null;
  const lead = {
    id: crypto.randomUUID(),
    businessId,
    source: 'referral',
    referredBy: referrer.id,
    referredByName: [referrer.firstName, referrer.lastName].filter(Boolean).join(' '),
    name: clean(name, 80),
    phone: clean(phone, 40),
    email: clean(email, 120).toLowerCase().replace(/[.,;:]+$/, ''),
    interest: 'Referral offer',
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  lead.updatedAt = lead.createdAt;
  const leads = load('leads', []);
  leads.push(lead);
  save('leads', leads);
  return lead;
}

export function referralCounts(businessId) {
  const counts = {};
  for (const l of load('leads', [])) {
    if (l.businessId === businessId && l.referredBy) counts[l.referredBy] = (counts[l.referredBy] || 0) + 1;
  }
  return counts;
}

export function listLeads(businessId) {
  return load('leads', [])
    .filter((l) => l.businessId === businessId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function updateLeadStatus(id, status) {
  const allowed = ['new', 'contacted', 'booked', 'lost'];
  if (!allowed.includes(status)) return null;
  const leads = load('leads', []);
  const lead = leads.find((l) => l.id === id);
  if (!lead) return null;
  lead.status = status;
  lead.updatedAt = new Date().toISOString();
  save('leads', leads);
  return lead;
}

export function getLead(id) {
  return load('leads', []).find((l) => l.id === id) || null;
}

export function markFollowedUp(id, channel) {
  const leads = load('leads', []);
  const lead = leads.find((l) => l.id === id);
  if (!lead) return null;
  lead.followedUpAt = new Date().toISOString();
  lead.followUpChannel = channel;
  if (lead.status === 'new') lead.status = 'contacted';
  lead.updatedAt = lead.followedUpAt;
  save('leads', leads);
  return lead;
}
