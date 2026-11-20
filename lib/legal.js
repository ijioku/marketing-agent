// Privacy policy and terms of service, served at /privacy and /terms.
// Plain language on purpose: business owners and their customers should be able
// to read these in a few minutes. Update UPDATED whenever the wording changes.

export const UPDATED = '20 November 2026';

// Where people can reach you. Set SUPPORT_EMAIL on the server to show an address;
// without it the pages point people to the business or to the dashboard.
const contactLine = (email) =>
  email
    ? `email <a href="mailto:${email}">${email}</a>`
    : 'reply to any email you got from us, or message us from your dashboard';

export function privacyBody({ supportEmail = '' } = {}) {
  const contact = contactLine(supportEmail);
  return `
<h1>Privacy policy</h1>
<p class="meta">Last updated ${UPDATED}</p>

<p>Marketing Agent helps businesses answer customer messages, keep a list of their customers and send them offers. This page explains what information we hold, why, who else sees it and what you can ask us to do with it. We follow the Nigeria Data Protection Act 2023.</p>

<h2>Who is responsible for what</h2>
<p><b>If you are a business using Marketing Agent</b>, we hold your account details and run the service for you.</p>
<p><b>If you are a customer of one of those businesses</b>, the business decides what to collect about you and how to use it. We store and process it on their behalf and only follow their instructions. For questions about your data, contact the business first; we will help them answer you.</p>

<h2>What we collect</h2>
<ul>
<li><b>Business accounts:</b> name and email of each person who can sign in, a scrambled (hashed) version of their password, and the business profile they enter: services, prices, opening hours, offers and contact links.</li>
<li><b>Customer lists:</b> names, phone numbers, emails, past visits or services and notes that a business imports or that are added while using the service.</li>
<li><b>Conversations:</b> messages people send to a business's chat assistant on its website, WhatsApp or Instagram, and the assistant's replies. If someone shares their name, phone, email or what they want, it is saved as an inquiry for that business.</li>
<li><b>Referral and offer pages:</b> the name, phone and email someone types in to claim an offer.</li>
<li><b>Email activity:</b> which marketing emails were sent and whether someone unsubscribed.</li>
<li><b>Technical data:</b> IP addresses are used briefly to block password guessing and spam. We do not use advertising or tracking cookies. The only cookie is the one that keeps you signed in.</li>
</ul>

<h2>Why we use it</h2>
<ul>
<li>To let the business's assistant answer questions and pass inquiries to the owner.</li>
<li>To draft and send the emails and offers the business approves.</li>
<li>To keep accounts secure, stop abuse and fix problems.</li>
</ul>
<p>We do not sell personal information, and we do not use it to advertise our own or anyone else's products.</p>

<h2>Who else handles it</h2>
<p>We use a small number of trusted providers to run the service. Each only gets what it needs to do its job:</p>
<ul>
<li><b>Render</b> hosts the website and server.</li>
<li><b>Neon</b> stores the database.</li>
<li><b>Groq</b> (or another AI provider) reads the conversation in order to write the assistant's reply and draft emails.</li>
<li><b>Brevo or Resend</b> deliver emails.</li>
<li><b>Meta</b> (WhatsApp and Instagram) carries messages when a business connects those channels.</li>
<li><b>Google</b> confirms your identity if you choose "Continue with Google". We receive only your name and email address.</li>
</ul>
<p>Some of these providers store data outside Nigeria, for example in the United States or Europe. We only use providers that protect data with encryption and industry security standards.</p>

<h2>How long we keep it</h2>
<p>We keep a business's data while its account is active. A business can delete contacts at any time from the dashboard. When a business closes its account, we delete its data within 30 days, apart from short-lived backups that expire on their own.</p>

<h2>How we protect it</h2>
<ul>
<li>All traffic uses an encrypted (HTTPS) connection.</li>
<li>Passwords are never stored as written, only as a one-way scrambled version.</li>
<li>Each business owner can only see their own business.</li>
<li>Password guessing is blocked after a few tries, and password reset links expire after 30 minutes and work once.</li>
</ul>
<p>No system is perfectly secure. If a breach affects your information, we will tell the affected businesses and the regulator as the law requires.</p>

<h2>Your rights</h2>
<p>You can ask to see the information held about you, correct it, delete it, or stop marketing messages. Every marketing email has an unsubscribe link that works straight away. For anything else, contact the business you dealt with, or ${contact}. We answer within 30 days. You can also complain to the Nigeria Data Protection Commission.</p>

<h2>Children</h2>
<p>Marketing Agent is for businesses and their adult customers. We do not knowingly collect information about children under 13.</p>

<h2>Changes</h2>
<p>If we change this policy, we will update the date at the top and tell business accounts about important changes.</p>
`;
}

export function termsBody({ supportEmail = '' } = {}) {
  const contact = contactLine(supportEmail);
  return `
<h1>Terms of service</h1>
<p class="meta">Last updated ${UPDATED}</p>

<p>These terms apply to businesses that use Marketing Agent. By signing in, you agree to them. If you don't agree, please don't use the service.</p>

<h2>What you get</h2>
<p>A chat assistant for your website and messaging channels, a dashboard to see inquiries and customers, and tools to draft and send marketing messages. Features can change as we improve the service.</p>

<h2>Your account</h2>
<ul>
<li>Keep your password private and tell us straight away if you think someone else has used your account.</li>
<li>You are responsible for what happens in your account, including logins you create for your staff.</li>
<li>The information you give us about your business (prices, hours, offers) must be accurate. The assistant uses it to answer customers.</li>
</ul>

<h2>Your customers' information</h2>
<ul>
<li>You must have the right to contact everyone you import. Only add people who are your customers or who agreed to hear from you.</li>
<li>Don't use Marketing Agent to send spam, bought email lists, scams, or anything illegal, hateful or misleading.</li>
<li>Respect unsubscribes. The service stops emailing anyone who unsubscribes, and you must not add them back.</li>
<li>Your customer data belongs to you. You can ask for a copy or ask us to delete it at any time.</li>
</ul>

<h2>The AI assistant</h2>
<p>The assistant answers from the information you give it, but AI can make mistakes. Check the messages it drafts before you approve them, and don't rely on it for anything where a wrong answer could cause harm, such as medical, legal or financial advice.</p>

<h2>Payment</h2>
<p>Prices and payment dates are agreed with you directly. If a payment is missed, we may pause the service after giving you notice.</p>

<h2>Availability</h2>
<p>We work to keep the service running, but we can't promise it will never go down or be slow. We may pause it for maintenance or to fix problems.</p>

<h2>Ending the service</h2>
<p>You can stop at any time. We may suspend or close an account that breaks these terms, puts other people at risk or is used to send spam. Where we can, we will warn you first and give you a chance to fix the problem and to download your data.</p>

<h2>Liability</h2>
<p>The service is provided as it is. As far as the law allows, we are not responsible for lost profits or indirect losses, and our total responsibility is limited to the amount you paid us in the three months before the problem. Nothing in these terms removes rights you have under Nigerian consumer law.</p>

<h2>Changes and law</h2>
<p>We may update these terms and will tell business accounts about important changes. These terms are governed by the laws of the Federal Republic of Nigeria.</p>

<h2>Contact</h2>
<p>Questions about these terms? ${contact}. See also our <a href="/privacy">privacy policy</a>.</p>
`;
}
