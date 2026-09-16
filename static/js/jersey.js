const DEFAULT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const DEFAULT_SHORTS_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
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
  shortsSizeChartUrl: '',
  jerseySizes: DEFAULT_SIZES.slice(),
  shortsSizes: DEFAULT_SHORTS_SIZES.slice(),
  jerseyFormFields: JSON.parse(JSON.stringify(DEFAULT_FIELDS)),
};

const jerseyUi = {
  teamId: '',
  size: '',
  shortsSize: '',
  wantShorts: false,
  wantPrint: false,
  view: 'front',
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

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

async function init() {
  setupThemeToggle();
  setupJerseyForm();
  await Promise.all([loadTeams(), loadJerseySettings()]);
  renderJerseyPage();
}

const THEME_KEY = 'zoliga-jersey-theme';

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  const btn = document.getElementById('themeToggle');
  if (btn) {
    const other = next === 'dark' ? 'light' : 'dark';
    btn.classList.toggle('is-on', next === 'light');
    btn.setAttribute('aria-label', `Switch to ${other} theme`);
    btn.setAttribute('title', `Switch to ${other} theme`);
    btn.setAttribute('aria-pressed', next === 'light' ? 'true' : 'false');
  }
}

function setupThemeToggle() {
  applyTheme(currentTheme());
  const btn = document.getElementById('themeToggle');
  if (!btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
}

async function loadTeams() {
  state.teams = await apiFetch('/api/teams/public');
}

async function loadJerseySettings() {
  try {
    const data = await apiFetch('/api/settings/jersey-public');
    state.jerseySizeChartUrl = data.jersey_size_chart_url || '';
    state.shortsSizeChartUrl = data.shorts_size_chart_url || '';
    state.jerseySizes = Array.isArray(data.jersey_sizes) && data.jersey_sizes.length
      ? data.jersey_sizes
      : DEFAULT_SIZES.slice();
    state.shortsSizes = Array.isArray(data.shorts_sizes) && data.shorts_sizes.length
      ? data.shorts_sizes
      : DEFAULT_SHORTS_SIZES.slice();
    state.jerseyFormFields = data.jersey_form_fields || JSON.parse(JSON.stringify(DEFAULT_FIELDS));
  } catch (e) {
    state.jerseySizeChartUrl = '';
    state.shortsSizeChartUrl = '';
    state.jerseySizes = DEFAULT_SIZES.slice();
    state.shortsSizes = DEFAULT_SHORTS_SIZES.slice();
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

function applyJerseyFormFields() {
  const teamCfg = fieldConfig('team');
  const nameCfg = fieldConfig('player_name');
  const numberCfg = fieldConfig('jersey_number');
  const sizeCfg = fieldConfig('size');

  const blockTeam = $('#blockTeam');
  const blockPrinting = $('#blockPrinting');
  const blockSize = $('#blockSize');
  const nameWrap = $('#jerseyFieldName');
  const numberWrap = $('#jerseyFieldNumber');

  if (blockTeam) blockTeam.style.display = teamCfg.enabled ? '' : 'none';
  if (blockSize) blockSize.style.display = sizeCfg.enabled ? '' : 'none';

  const showPrint = nameCfg.enabled || numberCfg.enabled;
  if (blockPrinting) blockPrinting.style.display = showPrint ? '' : 'none';
  if (nameWrap) nameWrap.style.display = nameCfg.enabled ? '' : 'none';
  if (numberWrap) numberWrap.style.display = numberCfg.enabled ? '' : 'none';

  const nameInput = $('#jerseyPlayerName');
  const numberInput = $('#jerseyNumber');
  if (nameInput) {
    if (nameCfg.required) nameInput.setAttribute('aria-required', 'true');
    else nameInput.removeAttribute('aria-required');
  }
  if (numberInput) {
    if (numberCfg.required) numberInput.setAttribute('aria-required', 'true');
    else numberInput.removeAttribute('aria-required');
  }

  renderCustomJerseyFields();
  applyJerseyBlockOrder();
}

function applyJerseyBlockOrder() {
  // Fixed kit-order section order: Team → Printing → Jersey size → Shorts → More details
  const form = $('#orderForm');
  if (!form) return;
  const orders = {
    blockTeam: 1,
    blockPrinting: 2,
    blockSize: 3,
    blockShorts: 4,
    blockCustom: 5,
  };
  Object.entries(orders).forEach(([id, score]) => {
    const el = document.getElementById(id);
    if (el) el.style.order = String(score);
  });
  const summary = form.querySelector('.summary');
  if (summary) summary.style.order = '100';
  form.style.display = 'flex';
  form.style.flexDirection = 'column';
}

function renderCustomJerseyFields() {
  const wrap = $('#jerseyCustomFields');
  const block = $('#blockCustom');
  if (!wrap || !block) return;

  const previous = {};
  wrap.querySelectorAll('[data-custom-field-id]').forEach(input => {
    previous[input.dataset.customFieldId] = input.value;
  });

  const defs = customFieldDefs().filter(f => f.enabled !== false);
  if (!defs.length) {
    wrap.innerHTML = '';
    block.style.display = 'none';
    return;
  }

  block.style.display = '';
  wrap.innerHTML = defs.map(field => {
    const value = previous[field.id] || '';
    const req = field.required ? ' aria-required="true"' : '';
    return `
      <div class="field" data-custom-field-wrap="${escapeHtml(field.id)}">
        <label for="jerseyCustom_${escapeHtml(field.id)}">${escapeHtml(field.label || field.id)}</label>
        <input type="text" id="jerseyCustom_${escapeHtml(field.id)}" data-custom-field-id="${escapeHtml(field.id)}" value="${escapeHtml(value)}" autocomplete="off"${req}>
      </div>`;
  }).join('');
  wrap.querySelectorAll('[data-custom-field-id]').forEach(input => {
    input.addEventListener('input', updateSummary);
  });
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

function selectedTeamId() {
  const checked = document.querySelector('input[name="team"]:checked');
  return jerseyUi.teamId || (checked && checked.value) || '';
}

function selectedSize() {
  const checked = document.querySelector('input[name="jsize"]:checked');
  return jerseyUi.size || (checked && checked.value) || '';
}

function selectedShortsSize() {
  if (!jerseyUi.wantShorts) return '';
  const checked = document.querySelector('input[name="ssize"]:checked');
  return jerseyUi.shortsSize || (checked && checked.value) || '';
}

function syncShortsCollapse(opts = {}) {
  const toggle = $('#wantShorts');
  const fields = $('#shortsFields');
  jerseyUi.wantShorts = !!(toggle && toggle.checked);
  if (fields) fields.classList.toggle('open', jerseyUi.wantShorts);
  if (!jerseyUi.wantShorts) {
    jerseyUi.shortsSize = '';
    $$('input[name="ssize"]').forEach(el => { el.checked = false; });
    showErr('errShortsSize', false);
  } else if (opts.focusPreview) {
    showView('shorts');
  }
  updateSummary();
}

function syncPrintCollapse(opts = {}) {
  const toggle = $('#wantPrint');
  const fields = $('#printFields');
  jerseyUi.wantPrint = !!(toggle && toggle.checked);
  if (fields) fields.classList.toggle('open', jerseyUi.wantPrint);
  if (!jerseyUi.wantPrint) {
    const nameInput = $('#jerseyPlayerName');
    const numberInput = $('#jerseyNumber');
    if (nameInput) nameInput.value = '';
    if (numberInput) numberInput.value = '';
    showErr('errPrint', false);
    updateJerseyOverlays();
  } else if (opts.focusPreview) {
    showView('back');
    const nameInput = $('#jerseyPlayerName');
    if (nameInput) nameInput.focus();
  }
  updateStageNote();
  updateSummary();
}

function playerNameValue() {
  if (!jerseyUi.wantPrint) return '';
  if (!fieldConfig('player_name').enabled) return '';
  return (($('#jerseyPlayerName') || {}).value || '').trim();
}

function jerseyNumberValue() {
  if (!jerseyUi.wantPrint) return '';
  if (!fieldConfig('jersey_number').enabled) return '';
  return (($('#jerseyNumber') || {}).value || '').trim();
}

function setupJerseyForm() {
  if (jerseyUi.wired) return;

  const form = $('#orderForm');
  const nameInput = $('#jerseyPlayerName');
  const numberInput = $('#jerseyNumber');
  const chartBtn = $('#sizeChartBtn');
  const chartLink = $('#sizeChartLink');
  const shortsChartLink = $('#shortsSizeChartLink');
  const chartClose = $('#chartClose');
  const chartDialog = $('#chartDialog');
  const confirmClose = $('#confirmClose');
  const confirmCancel = $('#confirmCancel');
  const confirmOk = $('#confirmOk');
  const confirmDialog = $('#confirmDialog');
  const again = $('#again');
  const wantShorts = $('#wantShorts');
  const wantPrint = $('#wantPrint');

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      openJerseyConfirm();
    });
  }

  if (nameInput) nameInput.addEventListener('input', () => {
    if (jerseyUi.wantPrint) showView('back');
    updateJerseyOverlays();
    updateSummary();
  });
  if (numberInput) {
    numberInput.addEventListener('input', () => {
      const cleaned = numberInput.value.replace(/\D/g, '').slice(0, 2);
      if (numberInput.value !== cleaned) numberInput.value = cleaned;
      if (jerseyUi.wantPrint) showView('back');
      updateJerseyOverlays();
      updateSummary();
    });
  }

  if (wantPrint) {
    wantPrint.addEventListener('change', () => syncPrintCollapse({ focusPreview: true }));
  }
  if (wantShorts) {
    wantShorts.addEventListener('change', () => syncShortsCollapse({ focusPreview: true }));
  }

  $$('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      showView(btn.dataset.view);
    });
  });

  const openJerseyChart = () => openSizeChart('jersey');
  const openShortsChart = () => openSizeChart('shorts');
  if (chartBtn) chartBtn.addEventListener('click', openJerseyChart);
  if (chartLink) chartLink.addEventListener('click', openJerseyChart);
  if (shortsChartLink) shortsChartLink.addEventListener('click', openShortsChart);
  if (chartClose) chartClose.addEventListener('click', closeSizeChart);
  if (chartDialog) {
    chartDialog.addEventListener('click', (e) => {
      if (e.target === chartDialog) closeSizeChart();
    });
  }

  if (confirmClose) confirmClose.addEventListener('click', closeJerseyConfirm);
  if (confirmCancel) confirmCancel.addEventListener('click', closeJerseyConfirm);
  if (confirmOk) confirmOk.addEventListener('click', confirmAndSubmitJerseyOrder);
  if (confirmDialog) {
    confirmDialog.addEventListener('click', (e) => {
      if (e.target === confirmDialog) closeJerseyConfirm();
    });
  }

  if (again) {
    again.addEventListener('click', resetForAnotherOrder);
  }

  jerseyUi.wired = true;
}

