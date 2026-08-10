let state = {
  players: [], teams: [], currentAuction: null,
  // Broadcast-only UI state -- never persisted, purely for the "what's happening
  // right now" presentation layer (see renderSpotlight / the ticker):
  recentResult: null,   // { type: 'sold' | 'unsold', player, expiresAt }
  callState: null,      // { call: 'going_once' | 'going_twice', playerId, expiresAt }
  lastSpotlightBid: null,
  lastBidId: null,
  waitingBackgroundUrl: '',
};

// Tracks the player currently shown as "up for auction" so we can fire the
// FIFA pack-reveal animation only when a *new* player is selected (not on
// first page load, and not on bid/timer refreshes for the same player).
let lastAuctionPlayerId = null;
let auctionBaselineReady = false;

// ---------- Auth guard (admins may also view this page) ----------
(async function guard() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error();
    await res.json();
    init();
  } catch (e) {
    window.location.href = '/login';
  }
})();

function logout() {
  fetch('/api/auth/logout', { method: 'POST' }).then(() => window.location.href = '/login');
}

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Request failed');
  return res.json();
}

async function init() {
  await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction(), loadSettings()]);
  lastAuctionPlayerId = state.currentAuction ? state.currentAuction.id : null;
  auctionBaselineReady = true;
  renderAll();
  connectSSE();
  document.getElementById('playerSearch').addEventListener('input', renderPlayersList);
  document.getElementById('playerStatusFilter').addEventListener('change', renderPlayersList);
  setInterval(refreshRelativeTimes, 5000);
  setInterval(tickAuctionTimer, 250);
}

async function loadPlayers() { state.players = await apiFetch('/api/players'); }
async function loadTeams() { state.teams = await apiFetch('/api/teams'); }
async function loadCurrentAuction() { state.currentAuction = await apiFetch('/api/auction/current'); }
async function loadSettings() {
  try {
    const data = await apiFetch('/api/settings');
    state.waitingBackgroundUrl = data.waiting_background_url || '';
  } catch (e) {
    state.waitingBackgroundUrl = '';
  }
}

function waitingSpotlightStyle() {
  const url = state.waitingBackgroundUrl;
  if (!url) return '';
  return ` style="--waiting-bg-image: url('${String(url).replace(/'/g, "\\'")}')"`;
}

function renderAll() {
  renderSpotlight();
  renderAuctionStatusStrip();
  renderTeamsList();
  renderTeamViewList();
  renderPlayersList();
  renderTicker();
}

// ---------- Live updates ----------
// knownPlayerStatus diffs player status across refreshes (rather than trusting
// any single SSE payload shape) so a sale/unsold result is detected and
// announced reliably regardless of which event triggered the reload -- the
// same robustness pattern the confetti celebration already relied on.
let knownPlayerStatus = null;

function connectSSE() {
  const es = new EventSource('/api/events');
  const refresh = async () => {
    state.callState = null;
    const previousAuctionId = lastAuctionPlayerId;
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    detectAndAnnounceResults();
    const nextAuctionId = state.currentAuction ? state.currentAuction.id : null;
    const shouldReveal = auctionBaselineReady
      && nextAuctionId
      && nextAuctionId !== previousAuctionId
      && typeof window.playPackReveal === 'function';
    lastAuctionPlayerId = nextAuctionId;
    renderAll();
    if (shouldReveal) {
      window.playPackReveal(state.currentAuction, {
        candidates: state.players,
        onDone: () => renderSpotlight(),
      });
    }
  };
  es.addEventListener('current_player', refresh);
  es.addEventListener('bid_updated', refresh);
  es.addEventListener('player_sold', refresh);
  es.addEventListener('player_unsold', refresh);
  es.addEventListener('player_reset', refresh);
  es.addEventListener('team_updated', refresh);
  es.addEventListener('timer_paused', refresh);
  es.addEventListener('timer_resumed', refresh);
  es.addEventListener('auction_call', (e) => {
    try { setCallState(JSON.parse(e.data)); } catch (err) { /* ignore malformed payload */ }
  });
  es.addEventListener('settings_updated', (e) => {
    try {
      const data = JSON.parse(e.data);
      state.waitingBackgroundUrl = data.waiting_background_url || '';
      renderSpotlight();
    } catch (err) { /* ignore */ }
  });
  es.onopen = () => setConnectionStatus(true);
  es.onerror = () => setConnectionStatus(false);

  // Seed the baseline so already-resolved players (from before this page
  // loaded) don't trigger a celebration/result banner -- only fresh ones should.
  knownPlayerStatus = new Map(state.players.map(p => [p.id, p.status]));
}

