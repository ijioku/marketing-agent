// Storage with two modes:
//  - Files (default, local): each collection is a JSON file in ./data (or DATA_DIR).
//  - Database (DATABASE_URL set, e.g. a free Neon Postgres): needed on free hosts,
//    which wipe files on every restart. All collections are loaded into memory at
//    startup and every change is written back to Postgres in the background.
//    This works because the app runs as a single server process.
// fs: files. path: file paths. crypto: random ids.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The data folder: DATA_DIR if set, otherwise ./data next to the app.
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(import.meta.dirname, '..', 'data');

let pool = null; // Postgres connection pool when DATABASE_URL is set
const cache = new Map(); // collection name -> value (database mode)
const dirty = new Set(); // collections changed but not yet written
// The pending "write to database" timer.
let flushTimer = null;

// Open storage. Called once when the server starts.
export async function initStore() {
  // No database address: use files.
  if (!process.env.DATABASE_URL) {
    // Make sure the data folder exists.
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Report file mode.
    return 'files';
  }
  // Load the Postgres library only when it's needed.
  const { default: pg } = await import('pg');
  // Connect to the database (at most 3 connections, enough for the free tier).
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  // Create the one table we use if it doesn't exist yet: name, JSON value, last change.
  await pool.query('CREATE TABLE IF NOT EXISTS app_data (name text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
  // Read every saved collection...
  const { rows } = await pool.query('SELECT name, value FROM app_data');
  // ...into memory.
  for (const r of rows) cache.set(r.name, r.value);
  // Write everything before the host stops the server (deploys, sleeping).
  // When the host stops the server, write pending changes first, then exit.
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => flush().finally(() => process.exit(0)));
  // Report database mode.
  return 'database';
}

// Which mode is active.
export const storageMode = () => (pool ? 'database' : 'files');

// Read a collection (or the fallback if it doesn't exist).
export function load(name, fallback) {
  // Database mode: hand back a copy from memory (a copy, so callers can't change the cache by accident).
  if (pool) return cache.has(name) ? structuredClone(cache.get(name)) : fallback;
  // File mode: read and decode the JSON file.
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf8'));
  } catch {
    // Missing or broken file: use the fallback.
    return fallback;
  }
}

// Save a collection.
export function save(name, value) {
  // Database mode:
  if (pool) {
    // update the copy in memory,
    cache.set(name, structuredClone(value));
    // mark it as changed,
    dirty.add(name);
    // and write to the database in 250 ms (several quick saves become one write).
    flushTimer ??= setTimeout(() => flush().catch((err) => console.error('[store] database write failed:', err.message)), 250);
    // Done for now.
    return;
  }
  // File mode: the file's path,
  const file = path.join(DATA_DIR, `${name}.json`);
  // and a temporary file next to it.
  const tmp = `${file}.tmp`;
  // Write to the temporary file first...
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  // ...then swap it in, so a crash mid-write never leaves a broken file.
  fs.renameSync(tmp, file);
}

// Write every changed collection to the database.
async function flush() {
  // The timer has fired.
  flushTimer = null;
  // File mode: nothing to do.
  if (!pool) return;
  // Each changed collection:
  for (const name of [...dirty]) {
    // unmark it,
    dirty.delete(name);
    try {
      // insert it, or update it if it already exists.
      await pool.query(
        'INSERT INTO app_data (name, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        [name, JSON.stringify(cache.get(name))]
      );
    } catch (err) {
      dirty.add(name); // keep it and retry shortly
      // try again in 5 seconds,
      flushTimer ??= setTimeout(() => flush().catch(() => {}), 5000);
      // and report the error.
      throw err;
    }
  }
}

// ---------- Conversations ----------

// One chat conversation (an empty one if it doesn't exist yet).
export function getConversation(businessId, sessionId) {
  // All conversations.
  const all = load('conversations', {});
  // Conversations are keyed by "business:session".
  return all[`${businessId}:${sessionId}`] || { businessId, sessionId, messages: [] };
}

// Add messages to a conversation (creating it if needed).
export function appendMessages(businessId, sessionId, newMessages, channel = 'website') {
  // All conversations.
  const all = load('conversations', {});
  // This conversation's key.
  const key = `${businessId}:${sessionId}`;
  // Existing one, or a new one with the channel and start time.
  const convo = all[key] || { businessId, sessionId, channel, startedAt: new Date().toISOString(), messages: [] };
  // Add each message with the time.
  for (const m of newMessages) convo.messages.push({ ...m, at: new Date().toISOString() });
  // Note the last change.
  convo.updatedAt = new Date().toISOString();
  // Put it back...
  all[key] = convo;
  // ...save...
  save('conversations', all);
  // ...and hand it back.
  return convo;
}

