// Interactive background: drifting dots that move out of the way of the mouse (or a finger),
// light up and link together around it, and drift at different speeds when the page scrolls.
// Used by the sign-in page and the customer page. Respects "reduce motion" and pauses
// when the tab is hidden, so it doesn't drain phone batteries.
//
//   MotionField.start(canvas, { colors: ['#4c8df6', ...], parallax: true })
(function () {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const RADIUS = 170; // how far around the pointer dots react (px)

  function start(canvas, opts = {}) {
    if (!canvas || !canvas.getContext) return { stop() {} };
    const ctx = canvas.getContext('2d');
    const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    const colors = () => (typeof opts.colors === 'function' ? opts.colors() : opts.colors) || [css('--blue', '#4c8df6')];
    const pointer = { x: -9999, y: -9999, on: false };
    let w = 0, h = 0, dots = [], raf = 0, stopped = false;
    const spot = { x: -9999, y: -9999, a: 0 }; // soft light that trails the pointer

    function resize() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(260, Math.max(60, (w * h) / 4200)));
      dots = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        r: Math.random() * 1.4 + 0.5,
        vy: -(Math.random() * 0.22 + 0.05), vx: (Math.random() - 0.5) * 0.08,
        depth: Math.random() * 0.45 + 0.08, // far dots move less when scrolling: depth
        ox: 0, oy: 0, glow: 0,
      }));
      if (reduce) draw();
    }

    // Canvas coordinates of the pointer, whether it's a mouse or a finger.
    function setPointer(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = clientX - rect.left; pointer.y = clientY - rect.top;
      pointer.on = pointer.x >= -40 && pointer.y >= -40 && pointer.x <= w + 40 && pointer.y <= h + 40;
    }
    const onMove = (e) => setPointer(e.clientX, e.clientY);
    const onTouch = (e) => { const t = e.touches[0]; if (t) setPointer(t.clientX, t.clientY); };
    const onLeave = () => { pointer.on = false; };

    // Pick the colour for a dot from its angle around the pointer, so the glow is a ring of colours.
    function colorAt(dx, dy) {
      const list = colors();
      const a = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);
      return list[Math.floor(a * list.length) % list.length];
    }

    function draw() {
      if (stopped) return;
      ctx.clearRect(0, 0, w, h);
      const base = css('--dot', 'rgba(127,127,127,.3)');
      const scroll = opts.parallax ? window.scrollY : 0;
      const near = [];

      // A soft light that glides after the pointer (eased, so it trails slightly behind).
      if (!reduce) {
        if (pointer.on) {
          if (spot.a === 0) { spot.x = pointer.x; spot.y = pointer.y; }
          spot.x += (pointer.x - spot.x) * 0.12; spot.y += (pointer.y - spot.y) * 0.12;
        }
        spot.a += ((pointer.on ? 1 : 0) - spot.a) * 0.06;
        if (spot.a < 0.01) spot.a = 0;
        if (spot.a > 0) {
          const g = ctx.createRadialGradient(spot.x, spot.y, 0, spot.x, spot.y, 280);
          g.addColorStop(0, colors()[0]);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalAlpha = 0.16 * spot.a;
          ctx.fillStyle = g;
          ctx.fillRect(spot.x - 280, spot.y - 280, 560, 560);
          ctx.globalAlpha = 1;
        }
      }

      for (const d of dots) {
        if (!reduce) {
          d.x += d.vx; d.y += d.vy;
          if (d.y < -10) { d.y = h + 10; d.x = Math.random() * w; }
          if (d.x < -10) d.x = w + 10; else if (d.x > w + 10) d.x = -10;
        }
        // Scrolling moves each dot by its own depth, wrapping around the screen.
        let sy = (d.y - scroll * d.depth) % (h + 20);
        if (sy < -10) sy += h + 20;
        let sx = d.x;

        // Push away from the pointer, then spring back.
        const dx = sx + d.ox - pointer.x, dy = sy + d.oy - pointer.y;
        const dist = Math.hypot(dx, dy);
        if (pointer.on && !reduce && dist < RADIUS && dist > 0.1) {
          const f = (1 - dist / RADIUS) ** 2 * 3.2;
          d.ox += (dx / dist) * f; d.oy += (dy / dist) * f;
          d.glow = Math.min(1, d.glow + 0.12);
        } else {
          d.glow = Math.max(0, d.glow - 0.03);
        }
        d.ox *= 0.93; d.oy *= 0.93;
        sx += d.ox; sy += d.oy;

        if (d.glow > 0.02) {
          ctx.globalAlpha = 0.35 + d.glow * 0.65;
          ctx.fillStyle = colorAt(sx - pointer.x, sy - pointer.y);
          ctx.beginPath(); ctx.arc(sx, sy, d.r + d.glow * 1.6, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
          if (dist < RADIUS * 1.1) near.push({ x: sx, y: sy, g: d.glow, c: ctx.fillStyle });
        } else {
          ctx.fillStyle = base;
          ctx.beginPath(); ctx.arc(sx, sy, d.r, 0, Math.PI * 2); ctx.fill();
        }
      }

      // Thin lines between lit-up dots: a small constellation that follows the pointer.
      ctx.lineWidth = 1;
      for (let i = 0; i < near.length && i < 40; i++) {
        for (let j = i + 1; j < near.length && j < 40; j++) {
          const a = near[i], b = near[j];
          const dd = Math.hypot(a.x - b.x, a.y - b.y);
          if (dd > 95) continue;
          ctx.globalAlpha = (1 - dd / 95) * Math.min(a.g, b.g) * 0.55;
          ctx.strokeStyle = a.c;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(draw);
    }

    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduce && !stopped) raf = requestAnimationFrame(draw);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    if (!reduce) {
      addEventListener('pointermove', onMove, { passive: true });
      addEventListener('touchmove', onTouch, { passive: true });
      addEventListener('touchstart', onTouch, { passive: true });
      document.addEventListener('pointerleave', onLeave);
      addEventListener('touchend', onLeave);
      document.addEventListener('visibilitychange', onVisibility);
      raf = requestAnimationFrame(draw);
    }
    if (reduce && opts.parallax) addEventListener('scroll', () => draw(), { passive: true });

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
  function tilt(elm, max = 4) {
    if (!elm || reduce || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    let raf = 0;
    addEventListener('pointermove', (e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = elm.getBoundingClientRect();
        const px = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (innerWidth / 2)));
        const py = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (innerHeight / 2)));
        elm.style.transform = `perspective(1000px) rotateX(${(-py * max).toFixed(2)}deg) rotateY(${(px * max).toFixed(2)}deg)`;
      });
    }, { passive: true });
    document.addEventListener('pointerleave', () => (elm.style.transform = ''));
  }

  window.MotionField = { start, tilt, reduce };
})();
