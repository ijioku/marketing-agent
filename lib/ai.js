// The agent's "brain".
// Works with ANY OpenAI-compatible API (Groq, OpenRouter, Gemini, OpenAI...).
// With no API key set, it falls back to a rule-based mode so demos still work for $0.

// The AI provider's address (Groq by default), without a trailing slash.
const BASE_URL = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
// The secret API key (empty = offline rules mode).
const API_KEY = process.env.AI_API_KEY || '';
// Which AI model to use.
const MODEL = process.env.AI_MODEL || 'openai/gpt-oss-120b';

// True when an API key is set.
export const aiEnabled = () => Boolean(API_KEY);
// AI status for the dashboard: on/off and the model name.
export const aiInfo = () => ({ enabled: aiEnabled(), model: aiEnabled() ? MODEL : 'offline rules' });

// Wait for ms milliseconds.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long the provider asked us to wait, from the Retry-After header or
// "try again in 7.5s" in the error text. Falls back to 10 seconds.
// Work out how long to wait after a "slow down" answer.
function retryDelayMs(res, bodyText) {
  // The Retry-After header, in seconds.
  const header = Number(res.headers.get('retry-after'));
  // If it's a sensible number, use it.
  if (Number.isFinite(header) && header > 0) return header * 1000;
  // Otherwise look for "try again in 1m7.5s" in the error text.
  const m = bodyText.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
  // Turn minutes and seconds into milliseconds.
  if (m) return ((Number(m[1]) || 0) * 60 + Number(m[2])) * 1000;
  // Neither found: wait 10 seconds.
  return 10_000;
}