function openSizeChart(kind) {
  const dlg = $('#chartDialog');
  const body = $('#chartBody');
  const title = dlg && dlg.querySelector('.dlg-head h2');
  if (!dlg || !body) return;
  const isShorts = kind === 'shorts';
  const url = isShorts ? (state.shortsSizeChartUrl || '') : (state.jerseySizeChartUrl || '');
  if (title) title.textContent = isShorts ? 'Shorts size chart' : 'Size chart';
  if (url) {
    body.innerHTML = `<img src="${escapeHtml(url)}" alt="${isShorts ? 'Shorts' : 'Jersey'} size chart"><p class="foot">Between two sizes? Go up one for a looser match-day fit.</p>`;
  } else {
    body.innerHTML = `<p class="foot">No ${isShorts ? 'shorts' : 'jersey'} size chart uploaded yet. Ask the organizer to add one in Admin → Settings.</p>`;
  }
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeSizeChart() {
  const dlg = $('#chartDialog');
  if (!dlg) return;
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}

function showErr(id, show) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('show', !!show);
}

function clearErrors() {
  ['errTeam', 'errPrint', 'errSize', 'errShortsSize', 'errCustom', 'formErr'].forEach(id => showErr(id, false));
  $$('[aria-invalid]').forEach(el => el.setAttribute('aria-invalid', 'false'));
}

