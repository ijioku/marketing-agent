// The sample business prospects can sign into ("Try the demo") and click around:
// approve emails, delete contacts, follow up inquiries… without breaking anything.
// Everything belonging to the demo business is rebuilt from the seed below on reset,
// with dates moved so the data always looks recent ("2 hours ago", "4 months ago").
// Demo emails are NEVER really sent, even when real email sending is switched on.
// crypto: random unsubscribe tokens for the sample contacts.
import crypto from 'node:crypto';
// load/save: read and write stored data.
import { load, save } from './store.js';
// Save and read business profiles.
import { writeBusiness, getBusiness } from './businesses.js';

// The sample hotel's id.
export const DEMO_ID = 'lagoon-breeze-hotel';
// True if an id is the sample hotel.
export const isDemoBusiness = (id) => id === DEMO_ID;
// The demo hotel's real booking section (on its sample page), used by Book now buttons and in the sample emails.
// It uses this server's own address, so it works locally and on the live site.
const DEMO_BOOKING_URL = `${(process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '')}/demo/${DEMO_ID}#booking`;

const RESET_IDLE_MS = 30 * 60_000; // reset once nobody has used the demo for 30 minutes
// When a demo visitor last did something (0 = never).
let lastActivity = 0;
// When the demo was last reset.
let lastReset = 0;

// A date-time h hours before now.
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
// A date (YYYY-MM-DD) d days before now.
const daysAgoDate = (d) => new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);

// The sample hotel's profile, exactly as an owner would fill it in Business setup.
const PROFILE = {
  id: DEMO_ID,
  // Marks it as the demo business.
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
  bookingLink: DEMO_BOOKING_URL,
  reviewLink: 'https://example.com/review/lagoon-breeze',
  // What the hotel sells, with prices (the AI uses these to answer customers).
  services: [
    { name: 'Standard room (bed & breakfast)', price: '₦65,000 / night', duration: '' },
    { name: 'Executive suite', price: '₦120,000 / night', duration: '' },
    { name: 'Sunday brunch buffet', price: '₦25,000 per person', duration: '11am–3pm' },
    { name: 'Rooftop grill dinner for two', price: '₦45,000', duration: '' },
    { name: 'Conference room (up to 40 guests)', price: '₦250,000 / day', duration: '8 hrs' },
    { name: 'Event hall (up to 200 guests)', price: 'From ₦1,500,000', duration: '' },
  ],
  // Common questions and answers for the AI.
  faqs: [
    { q: 'Is breakfast included?', a: 'Yes, every room includes breakfast for two in the restaurant (7am–10:30am).' },
    { q: 'Do you have parking and power?', a: 'Free secure parking, 24/7 power with backup, and fast Wi-Fi in every room.' },
    { q: 'How do I pay?', a: 'Bank transfer, POS or card. A 50% deposit confirms event and conference bookings.' },
    { q: 'Do you host weddings and parties?', a: 'Yes, the event hall takes up to 200 guests, with in-house catering and decor partners.' },
  ],
  // Current offers.
  offers: ['Stay 3 nights, pay for 2 (weekdays until Dec 15)', 'Birthday guests get a free cake at the rooftop grill'],
  // House rules.
  policies: ['Check-in 2pm, check-out 12 noon', 'Free cancellation up to 48 hours before arrival', '50% deposit for events'],
  // What the AI should aim for in chats.
  goal: 'Get room bookings, table reservations and event inquiries, and bring past guests back',
  // What a customer and their invited friend get.
  referralOffer: 'You and your friend both get a free Sunday brunch for one',
};

// [firstName, lastName, lastService, visits, lastVisit (days ago), tags, notes]
// The sample customers, one per line.
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

