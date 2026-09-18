let state = {
  players: [], teams: [], currentAuction: null, selectedBidTeamId: null, lastAuctionPlayerId: null,
  callState: null, // { call: 'going_once' | 'going_twice', playerId, expiresAt } -- ephemeral, never persisted
  auctionTimerSeconds: 120,
  auctionTimerEnabled: true,
  waitingBackgroundUrl: '',
  jerseySizeChartUrl: '',
  shortsSizeChartUrl: '',
  jerseySizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'],
  shortsSizes: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
  jerseyFormFields: {
    team: { enabled: true, required: true },
    player_name: { enabled: true, required: false },
    jersey_number: { enabled: true, required: false },
    size: { enabled: true, required: true },
    sleeve_length: { enabled: true, required: true },
    custom: [],
    order: ['team', 'player_name', 'jersey_number', 'size', 'sleeve_length'],
  },
  startingAuction: false,
  draftBidAmount: null,
  draftBidAuctionId: null,
  draftBidFloor: null,
  selectedPlayerIds: new Set(),
  jerseyOrders: [],
};

// Tracks whether we've finished the first paint so a mid-session player
// change can fire the pack-reveal animation (same as viewer).
let auctionBaselineReady = false;
let packRevealInProgress = false;

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
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body.detail === 'string') detail = body.detail;
      else if (Array.isArray(body.detail)) {
        detail = body.detail.map(d => d.msg || JSON.stringify(d)).join('; ') || detail;
      }
    } catch (e) {
      if (res.status === 413) {
        detail = 'File too large for the server. Compress the image (under ~5 MB) and try again.';
      }
    }
    throw new Error(typeof detail === 'string' ? detail : 'Request failed');
  }
  return res.status === 204 ? null : res.json();
}

// ---------- Init / data load ----------
async function init() {
  await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction(), loadSettings(), loadJerseyOrders()]);
  state.lastAuctionPlayerId = state.currentAuction ? state.currentAuction.id : null;
  auctionBaselineReady = true;
  renderAll();
  connectSSE();

  document.getElementById('playerSearch').addEventListener('input', renderPlayersList);
  document.getElementById('playerStatusFilter').addEventListener('change', renderPlayersList);
  document.getElementById('playerRoleFilter').addEventListener('change', renderPlayersList);
  document.getElementById('playerStarsFilter').addEventListener('change', renderPlayersList);

  const jerseySearch = document.getElementById('jerseyOrderSearch');
  const jerseyTeamFilter = document.getElementById('jerseyOrderTeamFilter');
  const jerseyKitFilter = document.getElementById('jerseyOrderKitFilter');
  const jerseySizeFilter = document.getElementById('jerseyOrderSizeFilter');
  if (jerseySearch) jerseySearch.addEventListener('input', renderJerseyOrders);
  if (jerseyTeamFilter) jerseyTeamFilter.addEventListener('change', renderJerseyOrders);
  if (jerseyKitFilter) jerseyKitFilter.addEventListener('change', renderJerseyOrders);
  if (jerseySizeFilter) jerseySizeFilter.addEventListener('change', renderJerseyOrders);

  document.getElementById('playerForm').addEventListener('submit', submitPlayerForm);
  document.getElementById('teamForm').addEventListener('submit', submitTeamForm);
  document.getElementById('assignForm').addEventListener('submit', submitAssignForm);
  document.getElementById('settingsForm').addEventListener('submit', submitSettingsForm);
  document.getElementById('timerEnabled').addEventListener('change', () => {
    state.auctionTimerEnabled = !!document.getElementById('timerEnabled').checked;
    fillSettingsForm();
  });

  setInterval(() => {
    document.querySelectorAll('[data-ts]').forEach(el => {
      const ts = el.getAttribute('data-ts');
      if (ts) el.textContent = relativeTime(ts);
    });
  }, 5000);
  setInterval(tickAuctionTimer, 250);
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
  }
}

async function loadSettings() {
  const data = await apiFetch('/api/settings');
  state.auctionTimerSeconds = data.auction_timer_seconds || 120;
  state.auctionTimerEnabled = data.auction_timer_enabled !== false;
  state.waitingBackgroundUrl = data.waiting_background_url || '';
  state.jerseySizeChartUrl = data.jersey_size_chart_url || '';
  state.shortsSizeChartUrl = data.shorts_size_chart_url || '';
  state.jerseySizes = Array.isArray(data.jersey_sizes) && data.jersey_sizes.length
    ? data.jersey_sizes
    : ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
  state.shortsSizes = Array.isArray(data.shorts_sizes) && data.shorts_sizes.length
    ? data.shorts_sizes
    : ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
  if (data.jersey_form_fields) state.jerseyFormFields = data.jersey_form_fields;
  fillSettingsForm();
}

async function loadJerseyOrders() {
  state.jerseyOrders = await apiFetch('/api/jersey-orders');
}

function formatJerseyWhen(value) {
  if (!value) return '—';
  const raw = String(value).includes('T') || String(value).includes('Z')
    ? value
    : String(value).replace(' ', 'T') + 'Z';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function jerseyCustomColumns() {
  const fields = state.jerseyFormFields || {};
  const customDefs = Array.isArray(fields.custom) ? fields.custom.slice() : [];
  const byId = Object.fromEntries(customDefs.map(c => [c.id, c]));
  const columns = [];
  const seen = new Set();

  const order = Array.isArray(fields.order) ? fields.order : [];
  order.forEach(key => {
    if (!key || !String(key).startsWith('custom:')) return;
    const id = String(key).slice(7);
    if (!id || seen.has(id) || !byId[id]) return;
    seen.add(id);
    columns.push({ id, label: byId[id].label || id });
  });
  customDefs.forEach(c => {
    if (!c || !c.id || seen.has(c.id)) return;
    seen.add(c.id);
    columns.push({ id: c.id, label: c.label || c.id });
  });

  // Keep historical custom keys from existing orders even if the field was removed.
  (state.jerseyOrders || []).forEach(o => {
    const extras = o.extra_fields || {};
    Object.keys(extras).forEach(id => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      columns.push({ id, label: id });
    });
  });

  return columns;
}