function validateOrder() {
  clearErrors();
  let ok = true;
  const teamCfg = fieldConfig('team');
  const nameCfg = fieldConfig('player_name');
  const numberCfg = fieldConfig('jersey_number');
  const sizeCfg = fieldConfig('size');
  const teamId = selectedTeamId();
  const playerName = playerNameValue();
  const jerseyNumber = jerseyNumberValue();
  const size = selectedSize();
  const shortsSize = selectedShortsSize();

  if (teamCfg.enabled && teamCfg.required && !teamId) {
    showErr('errTeam', true);
    ok = false;
  }
  if (sizeCfg.enabled && sizeCfg.required && !size) {
    showErr('errSize', true);
    ok = false;
  }
  if (jerseyUi.wantShorts && !shortsSize) {
    showErr('errShortsSize', true);
    ok = false;
  }

  let printBad = false;
  if (jerseyUi.wantPrint) {
    if (nameCfg.enabled && nameCfg.required && !playerName) printBad = true;
    if (numberCfg.enabled && numberCfg.required && !jerseyNumber) printBad = true;
    // If neither field is required by admin, still ask for at least one value when printing is on
    if (!nameCfg.required && !numberCfg.required && nameCfg.enabled && numberCfg.enabled
        && !playerName && !jerseyNumber) {
      printBad = true;
      const errPrint = $('#errPrint');
      if (errPrint) errPrint.textContent = 'Enter a name, a number, or both.';
    } else if (printBad) {
      const errPrint = $('#errPrint');
      if (errPrint) errPrint.textContent = 'Enter the required printing details.';
    }
  }
  if (printBad) {
    showErr('errPrint', true);
    const nameInput = $('#jerseyPlayerName');
    const numberInput = $('#jerseyNumber');
    if (nameCfg.enabled && nameCfg.required && !playerName && nameInput) {
      nameInput.setAttribute('aria-invalid', 'true');
    }
    if (numberCfg.enabled && numberCfg.required && !jerseyNumber && numberInput) {
      numberInput.setAttribute('aria-invalid', 'true');
    }
    ok = false;
  }

  const custom = collectCustomFieldValues();
  if (custom.errors.length) {
    showErr('errCustom', true);
    const errEl = $('#errCustom');
    if (errEl) errEl.textContent = custom.errors[0];
    ok = false;
  }

  if (!ok) showErr('formErr', true);
  return { ok, custom };
}