function detectAndAnnounceResults() {
  if (!knownPlayerStatus) return;
  const nextStatus = new Map();
  state.players.forEach(p => {
    nextStatus.set(p.id, p.status);
    const prev = knownPlayerStatus.get(p.id);
    if (prev !== undefined && prev !== p.status) {
      if (p.status === 'sold') {
        window.celebrateSale && window.celebrateSale(p);
        setRecentResult('sold', p);
      } else if (p.status === 'unsold' && prev === 'auction') {
        setRecentResult('unsold', p);
      }
    }
  });
  knownPlayerStatus = nextStatus;
}

// ---------- Ephemeral "what just happened" / "what's being called" state ----------
function setRecentResult(type, player) {
  state.recentResult = { type, player, expiresAt: Date.now() + 4000 };
  renderSpotlight();
  renderTicker();
  setTimeout(() => {
    if (state.recentResult && state.recentResult.expiresAt <= Date.now()) {
      state.recentResult = null;
      renderSpotlight();
      renderTicker();
    }
  }, 4100);
}

function activeRecentResult() {
  if (!state.recentResult) return null;
  if (state.recentResult.expiresAt <= Date.now()) { state.recentResult = null; return null; }
  return state.recentResult;
}

function setCallState(data) {
  state.callState = { call: data.call, playerId: data.player_id, expiresAt: Date.now() + 4000 };
  renderSpotlight();
  renderTicker();
  setTimeout(() => {
    if (state.callState && state.callState.expiresAt <= Date.now()) {
      state.callState = null;
      renderSpotlight();
      renderTicker();
    }
  }, 4100);
}

function activeCallState() {
  if (!state.callState) return null;
  if (state.callState.expiresAt <= Date.now()) { state.callState = null; return null; }
  return state.callState;
}

function callBannerHtml(call) {
  const isTwice = call.call === 'going_twice';
  return `<div class="call-banner ${isTwice ? 'is-twice' : 'is-once'}">${isTwice ? 'Going twice' : 'Going once'}</div>`;
}