function fillJerseyOrderFilters() {
  const orders = state.jerseyOrders || [];
  const teamSelect = document.getElementById('jerseyOrderTeamFilter');
  const sizeSelect = document.getElementById('jerseyOrderSizeFilter');

  if (teamSelect) {
    const prev = teamSelect.value;
    const teams = [...new Map(
      orders
        .filter(o => o.team_id != null)
        .map(o => [String(o.team_id), o.team_name || `Team ${o.team_id}`])
    ).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    teamSelect.innerHTML = `<option value="">All teams</option>${teams.map(([id, name]) =>
      `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`
    ).join('')}`;
    if (prev && teams.some(([id]) => id === prev)) teamSelect.value = prev;
  }

  if (sizeSelect) {
    const prev = sizeSelect.value;
    const sizes = [...new Set(
      orders.map(o => (o.size || '').trim()).filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    sizeSelect.innerHTML = `<option value="">All sizes</option>${sizes.map(s =>
      `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`
    ).join('')}`;
    if (prev && sizes.includes(prev)) sizeSelect.value = prev;
  }
}

function filteredJerseyOrders() {
  const orders = state.jerseyOrders || [];
  const q = ((document.getElementById('jerseyOrderSearch') || {}).value || '').trim().toLowerCase();
  const teamId = ((document.getElementById('jerseyOrderTeamFilter') || {}).value || '').trim();
  const kit = ((document.getElementById('jerseyOrderKitFilter') || {}).value || '').trim().toLowerCase();
  const size = ((document.getElementById('jerseyOrderSizeFilter') || {}).value || '').trim();

  return orders.filter(o => {
    if (teamId && String(o.team_id) !== teamId) return false;
    const kitType = (o.kit_type || 'home').toLowerCase() === 'away' ? 'away' : 'home';
    if (kit && kitType !== kit) return false;
    if (size && String(o.size || '') !== size) return false;
    if (!q) return true;
    const extras = o.extra_fields || {};
    const hay = [
      o.team_name,
      o.player_name,
      o.jersey_number,
      o.size,
      o.sleeve_length,
      o.shorts_size,
      kitType,
      ...Object.values(extras),
    ].map(v => String(v || '').toLowerCase()).join(' ');
    return hay.includes(q);
  });
}

function renderJerseyOrders() {
  const tbody = document.getElementById('jerseyOrdersList');
  const thead = document.getElementById('jerseyOrdersHead');
  const countEl = document.getElementById('jerseyOrderCount');
  if (!tbody) return;
  fillJerseyOrderFilters();
  const allOrders = state.jerseyOrders || [];
  const orders = filteredJerseyOrders();
  const customCols = jerseyCustomColumns();
  const colCount = 9 + customCols.length;
  const filtered = orders.length !== allOrders.length
    || !!((document.getElementById('jerseyOrderSearch') || {}).value || '').trim()
    || !!((document.getElementById('jerseyOrderTeamFilter') || {}).value || '')
    || !!((document.getElementById('jerseyOrderKitFilter') || {}).value || '')
    || !!((document.getElementById('jerseyOrderSizeFilter') || {}).value || '');

  if (countEl) {
    if (!allOrders.length) {
      countEl.textContent = '0 orders';
    } else if (filtered) {
      countEl.textContent = `Showing ${orders.length} of ${allOrders.length} order${allOrders.length === 1 ? '' : 's'}`;
    } else {
      countEl.textContent = allOrders.length === 1 ? '1 order' : `${allOrders.length} orders`;
    }
  }

  if (thead) {
    thead.innerHTML = `<tr>
      <th>When</th>
      <th>Team</th>
      <th>Kit</th>
      <th>Name</th>
      <th>Number</th>
      <th>Jersey</th>
      <th>Sleeve</th>
      <th>Shorts</th>
      ${customCols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}
      <th></th>
    </tr>`;
  }

  if (!allOrders.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="muted">No jersey orders yet.</td></tr>`;
    return;
  }

  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="muted">No orders match these filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = orders.map(o => {
    const extras = o.extra_fields || {};
    const customCells = customCols.map(c =>
      `<td>${escapeHtml(extras[c.id] || '—')}</td>`
    ).join('');
    return `
    <tr>
      <td>${escapeHtml(formatJerseyWhen(o.created_at))}</td>
      <td>
        <span class="jersey-order-team">
          <img src="${o.team_logo_url || placeholderImg()}" alt="">
          ${escapeHtml(o.team_name || 'Team')}
        </span>
      </td>
      <td>${escapeHtml((o.kit_type || 'home') === 'away' ? 'Away' : 'Home')}</td>
      <td>${escapeHtml(o.player_name || '—')}</td>
      <td>${escapeHtml(o.jersey_number || '—')}</td>
      <td><strong>${escapeHtml(o.size || '—')}</strong></td>
      <td>${escapeHtml(o.sleeve_length || '—')}</td>
      <td>${escapeHtml(o.shorts_size || '—')}</td>
      ${customCells}
      <td>
        <button class="btn btn-sm btn-danger" type="button" onclick="deleteJerseyOrder(${o.id})">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

function exportJerseyOrdersCsv() {
  window.location.href = '/api/jersey-orders/export';
}

async function deleteJerseyOrder(id) {
  if (!confirm('Delete this jersey order?')) return;
  try {
    await apiFetch(`/api/jersey-orders/${id}`, { method: 'DELETE' });
    toast('Jersey order deleted');
    await loadJerseyOrders();
    renderJerseyOrders();
  } catch (e) { toast(e.message, true); }
}

function fillSettingsForm() {
  const total = state.auctionTimerSeconds || 120;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const minutesEl = document.getElementById('timerMinutes');
  const secondsEl = document.getElementById('timerSeconds');
  const enabledEl = document.getElementById('timerEnabled');
  const durationFields = document.getElementById('timerDurationFields');
  if (minutesEl) minutesEl.value = minutes;
  if (secondsEl) secondsEl.value = seconds;
  if (enabledEl) enabledEl.checked = !!state.auctionTimerEnabled;
  if (durationFields) durationFields.style.opacity = state.auctionTimerEnabled ? '1' : '0.45';
  if (minutesEl) minutesEl.disabled = !state.auctionTimerEnabled;
  if (secondsEl) secondsEl.disabled = !state.auctionTimerEnabled;
  renderWaitingBgPreview();
  renderJerseySizeChartPreview();
  renderShortsSizeChartPreview();
  const sizesInput = document.getElementById('jerseySizesInput');
  if (sizesInput) sizesInput.value = (state.jerseySizes || []).join('\n');
  const shortsSizesInput = document.getElementById('shortsSizesInput');
  if (shortsSizesInput) shortsSizesInput.value = (state.shortsSizes || []).join('\n');
  fillJerseyFormFieldsConfig();
}

function fillJerseyFormFieldsConfig() {
  const fields = state.jerseyFormFields || {};
  const customById = Object.fromEntries((fields.custom || []).map(c => [c.id, c]));
  const defaultOrder = ['team', 'player_name', 'jersey_number', 'size', 'sleeve_length']
    .concat((fields.custom || []).map(c => `custom:${c.id}`));
  const order = Array.isArray(fields.order) && fields.order.length ? fields.order.slice() : defaultOrder;
  defaultOrder.forEach(key => {
    if (!order.includes(key)) order.push(key);
  });

  const builtinMeta = {
    team: { label: 'Team', locked: true },
    player_name: { label: 'Player name', locked: false },
    jersey_number: { label: 'Number', locked: false },
    size: { label: 'Size', locked: false },
    sleeve_length: { label: 'Sleeve length', locked: false },
  };

  const wrap = document.getElementById('jerseyFieldsSortable');
  if (!wrap) return;

  const rows = order.map((key, index) => {
    if (key.startsWith('custom:')) {
      const id = key.slice(7);
      const field = customById[id] || { id, label: 'Custom field', enabled: true, required: false };
      return `
        <div class="jersey-fields-config-row jersey-fields-config-sortable" data-field-key="${escapeHtml(key)}" data-sort-index="${index}">
          <span class="jersey-field-drag" title="Drag to reorder" aria-hidden="true">⠿</span>
          <input type="text" class="jersey-custom-label-input" value="${escapeHtml(field.label || '')}" placeholder="Field label" aria-label="Custom field label" data-custom-id="${escapeHtml(field.id || id)}">
          <label><input type="checkbox" class="jersey-field-enabled" ${field.enabled !== false ? 'checked' : ''}></label>
          <label><input type="checkbox" class="jersey-field-required" ${field.required ? 'checked' : ''} ${field.enabled === false ? 'disabled' : ''}></label>
          <button type="button" class="btn btn-sm btn-danger" data-remove-custom="${escapeHtml(field.id || id)}">Remove</button>
        </div>`;
    }
    const meta = builtinMeta[key] || { label: key, locked: false };
    const cfg = fields[key] || { enabled: true, required: false };
    const enabledChecked = key === 'team' || cfg.enabled !== false;
    const requiredChecked = key === 'team' || (!!cfg.required && cfg.enabled !== false);
    return `
      <div class="jersey-fields-config-row jersey-fields-config-sortable" data-field-key="${escapeHtml(key)}" data-sort-index="${index}">
        <span class="jersey-field-drag" title="Drag to reorder" aria-hidden="true">⠿</span>
        <span>${escapeHtml(meta.label)}</span>
        <label><input type="checkbox" class="jersey-field-enabled" data-builtin-key="${escapeHtml(key)}" ${enabledChecked ? 'checked' : ''} ${meta.locked ? 'disabled' : ''}></label>
        <label><input type="checkbox" class="jersey-field-required" data-builtin-key="${escapeHtml(key)}" ${requiredChecked ? 'checked' : ''} ${meta.locked || cfg.enabled === false ? 'disabled' : ''}></label>
        <span></span>
      </div>`;
  }).join('');

  wrap.innerHTML = rows;
  wireJerseyFieldRowControls(wrap);
  wireJerseyFieldsDrag(wrap);
}

function wireJerseyFieldRowControls(wrap) {
  wrap.querySelectorAll('.jersey-fields-config-sortable').forEach(row => {
    const enabledEl = row.querySelector('.jersey-field-enabled');
    const requiredEl = row.querySelector('.jersey-field-required');
    if (enabledEl && requiredEl && !enabledEl.disabled) {
      enabledEl.addEventListener('change', () => {
        if (!enabledEl.checked) requiredEl.checked = false;
        requiredEl.disabled = !enabledEl.checked;
      });
    }
    const removeBtn = row.querySelector('[data-remove-custom]');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        removeJerseyCustomField(removeBtn.getAttribute('data-remove-custom'));
      });
    }
  });
}

function wireJerseyFieldsDrag(wrap) {
  let dragEl = null;
  wrap.querySelectorAll('.jersey-fields-config-sortable').forEach(row => {
    row.draggable = false;
    const handle = row.querySelector('.jersey-field-drag');
    if (handle) {
      handle.addEventListener('mousedown', () => { row.draggable = true; });
      handle.addEventListener('mouseup', () => { row.draggable = false; });
    }
    row.addEventListener('dragstart', (e) => {
      if (!row.draggable) {
        e.preventDefault();
        return;
      }
      dragEl = row;
      row.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.dataset.fieldKey || '');
      }
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
      row.draggable = false;
      wrap.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
      dragEl = null;
      state.jerseyFormFields = readJerseyFormFieldsFromDom();
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      const target = e.currentTarget;
      if (!dragEl || target === dragEl) return;
      target.classList.add('drag-over');
      const children = [...wrap.querySelectorAll('.jersey-fields-config-sortable')];
      const dragIndex = children.indexOf(dragEl);
      const targetIndex = children.indexOf(target);
      if (dragIndex < targetIndex) wrap.insertBefore(dragEl, target.nextSibling);
      else wrap.insertBefore(dragEl, target);
    });
    row.addEventListener('dragleave', (e) => {
      e.currentTarget.classList.remove('drag-over');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove('drag-over');
    });
  });
}

