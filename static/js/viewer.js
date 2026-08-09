let state = { players: [], teams: [], currentAuction: null };

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
}

async function loadPlayers() { state.players = await apiFetch('/api/players'); }
async function loadTeams() { state.teams = await apiFetch('/api/teams'); }
async function loadCurrentAuction() { state.currentAuction = await apiFetch('/api/auction/current'); }

function renderAll() {
  renderSpotlight();
  renderAuctionDashboard();
  renderTeamsList();
  renderTeamViewList();
  renderPlayersList();
  renderTicker();
}

let knownSoldPlayerIds = null;

function connectSSE() {
  const es = new EventSource('/api/events');
  const refresh = async () => {
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    detectAndCelebrateSales();
    renderAll();
  };
  es.addEventListener('current_player', refresh);
  es.addEventListener('bid_updated', refresh);
  es.addEventListener('player_sold', refresh);
  es.addEventListener('player_unsold', refresh);
  es.addEventListener('player_reset', refresh);
  es.addEventListener('team_updated', refresh);
  es.onopen = () => setConnectionStatus(true);
  es.onerror = () => setConnectionStatus(false);

  // Seed the baseline so already-sold players (from before this page loaded)
  // don't trigger a celebration -- only newly-sold players should.
  knownSoldPlayerIds = new Set(state.players.filter(p => p.status === 'sold').map(p => p.id));
}

// Detect sales by diffing player status rather than relying solely on the
// SSE "player_sold" event's payload -- this way the celebration still fires
// even when SSE itself is unreliable and the dashboard is only staying
// current via polling. refresh() calls this every time it reloads player
// data, regardless of what triggered the reload.
function detectAndCelebrateSales() {
  if (!knownSoldPlayerIds) return;
  const currentSoldIds = new Set();
  state.players.forEach(p => {
    if (p.status === 'sold') {
      currentSoldIds.add(p.id);
      if (!knownSoldPlayerIds.has(p.id)) {
        window.celebrateSale && window.celebrateSale(p);
      }
    }
  });
  knownSoldPlayerIds = currentSoldIds;
}

function renderSpotlight() {
  const container = document.getElementById('spotlight');
  const current = state.currentAuction;
  if (!current) {
    container.innerHTML = `<div class="empty-state">Waiting for the next player to go up for auction...</div>`;
    document.getElementById('bidHistory').innerHTML = `<div class="bid-history-empty">No active bidding yet.</div>`;
    return;
  }
  const bidAmount = current.current_bid_amount || current.base_price;
  const nextBid = bidAmount + tierIncrement(bidAmount);
  const bidCount = current.history ? current.history.length : 0;
  const leadingTeam = state.teams.find(team => team.id === current.current_bid_team_id);
  const leadingBidHtml = leadingTeam
    ? `
      <aside class="leading-bid-card" aria-label="Current leading bid">
        <p class="eyebrow">Leading bid</p>
        <img class="leading-team-logo" src="${leadingTeam.logo_url || placeholderImg()}" alt="${escapeHtml(leadingTeam.name)} logo">
        <strong>${escapeHtml(leadingTeam.name)}</strong>
        <span>Current offer</span>
        <b>${fmtMoney(bidAmount)}</b>
        <small>${bidCount} ${bidCount === 1 ? 'bid recorded' : 'bids recorded'}</small>
      </aside>`
    : `
      <aside class="leading-bid-card leading-bid-empty" aria-label="Bidding status">
        <p class="eyebrow">Bidding status</p>
        <div class="leading-bid-mark" aria-hidden="true"></div>
        <strong>Awaiting first bid</strong>
        <span>Opening at ${fmtMoney(current.base_price)}</span>
        <small>Next minimum: ${fmtMoney(nextBid)}</small>
      </aside>`;
  container.innerHTML = `
    <div class="spotlight fifa-card ${cardTierClass(current.card_tier)}">
      ${ovrBadgeHtml(current)}
      <img class="spotlight-player-photo" src="${current.photo_url || placeholderImg()}" alt="${escapeHtml(current.name)}">
      <div class="info">
        <span class="badge badge-auction">Up for auction now</span>
        <h2>${escapeHtml(current.name)}</h2>
        <span class="badge position-badge">${escapeHtml(current.role || 'Player')}</span>
        <div class="muted spotlight-base-price">Base price: ${fmtMoney(current.base_price)}</div>
        <div class="bid-amount-display" aria-live="polite">${fmtMoney(bidAmount)}</div>
        <div class="bid-leading">${current.current_bid_team_name ? `Leading team: <b>${escapeHtml(current.current_bid_team_name)}</b>` : 'No bids yet — starting at base price'}</div>
        ${statGridHtml(current)}
        ${current.stats ? `<p class="muted">${escapeHtml(current.stats)}</p>` : ''}
      </div>
      ${leadingBidHtml}
    </div>`;

  const historyContainer = document.getElementById('bidHistory');
  historyContainer.innerHTML = current.history && current.history.length
    ? current.history.map(h => `
        <div class="bid-history-item">
          <span class="bid-history-team">
            <img src="${bidTeamLogo(h.team_id)}" alt="">
            ${escapeHtml(h.team_name || 'Unknown team')}
          </span>
          <span class="player-price">${fmtMoney(h.amount)}</span>
        </div>`).join('')
    : `<div class="bid-history-empty">No bids placed yet for this player.</div>`;
}

