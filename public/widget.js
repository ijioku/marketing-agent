/*
  Embeddable chat widget. A client adds ONE line to their website:
  <script src="https://YOUR-SERVER/widget.js" data-business="their-business-id" defer></script>
*/
(function () {
  const script = document.currentScript;
  if (!script) return;
  const businessId = script.dataset.business;
  const server = new URL(script.src).origin;
  if (!businessId) return console.warn('[marketing-agent] missing data-business attribute');

  // Stable anonymous visitor id so the conversation continues across page loads.
  let sessionId;
  const storeKey = `ma-session-${businessId}`;
  try {
    sessionId = localStorage.getItem(storeKey);
  } catch {}
  if (!sessionId) {
    sessionId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^\w-]/g, '');
    try {
      localStorage.setItem(storeKey, sessionId);
    } catch {}
  }

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:max(12px, env(safe-area-inset-right));bottom:max(12px, env(safe-area-inset-bottom));z-index:2147483000;';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' }); // keeps our styles separate from the client's site

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
      .bubble { width: 60px; height: 60px; border-radius: 50%; border: 0; cursor: pointer; color: #fff;
        background: var(--brand); box-shadow: 0 8px 24px rgba(0,0,0,.3), 0 0 0 2px rgba(255,255,255,.9); display: grid; place-items: center; margin-left: auto; }
      .bubble svg { width: 28px; height: 28px; }
      .panel { display: none; flex-direction: column; width: min(370px, calc(100vw - 40px)); height: min(540px, calc(100vh - 110px));
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
      input { flex: 1; border: 1px solid #d1d5db; border-radius: 999px; padding: 10px 14px; font-size: 14px; outline: none; min-width: 0; }
      input:focus { border-color: var(--brand); }
      form button { border: 0; border-radius: 999px; padding: 0 16px; background: var(--brand); color: #fff; font-weight: 600; cursor: pointer; }
      form button:disabled { opacity: .5; cursor: default; }
      .foot { font-size: 11px; color: #9ca3af; text-align: center; padding: 0 0 8px; background: #fff; }
      @media (max-width: 480px) {
        .panel { width: calc(100vw - 24px); height: calc(100dvh - 96px); border-radius: 14px; }
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

  const $ = (sel) => root.querySelector(sel);
  const panel = $('.panel');
  const msgs = $('.msgs');
  const form = $('form');
  const input = $('input');
  const sendBtn = $('form button');
  let profile = null;
  let greeted = false;

  // Render text safely, turning http(s) links into clickable links.
  function addMessage(text, who) {
    const el = document.createElement('div');
    el.className = `msg ${who}`;
    const parts = String(text).split(/(https?:\/\/[^\s)]+)/g);
    for (const part of parts) {
      if (/^https?:\/\//.test(part)) {
        const a = document.createElement('a');
        a.href = part;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = part.replace(/[.,!?]+$/, '');
        el.appendChild(a);
      } else {
        el.appendChild(document.createTextNode(part));
      }
    }
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  fetch(`${server}/api/public/business/${encodeURIComponent(businessId)}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((p) => {
      profile = p;
      host.style.setProperty('--brand', p.brandColor || '#2563eb');
      $('.name').textContent = p.name;
    })
    .catch(() => host.style.setProperty('--brand', '#2563eb'));
  host.style.setProperty('--brand', '#2563eb');

  function open() {
    panel.classList.add('open');
    if (!greeted) {
      greeted = true;
      addMessage(profile?.greeting || 'Hi! 👋 How can I help you today?', 'bot');
    }
    input.focus();
  }

  $('.bubble').addEventListener('click', () => (panel.classList.contains('open') ? panel.classList.remove('open') : open()));
  $('.close').addEventListener('click', () => panel.classList.remove('open'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMessage(text, 'me');
    sendBtn.disabled = true;
    const typing = addMessage('typing…', 'bot typing');
    try {
      const res = await fetch(`${server}/api/public/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId, sessionId, message: text }),
      });
      const data = await res.json();
      typing.remove();
      addMessage(data.reply || 'Sorry, something went wrong. Please try again.', 'bot');
    } catch {
      typing.remove();
      addMessage("Sorry, I couldn't connect. Please try again in a moment.", 'bot');
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  });
})();
