const DEFAULT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];

const state = {
  teams: [],
  jerseySizeChartUrl: '',
  jerseySizes: DEFAULT_SIZES.slice(),
};

const jerseyUi = {
  teamId: '',
  wired: false,
};

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = 'Request failed';
    try { detail = (await res.json()).detail || detail; } catch (e) {}
    throw new Error(typeof detail === 'string' ? detail : 'Request failed');
  }
  return res.status === 204 ? null : res.json();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function init() {
  setupJerseyForm();
  await Promise.all([loadTeams(), loadJerseySettings()]);
  renderJerseyPage();
}

async function loadTeams() {
  state.teams = await apiFetch('/api/teams/public');
}

async function loadJerseySettings() {
  try {
    const data = await apiFetch('/api/settings/jersey-public');
    state.jerseySizeChartUrl = data.jersey_size_chart_url || '';
    state.jerseySizes = Array.isArray(data.jersey_sizes) && data.jersey_sizes.length
      ? data.jersey_sizes
      : DEFAULT_SIZES.slice();
  } catch (e) {
    state.jerseySizeChartUrl = '';
    state.jerseySizes = DEFAULT_SIZES.slice();
  }
}

function setupJerseyForm() {
  if (jerseyUi.wired) return;
  const select = document.getElementById('jerseyTeamSelect');
  const nameInput = document.getElementById('jerseyPlayerName');
  const numberInput = document.getElementById('jerseyNumber');
  const sizeInput = document.getElementById('jerseySize');
  const submitBtn = document.getElementById('jerseySubmitBtn');
  if (!select || !nameInput || !numberInput || !sizeInput || !submitBtn) return;

  select.addEventListener('change', () => {
    jerseyUi.teamId = select.value;
    paintJerseyPreview();
  });
  nameInput.addEventListener('input', updateJerseyOverlays);
  numberInput.addEventListener('input', updateJerseyOverlays);
  submitBtn.addEventListener('click', submitJerseyOrder);
  jerseyUi.wired = true;
}

