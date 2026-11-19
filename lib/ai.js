// The agent's "brain".
// Works with ANY OpenAI-compatible API (Groq, OpenRouter, Gemini, OpenAI...).
// With no API key set, it falls back to a rule-based mode so demos still work for $0.

const BASE_URL = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
const API_KEY = process.env.AI_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';

export const aiEnabled = () => Boolean(API_KEY);
export const aiInfo = () => ({ enabled: aiEnabled(), model: aiEnabled() ? MODEL : 'offline rules' });

async function complete(messages, { temperature = 0.5, maxTokens = 400 } = {}) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`AI API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || '';
}

// ---------- Business knowledge -> prompt ----------

function businessFacts(biz) {
  const lines = [`Business: ${biz.name}${biz.type ? ` (${biz.type})` : ''}`];
  if (biz.tagline) lines.push(`Tagline: ${biz.tagline}`);
  if (biz.address) lines.push(`Address: ${biz.address}`);
  if (biz.phone) lines.push(`Phone: ${biz.phone}`);
  if (biz.email) lines.push(`Email: ${biz.email}`);
  if (biz.hours) lines.push(`Hours: ${biz.hours}`);
  if (biz.bookingLink) lines.push(`Booking link: ${biz.bookingLink}`);
  if (biz.services?.length) {
    lines.push('Services:');
    for (const s of biz.services) lines.push(`- ${s.name}${s.price ? ` — ${s.price}` : ''}${s.duration ? ` (${s.duration})` : ''}`);
  }
  if (biz.offers?.length) lines.push('Current offers:', ...biz.offers.map((o) => `- ${o}`));
  if (biz.policies?.length) lines.push('Policies:', ...biz.policies.map((p) => `- ${p}`));
  if (biz.faqs?.length) {
    lines.push('FAQs:');
    for (const f of biz.faqs) lines.push(`Q: ${f.q}\nA: ${f.a}`);
  }
  return lines.join('\n');
}

function chatSystemPrompt(biz) {
  return `You are the AI front-desk and marketing assistant for ${biz.name}. You chat with visitors on the business website.

Your goal: ${biz.goal}.
Tone: ${biz.tone}.

How to behave:
- Answer questions using ONLY the business facts below. Never invent prices, services, hours or promises. If you don't know, say the team will follow up.
- Keep replies short: 1–3 sentences, under 70 words. Plain text, no markdown.
- Once the visitor shows interest (asks about booking, prices, availability), guide them to book${biz.bookingLink ? ` using the booking link` : ''} and ask for their name and phone number or email so the team can confirm.
- Mention a current offer when it naturally fits.
- If asked whether you are a human, say you are the business's AI assistant.
- Never ask for payment details, passwords or ID numbers.

Lead capture: whenever you have learned any of the visitor's name, phone, email or what they want, add ONE final line in exactly this format (it is hidden from the visitor):
<lead>{"name":"","phone":"","email":"","interest":""}</lead>
Leave unknown fields as empty strings.

