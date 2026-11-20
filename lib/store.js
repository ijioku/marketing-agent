// Simple JSON-file storage. Good enough for a handful of clients;
// swap for PostgreSQL once you have paying customers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.join(import.meta.dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export function load(name, fallback) {
  const file = path.join(DATA_DIR, `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function save(name, value) {
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- Conversations ----------

export function getConversation(businessId, sessionId) {
  const all = load('conversations', {});
  return all[`${businessId}:${sessionId}`] || { businessId, sessionId, messages: [] };
}

export function appendMessages(businessId, sessionId, newMessages) {
  const all = load('conversations', {});
  const key = `${businessId}:${sessionId}`;
  const convo = all[key] || { businessId, sessionId, startedAt: new Date().toISOString(), messages: [] };
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

export function upsertLead(businessId, sessionId, fields) {
  // Only these keys are accepted. Lead data partly comes from AI output that a
  // chat visitor can influence, so never copy arbitrary keys (e.g. "__proto__").
  const ALLOWED = ['name', 'phone', 'email', 'interest'];
  const clean = {};
  for (const k of ALLOWED) {
    const v = fields?.[k];
    if (typeof v === 'string' && v.trim()) clean[k] = v.trim().replace(k === 'email' ? /[.,;:]+$/ : /$^/, '').slice(0, 200);
  }
  if (!Object.keys(clean).length) return null;

  const leads = load('leads', []);
  let lead = leads.find((l) => l.businessId === businessId && l.sessionId === sessionId);
  if (!lead) {
    // Someone is only a lead once the business can reach them. An "interest" alone
    // (e.g. they asked about braids but left no details) is not a lead yet.
    if (!clean.phone && !clean.email) return null;
    lead = { id: crypto.randomUUID(), businessId, sessionId, status: 'new', createdAt: new Date().toISOString() };
    leads.push(lead);
  }
  Object.assign(lead, clean, { updatedAt: new Date().toISOString() });
  save('leads', leads);
  return lead;
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