function addJerseyCustomField() {
  const fields = readJerseyFormFieldsFromDom();
  const id = `field_${Date.now().toString(36)}`;
  fields.custom.push({
    id,
    label: 'New field',
    enabled: true,
    required: false,
  });
  if (!Array.isArray(fields.order)) fields.order = [];
  fields.order.push(`custom:${id}`);
  state.jerseyFormFields = fields;
  fillJerseyFormFieldsConfig();
  const inputs = document.querySelectorAll('#jerseyFieldsSortable .jersey-custom-label-input');
  const last = inputs[inputs.length - 1];
  if (last) {
    last.focus();
    last.select();
  }
}

function removeJerseyCustomField(fieldId) {
  const fields = readJerseyFormFieldsFromDom();
  fields.custom = (fields.custom || []).filter(c => c.id !== fieldId);
  fields.order = (fields.order || []).filter(key => key !== `custom:${fieldId}`);
  state.jerseyFormFields = fields;
  fillJerseyFormFieldsConfig();
}

function readJerseyFormFieldsFromDom() {
  const builtin = {
    team: { enabled: true, required: true },
    player_name: { enabled: true, required: false },
    jersey_number: { enabled: true, required: false },
    size: { enabled: true, required: true },
    sleeve_length: { enabled: true, required: true },
  };
  const custom = [];
  const order = [];

  document.querySelectorAll('#jerseyFieldsSortable .jersey-fields-config-sortable').forEach(row => {
    const key = row.dataset.fieldKey || '';
    if (!key) return;
    order.push(key);
    if (key.startsWith('custom:')) {
      const labelEl = row.querySelector('.jersey-custom-label-input');
      const enabledEl = row.querySelector('.jersey-field-enabled');
      const requiredEl = row.querySelector('.jersey-field-required');
      const label = (labelEl && labelEl.value || '').trim();
      if (!label) return;
      const enabled = enabledEl ? !!enabledEl.checked : true;
      custom.push({
        id: (labelEl && labelEl.dataset.customId) || key.slice(7),
        label,
        enabled,
        required: enabled && requiredEl ? !!requiredEl.checked : false,
      });
      return;
    }
    const enabledEl = row.querySelector('.jersey-field-enabled');
    const requiredEl = row.querySelector('.jersey-field-required');
    const enabled = key === 'team' ? true : (enabledEl ? !!enabledEl.checked : true);
    const required = key === 'team' ? true : (enabled && requiredEl ? !!requiredEl.checked : false);
    builtin[key] = { enabled, required };
  });

  return {
    ...builtin,
    custom,
    order,
  };
}

function renderWaitingBgPreview() {
  const preview = document.getElementById('waitingBgPreview');
  const empty = document.getElementById('waitingBgEmpty');
  const clearBtn = document.getElementById('waitingBgClearBtn');
  if (!preview) return;
  const url = state.waitingBackgroundUrl;
  if (url) {
    preview.style.backgroundImage = `url("${url}")`;
    preview.classList.add('has-image');
    if (empty) empty.style.display = 'none';
    if (clearBtn) clearBtn.style.display = '';
  } else {
    preview.style.backgroundImage = '';
    preview.classList.remove('has-image');
    if (empty) empty.style.display = '';
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

function renderJerseySizeChartPreview() {
  const preview = document.getElementById('jerseySizeChartPreview');
  const empty = document.getElementById('jerseySizeChartEmpty');
  const clearBtn = document.getElementById('jerseySizeChartClearBtn');
  if (!preview) return;
  const url = state.jerseySizeChartUrl;
  if (url) {
    preview.style.backgroundImage = `url("${url}")`;
    preview.classList.add('has-image');
    if (empty) empty.style.display = 'none';
    if (clearBtn) clearBtn.style.display = '';
  } else {
    preview.style.backgroundImage = '';
    preview.classList.remove('has-image');
    if (empty) empty.style.display = '';
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

function renderShortsSizeChartPreview() {
  const preview = document.getElementById('shortsSizeChartPreview');
  const empty = document.getElementById('shortsSizeChartEmpty');
  const clearBtn = document.getElementById('shortsSizeChartClearBtn');
  if (!preview) return;
  const url = state.shortsSizeChartUrl;
  if (url) {
    preview.style.backgroundImage = `url("${url}")`;
    preview.classList.add('has-image');
    if (empty) empty.style.display = 'none';
    if (clearBtn) clearBtn.style.display = '';
  } else {
    preview.style.backgroundImage = '';
    preview.classList.remove('has-image');
    if (empty) empty.style.display = '';
    if (clearBtn) clearBtn.style.display = 'none';
  }
}

async function submitSettingsForm(e) {
  e.preventDefault();
  const enabled = !!document.getElementById('timerEnabled').checked;
  const minutes = parseInt(document.getElementById('timerMinutes').value, 10) || 0;
  const seconds = parseInt(document.getElementById('timerSeconds').value, 10) || 0;
  const total = Math.max(5, minutes * 60 + seconds);
  const status = document.getElementById('settingsStatus');
  try {
    const data = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auction_timer_seconds: total,
        auction_timer_enabled: enabled,
      }),
    });
    state.auctionTimerSeconds = data.auction_timer_seconds;
    state.auctionTimerEnabled = data.auction_timer_enabled !== false;
    state.waitingBackgroundUrl = data.waiting_background_url || state.waitingBackgroundUrl;
    state.jerseySizeChartUrl = data.jersey_size_chart_url || state.jerseySizeChartUrl;
    state.shortsSizeChartUrl = data.shorts_size_chart_url || state.shortsSizeChartUrl;
    if (Array.isArray(data.jersey_sizes) && data.jersey_sizes.length) state.jerseySizes = data.jersey_sizes;
    if (Array.isArray(data.shorts_sizes) && data.shorts_sizes.length) state.shortsSizes = data.shorts_sizes;
    fillSettingsForm();
    status.textContent = enabled
      ? 'Saved — timer applies to the next player put up for auction.'
      : 'Saved — auction timer is disabled.';
    toast(enabled ? 'Auction timer updated' : 'Auction timer disabled');
    renderAll();
  } catch (err) {
    status.textContent = '';
    toast(err.message, true);
  }
}