// A business's conversations, newest first.
export function listConversations(businessId) {
  // All conversations.
  const all = load('conversations', {});
  // Only this business's...
  return Object.values(all)
    .filter((c) => c.businessId === businessId)
    // ...sorted by last change, newest first.
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// ---------- Leads ----------

// Create or update an inquiry (lead) from details the AI found. `created` says if it is new.
export function upsertLead(businessId, sessionId, fields, source = 'chat') {
  // Only these keys are accepted. Lead data partly comes from AI output that a
  // chat visitor can influence, so never copy arbitrary keys (e.g. "__proto__").
  const ALLOWED = ['name', 'phone', 'email', 'interest'];
  // The cleaned details.
  const clean = {};
  // For each allowed field:
  for (const k of ALLOWED) {
    // its value,
    const v = fields?.[k];
    // keep non-empty text, trim it, remove trailing punctuation from emails, max 200 characters.
    if (typeof v === 'string' && v.trim()) clean[k] = v.trim().replace(k === 'email' ? /[.,;:]+$/ : /$^/, '').slice(0, 200);
  }
  // Nothing usable: no lead.
  if (!Object.keys(clean).length) return { lead: null, created: false };

  // All leads.
  const leads = load('leads', []);
  // This chat's existing lead, if any.
  let lead = leads.find((l) => l.businessId === businessId && l.sessionId === sessionId);
  // Not new until proven otherwise.
  let created = false;
  // No lead for this chat yet:
  if (!lead) {
    // Someone is only a lead once the business can reach them. An "interest" alone
    // (e.g. they asked about braids but left no details) is not a lead yet.
    if (!clean.phone && !clean.email) return { lead: null, created: false };
    // New lead: random id, business, chat, source (chat/whatsapp/instagram), status "new", time.
    lead = { id: crypto.randomUUID(), businessId, sessionId, source: ['chat', 'whatsapp', 'instagram'].includes(source) ? source : 'chat', status: 'new', createdAt: new Date().toISOString() };
    // Add it.
    leads.push(lead);
    // It's new.
    created = true;
  }
  // Copy in the details and note the change.
  Object.assign(lead, clean, { updatedAt: new Date().toISOString() });
  // Save.
  save('leads', leads);
  // Hand back the lead and whether it's new.
  return { lead, created };
}

// A friend who claimed a customer's referral offer on the invite page.
// Phone numbers compared by their last 9 digits.
const digitsOf = (p) => String(p || '').replace(/\D/g, '').slice(-9); // last 9 digits: ignores 0 / +234 prefixes

// Returns null if this person (same phone or email) is already an inquiry for the
// business, so one friend can't be counted, or rewarded, more than once.
// Save a friend's details from an invite page.
export function addReferralLead(businessId, referrer, { name, phone, email }) {
  // Clean text: trim and cut to a maximum length.
  const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  // The email in lower case.
  const em = clean(email, 120).toLowerCase();
  // The phone's last 9 digits.
  const ph = digitsOf(phone);
  // Already an inquiry with the same phone or email for this business?
  const dup = load('leads', []).some((l) => l.businessId === businessId && ((ph && digitsOf(l.phone) === ph) || (em && (l.email || '').toLowerCase() === em)));
  // Yes: don't add it again.
  if (dup) return null;
  // The new inquiry:
  const lead = {
    id: crypto.randomUUID(),
    businessId,
    // Marked as a referral...
    source: 'referral',
    // ...from this customer...
    referredBy: referrer.id,
    // ...with their full name.
    referredByName: [referrer.firstName, referrer.lastName].filter(Boolean).join(' '),
    name: clean(name, 80),
    phone: clean(phone, 40),
    email: clean(email, 120).toLowerCase().replace(/[.,;:]+$/, ''),
    // What they came for.
    interest: 'Referral offer',
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  // Created and updated at the same moment.
  lead.updatedAt = lead.createdAt;
  // Load leads, add it, save.
  const leads = load('leads', []);
  leads.push(lead);
  save('leads', leads);
  // Hand it back.
  return lead;
}

// How many friends each customer referred: { contactId: count }.
export function referralCounts(businessId) {
  // Start empty.
  const counts = {};
  // Go through every lead:
  for (const l of load('leads', [])) {
    // referral leads of this business add one to the referrer's count.
    if (l.businessId === businessId && l.referredBy) counts[l.referredBy] = (counts[l.referredBy] || 0) + 1;
  }
  // Hand back the counts.
  return counts;
}

// A business's inquiries, newest first.
export function listLeads(businessId) {
  return load('leads', [])
    .filter((l) => l.businessId === businessId)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// Change an inquiry's status.
export function updateLeadStatus(id, status) {
  // The only allowed statuses.
  const allowed = ['new', 'contacted', 'booked', 'lost'];
  // Anything else: refuse.
  if (!allowed.includes(status)) return null;
  // Load leads.
  const leads = load('leads', []);
  // Find this one.
  const lead = leads.find((l) => l.id === id);
  // Unknown: null.
  if (!lead) return null;
  // Set the status...
  lead.status = status;
  // ...note the change...
  lead.updatedAt = new Date().toISOString();
  // ...save...
  save('leads', leads);
  // ...and hand it back.
  return lead;
}

// One inquiry by id (null if unknown).
export function getLead(id) {
  return load('leads', []).find((l) => l.id === id) || null;
}

// Record that the owner followed up.
export function markFollowedUp(id, channel) {
  // Load leads.
  const leads = load('leads', []);
  // Find this one.
  const lead = leads.find((l) => l.id === id);
  // Unknown: null.
  if (!lead) return null;
  // When...
  lead.followedUpAt = new Date().toISOString();
  // ...and how (email or whatsapp).
  lead.followUpChannel = channel;
  // A new inquiry becomes "contacted".
  if (lead.status === 'new') lead.status = 'contacted';
  // Note the change.
  lead.updatedAt = lead.followedUpAt;
  // Save.
  save('leads', leads);
  // Hand it back.
  return lead;
}
