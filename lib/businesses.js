// Each client business is one profile. This is what makes the agent "custom"
// per business: same engine, different profile.
//  - Locally: one JSON file per business in /businesses (or DATA_DIR/businesses).
//  - With a database: all profiles live in the "businesses" collection.
// The first time a server starts, the sample businesses are copied in.
// fs: read and write files. path: build file paths.
import fs from 'node:fs';
import path from 'node:path';
// Storage helpers (used when profiles live in the database).
import { load, save, storageMode } from './store.js';

// The folder with the sample business files that ship with the app.
const SAMPLES = path.join(import.meta.dirname, '..', 'businesses');
// Read every sample .json file into { id: profile }.
const readSamples = () =>
  Object.fromEntries(
    fs.readdirSync(SAMPLES).filter((f) => f.endsWith('.json')).map((f) => {
      const b = JSON.parse(fs.readFileSync(path.join(SAMPLES, f), 'utf8'));
      return [b.id, b];
    })
  );

// The folder where profiles are kept in file mode.
const fileDir = () => {
  // DATA_DIR/businesses if DATA_DIR is set, otherwise the samples folder itself.
  const dir = process.env.DATA_DIR ? path.join(path.resolve(process.env.DATA_DIR), 'businesses') : SAMPLES;
  // First run with a new data folder: create it...
  if (dir !== SAMPLES && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    // ...and copy the samples in.
    for (const f of fs.readdirSync(SAMPLES)) if (f.endsWith('.json')) fs.copyFileSync(path.join(SAMPLES, f), path.join(dir, f));
  }
  return dir;
};

// All profiles as { id: profile }.
function allBusinesses() {
  // Database mode: all profiles are stored together.
  if (storageMode() === 'database') {
    // Load them (null if this is the first run).
    let all = load('businesses', null);
    // First run: start from the samples...
    if (!all) {
      all = readSamples();
      // ...and save them.
      save('businesses', all);
    }
    return all;
  }
  // File mode: read every .json file in the folder.
  const dir = fileDir();
  // Collect them as { id: profile }.
  const out = {};
  // Go through each file:
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      // Read and decode it...
      const b = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // ...and add it under its id.
      out[b.id] = b;
    } catch {
      /* skip unreadable file */
    }
  }
  return out;
}

// Save one business profile.
export function writeBusiness(biz) {
  // Database mode:
  if (storageMode() === 'database') {
    // Load all profiles, replace this one, save them all.
    const all = allBusinesses();
    all[biz.id] = biz;
    save('businesses', all);
  // File mode:
  } else {
    // Write the profile to its own file, nicely indented.
    fs.writeFileSync(path.join(fileDir(), `${biz.id}.json`), JSON.stringify(biz, null, 2));
  }
}

// A valid id is 2-60 lower-case letters, digits or dashes (stops tricks like "../").
export const isValidId = (id) => typeof id === 'string' && /^[a-z0-9-]{2,60}$/.test(id);

// Turn a name into an id: "Glow Lounge Lekki" becomes "glow-lounge-lekki".
export const slugify = (text) =>
  String(text || '')
    // lower case,
    .toLowerCase()
    // every run of other characters becomes one dash,
    .replace(/[^a-z0-9]+/g, '-')
    // no dashes at the start or end,
    .replace(/^-+|-+$/g, '')
    // max 60 characters.
    .slice(0, 60);

// Get one business by id (null if the id is invalid or unknown).
export function getBusiness(id) {
  if (!isValidId(id)) return null;
  return allBusinesses()[id] || null;
}

// A short list of all businesses for the dropdown, sorted by name.
export function listBusinesses() {
  return Object.values(allBusinesses())
    .sort((a, b) => a.name.localeCompare(b.name))
    // Only the fields the dropdown needs.
    .map((b) => ({ id: b.id, name: b.name, type: b.type, demo: Boolean(b.demo) }));
}

// Clean text: trim it and cut it to a maximum length (non-text becomes '').
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// Clean list of texts: at most 50 non-empty items.
const strList = (v, max = 500) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, 50) : []);

// Clean up a profile from the dashboard form and save it.
export function saveBusiness(input) {
  // Keep the id if valid, otherwise make one from the name.
  const id = isValidId(input.id) ? input.id : slugify(input.name);
  // No usable name: refuse.
  if (!isValidId(id)) throw new Error('Business needs a name.');

  // Build the profile field by field, trimming and limiting every value.
  const biz = {
    id,
    name: str(input.name, 120),
    type: str(input.type, 80),
    tagline: str(input.tagline, 200),
    // Brand colour must be #rrggbb, otherwise a default blue.
    brandColor: /^#[0-9a-fA-F]{6}$/.test(input.brandColor || '') ? input.brandColor : '#2563eb',
    // A default greeting if none was given.
    greeting: str(input.greeting, 300) || `Hi! 👋 Welcome to ${str(input.name, 120)}. How can I help?`,
    // A default tone for the AI.
    tone: str(input.tone, 200) || 'friendly and helpful',
    phone: str(input.phone, 40),
    email: str(input.email, 120),
    address: str(input.address, 200),
    hours: str(input.hours, 300),
    bookingLink: str(input.bookingLink, 300),
    reviewLink: str(input.reviewLink, 300),
    // Services: name, price and duration; keep only ones with a name; max 50.
    services: (Array.isArray(input.services) ? input.services : [])
      .map((s) => ({ name: str(s?.name, 120), price: str(s?.price, 60), duration: str(s?.duration, 60) }))
      .filter((s) => s.name)
      .slice(0, 50),
    // FAQs: question and answer; keep only complete pairs; max 50.
    faqs: (Array.isArray(input.faqs) ? input.faqs : [])
      .map((f) => ({ q: str(f?.q, 300), a: str(f?.a, 800) }))
      .filter((f) => f.q && f.a)
      .slice(0, 50),
    // Current offers and house policies, as clean lists.
    offers: strList(input.offers),
    policies: strList(input.policies),
    // What the AI should try to achieve in chats (default: get a booking or contact details).
    goal: str(input.goal, 300) || 'Get visitors to book or leave their contact details',
    // What a customer and their friend get when the friend comes through an invite link.
    referralOffer: str(input.referralOffer, 200),
  };

  // Save it and hand back the cleaned profile.
  writeBusiness(biz);
  return biz;
}

// What the public chat widget is allowed to see.
export function publicProfile(biz) {
  // Pick only the safe fields (no email, offers, policies or tone)...
  const { id, name, type, tagline, brandColor, greeting, phone, address, hours, bookingLink, services } = biz;
  // ...and return them.
  return { id, name, type, tagline, brandColor, greeting, phone, address, hours, bookingLink, services };
}
