// Starts the animated dot background on the small server-made pages (privacy, terms, invites...).
// It lives in its own file so the Content-Security-Policy can block inline scripts.
(function () {
  // The canvas the dots are drawn on.
  const canvas = document.getElementById('field');
  // No canvas, or motion.js didn't load: nothing to do.
  if (!canvas || !window.MotionField) return;
  // Default colours, used if the page didn't give any (or gave broken ones).
  let colors = ['#6d5efc', '#12b5a5', '#f4b13e', '#ff6b3d'];
  // Read the colours the server put in the canvas's data-colors attribute.
  try {
    // Turn the text back into a list.
    const given = JSON.parse(canvas.dataset.colors || '[]');
    // Use it only if it's a non-empty list of #rrggbb colours.
    if (Array.isArray(given) && given.length && given.every((c) => /^#[0-9a-fA-F]{6}$/.test(c))) colors = given;
  } catch {}
  // Start the animation with the same settings the pages used before.
  window.MotionField.start(canvas, { density: 5200, colors });
})();