function openJerseyConfirm() {
  const { ok, custom } = validateOrder();
  if (!ok) {
    const first = document.querySelector('.err.show');
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }

  const teamId = Number(selectedTeamId() || 0);
  const team = state.teams.find(t => String(t.id) === String(teamId));
  const teamName = team ? team.name : 'Selected team';
  const nameCfg = fieldConfig('player_name');
  const numberCfg = fieldConfig('jersey_number');
  const sizeCfg = fieldConfig('size');
  const playerName = playerNameValue();
  const jerseyNumber = jerseyNumberValue();
  const size = selectedSize();
  const shortsSize = selectedShortsSize();

  pendingOrder = {
    team_id: teamId,
    player_name: playerName,
    jersey_number: jerseyNumber,
    size,
    want_print: !!jerseyUi.wantPrint,
    want_shorts: !!jerseyUi.wantShorts,
    shorts_size: shortsSize,
    extra_fields: custom.values,
  };

  const lines = [`<strong>${escapeHtml(teamName)}</strong>`];
  if (nameCfg.enabled || numberCfg.enabled) {
    if (jerseyUi.wantPrint) {
      if (nameCfg.enabled) {
        lines.push(`Name: ${playerName ? escapeHtml(playerName.toUpperCase()) : '<em>none</em>'}`);
      }
      if (numberCfg.enabled) {
        lines.push(`Number: ${jerseyNumber ? escapeHtml(jerseyNumber) : '<em>none</em>'}`);
      }
    } else {
      lines.push('Printing: <em>none</em>');
    }
  }
  if (sizeCfg.enabled) {
    lines.push(`Jersey size: ${size ? `<strong>${escapeHtml(size)}</strong>` : '<em>none</em>'}`);
  }
  lines.push(`Shorts: ${jerseyUi.wantShorts && shortsSize ? `<strong>${escapeHtml(shortsSize)}</strong>` : '<em>not ordered</em>'}`);
  customFieldDefs().filter(f => f.enabled !== false).forEach(field => {
    const value = custom.values[field.id] || '';
    lines.push(`${escapeHtml(field.label || field.id)}: ${value ? escapeHtml(value) : '<em>none</em>'}`);
  });

  const summary = $('#confirmSummary');
  if (summary) summary.innerHTML = lines.join('<br>');

  const dlg = $('#confirmDialog');
  if (dlg) {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }
}

