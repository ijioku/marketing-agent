// The script that runs the public demo page (moved out of demo.html).
// Keeping it in its own file lets the Content-Security-Policy block inline scripts, so injected code can never run.
// ---------- Motion: dots that react to the mouse/finger, a glow that follows it, a hero that lifts on scroll ----------
// Lighter and darker versions of the brand colour, so the lit-up dots shimmer.
// Make a hex colour lighter (amt above 0) or darker (amt below 0).
function shade(hex, amt) {
  // The colour as a number.
  const n = parseInt(hex.slice(1), 16);
  // Move each red/green/blue channel towards white or black.
  const ch = (v) => Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt));
  // Build the rgb() colour.
  return `rgb(${ch(n >> 16)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}
// The brand colour (updated when the profile loads).
let brand = '#0f766e';
// Start the dots in shades of the brand colour, with scroll parallax.
window.MotionField?.start(document.getElementById('field'), { parallax: true, colors: () => [brand, shade(brand, 0.45), shade(brand, -0.25), shade(brand, 0.2)] });

// The hero and its contents.
const heroEl = document.getElementById('hero');
const heroInner = document.getElementById('heroInner');
// Only when motion is allowed:
if (!window.MotionField?.reduce) {
  // when the mouse moves,
  addEventListener('pointermove', (e) => {
    // find where the hero is,
    const r = heroEl.getBoundingClientRect();
    // ignore the mouse below it,
    if (e.clientY > r.bottom) return;
    // move the glow to the mouse (as percentages of the hero's size).
    heroEl.style.setProperty('--gx', `${((e.clientX - r.left) / r.width) * 100}%`);
    heroEl.style.setProperty('--gy', `${((e.clientY - r.top) / r.height) * 100}%`);
  }, { passive: true });
  // While scrolling, update at most once per frame:
  let ticking = false;
  // on scroll,
  addEventListener('scroll', () => {
    // skip if an update is already planned,
    if (ticking) return;
    // plan one,
    ticking = true;
    // on the next frame:
    requestAnimationFrame(() => {
      ticking = false;
      // how far into the hero we've scrolled,
      const y = Math.min(window.scrollY, heroEl.offsetHeight);
      // move the hero contents down slowly and shrink them slightly,
      heroInner.style.transform = `translateY(${y * 0.35}px) scale(${1 - y / heroEl.offsetHeight * 0.06})`;
      // and fade them out.
      heroInner.style.opacity = String(Math.max(0, 1 - y / (heroEl.offsetHeight * 0.85)));
    });
  }, { passive: true });
}

// Theme: System / Dark / Light, shared with the dashboard.
// The empty switch container.
const box = document.getElementById('themeSwitch');
// Make three buttons:
for (const [key, label] of [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']]) {
  // a button,
  const b = document.createElement('button');
  // with its label and theme name,
  b.type = 'button'; b.textContent = label; b.dataset.themeSet = key;
  // when clicked:
  b.addEventListener('click', () => {
    // switch the theme,
    document.documentElement.dataset.theme = key;
    // remember it (shared with the dashboard),
    try { localStorage.setItem('ma-theme', key); } catch {}
    // update which button looks pressed.
    paint();
  });
  // Add it to the switch.
  box.append(b);
}
// Mark the button of the current theme as pressed.
const paint = () => box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === (document.documentElement.dataset.theme || 'system'))));
// Do it once now.
paint();

// The business id: the last part of the address.
const id = location.pathname.split('/').filter(Boolean).pop();
// Shortcut: make an element with optional text and class.
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
// Shortcut: find an element by id.
const $ = (s) => document.getElementById(s);

// "Ask a question" opens the chat widget.
document.getElementById('ask').addEventListener('click', () => window.dispatchEvent(new Event('marketing-agent:open')));

// "+234 800 000 5678" → "2348000005678" for a WhatsApp chat link.
// Keeps only the digits of an international number (with +); otherwise no WhatsApp link.
const waDigits = (phone) => { const d = String(phone || '').replace(/\D/g, ''); return String(phone).trim().startsWith('+') && d.length >= 8 ? d : ''; };

// Opened from the dashboard (?from=dashboard)? Show a clear "Back to dashboard" link.
if (new URLSearchParams(location.search).get('from') === 'dashboard') {
  // Show the back link...
  $('backToDashboard').classList.remove('hidden');
  // ...and hide the second dashboard link, which would now say the same thing.
  $('seeDashboard').classList.add('hidden');
}

// ---------- Booking form ----------
// The business's WhatsApp number (digits only) and name, filled in once the profile loads.
let bookingWa = '';
let bookingBizName = '';
// The form, its message line, its send button and the WhatsApp button.
const bookForm = $('bookForm');
const bookMsg = $('bookMsg');
const bookSend = $('bookSend');
const bookWa = $('bookWa');
// Today's date in the visitor's own time zone, as 2026-12-24.
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
// The date picker can't go back before today.
$('bookWhen').min = today;
// Show a message under the form, green for success and red for a problem.
const say = (text, ok) => { bookMsg.textContent = text; bookMsg.className = `form-msg wide ${ok ? 'ok' : 'err'}`; };
// When the form is sent:
bookForm.addEventListener('submit', async (e) => {
  // Stay on this page (no full reload).
  e.preventDefault();
  // Read every box.
  const f = Object.fromEntries(new FormData(bookForm));
  // Check the basics here first, so mistakes show at once (the server checks again).
  if ((f.name || '').trim().length < 2) return say('Please enter your name.');
  if ((f.phone || '').replace(/\D/g, '').length < 7) return say('Please enter a valid phone number.');
  // Typed dates can skip the picker's minimum, so check the date isn't in the past.
  if (f.when && f.when < today) return say('Please choose a date from today onwards.');
  // Stop double-sending while it's on its way.
  bookSend.disabled = true;
  say('Sending…', true);
  try {
    // Send it to the server, with the business id from the address.
    const r = await fetch('/api/public/booking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f, businessId: id }) });
    // Read the server's answer.
    const data = await r.json().catch(() => ({}));
    // A problem: show the server's message.
    if (!r.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    // Success: thank them and say what happens next.
    say(`Thank you, ${f.name.trim()}! Your request was sent. The team will contact you on ${f.phone.trim()} to confirm.`, true);
    // Offer WhatsApp too, with the request already typed out.
    if (bookingWa) {
      // The message, one detail per line.
      const lines = [`Hello ${bookingBizName}, I just sent a booking request on your website.`, `Name: ${f.name.trim()}`, f.service && `For: ${f.service}`, f.when && `Date: ${f.when}`, f.guests && `People: ${f.guests}`, f.note && `Note: ${f.note.trim()}`].filter(Boolean);
      // Point the button at WhatsApp with that message, and show it.
      bookWa.href = `https://wa.me/${bookingWa}?text=${encodeURIComponent(lines.join('\n'))}`;
      bookWa.classList.remove('hidden');
    }
    // Clear the form for the next person.
    bookForm.reset();
  } catch (err) {
    // Show what went wrong.
    say(err.message);
  } finally {
    // Allow sending again.
    bookSend.disabled = false;
  }
});

