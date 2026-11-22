// Contacts: the people a business is allowed to email (its own customers,
// or partner businesses). Imported from a CSV exported from their booking/POS system.
// crypto: random ids, unsubscribe tokens and invite codes.
import crypto from 'node:crypto';
// load/save: read and write stored data.
import { load, save } from './store.js';

// ---------- CSV parsing (handles quotes, commas and newlines inside quotes) ----------

// Turn CSV text into rows of cells.
export function parseCsv(text) {
  // The finished rows.
  const rows = [];
  // The row being built.
  let row = [];
  // The cell being built.
  let field = '';
  // True while inside "quoted text".
  let inQuotes = false;
  const src = String(text).replace(/^﻿/, ''); // strip Excel BOM

  // Read the text one character at a time:
  for (let i = 0; i < src.length; i++) {
    // the current character.
    const c = src[i];
    // Inside quotes:
    if (inQuotes) {
      // two quote marks in a row mean one real quote mark,
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        // skip the second one.
        i++;
      // A single quote mark ends the quoted part.
      } else if (c === '"') {
        inQuotes = false;
      // Anything else (even commas and new lines) is part of the cell.
      } else {
        field += c;
      }
    // A quote mark starts a quoted part.
    } else if (c === '"') {
      inQuotes = true;
    // A comma ends the cell:
    } else if (c === ',') {
      // add it to the row,
      row.push(field);
      // and start a new cell.
      field = '';
    // A line break ends the row:
    } else if (c === '\n' || c === '\r') {
      // treat Windows "\r\n" as one break,
      if (c === '\r' && src[i + 1] === '\n') i++;
      // finish the cell,
      row.push(field);
      // add the row,
      rows.push(row);
      // and start a new row
      row = [];
      field = '';
    // Any other character goes into the cell.
    } else {
      field += c;
    }
  }
  // Text left over at the end (no final line break): finish the last row.
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop completely empty rows.
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

// Different systems name columns differently; map the common variants.
// Possible column names for each field, in lower case.
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

// Work out which column holds which field from the header row.
function mapHeaders(headerRow) {
  // field -> column number.
  const map = {};
  // For each header:
  headerRow.forEach((h, i) => {
    // lower case, underscores as spaces,
    const key = h.trim().toLowerCase().replace(/_/g, ' ');
    // check every field's aliases;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      // the first matching column wins.
      if (map[field] === undefined && (aliases.includes(key) || aliases.includes(h.trim().toLowerCase()))) map[field] = i;
    }
  });
  // Hand back the map.
  return map;
}

// A simple email shape check.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Consent values that mean "no".
const NO_VALUES = ['no', 'n', 'false', '0', 'unsubscribed', 'opted out', 'opt out'];