function remainingMs(endsAt) {
  if (!endsAt) return null;
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return null;
  return end - Date.now();
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function auctionClockMs(player) {
  if (!player) return null;
  if (player.auction_timer_paused) {
    const remaining = player.auction_remaining_seconds;
    if (remaining === null || remaining === undefined) return null;
    return Math.max(0, Number(remaining) * 1000);
  }
  if (!player.auction_ends_at) return null;
  const end = Date.parse(player.auction_ends_at);
  if (Number.isNaN(end)) return null;
  // Freeze the displayed auction time until the pack-reveal window ends.
  let effectiveNow = Date.now();
  if (player.auction_reveal_until) {
    const revealUntil = Date.parse(player.auction_reveal_until);
    if (!Number.isNaN(revealUntil) && effectiveNow < revealUntil) {
      effectiveNow = revealUntil;
    }
  }
  return end - effectiveNow;
}

function isAuctionRevealing(player) {
  if (!player || player.auction_timer_paused || !player.auction_reveal_until) return false;
  const revealUntil = Date.parse(player.auction_reveal_until);
  return !Number.isNaN(revealUntil) && Date.now() < revealUntil;
}

function auctionTimerHtml(player) {
  if (!player) return '';
  const paused = !!player.auction_timer_paused;
  const hasClock = paused || !!player.auction_ends_at;
  if (!hasClock) return '';
  const revealing = isAuctionRevealing(player);
  const ms = auctionClockMs(player);
  if (ms === null) return '';
  const urgent = !paused && !revealing && ms <= 15000;
  let attrs = '';
  if (paused) {
    attrs = ` data-paused="1" data-remaining-ms="${Math.round(ms)}"`;
  } else {
    attrs = ` data-ends-at="${escapeHtml(player.auction_ends_at || '')}"`;
    if (player.auction_reveal_until) {
      attrs += ` data-reveal-until="${escapeHtml(player.auction_reveal_until)}"`;
    }
  }
  const label = paused ? 'Paused' : (revealing ? 'Get ready' : 'Time left');
  return `
    <div class="auction-timer${urgent ? ' is-urgent' : ''}${paused ? ' is-paused' : ''}${revealing ? ' is-revealing' : ''}"${attrs} aria-live="polite">
      <span class="auction-timer-label">${label}</span>
      <span class="auction-timer-value">${formatCountdown(ms)}</span>
    </div>`;
}

function renderAuctionTimerDock() {
  const mount = document.getElementById('auctionTimerDock');
  if (!mount) return;
  mount.innerHTML = auctionTimerHtml(state.currentAuction);
}

function tickAuctionTimer() {
  document.querySelectorAll('.auction-timer').forEach(el => {
    if (el.getAttribute('data-paused') === '1') return;
    const endsAt = el.getAttribute('data-ends-at');
    if (!endsAt) return;
    const revealUntil = el.getAttribute('data-reveal-until');
    let effectiveNow = Date.now();
    let revealing = false;
    if (revealUntil) {
      const revealMs = Date.parse(revealUntil);
      if (!Number.isNaN(revealMs) && effectiveNow < revealMs) {
        effectiveNow = revealMs;
        revealing = true;
      }
    }
    const end = Date.parse(endsAt);
    if (Number.isNaN(end)) return;
    const ms = end - effectiveNow;
    const value = el.querySelector('.auction-timer-value');
    const label = el.querySelector('.auction-timer-label');
    if (value) value.textContent = formatCountdown(ms);
    if (label) label.textContent = revealing ? 'Get ready' : 'Time left';
    el.classList.toggle('is-revealing', revealing);
    el.classList.toggle('is-urgent', !revealing && ms <= 15000);
  });
}

function resultStateHtml(result) {
  const p = result.player;
  if (result.type === 'sold') {
    return `
      <div class="spotlight result-state is-sold fifa-card ${cardTierClass(p.card_tier)}">
        <span class="result-tag is-sold">Sold</span>
        <img class="spotlight-player-photo" src="${p.photo_url || placeholderImg()}" alt="${escapeHtml(p.name || 'Player')}">
        <div class="info">
          <h2>${escapeHtml(p.name || 'Player')}</h2>
          <div class="result-price">${fmtMoney(p.sold_price)}</div>
          <div class="result-team">to <b>${escapeHtml(p.team_name || 'Unknown team')}</b></div>
        </div>
      </div>`;
  }
  return `
    <div class="spotlight result-state is-unsold">
      <span class="result-tag is-unsold">Unsold</span>
      <img class="spotlight-player-photo" src="${p.photo_url || placeholderImg()}" alt="${escapeHtml(p.name || 'Player')}">
      <div class="info">
        <h2>${escapeHtml(p.name || 'Player')}</h2>
        <div class="result-team muted">Returned to the player pool</div>
      </div>
    </div>`;
}

// ---------- Hero: current player + current bid ----------
// Photo + player info on the left; live bid activity fills the empty right
// side of the spotlight card.
function spotlightBidPanelHtml() {
  return `
    <aside class="spotlight-bid-panel bid-activity-card dashboard-card" aria-labelledby="bidActivityTitle">
      <div class="dashboard-heading"><h2 id="bidActivityTitle">Latest bid</h2><span class="activity-caption">Live</span></div>
      <div id="bidActivity" class="bid-activity"></div>
      <div class="bid-history-heading"><h3>Bid history</h3></div>
      <div id="bidHistory" class="bid-history-log"></div>
    </aside>`;
}

function fillSpotlightBidPanels() {
  renderBidActivity();
  renderBidHistory();
}

function renderSpotlight() {
  const container = document.getElementById('spotlight');
  const current = state.currentAuction;

  if (!current) {
    const result = activeRecentResult();
    const hasBg = !!state.waitingBackgroundUrl;
    container.innerHTML = result
      ? resultStateHtml(result)
      : `
        <div class="spotlight spotlight-waiting${hasBg ? ' has-waiting-bg' : ''}"${waitingSpotlightStyle()}>
          <div class="empty-state">
            <p class="eyebrow">Auction desk</p>
            <h2>Waiting for the next player…</h2>
          </div>
        </div>`;
    renderAuctionTimerDock();
    return;
  }

  const bidAmount = current.current_bid_amount || current.base_price;
  const hasBids = !!current.current_bid_team_id;
  const leadingTeam = state.teams.find(team => team.id === current.current_bid_team_id);
  const call = activeCallState();
  const isNewBid = state.lastSpotlightBid !== null && state.lastSpotlightBid !== bidAmount;

  container.innerHTML = `
    <div class="spotlight fifa-card has-bid-panel ${cardTierClass(current.card_tier)}">
      ${call ? callBannerHtml(call) : ''}
      ${ovrBadgeHtml(current)}
      <img class="spotlight-player-photo" src="${current.photo_url || placeholderImg()}" alt="${escapeHtml(current.name)}">
      <div class="info">
        <p class="eyebrow auction-state-label${hasBids ? ' is-bidding' : ''}">${hasBids ? 'Bidding' : 'Now auctioning'}</p>
        <h2>${escapeHtml(current.name)}</h2>
        <span class="badge position-badge">${escapeHtml(current.role || 'Player')}</span>
        <div class="muted spotlight-base-price">Base price ${fmtMoney(current.base_price)}</div>
        <div class="current-bid-block">
          <span class="eyebrow">Current bid</span>
          <div class="bid-amount-display${isNewBid ? ' bid-pulse' : ''}" aria-live="polite">${fmtMoney(bidAmount)}</div>
        </div>
        <div class="leading-team-row${hasBids ? ' has-leader' : ''}">
          ${hasBids
            ? `<img class="mini-team-logo" src="${leadingTeam && leadingTeam.logo_url ? leadingTeam.logo_url : placeholderImg()}" alt="">
               <span class="leading-team-name">${escapeHtml(current.current_bid_team_name || 'Unknown team')}</span>
               <span class="leading-chip">Leading</span>`
            : `<span class="muted">No bids yet — starting at base price</span>`}
        </div>
        ${statBarsHtml(current)}
      </div>
      ${spotlightBidPanelHtml()}
    </div>`;
  state.lastSpotlightBid = bidAmount;
  fillSpotlightBidPanels();
  renderAuctionTimerDock();
}

// ---------- Latest bid activity ----------
function renderBidActivity() {
  const el = document.getElementById('bidActivity');
  if (!el) return;
  const current = state.currentAuction;
  if (!current) {
    el.innerHTML = `<div class="bid-activity-empty">No active bidding yet.</div>`;
    state.lastBidId = null;
    return;
  }
  const history = current.history || [];
  const bidAmount = current.current_bid_amount || current.base_price;
  if (!history.length) {
    el.innerHTML = `
      <div class="bid-activity-amount">${fmtMoney(bidAmount)}</div>
      <div class="bid-activity-meta">
        <span>Current opening bid</span>
      </div>`;
    state.lastBidId = null;
    return;
  }
  const latest = history[history.length - 1];
  const previousAmount = history.length > 1 ? history[history.length - 2].amount : current.base_price;
  const increment = latest.amount - previousAmount;
  const isNew = state.lastBidId !== null && state.lastBidId !== latest.id;
  el.innerHTML = `
    <div class="bid-activity-amount${isNew ? ' bid-pulse' : ''}">${fmtMoney(latest.amount)}</div>
    <div class="bid-activity-team">
      <img src="${bidTeamLogo(latest.team_id)}" alt="">
      <span>${escapeHtml(latest.team_name || 'Unknown team')}</span>
    </div>
    <div class="bid-activity-meta">
      <span class="bid-activity-increment">+${fmtMoney(increment)}</span>
      <span class="bid-activity-time" data-ts="${latest.created_at || ''}">${relativeTime(latest.created_at) || 'Just now'}</span>
    </div>`;
  state.lastBidId = latest.id;
}

// ---------- Bid history (newest on top; older bids scroll below) ----------
function renderBidHistory() {
  const historyContainer = document.getElementById('bidHistory');
  if (!historyContainer) return;
  const current = state.currentAuction;
  if (!current) {
    historyContainer.innerHTML = `<div class="bid-history-empty">No active bidding yet.</div>`;
    return;
  }
  const history = current.history || [];
  // Newest first so the current bid stays at the top of the scrollable log.
  const historyItems = [...history].reverse().map((h, index) => `
    <div class="bid-history-item${index === 0 ? ' is-current' : ''}">
      <span class="bid-history-team">
        <img src="${bidTeamLogo(h.team_id)}" alt="">
        ${escapeHtml(h.team_name || 'Unknown team')}
      </span>
      <span class="player-price">${fmtMoney(h.amount)}</span>
      <span class="bid-history-time" data-ts="${h.created_at || ''}">${relativeTime(h.created_at)}</span>
    </div>`).join('');
  const startingBidItem = `
    <div class="bid-history-item bid-history-start${!history.length ? ' is-current' : ''}">
      <span class="bid-history-team">Starting bid</span>
      <span class="player-price">${fmtMoney(current.base_price)}</span>
      <span class="bid-history-time"></span>
    </div>`;
  historyContainer.innerHTML = historyItems + startingBidItem;
  requestAnimationFrame(() => {
    historyContainer.scrollTop = 0;
  });
}

// Re-stamp only the relative-time labels on a slow interval, without
// rebuilding any of the surrounding markup (so nothing re-triggers its
// entry animation just because a minute ticked over).
function refreshRelativeTimes() {
  document.querySelectorAll('[data-ts]').forEach(el => {
    const ts = el.getAttribute('data-ts');
    if (ts) el.textContent = relativeTime(ts);
  });
}

// ---------- Auction status (compact strip -- must never compete with the hero) ----------
function renderAuctionStatusStrip() {
  const soldPlayers = state.players.filter(player => player.status === 'sold');
  const waitingPlayers = state.players.filter(player => player.status === 'waiting');
  const totalSpent = state.teams.reduce((sum, team) => sum + (team.purse_total - team.purse_remaining), 0);
  const activeTeams = state.teams.filter(team => team.squad.length > 0).length;
  document.getElementById('auctionOverview').innerHTML = `
    <div class="status-chip"><strong>${soldPlayers.length}</strong><span>Sold</span></div>
    <div class="status-chip"><strong>${waitingPlayers.length}</strong><span>Remaining</span></div>
    <div class="status-chip"><strong>${activeTeams}</strong><span>Active teams</span></div>
    <div class="status-chip is-highlight"><strong>${fmtMoney(totalSpent)}</strong><span>Total spent</span></div>
  `;
}

// ---------- Team purses (compact live-sports tiles, not an admin table) ----------
function renderTeamsList() {
  const container = document.getElementById('teamsList');
  if (!state.teams.length) { container.innerHTML = `<div class="empty">No teams yet.</div>`; return; }
  const leadingTeamId = state.currentAuction ? state.currentAuction.current_bid_team_id : null;
  container.innerHTML = state.teams.map(t => {
    const pct = t.purse_total ? Math.round((t.purse_remaining / t.purse_total) * 100) : 0;
    const isLeading = leadingTeamId === t.id;
    return `
      <div class="team-tile${isLeading ? ' is-leading' : ''}">
        <img class="team-logo" src="${t.logo_url || placeholderImg()}" alt="">
        <div class="team-tile-main">
          <div class="team-tile-top">
            <span class="team-tile-name">${escapeHtml(t.name)}</span>
            ${isLeading ? '<span class="leading-chip leading-chip-sm">Leading</span>' : ''}
          </div>
          <div class="team-tile-purse-row">
            <span class="team-tile-purse">${fmtMoney(t.purse_remaining)}</span>
            <span class="team-tile-slots">${t.squad.length}/${t.slots_max}</span>
          </div>
          <div class="purse-bar" aria-hidden="true"><div class="purse-bar-fill" style="width:${pct}%"></div></div>
        </div>
      </div>`;
  }).join('');
}

function renderTeamViewList() {
  const container = document.getElementById('teamViewList');
  if (!state.teams.length) {
    container.innerHTML = `<div class="empty">No teams yet.</div>`;
    return;
  }

  container.innerHTML = state.teams.map(team => {
    const squad = Array.isArray(team.squad) ? team.squad : [];
    const percentageRemaining = team.purse_total
      ? Math.round((team.purse_remaining / team.purse_total) * 100)
      : 0;
    const purseHue = Math.round(Math.max(0, Math.min(percentageRemaining, 100)) * 1.35);
    const purseColor = `hsl(${purseHue} 78% 52%)`;
    const selectedPlayers = squad.map(player => `
      <div class="team-view-player">
        <img class="team-view-player-photo" src="${player.photo_url || placeholderImg()}" alt="${escapeHtml(player.name)}">
        <b>${escapeHtml(player.name)}</b>
        ${player.overall !== undefined ? `<span class="ovr-chip ${cardTierClass(player.card_tier)}">${player.overall}</span>` : ''}
        <span class="team-view-player-position">${roleAbbreviation(player.role)}</span>
        <strong>${fmtMoney(player.sold_price)}</strong>
      </div>`).join('');
    const emptySlots = Math.max(team.slots_max - squad.length, 0);
    const emptySlotMarkup = Array.from({ length: emptySlots }, () =>
      `<div class="team-view-empty-slot">Open player slot</div>`
    ).join('');

    return `
      <article class="team-view-card">
        <header class="team-view-header">
          <img src="${team.logo_url || placeholderImg()}" alt="${escapeHtml(team.name)} logo">
          <div><h3>${escapeHtml(team.name)}</h3><span>${squad.length}/${team.slots_max} player slots filled</span></div>
        </header>
        <div class="team-view-purse">
          <div class="team-purse-chart" style="--purse-percent:${percentageRemaining}; --purse-color:${purseColor};" role="img" aria-label="${escapeHtml(team.name)} has ${percentageRemaining}% purse remaining"><span>${percentageRemaining}%</span></div>
          <div><span>Remaining purse</span><strong>${fmtMoney(team.purse_remaining)}</strong><small>of ${fmtMoney(team.purse_total)} total</small></div>
        </div>
        <div class="team-view-purse-bar" aria-hidden="true"><span style="width:${percentageRemaining}%; background:${purseColor};"></span></div>
        <div class="team-view-squad">${selectedPlayers}${emptySlotMarkup}</div>
      </article>`;
  }).join('');
}

function renderPlayersList() {
  const q = document.getElementById('playerSearch').value.toLowerCase();
  const statusFilter = document.getElementById('playerStatusFilter').value;
  let list = state.players.filter(p =>
    p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q)
  );
  if (statusFilter) list = list.filter(p => p.status === statusFilter);
  const container = document.getElementById('playersList');
  if (!list.length) { container.innerHTML = `<div class="empty">No players found.</div>`; return; }
  container.innerHTML = list.map(p => `
    <div class="player-card fifa-card ${cardTierClass(p.card_tier)}">
      ${ovrBadgeHtml(p)}
      <img class="player-photo" src="${p.photo_url || placeholderImg()}" alt="">
      <div class="player-name">${escapeHtml(p.name)}</div>
      <div class="player-meta">${escapeHtml(p.role || '')}</div>
      <div class="player-price">${fmtMoney(p.base_price)}${p.sold_price ? ' &rarr; ' + fmtMoney(p.sold_price) : ''}</div>
      ${statusBadge(p.status)}
      ${p.team_name ? `<div class="player-meta">Team: ${escapeHtml(p.team_name)}</div>` : ''}
      ${statGridHtml(p)}
    </div>
  `).join('');
}

