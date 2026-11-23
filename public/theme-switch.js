// Makes the System / Dark / Light buttons work on the small server-made pages (privacy, terms...).
// It lives in its own file so the Content-Security-Policy can block inline scripts.
(function () {
  // The page's root element, where the chosen theme is stored.
  const root = document.documentElement;
  // The three theme buttons.
  const buttons = document.querySelectorAll('.sw button');
  // Switch to theme `t`.
  function setTheme(t) {
    // Mark the page so the colour rules react.
    root.dataset.theme = t;
    // Remember the choice (storage can be blocked in private mode).
    try { localStorage.setItem('ma-theme', t); } catch {}
    // Show which button is pressed.
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === t)));
  }
  // Each button switches to its own theme when clicked.
  buttons.forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.t)));
  // Start with the saved theme (or follow the device).
  setTheme(root.dataset.theme || 'system');
})();
