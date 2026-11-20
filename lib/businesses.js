// Each client business is one JSON file in /businesses.
// This is what makes the agent "custom" per business: same engine, different profile.
import fs from 'node:fs';
import path from 'node:path';

const SAMPLES = path.join(import.meta.dirname, '..', 'businesses');

// Business profiles are edited from the dashboard, so on a server they must live
// on the persistent disk too. The first time, the sample businesses are copied there.
const DIR = process.env.DATA_DIR ? path.join(path.resolve(process.env.DATA_DIR), 'businesses') : SAMPLES;
if (DIR !== SAMPLES && !fs.existsSync(DIR)) {
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of fs.readdirSync(SAMPLES)) if (f.endsWith('.json')) fs.copyFileSync(path.join(SAMPLES, f), path.join(DIR, f));
}

export const isValidId = (id) => typeof id === 'string' && /^[a-z0-9-]{2,60}$/.test(id);

export const slugify = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

export function getBusiness(id) {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function listBusinesses() {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => getBusiness(f.replace(/\.json$/, '')))
    .filter(Boolean)
    .map((b) => ({ id: b.id, name: b.name, type: b.type }));
}

const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v, max = 500) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, 50) : []);

export function saveBusiness(input) {
  const id = isValidId(input.id) ? input.id : slugify(input.name);
  if (!isValidId(id)) throw new Error('Business needs a name.');

  const biz = {
    id,
    name: str(input.name, 120),
    type: str(input.type, 80),
    tagline: str(input.tagline, 200),
    brandColor: /^#[0-9a-fA-F]{6}$/.test(input.brandColor || '') ? input.brandColor : '#2563eb',
    greeting: str(input.greeting, 300) || `Hi! 👋 Welcome to ${str(input.name, 120)}. How can I help?`,
    tone: str(input.tone, 200) || 'friendly and helpful',
    phone: str(input.phone, 40),
    email: str(input.email, 120),
    address: str(input.address, 200),
    hours: str(input.hours, 300),
    bookingLink: str(input.bookingLink, 300),
    reviewLink: str(input.reviewLink, 300),
    services: (Array.isArray(input.services) ? input.services : [])
      .map((s) => ({ name: str(s?.name, 120), price: str(s?.price, 60), duration: str(s?.duration, 60) }))
      .filter((s) => s.name)
      .slice(0, 50),
    faqs: (Array.isArray(input.faqs) ? input.faqs : [])
      .map((f) => ({ q: str(f?.q, 300), a: str(f?.a, 800) }))
      .filter((f) => f.q && f.a)
      .slice(0, 50),
    offers: strList(input.offers),
    policies: strList(input.policies),
    goal: str(input.goal, 300) || 'Get visitors to book or leave their contact details',
    // What a customer and their friend get when the friend comes through an invite link.
    referralOffer: str(input.referralOffer, 200),
  };

  fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify(biz, null, 2));
  return biz;
}

// What the public chat widget is allowed to see.
export function publicProfile(biz) {
  const { id, name, type, tagline, brandColor, greeting, phone, address, hours, bookingLink, services } = biz;
  return { id, name, type, tagline, brandColor, greeting, phone, address, hours, bookingLink, services };
}
