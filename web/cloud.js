/*
 * AWS transport for the hosted dashboard.
 *
 * The local build talks to app.py on the same origin. The hosted build talks to
 * API Gateway, where the BLE bridge (aws_agent.py) is the only thing connected
 * to the bike. This shim:
 *   - routes /api/* and /status style paths to the AWS API with x-api-token
 *   - implements the WebSocket endpoint with polling
 *   - turns the asynchronous AWS commands into the synchronous responses the
 *     dashboard expects (scan, connect, disconnect, workout start/stop)
 *   - wires the API URL/token fields into the shared settings dialog
 */
(function () {
  'use strict';

  const KEYS = { api: 'echelon.apiUrl', token: 'echelon.apiToken' };
  const config = window.ECHELON_CONFIG || {};
  const nativeFetch = window.fetch.bind(window);
  const NativeWebSocket = window.WebSocket;
  const settings = {
    apiUrl: String(localStorage.getItem(KEYS.api) || config.apiUrl || '').replace(/\/+$/, ''),
    token: localStorage.getItem(KEYS.token) || '',
  };
  let waiters = [];

  window.__ECHELON_CLOUD__ = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function todayLocal() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  // --------------------------------------------------------------- settings
  function needsConfig() {
    return !settings.apiUrl || !settings.token;
  }

  function setStatus(message) {
    const status = document.getElementById('apiStatus');
    if (status) status.textContent = message || '';
  }

  function fillFields() {
    const group = document.getElementById('cloudSettings');
    if (group) group.hidden = false;
    const url = document.getElementById('apiUrlInput');
    const token = document.getElementById('apiTokenInput');
    if (url) url.value = settings.apiUrl;
    if (token) token.value = settings.token;
  }

  function openForConfig(message) {
    fillFields();
    setStatus(message || '');
    if (window.EchelonSettings) window.EchelonSettings.open('');
  }

  function waitForConfig() {
    return new Promise((resolve) => { waiters.push(resolve); });
  }

  async function ensureConfig() {
    if (!needsConfig()) return true;
    openForConfig('Enter the API token for your Echelon service.');
    return waitForConfig();
  }

  function saveSettings() {
    const urlInput = document.getElementById('apiUrlInput');
    const tokenInput = document.getElementById('apiTokenInput');
    const apiUrl = String((urlInput && urlInput.value) || '').trim().replace(/\/+$/, '');
    const token = String((tokenInput && tokenInput.value) || '').trim();
    if (!/^https?:\/\//i.test(apiUrl)) {
      setStatus('Enter the full https API URL.');
      return;
    }
    if (!token) {
      setStatus('Enter the API token from your CloudFormation deploy output.');
      return;
    }
    settings.apiUrl = apiUrl;
    settings.token = token;
    localStorage.setItem(KEYS.api, apiUrl);
    localStorage.setItem(KEYS.token, token);
    setStatus('Saved.');
    const pending = waiters;
    waiters = [];
    pending.forEach((resolve) => resolve(true));
    window.dispatchEvent(new Event('echelon:configured'));
  }

  function forgetToken() {
    settings.token = '';
    localStorage.removeItem(KEYS.token);
    const input = document.getElementById('apiTokenInput');
    if (input) input.value = '';
    setStatus('Token removed. Add it again to load ride history.');
  }

  // ------------------------------------------------------------------- http
  async function request(path, init) {
    await ensureConfig();
    const options = Object.assign({}, init);
    const headers = Object.assign({}, (init && init.headers) || {});
    headers['x-api-token'] = settings.token;
    options.headers = headers;

    let response = await nativeFetch(settings.apiUrl + path, options);
    if (response.status === 401) {
      openForConfig('The API token was rejected. Enter the current token.');
      const saved = await waitForConfig();
      if (saved) {
        headers['x-api-token'] = settings.token;
        response = await nativeFetch(settings.apiUrl + path, options);
      }
    }
    return response;
  }

  function getJson(path) {
    return request(path).then((response) => (response.ok ? response.json() : null));
  }

  function toApiPath(path) {
    const split = path.indexOf('?');
    const rawPath = split === -1 ? path : path.slice(0, split);
    const query = split === -1 ? '' : path.slice(split);

    if (rawPath === '/api/workout/active') return '/workouts/active';
    if (rawPath === '/api/workout/start') return '/workouts/start';
    if (rawPath === '/api/workout/stop') return '/workouts/stop';
    if (rawPath === '/api/export.csv') return '/export.csv';
    if (rawPath === '/api/stats') return `/stats${query ? `${query}&` : '?'}today=${todayLocal()}`;
    if (rawPath === '/api/workouts') return `/workouts${query}`;
    if (rawPath.indexOf('/api/workouts/') === 0) return `/workouts/${rawPath.slice('/api/workouts/'.length)}`;
    if (['/status', '/events', '/scan', '/connect', '/disconnect'].indexOf(rawPath) !== -1) {
      return rawPath + query;
    }
    return null;
  }

  // ------------------------------------------------------ command round trips
  async function runScan() {
    const before = await getJson('/scan-result');
    const created = await request('/scan', { method: 'POST' });
    if (!created.ok) return created;

    const deadline = Date.now() + 22000;
    while (Date.now() < deadline) {
      await sleep(1200);
      const result = await getJson('/scan-result');
      if (result && result.updated_at && (!before || before.updated_at !== result.updated_at)) {
        return jsonResponse({ devices: result.devices || [] });
      }
    }
    // No agent picked the command up: an empty list here would be misleading.
    return jsonResponse({ devices: [], timed_out: true });
  }

  async function runConnect(init) {
    let body = {};
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
    const created = await request('/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!created.ok) return created;

    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      await sleep(1200);
      const status = await getJson('/status');
      if (!status) continue;
      if (status.connected) return jsonResponse(status);
      if (status.state === 'error' && status.last_error) {
        return jsonResponse({ error: status.last_error, status }, 502);
      }
    }
    const status = await getJson('/status');
    return jsonResponse(status || { error: 'No response from the BLE agent.' }, status ? 200 : 504);
  }

  async function runDisconnect() {
    const created = await request('/disconnect', { method: 'POST' });
    if (!created.ok) return created;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await sleep(900);
      const status = await getJson('/status');
      if (status && !status.connected) return jsonResponse(status);
    }
    return jsonResponse((await getJson('/status')) || {});
  }

  async function runWorkoutStart() {
    const created = await request('/workouts/start', { method: 'POST' });
    if (!created.ok) return created;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(900);
      const active = await getJson('/workouts/active');
      if (active && active.active && active.workout) {
        return jsonResponse({ ok: true, workout: active.workout });
      }
    }
    return jsonResponse({ ok: false, workout: null });
  }

  async function runWorkoutStop() {
    const before = await getJson('/workouts/active');
    const previousId = before && before.active && before.workout ? before.workout.id : null;
    const created = await request('/workouts/stop', { method: 'POST' });
    if (!created.ok) return created;

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await sleep(900);
      const active = await getJson('/workouts/active');
      if (active && active.active) continue;
      const list = await getJson('/workouts?limit=10');
      const saved = ((list && list.workouts) || []).filter((w) => w.id !== previousId)[0];
      if (saved) return jsonResponse({ ok: true, workout: saved });
      if (previousId === null) return jsonResponse({ ok: true, workout: null });
    }
    return jsonResponse({ ok: true, workout: null });
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.charAt(0) !== '/' || url.indexOf('//') === 0) return nativeFetch(input, init);
    const target = toApiPath(url);
    if (!target) return nativeFetch(input, init);

    const method = String((init && init.method) || 'GET').toUpperCase();
    if (method === 'POST' && url === '/scan') return runScan();
    if (method === 'POST' && url === '/connect') return runConnect(init);
    if (method === 'POST' && url === '/disconnect') return runDisconnect();
    if (method === 'POST' && url === '/api/workout/start') return runWorkoutStart();
    if (method === 'POST' && url === '/api/workout/stop') return runWorkoutStop();
    return request(target, init);
  };

  // ------------------------------------------------------- websocket bridge
  class DashboardSocket {
    constructor() {
      this.listeners = new Map();
      this.closed = false;
      this.timer = null;
      this.ticks = 0;
      this.lastTelemetry = null;
      this.seenEvents = [];
      this.activeId = undefined;
      setTimeout(() => {
        if (this.closed) return;
        this.emit('open');
        this.loop();
      }, 0);
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }

    removeEventListener(type, handler) {
      const handlers = this.listeners.get(type);
      if (handlers) this.listeners.set(type, handlers.filter((item) => item !== handler));
    }

    emit(type, init) {
      const event = type === 'message'
        ? new MessageEvent('message', { data: init })
        : new Event(type);
      (this.listeners.get(type) || []).slice().forEach((handler) => {
        try { handler(event); } catch (error) { console.error(error); }
      });
    }

    send() { /* polling needs no client keepalive */ }

    close() {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.timer);
      this.emit('close');
    }

    push(payload) {
      this.emit('message', JSON.stringify(payload));
    }

    pollStatus() {
      return getJson('/status').then((status) => {
        if (!status || this.closed) return;
        this.push({ type: 'status', status });
        const stamp = status.latest && status.latest.timestamp;
        if (stamp && stamp !== this.lastTelemetry) {
          this.lastTelemetry = stamp;
          this.push({ type: 'telemetry', telemetry: status.latest });
        }
      }).catch(() => {});
    }

    pollEvents() {
      return getJson('/events').then((events) => {
        if (!Array.isArray(events) || this.closed) return;
        events.slice().reverse().forEach((event) => {
          const key = `${event.timestamp || ''}|${event.message || ''}`;
          if (this.seenEvents.indexOf(key) !== -1) return;
          this.seenEvents.push(key);
          this.push({ type: 'event', event });
        });
        if (this.seenEvents.length > 800) this.seenEvents = this.seenEvents.slice(-400);
      }).catch(() => {});
    }

    pollActive() {
      return getJson('/workouts/active').then(async (active) => {
        if (this.closed) return;
        const id = active && active.active && active.workout ? active.workout.id : null;
        if (this.activeId === undefined) {
          this.activeId = id;
          return;
        }
        if (id && id !== this.activeId) {
          this.activeId = id;
          this.push({ type: 'workout', event: 'started', workout: active.workout });
          return;
        }
        if (!id && this.activeId) {
          const previousId = this.activeId;
          this.activeId = null;
          const list = await getJson('/workouts?limit=25');
          const saved = ((list && list.workouts) || []).filter((w) => w.id === previousId)[0];
          this.push({ type: 'workout', event: 'saved', workout: saved || null });
        }
      }).catch(() => {});
    }

    async loop() {
      if (this.closed) return;
      if (needsConfig()) {
        this.timer = setTimeout(() => this.loop(), 3000);
        return;
      }
      this.ticks += 1;
      try {
        await this.pollStatus();
        if (this.ticks % 4 === 0) await this.pollEvents();
        if (this.ticks % 5 === 0) await this.pollActive();
      } catch (error) {
        console.warn('Polling failed', error);
      }
      this.timer = setTimeout(() => this.loop(), 1000);
    }
  }

  window.WebSocket = function (url) {
    if (String(url).indexOf('/ws/telemetry') === -1) return new NativeWebSocket(url);
    return new DashboardSocket();
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;

  // ------------------------------------------------------------ dashboard bits
  document.addEventListener('DOMContentLoaded', () => {
    fillFields();
    document.getElementById('saveApiBtn')?.addEventListener('click', saveSettings);
    document.getElementById('forgetTokenBtn')?.addEventListener('click', forgetToken);

    const hint = document.getElementById('dbHint');
    if (hint) hint.textContent = 'History: AWS DynamoDB';
    const foot = document.querySelector('.page-foot span:first-child');
    if (foot) foot.textContent = 'Hosted dashboard · data in your AWS account';

    if (needsConfig()) {
      openForConfig('Enter the API token from your CloudFormation deploy output.');
    }
  });

  window.EchelonCloud = {
    saveSettings,
    forgetToken,
    get settings() { return { ...settings }; },
  };
})();
