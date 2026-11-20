// The sample business prospects can sign into ("Try the demo") and click around:
// approve emails, delete contacts, follow up inquiries… without breaking anything.
// Everything belonging to the demo business is rebuilt from the seed below on reset,
// with dates moved so the data always looks recent ("2 hours ago", "4 months ago").
// Demo emails are NEVER really sent, even when real email sending is switched on.
import crypto from 'node:crypto';
import { load, save } from './store.js';
import { writeBusiness, getBusiness } from './businesses.js';

export const DEMO_ID = 'lagoon-breeze-hotel';
export const isDemoBusiness = (id) => id === DEMO_ID;

const RESET_IDLE_MS = 30 * 60_000; // reset once nobody has used the demo for 30 minutes
let lastActivity = 0;
let lastReset = 0;

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const daysAgoDate = (d) => new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);

const PROFILE = {
  id: DEMO_ID,
  demo: true,
  name: 'Lagoon Breeze Hotel & Grill',
  type: 'Boutique hotel & restaurant',
  tagline: '24 calm rooms, a rooftop grill and Sunday brunch by the water in Ikoyi.',
  brandColor: '#0f766e',
  greeting: 'Welcome to Lagoon Breeze! 🌴 Looking for a room, a table, or planning an event? Ask me anything.',
  tone: 'warm, polished and welcoming, like a great front-desk manager. Light Nigerian warmth',
  phone: '+234 800 000 5678',
  email: 'reservations@example.com',
  address: 'Lugard Avenue, Ikoyi, Lagos (sample business)',
  hours: 'Hotel: 24/7. Restaurant: daily 7am–11pm. Sunday brunch 11am–3pm',
  bookingLink: 'https://example.com/book/lagoon-breeze',
  reviewLink: 'https://example.com/review/lagoon-breeze',
  services: [
    { name: 'Standard room (bed & breakfast)', price: '₦65,000 / night', duration: '' },
    { name: 'Executive suite', price: '₦120,000 / night', duration: '' },
    { name: 'Sunday brunch buffet', price: '₦25,000 per person', duration: '11am–3pm' },
    { name: 'Rooftop grill dinner for two', price: '₦45,000', duration: '' },
    { name: 'Conference room (up to 40 guests)', price: '₦250,000 / day', duration: '8 hrs' },
    { name: 'Event hall (up to 200 guests)', price: 'From ₦1,500,000', duration: '' },
  ],
  faqs: [
    { q: 'Is breakfast included?', a: 'Yes, every room includes breakfast for two in the restaurant (7am–10:30am).' },
    { q: 'Do you have parking and power?', a: 'Free secure parking, 24/7 power with backup, and fast Wi-Fi in every room.' },
    { q: 'How do I pay?', a: 'Bank transfer, POS or card. A 50% deposit confirms event and conference bookings.' },
    { q: 'Do you host weddings and parties?', a: 'Yes, the event hall takes up to 200 guests, with in-house catering and decor partners.' },
  ],
  offers: ['Stay 3 nights, pay for 2 (weekdays until Dec 15)', 'Birthday guests get a free cake at the rooftop grill'],
  policies: ['Check-in 2pm, check-out 12 noon', 'Free cancellation up to 48 hours before arrival', '50% deposit for events'],
  goal: 'Get room bookings, table reservations and event inquiries, and bring past guests back',
  referralOffer: 'You and your friend both get a free Sunday brunch for one',
};

// [firstName, lastName, lastService, visits, lastVisit (days ago), tags, notes]
const CONTACTS = [
  ['Kemi', 'Adeyemi', 'Sunday brunch buffet', 9, 20, ['regular'], 'Brings her family most months'],
  ['Chidi', 'Okafor', 'Executive suite', 4, 140, ['corporate'], 'Books for his company in Abuja'],
  ['Funmi', 'Bakare', 'Rooftop grill dinner for two', 6, 115, ['regular'], 'Anniversary in December'],
  ['Emeka', 'Nwosu', 'Conference room', 3, 200, ['corporate'], 'HR manager at a bank'],
  ['Zainab', 'Bello', 'Standard room', 2, 160, [], 'Came for a wedding'],
  ['Tunde', 'Lawal', 'Sunday brunch buffet', 11, 9, ['regular', 'vip'], 'Always table 4 by the window'],
  ['Ngozi', 'Eze', 'Event hall', 1, 300, ['events'], "Hosted her mother's 60th"],
  ['Segun', 'Afolabi', 'Rooftop grill dinner for two', 5, 98, ['regular'], ''],
  ['Halima', 'Musa', 'Executive suite', 3, 130, ['vip'], 'Prefers a high floor'],
  ['Ifeanyi', 'Obi', 'Standard room', 7, 45, ['corporate'], 'Monthly business trips'],
  ['Bisola', 'Ogunleye', 'Sunday brunch buffet', 2, 190, [], 'Asked about birthday packages'],
  ['Daniel', 'Etim', 'Conference room', 2, 250, ['corporate'], 'Startup team offsites'],
];