// The "Christmas comeback" campaign: [customer first name, subject, email text] for each email waiting for approval.
const WIN_BACK = [
  ['Chidi', 'We’ve kept your suite warm, Chidi', 'Hi Chidi,\n\nIt’s been a few months since your last stay in our executive suite, and the team still remembers how much you liked the quiet top floor.\n\nIf work brings you to Lagos before Christmas, stay 3 weeknights and pay for only 2. Just reply to this email or book here and we’ll hold your favourite room:\n\n{{BOOKING_LINK}}\n\nSee you soon,\nThe Lagoon Breeze team'],
  ['Funmi', 'Your table by the rooftop is waiting, Funmi', 'Hi Funmi,\n\nWe loved hosting you for dinner at the rooftop grill, and we hear there’s an anniversary coming up in December! 🎉\n\nCome celebrate with us: book a dinner for two this month and dessert and a bottle of chilled zobo cocktail are on the house.\n\nReserve your table: {{BOOKING_LINK}}\n\nWarmly,\nLagoon Breeze Hotel & Grill'],
  ['Emeka', 'Planning your end-of-year team meeting?', 'Hello Emeka,\n\nThank you again for choosing our conference room for your team earlier this year. As the year closes, many teams are planning their strategy days.\n\nBook the conference room for December and we’ll include lunch and afternoon chops for up to 20 people at no extra cost.\n\nReply with a date and we’ll hold it for you.\n\nBest regards,\nLagoon Breeze Hotel & Grill'],
  ['Zainab', 'Come back for a calm weekend, Zainab', 'Hi Zainab,\n\nIt was lovely having you with us for the wedding weekend. If you ever need a peaceful break from Lagos traffic, our rooms (with breakfast for two) are just ₦65,000 a night.\n\nWeekdays until Dec 15: stay 3 nights, pay for 2.\n\n{{BOOKING_LINK}}\n\nHope to welcome you back soon!'],
  ['Halima', 'Your high-floor suite misses you, Halima', 'Dear Halima,\n\nWe’ve missed you at Lagoon Breeze! Your favourite high-floor executive suite is free on several dates in December.\n\nAs one of our valued guests, enjoy a complimentary late check-out (4pm) and welcome drinks on your next stay.\n\nBook here: {{BOOKING_LINK}}\n\nWarm regards,\nThe Lagoon Breeze team'],
  ['Bisola', 'A birthday brunch on us? 🎂', 'Hi Bisola,\n\nYou asked us about birthday packages when you came for Sunday brunch, so here’s a little something: book a brunch table for 4 or more this month and the birthday guest eats free, with a cake from our pastry chef.\n\nReserve your table: {{BOOKING_LINK}}\n\nCan’t wait to celebrate with you!\nLagoon Breeze Hotel & Grill'],
  ['Ngozi', 'Planning another celebration, Ngozi?', "Hello Ngozi,\n\nIt was an honour hosting your mother's 60th birthday in our event hall. If there’s another family celebration coming up, we’d love to make it special again.\n\nBook the event hall for any date in Q1 and get 10% off, plus free decor consultation.\n\nJust reply to this email and our events manager will call you.\n\nWarmly,\nLagoon Breeze Hotel & Grill"],
];

// The "Thank-you notes" campaign, already sent.
const THANK_YOU = [
  ['Kemi', 'Thank you for brunch with us, Kemi!', 'Hi Kemi,\n\nThank you for bringing the family for Sunday brunch again. It’s always a joy to see you all!\n\nSee you next Sunday,\nLagoon Breeze'],
  ['Tunde', 'Table 4 is always yours, Tunde', 'Hi Tunde,\n\nThank you for being one of our most loyal brunch guests. Table 4 by the window will be ready for you as always.\n\nWarmly,\nLagoon Breeze'],
  ['Ifeanyi', 'Thanks for staying with us again', 'Hi Ifeanyi,\n\nThanks for another stay with us this month. Safe travels, and see you on your next trip to Lagos!\n\nLagoon Breeze'],
];

// [sessionKey, source, status, hoursAgo, name, phone, email, interest, conversation]
// Sample inquiries, each with the chat it came from: [role, message].
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

// Note that a demo visitor just did something (resets the idle timer).
export function demoActivity() {
  lastActivity = Date.now();
}

