(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const GOAL_KEY = 'echelon.goalMinutes';
  const UNITS_KEY = 'echelon.units';
  const THEME_KEY = 'echelon.theme';
  const KM_PER_MILE = 1.609344;

  const state = {
    status: null,
    telemetry: null,
    stats: null,
    workouts: [],
    active: null,
    livePoints: [],
    liveMetric: 'cadence',
    rideSpeed: [],
    rideStamp: null,
    trendMetric: 'minutes',
    trendDays: 30,
    trendHover: null,
    detail: null,
    detailMetric: 'cadence',
    goalMinutes: clampGoal(localStorage.getItem(GOAL_KEY) || 30),
    units: localStorage.getItem(UNITS_KEY) === 'km' ? 'km' : 'mi',
    theme: localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light',
    socket: null,
    socketRetry: 0,
    seenEvents: new Set(),
    refreshTimer: null,
    lastLiveDraw: 0,
  };

  const METRICS = {
    cadence: { label: 'Cadence', short: 'Avg cadence', unit: 'rpm', color: '#b9f227', minMax: 80 },
    speed: { label: 'Speed', short: 'Avg speed', unit: 'mph', color: '#0e7490', minMax: 25 },
    resistance: { label: 'Resistance', short: 'Avg resistance', unit: 'level', color: '#8b93ff', minMax: 20 },
  };

  // Power that fills the Ride gauge ring end to end.
  const GAUGE_MAX_WATTS = 400;
  // Recent speeds kept for the Ride sparkline.
  const RIDE_SPEED_SAMPLES = 300;

  // ------------------------------------------------------------ units + theme
  function distanceFactor() {
    return state.units === 'mi' ? 1 / KM_PER_MILE : 1;
  }

  function distanceUnit() {
    return state.units === 'mi' ? 'mi' : 'km';
  }

  function speedUnit() {
    return state.units === 'mi' ? 'mph' : 'km/h';
  }

  function convertDistance(km) {
    if (km === null || km === undefined || km === '') return null;
    return Number(km) * distanceFactor();
  }

  function convertSpeed(kmh) {
    if (kmh === null || kmh === undefined || kmh === '') return null;
    return Number(kmh) * distanceFactor();
  }

  function fmtDistance(km, digits = 2) {
    return fmtNumber(convertDistance(km), digits);
  }

  function chartColor(metric) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(`--chart-${metric}`);
    return value.trim() || '#15803d';
  }

  function chartTheme() {
    const styles = getComputedStyle(document.documentElement);
    const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    return {
      text: read('--chart-text', '#6b7280'),
      grid: read('--chart-grid', '#e6e9ee'),
      gridStrong: read('--chart-grid-strong', '#cfd4dc'),
      tooltipBg: read('--chart-tooltip-bg', '#ffffff'),
      tooltipLine: read('--chart-tooltip-line', '#d5dae2'),
      tooltipText: read('--chart-tooltip-text', '#12151b'),
    };
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    syncThemeControls();
  }

  function syncThemeControls() {
    $$('#themeTabs button').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.theme === state.theme);
    });
  }

  function setTheme(theme) {
    state.theme = theme === 'dark' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, state.theme);
    applyTheme();
    redrawCharts();
  }

  function syncUnitControls() {
    $$('#unitTabs button').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.unit === state.units);
    });
  }

  // ------------------------------------------------------------------ pages
  const PAGE_HASHES = { '#live': 'live', '#ride': 'ride', '#trends': 'trends', '#history': 'workouts' };

  function currentPage() {
    return PAGE_HASHES[location.hash] || 'live';
  }

  // Mobile shows one section at a time; desktop keeps the single scrolling page.
  function applyPage() {
    const page = currentPage();
    document.documentElement.dataset.page = page;
    $$('a[data-page]').forEach((link) => {
      const active = link.dataset.page === page;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    // A hidden canvas has no size, so the sparkline is drawn once it becomes visible.
    if (page === 'ride') drawRideChart();
  }

  function redrawCharts() {
    drawLiveChart(true);
    drawTrendChart();
    drawRideChart();
    if (state.detail) drawDetailChart();
  }

  function setUnits(units) {
    state.units = units === 'km' ? 'km' : 'mi';
    localStorage.setItem(UNITS_KEY, state.units);
    syncUnitControls();
    renderStatus(state.status);
    renderLive(state.telemetry);
    renderStats();
    renderWorkouts();
    if (state.detail) renderDetail();
    redrawCharts();
  }

  function openSettings(message) {
    const dialog = $('#settingsDialog');
    if (!dialog) return;
    const hint = $('#settingsHint');
    if (hint && message) hint.textContent = message;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function closeSettings() {
    const dialog = $('#settingsDialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  window.EchelonSettings = { open: openSettings, close: closeSettings };

  // ---------------------------------------------------------------- utilities
  function clampGoal(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 30;
    return Math.max(5, Math.min(300, Math.round(number)));
  }

  function fmtNumber(value, digits = 0) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtDuration(seconds, compact = false) {
    seconds = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (compact) {
      if (hours) return `${hours}h ${minutes}m`;
      if (minutes) return `${minutes}m`;
      return `${secs}s`;
    }
    if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function parseDateOnly(key) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function dayKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function relativeDay(isoDateTime) {
    const date = new Date(isoDateTime);
    if (Number.isNaN(date.getTime())) return { title: 'Workout', sub: '' };
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    let title;
    if (isSameDay(date, now)) title = 'Today';
    else if (isSameDay(date, yesterday)) title = 'Yesterday';
    else title = `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return { title, sub: time };
  }

  function rideTitle(isoDateTime) {
    const date = new Date(isoDateTime);
    if (Number.isNaN(date.getTime())) return 'Ride session';
    const hour = date.getHours();
    if (hour < 5) return 'Night ride';
    if (hour < 12) return 'Morning ride';
    if (hour < 17) return 'Afternoon ride';
    if (hour < 21) return 'Evening ride';
    return 'Night ride';
  }

  function fullDate(isoDateTime) {
    const date = new Date(isoDateTime);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(undefined, {
      weekday: 'short', month: 'long', day: 'numeric', year: 'numeric',
    }) + ' · ' + date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function metricValue(point, metric) {
    if (!point) return null;
    if (metric === 'cadence') return point.cadence ?? null;
    if (metric === 'speed') return convertSpeed(point.speed);
    if (metric === 'resistance') return point.resistance ?? null;
    return null;
  }

  function metricDigits(metric) {
    return metric === 'speed' ? 1 : 0;
  }

  function metricText(value, metric) {
    if (value === null || value === undefined) return '—';
    const unit = metric === 'speed' ? speedUnit() : METRICS[metric].unit;
    return `${fmtNumber(value, metricDigits(metric))} ${unit}`;
  }

  function hexToRgba(hex, alpha) {
    const raw = hex.replace('#', '');
    const value = raw.length === 3
      ? raw.split('').map((char) => char + char).join('')
      : raw;
    const number = parseInt(value, 16);
    const red = (number >> 16) & 255;
    const green = (number >> 8) & 255;
    const blue = number & 255;
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  function niceMax(value, minimum = 10) {
    if (!Number.isFinite(value) || value <= 0) return minimum;
    const scaled = Math.max(value, minimum);
    const roughStep = scaled / 4;
    const exponent = Math.floor(Math.log10(roughStep));
    const base = Math.pow(10, exponent);
    const normalised = roughStep / base;
    const steps = [1, 2, 2.5, 3, 4, 5, 6, 8, 10];
    const step = steps.find((candidate) => normalised <= candidate) || 10;
    return step * base * 4;
  }

  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function setupCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function setHidden(element, hidden) {
    if (!element) return;
    element.hidden = Boolean(hidden);
  }

  function showToast(message, kind = '') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast show${kind ? ` ${kind}` : ''}`;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.className = 'toast';
    }, 3400);
  }

  async function api(path, method = 'GET', body) {
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) {
      if (window.__ECHELON_CLOUD__) throw new Error('API token rejected. Use Settings to enter a new one.');
      const target = `${location.pathname}${location.search}${location.hash}`;
      location.replace(`/login?next=${encodeURIComponent(target)}`);
      throw new Error('Authentication required.');
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!response.ok) {
      const message = data && data.error ? data.error : (response.statusText || `HTTP ${response.status}`);
      throw new Error(message);
    }
    return data;
  }

  async function downloadExport() {
    try {
      const response = await fetch('/api/export.csv');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'echelon-workouts.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      showToast(`Export failed: ${error.message}`, 'error');
    }
  }

  // ------------------------------------------------------------------ charts
  function drawLineChart(canvas, points, metric) {
    const { ctx, width, height } = setupCanvas(canvas);
    const conf = METRICS[metric];
    const color = chartColor(metric);
    const theme = chartTheme();
    const usable = (points || [])
      .map((point) => ({ point, value: metricValue(point, metric) }))
      .filter((entry) => entry.value !== null && entry.value !== undefined && Number.isFinite(Number(entry.value)));

    if (!usable.length) return false;

    const pad = { top: 16, right: 14, bottom: 26, left: 42 };
    const plotW = Math.max(1, width - pad.left - pad.right);
    const plotH = Math.max(1, height - pad.top - pad.bottom);
    const maxValue = niceMax(Math.max(...usable.map((entry) => Number(entry.value))) * 1.12, conf.minMax);
    const times = usable.map((entry) => Number(entry.point.t) || 0);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const span = Math.max(1, maxTime - minTime);

    const xFor = (time) => pad.left + ((time - minTime) / span) * plotW;
    const yFor = (value) => pad.top + plotH - (Number(value) / maxValue) * plotH;

    ctx.lineWidth = 1;
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i += 1) {
      const value = (maxValue / 4) * i;
      const y = yFor(value);
      ctx.strokeStyle = i === 0 ? theme.gridStrong : theme.grid;
      ctx.beginPath();
      ctx.moveTo(pad.left, Math.round(y) + 0.5);
      ctx.lineTo(width - pad.right, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = theme.text;
      ctx.textAlign = 'right';
      const tick = maxValue <= 12 ? value.toFixed(1) : Math.round(value);
      ctx.fillText(String(tick), pad.left - 8, y);
    }

    ctx.beginPath();
    usable.forEach((entry, index) => {
      const x = xFor(Number(entry.point.t) || 0);
      const y = yFor(Number(entry.value));
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    const lastEntry = usable[usable.length - 1];
    ctx.lineTo(xFor(Number(lastEntry.point.t) || 0), pad.top + plotH);
    ctx.lineTo(xFor(Number(usable[0].point.t) || 0), pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(color, 0.12);
    ctx.fill();

    ctx.beginPath();
    usable.forEach((entry, index) => {
      const x = xFor(Number(entry.point.t) || 0);
      const y = yFor(Number(entry.value));
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    const lastX = xFor(Number(lastEntry.point.t) || 0);
    const lastY = yFor(Number(lastEntry.value));
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lastX, lastY, 9, 0, Math.PI * 2);
    ctx.strokeStyle = hexToRgba(color, 0.28);
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = theme.text;
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const labels = 4;
    for (let i = 0; i <= labels; i += 1) {
      const time = minTime + (span / labels) * i;
      const x = xFor(time);
      ctx.textAlign = i === 0 ? 'left' : i === labels ? 'right' : 'center';
      ctx.fillText(fmtDuration(time), x, height - pad.bottom + 8);
    }
    return true;
  }

  function drawBarChart(canvas, daily, metric, hoverIndex) {
    const { ctx, width, height } = setupCanvas(canvas);
    const color = chartColor(metric);
    const theme = chartTheme();
    const conf = {
      minutes: { digits: 0, unit: 'min' },
      distance: { digits: 1, unit: distanceUnit() },
      cadence: { digits: 0, unit: 'rpm' },
    }[metric] || { digits: 0, unit: '' };

    const values = daily.map((day) => {
      if (metric === 'minutes') return day.minutes || 0;
      if (metric === 'distance') return convertDistance(day.distance_km || 0);
      return day.avg_cadence === null || day.avg_cadence === undefined ? null : day.avg_cadence;
    });
    const numeric = values.filter((value) => value !== null && Number.isFinite(Number(value)));
    const maxValue = niceMax(Math.max(0, ...numeric.map(Number)) * 1.15, metric === 'distance' ? 5 : 20);

    const pad = { top: 16, right: 12, bottom: 28, left: 40 };
    const plotW = Math.max(1, width - pad.left - pad.right);
    const plotH = Math.max(1, height - pad.top - pad.bottom);
    const slot = plotW / Math.max(1, daily.length);
    const barWidth = Math.max(3, Math.min(34, slot * 0.62));

    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i += 1) {
      const value = (maxValue / 4) * i;
      const y = pad.top + plotH - (value / maxValue) * plotH;
      ctx.strokeStyle = i === 0 ? theme.gridStrong : theme.grid;
      ctx.beginPath();
      ctx.moveTo(pad.left, Math.round(y) + 0.5);
      ctx.lineTo(width - pad.right, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = theme.text;
      ctx.textAlign = 'right';
      const tick = maxValue <= 10 ? value.toFixed(1) : Math.round(value);
      ctx.fillText(String(tick), pad.left - 8, y);
    }

    const layout = { pad, plotW, plotH, slot, barWidth, daily, values, metric, conf, width, height };
    canvas._layout = layout;

    daily.forEach((day, index) => {
      const value = values[index];
      if (value === null || value === undefined) return;
      const numericValue = Number(value);
      const barHeight = numericValue <= 0 ? 0 : Math.max(2, (numericValue / maxValue) * plotH);
      const x = pad.left + slot * index + (slot - barWidth) / 2;
      const y = pad.top + plotH - barHeight;
      const isHover = hoverIndex === index;

      if (numericValue > 0) {
        ctx.fillStyle = isHover ? color : hexToRgba(color, 0.82);
      } else {
        ctx.fillStyle = hexToRgba(theme.text, 0.14);
      }
      roundRect(ctx, x, y, barWidth, Math.max(barHeight, 2), Math.min(6, barWidth / 2));
      ctx.fill();
    });

    const labelStep = Math.ceil(daily.length / (width < 520 ? 5 : 8));
    const labelIndices = [];
    for (let index = 0; index < daily.length; index += labelStep) labelIndices.push(index);
    if (labelIndices[labelIndices.length - 1] !== daily.length - 1) {
      labelIndices.push(daily.length - 1);
      if (labelIndices.length > 2) {
        const previous = labelIndices[labelIndices.length - 2];
        const last = labelIndices[labelIndices.length - 1];
        if ((last - previous) * slot < 72) labelIndices.splice(labelIndices.length - 2, 1);
      }
    }
    const labelSet = new Set(labelIndices);
    ctx.fillStyle = theme.text;
    ctx.textBaseline = 'top';
    daily.forEach((day, index) => {
      if (!labelSet.has(index)) return;
      const date = parseDateOnly(day.date);
      const x = pad.left + slot * index + slot / 2;
      ctx.textAlign = index === 0 ? 'left' : index === daily.length - 1 ? 'right' : 'center';
      ctx.fillText(`${MONTHS[date.getMonth()]} ${date.getDate()}`, x, height - pad.bottom + 9);
    });

    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < daily.length) {
      const day = daily[hoverIndex];
      const index = hoverIndex;
      const x = pad.left + slot * index + slot / 2;
      ctx.strokeStyle = hexToRgba(color, 0.3);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, pad.top);
      ctx.lineTo(Math.round(x) + 0.5, pad.top + plotH);
      ctx.stroke();

      const date = parseDateOnly(day.date);
      const title = date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const first = metric === 'minutes'
        ? `${fmtNumber(day.minutes, 0)} minutes`
        : metric === 'distance'
          ? `${fmtDistance(day.distance_km, 1)} ${distanceUnit()}`
          : day.avg_cadence === null ? 'No cadence data' : `${fmtNumber(day.avg_cadence, 0)} rpm avg`;
      const second = `${day.workouts} ride${day.workouts === 1 ? '' : 's'} · ${fmtDistance(day.distance_km, 1)} ${distanceUnit()}`;
      const third = `${fmtDuration(day.seconds, true)} ridden`;

      ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
      const boxW = Math.max(
        ctx.measureText(title).width,
        ctx.measureText(first).width,
        ctx.measureText(second).width,
        ctx.measureText(third).width,
      ) + 22;
      const boxH = 64;
      let boxX = x - boxW / 2;
      boxX = Math.max(6, Math.min(width - boxW - 6, boxX));
      let boxY = pad.top + 4;
      const barY = pad.top + plotH - (Math.max(0, Number(values[index]) || 0) / maxValue) * plotH;
      if (barY - boxH - 12 > pad.top) boxY = barY - boxH - 10;

      ctx.fillStyle = theme.tooltipBg;
      ctx.strokeStyle = theme.tooltipLine;
      ctx.lineWidth = 1;
      roundRect(ctx, boxX, boxY, boxW, boxH, 9);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = theme.tooltipText;
      ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(title, boxX + 11, boxY + 9);
      ctx.fillStyle = color;
      ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(first, boxX + 11, boxY + 25);
      ctx.fillStyle = theme.text;
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(second, boxX + 11, boxY + 41);
      ctx.fillText(third, boxX + 11, boxY + 54);
    }

    return values.some((value) => value !== null && Number(value) > 0);
  }

  function drawLiveChart(force = false) {
    const now = performance.now();
    if (!force && now - state.lastLiveDraw < 350) return;
    state.lastLiveDraw = now;
    const hasData = drawLineChart($('#liveChart'), state.livePoints, state.liveMetric);
    setHidden($('#liveEmpty'), hasData);
    renderLiveFooter();
  }

  function drawTrendChart() {
    if (!state.stats) return;
    const daily = state.stats.daily;
    const hasData = drawBarChart($('#trendChart'), daily, state.trendMetric, state.trendHover);
    setHidden($('#trendEmpty'), hasData);
  }

  function drawDetailChart() {
    if (!state.detail) return;
    const samples = state.detail.samples || [];
    const hasData = drawLineChart($('#detailChart'), samples, state.detailMetric);
    const empty = $('#detailEmpty');
    if (!hasData) {
      const label = METRICS[state.detailMetric].label.toLowerCase();
      const strong = empty.querySelector('strong');
      const span = empty.querySelector('span');
      if (strong) strong.textContent = `No ${label} samples`;
      if (span) span.textContent = 'The bike did not report this field during the ride.';
    }
    setHidden(empty, hasData);
  }

  function canvasHoverIndex(canvas, event) {
    const layout = canvas._layout;
    if (!layout) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < layout.pad.left || x > layout.pad.left + layout.plotW) return null;
    const index = Math.floor((x - layout.pad.left) / layout.slot);
    if (index < 0 || index >= layout.daily.length) return null;
    return index;
  }

  // ------------------------------------------------------------------- render
  function renderStatus(status) {
    if (!status) return;
    state.status = status;
    const label = status.state === 'streaming'
      ? 'Streaming'
      : status.state === 'connected' || status.state === 'waiting_for_telemetry' || status.state === 'initializing' || status.state === 'subscribing'
        ? 'Connected'
        : status.state ? status.state.replaceAll('_', ' ') : 'Disconnected';
    $('#statusText').textContent = label.charAt(0).toUpperCase() + label.slice(1);

    const pill = $('#statusPill');
    pill.className = 'pill';
    if (status.state === 'streaming' || status.state === 'connected' || status.state === 'waiting_for_telemetry' || status.connected) {
      if (status.state === 'streaming') pill.classList.add('good');
      else if (status.state === 'error') pill.classList.add('bad');
      else pill.classList.add('warn');
    }
    if (status.state === 'error') pill.classList.add('bad');
    if (status.state === 'scanning' || status.state === 'connecting') pill.classList.add('warn');

    const device = status.device_name || status.device_address;
    const detail = status.last_error
      || (device
        ? `${device}${status.unlock_challenge_seen ? ' · challenge observed' : ''}`
        : 'Power on the bike, then scan. Close other apps using it first.');
    $('#deviceSub').textContent = detail;
    $('#deviceSub').title = status.last_error || '';

    const connected = Boolean(status.connected);
    const lock = $('#lockBtn');
    if (lock) lock.hidden = !status.auth_required;
    $('#connectBtn').disabled = !$('#deviceSelect').value;
    $('#disconnectBtn').disabled = !connected;
    $('#workoutBtn').disabled = !connected && !state.active;
    $('#scanBtn').disabled = status.state === 'scanning';

    renderWorkoutControls();
  }

  function renderWorkoutControls() {
    const active = state.active || state.status?.workout;
    const button = $('#workoutBtn');
    const badge = $('#trackingBadge');
    if (active) {
      button.textContent = 'Stop workout';
      button.classList.add('is-stop');
      button.disabled = false;
      badge.className = 'badge recording';
      badge.innerHTML = '<span class="badge-dot"></span>Recording';
    } else {
      button.textContent = 'Start workout';
      button.classList.remove('is-stop');
      button.disabled = state.status ? !state.status.connected : false;
      if (state.status && state.status.connected) {
        badge.className = 'badge';
        badge.innerHTML = '<span class="badge-dot"></span>Auto tracking';
        badge.title = 'Recording starts automatically when you pedal.';
      } else {
        badge.className = 'badge';
        badge.innerHTML = '<span class="badge-dot"></span>Not connected';
        badge.title = '';
      }
    }
  }

  function renderLive(telemetry) {
    if (telemetry) state.telemetry = telemetry;
    renderRide();
    if (!telemetry) return;
    const cadence = telemetry.cadence_rpm;
    const resistance = telemetry.resistance;
    const speed = telemetry.speed_kph_estimate;
    const distance = telemetry.distance_km;
    const elapsed = telemetry.elapsed_seconds;
    const power = telemetry.power_watts;

    $('#speedUnit').textContent = speedUnit();
    $('#distanceUnit').textContent = distanceUnit();

    $('#cadenceValue').textContent = cadence === null || cadence === undefined ? '—' : fmtNumber(cadence, 0);
    $('#resistanceValue').textContent = resistance === null || resistance === undefined ? '—' : fmtNumber(resistance, 0);
    $('#speedValue').textContent = speed === null || speed === undefined ? '—' : fmtNumber(convertSpeed(speed), 1);
    $('#distanceValue').textContent = distance === null || distance === undefined ? '—' : fmtNumber(convertDistance(distance), 2);
    $('#powerValue').textContent = power === null || power === undefined ? '—' : fmtNumber(power, 0);
    $('#elapsedValue').textContent = elapsed === null || elapsed === undefined
      ? '—'
      : fmtDuration(elapsed);
    $('#elapsedSub').textContent = state.active ? 'tracked session time' : 'bike timer';

    $('#cadenceMeter').style.width = cadence ? `${Math.min(100, (cadence / 130) * 100)}%` : '0%';
    $('#resistanceMeter').style.width = resistance ? `${Math.min(100, (resistance / 32) * 100)}%` : '0%';
    $('#speedMeter').style.width = speed ? `${Math.min(100, (convertSpeed(speed) / 28) * 100)}%` : '0%';

    if (telemetry.timestamp) {
      const seen = new Date(telemetry.timestamp);
      $('#lastPacket').textContent = `Last packet ${seen.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }
    const active = state.active || state.status?.workout;
    if (active) {
      const elapsedSeconds = Number(active.duration_seconds) || 0;
      $('#liveTracked').textContent = fmtDuration(elapsedSeconds);
      $('#elapsedValue').textContent = fmtDuration(elapsedSeconds);
      $('#distanceSub').textContent = 'tracked session';
      $('#distanceValue').textContent = fmtNumber(convertDistance(active.distance_km), 2);
    } else {
      $('#liveTracked').textContent = '—';
    }
  }

  // Metric-only ride screen: timer, power gauge, the remaining numbers, and a speed sparkline.
  function renderRide() {
    const telemetry = state.telemetry;
    const active = state.active || state.status?.workout || null;
    const live = (value) => value === null || value === undefined || Number.isNaN(Number(value));

    const elapsed = active ? Number(active.duration_seconds) || 0 : telemetry?.elapsed_seconds;
    const power = telemetry?.power_watts;
    const cadence = telemetry?.cadence_rpm;
    const resistance = telemetry?.resistance;
    const speed = telemetry?.speed_kph_estimate;
    const distance = active ? active.distance_km : telemetry?.distance_km;

    $('#rideClock').textContent = live(elapsed) ? '0:00' : fmtDuration(elapsed);
    $('#ridePower').textContent = live(power) ? '—' : fmtNumber(power, 0);
    $('#rideCadence').textContent = live(cadence) ? '—' : fmtNumber(cadence, 0);
    $('#rideResistance').textContent = live(resistance) ? '—' : fmtNumber(resistance, 0);
    $('#rideSpeed').textContent = live(speed) ? '—' : fmtNumber(convertSpeed(speed), 1);
    $('#rideDistance').textContent = live(distance) ? '—' : fmtNumber(convertDistance(distance), 2);
    $('#rideSpeedUnit').textContent = speedUnit();
    $('#rideDistanceUnit').textContent = distanceUnit();

    rememberRideSpeed(telemetry);

    const ring = $('#rideGauge');
    if (ring) {
      const circumference = 2 * Math.PI * ring.r.baseVal.value;
      const ratio = Math.min(1, Math.max(0, (live(power) ? 0 : Number(power)) / GAUGE_MAX_WATTS));
      ring.style.strokeDasharray = String(circumference);
      ring.style.strokeDashoffset = String(circumference * (1 - ratio));
    }

    drawRideChart();
  }

  // Rolling speed buffer for the Ride sparkline, independent of workout recording.
  function rememberRideSpeed(telemetry) {
    const stamp = telemetry?.timestamp;
    if (!stamp || stamp === state.rideStamp) return;
    state.rideStamp = stamp;
    const speed = Number(telemetry.speed_kph_estimate);
    if (!Number.isFinite(speed)) return;
    state.rideSpeed.push(speed);
    const excess = state.rideSpeed.length - RIDE_SPEED_SAMPLES;
    if (excess > 0) state.rideSpeed.splice(0, excess);
  }

  function drawRideChart() {
    const canvas = $('#rideChart');
    if (!canvas || !canvas.offsetParent) return;
    const { ctx, width, height } = setupCanvas(canvas);
    const color = chartColor('speed');

    const values = state.rideSpeed
      .map((speed) => convertSpeed(speed))
      .filter((speed) => Number.isFinite(speed));
    if (values.length < 2) return;

    const top = 10;
    const bottom = Math.max(top + 1, height - 10);
    const hi = Math.max(...values);
    const lo = Math.min(...values);
    const flat = hi - lo < 0.1;
    const span = flat ? 1 : hi - lo;
    const yFor = (value) => (flat ? (top + bottom) / 2 : bottom - ((value - lo) / span) * (bottom - top));
    const stepX = width / (values.length - 1);
    const xFor = (index) => index * stepX;

    ctx.beginPath();
    values.forEach((value, index) => {
      const x = xFor(index);
      const y = yFor(value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  function renderLiveFooter() {
    const points = state.livePoints;
    const metric = state.liveMetric;
    const values = points
      .map((point) => metricValue(point, metric))
      .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
      .map(Number);
    if (!values.length) {
      $('#liveAvg').textContent = '—';
      $('#livePeak').textContent = '—';
      $('#liveChartHint').textContent = state.active ? 'Waiting for samples' : 'Waiting for movement';
      return;
    }
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const peak = Math.max(...values);
    $('#liveAvg').textContent = metricText(average, metric);
    $('#livePeak').textContent = metricText(peak, metric);
    const lastT = Number(points[points.length - 1].t) || 0;
    $('#liveTracked').textContent = fmtDuration(lastT);
    $('#liveChartHint').textContent = `${METRICS[metric].label} · ${values.length} samples`;
  }

  function renderStats() {
    const stats = state.stats;
    if (!stats) return;
    const today = stats.totals?.today || { minutes: 0, distance_km: 0, avg_cadence: null, workouts: 0 };
    const goal = state.goalMinutes;
    const minutes = Number(today.minutes) || 0;
    const percent = goal > 0 ? Math.min(100, Math.round((minutes / goal) * 100)) : 0;
    const circumference = 2 * Math.PI * 50;

    const ring = $('#goalRing');
    ring.style.strokeDasharray = String(circumference);
    ring.style.strokeDashoffset = String(circumference * (1 - percent / 100));
    ring.classList.toggle('is-complete', minutes >= goal);
    $('#goalPercent').textContent = `${percent}%`;
    $('#goalText').textContent = `${fmtNumber(minutes, 0)} of ${goal} minutes today`;
    $('#goalInput').value = String(goal);

    const rideGoal = $('#rideGoal');
    if (rideGoal) {
      rideGoal.style.width = `${percent}%`;
      $('#rideGoalBar').setAttribute('aria-valuenow', String(percent));
    }

    $('#todayDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    $('#todayMinutes').textContent = fmtNumber(minutes, 0);
    $('#todayDistance').textContent = fmtNumber(convertDistance(today.distance_km), 1);
    $('#todayDistanceUnit').textContent = distanceUnit();
    $('#todayCadence').textContent = today.avg_cadence === null || today.avg_cadence === undefined ? '—' : fmtNumber(today.avg_cadence, 0);
    $('#todayWorkouts').textContent = fmtNumber(today.workouts, 0);
    $('#todayNote').textContent = today.workouts
      ? `${today.workouts} session${today.workouts === 1 ? '' : 's'} logged today. ${minutes >= goal ? 'Daily goal complete — nice work.' : `${fmtNumber(Math.max(0, goal - minutes), 0)} minutes to go.`}`
      : 'No workout recorded yet today.';

    const week = stats.totals?.week || { minutes: 0, distance_km: 0, workouts: 0 };
    const lifetime = stats.totals?.lifetime || { minutes: 0, distance_km: 0, workouts: 0 };
    $('#weekMinutes').textContent = fmtDuration(week.minutes * 60, true);
    $('#weekDistance').textContent = `${fmtNumber(convertDistance(week.distance_km), 1)} ${distanceUnit()} across ${fmtNumber(week.workouts, 0)} ride${week.workouts === 1 ? '' : 's'}`;
    $('#streakDays').textContent = `${fmtNumber(stats.streak_days, 0)} day${stats.streak_days === 1 ? '' : 's'}`;
    $('#streakSub').textContent = stats.streak_days
      ? 'Consecutive days with a saved ride'
      : 'Ride today to start one';
    $('#lifetimeDistance').textContent = `${fmtNumber(convertDistance(lifetime.distance_km), 1)} ${distanceUnit()}`;
    $('#lifetimeSub').textContent = `${fmtNumber(lifetime.workouts, 0)} rides · ${fmtDuration(lifetime.minutes * 60, true)}`;

    const farthest = stats.bests?.farthest;
    if (farthest) {
      $('#bestDistance').textContent = `${fmtNumber(convertDistance(farthest.distance_km), 1)} ${distanceUnit()}`;
      const when = relativeDay(farthest.started_at);
      $('#bestSub').textContent = `${when.title} · ${fmtDuration(farthest.duration_seconds)} · ${fmtNumber(farthest.avg_cadence, 0)} rpm`;
    } else {
      $('#bestDistance').textContent = '—';
      $('#bestSub').textContent = 'No rides yet';
    }

    const titles = {
      minutes: ['Minutes per day', 'Minutes ridden'],
      distance: ['Distance per day', `Distance ridden (${distanceUnit()})`],
      cadence: ['Average cadence per day', 'Average cadence'],
    };
    $('#trendTitle').textContent = titles[state.trendMetric][0];
    $('#trendLegend').textContent = titles[state.trendMetric][1];
    $('#trendHint').textContent = `Last ${state.trendDays} days`;
    drawTrendChart();
  }

  function renderWorkouts() {
    const list = $('#workoutList');
    list.textContent = '';
    const workouts = state.workouts;
    setHidden($('#historyEmpty'), workouts.length > 0);
    $('#historyFoot').textContent = workouts.length
      ? `${workouts.length} most recent session${workouts.length === 1 ? '' : 's'} · click any row for the full chart`
      : 'Sessions save automatically when a ride ends.';

    workouts.forEach((workout) => {
      const when = relativeDay(workout.started_at);
      const row = document.createElement('div');
      row.className = 'workout-row';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.dataset.id = String(workout.id);

      const date = document.createElement('span');
      date.className = 'workout-date';
      const dateTitle = document.createElement('strong');
      dateTitle.textContent = when.title;
      const dateSub = document.createElement('span');
      dateSub.textContent = `${when.sub} · ${workout.source === 'manual' ? 'Manual' : 'Auto'}`;
      date.append(dateTitle, dateSub);

      const duration = document.createElement('span');
      duration.className = 'workout-cell';
      duration.innerHTML = `<strong>${fmtDuration(workout.duration_seconds)}</strong><span>Duration</span>`;

      const distance = document.createElement('span');
      distance.className = 'workout-cell cell-distance';
      distance.innerHTML = `<strong>${fmtDistance(workout.distance_km, 2)} ${distanceUnit()}</strong><span>Distance</span>`;

      const cadence = document.createElement('span');
      cadence.className = 'workout-cell cell-cadence';
      cadence.innerHTML = `<strong>${workout.avg_cadence === null ? '—' : fmtNumber(workout.avg_cadence, 0)} rpm</strong><span>Avg cadence</span>`;

      const resistance = document.createElement('span');
      resistance.className = 'workout-cell cell-resistance';
      resistance.innerHTML = `<strong>${workout.avg_resistance === null ? '—' : fmtNumber(workout.avg_resistance, 0)}</strong><span>Resistance</span>`;

      const del = document.createElement('button');
      del.className = 'row-delete';
      del.type = 'button';
      del.setAttribute('aria-label', 'Delete workout');
      del.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg>';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        deleteWorkout(workout);
      });

      row.append(date, duration, distance, cadence, resistance, del);
      row.addEventListener('click', () => openDetail(workout.id));
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openDetail(workout.id);
        }
      });
      list.appendChild(row);
    });
  }

  // --------------------------------------------------------------- data loads
  async function fetchStatus() {
    try {
      const status = await api('/status');
      renderStatus(status);
      renderLive(status.latest);
      if (status.workout) state.active = { ...(state.active || {}), ...status.workout };
      renderWorkoutControls();
    } catch (error) {
      console.warn('Status load failed', error);
    }
  }

  async function fetchStats() {
    try {
      state.stats = await api(`/api/stats?days=${state.trendDays}`);
      renderStats();
    } catch (error) {
      showToast(`Could not load stats: ${error.message}`, 'error');
    }
  }

  async function fetchWorkouts() {
    try {
      const data = await api('/api/workouts?limit=100');
      state.workouts = data.workouts || [];
      renderWorkouts();
    } catch (error) {
      showToast(`Could not load workouts: ${error.message}`, 'error');
    }
  }

  async function fetchActive() {
    try {
      const data = await api('/api/workout/active');
      if (data.active && data.workout) {
        state.active = data.workout;
        state.livePoints = (data.workout.samples || []).map((sample) => ({
          t: Number(sample.t) || 0,
          cadence: sample.cadence,
          speed: sample.speed,
          resistance: sample.resistance,
          distance: sample.distance,
        }));
      } else {
        state.active = null;
        state.livePoints = [];
      }
      renderWorkoutControls();
      drawLiveChart(true);
    } catch (error) {
      console.warn('Active workout load failed', error);
    }
  }

  async function refreshHistory() {
    await Promise.all([fetchStats(), fetchWorkouts(), fetchActive(), fetchStatus()]);
  }

  function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => { refreshHistory(); }, 450);
  }

  // ---------------------------------------------------------------- workouts
  async function startWorkout() {
    try {
      await api('/api/workout/start', 'POST');
      showToast('Workout tracking started', 'success');
      state.livePoints = [];
      await refreshHistory();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function stopWorkout() {
    try {
      const result = await api('/api/workout/stop', 'POST');
      if (result.workout) {
        showToast(`Workout saved · ${fmtDuration(result.workout.duration_seconds)} · ${fmtDistance(result.workout.distance_km, 2)} ${distanceUnit()}`, 'success');
      } else {
        showToast('Session was too short to save.');
      }
      await refreshHistory();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function deleteWorkout(workout) {
    if (!confirm('Delete this workout from your history? This cannot be undone.')) return;
    try {
      await api(`/api/workouts/${workout.id}`, 'DELETE');
      showToast('Workout deleted');
      await refreshHistory();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function openDetail(id) {
    try {
      const workout = await api(`/api/workouts/${id}`);
      state.detail = workout;
      state.detailMetric = 'cadence';
      $$('#detailMetrics button').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.metric === 'cadence');
      });
      renderDetail();
      const dialog = $('#detailDialog');
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      try { history.replaceState(null, '', `${location.pathname}?workout=${id}${location.hash}`); } catch { /* ignore */ }
      drawDetailChart();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function renderDetail() {
    const workout = state.detail;
    if (!workout) return;
    const when = relativeDay(workout.started_at);
    $('#detailDate').textContent = fullDate(workout.started_at);
    $('#detailTitle').textContent = rideTitle(workout.started_at);
    $('#detailExport').href = '/api/export.csv';

    const chips = [
      ['Duration', fmtDuration(workout.duration_seconds)],
      ['Distance', `${fmtDistance(workout.distance_km, 2)} ${distanceUnit()}`],
      ['Avg cadence', workout.avg_cadence === null ? '—' : `${fmtNumber(workout.avg_cadence, 0)} rpm`],
      ['Peak cadence', workout.max_cadence === null ? '—' : `${fmtNumber(workout.max_cadence, 0)} rpm`],
      ['Avg speed', workout.avg_speed === null ? '—' : `${fmtNumber(convertSpeed(workout.avg_speed), 1)} ${speedUnit()}`],
      ['Avg resistance', workout.avg_resistance === null ? '—' : fmtNumber(workout.avg_resistance, 0)],
      ['Samples', fmtNumber(workout.sample_count, 0)],
      ['Source', workout.source === 'manual' ? 'Manual' : 'Auto'],
    ];
    const container = $('#detailChips');
    container.textContent = '';
    chips.forEach(([label, value]) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const strong = document.createElement('strong');
      strong.textContent = value;
      chip.append(strong, document.createTextNode(label));
      container.appendChild(chip);
    });
    if (when.title === 'Today') $('#detailTitle').textContent = `${rideTitle(workout.started_at)} · today`;
    drawDetailChart();
  }

  // ------------------------------------------------------------------- events
  function addEvent(event) {
    if (!event) return;
    const key = `${event.timestamp || ''}|${event.message || ''}`;
    if (state.seenEvents.has(key)) return;
    state.seenEvents.add(key);
    if (state.seenEvents.size > 600) {
      state.seenEvents = new Set(Array.from(state.seenEvents).slice(-300));
    }
    const line = document.createElement('div');
    if (event.level === 'error') line.className = 'err';
    const ts = event.timestamp ? new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const stamp = document.createElement('span');
    stamp.className = 'ts';
    stamp.textContent = ts ? `${ts}  ` : '';
    line.appendChild(stamp);
    line.appendChild(document.createTextNode(event.message || ''));
    const log = $('#events');
    log.appendChild(line);
    while (log.children.length > 200) log.firstElementChild.remove();
    if (log.parentElement && log.parentElement.open) log.scrollTop = log.scrollHeight;
  }

  // ------------------------------------------------------------------ sockets
  function connectSocket() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws/telemetry`);
    state.socket = socket;

    socket.addEventListener('open', () => {
      state.socketRetry = 0;
    });

    socket.addEventListener('message', (message) => {
      let payload;
      try { payload = JSON.parse(message.data); } catch { return; }
      if (payload.type === 'status') {
        const previousId = state.active?.id ?? null;
        renderStatus(payload.status);
        renderLive(payload.status.latest);
        if (payload.status.workout) {
          state.active = { ...(state.active || {}), ...payload.status.workout };
        } else if (state.active && !payload.status.connected) {
          state.active = null;
        }
        const newId = payload.status.workout?.id ?? null;
        if (newId !== previousId) fetchActive();
        renderWorkoutControls();
      } else if (payload.type === 'telemetry') {
        renderLive(payload.telemetry);
        ingestTelemetry(payload.telemetry);
      } else if (payload.type === 'event') {
        addEvent(payload.event);
      } else if (payload.type === 'workout') {
        handleWorkoutEvent(payload);
      }
    });

    socket.addEventListener('close', (event) => {
      if (event.code === 1008) {
        const target = `${location.pathname}${location.search}${location.hash}`;
        location.replace(`/login?next=${encodeURIComponent(target)}`);
        return;
      }
      state.socketRetry = Math.min(state.socketRetry + 1, 6);
      setTimeout(connectSocket, 800 * state.socketRetry);
    });
    socket.addEventListener('error', () => {
      try { socket.close(); } catch { /* ignore */ }
    });
  }

  function ingestTelemetry(telemetry) {
    const active = state.active || state.status?.workout;
    if (!active || !telemetry) return;
    const startedAt = active.started_at ? new Date(active.started_at).getTime() : NaN;
    let t;
    if (Number.isFinite(startedAt)) {
      t = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    } else {
      t = (Number(state.livePoints[state.livePoints.length - 1]?.t) || 0) + 1;
    }
    const last = state.livePoints[state.livePoints.length - 1];
    if (last && t <= last.t) t = last.t + 1;
    if (last && t - last.t < 1) return;
    state.livePoints.push({
      t,
      cadence: telemetry.cadence_rpm,
      speed: telemetry.speed_kph_estimate,
      resistance: telemetry.resistance,
      distance: telemetry.distance_km,
    });
    if (state.livePoints.length > 4000) state.livePoints.splice(0, state.livePoints.length - 4000);
    drawLiveChart();
  }

  function handleWorkoutEvent(payload) {
    if (payload.event === 'started') {
      state.livePoints = [];
      if (payload.workout) state.active = payload.workout;
      setHidden($('#liveEmpty'), false);
      showToast(payload.workout?.source === 'manual' ? 'Workout tracking started' : 'Auto tracking started — ride on!', 'success');
      fetchActive();
    } else if (payload.event === 'saved' || payload.event === 'stopped') {
      state.livePoints = [];
      state.active = null;
      if (payload.event === 'saved' && payload.workout) {
        const workout = payload.workout;
        showToast(`Workout saved · ${fmtDuration(workout.duration_seconds)} · ${fmtDistance(workout.distance_km, 2)} ${distanceUnit()}`, 'success');
      }
      scheduleRefresh();
    } else if (payload.event === 'deleted') {
      scheduleRefresh();
    }
    renderWorkoutControls();
  }

  // -------------------------------------------------------------------- setup
  function bindEvents() {
    $('#scanBtn').addEventListener('click', async () => {
      const button = $('#scanBtn');
      button.disabled = true;
      button.textContent = 'Scanning…';
      $('#deviceSelect').innerHTML = '<option value="">Scanning for bike…</option>';
      try {
        const data = await api('/scan', 'POST');
        const select = $('#deviceSelect');
        select.innerHTML = '';
        if (data.timed_out) {
          select.innerHTML = '<option value="">No answer from the bike agent</option>';
          showToast('No answer from the bike agent. Start it on the bike machine, then scan again.', 'error');
          addEvent({ level: 'error', message: 'Scan timed out: the bike agent did not respond. Start aws_agent.py on the bike machine.', timestamp: new Date().toISOString() });
        } else if (!data.devices || !data.devices.length) {
          select.innerHTML = '<option value="">No likely Echelon devices found</option>';
          showToast('The agent scanned but found no Echelon bike. Wake the bike (pedal a few turns) and scan again.', 'error');
        } else {
          data.devices.forEach((device) => {
            const option = document.createElement('option');
            option.value = device.address;
            option.dataset.name = device.name || 'Echelon';
            option.textContent = `${device.name || 'Echelon'} · ${device.address}${device.rssi !== null && device.rssi !== undefined ? ` (${device.rssi} dBm)` : ''}`;
            select.appendChild(option);
          });
          showToast(`Found ${data.devices.length} device${data.devices.length === 1 ? '' : 's'}`);
        }
        select.dispatchEvent(new Event('change'));
        renderStatus(state.status);
      } catch (error) {
        showToast(error.message, 'error');
        addEvent({ level: 'error', message: error.message, timestamp: new Date().toISOString() });
      } finally {
        button.disabled = false;
        button.textContent = 'Scan';
      }
    });

    $('#connectBtn').addEventListener('click', async () => {
      const option = $('#deviceSelect').selectedOptions[0];
      if (!option || !option.value) return;
      const button = $('#connectBtn');
      button.disabled = true;
      button.textContent = 'Connecting…';
      try {
        const status = await api('/connect', 'POST', {
          address: option.value,
          name: option.dataset.name || option.textContent || 'Echelon',
        });
        renderStatus(status);
        showToast('Connected. Waiting for telemetry…');
        state.livePoints = [];
      } catch (error) {
        showToast(error.message, 'error');
        fetchStatus();
      } finally {
        button.textContent = 'Connect';
        button.disabled = !$('#deviceSelect').value;
      }
    });

    $('#disconnectBtn').addEventListener('click', async () => {
      try {
        const status = await api('/disconnect', 'POST');
        renderStatus(status);
        showToast('Disconnected');
        state.active = null;
        state.livePoints = [];
        drawLiveChart(true);
        refreshHistory();
      } catch (error) {
        showToast(error.message, 'error');
      }
    });

    $('#workoutBtn').addEventListener('click', () => {
      const active = state.active || state.status?.workout;
      if (active) stopWorkout();
      else startWorkout();
    });

    $('#deviceSelect').addEventListener('change', () => {
      $('#connectBtn').disabled = !$('#deviceSelect').value;
    });

    $$('#liveMetrics button').forEach((button) => {
      button.addEventListener('click', () => {
        state.liveMetric = button.dataset.metric;
        $$('#liveMetrics button').forEach((item) => item.classList.toggle('is-active', item === button));
        drawLiveChart(true);
      });
    });

    $$('#detailMetrics button').forEach((button) => {
      button.addEventListener('click', () => {
        state.detailMetric = button.dataset.metric;
        $$('#detailMetrics button').forEach((item) => item.classList.toggle('is-active', item === button));
        drawDetailChart();
      });
    });

    $$('#rangeTabs button').forEach((button) => {
      button.addEventListener('click', async () => {
        state.trendDays = Number(button.dataset.days) || 30;
        $$('#rangeTabs button').forEach((item) => item.classList.toggle('is-active', item === button));
        await fetchStats();
      });
    });

    $$('#trendMetrics button').forEach((button) => {
      button.addEventListener('click', () => {
        state.trendMetric = button.dataset.metric;
        state.trendHover = null;
        $$('#trendMetrics button').forEach((item) => item.classList.toggle('is-active', item === button));
        renderStats();
      });
    });

    $('#goalInput').addEventListener('change', () => {
      state.goalMinutes = clampGoal($('#goalInput').value);
      localStorage.setItem(GOAL_KEY, String(state.goalMinutes));
      renderStats();
      showToast(`Daily goal set to ${state.goalMinutes} minutes`);
    });

    $('#exportBtn').addEventListener('click', () => { downloadExport(); });
    $('#detailExport').addEventListener('click', (event) => {
      event.preventDefault();
      downloadExport();
    });

    $$('#unitTabs button').forEach((button) => {
      button.addEventListener('click', () => setUnits(button.dataset.unit));
    });
    $$('#themeTabs button').forEach((button) => {
      button.addEventListener('click', () => setTheme(button.dataset.theme));
    });

    const settingsButton = $('#settingsBtn');
    if (settingsButton) settingsButton.addEventListener('click', () => openSettings(''));
    const settingsDialog = $('#settingsDialog');
    if (settingsDialog) {
      const close = () => closeSettings();
      $('#settingsClose')?.addEventListener('click', close);
      $('#settingsDone')?.addEventListener('click', close);
      settingsDialog.addEventListener('click', (event) => {
        if (event.target === settingsDialog) close();
      });
    }

    window.addEventListener('echelon:configured', () => {
      refreshHistory();
    });

    window.addEventListener('hashchange', () => {
      applyPage();
      window.scrollTo(0, 0);
    });

    $('#refreshBtn').addEventListener('click', () => {
      refreshHistory();
      showToast('History refreshed');
    });

    const trendCanvas = $('#trendChart');
    trendCanvas.addEventListener('mousemove', (event) => {
      const index = canvasHoverIndex(trendCanvas, event);
      if (index !== state.trendHover) {
        state.trendHover = index;
        drawTrendChart();
      }
    });
    trendCanvas.addEventListener('mouseleave', () => {
      if (state.trendHover !== null) {
        state.trendHover = null;
        drawTrendChart();
      }
    });

    const dialog = $('#detailDialog');
    const closeDialog = () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      try { history.replaceState(null, '', `${location.pathname}${location.hash}`); } catch { /* ignore */ }
    };
    $('#detailClose').addEventListener('click', closeDialog);
    $('#detailDone').addEventListener('click', closeDialog);
    dialog.addEventListener('close', () => {
      try { history.replaceState(null, '', `${location.pathname}${location.hash}`); } catch { /* ignore */ }
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeDialog();
    });
    $('#detailDelete').addEventListener('click', async () => {
      if (!state.detail) return;
      const workout = state.detail;
      if (!confirm('Delete this workout from your history? This cannot be undone.')) return;
      try {
        await api(`/api/workouts/${workout.id}`, 'DELETE');
        closeDialog();
        showToast('Workout deleted');
        await refreshHistory();
      } catch (error) {
        showToast(error.message, 'error');
      }
    });

    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const canvas = entry.target;
        if (canvas.id === 'liveChart') drawLiveChart(true);
        else if (canvas.id === 'trendChart') drawTrendChart();
        else if (canvas.id === 'detailChart') drawDetailChart();
        else if (canvas.id === 'rideChart') drawRideChart();
      });
    });
    ['#liveChart', '#trendChart', '#detailChart', '#rideChart'].forEach((selector) => {
      const canvas = $(selector);
      if (canvas) observer.observe(canvas);
    });
  }

  async function init() {
    applyTheme();
    syncUnitControls();
    applyPage();
    $('#goalInput').value = String(state.goalMinutes);
    bindEvents();
    connectSocket();
    await Promise.allSettled([fetchStatus(), fetchStats(), fetchWorkouts(), fetchActive()]);
    try {
      const events = await api('/events');
      if (Array.isArray(events)) events.forEach(addEvent);
    } catch { /* log endpoint is optional */ }
    const requestedWorkout = new URLSearchParams(location.search).get('workout');
    if (requestedWorkout) openDetail(requestedWorkout);
    drawLiveChart(true);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
