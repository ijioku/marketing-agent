// The script that runs the sign-in page and the dashboard (moved out of admin.html).
// Keeping it in its own file lets the Content-Security-Policy block inline scripts, so injected code can never run.
// The business currently shown.
let bizId = '';
// Server status (AI on, email mode, etc.).
let STATUS = null;
// Who is signed in.
let ME = null;
// The current business's inquiries.
let LEADS = [];
// The current business's campaigns.
let CAMPAIGNS = [];
// Shortcut: find one element with a CSS selector.
const $ = (s) => document.querySelector(s);
// Shortcut: make an element with optional text and class (text is always safe, never HTML).
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
// "5 min ago", "2 hours ago", "Yesterday", "3 days ago", then the date.
// Turn a date into "5 min ago" style text.
const ago = (iso) => {
  // Minutes since then.
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  // Not a valid date (or in the future): show the full date.
  if (!(m >= 0)) return fmt(iso);
  // Under a minute.
  if (m < 1) return 'Just now';
  // Under an hour.
  if (m < 60) return `${m} min ago`;
  // Hours.
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  // Days.
  const d = Math.round(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  // A week or more: the day and month.
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
};
// A full date and time in the visitor's own format.
const fmt = (iso) => iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
// True if the device asks for less motion.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Call our server's dashboard API and get the JSON answer (throws on errors).
async function api(path, opts = {}) {
  // Send the request,
  const res = await fetch(`/api/admin${path}`, {
    ...opts,
    credentials: 'same-origin', // sends the secure session cookie; the password is never stored in the browser
    // as JSON.
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  // Read the answer (empty if it isn't JSON).
  const data = await res.json().catch(() => ({}));
  // Session expired while using the dashboard: go back to the sign-in screen.
  if (res.status === 401 && path !== '/login' && !$('#app').classList.contains('hidden')) showLogin('Your session ended. Please sign in again.');
  // Any error: throw with the server's message.
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  // Hand back the data.
  return data;
}

// Show the sign-in screen (with an optional message).
function showLogin(message = '') {
  // Hide the dashboard,
  $('#app').classList.add('hidden');
  // show sign-in,
  $('#login').classList.remove('hidden');
  // show the message,
  $('#loginErr').textContent = message;
  // stop the dashboard's dots,
  stopAppField();
  // start the sign-in dots.
  startDots();
}

// ---------- Theme: System / Dark / Light ----------
// The three theme choices.
const THEMES = [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']];
// Build the theme switches (first time) and mark the current choice.
function paintThemeSwitches() {
  // The current theme.
  const current = document.documentElement.dataset.theme || 'system';
  // For each switch on the page:
  document.querySelectorAll('[data-theme-switch]').forEach((box) => {
    // if its buttons haven't been made yet:
    if (!box.children.length) {
      // tell screen readers it's a group,
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', 'Colour theme');
      // make one button per theme,
      for (const [key, label] of THEMES) {
        const b = el('button', label);
        b.type = 'button';
        b.dataset.themeSet = key;
        // when clicked:
        b.addEventListener('click', () => {
          // switch the theme,
          document.documentElement.dataset.theme = key;
          // remember it,
          try { localStorage.setItem('ma-theme', key); } catch {}
          // update the switches,
          paintThemeSwitches();
          // redraw the Google button in matching colours.
          if (typeof renderGoogle === 'function') renderGoogle();
        });
        box.append(b);
      }
    }
    // Mark the current theme's button as pressed.
    box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === current)));
  });
}
// Do it now.
paintThemeSwitches();

// ---------- Sign-in screen: interactive dots ----------
// Dots that dodge the mouse/finger and light up in the four glow colours (see /motion.js).
// They only run while the sign-in screen is showing.
// The running dot effect (null when stopped).
let dotsField = null;
// Start the sign-in dots (if not already running).
function startDots() {
  // Already running, or the script didn't load: stop.
  if (dotsField || !window.MotionField) return;
  // Read a colour from the CSS.
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  // Start them in the four accent colours.
  dotsField = MotionField.start($('#dots'), { density: 5200, colors: () => [css('--dusk'), css('--lagoon'), css('--gold'), css('--sunset')] });
}
// Stop them.
function stopDots() { dotsField?.stop(); dotsField = null; }

// Inside the dashboard: fewer dots and a softer light, so it stays calm while you work.
// The dashboard's dot effect.
let appField = null;
// Start it (if not already running).
function startAppField() {
  if (appField || !window.MotionField) return;
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  // Fewer dots, softer light, with scroll parallax.
  appField = MotionField.start($('#appField'), { parallax: true, density: 6500, spot: 0.12, colors: () => [css('--dusk'), css('--lagoon'), css('--gold'), css('--sunset')] });
}
// Stop it.
function stopAppField() { appField?.stop(); appField = null; }
// Tilt the phone preview towards the mouse.
window.MotionField?.tilt($('.phone'), 5);

// ---------- The live chat on the sign-in screen ----------
// The scripted conversation: [who, message].
const CHAT = [
  ['guest', 'Good evening! Any room free this Friday? 🙏'],
  ['bot', 'Yes! A standard room is ₦65,000 a night, breakfast for two included. Shall I hold one for you?'],
  ['guest', 'Yes please. Chinedu, 0803 000 2233'],
  ['bot', 'Done, Chinedu 🎉 Reception will confirm on WhatsApp in a few minutes.'],
];
// Wait for ms milliseconds.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Add one chat bubble with the current time.
function addBubble(who, text) {
  const b = el('div', text, `bubble ${who}`);
  b.append(el('time', new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
  $('#chat').append(b);
}
// Play the conversation in a loop.
async function playChat() {
  // The chat area and the "New inquiry" card.
  const chat = $('#chat'), toast = $('#toast');
  // Reduced motion: show everything at once, no animation.
  if (reduceMotion) { CHAT.forEach(([w, t]) => addBubble(w, t)); toast.classList.add('show'); return; }
  // Forever:
  while (true) {
    // paused while hidden (signed in or tab in background),
    if ($('#login').classList.contains('hidden') || document.hidden) { await wait(1000); continue; }
    // clear the chat,
    chat.replaceChildren(); toast.classList.remove('show');
    // short pause,
    await wait(900);
    // for each message:
    for (const [who, text] of CHAT) {
      // the assistant first "types" for 1.3 seconds,
      if (who === 'bot') {
        const typing = el('div', null, 'typing'); typing.append(el('i'), el('i'), el('i'));
        chat.append(typing); await wait(1300); typing.remove();
      // the guest just pauses,
      } else await wait(1000);
      // show the message,
      addBubble(who, text);
      await wait(900);
    }
    // then slide in the "New inquiry" card,
    toast.classList.add('show');
    // and wait before starting again.
    await wait(4200);
  }
}

// ---------- Sign in / forgot password / new password ----------
// Show one of the three sign-in views and hide the others.
function showView(name) {
  // Turns "forgot" into "#viewForgot" and toggles each view.
  for (const v of ['signin', 'forgot', 'reset']) $(`#view${v[0].toUpperCase()}${v.slice(1)}`).classList.toggle('hidden', v !== name);
}
// Any "Back to sign in" button switches view.
document.addEventListener('click', (e) => { const v = e.target.closest('[data-view]')?.dataset.view; if (v) showView(v); });
// Show a message under the sign-in form (green if ok, red if not).
function loginMessage(text, ok = false) { const m = $('#loginErr'); m.className = `msg ${ok ? 'ok' : 'err'}`; m.textContent = text; }

// "Forgot password?": copy the typed email over and show the reset form.
$('#forgotLink').addEventListener('click', () => { $('#forgotEmail').value = $('#user').value.trim(); $('#forgotMsg').textContent = ''; showView('forgot'); $('#forgotEmail').focus(); });
// Send the reset link:
$('#forgotForm').addEventListener('submit', async (e) => {
  // stop the page reloading,
  e.preventDefault();
  const btn = $('#forgotBtn'), msg = $('#forgotMsg');
  // stop double-clicks,
  btn.disabled = true;
  try {
    // ask the server to email a link.
    const r = await api('/forgot', { method: 'POST', body: JSON.stringify({ email: $('#forgotEmail').value.trim() }) });
    // Show the server's reply ("If that email has an account...").
    msg.className = 'msg ok'; msg.textContent = r.message;
  // Or the error.
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
  // Allow clicking again.
  btn.disabled = false;
});

// A reset link looks like /admin#reset=<token>. Keep the token, then remove it from the address bar.
// Read the token from the address (exactly 64 hex characters), or nothing.
let resetToken = (location.hash.match(/^#reset=([a-f0-9]{64})$/) || [])[1] || '';
// If there is one: clean the address bar and show the "Choose a new password" form.
if (resetToken) { history.replaceState(null, '', location.pathname); showView('reset'); }
// Saving the new password:
$('#resetForm').addEventListener('submit', async (e) => {
  // stop the page reloading,
  e.preventDefault();
  const msg = $('#resetMsg');
  // both boxes must match.
  if ($('#newPw').value !== $('#newPw2').value) { msg.className = 'msg err'; msg.textContent = "The two passwords don't match."; return; }
  // Stop double-clicks.
  $('#resetBtn').disabled = true;
  try {
    // Send the token and new password to the server.
    const r = await api('/reset', { method: 'POST', body: JSON.stringify({ token: resetToken, password: $('#newPw').value }) });
    // The token is used up.
    resetToken = '';
    // Clear both boxes.
    $('#newPw').value = $('#newPw2').value = '';
    // Back to the sign-in form,
    showView('signin');
    // with the email filled in,
    $('#user').value = r.email;
    // and a green success message.
    loginMessage('Password changed ✓ Sign in with your new password.', true);
    $('#pw').focus();
  // Error (expired link, too short...): show it.
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
  // Allow clicking again.
  $('#resetBtn').disabled = false;
});

// ---------- Continue with Google (only when GOOGLE_CLIENT_ID is set on the server) ----------
// True once Google's script has loaded and been set up.
let googleReady = false;
// Draw (or redraw) the Google button.
function renderGoogle() {
  // Not set up: nothing to draw.
  if (!googleReady) return;
  // Is the page currently dark?
  const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
  // Remove the old button.
  $('#googleBtn').replaceChildren();
  // Draw Google's button: black in dark mode, outlined in light mode, pill-shaped, fitting the card.
  google.accounts.id.renderButton($('#googleBtn'), { theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: Math.min(388, $('#googleBtn').clientWidth || 320) });
}
// Switch on Google sign-in if the server has it set up.
async function setupGoogle() {
  try {
    // Ask the server for the Google client id.
    const { googleClientId } = await fetch('/api/admin/auth-config').then((r) => r.json());
    // None: Google sign-in is off, keep it hidden.
    if (!googleClientId) return;
    // Load Google's sign-in script.
    await new Promise((ok, fail) => { const sc = document.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.onload = ok; sc.onerror = fail; document.head.append(sc); });
    // Set it up with our client id.
    google.accounts.id.initialize({
      client_id: googleClientId,
      // When the person picks their Google account:
      callback: async ({ credential }) => {
        // send Google's token to our server; if it's accepted, open the dashboard.
        try { await api('/google', { method: 'POST', body: JSON.stringify({ credential }) }); loginMessage(''); await start(); }
        // Otherwise show why (e.g. no account for that email).
        catch (err) { loginMessage(err.message); }
      },
    });
    // Ready.
    googleReady = true;
    // Show the button area,
    $('#googleWrap').classList.remove('hidden');
    // and draw the button.
    renderGoogle();
  } catch { /* Google unreachable: email sign-in still works */ }
}

// ---------- Login ----------
// The Show/Hide password button:
$('#pwToggle').addEventListener('click', () => {
  const pw = $('#pw');
  // is it hidden right now?
  const show = pw.type === 'password';
  // switch between dots and plain text,
  pw.type = show ? 'text' : 'password';
  // update the label,
  $('#pwToggle').textContent = show ? 'Hide' : 'Show';
  $('#pwToggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  // tell screen readers whether it's pressed,
  $('#pwToggle').setAttribute('aria-pressed', String(show));
  // keep the cursor in the box.
  pw.focus();
});

// Signing in with email and password:
$('#loginForm').addEventListener('submit', async (e) => {
  // stop the page reloading,
  e.preventDefault();
  const btn = $('#loginBtn');
  // stop double-clicks,
  btn.disabled = true;
  try {
    // send the details to the server (which sets the session cookie),
    await api('/login', { method: 'POST', body: JSON.stringify({ username: $('#user').value.trim(), password: $('#pw').value }) });
    // clear the password box,
    $('#pw').value = '';
    // clear any old error,
    $('#loginErr').textContent = '';
    // open the dashboard.
    await start();
  } catch (err) {
    // Wrong details or locked out: show the server's message.
    $('#loginErr').textContent = err.message;
  }
  // Allow clicking again.
  btn.disabled = false;
});

// "Try the demo":
$('#demoBtn').addEventListener('click', async () => {
  const btn = $('#demoBtn');
  // show progress,
  btn.disabled = true; btn.textContent = 'Opening the demo…';
  try {
    // sign in as the demo visitor,
    await api('/demo-login', { method: 'POST', body: '{}' });
    // forget the last business viewed,
    try { localStorage.removeItem('ma-biz'); } catch {}
    // open the dashboard.
    await start();
  // Problem: show it.
  } catch (err) { $('#loginErr').textContent = err.message; }
  // Put the button back.
  btn.disabled = false; btn.textContent = 'Try the demo';
});

// "Sign out": end the session on the server,
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch {}
  // forget the business,
  bizId = '';
  // back to the sign-in screen.
  showLogin('Signed out.');
});

// Open the dashboard (also used on page load to check for an existing session).
async function start() {
  try {
    // Ask who is signed in and the server status, at the same time.
    const [me, status] = await Promise.all([api('/me'), api('/status')]);
    // Remember both.
    ME = me; STATUS = status;
    // Show the weak-password warning if needed.
    $('#weakPw').classList.toggle('hidden', !status.weakPassword);
    // Swap the sign-in screen for the dashboard,
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    // swap the dot backgrounds,
    stopDots();
    startAppField();
    // show whether AI is on in the top bar,
    const pill = $('#aiPill');
    pill.textContent = status.ai.enabled ? 'AI assistant on' : 'Offline mode';
    pill.title = status.ai.enabled ? status.ai.model : 'No AI key: simple built-in replies';
    pill.classList.toggle('on', status.ai.enabled);
    // show or hide parts depending on the role,
    applyRole();
    // fill the campaign goal list,
    setupCampaignForm();
    // load the businesses (and everything about the selected one),
    await loadBusinesses();
    // open the tab named in the address (e.g. /admin#leads), letters only.
    const tab = location.hash.slice(1);
    if (tab) document.querySelector(`#tabs button[data-tab="${tab.replace(/[^a-z]/g, '')}"]`)?.click();
  } catch {
    // Not signed in yet: stay on the sign-in screen.
    showLogin($('#loginErr').textContent);
  }
}

// What each kind of user sees: the admin manages every business; an owner
// only theirs; the demo visitor a sample hotel that can't be renamed.
// Show or hide parts of the dashboard by role.
function applyRole() {
  // Which role is signed in?
  const admin = ME.role === 'admin', demo = ME.role === 'demo', owner = ME.role === 'owner';
  // Only the admin gets the business dropdown.
  $('#bizSelect').classList.toggle('hidden', !admin);
  // Only the demo shows the demo banner.
  $('#demoBanner').classList.toggle('hidden', !demo);
  // Only the admin manages owner logins.
  $('#loginsCard').classList.toggle('hidden', !admin);
  // Only owners change their own password here.
  $('#accountCard').classList.toggle('hidden', !owner);
  // Only the admin creates new businesses.
  $('#newBizRow').classList.toggle('hidden', !admin);
  // No CSV import in the demo.
  $('#importCard').classList.toggle('hidden', demo);
  // The demo's profile can be read but not edited.
  $('#bizFields').disabled = demo;
  // A different hint above the profile form for the demo.
  $('#setupHint').textContent = demo
    ? 'This is what the assistant knows about the sample hotel. In your own account you edit it here, and the assistant updates instantly.'
    : 'Everything the assistant knows about the business. It won\'t make up anything that isn\'t here.';
  // Owners see which email they're signed in with.
  if (owner) $('#meEmail').textContent = ME.email;
  // Good morning / afternoon / evening, by the hour,
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  // with the owner's first name when known.
  $('#hello').textContent = ME.name && owner ? `${part}, ${ME.name.split(' ')[0]}` : part;
}

// Load the list of businesses and pick which one to show.
async function loadBusinesses(selectId) {
  // The businesses this person may see.
  const list = await api('/businesses');
  // Fill the dropdown, marking the demo business.
  const sel = $('#bizSelect');
  sel.replaceChildren(...list.map((b) => { const o = el('option', b.demo ? `${b.name} (demo)` : b.name); o.value = b.id; return o; }));
  // The business last viewed on this device, if any.
  let saved = '';
  try { saved = localStorage.getItem('ma-biz') || ''; } catch {}
  // True if an id is in the list.
  const has = (id) => list.some((b) => b.id === id);
  // Pick: the one asked for, else the current one, else the saved one, else the first.
  bizId = [selectId, bizId, saved].find((id) => id && has(id)) || list[0]?.id || '';
  // Select it in the dropdown,
  sel.value = bizId;
  // show its name as the title,
  $('#bizTitle').textContent = list.find((b) => b.id === bizId)?.name || 'No business yet';
  // and load all its data.
  await refresh();
}

// Picking another business in the dropdown:
$('#bizSelect').addEventListener('change', (e) => {
  // switch to it,
  bizId = e.target.value;
  // remember it on this device,
  try { localStorage.setItem('ma-biz', bizId); } catch {}
  // show its name (without "(demo)"),
  $('#bizTitle').textContent = e.target.selectedOptions[0]?.textContent.replace(/ \(demo\)$/, '') || '';
  // load its data.
  refresh();
});

// Demo "Start over": back to 7 emails to review, 6 inquiries and every contact (for video retakes).
// The "Start over" button:
$('#demoResetBtn').addEventListener('click', async () => {
  const btn = $('#demoResetBtn');
  // stop double-clicks,
  btn.disabled = true;
  // show progress,
  $('#demoResetMsg').textContent = 'Resetting…';
  try {
    // ask the server to reset the sample hotel,
    await api('/demo/reset', { method: 'POST' });
    // reload everything,
    await refresh();
    // go back to the Inquiries tab,
    document.querySelector('#tabs button[data-tab="leads"]')?.click();
    // scroll to the top,
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // confirm.
    $('#demoResetMsg').textContent = 'Back to the start.';
  } catch (err) {
    // Problem: show it.
    $('#demoResetMsg').textContent = err.message;
  } finally {
    // Either way: allow clicking again,
    btn.disabled = false;
    // and clear the message after 4 seconds.
    setTimeout(() => { $('#demoResetMsg').textContent = ''; }, 4000);
  }
});

// Load everything for the selected business.
async function refresh() {
  // No business: nothing to load.
  if (!bizId) return;
  // Inquiries, chats, profile, contacts, campaigns and logins, all at the same time.
  await Promise.all([loadLeads(), loadConvos(), loadSetup(), loadContacts(), loadCampaigns(), loadLogins()]);
  // Show the campaign list (not an opened campaign).
  closeCampaign();
  // Update the "today" sentence and tab badges.
  paintToday();
  // This site's address.
  const origin = location.origin;
  // The one-line install code for this business.
  $('#snippet').textContent = `<script src="${origin}/widget.js" data-business="${bizId}" defer><\/script>`;
  // Link to this business's customer page.
  $('#demoLink').href = `/demo/${bizId}?from=dashboard`;
  // WhatsApp/Instagram connection status:
  const so = STATUS?.social;
  if (so) {
    // helper: a coloured label,
    const chip = (txt, cls) => el('span', txt, `chip ${cls}`);
    // show webhook, WhatsApp and Instagram status as labels.
    $('#socialStatus').replaceChildren(
      chip(so.webhookReady ? 'Webhook: ready' : 'Webhook: not set up', so.webhookReady ? 'sent' : 'skipped'),
      chip(so.whatsapp.numbers ? `WhatsApp: ${so.whatsapp.numbers} number(s)${so.whatsapp.live ? '' : ' (test mode)'}` : 'WhatsApp: not connected', so.whatsapp.numbers ? 'approved' : 'skipped'),
      chip(so.instagram.accounts ? `Instagram: ${so.instagram.accounts} account(s)${so.instagram.live ? '' : ' (test mode)'}` : 'Instagram: not connected', so.instagram.accounts ? 'approved' : 'skipped')
    );
  }
}

// One plain sentence about what needs doing today, plus counts on the tabs.
// The sentence under the business name, and the numbers on the tabs.
function paintToday() {
  // New inquiries.
  const fresh = LEADS.filter((l) => l.status === 'new').length;
  // Emails waiting for review in campaigns that are ready.
  const toReview = CAMPAIGNS.reduce((n, c) => n + (c.status === 'review' ? c.counts.review || 0 : 0), 0);
  // The parts of the sentence.
  const parts = [];
  if (fresh) parts.push(`${fresh} ${fresh === 1 ? 'person is' : 'people are'} waiting for a reply`);
  if (toReview) parts.push(`${toReview} ${toReview === 1 ? 'email is' : 'emails are'} ready for your review`);
  // Join them, or say all caught up.
  $('#todayLine').textContent = parts.length ? `${parts.join(' and ')}.` : 'All caught up. Nice work.';
  // Helper: show a number on a tab (hidden when zero).
  const setCount = (id, n) => { const c = $(id); c.textContent = n; c.classList.toggle('hidden', !n); };
  // Inquiries badge.
  setCount('#leadsCount', fresh);
  // Campaigns badge.
  setCount('#reviewCount', toReview);
}

// ---------- Tabs ----------
// Clicking a tab:
$('#tabs').addEventListener('click', (e) => {
  // which tab,
  const tab = e.target.closest('button')?.dataset.tab;
  // clicked between buttons: ignore,
  if (!tab) return;
  // highlight that tab,
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  // show its section, hide the others,
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  // inquiries and chats are refreshed so they're always current.
  if (tab === 'leads' || tab === 'chats') refresh();
});

// ---------- Leads ----------
// Helper: a table cell with a label (shown above the value on phones).
const cell = (text, label) => { const td = el('td', text); if (label) td.dataset.label = label; return td; };
// Load and show the inquiries.
async function loadLeads() {
  // Ask the server.
  const leads = await api(`/businesses/${bizId}/leads`);
  // Remember them.
  LEADS = leads;
  // Fill the four summary numbers.
  $('#sLeads').textContent = leads.length;
  $('#sNew').textContent = leads.filter((l) => l.status === 'new').length;
  $('#sBooked').textContent = leads.filter((l) => l.status === 'booked').length;
  $('#sFollow').textContent = leads.filter(isWaiting).length;
  // The table body.
  const rows = $('#leadRows');
  // None: show a helpful empty message across the whole row.
  if (!leads.length) {
    const td = el('td', 'No inquiries yet. They appear here when someone leaves their details in your website chat, WhatsApp, Instagram or a customer\'s invite link.', 'empty');
    td.colSpan = 6; const tr = el('tr'); tr.append(td); rows.replaceChildren(tr); return;
  }
  // One row per inquiry:
  rows.replaceChildren(...leads.map((l) => {
    const tr = el('tr');
    // name and where they came from,
    const who = el('td');
    who.append(el('b', l.name || '—'), el('div', SOURCE_LABEL(l), 'source'));
    // phone and/or email,
    const contact = cell(null, 'Contact');
    if (l.phone) contact.append(el('div', l.phone, 'nowrap'));
    if (l.email) contact.append(el('div', l.email, 'muted small-text'));
    if (!l.phone && !l.email) contact.textContent = '—';
    // "2 hours ago", with the full date on hover,
    const when = cell(ago(l.createdAt), 'When');
    when.title = fmt(l.createdAt);
    when.classList.add('nowrap');
    // add the first four cells,
    tr.append(who, cell(l.interest || '—', 'Interested in'), contact, when);
    // a status dropdown,
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `Status for ${l.name || 'this inquiry'}`);
    // with the four statuses,
    for (const [s, label] of [['new', 'New'], ['contacted', 'Contacted'], ['booked', 'Booked'], ['lost', 'Lost']]) { const o = el('option', label); o.value = s; sel.append(o); }
    // set to the current one,
    sel.value = l.status;
    // changing it saves straight away and refreshes the numbers.
    sel.addEventListener('change', async () => { await api(`/leads/${l.id}`, { method: 'PATCH', body: JSON.stringify({ status: sel.value }) }); await loadLeads(); paintToday(); });
    // Add it to the row.
    const td = cell(null, 'Status'); td.append(sel); tr.append(td);
    // Has this person waited too long?
    const waiting = isWaiting(l);
    // The Follow up button (highlighted with ⏰ if they've waited too long),
    const fu = el('button', waiting ? '⏰ Follow up' : 'Follow up', waiting ? 'btn small' : 'btn secondary small');
    // opens the follow-up box.
    fu.addEventListener('click', () => openFollowUp(l));
    const td2 = el('td'); td2.append(fu); tr.append(td2);
    // Hand back the row.
    return tr;
  }));
}

// Where an inquiry came from, with an emoji.
function SOURCE_LABEL(l) {
  if (l.source === 'referral') return `🎁 Invited by ${l.referredByName || 'a customer'}`;
  if (l.source === 'whatsapp') return '🟢 WhatsApp';
  if (l.source === 'instagram') return '📸 Instagram';
  if (l.source === 'booking') return '📅 Booking form';
  return '💬 Website chat';
}

// "Waiting": still marked new, never followed up, and older than the follow-up window.
// True if an inquiry needs a follow-up.
function isWaiting(l) {
  // The follow-up window from the server (default 24 hours).
  const hours = STATUS?.followUpAfterHours || 24;
  // New, never followed up, and older than the window.
  return l.status === 'new' && !l.followedUpAt && Date.now() - Date.parse(l.createdAt) > hours * 3600_000;
}

// The inquiry whose follow-up box is open.
let followLead = null;
// Open the follow-up box for an inquiry.
async function openFollowUp(l) {
  // Remember which one.
  followLead = l;
  const card = $('#followCard');
  // Show the box,
  card.classList.remove('hidden');
  // with a title naming the person,
  $('#followTitle').textContent = `Follow up with ${l.name || l.phone || l.email}`;
  // a "writing" placeholder,
  $('#followText').value = 'Writing a message…';
  $('#followSubject').value = '';
  $('#followMsg').textContent = '';
  // Email off until we know they have an email address.
  $('#followEmail').disabled = true;
  // WhatsApp hidden until we know their number works.
  $('#followWa').classList.add('hidden');
  // Scroll the box into view.
  card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  try {
    // Ask the AI for a draft.
    const d = await api(`/leads/${l.id}/follow-up/draft`, { method: 'POST', body: '{}' });
    // They opened another inquiry meanwhile: ignore this draft.
    if (followLead !== l) return;
    // Fill in the subject,
    $('#followSubject').value = d.emailSubject || '';
    // the email text (or the short message if there's no email),
    $('#followText').value = d.canEmail ? d.emailBody : d.sms;
    // enable email only if they have an address,
    $('#followEmail').disabled = !d.canEmail;
    $('#followEmail').title = d.canEmail ? '' : 'No email address for this person';
    // If their number works on WhatsApp:
    if (d.whatsappUrl) {
      const wa = $('#followWa');
      // show the WhatsApp button,
      wa.classList.remove('hidden');
      // remember the link and short message for later.
      wa.dataset.base = d.whatsappUrl.split('?')[0];
      wa.dataset.sms = d.sms;
    }
  // AI or server problem: show it.
  } catch (err) {
    $('#followText').value = '';
    $('#followMsg').className = 'msg err';
    $('#followMsg').textContent = err.message;
  }
}

// Close the follow-up box.
$('#followClose').addEventListener('click', () => { $('#followCard').classList.add('hidden'); followLead = null; });

// "Send by email":
$('#followEmail').addEventListener('click', async () => {
  // no inquiry open: nothing to do,
  if (!followLead) return;
  const msg = $('#followMsg');
  try {
    // send the edited message,
    await api(`/leads/${followLead.id}/follow-up/send`, { method: 'POST', body: JSON.stringify({ channel: 'email', subject: $('#followSubject').value, text: $('#followText').value }) });
    // confirm (saying clearly if nothing was really emailed),
    msg.className = 'msg ok';
    msg.textContent = ME.role === 'demo' ? 'Sent ✓ (demo: nobody was really emailed). Marked as contacted.' : STATUS.email.live ? 'Sent ✓ Marked as contacted.' : 'Saved in test mode ✓ (nothing was really emailed). Marked as contacted.';
    // refresh the table and badges.
    await loadLeads(); paintToday();
  // Problem: show it.
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
});

// WhatsApp: open the owner's own WhatsApp with the message typed in, then record it.
// "Send on WhatsApp" (a link that opens WhatsApp):
$('#followWa').addEventListener('click', async (e) => {
  const wa = e.currentTarget;
  // put the edited message into the WhatsApp link before it opens,
  wa.href = `${wa.dataset.base}?text=${encodeURIComponent($('#followText').value || wa.dataset.sms || '')}`;
  // no inquiry open: just open WhatsApp,
  if (!followLead) return;
  try {
    // record the follow-up on the server,
    await api(`/leads/${followLead.id}/follow-up/send`, { method: 'POST', body: JSON.stringify({ channel: 'whatsapp' }) });
    // confirm,
    $('#followMsg').className = 'msg ok';
    $('#followMsg').textContent = 'WhatsApp opened ✓ Marked as contacted.';
    // refresh.
    await loadLeads(); paintToday();
  } catch {}
});

// ---------- Conversations ----------
// Load and show the conversations.
async function loadConvos() {
  // Ask the server.
  const convos = await api(`/businesses/${bizId}/conversations`);
  // The container.
  const box = $('#convos');
  // None: an empty message.
  if (!convos.length) { box.replaceChildren(el('div', 'No conversations yet. They appear when someone chats with your assistant.', 'empty')); return; }
  // One expandable box per conversation:
  box.replaceChildren(...convos.map((c) => {
    const d = el('details', null, 'convo');
    // its summary line:
    const s = el('summary');
    // the customer's first message,
    const first = c.messages.find((m) => m.role === 'user')?.content || '';
    // the channel,
    const ch = { whatsapp: '🟢 WhatsApp', instagram: '📸 Instagram' }[c.channel] || '💬 Website';
    // first message, channel, number of messages and last time.
    s.append(el('b', first.slice(0, 80) || '(empty)'), el('span', `${ch}, ${c.messages.length} messages, ${fmt(c.updatedAt)}`));
    // Every message as a bubble.
    const lines = el('div', null, 'lines');
    for (const m of c.messages) lines.append(el('div', m.content, `line ${m.role}`));
    // Put it together.
    d.append(s, lines);
    return d;
  }));
}

// ---------- Quick message ----------
// "Write it" on the Quick message tab:
$('#draftBtn').addEventListener('click', async () => {
  const btn = $('#draftBtn');
  // show progress,
  btn.disabled = true; btn.textContent = 'Writing…';
  try {
    // ask the AI for a draft of the chosen kind,
    const d = await api(`/businesses/${bizId}/draft`, {
      method: 'POST',
      body: JSON.stringify({ kind: $('#kind').value, customerName: $('#custName').value, notes: $('#notes').value }),
    });
    // show the three texts,
    $('#dSms').textContent = d.sms; $('#dSubj').textContent = d.emailSubject; $('#dBody').textContent = d.emailBody;
    // and reveal them.
    $('#draftOut').classList.remove('hidden');
  // Problem: pop up the error.
  } catch (err) { alert(err.message); }
  // Put the button back.
  btn.disabled = false; btn.textContent = 'Write it';
});

// Any "Copy" button on the page:
document.addEventListener('click', async (e) => {
  // which element to copy,
  const id = e.target.dataset?.copy;
  // not a copy button: ignore,
  if (!id) return;
  const btn = e.target;
  // remember the button's label,
  const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
  // copy the text, show "Copied ✓" for 1.5 seconds, then the label again.
  try { await navigator.clipboard.writeText($(`#${id}`).textContent); btn.textContent = 'Copied ✓'; setTimeout(() => (btn.textContent = label), 1500); } catch {}
});

// ---------- Setup ----------
// The business profile form.
const form = $('#bizForm');
// Turn a list into text, one item per line.
const joinLines = (arr, fn) => (arr || []).map(fn).join('\n');
// Turn text into a list: one item per non-empty line.
const splitLines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean);

// Load the business profile into the form.
async function loadSetup() {
  // Ask the server.
  const b = await api(`/businesses/${bizId}`);
  // Fill the form.
  fillForm(b);
}

// Put a profile's values into the form.
function fillForm(b) {
  // Title: the business name, or "Set up a new business".
  $('#setupTitle').textContent = b.id ? b.name : 'Set up a new business';
  // Copy each simple text field.
  for (const k of ['id', 'name', 'type', 'tagline', 'phone', 'email', 'address', 'hours', 'bookingLink', 'reviewLink', 'greeting', 'tone', 'goal', 'referralOffer']) form.elements[k].value = b[k] || '';
  // The brand colour (default blue).
  form.elements.brandColor.value = b.brandColor || '#2563eb';
  // Services as "Name | Price | Duration" lines.
  form.elements.services.value = joinLines(b.services, (s) => [s.name, s.price, s.duration].filter(Boolean).join(' | '));
  // FAQs as "Question | Answer" lines.
  form.elements.faqs.value = joinLines(b.faqs, (f) => `${f.q} | ${f.a}`);
  // Offers and policies, one per line.
  form.elements.offers.value = (b.offers || []).join('\n');
  form.elements.policies.value = (b.policies || []).join('\n');
  // Clear any old message.
  $('#saveMsg').textContent = '';
}

// "Set up a new business": empty form, hide the logins card until it's saved.
$('#newBizBtn').addEventListener('click', () => { fillForm({}); $('#loginsCard').classList.add('hidden'); });

// Saving the profile:
form.addEventListener('submit', async (e) => {
  // stop the page reloading,
  e.preventDefault();
  // the form's fields,
  const f = form.elements;
  // build the profile from them:
  const body = {
    // the simple text fields,
    id: f.id.value, name: f.name.value, type: f.type.value, tagline: f.tagline.value, brandColor: f.brandColor.value,
    phone: f.phone.value, email: f.email.value, address: f.address.value, hours: f.hours.value,
    bookingLink: f.bookingLink.value, reviewLink: f.reviewLink.value, greeting: f.greeting.value, tone: f.tone.value, goal: f.goal.value, referralOffer: f.referralOffer.value,
    // each services line split at | into name, price and duration,
    services: splitLines(f.services.value).map((l) => { const [name, price, duration] = l.split('|').map((x) => x.trim()); return { name, price, duration }; }),
    // each FAQ line split at the first | into question and answer (lines without | are dropped),
    faqs: splitLines(f.faqs.value).map((l) => { const i = l.indexOf('|'); return i < 0 ? null : { q: l.slice(0, i).trim(), a: l.slice(i + 1).trim() }; }).filter(Boolean),
    // offers and policies as lists.
    offers: splitLines(f.offers.value),
    policies: splitLines(f.policies.value),
  };
  const msg = $('#saveMsg');
  try {
    // Send it to the server.
    const saved = await api('/businesses', { method: 'POST', body: JSON.stringify(body) });
    // Confirm.
    msg.className = 'msg ok'; msg.textContent = 'Saved ✓ The assistant now uses these details.';
    // The admin can now add owner logins for it.
    if (ME.role === 'admin') $('#loginsCard').classList.remove('hidden');
    // Reload the business list with this one selected.
    await loadBusinesses(saved.id);
  // Problem (e.g. missing name): show it.
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
});

// ---------- Owner logins (admin only) ----------
// Load the owner logins list (admin only).
async function loadLogins() {
  // Not the admin: nothing to do.
  if (ME?.role !== 'admin') return;
  // Ask the server (empty list if it fails).
  const list = await api(`/businesses/${bizId}/logins`).catch(() => []);
  // The container.
  const box = $('#loginList');
  // Is this the sample hotel?
  const isDemo = bizId === 'lagoon-breeze-hotel';
  // No "new login" form for the sample hotel.
  $('#newLoginForm').classList.toggle('hidden', isDemo);
  // Explain that the sample hotel uses the demo button instead.
  if (isDemo) { box.replaceChildren(el('div', 'The sample hotel has no owner login: prospects open it with "Try the demo" on the sign-in page.', 'muted')); return; }
  // No logins yet: say so.
  if (!list.length) { box.replaceChildren(el('div', 'No owner login yet. Create one below.', 'muted')); return; }
  // One row per login:
  box.replaceChildren(...list.map((u) => {
    const row = el('div', null, 'login-row');
    // name, email and when they last signed in,
    const who = el('div', null, 'who');
    who.append(el('b', u.name || u.email), el('span', `${u.email}${u.lastLoginAt ? `, last signed in ${fmt(u.lastLoginAt)}` : ', never signed in'}`, 'muted'));
    // and two buttons:
    const actions = el('div', null, 'chips');
    // Reset password:
    const reset = el('button', 'Reset password', 'btn secondary small');
    reset.addEventListener('click', async () => {
      // ask for a new one (a suggested password is pre-filled),
      const pw = prompt(`New password for ${u.email} (8+ characters):`, makePassword());
      // cancelled: stop,
      if (!pw) return;
      // save it, then offer to send it to the owner on WhatsApp,
      try { await api(`/logins/${u.id}/password`, { method: 'POST', body: JSON.stringify({ password: pw }) }); shareLogin(u.email, pw, `Password reset ✓ Send ${u.email} their new password.`); }
      // or show the problem.
      catch (err) { alert(err.message); }
    });
    // Remove:
    const remove = el('button', 'Remove', 'btn secondary small');
    remove.addEventListener('click', async () => {
      // ask to confirm first,
      if (!confirm(`Remove the login for ${u.email}? They will be signed out and can't sign in again.`)) return;
      // delete it and reload the list.
      try { await api(`/logins/${u.id}`, { method: 'DELETE' }); loadLogins(); } catch (err) { alert(err.message); }
    });
    // Put the row together.
    actions.append(reset, remove);
    row.append(who, actions);
    return row;
  }));
}

// Suggest an easy-to-type password like "mango-coral-482".
function makePassword() {
  // Words to pick from.
  const words = ['palm', 'lagoon', 'jollof', 'sunset', 'harbour', 'mango', 'breeze', 'coral', 'island', 'market'];
  // Three secure random numbers.
  const a = new Uint32Array(3); crypto.getRandomValues(a);
  // Two random words and a 3-digit number.
  return `${words[a[0] % words.length]}-${words[a[1] % words.length]}-${100 + (a[2] % 900)}`;
}
// "Suggest one" fills the password box.
$('#nlGen').addEventListener('click', () => { $('#nlPw').value = makePassword(); });

// Show a success message and a "Send login on WhatsApp" button.
function shareLogin(email, password, text) {
  // The message area.
  const msg = $('#nlMsg');
  msg.className = 'msg ok'; msg.textContent = text;
  // The business name.
  const biz = $('#bizTitle').textContent;
  // The WhatsApp message with the sign-in address, email and password.
  const wa = `Hello! Your ${biz} dashboard is ready.\n\nSign in: ${location.origin}/admin\nEmail: ${email}\nPassword: ${password}\n\nYou can change the password after signing in (Business setup).`;
  // A WhatsApp link with that message ready (the owner picks who to send it to).
  $('#nlShareWa').href = `https://wa.me/?text=${encodeURIComponent(wa)}`;
  // Show the button.
  $('#nlShare').classList.remove('hidden');
}

// Creating a new owner login:
$('#newLoginForm').addEventListener('submit', async (e) => {
  // stop the page reloading,
  e.preventDefault();
  // the email and password typed,
  const email = $('#nlEmail').value.trim(), password = $('#nlPw').value;
  try {
    // create it on the server,
    await api(`/businesses/${bizId}/logins`, { method: 'POST', body: JSON.stringify({ email, name: $('#nlName').value, password }) });
    // clear the form,
    $('#nlEmail').value = ''; $('#nlName').value = ''; $('#nlPw').value = '';
    // offer to send the login on WhatsApp,
    shareLogin(email, password, `Login created ✓ ${email} can now sign in and will only see this business.`);
    // reload the list.
    loadLogins();
  // Problem: show it and hide the WhatsApp button.
  } catch (err) { $('#nlMsg').className = 'msg err'; $('#nlMsg').textContent = err.message; $('#nlShare').classList.add('hidden'); }
});

// ---------- Owner: change own password ----------
// An owner changing their own password:
$('#pwForm').addEventListener('submit', async (e) => {
  // stop the page reloading,
  e.preventDefault();
  const msg = $('#pwMsg');
  try {
    // send the current and new password,
    await api('/me/password', { method: 'POST', body: JSON.stringify({ current: $('#pwCurrent').value, password: $('#pwNew').value }) });
    // clear both boxes,
    $('#pwCurrent').value = ''; $('#pwNew').value = '';
    // confirm.
    msg.className = 'msg ok'; msg.textContent = 'Password changed ✓ Other devices were signed out.';
  // Problem (wrong current password, too short): show it.
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
});

// ---------- Contacts ----------
// Load and show the contacts.
async function loadContacts() {
  // Ask the server.
  const contacts = await api(`/businesses/${bizId}/contacts`);
  // Show how many.
  $('#contactCount').textContent = `(${contacts.length})`;
  // The table body.
  const rows = $('#contactRows');
  // None: a helpful empty message across the whole row.
  if (!contacts.length) {
    const td = el('td', 'No contacts yet. Import a CSV below, or try the sample file.', 'empty');
    td.colSpan = 8; const tr = el('tr'); tr.append(td); rows.replaceChildren(tr); return;
  }
  // One row per contact:
  rows.replaceChildren(...contacts.map((c) => {
    const tr = el('tr');
    // can they be emailed?
    const ok = c.unsubscribed ? 'Unsubscribed' : c.consent ? 'Yes' : 'No consent';
    // Name cell also holds the delete link, so it's visible on phones.
    // their full name,
    const fullName = [c.firstName, c.lastName].filter(Boolean).join(' ');
    // the name cell,
    const nameTd = el('td');
    nameTd.append(el('b', fullName || '—'));
    // a Delete link,
    const del = el('button', 'Delete', 'link-btn');
    del.type = 'button';
    del.setAttribute('aria-label', `Delete ${fullName || c.email}`);
    // which asks to confirm, deletes the contact and refreshes the list and audience count,
    del.addEventListener('click', async () => {
      if (!confirm(`Delete ${fullName || c.email}? This cannot be undone.`)) return;
      try {
        await api(`/businesses/${bizId}/contacts/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
        await loadContacts();
        updateAudience();
      } catch (err) { alert(err.message); }
    });
    // under the name.
    nameTd.append(el('br'), del);
    // Add the other cells: email, last visit, last service, tags, can email, friends invited.
    tr.append(
      nameTd, cell(c.email, 'Email'),
      cell(c.lastVisit || '—', 'Last visit'), cell(c.lastService || '—', 'Last service'), cell((c.tags || []).join(', ') || '—', 'Tags'), cell(ok, 'Can email?'), cell(String(c.referrals || 0), 'Friends invited')
    );
    // The invite link cell:
    const linkTd = cell(null, 'Invite link');
    // if they have a code,
    if (c.referralCode) {
      // a link to their invite page,
      const a = el('a', c.referralCode);
      a.href = `/r/${c.referralCode}`;
      // opening in a new tab.
      a.target = '_blank';
      a.rel = 'noopener';
      linkTd.append(a);
    // Otherwise a dash.
    } else linkTd.textContent = '—';
    // Add it to the row.
    tr.append(linkTd);
    return tr;
  }));
}

// "Import":
$('#csvImport').addEventListener('click', async () => {
  // the chosen file,
  const file = $('#csvFile').files[0];
  const msg = $('#csvMsg');
  // no file: say so,
  if (!file) { msg.className = 'msg err'; msg.textContent = 'Choose a CSV file first.'; return; }
  try {
    // read the file and send its text to the server,
    const r = await api(`/businesses/${bizId}/contacts/import`, { method: 'POST', body: JSON.stringify({ csv: await file.text() }) });
    // show what happened (added, updated, skipped, no consent),
    msg.className = 'msg ok';
    msg.textContent = `Imported ✓ ${r.added} added, ${r.updated} updated, ${r.skipped} skipped (no valid email), ${r.noConsent} without marketing consent.`;
    // refresh the list,
    await loadContacts();
    // and the audience count.
    updateAudience();
  // Problem (no email column...): show it.
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
});

// "Delete all contacts": confirm, delete, refresh.
$('#csvClear').addEventListener('click', async () => {
  if (!confirm('Delete ALL contacts for this business? This cannot be undone.')) return;
  await api(`/businesses/${bizId}/contacts`, { method: 'DELETE' });
  loadContacts();
});

// ---------- Campaigns ----------
// The campaign currently opened (null = showing the list).
let openCampaignId = null;
// Timer for checking progress while emails are written or sent.
let pollTimer = null;

// Set up the "New email campaign" form.
function setupCampaignForm() {
  // A tip for each goal.
  const HINTS = {
    win_back: 'Brings back customers who stopped coming. Tip: choose "Haven\'t visited in 90+ days".',
    referral: 'Gets NEW customers: each happy customer gets a personal invite link (with a WhatsApp share button) to send friends. Tip: use the tag "regular".',
    review_request: 'More good reviews help new people find and trust the business online.',
    promo: 'Tell customers about an offer or news. Put the details in "Notes for the AI".',
    thank_you: 'A simple thank-you to loyal customers. Builds loyalty.',
    partnership: 'Pitch a nearby business to recommend each other. Brings new customers from their clients.',
  };
  // Show the chosen goal's tip.
  $('#cGoal').onchange = () => ($('#cGoalHint').textContent = HINTS[$('#cGoal').value] || '');
  // Fill the goal dropdown with the goals the server knows.
  $('#cGoal').replaceChildren(...Object.entries(STATUS.campaignGoals).map(([k, label]) => { const o = el('option', label); o.value = k; return o; }));
  // Show the first tip.
  $('#cGoal').onchange();
  // The email mode banner:
  const banner = $('#mailBanner');
  // demo: nothing is really sent,
  if (ME.role === 'demo') { banner.className = 'banner-note live'; banner.textContent = 'Demo: approve and "send" as much as you like. Nobody is really emailed.'; }
  // live: real inboxes,
  else if (STATUS.email.live) { banner.className = 'banner-note live'; banner.textContent = `Live sending is on (${STATUS.email.provider}). Approved emails go to real inboxes.`; }
  // test mode: saved, not sent,
  else if (STATUS.email.provider === 'log') { banner.className = 'banner-note test'; banner.textContent = 'Test mode: approved emails are saved, not sent. Nobody gets emailed until real sending is switched on.'; }
  // provider named but not set up.
  else { banner.className = 'banner-note test'; banner.textContent = `Email provider "${STATUS.email.provider}" is not configured. Add EMAIL_API_KEY and EMAIL_FROM_ADDRESS.`; }
}

// The audience filters as address parameters.
const audienceQuery = () => new URLSearchParams({ inactiveDays: $('#cInactive').value, tag: $('#cTag').value.trim() });
// Show how many people the campaign would reach.
async function updateAudience() {
  // No business: nothing to count.
  if (!bizId) return;
  // Ask the server and show "12 people will get this".
  try { const { count } = await api(`/businesses/${bizId}/audience?${audienceQuery()}`); $('#cAudience').textContent = `${count} ${count === 1 ? 'person' : 'people'} will get this`; } catch {}
}
// Recount when the filters change.
$('#cInactive').addEventListener('change', updateAudience);
$('#cTag').addEventListener('input', updateAudience);

// "Write the emails":
$('#cCreate').addEventListener('click', async () => {
  // clear old errors,
  const btn = $('#cCreate'); const msg = $('#cMsg'); msg.textContent = '';
  // stop double-clicks,
  btn.disabled = true;
  try {
    // create the campaign (the AI then writes the emails in the background),
    const c = await api(`/businesses/${bizId}/campaigns`, {
      method: 'POST',
      body: JSON.stringify({ goal: $('#cGoal').value, name: $('#cName').value, notes: $('#cNotes').value, audience: { inactiveDays: $('#cInactive').value, tag: $('#cTag').value } }),
    });
    // clear the name and notes,
    $('#cName').value = ''; $('#cNotes').value = '';
    // reload the list,
    await loadCampaigns();
    // and open the new campaign to watch progress.
    openCampaign(c.id);
  // Problem (no contacts match...): show it.
  } catch (err) { msg.textContent = err.message; }
  // Allow clicking again.
  btn.disabled = false;
});

// Friendly names for campaign statuses.
const STATUS_LABELS = { generating: 'Writing emails…', review: 'Waiting for your review', sending: 'Sending…', done: 'Done' };
// Small coloured labels like "3 to review", "2 sent".
function countChips(counts) {
  const box = el('div', null, 'chips');
  // One label per status that has emails.
  for (const [k, label] of [['review', 'to review'], ['approved', 'approved'], ['sent', 'sent'], ['skipped', 'skipped'], ['failed', 'failed']]) {
    if (counts[k]) box.append(el('span', `${counts[k]} ${label}`, `chip ${k}`));
  }
  return box;
}

// Load and show the campaign list.
async function loadCampaigns() {
  // Update the audience count.
  updateAudience();
  // Ask the server.
  const list = await api(`/businesses/${bizId}/campaigns`);
  // Remember them (for the "today" sentence).
  CAMPAIGNS = list;
  const box = $('#campaigns');
  // None: an empty message.
  if (!list.length) { box.replaceChildren(el('div', 'No campaigns yet. Import contacts, then create one below.', 'empty')); return; }
  // One clickable row per campaign:
  box.replaceChildren(...list.map((c) => {
    const row = el('div', null, 'camp');
    // reachable with the keyboard,
    row.tabIndex = 0;
    // and announced as a button.
    row.setAttribute('role', 'button');
    const left = el('div');
    // name, date and number of people,
    left.append(el('b', c.name), el('div', `${fmt(c.createdAt)}, ${c.total} ${c.total === 1 ? 'person' : 'people'}`, 'muted'));
    const right = el('div', null, 'chips');
    // status and counts,
    right.append(el('span', STATUS_LABELS[c.status] || c.status, `chip ${c.status}`), countChips(c.counts));
    row.append(left, right);
    // clicking opens it,
    row.addEventListener('click', () => openCampaign(c.id));
    // so do Enter and Space.
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCampaign(c.id); } });
    return row;
  }));
}

// Close an opened campaign and show the list again.
function closeCampaign() {
  // Forget it and stop checking progress.
  openCampaignId = null; clearTimeout(pollTimer);
  // Swap the views.
  $('#campaignDetail').classList.add('hidden'); $('#campaignList').classList.remove('hidden');
}
// "All campaigns" button: close, reload, update badges.
$('#cBack').addEventListener('click', async () => { closeCampaign(); await loadCampaigns(); paintToday(); });

// Open one campaign.
async function openCampaign(id) {
  // Remember it.
  openCampaignId = id;
  // Swap the views.
  $('#campaignList').classList.add('hidden'); $('#campaignDetail').classList.remove('hidden');
  // Clear old messages.
  $('#dMsg').textContent = '';
  // Show its emails.
  await renderCampaign(true);
}

// Show the opened campaign (full = redraw every email card).
async function renderCampaign(full) {
  // Stop any pending progress check.
  clearTimeout(pollTimer);
  // Closed meanwhile: stop.
  if (!openCampaignId) return;
  // Ask the server for it.
  const c = await api(`/campaigns/${openCampaignId}`);
  // Title with its status.
  $('#dTitle').textContent = `${c.name}: ${STATUS_LABELS[c.status] || c.status}`;
  // Its counts.
  $('#dCounts').replaceChildren(countChips(c.counts));
  // "Approve all" only when emails are waiting.
  $('#dApproveAll').disabled = !c.counts.review || c.status !== 'review';
  // "Send" only when emails are approved.
  $('#dSend').disabled = !c.counts.approved || c.status !== 'review';
  // Show any error from writing or sending.
  if (c.error) { $('#dMsg').className = 'msg err'; $('#dMsg').textContent = c.error; }

  // Still writing or sending?
  const busy = c.status === 'generating' || c.status === 'sending';
  // Re-render the email cards when needed, but don't wipe edits the owner is typing.
  if (full || busy || $('#dMessages').children.length !== c.messages.length) renderEmails(c);
  // Busy: check again in 1.5 seconds.
  if (busy) pollTimer = setTimeout(() => renderCampaign(false), 1500);
}

// Draw one card per email.
function renderEmails(c) {
  // The container.
  const box = $('#dMessages');
  // None yet: "Writing emails…".
  if (!c.messages.length) { box.replaceChildren(el('div', 'Writing emails…', 'card empty')); return; }
  // For each email:
  box.replaceChildren(...c.messages.map((m) => {
    // a card styled by its status,
    const card = el('div', null, `email ${m.status}`);
    // the "To" line with name, address and status,
    const to = el('div', null, 'to');
    to.append(el('b', m.toName || m.to), el('span', m.to, 'muted'), el('span', m.status, `chip ${m.status}`));
    // an editable subject,
    const subj = document.createElement('input'); subj.value = m.subject; subj.setAttribute('aria-label', 'Subject');
    // an editable body,
    const body = document.createElement('textarea'); body.value = m.body; body.setAttribute('aria-label', 'Email text');
    body.style.marginTop = '8px';
    // locked once sent, or while the campaign is busy,
    const locked = m.status === 'sent' || c.status !== 'review';
    subj.disabled = body.disabled = locked;
    // a row of buttons,
    const actions = el('div', null, 'row');
    // helper: a button that saves the edits with a new status,
    const act = (label, status, cls = 'btn secondary') => {
      const b = el('button', label, cls);
      b.disabled = locked;
      // on click: save, then redraw,
      b.addEventListener('click', async () => {
        try {
          await api(`/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ subject: subj.value, body: body.value, status }) });
          renderCampaign(true);
        // or show the problem.
        } catch (err) { alert(err.message); }
      });
      return b;
    };
    // Approve (unless already approved).
    if (m.status !== 'approved') actions.append(act('Approve', 'approved', 'btn'));
    // Don't send (unless already skipped).
    if (m.status !== 'skipped') actions.append(act("Don't send", 'skipped'));
    // Referral emails: a link to preview the invite page.
    if (m.referralCode) {
      const view = el('a', 'Preview invite page', 'btn secondary');
      view.href = `/r/${m.referralCode}?preview=1`; // same tab; the page shows a "Back to dashboard" button
      actions.append(view);
    }
    // Save edits without changing the status.
    actions.append(act('Save edits', undefined));
    // Put the card together,
    card.append(to, subj, body, actions);
    // with any send error underneath.
    if (m.error) card.append(el('div', m.error, 'err'));
    return card;
  }));
}

// "Approve all remaining": approve, then redraw.
$('#dApproveAll').addEventListener('click', async () => {
  await api(`/campaigns/${openCampaignId}/approve-all`, { method: 'POST' });
  renderCampaign(true);
});

// "Send approved emails":
$('#dSend').addEventListener('click', async () => {
  // really sending? (live email and not the demo)
  const live = STATUS.email.live && ME.role !== 'demo';
  // real sends ask to confirm first.
  if (live && !confirm('Send all approved emails to real inboxes now?')) return;
  const msg = $('#dMsg');
  try {
    // start sending,
    const r = await api(`/campaigns/${openCampaignId}/send`, { method: 'POST' });
    // show how many are going out (and whether the daily limit cut it short),
    msg.className = 'msg ok';
    msg.textContent = `${live ? 'Sending' : ME.role === 'demo' ? 'Sending (demo)' : 'Test-sending'} ${r.queued} emails…${r.limitedBy ? ` (daily limit of ${r.limitedBy} reached; the rest can go tomorrow)` : ''}`;
    // redraw (progress is checked automatically).
    renderCampaign(true);
  // Problem: show it.
  } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
});

// Start the chat preview animation.
playChat();
// Switch on Google sign-in if set up.
setupGoogle();
// Start the sign-in dots.
startDots();
if (!resetToken) start(); // if the session cookie is still valid, go straight to the dashboard

// Register the service worker so phones offer "Add to Home Screen" / "Install app".
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