const WIN_BACK = [
  ['Chidi', 'We’ve kept your suite warm, Chidi', 'Hi Chidi,\n\nIt’s been a few months since your last stay in our executive suite, and the team still remembers how much you liked the quiet top floor.\n\nIf work brings you to Lagos before Christmas, stay 3 weeknights and pay for only 2. Just reply to this email or book here and we’ll hold your favourite room:\n\nhttps://example.com/book/lagoon-breeze\n\nSee you soon,\nThe Lagoon Breeze team'],
  ['Funmi', 'Your table by the rooftop is waiting, Funmi', 'Hi Funmi,\n\nWe loved hosting you for dinner at the rooftop grill, and we hear there’s an anniversary coming up in December! 🎉\n\nCome celebrate with us: book a dinner for two this month and dessert and a bottle of chilled zobo cocktail are on the house.\n\nReserve your table: https://example.com/book/lagoon-breeze\n\nWarmly,\nLagoon Breeze Hotel & Grill'],
  ['Emeka', 'Planning your end-of-year team meeting?', 'Hello Emeka,\n\nThank you again for choosing our conference room for your team earlier this year. As the year closes, many teams are planning their strategy days.\n\nBook the conference room for December and we’ll include lunch and afternoon chops for up to 20 people at no extra cost.\n\nReply with a date and we’ll hold it for you.\n\nBest regards,\nLagoon Breeze Hotel & Grill'],
  ['Zainab', 'Come back for a calm weekend, Zainab', 'Hi Zainab,\n\nIt was lovely having you with us for the wedding weekend. If you ever need a peaceful break from Lagos traffic, our rooms (with breakfast for two) are just ₦65,000 a night.\n\nWeekdays until Dec 15: stay 3 nights, pay for 2.\n\nhttps://example.com/book/lagoon-breeze\n\nHope to welcome you back soon!'],
  ['Halima', 'Your high-floor suite misses you, Halima', 'Dear Halima,\n\nWe’ve missed you at Lagoon Breeze! Your favourite high-floor executive suite is free on several dates in December.\n\nAs one of our valued guests, enjoy a complimentary late check-out (4pm) and welcome drinks on your next stay.\n\nBook here: https://example.com/book/lagoon-breeze\n\nWarm regards,\nThe Lagoon Breeze team'],
  ['Bisola', 'A birthday brunch on us? 🎂', 'Hi Bisola,\n\nYou asked us about birthday packages when you came for Sunday brunch, so here’s a little something: book a brunch table for 4 or more this month and the birthday guest eats free, with a cake from our pastry chef.\n\nReserve your table: https://example.com/book/lagoon-breeze\n\nCan’t wait to celebrate with you!\nLagoon Breeze Hotel & Grill'],
  ['Ngozi', 'Planning another celebration, Ngozi?', "Hello Ngozi,\n\nIt was an honour hosting your mother's 60th birthday in our event hall. If there’s another family celebration coming up, we’d love to make it special again.\n\nBook the event hall for any date in Q1 and get 10% off, plus free decor consultation.\n\nJust reply to this email and our events manager will call you.\n\nWarmly,\nLagoon Breeze Hotel & Grill"],
];

const THANK_YOU = [
  ['Kemi', 'Thank you for brunch with us, Kemi!', 'Hi Kemi,\n\nThank you for bringing the family for Sunday brunch again. It’s always a joy to see you all!\n\nSee you next Sunday,\nLagoon Breeze'],
  ['Tunde', 'Table 4 is always yours, Tunde', 'Hi Tunde,\n\nThank you for being one of our most loyal brunch guests. Table 4 by the window will be ready for you as always.\n\nWarmly,\nLagoon Breeze'],
  ['Ifeanyi', 'Thanks for staying with us again', 'Hi Ifeanyi,\n\nThanks for another stay with us this month. Safe travels, and see you on your next trip to Lagos!\n\nLagoon Breeze'],
];

