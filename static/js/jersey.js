const DEFAULT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const DEFAULT_FIELDS = {
  team: { enabled: true, required: true },
  player_name: { enabled: true, required: false },
  jersey_number: { enabled: true, required: false },
  size: { enabled: true, required: true },
  custom: [],
  order: ['team', 'player_name', 'jersey_number', 'size'],
};

const state = {
  teams: [],
  jerseySizeChartUrl: '',
  jerseySizes: DEFAULT_SIZES.slice(),
  jerseyFormFields: JSON.parse(JSON.stringify(DEFAULT_FIELDS)),
};

const jerseyUi = {
  teamId: '',
  wired: false,
};

let pendingOrder = null;

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
    state.jerseyFormFields = data.jersey_form_fields || JSON.parse(JSON.stringify(DEFAULT_FIELDS));
  } catch (e) {
    state.jerseySizeChartUrl = '';
    state.jerseySizes = DEFAULT_SIZES.slice();
    state.jerseyFormFields = JSON.parse(JSON.stringify(DEFAULT_FIELDS));
  }
}

function fieldConfig(key) {
  const fields = state.jerseyFormFields || DEFAULT_FIELDS;
  return fields[key] || DEFAULT_FIELDS[key] || { enabled: true, required: false };
}

function customFieldDefs() {
  const fields = state.jerseyFormFields || DEFAULT_FIELDS;
  return Array.isArray(fields.custom) ? fields.custom : [];
}

function applyJerseyFormFields() {
  const map = [
    ['team', 'jerseyFieldTeam'],
    ['player_name', 'jerseyFieldName'],
    ['jersey_number', 'jerseyFieldNumber'],
    ['size', 'jerseyFieldSize'],
  ];
  map.forEach(([key, wrapId]) => {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    const cfg = fieldConfig(key);
    wrap.style.display = cfg.enabled ? '' : 'none';
    const input = wrap.querySelector('input, select');
    if (input) {
      if (cfg.required) input.setAttribute('aria-required', 'true');
      else input.removeAttribute('aria-required');
    }
  });
  renderCustomJerseyFields();
  applyJerseyFieldOrder();
}

function fieldOrderList() {
  const fields = state.jerseyFormFields || DEFAULT_FIELDS;
  const customKeys = customFieldDefs().map(c => `custom:${c.id}`);
  const fallback = ['team', 'player_name', 'jersey_number', 'size'].concat(customKeys);
  const order = Array.isArray(fields.order) && fields.order.length ? fields.order.slice() : fallback.slice();
  fallback.forEach(key => {
    if (!order.includes(key)) order.push(key);
  });
  return order;
}

function applyJerseyFieldOrder() {
  const order = fieldOrderList();
  const submit = document.querySelector('.jersey-submit-field');
  order.forEach((key, index) => {
    let el = null;
    if (key === 'team') el = document.getElementById('jerseyFieldTeam');
    else if (key === 'player_name') el = document.getElementById('jerseyFieldName');
    else if (key === 'jersey_number') el = document.getElementById('jerseyFieldNumber');
    else if (key === 'size') el = document.getElementById('jerseyFieldSize');
    else if (key.startsWith('custom:')) {
      el = document.querySelector(`[data-custom-field-wrap="${key.slice(7)}"]`);
    }
    if (el) el.style.order = String(index);
  });
  if (submit) submit.style.order = String(order.length + 10);
}

function renderCustomJerseyFields() {
  const wrap = document.getElementById('jerseyCustomFields');
  if (!wrap) return;
  const previous = {};
  wrap.querySelectorAll('[data-custom-field-id]').forEach(input => {
    previous[input.dataset.customFieldId] = input.value;
  });
  const defs = customFieldDefs().filter(f => f.enabled !== false);
  if (!defs.length) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = defs.map(field => {
    const value = previous[field.id] || '';
    return `
      <div class="field" data-custom-field-wrap="${escapeHtml(field.id)}">
        <label for="jerseyCustom_${escapeHtml(field.id)}">${escapeHtml(field.label || field.id)}</label>
        <input type="text" id="jerseyCustom_${escapeHtml(field.id)}" data-custom-field-id="${escapeHtml(field.id)}" value="${escapeHtml(value)}" autocomplete="off">
      </div>`;
  }).join('');
}

function collectCustomFieldValues() {
  const values = {};
  const errors = [];
  customFieldDefs().forEach(field => {
    if (field.enabled === false) return;
    const input = document.getElementById(`jerseyCustom_${field.id}`);
    const value = (input && input.value || '').trim();
    if (field.required && !value) {
      errors.push(`${field.label || field.id} is required.`);
      return;
    }
    if (value) values[field.id] = value;
  });
  return { values, errors };
}

function setupJerseyForm() {
  if (jerseyUi.wired) return;
  const select = document.getElementById('jerseyTeamSelect');
  const nameInput = document.getElementById('jerseyPlayerName');
  const numberInput = document.getElementById('jerseyNumber');
  const sizeInput = document.getElementById('jerseySize');
  const submitBtn = document.getElementById('jerseySubmitBtn');
  const cancelBtn = document.getElementById('jerseyConfirmCancel');
  const okBtn = document.getElementById('jerseyConfirmOk');
  const overlay = document.getElementById('jerseyConfirmOverlay');
  if (!select || !nameInput || !numberInput || !sizeInput || !submitBtn) return;

  select.addEventListener('change', () => {
    jerseyUi.teamId = select.value;
    paintJerseyPreview();
  });
  nameInput.addEventListener('input', updateJerseyOverlays);
  numberInput.addEventListener('input', updateJerseyOverlays);
  submitBtn.addEventListener('click', openJerseyConfirm);
  if (cancelBtn) cancelBtn.addEventListener('click', closeJerseyConfirm);
  if (okBtn) okBtn.addEventListener('click', confirmAndSubmitJerseyOrder);
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeJerseyConfirm();
    });
  }
  jerseyUi.wired = true;
}

