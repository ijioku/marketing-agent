// Contacts: the people a business is allowed to email (its own customers,
// or partner businesses). Imported from a CSV exported from their booking/POS system.
import crypto from 'node:crypto';
import { load, save } from './store.js';

// ---------- CSV parsing (handles quotes, commas and newlines inside quotes) ----------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text).replace(/^﻿/, ''); // strip Excel BOM

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

// Different systems name columns differently; map the common variants.
const HEADER_ALIASES = {
  firstName: ['first name', 'firstname', 'first', 'given name'],
  lastName: ['last name', 'lastname', 'last', 'surname', 'family name'],
  name: ['name', 'full name', 'customer', 'customer name', 'client', 'client name', 'contact', 'contact name'],
  email: ['email', 'e-mail', 'email address', 'mail'],
  phone: ['phone', 'phone number', 'mobile', 'cell', 'telephone'],
  company: ['company', 'business', 'organization', 'organisation', 'company name'],
  lastVisit: ['last visit', 'last appointment', 'last purchase', 'last order', 'last seen', 'last_visit'],
  lastService: ['last service', 'service', 'last product', 'product', 'last_service', 'favorite service'],
  visits: ['visits', 'total visits', 'number of visits', 'orders', 'total orders'],
  tags: ['tags', 'tag', 'segment', 'group', 'type'],
  notes: ['notes', 'note', 'comments'],
  consent: ['consent', 'subscribed', 'opt in', 'opt-in', 'marketing consent', 'accepts marketing'],
};

function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = h.trim().toLowerCase().replace(/_/g, ' ');
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] === undefined && (aliases.includes(key) || aliases.includes(h.trim().toLowerCase()))) map[field] = i;
    }
  });
  return map;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NO_VALUES = ['no', 'n', 'false', '0', 'unsubscribed', 'opted out', 'opt out'];

export function importContacts(businessId, csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one contact.');

  const cols = mapHeaders(rows[0]);
  if (cols.email === undefined) throw new Error('Could not find an "email" column in the CSV.');

  const all = load('contacts', []);
  const existing = new Map(all.filter((c) => c.businessId === businessId).map((c) => [c.email, c]));
  const result = { added: 0, updated: 0, skipped: 0, noConsent: 0 };

  for (const row of rows.slice(1)) {
    const get = (field) => (cols[field] !== undefined ? String(row[cols[field]] || '').trim().slice(0, 300) : '');
    const email = get('email').toLowerCase();
    if (!EMAIL_RE.test(email)) {
      result.skipped++;
      continue;
    }

    let firstName = get('firstName');
    let lastName = get('lastName');
    const fullName = get('name');
    if (!firstName && fullName) {
      const parts = fullName.split(/\s+/);
      firstName = parts[0];
      lastName = lastName || parts.slice(1).join(' ');
    }

    const consentRaw = get('consent').toLowerCase();
    const consent = consentRaw ? !NO_VALUES.includes(consentRaw) : true;
    if (!consent) result.noConsent++;

    const fields = {
      firstName,
      lastName,
      email,
      phone: get('phone'),
      company: get('company'),
      lastVisit: get('lastVisit'),
      lastService: get('lastService'),
      visits: get('visits'),
      tags: get('tags')
        .split(/[;|,]/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      notes: get('notes'),
    };

    const found = existing.get(email);
    if (found) {
      // Never re-subscribe someone who unsubscribed.
      Object.assign(found, fields, { consent: found.unsubscribed ? false : consent, updatedAt: new Date().toISOString() });
      if (!found.referralCode) found.referralCode = makeReferralCode(found.firstName);
      result.updated++;
    } else {
      const contact = {
        id: crypto.randomUUID(),
        businessId,
        ...fields,
        consent,
        unsubscribed: false,
        unsubscribeToken: crypto.randomBytes(16).toString('hex'),
        referralCode: makeReferralCode(firstName),
        createdAt: new Date().toISOString(),
      };
      all.push(contact);
      existing.set(email, contact);
      result.added++;
    }
  }

  save('contacts', all);
  return result;
}

export function listContacts(businessId) {
  return load('contacts', [])
    .filter((c) => c.businessId === businessId)
    .sort((a, b) => (a.firstName || a.email).localeCompare(b.firstName || b.email));
}

export function getContact(id) {
  return load('contacts', []).find((c) => c.id === id) || null;
}

// ---------- Referrals ----------
// Every customer gets a short personal code like "ADAEZE-K7Q2". Their invite link
// (/r/ADAEZE-K7Q2) lets a friend claim the business's referral offer, and the
// new customer is recorded as "referred by Adaeze".

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups
export function makeReferralCode(firstName) {
  const name = String(firstName || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10) || 'FRIEND';
  let suffix = '';
  for (const b of crypto.randomBytes(4)) suffix += CODE_CHARS[b % CODE_CHARS.length];
  return `${name}-${suffix}`;
}

export const isValidReferralCode = (code) => typeof code === 'string' && /^[A-Z]{1,10}-[A-Z2-9]{4}$/.test(code);

export function getContactByReferralCode(code) {
  if (!isValidReferralCode(code)) return null;
  return load('contacts', []).find((c) => c.referralCode === code) || null;
}

// Give older contacts (imported before referrals existed) a code.
export function backfillReferralCodes() {
  const all = load('contacts', []);
  let changed = 0;
  for (const c of all) {
    if (!c.referralCode) {
      c.referralCode = makeReferralCode(c.firstName);
      changed++;
    }
  }
  if (changed) save('contacts', all);
  return changed;
}

export const canEmail = (c) => c.consent && !c.unsubscribed;

// Who a campaign goes to. Keeps it simple: everyone emailable, optionally filtered.
export function selectAudience(businessId, { tag = '', inactiveDays = 0 } = {}) {
  const now = Date.now();
  return listContacts(businessId).filter((c) => {
    if (!canEmail(c)) return false;
    if (tag && !c.tags.includes(tag.toLowerCase())) return false;
    if (inactiveDays > 0) {
      const t = Date.parse(c.lastVisit);
      if (Number.isNaN(t)) return false;
      if (now - t < inactiveDays * 86_400_000) return false;
    }
    return true;
  });
}

export function unsubscribeByToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) return null;
  const all = load('contacts', []);
  const contact = all.find((c) => c.unsubscribeToken === token);
  if (!contact) return null;
  contact.unsubscribed = true;
  contact.consent = false;
  contact.unsubscribedAt = new Date().toISOString();
  save('contacts', all);
  return contact;
}

export function deleteContacts(businessId) {
  save(
    'contacts',
    load('contacts', []).filter((c) => c.businessId !== businessId)
  );
}