async function saveJerseySizes() {
  const status = document.getElementById('jerseySizesStatus');
  const raw = (document.getElementById('jerseySizesInput') || {}).value || '';
  const sizes = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  if (!sizes.length) {
    if (status) status.textContent = 'Add at least one size.';
    toast('Add at least one jersey size', true);
    return;
  }
  try {
    const enabled = !!document.getElementById('timerEnabled').checked;
    const minutes = parseInt(document.getElementById('timerMinutes').value, 10) || 0;
    const seconds = parseInt(document.getElementById('timerSeconds').value, 10) || 0;
    const total = Math.max(5, minutes * 60 + seconds);
    const data = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auction_timer_seconds: total,
        auction_timer_enabled: enabled,
        jersey_sizes: sizes,
      }),
    });
    state.jerseySizes = data.jersey_sizes || sizes;
    state.jerseySizeChartUrl = data.jersey_size_chart_url || state.jerseySizeChartUrl;
    state.shortsSizeChartUrl = data.shorts_size_chart_url || state.shortsSizeChartUrl;
    if (Array.isArray(data.shorts_sizes) && data.shorts_sizes.length) state.shortsSizes = data.shorts_sizes;
    if (data.jersey_form_fields) state.jerseyFormFields = data.jersey_form_fields;
    fillSettingsForm();
    if (status) status.textContent = `Saved ${state.jerseySizes.length} size(s).`;
    toast('Jersey sizes updated');
  } catch (err) {
    if (status) status.textContent = '';
    toast(err.message, true);
  }
}

async function saveShortsSizes() {
  const status = document.getElementById('shortsSizesStatus');
  const raw = (document.getElementById('shortsSizesInput') || {}).value || '';
  const sizes = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  if (!sizes.length) {
    if (status) status.textContent = 'Add at least one size.';
    toast('Add at least one shorts size', true);
    return;
  }
  try {
    const enabled = !!document.getElementById('timerEnabled').checked;
    const minutes = parseInt(document.getElementById('timerMinutes').value, 10) || 0;
    const seconds = parseInt(document.getElementById('timerSeconds').value, 10) || 0;
    const total = Math.max(5, minutes * 60 + seconds);
    const data = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auction_timer_seconds: total,
        auction_timer_enabled: enabled,
        shorts_sizes: sizes,
      }),
    });
    state.shortsSizes = data.shorts_sizes || sizes;
    state.shortsSizeChartUrl = data.shorts_size_chart_url || state.shortsSizeChartUrl;
    state.jerseySizeChartUrl = data.jersey_size_chart_url || state.jerseySizeChartUrl;
    if (Array.isArray(data.jersey_sizes) && data.jersey_sizes.length) state.jerseySizes = data.jersey_sizes;
    fillSettingsForm();
    if (status) status.textContent = `Saved ${state.shortsSizes.length} size(s).`;
    toast('Shorts sizes updated');
  } catch (err) {
    if (status) status.textContent = '';
    toast(err.message, true);
  }
}

async function saveJerseyFormFields() {
  const status = document.getElementById('jerseyFieldsStatus');
  const fields = readJerseyFormFieldsFromDom();
  try {
    const enabled = !!document.getElementById('timerEnabled').checked;
    const minutes = parseInt(document.getElementById('timerMinutes').value, 10) || 0;
    const seconds = parseInt(document.getElementById('timerSeconds').value, 10) || 0;
    const total = Math.max(5, minutes * 60 + seconds);
    const data = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auction_timer_seconds: total,
        auction_timer_enabled: enabled,
        jersey_form_fields: fields,
      }),
    });
    if (data.jersey_form_fields) state.jerseyFormFields = data.jersey_form_fields;
    fillSettingsForm();
    renderJerseyOrders();
    if (status) status.textContent = 'Field options saved.';
    toast('Jersey field options updated');
  } catch (err) {
    if (status) status.textContent = '';
    toast(err.message, true);
  }
}

async function uploadWaitingBackground(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    toast('Image is too large (max ~8 MB). Compress it and try again.', true);
    return;
  }
  const form = new FormData();
  form.append('photo', file);
  try {
    const res = await fetch('/api/settings/waiting-background', { method: 'POST', body: form });
    if (!res.ok) {
      let detail = `Upload failed (${res.status})`;
      try {
        const body = await res.json();
        if (typeof body.detail === 'string') detail = body.detail;
        else if (Array.isArray(body.detail)) {
          detail = body.detail.map(d => d.msg || JSON.stringify(d)).join('; ') || detail;
        }
      } catch (e) {
        if (res.status === 413) detail = 'File too large for the server. Compress the image and try again.';
      }
      throw new Error(detail);
    }
    const data = await res.json();
    state.waitingBackgroundUrl = data.waiting_background_url || '';
    renderWaitingBgPreview();
    renderSpotlight();
    toast('Waiting desk background updated');
  } catch (err) {
    toast(err.message, true);
  }
}

async function clearWaitingBackground() {
  try {
    const data = await apiFetch('/api/settings/waiting-background', { method: 'DELETE' });
    state.waitingBackgroundUrl = data.waiting_background_url || '';
    renderWaitingBgPreview();
    renderSpotlight();
    toast('Waiting desk background removed');
  } catch (err) {
    toast(err.message, true);
  }
}

async function uploadJerseySizeChart(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    toast('Image is too large (max ~8 MB). Compress it and try again.', true);
    return;
  }
  const form = new FormData();
  form.append('photo', file);
  try {
    const res = await fetch('/api/settings/jersey-size-chart', { method: 'POST', body: form });
    if (!res.ok) {
      let detail = `Upload failed (${res.status})`;
      try {
        const body = await res.json();
        if (typeof body.detail === 'string') detail = body.detail;
        else if (Array.isArray(body.detail)) {
          detail = body.detail.map(d => d.msg || JSON.stringify(d)).join('; ') || detail;
        }
      } catch (e) {
        if (res.status === 413) detail = 'File too large for the server. Compress the image and try again.';
      }
      throw new Error(detail);
    }
    const data = await res.json();
    state.jerseySizeChartUrl = data.jersey_size_chart_url || '';
    state.shortsSizeChartUrl = data.shorts_size_chart_url || state.shortsSizeChartUrl;
    if (Array.isArray(data.jersey_sizes) && data.jersey_sizes.length) state.jerseySizes = data.jersey_sizes;
    if (Array.isArray(data.shorts_sizes) && data.shorts_sizes.length) state.shortsSizes = data.shorts_sizes;
    renderJerseySizeChartPreview();
    toast('Jersey size chart updated');
  } catch (err) {
    toast(err.message, true);
  }
}

async function clearJerseySizeChart() {
  try {
    const data = await apiFetch('/api/settings/jersey-size-chart', { method: 'DELETE' });
    state.jerseySizeChartUrl = data.jersey_size_chart_url || '';
    renderJerseySizeChartPreview();
    toast('Jersey size chart removed');
  } catch (err) {
    toast(err.message, true);
  }
}

async function uploadShortsSizeChart(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    toast('Image is too large (max ~8 MB). Compress it and try again.', true);
    return;
  }
  const form = new FormData();
  form.append('photo', file);
  try {
    const res = await fetch('/api/settings/shorts-size-chart', { method: 'POST', body: form });
    if (!res.ok) {
      let detail = `Upload failed (${res.status})`;
      try {
        const body = await res.json();
        if (typeof body.detail === 'string') detail = body.detail;
        else if (Array.isArray(body.detail)) {
          detail = body.detail.map(d => d.msg || JSON.stringify(d)).join('; ') || detail;
        }
      } catch (e) {
        if (res.status === 413) detail = 'File too large for the server. Compress the image and try again.';
      }
      throw new Error(detail);
    }
    const data = await res.json();
    state.shortsSizeChartUrl = data.shorts_size_chart_url || '';
    if (Array.isArray(data.shorts_sizes) && data.shorts_sizes.length) state.shortsSizes = data.shorts_sizes;
    renderShortsSizeChartPreview();
    toast('Shorts size chart updated');
  } catch (err) {
    toast(err.message, true);
  }
}

async function clearShortsSizeChart() {
  try {
    const data = await apiFetch('/api/settings/shorts-size-chart', { method: 'DELETE' });
    state.shortsSizeChartUrl = data.shorts_size_chart_url || '';
    renderShortsSizeChartPreview();
    toast('Shorts size chart removed');
  } catch (err) {
    toast(err.message, true);
  }
}