BUSINESS FACTS
${businessFacts(biz)}`;
}

// ---------- Lead extraction ----------

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;

const NAME_RE = /\b(?:i'?m|i am|my name is|this is|it's)\s+([A-Za-z][a-z'-]{1,30})/i;
const NOT_NAMES = new Set(['looking', 'interested', 'just', 'here', 'not', 'trying', 'wondering', 'new', 'good', 'fine', 'calling']);

function extractFromText(text) {
  const name = text.match(NAME_RE)?.[1] || '';
  return {
    name: name && !NOT_NAMES.has(name.toLowerCase()) ? name[0].toUpperCase() + name.slice(1) : '',
    email: text.match(EMAIL_RE)?.[0] || '',
    phone: text.match(PHONE_RE)?.[0] || '',
  };
}

function splitLeadTag(raw) {
  const match = raw.match(/<lead>([\s\S]*?)<\/lead>/i);
  const reply = raw.replace(/<lead>[\s\S]*?<\/lead>/gi, '').trim();
  let lead = {};
  if (match) {
    try {
      lead = JSON.parse(match[1]);
    } catch {
      /* model produced bad JSON; ignore */
    }
  }
  return { reply, lead };
}

// ---------- Offline (no API key) mode ----------

// Match at a word start, so "hi" doesn't fire on "this".
const has = (text, words) => words.some((w) => new RegExp(`\\b${w}`).test(text));

function offlineReply(biz, message) {
  const t = message.toLowerCase();
  const contact = extractFromText(message);

  if (contact.phone || contact.email) {
    return `Thanks! The ${biz.name} team will reach out shortly to confirm.${biz.bookingLink ? ` You can also book right now here: ${biz.bookingLink}` : ''}`;
  }

  // Best FAQ match by shared words
  const words = new Set(t.split(/\W+/).filter((w) => w.length > 3));
  let best = null;
  let bestScore = 0;
  for (const f of biz.faqs || []) {
    const score = f.q.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
    if (score > bestScore) [best, bestScore] = [f, score];
  }
  if (best && bestScore >= 2) return best.a;

  // A question can ask several things at once ("how much is a fade and are you open Saturday?"),
  // so collect every answer that applies.
  const answers = [];
  const named = (biz.services || []).filter((s) =>
    s.name.toLowerCase().split(/\W+/).some((w) => w.length > 3 && words.has(w))
  );
  if (named.length) {
    answers.push(named.map((s) => `${s.name}: ${s.price || 'ask us'}${s.duration ? ` (${s.duration})` : ''}`).join('; ') + '.');
  } else if (has(t, ['price', 'cost', 'how much', 'service', 'menu', 'offer']) && biz.services?.length) {
    const list = biz.services.slice(0, 6).map((s) => `${s.name}${s.price ? ` (${s.price})` : ''}`).join(', ');
    answers.push(`Here's what we offer: ${list}.${biz.offers?.[0] ? ` Right now: ${biz.offers[0]}.` : ''}`);
  }
  if (has(t, ['hour', 'open', 'close', 'when are you', 'today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekend'])) {
    answers.push(biz.hours ? `We're open ${biz.hours}.` : `Our team will confirm hours for you.`);
  }
  if (has(t, ['where', 'address', 'location', 'located', 'directions'])) {
    answers.push(biz.address ? `We're at ${biz.address}.` : `Our team can share directions.`);
  }
  if (answers.length) return `${answers.join(' ')} Want me to help you book?`;
  if (has(t, ['book', 'appointment', 'schedule', 'reserve', 'available', 'slot'])) {
    return `Happy to help you book!${biz.bookingLink ? ` Grab a time here: ${biz.bookingLink} — or` : ''} leave your name and phone number and we'll confirm a time.`;
  }
  if (best && bestScore >= 1) return best.a;
  if (has(t, ['hi', 'hello', 'hey', 'yo'])) return biz.greeting;

  return `Good question! Leave your name and phone number or email and someone from ${biz.name} will get back to you quickly.`;
}

// ---------- Public API ----------

