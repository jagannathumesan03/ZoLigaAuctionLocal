// ---------- Slot-machine player reveal (horizontal) ----------
// Plays on viewer and admin when a new player is put up for auction: a
// horizontal reel spins through candidate cards and lands on the selected
// player. Keep TOTAL_MS in sync with backend PACK_REVEAL_SECONDS (5s).
// Exposes window.playPackReveal(player, { onDone, candidates }).

(function () {
  const TOTAL_MS = 5000;
  const SPIN_MS = 3200;
  const ITEM_W = 148;
  const REDUCE = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fmtMoney(v) {
    if (v === null || v === undefined) return '-';
    return '₹' + Number(v).toLocaleString('en-IN') + ' Cr';
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function placeholderImg() {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100%" height="100%" fill="#1a232d"/><text x="50%" y="50%" fill="#3a4a5c" font-size="14" text-anchor="middle" dy=".3em">No Photo</text></svg>`
    );
  }

  function shuffle(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }


  function starValue(player) {
    const n = parseFloat(player && player.stars);
    if (!Number.isFinite(n)) return 3;
    return Math.max(2, Math.min(5, Math.round(n * 2) / 2));
  }

  function ratingLabel(player) {
    return starValue(player).toFixed(1).replace(/\.0$/, '');
  }
  function buildReel(winner, candidates) {
    const pool = shuffle(
      (candidates || []).filter(p => p && p.id !== winner.id)
    );
    const fillers = [];
    const need = 18;
    if (pool.length) {
      while (fillers.length < need) {
        fillers.push(...shuffle(pool));
      }
      fillers.length = need;
    } else {
      for (let i = 0; i < need; i += 1) fillers.push(winner);
    }
    const stopIndex = fillers.length;
    return { items: [...fillers, winner, ...fillers.slice(0, 3)], stopIndex };
  }

  function tileHtml(player, isWinner) {
    const tier = player.card_tier || 'bronze';
    const photo = player.photo_url || placeholderImg();
    return `
      <div class="slot-tile card-${escapeHtml(tier)}${isWinner ? ' is-winner' : ''}" data-player-id="${player.id}">
        <div class="slot-tile-ovr">${ratingLabel(player)}</div>
        <img class="slot-tile-photo" src="${photo}" alt="" onerror="this.src='${placeholderImg()}'">
        <div class="slot-tile-name">${escapeHtml(player.name || 'Player')}</div>
        <div class="slot-tile-role">${escapeHtml(player.role || 'Player')}</div>
        ${isWinner ? `<div class="slot-tile-price">${fmtMoney(player.base_price)}</div>` : ''}
      </div>`;
  }

  let active = null;

  function clearActive() {
    if (!active) return;
    active.timers.forEach(clearTimeout);
    if (active.overlay && active.overlay.parentNode) active.overlay.remove();
    document.body.classList.remove('pack-reveal-open');
    active = null;
  }

  window.playPackReveal = function playPackReveal(player, opts = {}) {
    if (!player) {
      if (opts.onDone) opts.onDone();
      return;
    }

    clearActive();

    if (REDUCE()) {
      if (opts.onDone) opts.onDone();
      return;
    }

    const { items, stopIndex } = buildReel(player, opts.candidates || []);
    const offset = stopIndex * ITEM_W;

    const overlay = document.createElement('div');
    overlay.id = 'packReveal';
    overlay.className = 'pack-reveal slot-reveal';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = `
      <div class="pack-reveal-stage slot-stage">
        <div class="pack-reveal-label">Spinning the draft…</div>
        <div class="slot-machine">
          <div class="slot-window">
            <div class="slot-pointer" aria-hidden="true"></div>
            <div class="slot-fade slot-fade-left" aria-hidden="true"></div>
            <div class="slot-fade slot-fade-right" aria-hidden="true"></div>
            <div class="slot-reel" style="transform: translate3d(0,0,0)">
              ${items.map((p, i) => tileHtml(p, i === stopIndex)).join('')}
            </div>
          </div>
        </div>
        <div class="pack-reveal-caption">New player up for auction</div>
      </div>`;

    document.body.appendChild(overlay);
    document.body.classList.add('pack-reveal-open');

    const reel = overlay.querySelector('.slot-reel');
    const timers = [];
    const schedule = (fn, ms) => timers.push(setTimeout(fn, ms));
    active = { overlay, timers, onDone: opts.onDone };

    requestAnimationFrame(() => {
      overlay.classList.add('is-visible');
      requestAnimationFrame(() => {
        overlay.classList.add('is-spinning');
        reel.style.transition = `transform ${SPIN_MS}ms cubic-bezier(0.08, 0.75, 0.12, 1)`;
        reel.style.transform = `translate3d(${-offset}px, 0, 0)`;
      });
    });

    schedule(() => {
      overlay.classList.remove('is-spinning');
      overlay.classList.add('is-landed');
      const winnerTile = reel.querySelector('.slot-tile.is-winner');
      if (winnerTile) winnerTile.classList.add('is-locked');
    }, SPIN_MS + 40);

    schedule(() => {
      overlay.classList.add('is-hold');
    }, SPIN_MS + 200);

    schedule(() => {
      overlay.classList.add('is-leaving');
      overlay.classList.remove('is-visible');
    }, TOTAL_MS - 450);

    schedule(() => {
      const done = active && active.onDone;
      clearActive();
      if (done) done();
    }, TOTAL_MS);
  };
})();