function openJerseyConfirm() {
  const statusEl = document.getElementById('jerseySubmitStatus');
  const select = document.getElementById('jerseyTeamSelect');
  const nameInput = document.getElementById('jerseyPlayerName');
  const numberInput = document.getElementById('jerseyNumber');
  const sizeInput = document.getElementById('jerseySize');
  const teamId = Number(jerseyUi.teamId || (select && select.value) || 0);
  const nameCfg = fieldConfig('player_name');
  const numberCfg = fieldConfig('jersey_number');
  const sizeCfg = fieldConfig('size');
  const playerName = nameCfg.enabled ? (nameInput && nameInput.value || '').trim() : '';
  const jerseyNumber = numberCfg.enabled ? (numberInput && numberInput.value || '').trim() : '';
  const size = sizeCfg.enabled ? (sizeInput && sizeInput.value || '').trim() : '';

  const setStatus = (msg, isError = false) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('is-error', !!isError);
  };

  if (!teamId) { setStatus('Select a team first.', true); return; }
  if (nameCfg.enabled && nameCfg.required && !playerName) {
    setStatus('Enter the name for the jersey.', true); return;
  }
  if (numberCfg.enabled && numberCfg.required && !jerseyNumber) {
    setStatus('Enter a jersey number.', true); return;
  }
  if (sizeCfg.enabled && sizeCfg.required && !size) {
    setStatus('Choose a jersey size.', true); return;
  }
  const custom = collectCustomFieldValues();
  if (custom.errors.length) {
    setStatus(custom.errors[0], true); return;
  }

  const team = state.teams.find(t => String(t.id) === String(teamId));
  const teamName = team ? team.name : 'Selected team';
  pendingOrder = {
    team_id: teamId,
    player_name: playerName,
    jersey_number: jerseyNumber,
    size,
    extra_fields: custom.values,
  };

  const summary = document.getElementById('jerseyConfirmSummary');
  if (summary) {
    const lines = [`<strong>${escapeHtml(teamName)}</strong>`];
    if (nameCfg.enabled) {
      lines.push(`Name: ${playerName ? escapeHtml(playerName) : '<em>none</em>'}`);
    }
    if (numberCfg.enabled) {
      lines.push(`Number: ${jerseyNumber ? escapeHtml(jerseyNumber) : '<em>none</em>'}`);
    }
    if (sizeCfg.enabled) {
      lines.push(`Size: ${size ? `<strong>${escapeHtml(size)}</strong>` : '<em>none</em>'}`);
    }
    customFieldDefs().filter(f => f.enabled !== false).forEach(field => {
      const value = custom.values[field.id] || '';
      lines.push(`${escapeHtml(field.label || field.id)}: ${value ? escapeHtml(value) : '<em>none</em>'}`);
    });
    summary.innerHTML = lines.join('<br>');
  }
  const overlay = document.getElementById('jerseyConfirmOverlay');
  if (overlay) overlay.style.display = 'flex';
  setStatus('');
}

function closeJerseyConfirm() {
  pendingOrder = null;
  const overlay = document.getElementById('jerseyConfirmOverlay');
  if (overlay) overlay.style.display = 'none';
}

async function confirmAndSubmitJerseyOrder() {
  if (!pendingOrder) return;
  const order = pendingOrder;
  const statusEl = document.getElementById('jerseySubmitStatus');
  const submitBtn = document.getElementById('jerseySubmitBtn');
  const okBtn = document.getElementById('jerseyConfirmOk');

  const setStatus = (msg, isError = false) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.classList.toggle('is-error', !!isError);
  };

  closeJerseyConfirm();
  if (submitBtn) submitBtn.disabled = true;
  if (okBtn) okBtn.disabled = true;
  setStatus('Submitting order…');
  try {
    await apiFetch('/api/jersey-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    const extras = order.extra_fields || {};
    const extraLabel = Object.values(extras).filter(Boolean).join(' · ');
    const label = [
      order.player_name || null,
      order.jersey_number ? `#${order.jersey_number}` : null,
      order.size || null,
      extraLabel || null,
    ].filter(Boolean).join(' · ');
    setStatus(label ? `Order saved: ${label}` : 'Order saved.');
  } catch (err) {
    setStatus(err.message || 'Could not save jersey order', true);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (okBtn) okBtn.disabled = false;
  }
}

function renderJerseyPage() {
  const select = document.getElementById('jerseyTeamSelect');
  if (!select) return;

  applyJerseyFormFields();
  fillJerseySizeOptions();

  const signature = state.teams.map(t =>
    `${t.id}:${t.jersey_front_url || ''}:${t.jersey_back_url || ''}:${t.shorts_url || ''}:${t.name}`
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
  const shorts = team.shorts_url || '';
  const paintKey = `kit-v2|${team.id}|${front}|${back}|${shorts}`;
  if (!front && !back && !shorts) {
    preview.dataset.paintKey = paintKey;
    preview.innerHTML = `<p class="muted jersey-empty">No kit uploaded yet for ${escapeHtml(team.name)}.</p>`;
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
            <svg class="jersey-name-arch" viewBox="0 0 220 64" preserveAspectRatio="xMidYMid meet">
              <defs>
                <path id="jerseyNameArc-${team.id}" d="M 12 48 Q 110 8 208 48" fill="none"></path>
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
  if (shorts) {
    sides.push(`
      <div class="jersey-side">
        <p class="jersey-side-label">Shorts</p>
        <div class="jersey-image-wrap jersey-image-wrap-shorts">
          <img src="${shorts}" alt="${escapeHtml(team.name)} shorts">
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
