# Marketing Agent

An AI marketing assistant for local businesses (barbershops, salons, dentists, gyms…). It does two jobs:

- **Brings customers back (outbound):** imports the business's customer list and writes a personal email to each person: win-backs, offers, review requests, thank-yous, and partnership pitches to other local businesses. The owner approves every email before it's sent.
- **Catches new customers (inbound):** a chat assistant on the business's website that answers questions 24/7 and captures leads.

**One engine, customized per client:** each business is one profile (services, prices, hours, FAQs, offers, tone). The AI only uses what's in that profile.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000/admin. The password is `changeme`.

Everything works for $0 out of the box:
- **AI:** with no key, a rule-based "offline mode" is used. For real AI writing, copy `.env.example` to `.env` and add a free key from Groq, Gemini or OpenRouter.
- **Email:** defaults to **test mode**. Approved emails are saved to `data/outbox.json` and nobody is emailed. Switch to Brevo or Resend (both have free tiers) in `.env` to send for real.

## Email campaigns: how it works

1. **Contacts → Import** a CSV exported from the business's booking/POS system (try `public/sample-contacts.csv`).
2. **Email campaigns → New campaign:** pick a goal and who gets it (e.g. "haven't visited in 60+ days").
3. The AI writes one email per person. **Review**: edit, approve, or skip each one.
4. **Send approved emails.**

### Personal, not creepy

The AI only ever sees a short whitelist of facts: first name, company, last service, a *vague* time since the last visit ("a few months", never exact dates), and whether they're a regular. Private notes and phone numbers are never sent to the AI. The prompt forbids mentioning data or tracking, guessing about anyone's personal life, fake urgency, and offering new-customer deals to existing customers. See `safeContactFacts` in `lib/ai.js`.

### Staying legal and out of spam folders

- Every email includes the business name, address and a working **unsubscribe** link, plus one-click unsubscribe headers (CAN-SPAM / GDPR basics).
- Contacts without marketing consent are never emailed. Unsubscribed contacts are never re-added by a later import.
- Consent is re-checked right before each send.
- A daily send limit and delay (`SEND_DAILY_LIMIT`, `SEND_DELAY_MS`) protect the sender's reputation. Start low and raise slowly.
- Only import people who are customers of the business or agreed to hear from it. This tool is not for buying lists or blasting strangers.

## What's inside

| Part | Where | What it does |
|---|---|---|
| Dashboard | `public/admin.html` | Leads, conversations, campaigns, contacts, quick messages, business setup, install code |
| Campaign engine | `lib/campaigns.js` | Audience selection, background drafting, approval queue, sending |
| Contacts | `lib/contacts.js` | CSV import with flexible column names, consent and unsubscribe handling |
| Email sending | `lib/mailer.js` | Test mode, Brevo, Resend; legal footer and unsubscribe headers |
| AI brain | `lib/ai.js` | Chat replies, lead capture, personalized campaign emails |
| Chat widget | `public/widget.js` | The chat bubble that goes on the client's site with one line of code |
| Demo page | `/demo/<business-id>` | A sample website for each client. Use it for sales videos and calls |
| Business profiles | `businesses/*.json` | One file per client |
| Data | `data/*.json` | Contacts, campaigns, leads, chat logs (never committed) |

## Roadmap

- Automatic follow-up if someone doesn't reply or book
- Track replies and bookings per campaign (results page)
- Deploy online (Render, Railway, Fly.io or a ~$5 VPS) so unsubscribe links and the widget work on the internet
- Missed-call text-back and SMS campaigns (Twilio)
- Partner/prospect finder for partnership outreach