// ---------- Topbar live ticker ----------
// Two priorities, not one crowded line: a static primary line that always
// shows the single most important fact right now (who/how much/who's
// leading, or a sold/unsold/going-once-twice announcement), and a slower
// secondary marquee for supporting stats. The marquee mechanics themselves
// (measured pixel widths via the Web Animations API) are unchanged.

function buildPrimaryTickerText() {
  const call = activeCallState();
  if (call) return call.call === 'going_twice' ? '📣 GOING TWICE…' : '📣 GOING ONCE…';

  const result = activeRecentResult();
  if (result) {
    return result.type === 'sold'
      ? `✅ SOLD — ${result.player.name} → ${result.player.team_name || 'Unknown team'} for ${fmtMoney(result.player.sold_price)}`
      : `↩ UNSOLD — ${result.player.name} returns to the pool`;
  }

  // Live auction details already fill the spotlight — keep primary empty
  // so the marquee isn't repeating the same player / bid / leader line.
  if (state.currentAuction) return '';
  return 'Waiting for the next player…';
}

function buildSecondaryTickerText() {
  if (!state.players.length) return '📢 Live updates will appear here as players are auctioned...';
  const soldPlayers = state.players.filter(p => p.status === 'sold' && p.sold_price);
  const waitingCount = state.players.filter(p => p.status === 'waiting').length;
  const activeTeams = state.teams.filter(t => t.squad.length > 0).length;
  const parts = [];
  if (soldPlayers.length) {
    const top = soldPlayers.reduce((best, p) => (p.sold_price > best.sold_price ? p : best));
    parts.push(`Highest sale ${fmtMoney(top.sold_price)} (${top.name})`);
  }
  parts.push(`${soldPlayers.length} sold`);
  parts.push(`${waitingCount} remaining`);
  parts.push(`${activeTeams} active teams`);
  return parts.join('   •   ');
}

