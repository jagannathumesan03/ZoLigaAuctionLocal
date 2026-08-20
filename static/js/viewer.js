let state = {
  players: [], teams: [], currentAuction: null,
  // Broadcast-only UI state -- never persisted, purely for the "what's happening
  // right now" presentation layer (see renderSpotlight / the ticker):
  recentResult: null,   // { type: 'sold' | 'unsold', player, expiresAt }
  callState: null,      // { call: 'going_once' | 'going_twice', playerId, expiresAt }
  lastSpotlightBid: null,
  waitingBackgroundUrl: '',
  auth: { role: 'viewer', team_id: null, username: '' },
};

// Tracks the player currently shown as "up for auction" so we can fire the
// FIFA pack-reveal animation only when a *new* player is selected (not on
// first page load, and not on bid/timer refreshes for the same player).
let lastAuctionPlayerId = null;
let auctionBaselineReady = false;
let packRevealInProgress = false;

// ---------- Auth guard (admins may also view this page) ----------
(async function guard() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error();
    state.auth = await res.json();
    if (state.auth.role === 'team') setupManagerTab();
    if (isBroadcastViewer()) {
      document.body.classList.add('has-broadcast-viewer');
      activateTab('teams');
    }
    init();
  } catch (e) {
    window.location.href = '/login';
  }
})();

function isBroadcastViewer() {
  return state.auth.role === 'viewer';
}

function isManagerViewer() {
  return state.auth.role === 'team';
}

function logout() {
  fetch('/api/auth/logout', { method: 'POST' }).then(() => window.location.href = '/login');
}

function setupManagerTab() {
  const tab = document.querySelector('.tab[data-tab="manager"]');
  const panel = document.getElementById('tab-manager');
  if (tab) tab.hidden = false;
  if (panel) panel.hidden = false;
  document.body.classList.add('has-manager-desk');
  activateTab('manager');
}