// Reasoning models "think" first, so token limits are generous.
// maxWaitMs: how long we're willing to wait out rate limits. Campaigns run in
// the background and can wait; live chat should answer fast or fall back.
// Send messages to the AI and get its reply text.
async function complete(messages, { temperature = 0.5, maxTokens = 1200, maxWaitMs = 5_000 } = {}) {
  // Total time spent waiting on rate limits so far.
  let waited = 0;
  // The provider's answer.
  let res;
  // Keep trying until we get an answer that isn't "slow down":
  for (;;) {
    // send the conversation to the AI,
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      // as JSON, with our API key,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      // the model, the messages, how creative to be, and the reply length limit,
      body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens }),
      // giving up after 30 seconds.
      signal: AbortSignal.timeout(30_000),
    });
    // Not rate limited: stop looping.
    if (res.status !== 429) break;
    // Free tiers limit tokens per minute. Wait as asked, then try again.
    // Read the error text.
    const body = await res.text();
    // How long to wait (plus half a second), at most 65 seconds.
    const delay = Math.min(retryDelayMs(res, body) + 500, 65_000);
    // Waiting would take too long: give up with an error.
    if (waited + delay > maxWaitMs) throw new Error(`AI API 429 (rate limit): ${body.slice(0, 120)}`);
    // Log the wait.
    console.log(`[ai] rate limited, waiting ${Math.round(delay / 1000)}s…`);
    // Wait...
    await sleep(delay);
    // ...and count it.
    waited += delay;
  }
  // Any other error: stop with the status and the start of the error text.
  if (!res.ok) throw new Error(`AI API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // Decode the answer.
  const json = await res.json();
  // The reply text (empty if missing).
  const text = json.choices?.[0]?.message?.content || '';
  // Some models wrap their private reasoning in <think> tags; never show that to customers.
  // Remove <think>...</think> blocks and outer spaces.
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ---------- Business knowledge -> prompt ----------

// Turn a business profile into plain text facts for the AI.
function businessFacts(biz) {
  // Start with the name and type.
  const lines = [`Business: ${biz.name}${biz.type ? ` (${biz.type})` : ''}`];
  // Add each fact only if the business filled it in:
  if (biz.tagline) lines.push(`Tagline: ${biz.tagline}`);
  if (biz.address) lines.push(`Address: ${biz.address}`);
  if (biz.phone) lines.push(`Phone: ${biz.phone}`);
  if (biz.email) lines.push(`Email: ${biz.email}`);
  if (biz.hours) lines.push(`Hours: ${biz.hours}`);
  if (biz.bookingLink) lines.push(`Booking link: ${biz.bookingLink}`);
  // Services as a list, with price and duration when known.
  if (biz.services?.length) {
    lines.push('Services:');
    for (const s of biz.services) lines.push(`- ${s.name}${s.price ? ` — ${s.price}` : ''}${s.duration ? ` (${s.duration})` : ''}`);
  }
  // Offers, the referral offer and policies.
  if (biz.offers?.length) lines.push('Current offers:', ...biz.offers.map((o) => `- ${o}`));
  if (biz.referralOffer) lines.push(`Referral offer (when a customer invites a friend): ${biz.referralOffer}`);
  if (biz.policies?.length) lines.push('Policies:', ...biz.policies.map((p) => `- ${p}`));
  // FAQs as Q/A pairs.
  if (biz.faqs?.length) {
    lines.push('FAQs:');
    for (const f of biz.faqs) lines.push(`Q: ${f.q}\nA: ${f.a}`);
  }
  // One fact per line.
  return lines.join('\n');
}

// The instructions given to the AI before every chat: its role, goal, tone, rules and the business facts.
function chatSystemPrompt(biz) {
  return `You are the AI front-desk and marketing assistant for ${biz.name}. You chat with visitors on the business website.

Your goal: ${biz.goal}.
Tone: ${biz.tone}.

How to behave:
- Answer questions using ONLY the business facts below. Never invent prices, services, hours or promises. If you don't know, say the team will follow up.
- Keep replies short: 1–3 sentences, under 70 words. Plain text, no markdown.
- Once the visitor shows interest (asks about booking, prices, availability), guide them to book${biz.bookingLink ? ` using the booking link` : ''} and ask for their name and phone number or email so the team can confirm.
- You CANNOT book, confirm, reserve or hold appointments yourself. Never say "you're booked", "we've got you" or "we'll hold that slot". Instead, point them to the booking link and/or say the team will contact them to confirm.
- If a listed combo service matches what they want (e.g. "haircut + beard"), quote that instead of adding prices together.
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

// Must not swallow a sentence-ending full stop ("me@x.com.")
// Finds an email address in text.
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
// Finds a phone number (at least 9 digits, spaces and dashes allowed).
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;

// Finds a name after "I'm", "my name is", "this is"...
const NAME_RE = /\b(?:i'?m|i am|my name is|this is|it's)\s+([A-Za-z][a-z'-]{1,30})/i;
// Words that follow "I'm" but aren't names ("I'm looking...").
const NOT_NAMES = new Set(['looking', 'interested', 'just', 'here', 'not', 'trying', 'wondering', 'new', 'good', 'fine', 'calling']);

// Pick a name, email and phone out of the customer's own message.
function extractFromText(text) {
  // The word after "I'm" etc.
  const name = text.match(NAME_RE)?.[1] || '';
  return {
    // Use it with a capital letter, unless it's one of the non-names.
    name: name && !NOT_NAMES.has(name.toLowerCase()) ? name[0].toUpperCase() + name.slice(1) : '',
    // The first email found.
    email: text.match(EMAIL_RE)?.[0] || '',
    // The first phone number found.
    phone: text.match(PHONE_RE)?.[0] || '',
  };
}

// Separate the AI's reply from the hidden <lead>{...}</lead> line.
function splitLeadTag(raw) {
  // Models sometimes write the closing tag as <\/lead>, or forget it entirely.
  // Whatever happens, the tag must never be shown to the visitor.
  // Find the lead tag (closing tag optional).
  const match = raw.match(/<lead>([\s\S]*?)(?:<\\?\/lead>|$)/i);
  // The reply with every lead tag removed.
  const reply = raw.replace(/<lead>[\s\S]*?(?:<\\?\/lead>|$)/gi, '').trim();
  // Empty lead by default.
  let lead = {};
  // If there was a tag:
  if (match) {
    try {
      // read the JSON inside it.
      lead = JSON.parse(match[1]);
    } catch {
      /* model produced bad JSON; ignore */
    }
  }
  // Hand back both.
  return { reply, lead };
}

// ---------- Offline (no API key) mode ----------

// Match at a word start, so "hi" doesn't fire on "this".
// True if the text contains any of the words at a word start.
const has = (text, words) => words.some((w) => new RegExp(`\\b${w}`).test(text));

// Simple answers without AI, used when there's no API key or the AI fails.
function offlineReply(biz, message) {
  // The message in lower case.
  const t = message.toLowerCase();
  // Any phone or email in the message.
  const contact = extractFromText(message);

  // They left contact details: thank them (and give the booking link).
  if (contact.phone || contact.email) {
    return `Thanks! The ${biz.name} team will reach out shortly to confirm.${biz.bookingLink ? ` You can also book right now here: ${biz.bookingLink}` : ''}`;
  }

  // Best FAQ match by shared words
  // The longer words in the message.
  const words = new Set(t.split(/\W+/).filter((w) => w.length > 3));
  // The best-matching FAQ...
  let best = null;
  // ...and how many words it shares.
  let bestScore = 0;
  // For each FAQ:
  for (const f of biz.faqs || []) {
    // count shared words,
    const score = f.q.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
    // keep the best.
    if (score > bestScore) [best, bestScore] = [f, score];
  }
  // Two or more shared words: answer with that FAQ.
  if (best && bestScore >= 2) return best.a;

  // A question can ask several things at once ("how much is a fade and are you open Saturday?"),
  // so collect every answer that applies.
  // Answers collected so far.
  const answers = [];
  // Services whose name shares a word with the message.
  const named = (biz.services || []).filter((s) =>
    s.name.toLowerCase().split(/\W+/).some((w) => w.length > 3 && words.has(w))
  );
  // Named services: give their prices.
  if (named.length) {
    answers.push(named.map((s) => `${s.name}: ${s.price || 'ask us'}${s.duration ? ` (${s.duration})` : ''}`).join('; ') + '.');
  // A general price question: list up to 6 services (and the current offer).
  } else if (has(t, ['price', 'cost', 'how much', 'service', 'menu', 'offer']) && biz.services?.length) {
    const list = biz.services.slice(0, 6).map((s) => `${s.name}${s.price ? ` (${s.price})` : ''}`).join(', ');
    answers.push(`Here's what we offer: ${list}.${biz.offers?.[0] ? ` Right now: ${biz.offers[0]}.` : ''}`);
  }
  // A question about opening times: give the hours.
  if (has(t, ['hour', 'open', 'close', 'when are you', 'today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekend'])) {
    answers.push(biz.hours ? `We're open ${biz.hours}.` : `Our team will confirm hours for you.`);
  }
  // A question about the location: give the address.
  if (has(t, ['where', 'address', 'location', 'located', 'directions'])) {
    answers.push(biz.address ? `We're at ${biz.address}.` : `Our team can share directions.`);
  }
  // Found answers: send them all and offer to book.
  if (answers.length) return `${answers.join(' ')} Want me to help you book?`;
  // A booking question: give the booking link and ask for contact details.
  if (has(t, ['book', 'appointment', 'schedule', 'reserve', 'available', 'slot'])) {
    return `Happy to help you book!${biz.bookingLink ? ` Grab a time here: ${biz.bookingLink} — or` : ''} leave your name and phone number and we'll confirm a time.`;
  }
  // A weak FAQ match is better than nothing.
  if (best && bestScore >= 1) return best.a;
  // A greeting: reply with the business greeting.
  if (has(t, ['hi', 'hello', 'hey', 'yo'])) return biz.greeting;

  // Anything else: ask for contact details.
  return `Good question! Leave your name and phone number or email and someone from ${biz.name} will get back to you quickly.`;
}

// ---------- Public API ----------

// Write a chat reply for a customer message.
export async function chatReply(biz, history, message) {
  // Details found directly in the message.
  const fromText = extractFromText(message);

  // No AI key:
  if (!aiEnabled()) {
    // rule-based reply.
    return { reply: offlineReply(biz, message), lead: fromText, mode: 'offline' };
  }

  // The conversation for the AI:
  const messages = [
    // the instructions,
    { role: 'system', content: chatSystemPrompt(biz) },
    // the last 12 messages for context,
    ...history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
    // and the new message.
    { role: 'user', content: message },
  ];

  try {
    // Ask the AI.
    const raw = await complete(messages);
    // Separate the reply from the lead line.
    const { reply, lead } = splitLeadTag(raw);
    // Hand back:
    return {
      // the reply (rule-based if the AI said nothing useful),
      reply: reply || offlineReply(biz, message),
      // the lead details (details found directly in the message win),
      lead: { ...lead, ...Object.fromEntries(Object.entries(fromText).filter(([, v]) => v)) },
      mode: 'ai',
    };
  // The AI failed:
  } catch (err) {
    // log it,
    console.error('[ai] falling back to offline mode:', err.message);
    // and use the rule-based reply so the customer still gets an answer.
    return { reply: offlineReply(biz, message), lead: fromText, mode: 'offline' };
  }
}

// Retention / growth message drafts for the owner dashboard.
// Instructions for each kind of one-off message the owner can ask for.
const DRAFT_KINDS = {
  review_request: 'Ask a happy recent customer to leave a review. Include the review link if available. Warm, short, grateful.',
  win_back: "Bring back a customer who hasn't visited in a while. Friendly 'we miss you', give a reason to come back (use a current offer if there is one), include the booking link.",
  promo: 'Announce a promotion or news to existing customers. Clear benefit, clear deadline if any, include the booking link.',
  lead_follow_up: 'Follow up with a new lead who chatted on the website but has not booked yet. Reference what they were interested in, make booking easy.',
};

// The list of kinds, for the dashboard.
export const draftKinds = Object.keys(DRAFT_KINDS);

// Simple drafts without AI.
function offlineDraft(biz, kind, details) {
  // The customer's name, or "there".
  const name = details.customerName || 'there';
  // The booking link sentence, if there is one.
  const book = biz.bookingLink ? ` Book here: ${biz.bookingLink}` : '';
  // The first current offer, if any.
  const offer = biz.offers?.[0] ? ` ${biz.offers[0]}.` : '';
  // A short message for each kind:
  const sms = {
    review_request: `Hi ${name}, thanks for visiting ${biz.name}! Would you mind leaving us a quick review? It really helps.${biz.reviewLink ? ` ${biz.reviewLink}` : ''}`,
    win_back: `Hi ${name}, we miss you at ${biz.name}!${offer}${book}`,
    promo: `${biz.name}: ${details.notes || biz.offers?.[0] || 'We have something new for you'}.${book}`,
    lead_follow_up: `Hi ${name}, it's ${biz.name} following up on your question${details.notes ? ` about ${details.notes}` : ''}. Want us to save you a spot?${book}`,
  }[kind];
  // The SMS text plus an email version.
  return { sms, emailSubject: `A note from ${biz.name}`, emailBody: `${sms}\n\n— The ${biz.name} team` };
}

// Draft a one-off message.
export async function draftMessage(biz, kind, details = {}) {
  // Unknown kind: error.
  if (!DRAFT_KINDS[kind]) throw new Error('Unknown message type');
  // No AI: simple draft.
  if (!aiEnabled()) return { ...offlineDraft(biz, kind, details), mode: 'offline' };

  // The request to the AI: purpose, tone, name, notes, review link, required JSON format and the business facts.
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
    // Ask the AI (a bit more creative than chat).
    const raw = await complete([{ role: 'user', content: prompt }], { temperature: 0.7, maxTokens: 1500 });
    // Take the JSON part of its answer and decode it.
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    // Hand back the three texts.
    return { sms: String(json.sms || ''), emailSubject: String(json.emailSubject || ''), emailBody: String(json.emailBody || ''), mode: 'ai' };
  // Broken answer or AI failure:
  } catch (err) {
    // log it,
    console.error('[ai] draft fallback:', err.message);
    // use the simple draft.
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

// The goals a campaign can have: a label for the dashboard and a brief for the AI.
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
  referral: {
    label: 'Get new customers through referrals (ask happy customers to invite friends)',
    brief:
      "Thank them warmly for being a valued customer, then invite them to share their personal invite link with a friend or two who'd enjoy the business. State the referral offer EXACTLY as written in the business facts, so it's clear what they and their friend get. Do NOT write any link or URL: their personal invite link and a WhatsApp share link are added automatically right after your text. End with a line that leads into the link, like 'Here's your personal invite link:'.",
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

// Turn a last-visit date into a vague phrase (the AI never sees exact dates).
function timeSince(dateText) {
  // Read the date.
  const t = Date.parse(dateText);
  // Not a date: nothing.
  if (Number.isNaN(t)) return '';
  // Days since then.
  const days = (Date.now() - t) / 86_400_000;
  // In the future: nothing.
  if (days < 0) return '';
  // Less than 3 weeks.
  if (days < 21) return 'recently';
  // Less than about 7 weeks.
  if (days < 50) return 'a few weeks';
  // Less than about 2.5 months.
  if (days < 75) return 'a couple of months';
  // Less than about 6.5 months.
  if (days < 200) return 'a few months';
  // Longer.
  return 'quite a while';
}

// The ONLY customer facts the AI is allowed to see.
// Turn a contact into the few safe facts above.
export function safeContactFacts(contact) {
  // Number of visits.
  const visits = Number.parseInt(contact.visits, 10);
  return {
    // First name only.
    firstName: contact.firstName || '',
    // Company (for partnership emails).
    company: contact.company || '',
    // What they had last.
    lastService: contact.lastService || '',
    // A vague time since their last visit.
    timeSinceLastVisit: timeSince(contact.lastVisit),
    // 5 or more visits counts as a regular.
    isRegular: Number.isFinite(visits) && visits >= 5,
  };
}

// The rules that keep campaign emails personal but not creepy (sent to the AI with every email).
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
- Never claim anything has changed (new tools, renovations, new staff, a "refreshed vibe", new services) unless it is stated in the facts or owner notes.
- Every concrete perk or detail (free drinks, tea, gifts, seats, discounts, amenities) must come from the facts or owner notes. If it isn't written there, don't mention it.
- Only mention an offer if it fits the recipient (e.g. a braid-booking perk is fine to mention, but don't pretend it applies to a different service).
- Offers meant for NEW customers (first visit, first session, new patients, new clients, new members) do not apply to existing customers. Don't offer them unless the recipient is a partner business.`;

// Spots offers meant only for new customers ("first visit", "new clients"...).
const NEW_CUSTOMER_OFFER = /\b(first[- ]?(visit|time|session)|new (patient|customer|client|member)s?)\b/i;

// Simple campaign emails without AI.
function offlineCampaignEmail(biz, goal, facts, notes) {
  // "Hi Kemi," or "Hi there,".
  const hi = facts.firstName ? `Hi ${facts.firstName},` : 'Hi there,';
  // The booking link, if any.
  const book = biz.bookingLink ? `\n\nYou can grab a time here: ${biz.bookingLink}` : '';
  // Existing customers shouldn't be offered "first visit" deals.
  // The first offer that isn't a new-customer offer.
  const existingOffer = (biz.offers || []).find((o) => !NEW_CUSTOMER_OFFER.test(o));
  // As a sentence.
  const offer = existingOffer ? ` ${existingOffer.replace(/\.$/, '')}.` : '';
  // "your next braids" or "your next visit".
  const svc = facts.lastService ? ` your next ${facts.lastService.toLowerCase()}` : ' your next visit';
  // A subject and body for each goal:
  const templates = {
    win_back: [`We'd love to see you again`, `${hi}\n\nIt's been ${facts.timeSinceLastVisit || 'a little while'} and we'd love to have you back at ${biz.name} for${svc}.${offer}${book}`],
    promo: [`Something new at ${biz.name}`, `${hi}\n\nQuick heads-up from ${biz.name}: ${notes || existingOffer || 'we have something new we think you will like'}.${book}`],
    review_request: [`Thanks for coming in`, `${hi}\n\nThanks for choosing ${biz.name}. If you have a minute, a quick review would really help us out${biz.reviewLink ? `: ${biz.reviewLink}` : '.'}\n\nThank you!`],
    thank_you: [`Thank you from ${biz.name}`, `${hi}\n\nJust a quick note to say thank you for being one of our regulars at ${biz.name}. We really appreciate you.${offer}`],
    referral: [`A gift for you and a friend`, `${hi}\n\nThank you for being such a valued customer at ${biz.name}. If you know someone who'd love us too, share your personal invite link with them. ${biz.referralOffer ? `${biz.referralOffer.replace(/\.$/, '')}.` : ''}\n\nHere's your personal invite link:`],
    partnership: [`Partnership idea: ${biz.name} x ${facts.company || 'your business'}`, `${hi}\n\nI run ${biz.name}${biz.address ? ` nearby (${biz.address})` : ''}. I think our customers overlap, and I'd love to explore a simple partnership, like recommending each other or a joint offer. Open to a quick chat?`],
  };
  // Pick the one for this goal.
  const [subject, body] = templates[goal];
  // Hand it back.
  return { subject, body };
}

// Write one personal campaign email.
export async function writeCampaignEmail(biz, goal, contact, notes = '') {
  // Unknown goal: error.
  if (!CAMPAIGN_GOALS[goal]) throw new Error('Unknown campaign goal');
  // Only the safe facts about the customer.
  const facts = safeContactFacts(contact);
  // No AI: simple email.
  if (!aiEnabled()) return { ...offlineCampaignEmail(biz, goal, facts, notes), mode: 'offline' };

  // The request to the AI: goal, tone, notes, rules, the customer's safe facts, business facts and the JSON format.
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
    // Background job: willing to wait out free-tier rate limits for up to 3 minutes per email.
    const raw = await complete([{ role: 'user', content: prompt }], { temperature: 0.8, maxTokens: 1500, maxWaitMs: 180_000 });
    // Take the JSON part of the answer and decode it.
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    // Both fields are required.
    if (!json.subject || !json.body) throw new Error('missing fields');
    // Hand back the subject (max 120) and body (max 3000).
    return { subject: String(json.subject).slice(0, 120), body: String(json.body).slice(0, 3000), mode: 'ai' };
  // Broken answer or AI failure:
  } catch (err) {
    // log it,
    console.error('[ai] campaign email fallback:', err.message);
    // use the simple email.
    return { ...offlineCampaignEmail(biz, goal, facts, notes), mode: 'offline' };
  }
}