// Load the business's public profile.
fetch(`/api/public/business/${encodeURIComponent(id)}`)
  // Stop if not found.
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  // Then fill in the page:
  .then((b) => {
    // the tab title,
    document.title = b.name;
    // the brand colour (only a valid #rrggbb),
    if (/^#[0-9a-f]{6}$/i.test(b.brandColor || '')) { brand = b.brandColor; document.documentElement.style.setProperty('--brand', b.brandColor); }
    // the name in the navigation and hero,
    $('navName').textContent = b.name;
    $('name').textContent = b.name;
    // the business type,
    $('kind').textContent = b.type || '';
    // the tagline,
    $('tagline').textContent = b.tagline || '';
    // Both Book now buttons already point to the booking form on this page (#booking).
    // Fill the form's "What would you like?" list with this business's services.
    for (const s of b.services || []) {
      // One option per service, showing its price.
      const o = el('option', s.price ? `${s.name} (${s.price})` : s.name);
      // The value sent is just the service name.
      o.value = s.name;
      $('bookService').append(o);
    }
    // Remember the business's WhatsApp number for the "Also send on WhatsApp" button.
    bookingWa = waDigits(b.phone);
    // Remember the name for the WhatsApp message.
    bookingBizName = b.name;

    // The price list:
    const svc = $('services');
    // for each service,
    for (const s of b.services || []) {
      // a list item,
      const li = el('li');
      // a line holding:
      const line = el('div', null, 'line');
      // the name, a dotted leader and the price,
      line.append(el('b', s.name), el('span', null, 'leader'), el('span', s.price || '', 'price'));
      li.append(line);
      // and the duration underneath if known.
      if (s.duration) li.append(el('div', s.duration, 'dur'));
      svc.append(li);
    }
    // No services: remove the section.
    if (!svc.children.length) svc.closest('section').remove();

    // The visit details:
    const info = $('info');
    // helper: add a box with a label and a value.
    const add = (label, build) => { const d = el('div'); d.append(el('div', label, 'label')); const v = el('div', null, 'value'); build(v); d.append(v); info.append(d); };
    // Opening hours.
    if (b.hours) add('Hours', (v) => (v.textContent = b.hours));
    // Address.
    if (b.address) add('Address', (v) => (v.textContent = b.address));
    // Phone:
    if (b.phone) add('Call or WhatsApp', (v) => {
      // a tap-to-call link,
      const a = el('a', b.phone); a.href = `tel:${b.phone.replace(/[^\d+]/g, '')}`; v.append(a);
      // and a WhatsApp link when the number has a country code.
      const wa = waDigits(b.phone);
      if (wa) { const w = el('a', 'Chat on WhatsApp', 'wa'); w.href = `https://wa.me/${wa}`; w.target = '_blank'; w.rel = 'noopener'; v.append(el('br'), w); }
    });
    // Nothing to show: remove the section.
    if (!info.children.length) info.closest('section').remove();
    // The footer text with this year.
    $('foot').textContent = `© ${new Date().getFullYear()} ${b.name} · Chat assistant by Marketing Agent · `;
    // Plus a link to the privacy policy.
    const privacy = document.createElement('a');
    privacy.href = '/privacy';
    privacy.textContent = 'Privacy';
    privacy.style.color = 'inherit';
    $('foot').append(privacy);

    // Finally load the chat widget for this business.
    const w = document.createElement('script');
    w.src = '/widget.js';
    w.dataset.business = b.id;
    document.body.append(w);
  })
  // Not found: say so.
  .catch(() => { $('name').textContent = 'Business not found'; $('navName').textContent = ''; });