// Import contacts from CSV text for a business.
export function importContacts(businessId, csvText) {
  // Read the rows.
  const rows = parseCsv(csvText);
  // Need a header and at least one person.
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one contact.');

  // Find the columns.
  const cols = mapHeaders(rows[0]);
  // Email is required.
  if (cols.email === undefined) throw new Error('Could not find an "email" column in the CSV.');

  // Load all contacts.
  const all = load('contacts', []);
  // This business's existing contacts by email (to update instead of duplicating).
  const existing = new Map(all.filter((c) => c.businessId === businessId).map((c) => [c.email, c]));
  // Counts to report back.
  const result = { added: 0, updated: 0, skipped: 0, noConsent: 0 };

  // For each person (every row after the header):
  for (const row of rows.slice(1)) {
    // helper: read one field from the row (trimmed, max 300 characters, '' if the column is missing).
    const get = (field) => (cols[field] !== undefined ? String(row[cols[field]] || '').trim().slice(0, 300) : '');
    // Their email in lower case.
    const email = get('email').toLowerCase();
    // Invalid email:
    if (!EMAIL_RE.test(email)) {
      // count it as skipped,
      result.skipped++;
      // and move on.
      continue;
    }

    // First and last name...
    let firstName = get('firstName');
    let lastName = get('lastName');
    // ...or a single full-name column:
    const fullName = get('name');
    // if there's no first name, split the full name:
    if (!firstName && fullName) {
      // at spaces,
      const parts = fullName.split(/\s+/);
      // first word = first name,
      firstName = parts[0];
      // the rest = last name.
      lastName = lastName || parts.slice(1).join(' ');
    }

    // The consent column, if any.
    const consentRaw = get('consent').toLowerCase();
    // No consent column means yes; otherwise any "no" value means no.
    const consent = consentRaw ? !NO_VALUES.includes(consentRaw) : true;
    // Count people without consent.
    if (!consent) result.noConsent++;

    // The contact's details:
    const fields = {
      firstName,
      lastName,
      email,
      phone: get('phone'),
      company: get('company'),
      lastVisit: get('lastVisit'),
      lastService: get('lastService'),
      visits: get('visits'),
      // Tags can be split by ; | or commas, stored in lower case.
      tags: get('tags')
        .split(/[;|,]/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      notes: get('notes'),
    };

    // Do we already have this email?
    const found = existing.get(email);
    // Yes: update them.
    if (found) {
      // Never re-subscribe someone who unsubscribed.
      Object.assign(found, fields, { consent: found.unsubscribed ? false : consent, updatedAt: new Date().toISOString() });
      // Give them an invite code if they don't have one.
      if (!found.referralCode) found.referralCode = makeReferralCode(found.firstName);
      // Count the update.
      result.updated++;
    // No: create a new contact.
    } else {
      const contact = {
        // A random id.
        id: crypto.randomUUID(),
        businessId,
        ...fields,
        consent,
        // Not unsubscribed.
        unsubscribed: false,
        // A random unsubscribe token.
        unsubscribeToken: crypto.randomBytes(16).toString('hex'),
        // Their personal invite code.
        referralCode: makeReferralCode(firstName),
        // When added.
        createdAt: new Date().toISOString(),
      };
      // Add it to the list...
      all.push(contact);
      // ...remember it (in case the same email appears twice in the file)...
      existing.set(email, contact);
      // ...and count it.
      result.added++;
    }
  }

  // Save everything.
  save('contacts', all);
  // Report the counts.
  return result;
}

// A business's contacts, sorted by first name (or email).
export function listContacts(businessId) {
  return load('contacts', [])
    .filter((c) => c.businessId === businessId)
    .sort((a, b) => (a.firstName || a.email).localeCompare(b.firstName || b.email));
}

// One contact by id (null if unknown).
export function getContact(id) {
  return load('contacts', []).find((c) => c.id === id) || null;
}

// ---------- Referrals ----------
// Every customer gets a short personal code like "ADAEZE-K7Q2". Their invite link
// (/r/ADAEZE-K7Q2) lets a friend claim the business's referral offer, and the
// new customer is recorded as "referred by Adaeze".

// Characters used in invite codes.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I mix-ups
// Make an invite code like "ADAEZE-K7Q2".
export function makeReferralCode(firstName) {
  // Up to 10 letters of the first name in capitals ("FRIEND" if none).
  const name = String(firstName || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10) || 'FRIEND';
  // Then 4 random characters:
  let suffix = '';
  // each random byte picks one character.
  for (const b of crypto.randomBytes(4)) suffix += CODE_CHARS[b % CODE_CHARS.length];
  // Join them with a dash.
  return `${name}-${suffix}`;
}

// A valid code is 1-10 capital letters, a dash and 4 code characters.
export const isValidReferralCode = (code) => typeof code === 'string' && /^[A-Z]{1,10}-[A-Z2-9]{4}$/.test(code);

// Find the contact with an invite code.
export function getContactByReferralCode(code) {
  // Badly formed code: nobody.
  if (!isValidReferralCode(code)) return null;
  // Find them (null if unknown).
  return load('contacts', []).find((c) => c.referralCode === code) || null;
}

// Give older contacts (imported before referrals existed) a code.
// Run at start-up.
export function backfillReferralCodes() {
  // Load all contacts.
  const all = load('contacts', []);
  // How many were changed.
  let changed = 0;
  // For each contact:
  for (const c of all) {
    // no code yet:
    if (!c.referralCode) {
      // make one,
      c.referralCode = makeReferralCode(c.firstName);
      // count it.
      changed++;
    }
  }
  // Save only if something changed.
  if (changed) save('contacts', all);
  // Report how many.
  return changed;
}

// True if a contact may be emailed: they agreed and haven't unsubscribed.
export const canEmail = (c) => c.consent && !c.unsubscribed;

// Who a campaign goes to. Keeps it simple: everyone emailable, optionally filtered.
// Pick a campaign's recipients, optionally by tag and by "away for at least N days".
export function selectAudience(businessId, { tag = '', inactiveDays = 0 } = {}) {
  // The time now.
  const now = Date.now();
  // Go through the business's contacts:
  return listContacts(businessId).filter((c) => {
    // not emailable: leave out.
    if (!canEmail(c)) return false;
    // tag chosen and they don't have it: leave out.
    if (tag && !c.tags.includes(tag.toLowerCase())) return false;
    // "away for N days" chosen:
    if (inactiveDays > 0) {
      // read their last visit date,
      const t = Date.parse(c.lastVisit);
      // no valid date: leave out,
      if (Number.isNaN(t)) return false;
      // visited too recently: leave out.
      if (now - t < inactiveDays * 86_400_000) return false;
    }
    // Everyone else is in.
    return true;
  });
}

// Unsubscribe the contact with this token.
export function unsubscribeByToken(token) {
  // The token must be 32 hex characters.
  if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) return null;
  // Load contacts.
  const all = load('contacts', []);
  // Find the contact.
  const contact = all.find((c) => c.unsubscribeToken === token);
  // Unknown: null.
  if (!contact) return null;
  // Mark them unsubscribed,
  contact.unsubscribed = true;
  // remove consent,
  contact.consent = false;
  // note when,
  contact.unsubscribedAt = new Date().toISOString();
  // save,
  save('contacts', all);
  // and hand them back.
  return contact;
}

// Removes one contact. Returns false if it doesn't exist or belongs to another business.
// Delete one contact of a business.
export function deleteContact(businessId, contactId) {
  // Load contacts.
  const all = load('contacts', []);
  // Keep everyone except this contact.
  const rest = all.filter((c) => !(c.businessId === businessId && c.id === contactId));
  // Nothing removed: it didn't exist (or wasn't this business's).
  if (rest.length === all.length) return false;
  // Save the rest.
  save('contacts', rest);
  // Done.
  return true;
}

// Delete every contact of a business.
export function deleteContacts(businessId) {
  // Save the list without this business's contacts.
  save(
    'contacts',
    load('contacts', []).filter((c) => c.businessId !== businessId)
  );
}