function waitingSpotlightStyle() {
  const url = state.waitingBackgroundUrl;
  if (!url) return '';
  return ` style="--waiting-bg-image: url('${String(url).replace(/'/g, "\\'")}')"`;
}

function renderAll() {
  renderSpotlight();
  renderBidPanel();
  renderAuctionControls();
  renderPlayersList();
  renderTeamsList();
  renderJerseyOrders();
}

// ---------- SSE ----------
let knownSoldPlayerIds = null;

function connectSSE() {
  const es = new EventSource('/api/events');
  const refresh = async () => {
    state.callState = null;
    const previousAuctionId = state.lastAuctionPlayerId;
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    detectAndCelebrateSales();
    const nextAuctionId = state.currentAuction ? state.currentAuction.id : null;
    const shouldReveal = auctionBaselineReady
      && nextAuctionId
      && nextAuctionId !== previousAuctionId
      && typeof window.playPackReveal === 'function';
    state.lastAuctionPlayerId = nextAuctionId;
    if (shouldReveal) packRevealInProgress = true;
    renderAll();
    if (shouldReveal) {
      window.playPackReveal(state.currentAuction, {
        candidates: state.players,
        onDone: () => {
          packRevealInProgress = false;
          renderSpotlight();
          renderBidPanel();
          renderAuctionControls();
        },
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
  es.addEventListener('jersey_order_created', async () => {
    await loadJerseyOrders();
    renderJerseyOrders();
  });
  es.addEventListener('jersey_order_deleted', async () => {
    await loadJerseyOrders();
    renderJerseyOrders();
  });
  es.addEventListener('auction_call', (e) => {
    try { setCallState(JSON.parse(e.data)); } catch (err) { /* ignore malformed payload */ }
  });
  es.addEventListener('settings_updated', async (e) => {
    try {
      const data = JSON.parse(e.data);
      state.auctionTimerSeconds = data.auction_timer_seconds || state.auctionTimerSeconds;
      state.auctionTimerEnabled = data.auction_timer_enabled !== false;
      state.waitingBackgroundUrl = data.waiting_background_url || '';
      state.jerseySizeChartUrl = data.jersey_size_chart_url || '';
      state.shortsSizeChartUrl = data.shorts_size_chart_url || '';
      if (Array.isArray(data.jersey_sizes) && data.jersey_sizes.length) state.jerseySizes = data.jersey_sizes;
      if (Array.isArray(data.shorts_sizes) && data.shorts_sizes.length) state.shortsSizes = data.shorts_sizes;
      if (data.jersey_form_fields) state.jerseyFormFields = data.jersey_form_fields;
      fillSettingsForm();
      if (state.currentAuction) await loadCurrentAuction();
      renderAll();
    } catch (err) { /* ignore */ }
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
  if (!current.current_bid_team_id) {
    toast('Place a bid for a team before calling going once / twice', true);
    return;
  }
  try {
    await apiFetch('/api/auction/call', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: current.id, call }),
    });
  } catch (e) { toast(e.message, true); }
}
function markGoingOnce() { announceCall('going_once'); }
function markGoingTwice() { announceCall('going_twice'); }

// ---------- Auction countdown ----------
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

async function pauseAuctionTimer() {
  try {
    state.currentAuction = await apiFetch('/api/auction/timer/pause', { method: 'POST' });
    renderSpotlight();
    toast('Timer paused');
  } catch (e) { toast(e.message, true); }
}

async function resumeAuctionTimer() {
  try {
    state.currentAuction = await apiFetch('/api/auction/timer/resume', { method: 'POST' });
    renderSpotlight();
    toast('Timer resumed');
  } catch (e) { toast(e.message, true); }
}

// ---------- Spotlight ----------
// The hero of the operator screen too -- name and current bid dominate;
// everything else (base price, leading team, stats) supports them.
function previousBidInfo(current) {
  const history = current.history || [];
  if (history.length >= 2) {
    const prev = history[history.length - 2];
    return { amount: prev.amount, teamName: prev.team_name || 'Unknown team', teamId: prev.team_id };
  }
  if (history.length === 1) {
    return { amount: current.base_price, teamName: 'Starting bid', teamId: null };
  }
  return null;
}

function renderSpotlight() {
  const container = document.getElementById('spotlight');
  const current = packRevealInProgress ? null : state.currentAuction;
  document.getElementById('bidPanelWrapper').style.display = current ? 'block' : 'none';
  if (!current) {
    const hasBg = !!state.waitingBackgroundUrl;
    const complete = isAuctionComplete();
    let title = 'No player currently up for auction';
    let subtitle = '<p class="muted">Press Start auction to draw a random player from the pool.</p>';
    if (packRevealInProgress) {
      title = 'Revealing the next player…';
      subtitle = '';
    } else if (complete) {
      title = 'Auction has been completed';
      subtitle = '<p class="muted">Every player has been through the auction desk.</p>';
    }
    container.innerHTML = `
      <div class="spotlight spotlight-waiting${hasBg ? ' has-waiting-bg' : ''}"${waitingSpotlightStyle()}>
        <div class="empty-state">
          <p class="eyebrow">Auction desk</p>
          <h2>${title}</h2>
          ${subtitle}
        </div>
      </div>`;
    return;
  }
  const bidAmount = current.current_bid_amount || current.base_price;
  const hasBids = !!current.current_bid_team_id;
  const leadingTeam = state.teams.find(team => team.id === current.current_bid_team_id);
  const previous = previousBidInfo(current);
  const hasHistory = (current.history || []).length > 0;
  const call = activeCallState();
  container.innerHTML = `
    <div class="spotlight fifa-card ${cardTierClass(current.card_tier)}">
      ${call ? callBannerHtml(call) : ''}
      ${auctionTimerHtml(current)}
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
          <span class="eyebrow">Highest live bid</span>
          <div class="bid-amount-display" aria-live="polite">${fmtMoney(bidAmount)}</div>
        </div>
        <div class="leading-team-row${hasBids ? ' has-leader' : ''}">
          ${hasBids
            ? `<img class="mini-team-logo" src="${leadingTeam && leadingTeam.logo_url ? leadingTeam.logo_url : placeholderImg()}" alt="">
               <span class="leading-team-name">${escapeHtml(current.current_bid_team_name || 'Unknown team')}</span>
               <span class="leading-chip">Leading</span>`
            : `<span class="muted">No bids yet — starting at base price</span>`}
        </div>
        ${previous
          ? `<div class="previous-bid-row">
               <span class="eyebrow">Previous bid</span>
               <strong>${fmtMoney(previous.amount)}</strong>
               <span class="muted">${escapeHtml(previous.teamName)}</span>
             </div>`
          : ''}
        <div class="player-actions">
          <button class="btn btn-primary btn-sm" type="button" onclick="sellToLeader()" ${hasBids ? '' : 'disabled title="Needs a leading bidder first"'}>Sell</button>
          <button class="btn btn-sm" type="button" onclick="undoLastBid()" ${hasHistory ? '' : 'disabled title="No bids to undo"'}>Undo bid</button>
          <button class="btn btn-warn btn-sm" type="button" onclick="markUnsold(${current.id})">Mark unsold</button>
          <button class="btn btn-sm" type="button" onclick="markGoingOnce()" ${hasBids ? '' : 'disabled title="Needs a leading bidder first"'}>Going once</button>
          <button class="btn btn-sm" type="button" onclick="markGoingTwice()" ${hasBids ? '' : 'disabled title="Needs a leading bidder first"'}>Going twice</button>
          ${(current.auction_ends_at || current.auction_timer_paused)
            ? (current.auction_timer_paused
              ? `<button class="btn btn-primary btn-sm" type="button" onclick="resumeAuctionTimer()">Resume timer</button>`
              : `<button class="btn btn-sm" type="button" onclick="pauseAuctionTimer()">Pause timer</button>`)
            : ''}
        </div>
      </div>
    </div>`;
}

// ---------- Live bidding panel ----------
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
function addBidSteps(amount, steps) {
  let value = Number(amount || 0);
  for (let i = 0; i < Math.max(0, steps); i += 1) value = nextStandardBid(value);
  return value;
}
function isOnBidGrid(amount) {
  const value = Number(amount || 0);
  if (value < PLAYER_BASE_PRICE_CR) return false;
  if (value <= BID_HIGH_THRESHOLD_CR) return (value - PLAYER_BASE_PRICE_CR) % BID_STEP_LOW_CR === 0;
  return (value - BID_HIGH_THRESHOLD_CR) % BID_STEP_HIGH_CR === 0;
}
function hasLiveBid(current) {
  return !!(current && current.current_bid_team_id);
}
function nextRaiseAmount(current) {
  const bidAmount = current.current_bid_amount || current.base_price || PLAYER_BASE_PRICE_CR;
  return hasLiveBid(current) ? nextStandardBid(bidAmount) : bidAmount;
}

function syncDraftBidAmount(current) {
  const bidAmount = current.current_bid_amount || current.base_price;
  const nextAmount = nextRaiseAmount(current);
  const live = hasLiveBid(current);
  const staleDraft = live
    ? (!state.draftBidAmount || state.draftBidAmount <= bidAmount)
    : (!state.draftBidAmount || state.draftBidAmount < bidAmount);
  const needsReset = state.draftBidAuctionId !== current.id
    || state.draftBidFloor !== bidAmount
    || staleDraft;
  if (needsReset) {
    state.draftBidAmount = nextAmount;
    state.draftBidAuctionId = current.id;
    state.draftBidFloor = bidAmount;
  }
  return { bidAmount, nextAmount, draftAmount: state.draftBidAmount };
}

function renderBidPanel() {
  const wrapper = document.getElementById('bidPanel');
  const current = state.currentAuction;
  if (!current) {
    wrapper.innerHTML = '';
    state.draftBidAmount = null;
    state.draftBidAuctionId = null;
    state.draftBidFloor = null;
    return;
  }

  const { bidAmount, nextAmount, draftAmount } = syncDraftBidAmount(current);
  const live = hasLiveBid(current);
  const jump2 = addBidSteps(bidAmount, live ? 2 : 2);
  const jump5 = addBidSteps(bidAmount, 5);
  const hasBids = !!current.current_bid_team_id;
  const hasHistory = (current.history || []).length > 0;

  const teamTilesHtml = state.teams.map(t => {
    const full = t.squad.length >= t.slots_max;
    const spend = spendBudget(t);
    const cannotRaise = live ? spend.max <= bidAmount : spend.max < bidAmount;
    const canAllIn = spend.max < nextAmount && !cannotRaise;
    const placeAmount = draftAmount > spend.max && canAllIn ? spend.max : draftAmount;
    const leading = current.current_bid_team_id === t.id;
    const disabled = full || cannotRaise;
    const reason = full
      ? 'Squad full'
      : (cannotRaise ? 'Over max spend' : (canAllIn && draftAmount > spend.max ? `All-in ${fmtMoney(spend.max)}` : `Bid ${fmtMoney(placeAmount)}`));
    const pct = t.purse_total ? Math.max(0, Math.min(100, Math.round((t.purse_remaining / t.purse_total) * 100))) : 0;
    const keepHint = spend.keepSlots
      ? `Keeps ${fmtMoney(spend.reserve)} (${fmtMoney(PLAYER_BASE_PRICE_CR)} × ${spend.keepSlots})`
      : 'Last slot — full purse';
    return `
      <button type="button"
        class="auction-team-tile${leading ? ' is-leading' : ''}${disabled ? ' is-disabled' : ''}"
        ${disabled ? 'disabled' : ''}
        onclick="oneClickBid(${t.id})"
        title="${escapeHtml(reason)}">
        <img class="auction-team-tile-logo" src="${t.logo_url || placeholderImg()}" alt="">
        <div class="auction-team-tile-main">
          <strong class="auction-team-tile-name">${escapeHtml(t.name)}</strong>
          <span class="auction-team-tile-meta">${t.squad.length}/${t.slots_max} slots · remaining ${fmtMoney(t.purse_remaining)}</span>
          <span class="auction-team-tile-max">Max spend ${fmtMoney(spend.max)}</span>
          <span class="auction-team-tile-keep">${keepHint}</span>
          <span class="purse-bar"><span class="purse-bar-fill" style="width:${pct}%; background:${purseColorFor(pct)}"></span></span>
          <span class="auction-team-tile-action">${disabled ? reason : (canAllIn && draftAmount > spend.max ? `All-in ${fmtMoney(spend.max)}` : fmtMoney(placeAmount))}</span>
        </div>
      </button>`;
  }).join('');

  const bidHistoryItems = [...(current.history || [])].reverse().map((h, index) => `
        <div class="bid-history-item${index === 0 ? ' is-current' : ''}">
          <span class="bid-history-team">
            <img src="${bidTeamLogo(h.team_id)}" alt="">
            ${escapeHtml(h.team_name || 'Unknown team')}
          </span>
          <span class="player-price">${fmtMoney(h.amount)}</span>
          <span class="bid-history-time" data-ts="${h.created_at || ''}">${relativeTime(h.created_at)}</span>
        </div>`).join('');
  const startingBidItem = `
        <div class="bid-history-item bid-history-start${!hasHistory ? ' is-current' : ''}">
          <span class="bid-history-team">Starting bid</span>
          <span class="player-price">${fmtMoney(current.base_price)}</span>
          <span class="bid-history-time"></span>
        </div>`;

  wrapper.innerHTML = `
    <div class="bid-summary">
      <span>Highest live bid</span>
      <strong>${fmtMoney(bidAmount)}</strong>
      <span>Minimum next: ${fmtMoney(nextAmount)}</span>
    </div>
    <div class="bid-amount-editor">
      <label for="manualBidAmount">Bid amount (editable)</label>
      <div class="bid-amount-editor-row">
        <input type="number" id="manualBidAmount" min="${live ? bidAmount + 1 : bidAmount}" step="5" value="${draftAmount}" oninput="onManualBidInput(this)">
        <strong class="bid-amount-preview" id="manualBidPreview">${fmtMoney(draftAmount)}</strong>
      </div>
      <div class="bid-tier-buttons">
        <button type="button" class="btn bid-tier-btn" onclick="setManualBidAmount(${nextAmount})">${fmtMoney(nextAmount)}<small>${live ? 'Min raise' : 'Opening bid'}</small></button>
        <button type="button" class="btn bid-tier-btn" onclick="setManualBidAmount(${jump2})">${fmtMoney(jump2)}<small>Jump +2 steps</small></button>
        <button type="button" class="btn bid-tier-btn" onclick="setManualBidAmount(${jump5})">${fmtMoney(jump5)}<small>Jump +5 steps</small></button>
      </div>
    </div>
    <label>Teams — tap a tile to place the amount above</label>
    <div class="auction-team-tiles">${teamTilesHtml || '<div class="empty">No teams yet.</div>'}</div>
    <div class="row mt-16 auction-desk-actions">
      <button type="button" class="btn btn-primary" onclick="sellToLeader()" ${hasBids ? '' : 'disabled'}>Sell to leader</button>
      <button type="button" class="btn" onclick="undoLastBid()" ${hasHistory ? '' : 'disabled'}>Undo last bid</button>
      <button type="button" class="btn btn-quiet btn-sm" onclick="openAssignModal(${current.id})">Sell with override…</button>
    </div>
    <label class="mt-16">Bid history</label>
    <div class="bid-history-log">${bidHistoryItems + startingBidItem}</div>
  `;
}

function bidTeamLogo(teamId) {
  const team = state.teams.find(candidate => candidate.id === teamId);
  return team && team.logo_url ? team.logo_url : placeholderImg();
}

function onManualBidInput(el) {
  const value = parseInt(el.value, 10);
  state.draftBidAmount = Number.isFinite(value) ? value : null;
  const preview = document.getElementById('manualBidPreview');
  if (preview) preview.textContent = state.draftBidAmount ? fmtMoney(state.draftBidAmount) : '—';
  document.querySelectorAll('.auction-team-tile:not(:disabled) .auction-team-tile-action').forEach(node => {
    node.textContent = state.draftBidAmount ? fmtMoney(state.draftBidAmount) : 'Set amount';
  });
}

function setManualBidAmount(amount) {
  state.draftBidAmount = amount;
  renderBidPanel();
  const input = document.getElementById('manualBidAmount');
  if (input) input.focus();
}

async function oneClickBid(teamId) {
  const current = state.currentAuction;
  if (!current) return;
  const bidAmount = current.current_bid_amount || current.base_price || PLAYER_BASE_PRICE_CR;
  const live = hasLiveBid(current);
  const nextStd = nextRaiseAmount(current);
  const input = document.getElementById('manualBidAmount');
  const typed = input ? parseInt(input.value, 10) : NaN;
  let amount = Number.isFinite(typed) ? typed : (state.draftBidAmount || nextStd);
  const team = state.teams.find(candidate => candidate.id === teamId);
  if (!team) return;
  const spend = maxSpend(team);
  if (live ? amount <= bidAmount : amount < bidAmount) {
    toast(live ? `Bid must be higher than ${fmtMoney(bidAmount)}` : `Bid must be at least ${fmtMoney(bidAmount)}`, true);
    return;
  }
  if (amount > spend) {
    if (spend < nextStd && spend > (live ? bidAmount : bidAmount - 1)) {
      amount = spend;
    } else {
      toast(`${team.name} can spend at most ${fmtMoney(spend)} (must keep ${fmtMoney(PLAYER_BASE_PRICE_CR)} for each remaining squad slot)`, true);
      return;
    }
  }
  if (amount !== spend || spend >= nextStd) {
    if (!isOnBidGrid(amount) || amount < nextStd) {
      toast(`Bid must land on a valid increment. Next standard bid is ${fmtMoney(nextStd)} (₹5 Cr to ₹200 Cr, then ₹10 Cr). All-in allowed only when max spend is below that.`, true);
      return;
    }
  }
  state.draftBidAmount = amount;
  await placeBid(teamId, amount);
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

async function undoLastBid() {
  try {
    await apiFetch('/api/auction/undo-bid', { method: 'POST' });
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    renderAll();
    toast('Last bid undone');
  } catch (e) { toast(e.message, true); }
}

async function sellToLeader() {
  const current = state.currentAuction;
  if (!current || !current.current_bid_team_id) {
    toast('Needs a leading bidder to sell', true);
    return;
  }
  const amount = current.current_bid_amount || current.base_price;
  const teamName = current.current_bid_team_name || 'the leading team';
  if (!confirm(`Sell ${current.name} to ${teamName} for ${fmtMoney(amount)}?`)) return;
  try {
    await apiFetch('/api/auction/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_id: current.id,
        team_id: current.current_bid_team_id,
        sold_price: amount,
      }),
    });
    toast(`Sold to ${teamName}`);
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    renderAll();
  } catch (e) { toast(e.message, true); }
}

// ---------- Auction tab: start random draw ----------
function poolPlayers() {
  return state.players.filter(p => p.status === 'waiting' || p.status === 'unsold');
}

function isAuctionComplete() {
  return state.players.length > 0
    && !state.currentAuction
    && !packRevealInProgress
    && poolPlayers().length === 0;
}

function renderAuctionControls() {
  const countEl = document.getElementById('auctionPoolCount');
  const btn = document.getElementById('startAuctionBtn');
  if (!btn) return;
  const pool = poolPlayers();
  if (state.currentAuction) state.startingAuction = false;
  const busy = !!state.currentAuction || state.startingAuction;
  if (countEl) {
    countEl.textContent = pool.length
      ? `${pool.length} player${pool.length === 1 ? '' : 's'} ready`
      : 'Pool empty';
  }
  btn.disabled = busy || pool.length === 0;
  btn.textContent = state.startingAuction
    ? 'Starting…'
    : (state.currentAuction ? 'Auction in progress' : 'Start auction');
}

async function startAuction() {
  if (state.startingAuction || state.currentAuction) return;
  state.startingAuction = true;
  renderAuctionControls();
  try {
    await apiFetch('/api/auction/start', { method: 'POST' });
    toast('Random player drawn — revealing…');
    // Keep the button locked until SSE refresh sets currentAuction.
  } catch (e) {
    state.startingAuction = false;
    renderAuctionControls();
    toast(e.message, true);
  }
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
function getFilteredPlayers() {
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
  return list;
}

function prunePlayerSelection() {
  const liveIds = new Set(state.players.map(p => p.id));
  state.selectedPlayerIds.forEach(id => {
    if (!liveIds.has(id)) state.selectedPlayerIds.delete(id);
  });
}

function updatePlayerBulkBar(list = getFilteredPlayers()) {
  prunePlayerSelection();
  const count = state.selectedPlayerIds.size;
  const countEl = document.getElementById('playerBulkCount');
  const selectAllEl = document.getElementById('playerSelectAll');
  const undoBtn = document.getElementById('bulkUndoBtn');
  const deleteBtn = document.getElementById('bulkDeleteBtn');
  if (!countEl) return;

  countEl.textContent = count === 1 ? '1 selected' : `${count} selected`;
  if (deleteBtn) deleteBtn.disabled = count === 0;

  const undoable = count > 0 && [...state.selectedPlayerIds].some(id => {
    const p = state.players.find(x => x.id === id);
    return p && (p.status === 'sold' || p.status === 'unsold');
  });
  if (undoBtn) undoBtn.disabled = !undoable;

  if (selectAllEl) {
    const visibleIds = list.map(p => p.id);
    const selectedVisible = visibleIds.filter(id => state.selectedPlayerIds.has(id)).length;
    selectAllEl.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    selectAllEl.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  }
}

function togglePlayerSelection(id, checked) {
  if (checked) state.selectedPlayerIds.add(id);
  else state.selectedPlayerIds.delete(id);
  updatePlayerBulkBar();
  const card = document.querySelector(`.player-card[data-player-id="${id}"]`);
  if (card) card.classList.toggle('is-selected', checked);
}

function toggleSelectAllPlayers(checked) {
  getFilteredPlayers().forEach(p => {
    if (checked) state.selectedPlayerIds.add(p.id);
    else state.selectedPlayerIds.delete(p.id);
  });
  renderPlayersList();
}

function clearPlayerSelection() {
  state.selectedPlayerIds.clear();
  renderPlayersList();
}

async function bulkDeletePlayers() {
  const ids = [...state.selectedPlayerIds];
  if (!ids.length) return;

  const players = ids.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const onAuction = players.filter(p => p.status === 'auction');
  let toDelete = players;
  if (onAuction.length) {
    const skip = !confirm(
      `${onAuction.length} selected player(s) are currently up for auction and will be skipped. Delete the rest?`
    );
    if (!skip) return;
    toDelete = players.filter(p => p.status !== 'auction');
  }
  if (!toDelete.length) {
    toast('No players eligible for deletion', true);
    return;
  }
  if (!confirm(`Delete ${toDelete.length} player(s) permanently?`)) return;

  let deleted = 0;
  let failed = 0;
  for (const p of toDelete) {
    try {
      await apiFetch(`/api/players/${p.id}`, { method: 'DELETE' });
      state.selectedPlayerIds.delete(p.id);
      deleted++;
    } catch (e) {
      failed++;
    }
  }

  if (deleted) {
    toast(`Deleted ${deleted} player(s)` + (failed ? ` (${failed} failed)` : ''));
    await loadPlayers();
    renderAll();
  } else {
    toast('Could not delete selected players', true);
  }
}

async function bulkUndoPlayers() {
  const ids = [...state.selectedPlayerIds];
  const undoable = ids
    .map(id => state.players.find(p => p.id === id))
    .filter(p => p && (p.status === 'sold' || p.status === 'unsold'));
  if (!undoable.length) {
    toast('No sold or unsold players selected', true);
    return;
  }
  if (!confirm(`Undo ${undoable.length} assignment(s) and return those players to the waiting pool?`)) return;

  let reverted = 0;
  let failed = 0;
  for (const p of undoable) {
    try {
      await apiFetch('/api/auction/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_id: p.id }),
      });
      reverted++;
    } catch (e) {
      failed++;
    }
  }

  if (reverted) {
    toast(`Reverted ${reverted} player(s)` + (failed ? ` (${failed} failed)` : ''));
    await Promise.all([loadPlayers(), loadTeams(), loadCurrentAuction()]);
    renderAll();
  } else {
    toast('Could not undo selected players', true);
  }
}

function renderPlayersList() {
  const list = getFilteredPlayers();
  prunePlayerSelection();

  const container = document.getElementById('playersList');
  if (!list.length) {
    container.innerHTML = `<div class="empty">No players found.</div>`;
    updatePlayerBulkBar(list);
    return;
  }
  container.innerHTML = list.map(p => `
    <div class="player-card fifa-card ${cardTierClass(p.card_tier)}${state.selectedPlayerIds.has(p.id) ? ' is-selected' : ''}" data-player-id="${p.id}">
      <label class="player-select" onclick="event.stopPropagation()">
        <input type="checkbox" class="player-select-cb" ${state.selectedPlayerIds.has(p.id) ? 'checked' : ''}
          onchange="togglePlayerSelection(${p.id}, this.checked)" aria-label="Select ${escapeHtml(p.name)}">
      </label>
      ${ratingBadgeHtml(p)}
      <img class="player-photo" src="${p.photo_url || placeholderImg()}" alt="">
      <div class="player-name">${escapeHtml(p.name)}</div>
      <div class="player-meta">${escapeHtml(p.role || '')}</div>
      ${affiliationBadgeHtml(p.stats)}
      ${starsHtml(p)}
      <div class="player-price">${fmtMoney(p.base_price)}${p.sold_price ? ' &rarr; ' + fmtMoney(p.sold_price) : ''}</div>
      ${statusBadge(p.status)}
      ${p.team_name ? `<div class="player-meta">Team: ${escapeHtml(p.team_name)}</div>` : ''}
      <div class="player-actions">
        <button class="btn btn-sm" onclick="openPlayerModal(${p.id})">Edit</button>
        ${p.status !== 'sold' ? `<button class="btn btn-primary btn-sm" onclick="openAssignModal(${p.id})">Assign</button>` : ''}
        ${p.status === 'sold' || p.status === 'unsold' ? `<button class="btn btn-warn btn-sm" onclick="undoPlayer(${p.id})">Undo</button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deletePlayer(${p.id})">Delete</button>
      </div>
    </div>
  `).join('');
  updatePlayerBulkBar(list);
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
    document.getElementById('playerStats').value = normalizeAffiliation(p.stats || '');
    document.getElementById('playerStars').value = String(starValue(p));
  } else {
    document.getElementById('playerStars').value = '3';
    document.getElementById('playerStats').value = '';
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
  fd.append('stars', document.getElementById('playerStars').value);
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
    state.selectedPlayerIds.delete(id);
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
    let msg = `Imported ${result.created} players`;
    if (result.photos_imported) msg += `, ${result.photos_imported} photo(s)`;
    if (result.errors.length) {
      msg += ` (${result.errors.length} warning(s): ${result.errors.slice(0, 2).join('; ')}${result.errors.length > 2 ? '…' : ''})`;
    }
    toast(msg, result.errors.length > 0 && result.created === 0);
    if (result.errors.length) console.warn('CSV import warnings:', result.errors);
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
    const spend = spendBudget(t);
    return `
      <div class="team-card">
        <div class="team-header">
          <img class="team-logo" src="${t.logo_url || placeholderImg()}" alt="">
          <div>
            <div class="team-name">${escapeHtml(t.name)}</div>
            <div class="team-purse">${t.squad.length}/${t.slots_max} players${t.has_owner_password ? ' · login set' : ''}</div>
          </div>
          <div style="margin-left:auto; display:flex; gap:6px;">
            <button class="btn btn-sm" onclick="openTeamModal(${t.id})">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteTeam(${t.id})">Delete</button>
          </div>
        </div>
        <div class="team-purse">Remaining: ${fmtMoney(t.purse_remaining)} / ${fmtMoney(t.purse_total)}</div>
        <div class="team-purse team-max-spend">Max spend: ${fmtMoney(spend.max)}${spend.keepSlots ? ` · keeps ${fmtMoney(spend.reserve)} (${fmtMoney(PLAYER_BASE_PRICE_CR)} × ${spend.keepSlots})` : ''}</div>
        <div class="purse-bar"><div class="purse-bar-fill" style="width:${pct}%; background:${purseColorFor(pct)}"></div></div>
        <div class="squad-list">${squadHtml}${emptyHtml}</div>
      </div>`;
  }).join('');
}

function openTeamModal(id) {
  const form = document.getElementById('teamForm');
  form.reset();
  document.getElementById('teamId').value = id || '';
  document.getElementById('teamModalTitle').textContent = id ? 'Edit Team' : 'Add Team';
  const hint = document.getElementById('teamPasswordHint');
  if (id) {
    const t = state.teams.find(x => x.id === id);
    document.getElementById('teamName').value = t.name;
    document.getElementById('teamPurse').value = t.purse_total;
    document.getElementById('teamSlots').value = t.slots_max;
    if (hint) hint.textContent = t.has_owner_password
      ? 'A team password is set. Enter a new one only if you want to change it.'
      : 'No team password yet — set one so the owner can open their manager desk.';
  } else {
    document.getElementById('teamPurse').value = 1000;
    document.getElementById('teamSlots').value = 8;
    if (hint) hint.textContent = 'Owners use this password on the viewer login to open their manager desk.';
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
  const ownerPassword = document.getElementById('teamOwnerPassword').value;
  if (ownerPassword) fd.append('owner_password', ownerPassword);
  const logo = document.getElementById('teamLogo').files[0];
  if (logo) fd.append('logo', logo);
  const jerseyFront = document.getElementById('teamJerseyFront').files[0];
  if (jerseyFront) fd.append('jersey_front', jerseyFront);
  const jerseyBack = document.getElementById('teamJerseyBack').files[0];
  if (jerseyBack) fd.append('jersey_back', jerseyBack);
  const shorts = document.getElementById('teamShorts').files[0];
  if (shorts) fd.append('shorts', shorts);
  const awayJerseyFront = document.getElementById('teamAwayJerseyFront').files[0];
  if (awayJerseyFront) fd.append('away_jersey_front', awayJerseyFront);
  const awayJerseyBack = document.getElementById('teamAwayJerseyBack').files[0];
  if (awayJerseyBack) fd.append('away_jersey_back', awayJerseyBack);
  const awayShorts = document.getElementById('teamAwayShorts').files[0];
  if (awayShorts) fd.append('away_shorts', awayShorts);

  const maxBytes = 8 * 1024 * 1024;
  for (const [label, file] of [
    ['Logo', logo],
    ['Jersey front', jerseyFront],
    ['Jersey back', jerseyBack],
    ['Shorts', shorts],
    ['Away shirt front', awayJerseyFront],
    ['Away shirt back', awayJerseyBack],
    ['Away shorts', awayShorts],
  ]) {
    if (file && file.size > maxBytes) {
      toast(`${label} is too large (max ~8 MB). Compress it and try again.`, true);
      return;
    }
  }

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
      ${escapeHtml(t.name)} (${t.squad.length}/${t.slots_max} slots, remaining ${fmtMoney(t.purse_remaining)}, max ${fmtMoney(maxSpend(t))})
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
  return '₹' + Number(v).toLocaleString('en-IN') + ' Cr';
}
function slotsLeft(team) {
  const filled = team.slots_filled != null ? team.slots_filled : (team.squad || []).length;
  return Math.max(0, (team.slots_max || 0) - filled);
}
function spendBudget(team) {
  const left = slotsLeft(team);
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
// Same green-to-red purse-health ramp the viewer page uses, so a team's
// purse bar reads the same way in both places instead of staying a flat,
// unchanging color as the purse drains.
function purseColorFor(percentageRemaining) {
  const hue = Math.round(Math.max(0, Math.min(percentageRemaining, 100)) * 1.35);
  return `hsl(${hue} 78% 52%)`;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function placeholderImg() {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="100%" height="100%" fill="#1a232d"/><text x="50%" y="50%" fill="#3a4a5c" font-size="14" text-anchor="middle" dy=".3em">No Photo</text></svg>`
  );
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