let tickerAnimation = null;
let tickerRenderVersion = 0;

function renderTicker() {
  const primaryEl = document.getElementById('tickerPrimary');
  if (primaryEl) {
    const primaryText = buildPrimaryTickerText();
    primaryEl.textContent = primaryText;
    primaryEl.hidden = !primaryText;
  }

  const text = buildSecondaryTickerText();
  const track = document.getElementById('tickerTrack');
  const content = document.getElementById('tickerContent');
  if (!track || !content) return;

  content.textContent = text;
  track.replaceChildren(content);
  startTickerAnimation();
}

// A complete live-news group is duplicated enough times to cover any viewport.
// Moving by one group width makes the end frame identical to the next start.
function startTickerAnimation() {
  const viewport = document.getElementById('tickerViewport');
  const track = document.getElementById('tickerTrack');
  const content = document.getElementById('tickerContent');
  if (!viewport || !track || !content) return;

  if (tickerAnimation) {
    tickerAnimation.cancel();
    tickerAnimation = null;
  }

  const renderVersion = ++tickerRenderVersion;

  // Wait for layout so the message and viewport widths are accurate.
  requestAnimationFrame(() => {
    if (renderVersion !== tickerRenderVersion) return;

    const viewportWidth = viewport.getBoundingClientRect().width;
    const textWidth = content.getBoundingClientRect().width;
    if (!viewportWidth || !textWidth) return;

    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    const loopDistance = textWidth + gap;
    const copyCount = Math.ceil(viewportWidth / loopDistance) + 1;
    for (let index = 1; index < copyCount; index += 1) {
      const copy = content.cloneNode(true);
      copy.removeAttribute('id');
      copy.setAttribute('aria-hidden', 'true');
      track.appendChild(copy);
    }

    const pixelsPerSecond = 40;
    const duration = Math.max((loopDistance / pixelsPerSecond) * 1000, 6000);

    tickerAnimation = track.animate(
      [
        { transform: 'translateX(0)' },
        { transform: `translateX(${-loopDistance}px)` },
      ],
      { duration, iterations: Infinity, easing: 'linear' }
    );
  });
}