// [sessionKey, source, status, hoursAgo, name, phone, email, interest, conversation]
const LEADS = [
  ['web-tolu', 'chat', 'new', 2, 'Tolu Adebayo', '0803 000 1122', 'tolu.a@example.com', 'Wedding reception for 150 guests in February', [
    ['user', 'Hi, do you host wedding receptions? Around 150 guests'],
    ['assistant', 'Congratulations! 🎉 Yes, our event hall takes up to 200 guests, with in-house catering and decor partners. Packages start from ₦1,500,000. What date are you thinking of?'],
    ['user', 'February 14th. Can someone call me? Tolu, 0803 000 1122'],
    ['assistant', 'Lovely date! I’ve passed your details to our events manager, Tolu. They’ll call you on 0803 000 1122 shortly with availability and packages.'],
  ]],
  ['wa-chinedu', 'whatsapp', 'new', 30, 'Chinedu Okeke', '+234 803 000 2233', '', '3 nights in an executive suite from Dec 22', [
    ['user', 'Good evening. Do you have an executive suite free from 22 to 25 December?'],
    ['assistant', 'Good evening! Our executive suite is ₦120,000 per night with breakfast for two. I’ve noted Dec 22–25 for you. Can I take your name so the reservations team can confirm?'],
    ['user', 'Chinedu Okeke'],
    ['assistant', 'Thank you, Chinedu! Reservations will confirm availability on this WhatsApp number shortly. 🌴'],
  ]],
  ['ig-amaka', 'instagram', 'contacted', 52, 'Amaka Udeh', '0812 000 3344', '', 'Sunday brunch for 6 people', [
    ['user', 'How much is your Sunday brunch? We are 6'],
    ['assistant', 'Our Sunday brunch buffet is ₦25,000 per person (11am–3pm), so ₦150,000 for 6. Would you like me to reserve a table?'],
    ['user', 'Yes please, this Sunday. Amaka 0812 000 3344'],
    ['assistant', 'Done! A table for 6 is requested for this Sunday, Amaka. We’ll confirm on 0812 000 3344.'],
  ]],
  ['web-bello', 'chat', 'booked', 120, 'Musa Bello', '0809 000 4455', 'm.bello@example.com', 'Conference room for a 30-person training', [
    ['user', 'Do you have a conference room for 30 people next week Thursday?'],
    ['assistant', 'Yes! Our conference room takes up to 40 guests: ₦250,000 per day, with projector and Wi-Fi. Can I take your name and email to send the details?'],
    ['user', 'Musa Bello, m.bello@example.com'],
    ['assistant', 'Thank you, Mr Bello! The details are on the way to m.bello@example.com.'],
  ]],
  ['web-grace', 'chat', 'lost', 200, 'Grace Nnaji', '', 'grace.n@example.com', 'Room for one night (price check)', [
    ['user', 'How much is a room for one night?'],
    ['assistant', 'A standard room is ₦65,000 per night, breakfast for two included. Would you like to book?'],
    ['user', 'Ok thanks, send to grace.n@example.com'],
    ['assistant', 'Sent! Let us know if you’d like to reserve, Grace.'],
  ]],
];

export function demoActivity() {
  lastActivity = Date.now();
}