// ---------- Tabs ----------
function activateTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => {
    const on = t.dataset.tab === tabName;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const panel = document.getElementById('tab-' + tabName);
  if (panel) panel.classList.add('active');
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
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
  document.getElementById('playerRoleFilter').addEventListener('change', renderPlayersList);
  document.getElementById('playerStarsFilter').addEventListener('change', renderPlayersList);
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

function auctionablePlayers() {
  return state.players.filter(p => p.status === 'waiting' || p.status === 'unsold');
}

function isAuctionComplete() {
  return state.players.length > 0
    && !state.currentAuction
    && !packRevealInProgress
    && auctionablePlayers().length === 0;
}

function renderAll() {
  renderSpotlight();
  renderAuctionStatusStrip();
  renderManagerDesk();
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

// SSE events can arrive in quick bursts (a bid landing right as a new player
// goes up, a reconnect replaying state, etc.). Each refresh does its own
// async fetch + mutates shared `state`/`lastAuctionPlayerId`, so letting two
// runs overlap lets the slower one finish "after" the faster one, re-read
// state the faster run already updated, and wrongly conclude the auction
// player changed again -- which retriggers/restarts the pack-reveal
// animation mid-spin. Serializing runs (and coalescing anything that arrives
// while one is in flight into a single follow-up pass) makes each refresh
// see a consistent, already-settled `lastAuctionPlayerId` before it starts.
let refreshInFlight = false;
let refreshPending = false;

function connectSSE() {
  const es = new EventSource('/api/events');
  const runRefresh = async () => {
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
    if (shouldReveal) packRevealInProgress = true;
    renderAll();
    if (shouldReveal) {
      window.playPackReveal(state.currentAuction, {
        candidates: state.players,
        onDone: () => {
          packRevealInProgress = false;
          renderSpotlight();
        },
      });
    }
  };
  const refresh = async () => {
    if (refreshInFlight) { refreshPending = true; return; }
    refreshInFlight = true;
    try {
      await runRefresh();
    } finally {
      refreshInFlight = false;
      if (refreshPending) {
        refreshPending = false;
        refresh();
      }
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
      renderAll();
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
        <div class="spotlight-photo-wrap">
          ${ratingBadgeHtml(p)}
          <img class="spotlight-player-photo" src="${p.photo_url || placeholderImg()}" alt="${escapeHtml(p.name || 'Player')}">
        </div>
        <div class="info">
          <h2>${escapeHtml(p.name || 'Player')}</h2>
          ${starsHtml(p, 'star-rating-lg')}
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
// Photo + player info fill the left of the viewer window; camera stays on the right.

function renderSpotlight() {
  const container = document.getElementById('spotlight');
  const current = packRevealInProgress ? null : state.currentAuction;

  if (!current) {
    const result = packRevealInProgress ? null : activeRecentResult();
    const hasBg = !!state.waitingBackgroundUrl;
    let waitingTitle = 'Waiting for the next player…';
    if (packRevealInProgress) waitingTitle = 'Revealing the next player…';
    else if (isAuctionComplete()) waitingTitle = 'Auction has been completed';
    container.innerHTML = result
      ? resultStateHtml(result)
      : `
        <div class="spotlight spotlight-waiting${hasBg ? ' has-waiting-bg' : ''}"${waitingSpotlightStyle()}>
          <div class="empty-state">
            <p class="eyebrow">Auction desk</p>
            <h2>${waitingTitle}</h2>
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

  const showBidHistory = isManagerViewer() || isBroadcastViewer();
  container.innerHTML = `
    <div class="spotlight fifa-card${showBidHistory ? ' has-bid-panel' : ''} ${cardTierClass(current.card_tier)}">
      ${call ? callBannerHtml(call) : ''}
      <div class="spotlight-photo-wrap">
        ${ratingBadgeHtml(current)}
        <img class="spotlight-player-photo" src="${current.photo_url || placeholderImg()}" alt="${escapeHtml(current.name)}">
      </div>
      <div class="info">
        <p class="eyebrow auction-state-label${hasBids ? ' is-bidding' : ''}">${hasBids ? 'Bidding' : 'Now auctioning'}</p>
        <h2>${escapeHtml(current.name)}</h2>
        <div class="spotlight-player-meta">
          <span class="badge position-badge">${escapeHtml(current.role || 'Player')}</span>
          ${affiliationBadgeHtml(current.stats, 'affiliation-badge-lg')}
          ${starsHtml(current, 'star-rating-lg')}
        </div>
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
      </div>
      ${showBidHistory ? spotlightBidPanelHtml() : ''}
    </div>`;
  state.lastSpotlightBid = bidAmount;
  if (showBidHistory) renderBidHistory();
  renderAuctionTimerDock();
}

function spotlightBidPanelHtml() {
  return `
    <aside class="spotlight-bid-panel bid-activity-card dashboard-card" aria-labelledby="bidHistoryTitle">
      <div class="dashboard-heading"><h2 id="bidHistoryTitle">Bid history</h2><span class="activity-caption">Live</span></div>
      <div id="bidHistory" class="bid-history-log"></div>
    </aside>`;
}

function bidTeamLogo(teamId) {
  const team = state.teams.find(candidate => candidate.id === teamId);
  return team && team.logo_url ? team.logo_url : placeholderImg();
}

function renderBidHistory() {
  const historyContainer = document.getElementById('bidHistory');
  if (!historyContainer) return;
  const current = state.currentAuction;
  if (!current) {
    historyContainer.innerHTML = `<div class="bid-history-empty">No active bidding yet.</div>`;
    return;
  }
  const history = current.history || [];
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
// Same green-to-red hue ramp the full Team view tab uses (see
// renderTeamViewList below), so a team's purse bar reads the same way
// everywhere it appears -- this compact tile just wasn't wired up to it and
// stayed a flat, unchanging color as the purse drained.
function purseColorFor(percentageRemaining) {
  const hue = Math.round(Math.max(0, Math.min(percentageRemaining, 100)) * 1.35);
  return `hsl(${hue} 78% 52%)`;
}

function renderTeamsList() {
  const container = document.getElementById('teamsList');
  if (!state.teams.length) { container.innerHTML = `<div class="empty">No teams yet.</div>`; return; }
  const leadingTeamId = state.currentAuction ? state.currentAuction.current_bid_team_id : null;
  container.innerHTML = state.teams.map(t => {
    const pct = t.purse_total ? Math.round((t.purse_remaining / t.purse_total) * 100) : 0;
    const isLeading = leadingTeamId === t.id;
    const spend = spendBudget(t);
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
            <span class="team-tile-slots">${(t.slots_filled != null ? t.slots_filled : t.squad.length)}/${t.slots_max}</span>
          </div>
          <div class="team-tile-max">Max spend ${fmtMoney(spend.max)}</div>
          ${spend.keepSlots ? `<div class="team-tile-keep">Keeps ${fmtMoney(spend.reserve)} (${fmtMoney(PLAYER_BASE_PRICE_CR)} × ${spend.keepSlots})</div>` : ''}
          <div class="purse-bar" aria-hidden="true"><div class="purse-bar-fill" style="width:${pct}%; background:${purseColorFor(pct)}"></div></div>
        </div>
      </div>`;
  }).join('');
}

const PLAYER_BASE_PRICE_CR = 30;
const BID_STEP_LOW_CR = 5;
const BID_STEP_HIGH_CR = 10;
const BID_HIGH_THRESHOLD_CR = 200;

function bidIncrement(amount) {
  return Number(amount) >= BID_HIGH_THRESHOLD_CR ? BID_STEP_HIGH_CR : BID_STEP_LOW_CR;
}
function nextStandardBid(amount) {
  return Number(amount || 0) + bidIncrement(amount);
}
function nextRaiseAmount(current) {
  const bidAmount = current.current_bid_amount || current.base_price || PLAYER_BASE_PRICE_CR;
  return current.current_bid_team_id ? nextStandardBid(bidAmount) : bidAmount;
}

function ownTeam() {
  if (state.auth.role !== 'team' || !state.auth.team_id) return null;
  return state.teams.find(team => team.id === state.auth.team_id) || null;
}

function renderManagerDesk() {
  const desk = document.getElementById('managerDesk');
  const brand = document.getElementById('viewerBrand');
  const me = ownTeam();
  if (!desk) return;
  if (!me) {
    desk.innerHTML = '';
    if (brand) brand.textContent = 'Live Auction';
    return;
  }
  if (brand) brand.textContent = `${me.name} · Live Auction`;

  const squad = Array.isArray(me.squad) ? me.squad : [];
  const slotsLeft = Math.max(0, me.slots_max - squad.length);
  const spent = Math.max(0, (me.purse_total || 0) - (me.purse_remaining || 0));
  const pct = me.purse_total ? Math.round((me.purse_remaining / me.purse_total) * 100) : 0;
  const current = state.currentAuction;
  const currentAmount = current ? (current.current_bid_amount || current.base_price) : 0;
  const nextAmount = current ? nextRaiseAmount(current) : 0;
  const afterBuy = me.purse_remaining - nextAmount;
  const slotsAfter = slotsLeft - 1;
  const spend = spendBudget(me);
  const max = spend.max;
  const affordable = current && slotsLeft > 0 && nextAmount <= max;
  const counts = squadPositionCounts(squad);
  const gaps = POS_ORDER.filter(pos => counts[pos] === 0);
  const currentPos = current ? roleAbbreviation(current.role) : '';
  const fillsGap = current && gaps.includes(currentPos);
  const avgPaid = squad.length
    ? Math.round(squad.reduce((sum, p) => sum + (p.sold_price || 0), 0) / squad.length)
    : 0;
  const strength = squad.length
    ? (squad.reduce((sum, p) => sum + starValue(p), 0) / squad.length).toFixed(1)
    : 0;
  const kit = teamKitColor(me);

  const signings = squad.length
    ? `<div class="manager-signings-wrap"><table class="manager-signings-table">
        <thead><tr><th></th><th>Player</th><th>Pos</th><th>Affiliation</th><th>Level</th><th class="paid">Paid</th></tr></thead>
        <tbody>${squad.map(p => {
          const pos = roleAbbreviation(p.role);
          return `
            <tr>
              <td><img src="${p.photo_url || placeholderImg()}" alt="" style="border-color:${kit}"></td>
              <td>${escapeHtml(p.name)}</td>
              <td><span class="manager-pos-chip" style="background:${POS_COLOR[pos] || '#6b7280'}">${escapeHtml(pos)}</span></td>
              <td>${affiliationBadgeHtml(p.stats) || '<span class="muted">—</span>'}</td>
              <td class="num">${starsHtml(p, 'star-rating-sm')}</td>
              <td class="paid">${fmtMoney(p.sold_price)}</td>
            </tr>`;
        }).join('')}</tbody>
      </table></div>`
    : `<div class="empty">Nothing bought yet — your full purse is intact.</div>`;

  desk.innerHTML = `
    <div class="section-heading compact">
      <div><p class="eyebrow">Manager desk</p><h2>${escapeHtml(me.name)}</h2></div>
      <span class="connection-state"><span></span> Your squad only</span>
    </div>
    <div class="manager-grid">
      <article class="dashboard-card manager-on-block">
        <div class="dashboard-heading"><h2>On the block</h2></div>
        ${current ? `
          <div class="manager-block-row">
            <img src="${current.photo_url || placeholderImg()}" alt="">
            <div>
              <strong>${escapeHtml(current.name)}</strong>
              <span>${escapeHtml(current.role || 'Player')} · ${starsHtml(current, 'star-rating-inline')}</span>
              <div class="muted">Live bid ${fmtMoney(currentAmount)}</div>
              ${current.current_bid_team_name ? `<div class="muted">Led by ${escapeHtml(current.current_bid_team_name)}</div>` : ''}
              ${fillsGap ? `<span class="leading-chip">Fills your ${currentPos} gap</span>` : ''}
            </div>
          </div>` : `<div class="empty">Nothing up for bid right now.</div>`}
      </article>
      <article class="dashboard-card">
        <div class="dashboard-heading"><h2>If you win at ${current ? fmtMoney(nextAmount) : '—'}</h2></div>
        <div class="manager-kpis">
          <div><span>Purse after</span><strong>${current ? fmtMoney(Math.max(0, afterBuy)) : '—'}</strong></div>
          <div><span>Slots after</span><strong>${current ? Math.max(0, slotsAfter) : slotsLeft}</strong></div>
        </div>
        <p class="muted">${!current
          ? (isAuctionComplete() ? 'Auction has been completed.' : 'Waiting for the next player.')
          : !affordable
            ? (slotsLeft === 0
              ? 'Squad complete — you are out of this lot.'
              : (nextAmount > me.purse_remaining
                ? 'This raise is over your remaining purse.'
                : 'This raise is over your max spend — keep ₹30 Cr for each remaining slot.'))
            : 'Comfortable — you can still cover remaining slots.'}</p>
      </article>
    </div>
    <div class="auction-status-strip manager-status">
      <div class="status-chip"><strong>${fmtMoney(me.purse_remaining)}</strong><span>Purse remaining</span></div>
      <div class="status-chip is-highlight"><strong>${fmtMoney(max)}</strong><span>Max you can spend</span></div>
      <div class="status-chip"><strong>${spend.keepSlots ? fmtMoney(spend.reserve) : '—'}</strong><span>${spend.keepSlots ? `Reserved (₹30 Cr × ${spend.keepSlots})` : 'Last slot'}</span></div>
      <div class="status-chip"><strong>${squad.length}/${me.slots_max}</strong><span>Players taken</span></div>
      <div class="status-chip"><strong>${strength ? strength + '★' : '—'}</strong><span>Squad level</span></div>
      <div class="status-chip"><strong>${gaps.length ? gaps.join(' ') : 'None'}</strong><span>Position gaps</span></div>
    </div>
    <div class="manager-squad">
      <article class="dashboard-card manager-pitch-card">
        <div class="dashboard-heading">
          <h2>Match-day five</h2>
          <span class="activity-caption">${squad.length}/${me.slots_max}</span>
        </div>
        ${renderPitch(squad, kit)}
      </article>
      <article class="dashboard-card manager-signings">
        <div class="dashboard-heading">
          <h2>Your signings</h2>
          <span class="activity-caption">Avg buy ${fmtMoney(avgPaid)} · ${pct}% purse left</span>
        </div>
        <div class="purse-bar" aria-hidden="true"><div class="purse-bar-fill" style="width:${pct}%; background:${purseColorFor(pct)}"></div></div>
        ${signings}
      </article>
    </div>
  `;
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
    const purseColor = purseColorFor(percentageRemaining);
    const selectedPlayers = squad.map(player => `
      <div class="team-view-player">
        <img class="team-view-player-photo" src="${player.photo_url || placeholderImg()}" alt="${escapeHtml(player.name)}">
        <b>${escapeHtml(player.name)}</b>
        ${starsHtml(player, 'star-rating-sm')}
        <span class="team-view-player-position">${roleAbbreviation(player.role)}</span>
        <strong>${fmtMoney(player.sold_price)}</strong>
      </div>`).join('');
    const emptySlots = Math.max(team.slots_max - squad.length, 0);
    const emptySlotMarkup = Array.from({ length: emptySlots }, () =>
      `<div class="team-view-empty-slot">Open player slot</div>`
    ).join('');
    const spend = spendBudget(team);

    return `
      <article class="team-view-card">
        <header class="team-view-header">
          <img src="${team.logo_url || placeholderImg()}" alt="${escapeHtml(team.name)} logo">
          <div><h3>${escapeHtml(team.name)}</h3><span>${squad.length}/${team.slots_max} player slots filled</span></div>
        </header>
        <div class="team-view-purse">
          <div class="team-purse-chart" style="--purse-percent:${percentageRemaining}; --purse-color:${purseColor};" role="img" aria-label="${escapeHtml(team.name)} has ${percentageRemaining}% purse remaining"><span>${percentageRemaining}%</span></div>
          <div><span>Remaining purse</span><strong>${fmtMoney(team.purse_remaining)}</strong><small>of ${fmtMoney(team.purse_total)} total</small><small class="team-view-max-spend">Max spend ${fmtMoney(spend.max)}${spend.keepSlots ? ` · keeps ${fmtMoney(spend.reserve)} (₹30 Cr × ${spend.keepSlots})` : ''}</small></div>
        </div>
        <div class="team-view-purse-bar" aria-hidden="true"><span style="width:${percentageRemaining}%; background:${purseColor};"></span></div>
        <div class="team-view-squad">${selectedPlayers}${emptySlotMarkup}</div>
      </article>`;
  }).join('');
}

function renderPlayersList() {
  const q = document.getElementById('playerSearch').value.toLowerCase();
  const statusFilter = document.getElementById('playerStatusFilter').value;
  const roleFilter = document.getElementById('playerRoleFilter').value;
  const starsFilter = document.getElementById('playerStarsFilter').value;
  let list = state.players.filter(p =>
    p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q)
  );
  if (statusFilter) list = list.filter(p => p.status === statusFilter);
  if (roleFilter) list = list.filter(p => playerHasPosition(p.role, roleFilter));
  if (starsFilter) {
    const target = parseFloat(starsFilter);
    list = list.filter(p => starValue(p) === target);
  }
  const container = document.getElementById('playersList');
  if (!list.length) { container.innerHTML = `<div class="empty">No players found.</div>`; return; }
  container.innerHTML = list.map(p => `
    <div class="player-card fifa-card ${cardTierClass(p.card_tier)}">
      ${ratingBadgeHtml(p)}
      <img class="player-photo" src="${p.photo_url || placeholderImg()}" alt="">
      <div class="player-name">${escapeHtml(p.name)}</div>
      <div class="player-meta">${escapeHtml(p.role || '')}</div>
      ${affiliationBadgeHtml(p.stats)}
      ${starsHtml(p)}
      <div class="player-price">${fmtMoney(p.base_price)}${p.sold_price ? ' &rarr; ' + fmtMoney(p.sold_price) : ''}</div>
      ${statusBadge(p.status)}
      ${p.team_name ? `<div class="player-meta">Team: ${escapeHtml(p.team_name)}</div>` : ''}
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
  if (isAuctionComplete()) return 'Auction has been completed';
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

const POS_ORDER = ['GK', 'DEF', 'MID', 'FW'];
const POS_COLOR = { GK: '#C08A1E', DEF: '#3C82B8', MID: '#12906A', FW: '#D4504A' };
const TEAM_KIT = ['#D4504A', '#3C82B8', '#12906A', '#C08A1E', '#7D5AA6', '#1F8D96'];
const MATCHDAY_FIVE = [
  { pos: 'GK', x: 50, y: 87 },
  { pos: 'DEF', x: 24, y: 66 }, { pos: 'DEF', x: 76, y: 66 },
  { pos: 'MID', x: 50, y: 45 },
  { pos: 'FW', x: 50, y: 20 },
];

function teamKitColor(team) {
  const index = Math.max(0, Number(team && team.id) - 1);
  return TEAM_KIT[index % TEAM_KIT.length];
}

function lastName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts[parts.length - 1] || name || '';
}

function squadPositionCounts(squad) {
  const counts = { FW: 0, MID: 0, DEF: 0, GK: 0 };
  squad.forEach(p => {
    const key = roleAbbreviation(p.role);
    if (counts[key] !== undefined) counts[key] += 1;
  });
  return counts;
}

function buildMatchdayFive(squad) {
  const pool = Array.isArray(squad) ? [...squad] : [];
  const taken = new Set();
  const filled = MATCHDAY_FIVE.map(slot => {
    const pick = pool.find(p => roleAbbreviation(p.role) === slot.pos && !taken.has(p.id));
    if (pick) taken.add(pick.id);
    return { ...slot, player: pick || null, outOfPos: false };
  });
  filled.forEach(slot => {
    if (!slot.player) {
      const alt = pool.find(p => !taken.has(p.id));
      if (alt) {
        taken.add(alt.id);
        slot.player = alt;
        slot.outOfPos = true;
      }
    }
  });
  return { filled, bench: pool.filter(p => !taken.has(p.id)) };
}

function renderPitch(squad, kitColor) {
  const { filled, bench } = buildMatchdayFive(squad);
  const spots = filled.map(slot => {
    if (slot.player) {
      const pos = roleAbbreviation(slot.player.role);
      const meta = slot.outOfPos
        ? `${escapeHtml(pos)} cover`
        : escapeHtml(fmtMoney(slot.player.sold_price));
      return `
        <div class="manager-spot" style="left:${slot.x}%;top:${slot.y}%">
          <img src="${slot.player.photo_url || placeholderImg()}" alt="" style="border-color:${kitColor}">
          <div class="manager-spot-name">${escapeHtml(lastName(slot.player.name))}</div>
          <div class="manager-spot-meta${slot.outOfPos ? ' is-cover' : ''}">${meta}</div>
        </div>`;
    }
    return `
      <div class="manager-spot" style="left:${slot.x}%;top:${slot.y}%">
        <div class="manager-spot-vacant">${escapeHtml(slot.pos)}</div>
        <div class="manager-spot-name">Vacant</div>
      </div>`;
  }).join('');
  const benchChips = bench.length
    ? bench.map(p => `
        <span class="manager-bench-chip">
          <span class="dot" style="background:${POS_COLOR[roleAbbreviation(p.role)] || '#8fa1b3'}"></span>
          ${escapeHtml(p.name)} · ${fmtMoney(p.sold_price)}
        </span>`).join('')
    : `<span class="muted">No rotation options yet.</span>`;
  return `
    <div class="manager-pitch" aria-label="Match-day five">
      <div class="manager-pitch-line touch"></div>
      <div class="manager-pitch-line halfway"></div>
      <div class="manager-pitch-line circle"></div>
      <div class="manager-pitch-line box-top"></div>
      <div class="manager-pitch-line box-bottom"></div>
      ${spots}
    </div>
    <div class="manager-bench">
      <div class="manager-bench-label">Bench · ${bench.length}</div>
      <div class="manager-bench-row">${benchChips}</div>
    </div>`;
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
  return '₹' + Number(v).toLocaleString('en-IN') + ' Cr';
}
function slotsRemaining(team) {
  const filled = team.slots_filled != null ? team.slots_filled : (team.squad || []).length;
  return Math.max(0, (team.slots_max || 0) - filled);
}
function spendBudget(team) {
  const left = slotsRemaining(team);
  if (left <= 0) return { max: 0, reserve: 0, keepSlots: 0 };
  const keepSlots = Math.max(0, left - 1);
  const reserve = keepSlots * PLAYER_BASE_PRICE_CR;
  return {
    max: Math.max(0, (team.purse_remaining || 0) - reserve),
    reserve,
    keepSlots,
  };
}
function maxSpend(team) {
  return spendBudget(team).max;
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

// ---------- Player card helpers ----------
// Organizers set player.stars (2.0–5.0, half-step). card_tier is derived server-side.
function cardTierClass(tier) {
  return 'card-' + (tier || 'bronze');
}
function starValue(p) {
  const n = parseFloat(p && p.stars);
  if (!Number.isFinite(n)) return 3;
  return Math.max(2, Math.min(5, Math.round(n * 2) / 2));
}
function ratingLabel(p) {
  return starValue(p).toFixed(1).replace(/\.0$/, '');
}
function starsHtml(p, extraClass) {
  const value = starValue(p);
  const cls = extraClass ? ` ${extraClass}` : '';
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
  return `<span class="star-rating${cls}" aria-label="${value} of 5 stars">${stars.join('')}</span>`;
}
function ratingBadgeHtml(p, extraClass) {
  const cls = extraClass ? ` ${extraClass}` : '';
  return `<div class="rating-badge ${cardTierClass(p.card_tier)}${cls}" aria-label="Player value ${starValue(p)} of 5">${ratingLabel(p)}</div>`;
}