// pause the scroll while the pointer is over it so it's easier to read
const tickerWrapEl = document.getElementById('tickerWrap');
if (tickerWrapEl) {
  tickerWrapEl.addEventListener('mouseenter', () => tickerAnimation && tickerAnimation.pause());
  tickerWrapEl.addEventListener('mouseleave', () => tickerAnimation && tickerAnimation.play());
}

function setConnectionStatus(isConnected) {
  document.querySelectorAll('.connection-state').forEach(element => {
    element.lastChild.textContent = isConnected ? ' Live updates connected' : ' Reconnecting live updates';
    element.classList.toggle('is-reconnecting', !isConnected);
  });
}

function bidTeamLogo(teamId) {
  const team = state.teams.find(candidate => candidate.id === teamId);
  return team && team.logo_url ? team.logo_url : placeholderImg();
}

function roleAbbreviation(role) {
  const normalizedRole = String(role || '').trim().toLowerCase();
  const abbreviations = {
    forward: 'FW',
    midfielder: 'MID',
    middle: 'MID',
    defender: 'DEF',
    goalkeeper: 'GK',
  };
  return abbreviations[normalizedRole] || (normalizedRole ? normalizedRole.slice(0, 3).toUpperCase() : '-');
}

// ---------- Helpers ----------
function statusBadge(status) {
  const map = {
    sold: ['badge-sold', 'Sold'],
    auction: ['badge-auction', 'Up for auction'],
    waiting: ['badge-waiting', 'Waiting'],
    unsold: ['badge-unsold', 'Unsold'],
  };
  const [cls, label] = map[status] || map.waiting;
  return `<span class="badge ${cls}">${label}</span>`;
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

function relativeTime(ts) {
  if (!ts) return '';
  const iso = String(ts).includes('T') ? ts : String(ts).replace(' ', 'T') + 'Z';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr}h ago`;
}

// ---------- FIFA-style card helpers ----------
// player.overall / player.card_tier are computed server-side (see
// backend/database.py's enrich_player); these just turn them into markup
// shared by the spotlight, team squad view, and player pool cards.
function cardTierClass(tier) {
  return 'card-' + (tier || 'bronze');
}
function ovrBadgeHtml(p) {
  if (p.overall === undefined || p.overall === null) return '';
  return `<div class="ovr-badge ${cardTierClass(p.card_tier)}"><span class="ovr-value">${p.overall}</span><span class="ovr-label">OVR</span></div>`;
}
function statGridHtml(p) {
  const stats = [['PAC', p.pace], ['SHO', p.shooting], ['PAS', p.passing], ['DRI', p.dribbling], ['DEF', p.defending], ['PHY', p.physical]];
  return `<div class="stat-grid">${stats.map(([label, val]) =>
    `<div class="stat-item"><span class="stat-label">${label}</span><span class="stat-value">${val ?? '-'}</span></div>`
  ).join('')}</div>`;
}
// Compact bar-meter version used in the hero spotlight, where the six
// sub-stats need to be scannable at a glance without competing visually
// with the player's name or the current bid.
function statBarsHtml(p) {
  const stats = [['PAC', p.pace], ['SHO', p.shooting], ['PAS', p.passing], ['DRI', p.dribbling], ['DEF', p.defending], ['PHY', p.physical]];
  return `<div class="stat-bars">${stats.map(([label, val]) => {
    const pct = Math.max(0, Math.min(100, val ?? 0));
    return `
      <div class="stat-bar-row">
        <span class="stat-bar-label">${label}</span>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
        <span class="stat-bar-value">${val ?? '-'}</span>
      </div>`;
  }).join('')}</div>`;
}
