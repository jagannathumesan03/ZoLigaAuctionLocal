let state = {
  players: [], teams: [], currentAuction: null,
  // Broadcast-only UI state -- never persisted, purely for the "what's happening
  // right now" presentation layer (see renderSpotlight / the ticker):
  recentResult: null,   // { type: 'sold' | 'unsold', player, expiresAt }
  callState: null,      // { call: 'going_once' | 'going_twice', playerId, expiresAt }
  lastSpotlightBid: null,
  lastBidId: null,
};

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
  await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
  renderAll();
  connectSSE();
  document.getElementById('playerSearch').addEventListener('input', renderPlayersList);
  document.getElementById('playerStatusFilter').addEventListener('change', renderPlayersList);
  setInterval(refreshRelativeTimes, 5000);
}

async function loadPlayers() { state.players = await apiFetch('/api/players'); }
async function loadTeams() { state.teams = await apiFetch('/api/teams'); }
async function loadCurrentAuction() { state.currentAuction = await apiFetch('/api/auction/current'); }

function renderAll() {
  renderSpotlight();
  renderBidActivity();
  renderBidHistory();
  renderNextUp();
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
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    detectAndAnnounceResults();
    renderAll();
  };
  es.addEventListener('current_player', refresh);
  es.addEventListener('bid_updated', refresh);
  es.addEventListener('player_sold', refresh);
  es.addEventListener('player_unsold', refresh);
  es.addEventListener('player_reset', refresh);
  es.addEventListener('team_updated', refresh);
  es.addEventListener('auction_call', (e) => {
    try { setCallState(JSON.parse(e.data)); } catch (err) { /* ignore malformed payload */ }
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
// This is the dominant element on the page -- everything else supports it.
// No "leading bid" card duplicates the current-bid number anymore; the
// latest-bid-activity panel below covers "what just happened" instead.
function renderSpotlight() {
  const container = document.getElementById('spotlight');
  const current = state.currentAuction;

  if (!current) {
    const result = activeRecentResult();
    container.innerHTML = result
      ? resultStateHtml(result)
      : `
        <div class="spotlight spotlight-waiting">
          <div class="empty-state">
            <p class="eyebrow">Auction desk</p>
            <h2>Waiting for the next player…</h2>
          </div>
        </div>`;
    return;
  }

  const bidAmount = current.current_bid_amount || current.base_price;
  const hasBids = !!current.current_bid_team_id;
  const leadingTeam = state.teams.find(team => team.id === current.current_bid_team_id);
  const call = activeCallState();
  const isNewBid = state.lastSpotlightBid !== null && state.lastSpotlightBid !== bidAmount;

  container.innerHTML = `
    <div class="spotlight fifa-card ${cardTierClass(current.card_tier)}">
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
    </div>`;
  state.lastSpotlightBid = bidAmount;
}

// ---------- Latest bid activity (replaces the old duplicate "leading bid" card) ----------
function renderBidActivity() {
  const el = document.getElementById('bidActivity');
  const current = state.currentAuction;
  if (!current) {
    el.innerHTML = `<div class="bid-activity-empty">No active bidding yet.</div>`;
    state.lastBidId = null;
    return;
  }
  const history = current.history || [];
  if (!history.length) {
    el.innerHTML = `<div class="bid-activity-empty">Awaiting the first bid — opening at ${fmtMoney(current.base_price)}.</div>`;
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

// ---------- Bid history (compact live feed, newest first) ----------
function renderBidHistory() {
  const historyContainer = document.getElementById('bidHistory');
  const current = state.currentAuction;
  if (!current) {
    historyContainer.innerHTML = `<div class="bid-history-empty">No active bidding yet.</div>`;
    return;
  }
  const historyItems = (current.history || []).map(h => `
    <div class="bid-history-item">
      <span class="bid-history-team">
        <img src="${bidTeamLogo(h.team_id)}" alt="">
        ${escapeHtml(h.team_name || 'Unknown team')}
      </span>
      <span class="player-price">${fmtMoney(h.amount)}</span>
      <span class="bid-history-time" data-ts="${h.created_at || ''}">${relativeTime(h.created_at)}</span>
    </div>`).join('');
  // Starting bid is real data (the player's base price), placed first in the
  // DOM -- the log is flipped visually via column-reverse (see CSS), so this
  // ends up at the bottom of the feed and the newest bid on top.
  const startingBidItem = `
    <div class="bid-history-item bid-history-start">
      <span class="bid-history-team">Starting bid</span>
      <span class="player-price">${fmtMoney(current.base_price)}</span>
      <span class="bid-history-time"></span>
    </div>`;
  historyContainer.innerHTML = startingBidItem + historyItems;
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

// ---------- Up next ----------
function renderNextUp() {
  const waitingPlayers = state.players.filter(player => player.status === 'waiting');
  const nextPlayer = waitingPlayers[0];
  const nextUp = document.getElementById('nextUp');
  nextUp.innerHTML = nextPlayer
    ? `
      <div class="next-player fifa-card ${cardTierClass(nextPlayer.card_tier)}">
        ${ovrBadgeHtml(nextPlayer)}
        <img src="${nextPlayer.photo_url || placeholderImg()}" alt="${escapeHtml(nextPlayer.name)}">
        <div>
          <strong>${escapeHtml(nextPlayer.name)}</strong>
          <span>${escapeHtml(nextPlayer.role || 'Player')}</span>
          <small>Base price: ${fmtMoney(nextPlayer.base_price)}</small>
        </div>
      </div>`
    : `<div class="next-player-empty">No waiting players in the pool.</div>`;
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

  const current = state.currentAuction;
  if (!current) return 'Waiting for the next player…';
  const bidAmount = current.current_bid_amount || current.base_price;
  const leader = current.current_bid_team_name ? ` → ${current.current_bid_team_name}` : ' (opening bid)';
  return `${current.name} → ${fmtMoney(bidAmount)}${leader}`;
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
  if (primaryEl) primaryEl.textContent = buildPrimaryTickerText();

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
