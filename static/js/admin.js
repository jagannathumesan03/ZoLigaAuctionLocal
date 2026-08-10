let state = {
  players: [], teams: [], currentAuction: null, selectedBidTeamId: null, lastAuctionPlayerId: null,
  callState: null, // { call: 'going_once' | 'going_twice', playerId, expiresAt } -- ephemeral, never persisted
};

// ---------- Auth guard ----------
(async function guard() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error();
    const data = await res.json();
    if (data.role !== 'admin') { window.location.href = '/viewer'; return; }
    document.getElementById('whoami').textContent = `Signed in as ${data.username}`;
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

// ---------- Toast ----------
function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = 'Request failed';
    try { detail = (await res.json()).detail || detail; } catch (e) {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

// ---------- Init / data load ----------
async function init() {
  await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
  renderAll();
  connectSSE();

  document.getElementById('auctionSearch').addEventListener('input', renderAuctionList);
  document.getElementById('playerSearch').addEventListener('input', renderPlayersList);
  document.getElementById('playerStatusFilter').addEventListener('change', renderPlayersList);

  document.getElementById('playerForm').addEventListener('submit', submitPlayerForm);
  document.getElementById('teamForm').addEventListener('submit', submitTeamForm);
  document.getElementById('assignForm').addEventListener('submit', submitAssignForm);

  setInterval(() => {
    document.querySelectorAll('[data-ts]').forEach(el => {
      const ts = el.getAttribute('data-ts');
      if (ts) el.textContent = relativeTime(ts);
    });
  }, 5000);
}

async function loadPlayers() {
  state.players = await apiFetch('/api/players');
}
async function loadTeams() {
  state.teams = await apiFetch('/api/teams');
}
async function loadCurrentAuction() {
  state.currentAuction = await apiFetch('/api/auction/current');
  const newId = state.currentAuction ? state.currentAuction.id : null;
  if (newId !== state.lastAuctionPlayerId) {
    // a different player (or no player) is now up for auction — clear the stale team selection
    state.selectedBidTeamId = null;
    state.lastAuctionPlayerId = newId;
  }
}

function renderAll() {
  renderSpotlight();
  renderBidPanel();
  renderAuctionList();
  renderPlayersList();
  renderTeamsList();
}

// ---------- SSE ----------
let knownSoldPlayerIds = null;

function connectSSE() {
  const es = new EventSource('/api/events');
  const refresh = async () => {
    state.callState = null;
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
  es.addEventListener('auction_call', (e) => {
    try { setCallState(JSON.parse(e.data)); } catch (err) { /* ignore malformed payload */ }
  });
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

// ---------- Ephemeral auctioneer call ("Going once" / "Going twice") ----------
// Broadcast-only, never persisted -- see backend/routers/auction.py's /call
// endpoint. Cleared automatically after a few seconds, or immediately once a
// new bid/sale/reset event arrives (handled in connectSSE's refresh()).
function setCallState(data) {
  state.callState = { call: data.call, playerId: data.player_id, expiresAt: Date.now() + 4000 };
  renderSpotlight();
  setTimeout(() => {
    if (state.callState && state.callState.expiresAt <= Date.now()) {
      state.callState = null;
      renderSpotlight();
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
async function announceCall(call) {
  const current = state.currentAuction;
  if (!current) return;
  try {
    await apiFetch('/api/auction/call', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: current.id, call }),
    });
  } catch (e) { toast(e.message, true); }
}
function markGoingOnce() { announceCall('going_once'); }
function markGoingTwice() { announceCall('going_twice'); }

// ---------- Spotlight ----------
// The hero of the operator screen too -- name and current bid dominate;
// everything else (base price, leading team, stats) supports them.
function renderSpotlight() {
  const container = document.getElementById('spotlight');
  const current = state.currentAuction;
  document.getElementById('bidPanelWrapper').style.display = current ? 'block' : 'none';
  if (!current) {
    container.innerHTML = `
      <div class="spotlight spotlight-waiting">
        <div class="empty-state">No player currently up for auction. Pick one below.</div>
      </div>`;
    return;
  }
  const bidAmount = current.current_bid_amount || current.base_price;
  const hasBids = !!current.current_bid_team_id;
  const call = activeCallState();
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
          <div class="bid-amount-display" aria-live="polite">${fmtMoney(bidAmount)}</div>
        </div>
        <div class="leading-team-row${hasBids ? ' has-leader' : ''}">
          ${hasBids
            ? `<span class="leading-team-name">${escapeHtml(current.current_bid_team_name || 'Unknown team')}</span><span class="leading-chip">Leading</span>`
            : `<span class="muted">No bids yet — starting at base price</span>`}
        </div>
        ${statBarsHtml(current)}
        ${current.stats ? `<p class="muted">${escapeHtml(current.stats)}</p>` : ''}
        <div class="player-actions">
          <button class="btn btn-sm" type="button" onclick="markGoingOnce()">Going once</button>
          <button class="btn btn-sm" type="button" onclick="markGoingTwice()">Going twice</button>
          <button class="btn btn-warn btn-sm" type="button" onclick="markUnsold(${current.id})">Mark unsold</button>
        </div>
      </div>
    </div>`;
}

// ---------- Live bidding panel ----------
function tierIncrement(amount) {
  if (amount < 100000) return 10000;
  if (amount < 500000) return 25000;
  if (amount < 1000000) return 50000;
  if (amount < 5000000) return 100000;
  return 250000;
}

function renderBidPanel() {
  const wrapper = document.getElementById('bidPanel');
  const current = state.currentAuction;
  if (!current) { wrapper.innerHTML = ''; return; }

  // default the selection to whoever is currently leading, if the admin hasn't picked yet
  if (!state.selectedBidTeamId && current.current_bid_team_id) {
    state.selectedBidTeamId = current.current_bid_team_id;
  }

  const bidAmount = current.current_bid_amount || current.base_price;
  const inc = tierIncrement(bidAmount);
  const tiers = [inc, inc * 2, inc * 5];
  const eligibleTeams = state.teams.filter(t => t.squad.length < t.slots_max);

  const teamButtonsHtml = state.teams.map(t => {
    const full = t.squad.length >= t.slots_max;
    const active = state.selectedBidTeamId === t.id;
    return `<button type="button" class="btn team-bid-btn ${active ? 'active' : ''}" aria-pressed="${active}" ${full ? 'disabled' : ''} onclick="selectBidTeam(${t.id})">
      ${escapeHtml(t.name)}${full ? ' <small>(full)</small>' : ''}
    </button>`;
  }).join('');

  const tierButtonsHtml = tiers.map(delta => `
    <button type="button" class="btn bid-tier-btn" ${eligibleTeams.length ? '' : 'disabled'} onclick="quickBid(${delta})">
      ${fmtMoney(bidAmount + delta)}
      <small>+${fmtMoney(delta)}</small>
    </button>
  `).join('');

  const bidHistoryItems = (current.history || []).map(h => `
        <div class="bid-history-item">
          <span>${escapeHtml(h.team_name || 'Unknown team')}</span>
          <span class="player-price">${fmtMoney(h.amount)}</span>
          <span class="bid-history-time" data-ts="${h.created_at || ''}">${relativeTime(h.created_at)}</span>
        </div>`).join('');
  const startingBidItem = `
        <div class="bid-history-item bid-history-start">
          <span>Starting bid</span>
          <span class="player-price">${fmtMoney(current.base_price)}</span>
          <span class="bid-history-time"></span>
        </div>`;
  const historyHtml = startingBidItem + bidHistoryItems;

  wrapper.innerHTML = `
    <div class="bid-summary"><span>Current bid</span><strong>${fmtMoney(bidAmount)}</strong><span>Minimum next bid: ${fmtMoney(bidAmount + inc)}</span></div>
    <label>Choose the bidding team</label>
    <div class="bid-team-buttons">${teamButtonsHtml}</div>
    <label>Quick raise</label>
    <div class="bid-tier-buttons">${tierButtonsHtml}</div>
    <label>Custom increment (1 - 1,000,000)</label>
    <div class="bid-stepper">
      <input type="number" id="bidCustomIncrement" min="1" max="1000000" value="10000">
      <button type="button" class="btn btn-primary btn-sm" ${eligibleTeams.length ? '' : 'disabled'} onclick="customBid()">+ Add to bid</button>
    </div>
    <label>Bid history</label>
    <div class="bid-history-log">${historyHtml}</div>
    <div class="row mt-16">
      <button type="button" class="btn btn-primary" onclick="openAssignModal(${current.id})">Finalize Sale</button>
    </div>
  `;
}

function selectBidTeam(teamId) {
  state.selectedBidTeamId = state.selectedBidTeamId === teamId ? null : teamId;
  renderBidPanel();
}

function selectedBidTeam() {
  if (!state.selectedBidTeamId) { toast('Pick a team before placing a bid', true); return null; }
  return state.selectedBidTeamId;
}

async function quickBid(delta) {
  const teamId = selectedBidTeam();
  if (!teamId) return;
  const current = state.currentAuction;
  const bidAmount = current.current_bid_amount || current.base_price;
  await placeBid(teamId, bidAmount + delta);
}

async function customBid() {
  const teamId = selectedBidTeam();
  if (!teamId) return;
  const incrementInput = document.getElementById('bidCustomIncrement');
  const increment = parseInt(incrementInput.value);
  if (!increment || increment < 1 || increment > 1000000) {
    toast('Enter an increment between 1 and 1,000,000', true);
    return;
  }
  const current = state.currentAuction;
  const bidAmount = current.current_bid_amount || current.base_price;
  await placeBid(teamId, bidAmount + increment);
}

async function placeBid(teamId, amount) {
  try {
    await apiFetch('/api/auction/bid', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: state.currentAuction.id, team_id: teamId, amount }),
    });
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    renderAll();
    const team = state.teams.find(candidate => candidate.id === teamId);
    toast(`Bid recorded: ${team ? team.name : 'Team'} at ${fmtMoney(amount)}`);
  } catch (e) { toast(e.message, true); }
}

// ---------- Auction tab: pick next player ----------
function renderAuctionList() {
  const q = document.getElementById('auctionSearch').value.toLowerCase();
  const list = state.players.filter(p =>
    (p.status === 'waiting' || p.status === 'unsold') &&
    (p.name.toLowerCase().includes(q) || (p.role || '').toLowerCase().includes(q))
  );
  const container = document.getElementById('auctionPlayerList');
  if (!list.length) { container.innerHTML = `<div class="empty">No players waiting.</div>`; return; }
  container.innerHTML = list.map(p => `
    <div class="player-card fifa-card ${cardTierClass(p.card_tier)}">
      ${ovrBadgeHtml(p)}
      <img class="player-photo" src="${p.photo_url || placeholderImg()}" alt="">
      <div class="player-name">${escapeHtml(p.name)}</div>
      <div class="player-meta">${escapeHtml(p.role || '')}</div>
      <div class="player-price">${fmtMoney(p.base_price)}</div>
      ${statusBadge(p.status)}
      ${statGridHtml(p)}
      <div class="player-actions">
        <button class="btn btn-primary btn-sm" onclick="setCurrent(${p.id})">Put Up for Auction</button>
      </div>
    </div>
  `).join('');
}

async function setCurrent(playerId) {
  try {
    await apiFetch('/api/auction/set-current', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: playerId }),
    });
    toast('Player is now up for auction');
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    renderAll();
    document.querySelector('.tab[data-tab="auction"]').click();
  } catch (e) { toast(e.message, true); }
}

async function markUnsold(playerId) {
  try {
    await apiFetch('/api/auction/unsold', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: playerId }),
    });
    toast('Player marked unsold');
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    renderAll();
  } catch (e) { toast(e.message, true); }
}

async function undoPlayer(playerId) {
  if (!confirm('Undo this assignment and return the player to the waiting pool?')) return;
  try {
    await apiFetch('/api/auction/undo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: playerId }),
    });
    toast('Reverted');
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    renderAll();
  } catch (e) { toast(e.message, true); }
}

// ---------- Players tab ----------
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
      <div class="player-actions">
        <button class="btn btn-sm" onclick="openPlayerModal(${p.id})">Edit</button>
        ${p.status !== 'sold' ? `<button class="btn btn-primary btn-sm" onclick="openAssignModal(${p.id})">Assign</button>` : ''}
        ${p.status === 'sold' || p.status === 'unsold' ? `<button class="btn btn-warn btn-sm" onclick="undoPlayer(${p.id})">Undo</button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deletePlayer(${p.id})">Delete</button>
      </div>
    </div>
  `).join('');
}

function openPlayerModal(id) {
  const form = document.getElementById('playerForm');
  form.reset();
  document.getElementById('playerId').value = id || '';
  document.getElementById('playerModalTitle').textContent = id ? 'Edit Player' : 'Add Player';
  if (id) {
    const p = state.players.find(x => x.id === id);
    document.getElementById('playerName').value = p.name;
    document.getElementById('playerRole').value = p.role || 'Forward';
    document.getElementById('playerBasePrice').value = p.base_price;
    document.getElementById('playerStats').value = p.stats || '';
    document.getElementById('playerPace').value = p.pace ?? 50;
    document.getElementById('playerShooting').value = p.shooting ?? 50;
    document.getElementById('playerPassing').value = p.passing ?? 50;
    document.getElementById('playerDribbling').value = p.dribbling ?? 50;
    document.getElementById('playerDefending').value = p.defending ?? 50;
    document.getElementById('playerPhysical').value = p.physical ?? 50;
  }
  document.getElementById('playerModalOverlay').style.display = 'flex';
}
function closePlayerModal() { document.getElementById('playerModalOverlay').style.display = 'none'; }

async function submitPlayerForm(e) {
  e.preventDefault();
  const id = document.getElementById('playerId').value;
  const fd = new FormData();
  fd.append('name', document.getElementById('playerName').value);
  fd.append('role', document.getElementById('playerRole').value);
  fd.append('base_price', document.getElementById('playerBasePrice').value);
  fd.append('stats', document.getElementById('playerStats').value);
  fd.append('pace', document.getElementById('playerPace').value);
  fd.append('shooting', document.getElementById('playerShooting').value);
  fd.append('passing', document.getElementById('playerPassing').value);
  fd.append('dribbling', document.getElementById('playerDribbling').value);
  fd.append('defending', document.getElementById('playerDefending').value);
  fd.append('physical', document.getElementById('playerPhysical').value);
  const photo = document.getElementById('playerPhoto').files[0];
  if (photo) fd.append('photo', photo);

  try {
    await apiFetch(id ? `/api/players/${id}` : '/api/players', {
      method: id ? 'PUT' : 'POST', body: fd,
    });
    toast('Player saved');
    closePlayerModal();
    await loadPlayers();
    renderAll();
  } catch (e) { toast(e.message, true); }
}

async function deletePlayer(id) {
  if (!confirm('Delete this player permanently?')) return;
  try {
    await apiFetch(`/api/players/${id}`, { method: 'DELETE' });
    toast('Player deleted');
    await loadPlayers();
    renderAll();
  } catch (e) { toast(e.message, true); }
}

async function uploadCsv(event) {
  const file = event.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const result = await apiFetch('/api/players/bulk-csv', { method: 'POST', body: fd });
    toast(`Imported ${result.created} players` + (result.errors.length ? ` (${result.errors.length} errors)` : ''));
    await loadPlayers();
    renderAll();
  } catch (e) { toast(e.message, true); }
  event.target.value = '';
}

// ---------- Teams tab ----------
function renderTeamsList() {
  const container = document.getElementById('teamsList');
  if (!state.teams.length) { container.innerHTML = `<div class="empty">No teams yet.</div>`; return; }
  container.innerHTML = state.teams.map(t => {
    const pct = t.purse_total ? Math.round((t.purse_remaining / t.purse_total) * 100) : 0;
    const squadHtml = t.squad.map(p => `
      <div class="squad-item">
        <span>${escapeHtml(p.name)} <span class="muted">(${escapeHtml(p.role || '')})</span></span>
        <span class="player-price">${fmtMoney(p.sold_price)}</span>
      </div>`).join('');
    const emptySlots = Math.max(t.slots_max - t.squad.length, 0);
    const emptyHtml = Array.from({ length: emptySlots }).map(() => `<div class="squad-slot-empty">Empty slot</div>`).join('');
    return `
      <div class="team-card">
        <div class="team-header">
          <img class="team-logo" src="${t.logo_url || placeholderImg()}" alt="">
          <div>
            <div class="team-name">${escapeHtml(t.name)}</div>
            <div class="team-purse">${t.squad.length}/${t.slots_max} players</div>
          </div>
          <div style="margin-left:auto; display:flex; gap:6px;">
            <button class="btn btn-sm" onclick="openTeamModal(${t.id})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteTeam(${t.id})">Delete</button>
          </div>
        </div>
        <div class="team-purse">Purse: ${fmtMoney(t.purse_remaining)} / ${fmtMoney(t.purse_total)}</div>
        <div class="purse-bar"><div class="purse-bar-fill" style="width:${pct}%"></div></div>
        <div class="squad-list">${squadHtml}${emptyHtml}</div>
      </div>`;
  }).join('');
}

function openTeamModal(id) {
  const form = document.getElementById('teamForm');
  form.reset();
  document.getElementById('teamId').value = id || '';
  document.getElementById('teamModalTitle').textContent = id ? 'Edit Team' : 'Add Team';
  if (id) {
    const t = state.teams.find(x => x.id === id);
    document.getElementById('teamName').value = t.name;
    document.getElementById('teamPurse').value = t.purse_total;
    document.getElementById('teamSlots').value = t.slots_max;
  } else {
    document.getElementById('teamPurse').value = 10000000;
    document.getElementById('teamSlots').value = 7;
  }
  document.getElementById('teamModalOverlay').style.display = 'flex';
}
function closeTeamModal() { document.getElementById('teamModalOverlay').style.display = 'none'; }

async function submitTeamForm(e) {
  e.preventDefault();
  const id = document.getElementById('teamId').value;
  const fd = new FormData();
  fd.append('name', document.getElementById('teamName').value);
  fd.append('purse_total', document.getElementById('teamPurse').value);
  fd.append('slots_max', document.getElementById('teamSlots').value);
  const logo = document.getElementById('teamLogo').files[0];
  if (logo) fd.append('logo', logo);

  try {
    await apiFetch(id ? `/api/teams/${id}` : '/api/teams', {
      method: id ? 'PUT' : 'POST', body: fd,
    });
    toast('Team saved');
    closeTeamModal();
    await loadTeams();
    renderAll();
  } catch (e) { toast(e.message, true); }
}

async function deleteTeam(id) {
  if (!confirm('Delete this team?')) return;
  try {
    await apiFetch(`/api/teams/${id}`, { method: 'DELETE' });
    toast('Team deleted');
    await loadTeams();
    renderAll();
  } catch (e) { toast(e.message, true); }
}

// ---------- Assign modal ----------
function openAssignModal(playerId) {
  const p = state.players.find(x => x.id === playerId);
  const isLiveCurrent = state.currentAuction && state.currentAuction.id === playerId;
  const liveBidAmount = isLiveCurrent ? (state.currentAuction.current_bid_amount || state.currentAuction.base_price) : null;
  const liveTeamId = isLiveCurrent ? state.currentAuction.current_bid_team_id : null;

  document.getElementById('assignPlayerId').value = playerId;
  document.getElementById('assignPlayerName').textContent = isLiveCurrent
    ? `${p.name} — current live bid ${fmtMoney(liveBidAmount)}`
    : `${p.name} — base price ${fmtMoney(p.base_price)}`;
  const select = document.getElementById('assignTeamId');
  select.innerHTML = state.teams.map(t =>
    `<option value="${t.id}" ${t.squad.length >= t.slots_max ? 'disabled' : ''} ${liveTeamId && t.id === liveTeamId ? 'selected' : ''}>
      ${escapeHtml(t.name)} (${t.squad.length}/${t.slots_max} slots, purse ${fmtMoney(t.purse_remaining)})
    </option>`
  ).join('');
  document.getElementById('assignSoldPrice').value = liveBidAmount || p.base_price;
  document.getElementById('assignModalOverlay').style.display = 'flex';
}
function closeAssignModal() { document.getElementById('assignModalOverlay').style.display = 'none'; }

async function submitAssignForm(e) {
  e.preventDefault();
  const player_id = parseInt(document.getElementById('assignPlayerId').value);
  const team_id = parseInt(document.getElementById('assignTeamId').value);
  const sold_price = parseInt(document.getElementById('assignSoldPrice').value);
  try {
    await apiFetch('/api/auction/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id, team_id, sold_price }),
    });
    toast('Player assigned!');
    closeAssignModal();
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    renderAll();
  } catch (e) { toast(e.message, true); }
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
// shared by the player-pool cards, the auction queue cards, and the spotlight.
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
// Compact bar-meter version used in the spotlight hero, where the six
// sub-stats need to be scannable without competing with the name/bid.
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

function setConnectionStatus(isConnected) {
  document.querySelectorAll('.connection-state').forEach(element => {
    element.lastChild.textContent = isConnected ? ' Live updates connected' : ' Reconnecting live updates';
    element.classList.toggle('is-reconnecting', !isConnected);
  });
}