function renderAuctionDashboard() {
  const soldPlayers = state.players.filter(player => player.status === 'sold');
  const waitingPlayers = state.players.filter(player => player.status === 'waiting');
  const totalSpent = state.teams.reduce((sum, team) => sum + (team.purse_total - team.purse_remaining), 0);
  const activeTeams = state.teams.filter(team => team.squad.length > 0).length;
  const overview = document.getElementById('auctionOverview');
  const liveNewsContent = document.getElementById('liveNewsContent');
  const nextUp = document.getElementById('nextUp');
  const nextPlayer = waitingPlayers[0];

  overview.innerHTML = `
    <div class="overview-stats">
      <div><span>Players sold</span><strong>${soldPlayers.length}</strong></div>
      <div><span>Players remaining</span><strong>${waitingPlayers.length}</strong></div>
      <div><span>Total spent</span><strong>${fmtMoney(totalSpent)}</strong></div>
      <div><span>Active teams</span><strong>${activeTeams}</strong></div>
    </div>`;

  liveNewsContent.textContent = `Auction update: ${soldPlayers.length} sold, ${waitingPlayers.length} remaining in the player pool`;

  nextUp.innerHTML = nextPlayer
    ? `
      <div class="next-player">
        <img src="${nextPlayer.photo_url || placeholderImg()}" alt="${escapeHtml(nextPlayer.name)}">
        <div>
          <strong>${escapeHtml(nextPlayer.name)}</strong>
          <span>${escapeHtml(nextPlayer.role || 'Player')}</span>
          <small>Base price: ${fmtMoney(nextPlayer.base_price)}</small>
        </div>
      </div>`
    : `<div class="next-player-empty">No waiting players in the pool.</div>`;
}

function renderTeamsList() {
  const container = document.getElementById('teamsList');
  if (!state.teams.length) { container.innerHTML = `<div class="empty">No teams yet.</div>`; return; }
  container.innerHTML = state.teams.map(t => {
    const pct = t.purse_total ? Math.round((t.purse_remaining / t.purse_total) * 100) : 0;
    const purseHue = Math.round(Math.max(0, Math.min(pct, 100)) * 1.35);
    const purseColor = `hsl(${purseHue} 78% 52%)`;
    const squad = Array.isArray(t.squad) ? t.squad : [];
    const playerSlots = Array.from({ length: t.slots_max }, (_, index) => {
      const player = squad[index];
      return player
        ? `<img src="${player.photo_url || placeholderImg()}" alt="${escapeHtml(player.name)}">`
        : '<span aria-hidden="true"></span>';
    }).join('');
    return `
      <div class="team-card">
        <div class="team-header">
          <img class="team-logo" src="${t.logo_url || placeholderImg()}" alt="">
          <div>
            <div class="team-name">${escapeHtml(t.name)}</div>
            <div class="team-player-slots" role="img" aria-label="${squad.length} of ${t.slots_max} player slots filled">${playerSlots}</div>
          </div>
        </div>
        <div class="purse-overview">
          <div class="compact-purse-percent" style="--purse-color:${purseColor};">${pct}%</div>
          <div class="purse-details">
            <span>${fmtMoney(t.purse_remaining)} remaining</span>
            <small>${squad.length}/${t.slots_max} player slots filled</small>
          </div>
        </div>
        <div class="purse-bar" aria-hidden="true"><div class="purse-bar-fill" style="width:${pct}%; background:${purseColor};"></div></div>
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

// ---------- Topbar live news ticker ----------
// A general-purpose scrolling strip in the middle of the topbar. To add more
// items later (e.g. "biggest steal", "most expensive team", a custom
// announcement), just write another buildXyzTickerItem() function that
// returns a string (or null to skip when there's nothing to show) and push
// it into tickerBuilders below — no other changes needed.

function buildHighestSaleTickerItem() {
  const soldPlayers = state.players.filter(p => p.status === 'sold' && p.sold_price);
  if (!soldPlayers.length) return null;
  const top = soldPlayers.reduce((best, p) => (p.sold_price > best.sold_price ? p : best));
  return `\u{1F3C6} Highest bid so far: ${top.name} → ${top.team_name || 'Unknown team'} for ${fmtMoney(top.sold_price)}`;
}

function buildCurrentAuctionTickerItem() {
  const current = state.currentAuction;
  if (!current) return null;
  const bidAmount = current.current_bid_amount || current.base_price;
  const leader = current.current_bid_team_name ? ` with ${current.current_bid_team_name}` : ' at opening price';
  return `LIVE: ${current.name} is at ${fmtMoney(bidAmount)}${leader}`;
}

function buildAuctionProgressTickerItem() {
  const soldCount = state.players.filter(p => p.status === 'sold').length;
  const waitingCount = state.players.filter(p => p.status === 'waiting').length;
  if (!state.players.length) return null;
  return `Auction update: ${soldCount} sold, ${waitingCount} remaining in the player pool`;
}

const tickerBuilders = [
  buildCurrentAuctionTickerItem,
  buildHighestSaleTickerItem,
  buildAuctionProgressTickerItem,
];

let tickerAnimation = null;
let tickerRenderVersion = 0;

function renderTicker() {
  const items = tickerBuilders.map(build => build()).filter(Boolean);
  const text = items.length
    ? items.join('     ★     ')
    : '\u{1F4E2} Live updates will appear here as players are auctioned...';

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

    const pixelsPerSecond = 52;
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

function tierIncrement(amount) {
  if (amount < 100000) return 10000;
  if (amount < 500000) return 25000;
  if (amount < 1000000) return 50000;
  if (amount < 5000000) return 100000;
  return 250000;
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