function closeJerseyConfirm() {
  pendingOrder = null;
  const dlg = $('#confirmDialog');
  if (!dlg) return;
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}

async function confirmAndSubmitJerseyOrder() {
  if (!pendingOrder) return;
  const order = pendingOrder;
  const submitBtn = $('#jerseySubmitBtn');
  const okBtn = $('#confirmOk');
  const formErr = $('#formErr');

  closeJerseyConfirm();
  if (submitBtn) submitBtn.disabled = true;
  if (okBtn) okBtn.disabled = true;

  try {
    await apiFetch('/api/jersey-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    showOrderDone(order);
  } catch (err) {
    if (formErr) {
      formErr.textContent = err.message || 'Could not save jersey order';
      formErr.classList.add('show');
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (okBtn) okBtn.disabled = false;
  }
}

function showOrderDone(order) {
  const form = $('#orderForm');
  const done = $('#done');
  const doneList = $('#doneList');
  const doneMsg = $('#doneMsg');
  const team = state.teams.find(t => String(t.id) === String(order.team_id));
  const items = [['Team', team ? team.name : String(order.team_id)]];

  if (fieldConfig('player_name').enabled || fieldConfig('jersey_number').enabled) {
    if (order.player_name || order.jersey_number) {
      if (fieldConfig('player_name').enabled) {
        items.push(['Name', order.player_name ? order.player_name.toUpperCase() : '—']);
      }
      if (fieldConfig('jersey_number').enabled) {
        items.push(['Number', order.jersey_number || '—']);
      }
    } else {
      items.push(['Printing', 'None']);
    }
  }
  if (fieldConfig('size').enabled) {
    items.push(['Jersey size', order.size || '—']);
  }
  items.push(['Shorts', order.shorts_size || 'Not ordered']);
  customFieldDefs().filter(f => f.enabled !== false).forEach(field => {
    const value = (order.extra_fields || {})[field.id] || '';
    items.push([field.label || field.id, value || '—']);
  });

  if (doneList) {
    doneList.innerHTML = items.map(([k, v]) =>
      `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`
    ).join('');
  }
  if (doneMsg) doneMsg.textContent = 'Your kit order has been saved.';
  if (form) form.style.display = 'none';
  if (done) {
    done.classList.add('show');
    done.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function resetForAnotherOrder() {
  const form = $('#orderForm');
  const done = $('#done');
  if (form) {
    form.reset();
    form.style.display = 'flex';
  }
  if (done) done.classList.remove('show');
  jerseyUi.teamId = '';
  jerseyUi.size = '';
  jerseyUi.shortsSize = '';
  jerseyUi.wantShorts = false;
  jerseyUi.wantPrint = false;
  const wantShorts = $('#wantShorts');
  if (wantShorts) wantShorts.checked = false;
  const wantPrint = $('#wantPrint');
  if (wantPrint) wantPrint.checked = false;
  const shortsFields = $('#shortsFields');
  if (shortsFields) shortsFields.classList.remove('open');
  const printFields = $('#printFields');
  if (printFields) printFields.classList.remove('open');
  clearErrors();
  renderJerseyPage();
  showView('front');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderJerseyPage() {
  applyJerseyFormFields();
  renderTeamPicker();
  renderSizeChips();
  renderShortsSizeChips();
  syncPrintCollapse();
  syncShortsCollapse();
  paintJerseyPreview();
  updateSummary();
}

function renderTeamPicker() {
  const picker = $('#teamPicker');
  if (!picker) return;

  const signature = state.teams.map(t =>
    `${t.id}:${t.logo_url || ''}:${t.jersey_front_url || ''}:${t.jersey_back_url || ''}:${t.shorts_url || ''}:${t.name}`
  ).join('|');
  if (picker.dataset.teamSignature === signature) {
    syncTeamSelection();
    return;
  }

  if (!state.teams.length) {
    picker.innerHTML = `<p class="hint" style="margin:0;">No teams yet. Ask the organizer to add teams in Admin.</p>`;
    picker.dataset.teamSignature = signature;
    return;
  }

  picker.innerHTML = state.teams.map(t => {
    const logo = t.logo_url
      ? `<img class="swatch" src="${escapeHtml(t.logo_url)}" alt="">`
      : `<span class="swatch" aria-hidden="true"></span>`;
    return `
      <label class="team">
        <input type="radio" name="team" value="${t.id}">
        <span class="box">
          ${logo}
          <span>${escapeHtml(t.name)}</span>
        </span>
      </label>`;
  }).join('');

  picker.querySelectorAll('input[name="team"]').forEach(input => {
    input.addEventListener('change', () => {
      jerseyUi.teamId = input.value;
      showErr('errTeam', false);
      paintJerseyPreview();
      updateSummary();
      const team = state.teams.find(t => String(t.id) === String(input.value));
      if (team && team.jersey_back_url && (playerNameValue() || jerseyNumberValue())) {
        showView('back');
      } else {
        showView('front');
      }
    });
  });

  picker.dataset.teamSignature = signature;
  syncTeamSelection();
}

function syncTeamSelection() {
  if (!jerseyUi.teamId) return;
  const input = Array.from(document.querySelectorAll('input[name="team"]'))
    .find(el => el.value === String(jerseyUi.teamId));
  if (input) input.checked = true;
  else jerseyUi.teamId = '';
}

function renderSizeChips() {
  const wrap = $('#sizeChips');
  if (!wrap) return;
  const sizes = Array.isArray(state.jerseySizes) && state.jerseySizes.length
    ? state.jerseySizes
    : DEFAULT_SIZES;
  const signature = sizes.join('|');
  if (wrap.dataset.sizeSignature === signature) {
    syncSizeSelection();
    return;
  }

  wrap.innerHTML = sizes.map(s => `
    <label class="chip">
      <input type="radio" name="jsize" value="${escapeHtml(s)}">
      <span>${escapeHtml(s)}</span>
    </label>
  `).join('');

  wrap.querySelectorAll('input[name="jsize"]').forEach(input => {
    input.addEventListener('change', () => {
      jerseyUi.size = input.value;
      showErr('errSize', false);
      updateSummary();
    });
  });

  wrap.dataset.sizeSignature = signature;
  syncSizeSelection();
}

function syncSizeSelection() {
  if (!jerseyUi.size) return;
  const input = Array.from(document.querySelectorAll('input[name="jsize"]'))
    .find(el => el.value === String(jerseyUi.size));
  if (input) input.checked = true;
  else jerseyUi.size = '';
}

function renderShortsSizeChips() {
  const wrap = $('#shortsSizeChips');
  if (!wrap) return;
  const sizes = Array.isArray(state.shortsSizes) && state.shortsSizes.length
    ? state.shortsSizes
    : DEFAULT_SHORTS_SIZES;
  const signature = sizes.join('|');
  if (wrap.dataset.sizeSignature === signature) {
    syncShortsSizeSelection();
    return;
  }

  wrap.innerHTML = sizes.map(s => `
    <label class="chip">
      <input type="radio" name="ssize" value="${escapeHtml(s)}">
      <span>${escapeHtml(s)}</span>
    </label>
  `).join('');

  wrap.querySelectorAll('input[name="ssize"]').forEach(input => {
    input.addEventListener('change', () => {
      jerseyUi.shortsSize = input.value;
      showErr('errShortsSize', false);
      updateSummary();
    });
  });

  wrap.dataset.sizeSignature = signature;
  syncShortsSizeSelection();
}

function syncShortsSizeSelection() {
  if (!jerseyUi.shortsSize) return;
  const input = Array.from(document.querySelectorAll('input[name="ssize"]'))
    .find(el => el.value === String(jerseyUi.shortsSize));
  if (input) input.checked = true;
  else jerseyUi.shortsSize = '';
}

function showView(view) {
  jerseyUi.view = view || 'front';
  $$('.stage-view').forEach(el => {
    el.classList.toggle('on', el.dataset.view === jerseyUi.view);
  });
  $$('.tabs button').forEach(btn => {
    btn.setAttribute('aria-selected', btn.dataset.view === jerseyUi.view ? 'true' : 'false');
  });
  updateStageNote();
}

function paintJerseyPreview() {
  const kitName = $('#kitName');
  const stageEmpty = $('#stageEmpty');
  const viewFront = $('#view-front');
  const viewBack = $('#view-back');
  const viewShorts = $('#view-shorts');
  const tabFront = $('#tabFront');
  const tabBack = $('#tabBack');
  const tabShorts = $('#tabShorts');
  if (!viewFront || !viewBack || !viewShorts) return;

  const teamId = selectedTeamId();
  if (!teamId) {
    if (kitName) kitName.textContent = 'Pick a team to see its kit';
    if (stageEmpty) stageEmpty.style.display = '';
    viewFront.classList.remove('on');
    viewBack.classList.remove('on');
    viewShorts.classList.remove('on');
    viewFront.innerHTML = '';
    viewBack.innerHTML = '';
    viewShorts.innerHTML = '';
    [tabFront, tabBack, tabShorts].forEach(tab => { if (tab) tab.disabled = true; });
    updateStageNote();
    return;
  }

  const team = state.teams.find(t => String(t.id) === String(teamId));
  if (!team) {
    if (kitName) kitName.textContent = 'Pick a team to see its kit';
    if (stageEmpty) stageEmpty.style.display = '';
    return;
  }

  if (kitName) kitName.textContent = `${team.name} kit`;
  if (stageEmpty) stageEmpty.style.display = 'none';

  const front = team.jersey_front_url || '';
  const back = team.jersey_back_url || '';
  const shorts = team.shorts_url || '';
  const name = playerNameValue().toUpperCase();
  const number = jerseyNumberValue();
  const paintKey = `kit|${team.id}|${front}|${back}|${shorts}`;

  if (viewFront.dataset.paintKey !== paintKey) {
    viewFront.innerHTML = front
      ? `<div class="jersey-image-wrap"><img src="${escapeHtml(front)}" alt="${escapeHtml(team.name)} jersey front"></div>`
      : `<p class="stage-empty">No front kit uploaded.</p>`;
    viewFront.dataset.paintKey = paintKey;

    if (back) {
      viewBack.innerHTML = `
        <div class="jersey-image-wrap jersey-image-wrap-back">
          <img src="${escapeHtml(back)}" alt="${escapeHtml(team.name)} jersey back">
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
        </div>`;
    } else {
      viewBack.innerHTML = `<p class="stage-empty">No back kit uploaded.</p>`;
    }
    viewBack.dataset.paintKey = paintKey;

    viewShorts.innerHTML = shorts
      ? `<div class="jersey-image-wrap jersey-image-wrap-shorts"><img src="${escapeHtml(shorts)}" alt="${escapeHtml(team.name)} shorts"></div>`
      : `<p class="stage-empty">No shorts uploaded.</p>`;
    viewShorts.dataset.paintKey = paintKey;
  } else {
    updateJerseyOverlays();
  }

  if (tabFront) tabFront.disabled = !front;
  if (tabBack) tabBack.disabled = !back;
  if (tabShorts) tabShorts.disabled = !shorts;

  let view = jerseyUi.view;
  if (view === 'front' && !front) view = back ? 'back' : (shorts ? 'shorts' : 'front');
  if (view === 'back' && !back) view = front ? 'front' : (shorts ? 'shorts' : 'back');
  if (view === 'shorts' && !shorts) view = front ? 'front' : (back ? 'back' : 'shorts');
  if (!front && !back && !shorts) {
    if (stageEmpty) {
      stageEmpty.style.display = '';
      stageEmpty.textContent = `No kit uploaded yet for ${team.name}.`;
    }
  }
  showView(view);
}

function updateJerseyOverlays() {
  const name = playerNameValue();
  const number = jerseyNumberValue();
  $$('[data-jersey-name]').forEach(el => {
    el.textContent = name.toUpperCase();
    const svgText = el.closest('text');
    if (svgText) {
      const len = name.length;
      svgText.setAttribute('font-size', len > 9 ? '20' : len > 7 ? '23' : '28');
    }
  });
  $$('[data-jersey-number]').forEach(el => { el.textContent = number; });
  updateStageNote();
}

function updateStageNote() {
  const note = $('#stageNote');
  if (!note) return;
  if (!selectedTeamId()) {
    note.textContent = 'Select a team to preview front, back, and shorts.';
    return;
  }
  const name = playerNameValue();
  const number = jerseyNumberValue();
  if (jerseyUi.view === 'back') {
    if (!jerseyUi.wantPrint) {
      note.textContent = 'Turn on Add printing to place a name and number on the back.';
    } else {
      note.textContent = name || number
        ? 'Check the spelling on the back before ordering.'
        : 'Add a name and number to see them on the kit.';
    }
  } else if (jerseyUi.view === 'shorts') {
    note.textContent = 'Shorts preview for the selected team.';
  } else {
    note.textContent = 'Front of the jersey for the selected team.';
  }
}

function updateSummary() {
  const lines = $('#orderLines');
  if (!lines) return;
  const team = state.teams.find(t => String(t.id) === String(selectedTeamId()));
  const rows = [];
  if (fieldConfig('team').enabled) {
    rows.push(['Team', team ? team.name : '—']);
  }
  if (fieldConfig('player_name').enabled || fieldConfig('jersey_number').enabled) {
    if (jerseyUi.wantPrint) {
      if (fieldConfig('player_name').enabled) {
        const name = playerNameValue();
        rows.push(['Name', name ? name.toUpperCase() : '—']);
      }
      if (fieldConfig('jersey_number').enabled) {
        rows.push(['Number', jerseyNumberValue() || '—']);
      }
    } else {
      rows.push(['Printing', 'None']);
    }
  }
  if (fieldConfig('size').enabled) {
    rows.push(['Jersey size', selectedSize() || '—']);
  }
  rows.push(['Shorts', jerseyUi.wantShorts ? (selectedShortsSize() || 'Choose size') : 'Not ordered']);
  customFieldDefs().filter(f => f.enabled !== false).forEach(field => {
    const input = document.getElementById(`jerseyCustom_${field.id}`);
    const value = (input && input.value || '').trim();
    rows.push([field.label || field.id, value || '—']);
  });
  lines.innerHTML = rows.map(([k, v]) =>
    `<li><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></li>`
  ).join('');
}

init();
