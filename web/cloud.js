/*
 * Cloud transport for the Echelon dashboard (GitHub Pages build).
 *
 * The local build talks to app.py on the same origin. This shim keeps
 * static/app.js unchanged and supports two connection modes:
 *
 *   phone  - this browser owns the BLE link through Web Bluetooth (ble.js);
 *            AWS is only used to store finished workouts and read history.
 *   agent  - a machine near the bike runs aws_agent.py; every request goes to
 *            the AWS API and live updates come from polling.
 *
 * It also turns the asynchronous AWS commands into the synchronous responses
 * the dashboard expects (scan, connect, disconnect, workout start/stop).
 */
(function () {
  'use strict';

  const KEYS = { api: 'echelon.apiUrl', token: 'echelon.apiToken', mode: 'echelon.mode' };
  const PENDING_KEY = 'echelon.pendingWorkouts';
  const bleSupported = Boolean(window.EchelonBle && window.EchelonBle.supported);
  const config = window.ECHELON_CONFIG || {};
  const nativeFetch = window.fetch.bind(window);
  const NativeWebSocket = window.WebSocket;
  const settings = {
    apiUrl: String(config.apiUrl || localStorage.getItem(KEYS.api) || '').replace(/\/+$/, ''),
    token: localStorage.getItem(KEYS.token) || '',
    mode: localStorage.getItem(KEYS.mode) || (bleSupported ? 'phone' : 'agent'),
  };
  if (!bleSupported) settings.mode = 'agent';
  const bike = settings.mode === 'phone' ? window.EchelonBle.create() : null;

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

  function readPending() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writePending(list) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(-50))); } catch { /* ignore */ }
  }

  // --------------------------------------------------------------- settings
  let gate = null;

  function askForSettings(message) {
    if (gate) return gate;
    gate = new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;'
        + 'justify-content:center;padding:18px;background:rgba(15,17,21,0.55);';

      const form = document.createElement('form');
      form.style.cssText = 'width:100%;max-width:440px;display:grid;gap:14px;padding:24px;'
        + 'border-radius:14px;background:var(--surface,#ffffff);color:var(--text,#12161d);'
        + 'border:1px solid var(--line-strong,#cdd2da);font:14px/1.5 "Segoe UI",system-ui,sans-serif;';

      const title = document.createElement('h2');
      title.textContent = 'Echelon settings';
      title.style.cssText = 'margin:0;font-size:18px;letter-spacing:0.01em;';

      const note = document.createElement('p');
      note.textContent = message;
      note.style.cssText = 'margin:0;color:var(--muted,#5a6472);font-size:13px;';

      const field = (labelText, input) => {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:grid;gap:6px;font-size:12px;letter-spacing:0.06em;'
          + 'text-transform:uppercase;color:var(--muted-2,#7b8494);';
        wrap.append(document.createTextNode(labelText), input);
        return wrap;
      };

      const inputStyle = 'padding:10px 12px;border-radius:8px;'
        + 'border:1px solid var(--line-strong,#cdd2da);'
        + 'background:var(--surface-2,#f5f6f8);color:var(--text,#12161d);'
        + 'font:13px/1.4 ui-monospace,Consolas,monospace;text-transform:none;';

      const modeSelect = document.createElement('select');
      modeSelect.style.cssText = inputStyle;
      const phoneOption = document.createElement('option');
      phoneOption.value = 'phone';
      phoneOption.textContent = 'This device (Bluetooth)';
      const agentOption = document.createElement('option');
      agentOption.value = 'agent';
      agentOption.textContent = 'Remote agent (AWS)';
      modeSelect.append(phoneOption, agentOption);
      if (!bleSupported) {
        phoneOption.disabled = true;
        phoneOption.textContent = 'This device (not supported by this browser)';
      }
      modeSelect.value = settings.mode;

      const apiInput = document.createElement('input');
      apiInput.type = 'url';
      apiInput.required = true;
      apiInput.placeholder = 'https://abc123.execute-api.us-east-1.amazonaws.com';
      apiInput.value = settings.apiUrl;
      apiInput.style.cssText = inputStyle;

      const tokenInput = document.createElement('input');
      tokenInput.type = 'password';
      tokenInput.required = true;
      tokenInput.placeholder = 'x-api-token value';
      tokenInput.autocomplete = 'off';
      tokenInput.style.cssText = inputStyle;

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = 'Save';
      submit.style.cssText = 'padding:11px 16px;border-radius:9px;border:0;cursor:pointer;'
        + 'background:var(--accent,#15803d);color:var(--accent-contrast,#ffffff);font-weight:700;font-size:14px;';

      const hint = document.createElement('p');
      hint.textContent = bleSupported
        ? 'Bluetooth mode connects this browser to the bike. The API URL and token are only used for workout history. Values stay in this browser.'
        : 'This browser has no Web Bluetooth (iPhone, Firefox). Use Chrome on Android for direct Bluetooth, or run the agent near the bike.';
      hint.style.cssText = 'margin:0;color:var(--muted-2,#7b8494);font-size:11.5px;';

      form.append(
        title, note,
        field('Connection mode', modeSelect),
        field('API URL', apiInput),
        field('API token', tokenInput),
        submit, hint,
      );
      overlay.appendChild(form);

      const finish = (ok) => {
        overlay.remove();
        gate = null;
        resolve(ok);
      };

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const apiUrl = apiInput.value.trim().replace(/\/+$/, '');
        const token = tokenInput.value.trim();
        if (!/^https?:\/\//i.test(apiUrl) || !token) {
          note.textContent = 'Enter the full https URL and the API token.';
          return;
        }
        const modeChanged = modeSelect.value !== settings.mode;
        settings.apiUrl = apiUrl;
        settings.token = token;
        settings.mode = modeSelect.value;
        localStorage.setItem(KEYS.api, apiUrl);
        localStorage.setItem(KEYS.token, token);
        localStorage.setItem(KEYS.mode, settings.mode);
        finish(true);
        if (modeChanged) setTimeout(() => location.reload(), 50);
      });

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay && settings.apiUrl && settings.token) finish(false);
      });

      document.body.appendChild(overlay);
      tokenInput.focus();
    });
    return gate;
  }

  function ensureConfig() {
    if (settings.apiUrl && settings.token) return Promise.resolve(true);
    return askForSettings(
      'Enter the API Gateway URL and token from your CloudFormation deploy output.',
    );
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
      const saved = await askForSettings('The API token was rejected. Enter the current token.');
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

  // ------------------------------------------------- workout upload (phone)
  async function uploadWorkout(workout) {
    try {
      const response = await request('/workouts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(workout),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return true;
    } catch (error) {
      const pending = readPending().filter((item) => item.id !== workout.id);
      pending.push(workout);
      writePending(pending);
      if (bike) bike.log(`Workout kept on this device; upload retried later (${error.message}).`, 'info');
      return false;
    }
  }

  async function flushPending() {
    if (!bike || !settings.apiUrl || !settings.token) return;
    const pending = readPending();
    if (!pending.length) return;
    const keep = [];
    for (const workout of pending) {
      try {
        const response = await request('/workouts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(workout),
        });
        if (!response.ok) {
          keep.push(workout);
          continue;
        }
        bike.log(`Uploaded saved workout from ${workout.started_at}.`);
      } catch {
        keep.push(workout);
      }
    }
    writePending(keep);
  }

  if (bike) {
    bike.onConnect = () => { flushPending(); };
    bike.onWorkout = (workout) => { uploadWorkout(workout); };
  }

  // ---------------------------------------------------------------- routing
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

  async function localScan() {
    try {
      return jsonResponse({ devices: await bike.scan() });
    } catch (error) {
      return jsonResponse({ error: error.message }, 500);
    }
  }

  async function localConnect() {
    try {
      return jsonResponse(await bike.connect());
    } catch (error) {
      return jsonResponse({ error: error.message, status: bike.status() }, 502);
    }
  }

  async function localDisconnect() {
    try {
      return jsonResponse(await bike.disconnect(false));
    } catch (error) {
      return jsonResponse({ error: error.message, status: bike.status() }, 500);
    }
  }

  async function localWorkoutStop() {
    const summary = bike.stopWorkout();
    if (summary) await uploadWorkout(summary);
    return jsonResponse({ ok: true, workout: summary });
  }

  // Must stay synchronous: a null return means "not handled here, use AWS".
  function localBikeRoute(url, method) {
    if (!bike) return null;
    const rawPath = url.split('?')[0];

    if (rawPath === '/status' && method === 'GET') return jsonResponse(bike.status());
    if (rawPath === '/events' && method === 'GET') return jsonResponse(bike.events.slice().reverse());
    if (rawPath === '/scan' && method === 'POST') return localScan();
    if (rawPath === '/connect' && method === 'POST') return localConnect();
    if (rawPath === '/disconnect' && method === 'POST') return localDisconnect();

    if (rawPath === '/api/workout/active' && method === 'GET') {
      const snapshot = bike.tracker.snapshot();
      return jsonResponse({ active: Boolean(snapshot), workout: snapshot });
    }
    if (rawPath === '/api/workout/start' && method === 'POST') {
      const summary = bike.startWorkout();
      return jsonResponse({ ok: Boolean(summary), workout: summary });
    }
    if (rawPath === '/api/workout/stop' && method === 'POST') return localWorkoutStop();

    return null;
  }

  // ------------------------------------------------------ agent round trips
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
    return jsonResponse({ devices: [] });
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
    const method = String((init && init.method) || 'GET').toUpperCase();

    const local = localBikeRoute(url, method);
    if (local) return local;

    const target = toApiPath(url);
    if (!target) return nativeFetch(input, init);

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
      this.unsubscribe = null;
      this.maintenance = null;
      setTimeout(() => {
        if (this.closed) return;
        this.emit('open');
        if (bike) this.startLocal();
        else this.loop();
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

    send() { /* neither mode needs a client keepalive */ }

    close() {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.timer);
      if (this.maintenance) clearInterval(this.maintenance);
      if (this.unsubscribe) this.unsubscribe();
      this.emit('close');
    }

    push(payload) {
      this.emit('message', JSON.stringify(payload));
    }

    startLocal() {
      this.unsubscribe = bike.subscribe((payload) => {
        if (!this.closed) this.push(payload);
      });
      this.push({ type: 'status', status: bike.status() });
      this.push({ type: 'telemetry', telemetry: bike.latest });
      bike.events.slice(-50).forEach((event) => this.push({ type: 'event', event }));
      flushPending();
      this.maintenance = setInterval(() => {
        if (settings.apiUrl && settings.token) flushPending();
      }, 30000);
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
      if (!settings.apiUrl || !settings.token) {
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
    const lock = document.getElementById('lockBtn');
    if (lock) {
      lock.hidden = false;
      lock.textContent = 'Settings';
      lock.setAttribute('href', '#');
      lock.title = settings.mode === 'phone'
        ? 'Connecting from this device over Bluetooth'
        : 'Connecting through the remote agent';
      lock.addEventListener('click', (event) => {
        event.preventDefault();
        askForSettings('Update the connection mode, API URL, or token.');
      });
    }

    // Chrome only allows the device chooser during transient activation, so the
    // agent's fetch('/scan') cannot open it. Prime it from the real click.
    if (bike) {
      const scanButton = document.getElementById('scanBtn');
      if (scanButton) {
        scanButton.addEventListener('click', () => { bike.primeDevice(); }, true);
      }
      // Closing the tab mid-ride would otherwise drop the workout: keep the
      // partial session on the device and let the next visit upload it.
      window.addEventListener('beforeunload', () => {
        try {
          if (bike.tracker.active) {
            const summary = bike.tracker.stop();
            if (summary) {
              const pending = readPending().filter((item) => item.id !== summary.id);
              pending.push(summary);
              writePending(pending);
            }
          }
        } catch (error) {
          console.warn('Could not persist in-progress workout', error);
        }
        bike.disconnect(true);
      });
    }

    const hint = document.getElementById('dbHint');
    if (hint) hint.textContent = 'History: AWS DynamoDB';
    const foot = document.querySelector('.page-foot span:first-child');
    if (foot) {
      foot.textContent = settings.mode === 'phone'
        ? 'Bluetooth from this device · history in your AWS account'
        : 'Hosted dashboard · data in your AWS account';
    }
  });

  // Prompt once at startup when the site has no configuration yet.
  window.addEventListener('load', () => { ensureConfig(); });

  window.EchelonCloud = {
    get mode() { return settings.mode; },
    get bike() { return bike; },
  };
})();
