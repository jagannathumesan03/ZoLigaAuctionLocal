// ---------- Sale celebration (confetti + banner) ----------
// Fired whenever a player is confirmed sold to a team, on both the admin and
// viewer dashboards. Self-contained: builds its own canvas/DOM nodes and
// tears them down when the animation finishes, so it never leaks state into
// the rest of the page. Exposes a single global: celebrateSale(player).

(function () {
  const CONFETTI_COLORS = ['#26d77d', '#4cb7ff', '#ffb31a', '#ff5c67', '#ffffff'];
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fireConfetti(durationMs = 2600) {
    if (reduceMotion()) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const particleCount = Math.min(160, Math.round(window.innerWidth / 6));
    const particles = Array.from({ length: particleCount }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.4,
      size: 6 + Math.random() * 6,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      speedY: 2.4 + Math.random() * 3.2,
      speedX: (Math.random() - 0.5) * 2.4,
      rotation: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.3,
      shape: Math.random() < 0.5 ? 'rect' : 'circle',
    }));

    const start = performance.now();

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);

    function tick(now) {
      const elapsed = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const fadeStart = durationMs - 500;
      const opacity = elapsed > fadeStart ? Math.max(0, 1 - (elapsed - fadeStart) / 500) : 1;

      particles.forEach(p => {
        p.x += p.speedX;
        p.y += p.speedY;
        p.rotation += p.spin;
        if (p.y > canvas.height + 30) {
          p.y = -20;
          p.x = Math.random() * canvas.width;
        }
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        if (p.shape === 'rect') {
          ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      });

      if (elapsed < durationMs) {
        requestAnimationFrame(tick);
      } else {
        window.removeEventListener('resize', resize);
        canvas.remove();
      }
    }
    requestAnimationFrame(tick);
  }

  function fmtMoney(v) {
    if (v === null || v === undefined) return '-';
    return '₹' + Number(v).toLocaleString('en-IN');
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function placeholderImg() {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100%" height="100%" fill="#1a232d"/><text x="50%" y="50%" fill="#3a4a5c" font-size="14" text-anchor="middle" dy=".3em">No Photo</text></svg>`
    );
  }


  function starValue(player) {
    const n = parseFloat(player && player.stars);
    if (!Number.isFinite(n)) return 3;
    return Math.max(2, Math.min(5, Math.round(n * 2) / 2));
  }

  function ratingLabel(player) {
    return starValue(player).toFixed(1).replace(/\.0$/, '');
  }

  function starsHtml(player, extraClass = '') {
    const value = starValue(player);
    const stars = [];
    for (let i = 1; i <= 5; i += 1) {
      if (value >= i) {
        stars.push('<span class="star-glyph is-full">★</span>');
      } else if (value >= i - 0.5) {
        stars.push('<span class="star-glyph is-half"><span class="star-right">★</span><span class="star-left">★</span></span>');
      } else {
        stars.push('<span class="star-glyph is-empty">★</span>');
      }
    }
    return `<div class="star-rating${extraClass}" aria-label="${value} of 5 stars">${stars.join('')}</div>`;
  }

  function ratingBadgeHtml(player, extraClass = '') {
    return `<div class="rating-badge card-${player.card_tier || 'bronze'}${extraClass}" aria-label="Player value ${starValue(player)} of 5">${ratingLabel(player)}</div>`;
  }
  let dismissTimer = null;

  window.celebrateSale = function celebrateSale(player) {
    if (!player) return;
    fireConfetti();

    let overlay = document.getElementById('saleCelebration');
    if (overlay) {
      overlay.remove();
      if (dismissTimer) clearTimeout(dismissTimer);
    }

    overlay = document.createElement('div');
    overlay.id = 'saleCelebration';
    overlay.className = 'sale-celebration';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    const tierClass = 'card-' + (player.card_tier || 'bronze');
    overlay.innerHTML = `
      <div class="sale-celebration-card fifa-card ${tierClass}">
        <span class="sale-celebration-tag">Sold!</span>
        ${ratingBadgeHtml(player, ' rating-badge-lg')}
        ${starsHtml(player, ' star-rating-lg')}
        <img class="sale-celebration-photo" src="${player.photo_url || placeholderImg()}" alt="${escapeHtml(player.name || 'Player')}" onerror="this.src='${placeholderImg()}'">
        <h2>${escapeHtml(player.name || 'Player')}</h2>
        <div class="sale-celebration-team">${player.team_name ? `to <b>${escapeHtml(player.team_name)}</b>` : ''}</div>
        <div class="sale-celebration-price">${fmtMoney(player.sold_price)}</div>
      </div>`;
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add('is-visible'));

    dismissTimer = setTimeout(() => {
      overlay.classList.remove('is-visible');
      overlay.classList.add('is-leaving');
      setTimeout(() => overlay.remove(), 400);
    }, 3400);
  };
})();
