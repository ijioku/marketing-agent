// Interactive background: drifting dots that move out of the way of the mouse (or a finger),
// light up and link together around it, and drift at different speeds when the page scrolls.
// Used by the sign-in page and the customer page. Respects "reduce motion" and pauses
// when the tab is hidden, so it doesn't drain phone batteries.
//
//   MotionField.start(canvas, { colors: ['#4c8df6', ...], parallax: true, density: 4200, spot: 0.16 })
//   density: screen area per dot (bigger = fewer dots). spot: brightness of the light that follows the pointer.
// Wrapped in a function so the variables stay private.
(function () {
  // True if the visitor's device asks for less motion.
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const RADIUS = 170; // how far around the pointer dots react (px)

  // Start the effect on a <canvas> element.
  function start(canvas, opts = {}) {
    // No canvas: do nothing (and give back a harmless stop function).
    if (!canvas || !canvas.getContext) return { stop() {} };
    // The drawing tool for the canvas.
    const ctx = canvas.getContext('2d');
    // Read a colour variable from the page's CSS.
    const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    // The dot colours: given ones, or the page's blue.
    const colors = () => (typeof opts.colors === 'function' ? opts.colors() : opts.colors) || [css('--blue', '#4c8df6')];
    // Where the pointer is (far off-screen until it moves).
    const pointer = { x: -9999, y: -9999, on: false };
    // Canvas size, the dots, the animation frame id and whether it was stopped.
    let w = 0, h = 0, dots = [], raf = 0, stopped = false;
    const spot = { x: -9999, y: -9999, a: 0 }; // soft light that trails the pointer

    // Fit the canvas to its size on screen and scatter new dots.
    function resize() {
      // Screen sharpness (capped at 2 to save battery).
      const dpr = Math.min(devicePixelRatio || 1, 2);
      // The canvas size in CSS pixels.
      w = canvas.clientWidth; h = canvas.clientHeight;
      // Real pixels = CSS pixels x sharpness.
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      // Draw in CSS pixels.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // How many dots: screen area / density, between 40 and 260.
      const n = Math.round(Math.min(260, Math.max(40, (w * h) / (opts.density || 4200))));
      // Make the dots:
      dots = Array.from({ length: n }, () => ({
        // random position,
        x: Math.random() * w, y: Math.random() * h,
        // random size,
        r: Math.random() * 1.4 + 0.5,
        // slow upward drift with a little sideways wander,
        vy: -(Math.random() * 0.22 + 0.05), vx: (Math.random() - 0.5) * 0.08,
        depth: Math.random() * 0.45 + 0.08, // far dots move less when scrolling: depth
        // push offset and glow start at zero.
        ox: 0, oy: 0, glow: 0,
      }));
      // With reduced motion, draw one still picture.
      if (reduce) draw();
    }

    // Canvas coordinates of the pointer, whether it's a mouse or a finger.
    // Move the pointer to a screen position.
    function setPointer(clientX, clientY) {
      // Where the canvas is on screen.
      const rect = canvas.getBoundingClientRect();
      // Convert to canvas coordinates.
      pointer.x = clientX - rect.left; pointer.y = clientY - rect.top;
      // It counts only while over (or just around) the canvas.
      pointer.on = pointer.x >= -40 && pointer.y >= -40 && pointer.x <= w + 40 && pointer.y <= h + 40;
    }
    // Mouse moved.
    const onMove = (e) => setPointer(e.clientX, e.clientY);
    // Finger moved: use the first finger.
    const onTouch = (e) => { const t = e.touches[0]; if (t) setPointer(t.clientX, t.clientY); };
    // Pointer left: stop reacting.
    const onLeave = () => { pointer.on = false; };

    // Pick the colour for a dot from its angle around the pointer, so the glow is a ring of colours.
    // Colour for a dot.
    function colorAt(dx, dy) {
      // The colours.
      const list = colors();
      // The angle around the pointer as 0 to 1.
      const a = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);
      // Pick the colour for that slice of the circle.
      return list[Math.floor(a * list.length) % list.length];
    }

    // Draw one frame.
    function draw() {
      // Stopped: do nothing.
      if (stopped) return;
      // Clear the canvas.
      ctx.clearRect(0, 0, w, h);
      // The normal dot colour from the page's theme.
      const base = css('--dot', 'rgba(127,127,127,.3)');
      // How far the page has scrolled (only if parallax is on).
      const scroll = opts.parallax ? window.scrollY : 0;
      // Lit dots near the pointer, for the connecting lines.
      const near = [];

      // A soft light that glides after the pointer (eased, so it trails slightly behind).
      // Only when motion is allowed:
      if (!reduce) {
        // while the pointer is over the canvas:
        if (pointer.on) {
          // first appearance: jump straight to it,
          if (spot.a === 0) { spot.x = pointer.x; spot.y = pointer.y; }
          // then move 12% of the way each frame (smooth trailing).
          spot.x += (pointer.x - spot.x) * 0.12; spot.y += (pointer.y - spot.y) * 0.12;
        }
        // Fade the light in or out.
        spot.a += ((pointer.on ? 1 : 0) - spot.a) * 0.06;
        // Snap tiny values to zero.
        if (spot.a < 0.01) spot.a = 0;
        // If the light is visible:
        if (spot.a > 0) {
          // a circular gradient 280px wide,
          const g = ctx.createRadialGradient(spot.x, spot.y, 0, spot.x, spot.y, 280);
          // the first colour in the middle,
          g.addColorStop(0, colors()[0]);
          // fading to transparent,
          g.addColorStop(1, 'rgba(0,0,0,0)');
          // at the chosen brightness,
          ctx.globalAlpha = (opts.spot ?? 0.16) * spot.a;
          ctx.fillStyle = g;
          // painted around the light's position.
          ctx.fillRect(spot.x - 280, spot.y - 280, 560, 560);
          // Back to full opacity.
          ctx.globalAlpha = 1;
        }
      }

      // For each dot:
      for (const d of dots) {
        // if motion is allowed:
        if (!reduce) {
          // drift,
          d.x += d.vx; d.y += d.vy;
          // off the top: come back at the bottom in a new spot,
          if (d.y < -10) { d.y = h + 10; d.x = Math.random() * w; }
          // off one side: come back on the other.
          if (d.x < -10) d.x = w + 10; else if (d.x > w + 10) d.x = -10;
        }
        // Scrolling moves each dot by its own depth, wrapping around the screen.
        // Scroll-shifted height, wrapped around the screen.
        let sy = (d.y - scroll * d.depth) % (h + 20);
        // Keep it on screen.
        if (sy < -10) sy += h + 20;
        // Its horizontal position.
        let sx = d.x;

        // Push away from the pointer, then spring back.
        // Distance from the pointer.
        const dx = sx + d.ox - pointer.x, dy = sy + d.oy - pointer.y;
        const dist = Math.hypot(dx, dy);
        // Close to the pointer:
        if (pointer.on && !reduce && dist < RADIUS && dist > 0.1) {
          // stronger push the closer it is,
          const f = (1 - dist / RADIUS) ** 2 * 3.2;
          // push it away,
          d.ox += (dx / dist) * f; d.oy += (dy / dist) * f;
          // and light it up.
          d.glow = Math.min(1, d.glow + 0.12);
        // Otherwise:
        } else {
          // fade its glow.
          d.glow = Math.max(0, d.glow - 0.03);
        }
        // Spring back towards its home.
        d.ox *= 0.93; d.oy *= 0.93;
        // Apply the push.
        sx += d.ox; sy += d.oy;

        // A lit dot:
        if (d.glow > 0.02) {
          // brighter the more it glows,
          ctx.globalAlpha = 0.35 + d.glow * 0.65;
          // coloured by its angle around the pointer,
          ctx.fillStyle = colorAt(sx - pointer.x, sy - pointer.y);
          // drawn a little bigger,
          ctx.beginPath(); ctx.arc(sx, sy, d.r + d.glow * 1.6, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
          // remember it for the lines.
          if (dist < RADIUS * 1.1) near.push({ x: sx, y: sy, g: d.glow, c: ctx.fillStyle });
        // A normal dot:
        } else {
          // in the theme colour,
          ctx.fillStyle = base;
          // at its normal size.
          ctx.beginPath(); ctx.arc(sx, sy, d.r, 0, Math.PI * 2); ctx.fill();
        }
      }

      // Thin lines between lit-up dots: a small constellation that follows the pointer.
      // 1-pixel lines.
      ctx.lineWidth = 1;
      // Each pair of lit dots (max 40 dots):
      for (let i = 0; i < near.length && i < 40; i++) {
        for (let j = i + 1; j < near.length && j < 40; j++) {
          const a = near[i], b = near[j];
          // their distance,
          const dd = Math.hypot(a.x - b.x, a.y - b.y);
          // too far apart: no line,
          if (dd > 95) continue;
          // closer and brighter = more visible line,
          ctx.globalAlpha = (1 - dd / 95) * Math.min(a.g, b.g) * 0.55;
          // in the first dot's colour,
          ctx.strokeStyle = a.c;
          // draw it.
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      // Reset opacity.
      ctx.globalAlpha = 1;
      // Ask the browser to draw the next frame.
      if (!reduce) raf = requestAnimationFrame(draw);
    }

    // When the tab is hidden or shown again:
    const onVisibility = () => {
      // stop drawing,
      cancelAnimationFrame(raf);
      // restart only if visible, allowed and not stopped.
      if (!document.hidden && !reduce && !stopped) raf = requestAnimationFrame(draw);
    };

    // Size the canvas now...
    resize();
    // ...and again whenever its size changes.
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    // With motion allowed:
    if (!reduce) {
      // follow the mouse,
      addEventListener('pointermove', onMove, { passive: true });
      // follow fingers,
      addEventListener('touchmove', onTouch, { passive: true });
      addEventListener('touchstart', onTouch, { passive: true });
      // stop reacting when the pointer leaves,
      document.addEventListener('pointerleave', onLeave);
      // or the finger lifts,
      addEventListener('touchend', onLeave);
      // pause when the tab is hidden,
      document.addEventListener('visibilitychange', onVisibility);
      // start animating.
      raf = requestAnimationFrame(draw);
    }
    // Reduced motion with parallax: redraw the still picture when scrolling.
    if (reduce && opts.parallax) addEventListener('scroll', () => draw(), { passive: true });

    // Give back a stop() function that undoes everything.
    return {
      stop() {
        stopped = true;
        cancelAnimationFrame(raf);
        ro.disconnect();
        removeEventListener('pointermove', onMove);
        removeEventListener('touchmove', onTouch);
        removeEventListener('touchstart', onTouch);
        document.removeEventListener('pointerleave', onLeave);
        removeEventListener('touchend', onLeave);
        document.removeEventListener('visibilitychange', onVisibility);
      },
    };
  }

  // Tilts an element a few degrees toward the mouse (mouse only; never on touch or reduced motion).
  // Tilt an element towards the mouse by up to `max` degrees.
  function tilt(elm, max = 4) {
    // Only with a real mouse and motion allowed.
    if (!elm || reduce || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    // The pending frame.
    let raf = 0;
    // When the mouse moves:
    addEventListener('pointermove', (e) => {
      // cancel the last pending update,
      cancelAnimationFrame(raf);
      // on the next frame:
      raf = requestAnimationFrame(() => {
        // where the element is,
        const r = elm.getBoundingClientRect();
        // horizontal mouse position from -1 to 1 relative to the element's centre,
        const px = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (innerWidth / 2)));
        // vertical position, the same,
        const py = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (innerHeight / 2)));
        // tilt it in 3D.
        elm.style.transform = `perspective(1000px) rotateX(${(-py * max).toFixed(2)}deg) rotateY(${(px * max).toFixed(2)}deg)`;
      });
    }, { passive: true });
    // Mouse leaves the page: straighten it.
    document.addEventListener('pointerleave', () => (elm.style.transform = ''));
  }

  // Make start, tilt and reduce available to the pages.
  window.MotionField = { start, tilt, reduce };
})();