// Build (or rebuild) everything for the demo business from the seed.
export function resetDemo() {
  // Save the sample hotel's profile.
  writeBusiness(PROFILE);
  // Shortcut: load a collection, or an empty list.
  const keep = (name, fallback = []) => load(name, fallback);
  // The time now, for the log message.
  const now = new Date().toISOString();

  // Contacts
  // Keep every other business's contacts; drop the demo's.
  const contacts = keep('contacts').filter((c) => c.businessId !== DEMO_ID);
  // Sample contacts by first name, used below to link emails to people.
  const byName = {};
  // Turn each sample line into a full contact:
  CONTACTS.forEach(([firstName, lastName, lastService, visits, lastVisit, tags, notes], i) => {
    const c = {
      // A fixed id like "demo-kemi".
      id: `demo-${firstName.toLowerCase()}`,
      businessId: DEMO_ID,
      firstName,
      lastName,
      // A made-up email like kemi.adeyemi@example.com.
      email: `${firstName}.${lastName}@example.com`.toLowerCase(),
      // A made-up phone number, different for each person.
      phone: `+234 800 000 ${String(2100 + i * 37)}`,
      company: '',
      // Their last visit, counted back from today so it always looks recent.
      lastVisit: daysAgoDate(lastVisit),
      lastService,
      // Visits stored as text, like imported CSV data.
      visits: String(visits),
      tags,
      notes,
      // They agreed to receive emails.
      consent: true,
      unsubscribed: false,
      // A random unsubscribe token.
      unsubscribeToken: crypto.randomBytes(16).toString('hex'),
      // A readable invite code like "TUNDE-DEMO".
      referralCode: `${firstName.toUpperCase()}-DEMO`,
      // Added 60 days ago.
      createdAt: hoursAgo(24 * 60),
    };
    // Add it to the list...
    contacts.push(c);
    // ...and remember it by first name.
    byName[firstName] = c;
  });
  // Save all contacts.
  save('contacts', contacts);

  // Campaigns: one waiting for the owner's review, one already sent.
  // Keep other businesses' campaigns and emails; drop the demo's.
  const campaigns = keep('campaigns').filter((c) => c.businessId !== DEMO_ID);
  const messages = keep('campaign_messages').filter((m) => m.businessId !== DEMO_ID);
  // Helper: add one campaign and its emails.
  const addCampaign = (id, name, goal, notes, list, status, ago) => {
    // The campaign record (win-back campaigns target people away 90+ days).
    campaigns.push({ id, businessId: DEMO_ID, name, goal, notes, audience: { tag: '', inactiveDays: goal === 'win_back' ? 90 : 0 }, status, total: list.length, createdAt: hoursAgo(ago), updatedAt: hoursAgo(ago) });
    // One email per line of the campaign's list:
    list.forEach(([first, subject, body], i) => {
      // the customer it's for,
      const c = byName[first];
      // the email record:
      messages.push({
        id: `${id}-${i + 1}`,
        campaignId: id,
        businessId: DEMO_ID,
        contactId: c.id,
        to: c.email,
        toName: `${c.firstName} ${c.lastName}`,
        subject,
        // the email text, with the demo booking link filled in.
        body: body.split('{{BOOKING_LINK}}').join(DEMO_BOOKING_URL),
        // sent for a finished campaign, waiting for review otherwise.
        status: status === 'done' ? 'sent' : 'review',
        createdAt: hoursAgo(ago),
        updatedAt: hoursAgo(ago),
        // Sent emails also get a sent time and a fake provider id.
        ...(status === 'done' ? { sentAt: hoursAgo(ago - 1), providerId: 'demo' } : {}),
      });
    });
  };
  // The campaign waiting for approval (made 3 hours ago).
  addCampaign('demo-winback', 'Christmas comeback', 'win_back', 'Stay 3 nights pay 2; free dessert for anniversaries; birthday brunch offer', WIN_BACK, 'review', 3);
  // The finished campaign (9 days ago).
  addCampaign('demo-thanks', 'Thank-you notes', 'thank_you', '', THANK_YOU, 'done', 24 * 9);
  // Save campaigns and emails.
  save('campaigns', campaigns);
  save('campaign_messages', messages);

  // Inquiries and the chats they came from, plus one friend invited by Kemi.
  // Keep other businesses' inquiries.
  const leads = keep('leads').filter((l) => l.businessId !== DEMO_ID);
  // All conversations.
  const convos = keep('conversations', {});
  // Delete the demo's old conversations.
  for (const k of Object.keys(convos)) if (convos[k]?.businessId === DEMO_ID) delete convos[k];
  // For each sample inquiry:
  for (const [key, source, status, ago, name, phone, email, interest, chat] of LEADS) {
    // its chat session id,
    const sessionId = `demo-${key}`;
    // the inquiry (a "contacted" one also gets a follow-up record),
    leads.push({ id: `demo-lead-${key}`, businessId: DEMO_ID, sessionId, source, status, name, phone, email, interest, createdAt: hoursAgo(ago), updatedAt: hoursAgo(ago), ...(status === 'contacted' ? { followedUpAt: hoursAgo(ago - 2), followUpChannel: 'whatsapp' } : {}) });
    // and its conversation, with message times spaced a minute apart.
    convos[`${DEMO_ID}:${sessionId}`] = {
      businessId: DEMO_ID,
      sessionId,
      channel: { chat: 'website', whatsapp: 'whatsapp', instagram: 'instagram' }[source],
      startedAt: hoursAgo(ago + 0.1),
      updatedAt: hoursAgo(ago),
      messages: chat.map(([role, content], i) => ({ role, content, at: hoursAgo(ago + 0.1 - i * 0.02) })),
    };
  }
  // Kemi's referral: a friend she invited.
  const kemi = byName.Kemi;
  // Add the referred friend as an inquiry.
  leads.push({ id: 'demo-lead-ref-ifeoma', businessId: DEMO_ID, source: 'referral', referredBy: kemi.id, referredByName: 'Kemi Adeyemi', name: 'Ifeoma Chukwu', phone: '0805 000 6677', email: 'ifeoma.c@example.com', interest: 'Referral offer', status: 'new', createdAt: hoursAgo(5), updatedAt: hoursAgo(5) });
  // Save inquiries and conversations.
  save('leads', leads);
  save('conversations', convos);

  // Remember when this reset happened.
  lastReset = Date.now();
  // Log it.
  console.log(`[demo] sample business reset (${now})`);
}

// Called when someone starts the demo: fresh data unless another prospect is mid-tour.
export function ensureFreshDemo() {
  // Reset if the hotel is missing, idle for 30+ minutes, or never reset since start-up.
  if (!getBusiness(DEMO_ID) || Date.now() - lastActivity > RESET_IDLE_MS || !lastReset) resetDemo();
  // Note this activity.
  demoActivity();
}

// Background safety net: tidy the demo after it has sat idle.
// Every 10 minutes:
setInterval(() => {
  // if someone used the demo after the last reset and it's now been idle 30+ minutes, reset it.
  if (lastActivity && lastActivity > lastReset - 1000 && Date.now() - lastActivity > RESET_IDLE_MS) resetDemo();
// unref() lets the program exit even though this timer exists.
}, 10 * 60_000).unref();
