// Applies the saved theme (System / Dark / Light) before the page draws, so it never flashes the wrong colours.
// Loaded in the <head> of every page. It lives in its own file so the Content-Security-Policy can block inline scripts.
// Theme follows the device (light/dark) unless the user picks one with the switch.
(function () {
  // Default: follow the device.
  let theme = 'system';
  // Use the saved choice if there is one (storage may be blocked in private mode).
  try { theme = localStorage.getItem('ma-theme') || 'system'; } catch {}
  // Mark the page; the colour rules below react to this.
  document.documentElement.dataset.theme = theme;
})();