export async function chatReply(biz, history, message) {
  const fromText = extractFromText(message);

  if (!aiEnabled()) {
    return { reply: offlineReply(biz, message), lead: fromText, mode: 'offline' };
  }

  const messages = [
    { role: 'system', content: chatSystemPrompt(biz) },
    ...history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  try {
    const raw = await complete(messages);
    const { reply, lead } = splitLeadTag(raw);
    return {
      reply: reply || offlineReply(biz, message),
      lead: { ...lead, ...Object.fromEntries(Object.entries(fromText).filter(([, v]) => v)) },
      mode: 'ai',
    };
  } catch (err) {
    console.error('[ai] falling back to offline mode:', err.message);
    return { reply: offlineReply(biz, message), lead: fromText, mode: 'offline' };
  }
}

// Retention / growth message drafts for the owner dashboard.
const DRAFT_KINDS = {
  review_request: 'Ask a happy recent customer to leave a review. Include the review link if available. Warm, short, grateful.',
  win_back: "Bring back a customer who hasn't visited in a while. Friendly 'we miss you', give a reason to come back (use a current offer if there is one), include the booking link.",
  promo: 'Announce a promotion or news to existing customers. Clear benefit, clear deadline if any, include the booking link.',
  lead_follow_up: 'Follow up with a new lead who chatted on the website but has not booked yet. Reference what they were interested in, make booking easy.',
};

export const draftKinds = Object.keys(DRAFT_KINDS);

function offlineDraft(biz, kind, details) {
  const name = details.customerName || 'there';
  const book = biz.bookingLink ? ` Book here: ${biz.bookingLink}` : '';
  const offer = biz.offers?.[0] ? ` ${biz.offers[0]}.` : '';
  const sms = {
    review_request: `Hi ${name}, thanks for visiting ${biz.name}! Would you mind leaving us a quick review? It really helps.${biz.reviewLink ? ` ${biz.reviewLink}` : ''}`,
    win_back: `Hi ${name}, we miss you at ${biz.name}!${offer}${book}`,
    promo: `${biz.name}: ${details.notes || biz.offers?.[0] || 'We have something new for you'}.${book}`,
    lead_follow_up: `Hi ${name}, it's ${biz.name} following up on your question${details.notes ? ` about ${details.notes}` : ''}. Want us to save you a spot?${book}`,
  }[kind];
  return { sms, emailSubject: `A note from ${biz.name}`, emailBody: `${sms}\n\n— The ${biz.name} team` };
}

export async function draftMessage(biz, kind, details = {}) {
  if (!DRAFT_KINDS[kind]) throw new Error('Unknown message type');
  if (!aiEnabled()) return { ...offlineDraft(biz, kind, details), mode: 'offline' };

  const prompt = `Write a marketing message for ${biz.name}.
Purpose: ${DRAFT_KINDS[kind]}
Tone: ${biz.tone}.
Customer name: ${details.customerName || '(unknown — use a friendly generic greeting)'}
Extra notes from the owner: ${details.notes || '(none)'}
Review link: ${biz.reviewLink || '(none)'}

Return ONLY valid JSON: {"sms":"under 300 characters","emailSubject":"...","emailBody":"3-6 short sentences"}
Do not invent offers or prices that are not in the facts.

BUSINESS FACTS
${businessFacts(biz)}`;

  try {
    const raw = await complete([{ role: 'user', content: prompt }], { temperature: 0.7, maxTokens: 500 });
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return { sms: String(json.sms || ''), emailSubject: String(json.emailSubject || ''), emailBody: String(json.emailBody || ''), mode: 'ai' };
  } catch (err) {
    console.error('[ai] draft fallback:', err.message);
    return { ...offlineDraft(biz, kind, details), mode: 'offline' };
  }
}

// ---------- Personalized campaign emails ----------
//
// "Personal, not creepy" rules live here, in code, so every client gets them:
// - The AI only ever sees: first name, company, last service, a VAGUE time since last visit,
//   and whether they're a regular. Never exact dates, never the owner's private notes,
//   never phone numbers.
// - The prompt forbids mentioning data, tracking, or anything a customer wouldn't
//   expect their barber/dentist/gym to naturally remember.

export const CAMPAIGN_GOALS = {
  win_back: {
    label: 'Win back customers who stopped coming',
    brief: "Invite them back warmly. It's been a while; give one good reason to return (a current offer if there is one) and make booking easy.",
  },
  promo: {
    label: 'Announce an offer or news',
    brief: 'Tell them about the offer or news in the owner notes. Clear benefit, honest deadline only if the owner gave one, easy next step.',
  },
  review_request: {
    label: 'Ask happy customers for a review',
    brief: 'Thank them for coming in and ask, without pressure, for a quick review. Include the review link.',
  },
  thank_you: {
    label: 'Thank loyal regulars',
    brief: 'Genuinely thank them for being a regular. No hard sell; optionally mention a small perk from the offers if there is one.',
  },
  partnership: {
    label: 'Propose a partnership to another local business',
    brief:
      "Write to the owner of another local business proposing a simple, concrete partnership (cross-promotion, referral swap, or a joint offer). Explain the benefit for THEM, keep it short and humble, and end with a low-pressure question like 'open to a quick chat?'.",
  },
};

function timeSince(dateText) {
  const t = Date.parse(dateText);
  if (Number.isNaN(t)) return '';
  const days = (Date.now() - t) / 86_400_000;
  if (days < 0) return '';
  if (days < 21) return 'recently';
  if (days < 50) return 'a few weeks';
  if (days < 75) return 'a couple of months';
  if (days < 200) return 'a few months';
  return 'quite a while';
}

// The ONLY customer facts the AI is allowed to see.
export function safeContactFacts(contact) {
  const visits = Number.parseInt(contact.visits, 10);
  return {
    firstName: contact.firstName || '',
    company: contact.company || '',
    lastService: contact.lastService || '',
    timeSinceLastVisit: timeSince(contact.lastVisit),
    isRegular: Number.isFinite(visits) && visits >= 5,
  };
}

const TONE_RULES = `Rules so the email feels personal but NEVER creepy:
- Write like a real person at the business who knows this customer, not like a marketing system.
- Use their first name once, naturally. If no name, use a friendly greeting without one.
- You may mention their usual/last service and roughly how long it's been, the way a friendly business owner would ("it's been a few months"). Never exact dates, counts, amounts, or anything that sounds tracked.
- Never mention data, records, systems, AI, tracking, or how you know anything.
- Never guess about their personal life, health, money, family, or why they stopped coming. Never guilt-trip.
- No fake urgency, no ALL CAPS, no "act now", no spammy words, max one emoji.
- 60–130 words. One clear call to action. Plain text, no markdown.
- Do not add a signature block or unsubscribe text; that is added automatically.
- Do not invent offers, prices, or facts that are not in the business facts or owner notes.
- Offers meant for NEW customers (first visit, new patients, new clients) do not apply to existing customers. Don't offer them unless the recipient is a partner business.`;

const NEW_CUSTOMER_OFFER = /\b(first[- ]?(visit|time)|new (patient|customer|client)s?)\b/i;

function offlineCampaignEmail(biz, goal, facts, notes) {
  const hi = facts.firstName ? `Hi ${facts.firstName},` : 'Hi there,';
  const book = biz.bookingLink ? `\n\nYou can grab a time here: ${biz.bookingLink}` : '';
  // Existing customers shouldn't be offered "first visit" deals.
  const existingOffer = (biz.offers || []).find((o) => !NEW_CUSTOMER_OFFER.test(o));
  const offer = existingOffer ? ` ${existingOffer.replace(/\.$/, '')}.` : '';
  const svc = facts.lastService ? ` your next ${facts.lastService.toLowerCase()}` : ' your next visit';
  const templates = {
    win_back: [`We'd love to see you again`, `${hi}\n\nIt's been ${facts.timeSinceLastVisit || 'a little while'} and we'd love to have you back at ${biz.name} for${svc}.${offer}${book}`],
    promo: [`Something new at ${biz.name}`, `${hi}\n\nQuick heads-up from ${biz.name}: ${notes || existingOffer || 'we have something new we think you will like'}.${book}`],
    review_request: [`Thanks for coming in`, `${hi}\n\nThanks for choosing ${biz.name}. If you have a minute, a quick review would really help us out${biz.reviewLink ? `: ${biz.reviewLink}` : '.'}\n\nThank you!`],
    thank_you: [`Thank you from ${biz.name}`, `${hi}\n\nJust a quick note to say thank you for being one of our regulars at ${biz.name}. We really appreciate you.${offer}`],
    partnership: [`Partnership idea: ${biz.name} x ${facts.company || 'your business'}`, `${hi}\n\nI run ${biz.name}${biz.address ? ` nearby (${biz.address})` : ''}. I think our customers overlap, and I'd love to explore a simple partnership, like recommending each other or a joint offer. Open to a quick chat?`],
  };
  const [subject, body] = templates[goal];
  return { subject, body };
}

export async function writeCampaignEmail(biz, goal, contact, notes = '') {
  if (!CAMPAIGN_GOALS[goal]) throw new Error('Unknown campaign goal');
  const facts = safeContactFacts(contact);
  if (!aiEnabled()) return { ...offlineCampaignEmail(biz, goal, facts, notes), mode: 'offline' };

  const prompt = `You write one email on behalf of ${biz.name}.

Goal: ${CAMPAIGN_GOALS[goal].brief}
Tone: ${biz.tone}.
Owner notes for this campaign: ${notes || '(none)'}
Review link: ${biz.reviewLink || '(none)'}

${TONE_RULES}

RECIPIENT (only these facts are known)
${JSON.stringify(facts)}

BUSINESS FACTS
${businessFacts(biz)}

Return ONLY valid JSON: {"subject":"short natural subject, under 50 characters, no clickbait","body":"the email text"}`;

  try {
    const raw = await complete([{ role: 'user', content: prompt }], { temperature: 0.8, maxTokens: 500 });
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (!json.subject || !json.body) throw new Error('missing fields');
    return { subject: String(json.subject).slice(0, 120), body: String(json.body).slice(0, 3000), mode: 'ai' };
  } catch (err) {
    console.error('[ai] campaign email fallback:', err.message);
    return { ...offlineCampaignEmail(biz, goal, facts, notes), mode: 'offline' };
  }
}