async function submitJerseyOrder() {
  const statusEl = document.getElementById('jerseySubmitStatus');
  const select = document.getElementById('jerseyTeamSelect');
  const nameInput = document.getElementById('jerseyPlayerName');
  const numberInput = document.getElementById('jerseyNumber');
  const sizeInput = document.getElementById('jerseySize');
  const submitBtn = document.getElementById('jerseySubmitBtn');
  const teamId = Number(jerseyUi.teamId || (select && select.value) || 0);
  const playerName = (nameInput && nameInput.value || '').trim();
  const jerseyNumber = (numberInput && numberInput.value || '').trim();
  const size = (sizeInput && sizeInput.value || '').trim();

  const setStatus = (msg, isError = false) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('is-error', !!isError);
  };

  if (!teamId) { setStatus('Select a team first.', true); return; }
  if (!playerName) { setStatus('Enter the name for the jersey.', true); return; }
  if (!size) { setStatus('Choose a jersey size.', true); return; }

  if (submitBtn) submitBtn.disabled = true;
  setStatus('Submitting order…');
  try {
    await apiFetch('/api/jersey-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: teamId,
        player_name: playerName,
        jersey_number: jerseyNumber,
        size,
      }),
    });
    setStatus(`Order saved: ${playerName}${jerseyNumber ? ` #${jerseyNumber}` : ''} · ${size}`);
  } catch (err) {
    setStatus(err.message || 'Could not save jersey order', true);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function renderJerseyPage() {
  const select = document.getElementById('jerseyTeamSelect');
  if (!select) return;

  fillJerseySizeOptions();

  const signature = state.teams.map(t =>
    `${t.id}:${t.jersey_front_url || ''}:${t.jersey_back_url || ''}:${t.name}`
  ).join('|');
  const selection = jerseyUi.teamId || select.value;

  if (select.dataset.teamSignature !== signature) {
    select.innerHTML = `<option value="">Select a team…</option>${state.teams.map(t =>
      `<option value="${t.id}">${escapeHtml(t.name)}</option>`
    ).join('')}`;
    if (selection && state.teams.some(t => String(t.id) === String(selection))) {
      select.value = String(selection);
      jerseyUi.teamId = String(selection);
    } else if (jerseyUi.teamId && !state.teams.some(t => String(t.id) === String(jerseyUi.teamId))) {
      jerseyUi.teamId = '';
      select.value = '';
    }
    select.dataset.teamSignature = signature;
  } else if (selection && select.value !== String(selection)) {
    select.value = String(selection);
  }

  paintJerseyPreview();
}

function fillJerseySizeOptions() {
  const sizeInput = document.getElementById('jerseySize');
  if (!sizeInput) return;
  const sizes = Array.isArray(state.jerseySizes) && state.jerseySizes.length
    ? state.jerseySizes
    : DEFAULT_SIZES;
  const signature = sizes.join('|');
  const previous = sizeInput.value;
  if (sizeInput.dataset.sizeSignature === signature) {
    if (previous && sizes.includes(previous)) sizeInput.value = previous;
    return;
  }
  sizeInput.innerHTML = `<option value="">Select size…</option>${sizes.map(s =>
    `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`
  ).join('')}`;
  if (previous && sizes.includes(previous)) sizeInput.value = previous;
  sizeInput.dataset.sizeSignature = signature;
}

function paintJerseyPreview() {
  const preview = document.getElementById('jerseyPreview');
  if (!preview) return;

  const teamId = jerseyUi.teamId || (document.getElementById('jerseyTeamSelect') || {}).value;
  if (!teamId) {
    const chartUrl = state.jerseySizeChartUrl || '';
    const paintKey = `size-chart|${chartUrl}`;
    if (preview.dataset.paintKey === paintKey) return;
    preview.dataset.paintKey = paintKey;
    if (chartUrl) {
      preview.innerHTML = `
        <div class="jersey-size-chart">
          <p class="jersey-side-label">Size chart</p>
          <img src="${escapeHtml(chartUrl)}" alt="Jersey size chart">
        </div>`;
    } else {
      preview.innerHTML = `<p class="muted jersey-empty">Select a team to preview its jersey.</p>`;
    }
    return;
  }

  const team = state.teams.find(t => String(t.id) === String(teamId));
  if (!team) {
    preview.dataset.paintKey = '';
    preview.innerHTML = `<p class="muted jersey-empty">Select a team to preview its jersey.</p>`;
    return;
  }

  const front = team.jersey_front_url || '';
  const back = team.jersey_back_url || '';
  const paintKey = `back-only-v1|${team.id}|${front}|${back}`;
  if (!front && !back) {
    preview.dataset.paintKey = paintKey;
    preview.innerHTML = `<p class="muted jersey-empty">No jersey uploaded yet for ${escapeHtml(team.name)}.</p>`;
    return;
  }

  if (preview.dataset.paintKey === paintKey && preview.querySelector('.jersey-preview-grid')) {
    updateJerseyOverlays();
    return;
  }

  const name = ((document.getElementById('jerseyPlayerName') || {}).value || '').trim().toUpperCase();
  const number = ((document.getElementById('jerseyNumber') || {}).value || '').trim();
  const sides = [];
  if (front) {
    sides.push(`
      <div class="jersey-side">
        <p class="jersey-side-label">Front</p>
        <div class="jersey-image-wrap">
          <img src="${front}" alt="${escapeHtml(team.name)} jersey front">
        </div>
      </div>`);
  }
  if (back) {
    sides.push(`
      <div class="jersey-side">
        <p class="jersey-side-label">Back</p>
        <div class="jersey-image-wrap jersey-image-wrap-back">
          <img src="${back}" alt="${escapeHtml(team.name)} jersey back">
          <div class="jersey-back-print" aria-hidden="true">
            <svg class="jersey-name-arch" viewBox="0 0 220 48" preserveAspectRatio="xMidYMid meet">
              <defs>
                <path id="jerseyNameArc-${team.id}" d="M 18 38 Q 110 4 202 38" fill="none"></path>
              </defs>
              <text class="jersey-name-arch-text">
                <textPath href="#jerseyNameArc-${team.id}" startOffset="50%" text-anchor="middle">
                  <tspan data-jersey-name>${escapeHtml(name)}</tspan>
                </textPath>
              </text>
            </svg>
            <span class="jersey-overlay jersey-overlay-number" data-jersey-number>${escapeHtml(number)}</span>
          </div>
        </div>
      </div>`);
  }
  preview.innerHTML = `<div class="jersey-preview-grid">${sides.join('')}</div>`;
  preview.dataset.paintKey = paintKey;
}

function updateJerseyOverlays() {
  const name = ((document.getElementById('jerseyPlayerName') || {}).value || '').trim();
  const number = ((document.getElementById('jerseyNumber') || {}).value || '').trim();
  document.querySelectorAll('[data-jersey-name]').forEach(el => { el.textContent = name.toUpperCase(); });
  document.querySelectorAll('[data-jersey-number]').forEach(el => { el.textContent = number; });
}

init();