// Build (or rebuild) everything for the demo business from the seed.
export function resetDemo() {
  writeBusiness(PROFILE);
  const keep = (name, fallback = []) => load(name, fallback);
  const now = new Date().toISOString();

  // Contacts
  const contacts = keep('contacts').filter((c) => c.businessId !== DEMO_ID);
  const byName = {};
  CONTACTS.forEach(([firstName, lastName, lastService, visits, lastVisit, tags, notes], i) => {
    const c = {
      id: `demo-${firstName.toLowerCase()}`,
      businessId: DEMO_ID,
      firstName,
      lastName,
      email: `${firstName}.${lastName}@example.com`.toLowerCase(),
      phone: `+234 800 000 ${String(2100 + i * 37)}`,
      company: '',
      lastVisit: daysAgoDate(lastVisit),
      lastService,
      visits: String(visits),
      tags,
      notes,
      consent: true,
      unsubscribed: false,
      unsubscribeToken: crypto.randomBytes(16).toString('hex'),
      referralCode: `${firstName.toUpperCase()}-DEMO`,
      createdAt: hoursAgo(24 * 60),
    };
    contacts.push(c);
    byName[firstName] = c;
  });
  save('contacts', contacts);

  // Campaigns: one waiting for the owner's review, one already sent.
  const campaigns = keep('campaigns').filter((c) => c.businessId !== DEMO_ID);
  const messages = keep('campaign_messages').filter((m) => m.businessId !== DEMO_ID);
  const addCampaign = (id, name, goal, notes, list, status, ago) => {
    campaigns.push({ id, businessId: DEMO_ID, name, goal, notes, audience: { tag: '', inactiveDays: goal === 'win_back' ? 90 : 0 }, status, total: list.length, createdAt: hoursAgo(ago), updatedAt: hoursAgo(ago) });
    list.forEach(([first, subject, body], i) => {
      const c = byName[first];
      messages.push({
        id: `${id}-${i + 1}`,
        campaignId: id,
        businessId: DEMO_ID,
        contactId: c.id,
        to: c.email,
        toName: `${c.firstName} ${c.lastName}`,
        subject,
        body,
        status: status === 'done' ? 'sent' : 'review',
        createdAt: hoursAgo(ago),
        updatedAt: hoursAgo(ago),
        ...(status === 'done' ? { sentAt: hoursAgo(ago - 1), providerId: 'demo' } : {}),
      });
    });
  };
  addCampaign('demo-winback', 'Christmas comeback', 'win_back', 'Stay 3 nights pay 2; free dessert for anniversaries; birthday brunch offer', WIN_BACK, 'review', 3);
  addCampaign('demo-thanks', 'Thank-you notes', 'thank_you', '', THANK_YOU, 'done', 24 * 9);
  save('campaigns', campaigns);
  save('campaign_messages', messages);

  // Inquiries and the chats they came from, plus one friend invited by Kemi.
  const leads = keep('leads').filter((l) => l.businessId !== DEMO_ID);
  const convos = keep('conversations', {});
  for (const k of Object.keys(convos)) if (convos[k]?.businessId === DEMO_ID) delete convos[k];
  for (const [key, source, status, ago, name, phone, email, interest, chat] of LEADS) {
    const sessionId = `demo-${key}`;
    leads.push({ id: `demo-lead-${key}`, businessId: DEMO_ID, sessionId, source, status, name, phone, email, interest, createdAt: hoursAgo(ago), updatedAt: hoursAgo(ago), ...(status === 'contacted' ? { followedUpAt: hoursAgo(ago - 2), followUpChannel: 'whatsapp' } : {}) });
    convos[`${DEMO_ID}:${sessionId}`] = {
      businessId: DEMO_ID,
      sessionId,
      channel: { chat: 'website', whatsapp: 'whatsapp', instagram: 'instagram' }[source],
      startedAt: hoursAgo(ago + 0.1),
      updatedAt: hoursAgo(ago),
      messages: chat.map(([role, content], i) => ({ role, content, at: hoursAgo(ago + 0.1 - i * 0.02) })),
    };
  }
  const kemi = byName.Kemi;
  leads.push({ id: 'demo-lead-ref-ifeoma', businessId: DEMO_ID, source: 'referral', referredBy: kemi.id, referredByName: 'Kemi Adeyemi', name: 'Ifeoma Chukwu', phone: '0805 000 6677', email: 'ifeoma.c@example.com', interest: 'Referral offer', status: 'new', createdAt: hoursAgo(5), updatedAt: hoursAgo(5) });
  save('leads', leads);
  save('conversations', convos);

  lastReset = Date.now();
  console.log(`[demo] sample business reset (${now})`);
}

// Called when someone starts the demo: fresh data unless another prospect is mid-tour.
export function ensureFreshDemo() {
  if (!getBusiness(DEMO_ID) || Date.now() - lastActivity > RESET_IDLE_MS || !lastReset) resetDemo();
  demoActivity();
}

// Background safety net: tidy the demo after it has sat idle.
setInterval(() => {
  if (lastActivity && lastActivity > lastReset - 1000 && Date.now() - lastActivity > RESET_IDLE_MS) resetDemo();
}, 10 * 60_000).unref();
