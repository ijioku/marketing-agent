/*
  Embeddable chat widget. A client adds ONE line to their website:
  <script src="https://YOUR-SERVER/widget.js" data-business="their-business-id" defer></script>
*/
// Everything is wrapped in a function so our variables never clash with the client's site.
(function () {
  // The <script> tag that loaded this file.
  const script = document.currentScript;
  // Can't find it (very old browser): do nothing.
  if (!script) return;
  // The business id from data-business="...".
  const businessId = script.dataset.business;
  // Our server's address, taken from where this script was loaded.
  const server = new URL(script.src).origin;
  // No business id: warn the site owner in the console and stop.
  if (!businessId) return console.warn('[marketing-agent] missing data-business attribute');

  // Stable anonymous visitor id so the conversation continues across page loads.
  // Will hold this visitor's id.
  let sessionId;
  // Where it's kept in the browser (one per business).
  const storeKey = `ma-session-${businessId}`;
  try {
    // Read it if this visitor has chatted before.
    sessionId = localStorage.getItem(storeKey);
  // Storage blocked (private mode): carry on without it.
  } catch {}
  // No id yet:
  if (!sessionId) {
    // make a random one (with a fallback for old browsers), letters, digits and dashes only.
    sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^\w-]/g, '');
    try {
      // save it for next time.
      localStorage.setItem(storeKey, sessionId);
    } catch {}
  }

  // A box that holds the chat, fixed to the bottom-right corner.
  const host = document.createElement('div');
  // Bottom-right, clear of phone notches, above everything else on the page.
  // A website can lift the chat higher (for example above its own floating button or a bottom bar)
  // by setting the CSS variable --ma-offset-bottom, such as "--ma-offset-bottom: 72px".
  host.style.cssText = 'position:fixed;right:max(12px, env(safe-area-inset-right));bottom:calc(max(12px, env(safe-area-inset-bottom)) + var(--ma-offset-bottom, 0px));transition:bottom .3s ease;z-index:2147483000;';
  // Add it to the page.
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' }); // keeps our styles separate from the client's site

  // The chat's look and layout: styles, the chat panel (header, messages, input) and the round button.
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel, form, input { color-scheme: light; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
      .bubble { width: 60px; height: 60px; border-radius: 50%; border: 0; cursor: pointer; color: #fff;
        background: var(--brand); box-shadow: 0 8px 24px rgba(0,0,0,.3), 0 0 0 2px rgba(255,255,255,.9); display: grid; place-items: center; margin-left: auto; }
      .bubble svg { width: 28px; height: 28px; }
      .panel { display: none; flex-direction: column; width: min(370px, calc(100vw - 40px)); height: min(540px, calc(100vh - 110px - var(--ma-offset-bottom, 0px)));
        background: #fff; color: #111; border-radius: 16px; overflow: hidden; box-shadow: 0 16px 48px rgba(0,0,0,.28); margin-bottom: 12px; }
      .panel.open { display: flex; }
      .head { background: var(--brand); color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 10px; }
      .head .dot { width: 9px; height: 9px; border-radius: 50%; background: #4ade80; flex: none; }
      .head .name { font-weight: 650; font-size: 15px; }
      .head .sub { font-size: 12px; opacity: .85; }
      .head button { margin-left: auto; background: none; border: 0; color: #fff; font-size: 22px; cursor: pointer; line-height: 1; }
      .msgs { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px; background: #f6f7f9; }
      .msg { max-width: 82%; padding: 9px 12px; border-radius: 14px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; }
      .bot { background: #fff; border: 1px solid #e5e7eb; align-self: flex-start; border-bottom-left-radius: 4px; }
      .me { background: var(--brand); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
      .me a { color: #fff; }
      .bot a { color: var(--brand); font-weight: 600; }
      .typing { color: #6b7280; font-style: italic; }
      form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e5e7eb; background: #fff; }
      input { flex: 1; background: #fff; color: #111; border: 1px solid #d1d5db; border-radius: 999px; padding: 10px 14px; font-size: 14px; outline: none; min-width: 0; }
      input:focus { border-color: var(--brand); }
      form button { border: 0; border-radius: 999px; padding: 0 16px; background: var(--brand); color: #fff; font-weight: 600; cursor: pointer; }
      form button:disabled { opacity: .5; cursor: default; }
      .foot { font-size: 11px; color: #9ca3af; text-align: center; padding: 0 0 8px; background: #fff; }
      @media (max-width: 480px) {
        .panel { width: calc(100vw - 24px); height: calc(100dvh - 96px - var(--ma-offset-bottom, 0px)); border-radius: 14px; }
        input { font-size: 16px; } /* prevents iPhone auto-zoom on focus */
        .msg { max-width: 88%; font-size: 15px; }
        .bubble { width: 56px; height: 56px; }
      }
    </style>
    <div class="panel" role="dialog" aria-label="Chat">
      <div class="head">
        <span class="dot"></span>
        <div><div class="name">Chat with us</div><div class="sub">AI assistant · replies instantly</div></div>
        <button type="button" class="close" aria-label="Close chat">×</button>
      </div>
      <div class="msgs" aria-live="polite"></div>
      <form>
        <input name="m" autocomplete="off" placeholder="Type your message…" maxlength="1000" aria-label="Message" />
        <button type="submit">Send</button>
      </form>
      <div class="foot">AI assistant · may make mistakes</div>
    </div>
    <button class="bubble" type="button" aria-label="Open chat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    </button>`;

  // Shortcut: find an element inside the chat.
  const $ = (sel) => root.querySelector(sel);
  // The chat panel.
  const panel = $('.panel');
  // The message list.
  const msgs = $('.msgs');
  // The message form.
  const form = $('form');
  // The text box.
  const input = $('input');
  // The Send button.
  const sendBtn = $('form button');
  // The business profile, once loaded.
  let profile = null;
  // Has the greeting been shown yet?
  let greeted = false;

  // Render text safely, turning http(s) links into clickable links.
  // Add a message bubble ("me" = visitor, "bot" = assistant).
  function addMessage(text, who) {
    // A new bubble.
    const el = document.createElement('div');
    // Style it as visitor or assistant.
    el.className = `msg ${who}`;
    // Split the text around web links.
    const parts = String(text).split(/(https?:\/\/[^\s)]+)/g);
    // For each piece:
    for (const part of parts) {
      // a link:
      if (/^https?:\/\//.test(part)) {
        // make a real link,
        const a = document.createElement('a');
        // to that address,
        a.href = part;
        // opening in a new tab,
        a.target = '_blank';
        // safely (the new tab can't control this page),
        a.rel = 'noopener noreferrer';
        // showing the address without trailing punctuation.
        a.textContent = part.replace(/[.,!?]+$/, '');
        // Add it.
        el.appendChild(a);
      // Plain text:
      } else {
        // add it as text (never as HTML, so nothing harmful can run).
        el.appendChild(document.createTextNode(part));
      }
    }
    // Add the bubble to the list,
    msgs.appendChild(el);
    // scroll to the bottom,
    msgs.scrollTop = msgs.scrollHeight;
    // and hand it back (so "typing…" can be removed later).
    return el;
  }

  // Load the business profile:
  fetch(`${server}/api/public/business/${encodeURIComponent(businessId)}`)
    // stop if the server says no,
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    // then:
    .then((p) => {
      // remember it,
      profile = p;
      // use the brand colour,
      host.style.setProperty('--brand', p.brandColor || '#2563eb');
      // show the business name in the header.
      $('.name').textContent = p.name;
    })
    // Failed: keep the default blue.
    .catch(() => host.style.setProperty('--brand', '#2563eb'));
  // Default blue until the profile arrives.
  host.style.setProperty('--brand', '#2563eb');

  // Open the chat.
  function open() {
    // Show the panel.
    panel.classList.add('open');
    // First time:
    if (!greeted) {
      // remember the greeting was shown,
      greeted = true;
      // show the business greeting.
      addMessage(profile?.greeting || 'Hi! 👋 How can I help you today?', 'bot');
    }
    // Put the cursor in the text box.
    input.focus();
  }

  // The round button opens or closes the chat.
  $('.bubble').addEventListener('click', () => (panel.classList.contains('open') ? panel.classList.remove('open') : open()));
  // The × closes it.
  $('.close').addEventListener('click', () => panel.classList.remove('open'));
  // The website can open the chat from its own buttons ("Ask a question"):
  //   window.dispatchEvent(new Event('marketing-agent:open'))
  // Listen for that event.
  window.addEventListener('marketing-agent:open', open);

  // The visitor pressed Send:
  form.addEventListener('submit', async (e) => {
    // stop the page reloading.
    e.preventDefault();
    // The typed text.
    const text = input.value.trim();
    // Empty: do nothing.
    if (!text) return;
    // Clear the box.
    input.value = '';
    // Show their message.
    addMessage(text, 'me');
    // Stop double-sending.
    sendBtn.disabled = true;
    // Show "typing…" while waiting.
    const typing = addMessage('typing…', 'bot typing');
    try {
      // Send the message to our server.
      const res = await fetch(`${server}/api/public/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId, sessionId, message: text }),
      });
      // Read the answer.
      const data = await res.json();
      // Remove "typing…".
      typing.remove();
      // Show the reply.
      addMessage(data.reply || 'Sorry, something went wrong. Please try again.', 'bot');
    // Network failure:
    } catch {
      // remove "typing…",
      typing.remove();
      // and say so.
      addMessage("Sorry, I couldn't connect. Please try again in a moment.", 'bot');
    // Either way:
    } finally {
      // allow sending again,
      sendBtn.disabled = false;
      // put the cursor back.
      input.focus();
    }
  });
})();
