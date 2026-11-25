/*
 * Direct Bluetooth transport for the Echelon dashboard (Web Bluetooth).
 *
 * Ports protocol.py and the storage.WorkoutRecorder rules to the browser so a
 * phone running Chrome for Android can own the BLE link with no local agent.
 * Web Bluetooth is unavailable in Safari/iOS, so the cloud build falls back to
 * the remote-agent mode there.
 *
 * QZ attribution: the challenge/response algorithm was discovered and
 * documented by Christian Emerson (@christianbemerson); see protocol.py.
 */
(function () {
  'use strict';

  const SERVICE_UUID = '0bf669f1-45f2-11e7-9598-0800200c9a66';
  const WRITE_UUID = '0bf669f2-45f2-11e7-9598-0800200c9a66';
  const NOTIFY_UUIDS = [
    '0bf669f3-45f2-11e7-9598-0800200c9a66',
    '0bf669f4-45f2-11e7-9598-0800200c9a66',
  ];
  const POLL_INTERVAL_SECONDS = 2;
  const SAMPLE_INTERVAL_SECONDS = 5;
  const MIN_TRACKED_SECONDS = 10;
  const MIN_TRACKED_SAMPLES = 2;

  // ------------------------------------------------------------------ codec
  function hexOf(bytes) {
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(' ').toUpperCase();
  }

  function decimalPrefix(bytes) {
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    let digits = '';
    for (const char of hex) {
      if (char < '0' || char > '9') break;
      digits += char;
    }
    if (!digits) throw new Error('challenge contains a byte pair with no decimal prefix');
    return Number.parseInt(digits, 10);
  }

  function responseForChallenge(challenge) {
    if (challenge.length !== 8) throw new Error(`expected 8-byte challenge, got ${challenge.length}`);
    if (challenge[0] !== 0xf0 || challenge[1] !== 0xe0) {
      throw new Error('invalid challenge prefix; expected F0 E0');
    }
    const a = decimalPrefix([challenge[4], challenge[2]]);
    const b = decimalPrefix([challenge[3], challenge[5]]);
    const c = decimalPrefix([challenge[6]]);
    if (c === 0) throw new Error('challenge divisor is zero');
    const value = (a * b) % c;
    if (value < 0 || value > 99) throw new Error(`auth value outside 0..99: ${value}`);
    const response = Uint8Array.from([0xf0, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00]);
    response[4] = ((Math.floor(value / 10) << 4) | (value % 10)) & 0xff;
    let checksum = 0;
    response.forEach((byte) => { checksum = (checksum + byte) & 0xff; });
    return Uint8Array.from([...response, checksum]);
  }

  function activationCommand() {
    return Uint8Array.from([0xf0, 0xb0, 0x01, 0x01, 0xa2]);
  }

  function pollCommand(counter) {
    const frame = Uint8Array.from([0xf0, 0xa0, 0x01, 0x00, 0x00]);
    frame[3] = counter & 0xff;
    let sum = 0;
    for (let index = 0; index < 4; index += 1) sum = (sum + frame[index]) & 0xff;
    frame[4] = sum;
    return frame;
  }

  function initFrames() {
    const first = Uint8Array.from([0xf0, 0xa1, 0x00, 0x91]);
    const second = Uint8Array.from([0xf0, 0xa3, 0x00, 0x93]);
    return [first, first, first, first, second, first];
  }

  function decodeTelemetry(frame) {
    if (frame.length === 5 && frame[0] === 0xf0 && frame[1] === 0xd2) {
      return { resistance: frame[3] };
    }
    if (frame.length === 13) {
      const elapsed = (frame[3] << 8) | frame[4];
      const distance = ((frame[7] << 8) | frame[8]) / 100;
      const cadence = frame[10];
      return {
        elapsed_seconds: elapsed,
        distance_km: Math.round(distance * 100) / 100,
        cadence_rpm: cadence,
        speed_kph_estimate: Math.round(0.37497622 * cadence * 100) / 100,
        power_watts: null,
      };
    }
    return null;
  }

  /** Browser port of power.calculate_echelon_watts. */
  function calculateEchelonWatts(cadence, resistance, gain, matchOfficialApp) {
    const calibration = gain === undefined || gain === null ? 1 : Number(gain);
    if (!(cadence > 0)) return 0;
    const level = Math.max(1, Math.min(32, Number(resistance)));
    const magneticWatts = 0.0022 * Math.exp(0.115 * level) * (cadence ** 1.85);
    const drivetrainWatts = 0.25 * cadence;
    let watts = (magneticWatts + drivetrainWatts) * calibration;
    if (matchOfficialApp) watts *= 1.2;
    return Math.round(watts * 10) / 10;
  }

  // ---------------------------------------------------------------- helpers
  function localIso(value) {
    const pad = (number) => String(Math.floor(Math.abs(number))).padStart(2, '0');
    const offset = -value.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
      + `T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
      + `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
  }

  function localDate(value) {
    const pad = (number) => String(number).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------------------------------------------------------------- recorder
  class WorkoutTracker {
    constructor() {
      this.workoutId = null;
      this.source = 'auto';
      this.autoPaused = false;
      this.startedAt = null;
      this.startedClock = 0;
      this.lastSampleClock = 0;
      this.samples = [];
      this.sampleCount = 0;
      this.startDistance = null;
      this.lastDistance = null;
      this.startElapsed = null;
      this.lastElapsed = null;
      this.resetAccumulators();
    }

    resetAccumulators() {
      this.cadenceSum = 0;
      this.cadenceN = 0;
      this.cadenceMax = null;
      this.speedSum = 0;
      this.speedN = 0;
      this.speedMax = null;
      this.resistanceSum = 0;
      this.resistanceN = 0;
      this.resistanceMax = null;
    }

    get active() {
      return this.workoutId !== null;
    }

    clock() {
      return performance.now() / 1000;
    }

    resetForConnection() {
      this.autoPaused = false;
    }

    start(source) {
      if (this.active) return this.summary();
      this.startedAt = new Date();
      this.source = source || 'auto';
      this.startedClock = this.clock();
      this.lastSampleClock = this.startedClock;
      this.samples = [];
      this.sampleCount = 0;
      this.startDistance = null;
      this.lastDistance = null;
      this.startElapsed = null;
      this.lastElapsed = null;
      this.resetAccumulators();
      this.workoutId = `${this.startedAt.getTime()}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
      return this.summary();
    }

    handle(metrics) {
      let event = null;
      if (!this.active) {
        const moving = (metrics.cadence_rpm || 0) > 0;
        if (this.autoPaused || !moving) return null;
        this.start('auto');
        event = 'started';
      }

      const cadence = metrics.cadence_rpm;
      const speed = metrics.speed_kph_estimate;
      const resistance = metrics.resistance;
      const distance = metrics.distance_km;
      const elapsed = metrics.elapsed_seconds;

      if (cadence !== null && cadence !== undefined && cadence > 0) {
        this.cadenceSum += cadence;
        this.cadenceN += 1;
        this.cadenceMax = Math.max(this.cadenceMax || 0, cadence);
      }
      if (speed !== null && speed !== undefined) {
        this.speedSum += speed;
        this.speedN += 1;
        this.speedMax = Math.max(this.speedMax || 0, speed);
      }
      if (resistance !== null && resistance !== undefined) {
        this.resistanceSum += resistance;
        this.resistanceN += 1;
        this.resistanceMax = Math.max(this.resistanceMax || 0, resistance);
      }
      if (distance !== null && distance !== undefined) {
        if (this.startDistance === null) this.startDistance = distance;
        this.lastDistance = distance;
      }
      if (elapsed !== null && elapsed !== undefined) {
        if (this.startElapsed === null) this.startElapsed = elapsed;
        this.lastElapsed = elapsed;
      }

      const now = this.clock();
      if (now - this.lastSampleClock >= SAMPLE_INTERVAL_SECONDS) {
        this.lastSampleClock = now;
        this.samples.push({
          t: Math.max(0, Math.round(now - this.startedClock)),
          cadence: cadence === undefined ? null : cadence,
          speed: speed === undefined ? null : speed,
          resistance: resistance === undefined ? null : resistance,
          distance: distance === undefined ? null : distance,
        });
        this.sampleCount += 1;
      }
      return event;
    }

    fields() {
      let duration = Math.round(this.clock() - this.startedClock);
      if (this.lastElapsed !== null && this.startElapsed !== null && this.lastElapsed >= this.startElapsed) {
        duration = this.lastElapsed - this.startElapsed;
      }
      duration = Math.max(0, duration);

      let distance = 0;
      if (this.lastDistance !== null && this.startDistance !== null) {
        distance = this.lastDistance - this.startDistance;
        if (distance < 0) distance = this.lastDistance;
      }

      const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
      return {
        duration_seconds: duration,
        distance_km: round(Math.max(0, distance), 2),
        avg_cadence: this.cadenceN ? round(this.cadenceSum / this.cadenceN, 1) : null,
        max_cadence: this.cadenceMax,
        avg_speed: this.speedN ? round(this.speedSum / this.speedN, 1) : null,
        max_speed: this.speedMax,
        avg_resistance: this.resistanceN ? round(this.resistanceSum / this.resistanceN, 1) : null,
        max_resistance: this.resistanceMax,
        sample_count: this.sampleCount,
      };
    }

    summary() {
      if (!this.active || !this.startedAt) return null;
      return Object.assign({
        id: this.workoutId,
        started_at: localIso(this.startedAt),
        ended_at: null,
        date: localDate(this.startedAt),
      }, this.fields(), { source: this.source });
    }

    snapshot() {
      const summary = this.summary();
      if (!summary) return null;
      summary.samples = this.samples.slice();
      return summary;
    }

    stop() {
      if (!this.active) return null;
      const fields = this.fields();
      const summary = Object.assign({
        id: this.workoutId,
        started_at: localIso(this.startedAt),
        ended_at: localIso(new Date()),
        date: localDate(this.startedAt),
      }, fields, { source: this.source, samples: this.samples.slice() });

      this.workoutId = null;
      this.startedAt = null;
      if (fields.duration_seconds < MIN_TRACKED_SECONDS && fields.sample_count < MIN_TRACKED_SAMPLES) {
        return null;
      }
      return summary;
    }
  }

  // -------------------------------------------------------------------- bike
  class BikeBle {
    constructor() {
      this.listeners = [];
      this.device = null;
      this.devicePromise = null;
      this.server = null;
      this.writeChar = null;
      this.notifyChars = [];
      this.state = 'disconnected';
      this.lastError = null;
      this.latest = this.emptyMetrics();
      this.events = [];
      this.tracker = new WorkoutTracker();
      this.unlockAttempted = false;
      this.unlockSeen = false;
      this.pollTimer = null;
      this.pollCounter = 1;
      this.connecting = false;
      this.onConnect = null;
      this.onWorkout = null;
    }

    static get supported() {
      return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth && navigator.bluetooth.requestDevice);
    }

    emptyMetrics() {
      return {
        timestamp: null, connected: false, state: 'disconnected',
        cadence_rpm: null, speed_kph_estimate: null, resistance: null,
        distance_km: null, elapsed_seconds: null, power_watts: null,
        last_frame_hex: null,
      };
    }

    subscribe(handler) {
      this.listeners.push(handler);
      return () => {
        this.listeners = this.listeners.filter((item) => item !== handler);
      };
    }

    emit(payload) {
      this.listeners.slice().forEach((handler) => {
        try { handler(payload); } catch (error) { console.error(error); }
      });
    }

    log(message, level) {
      const event = {
        timestamp: new Date().toISOString(),
        level: level || 'info',
        message,
        data: null,
      };
      this.events.push(event);
      this.events = this.events.slice(-200);
      console.log(`[ble] ${message}`);
      this.emit({ type: 'event', event });
    }

    status() {
      return {
        state: this.state,
        connected: Boolean(this.device && this.server && this.device.gatt.connected),
        device_name: this.device ? this.device.name || 'Echelon' : null,
        device_address: this.device ? this.device.id : null,
        last_error: this.lastError,
        unlock_challenge_seen: this.unlockSeen,
        auth_required: false,
        latest: this.latest,
        workout: this.tracker.summary(),
        source: 'browser',
      };
    }

    broadcastStatus() {
      this.emit({ type: 'status', status: this.status() });
    }

    /**
     * Must be called synchronously from a user gesture: Chrome only allows the
     * device chooser during transient activation, which an awaited fetch()
     * would consume.
     */
    primeDevice() {
      if (!BikeBle.supported) return;
      this.state = 'scanning';
      this.broadcastStatus();
      this.devicePromise = navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'ECH' }, { services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
      });
      this.devicePromise.catch(() => {});
    }

    async scan() {
      if (!BikeBle.supported) {
        throw new Error('This browser has no Web Bluetooth. Use Chrome on Android, or switch to remote-agent mode.');
      }
      this.log('Scanning for BLE devices…');
      let device;
      const pending = this.devicePromise;
      this.devicePromise = null;
      try {
        device = await (pending || navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'ECH' }, { services: [SERVICE_UUID] }],
          optionalServices: [SERVICE_UUID],
        }));
      } catch (error) {
        this.state = 'disconnected';
        this.broadcastStatus();
        if (error && error.name === 'NotFoundError') {
          this.log('Scan cancelled.', 'info');
          return [];
        }
        this.lastError = error.message || String(error);
        this.log(`BLE scan failed: ${this.lastError}`, 'error');
        throw error;
      }
      this.device = device;
      this.state = 'disconnected';
      this.log(`Found ${device.name || 'Echelon device'}.`);
      this.broadcastStatus();
      return [{
        name: device.name || '(unnamed Echelon device)',
        address: device.id,
        rssi: null,
        service_uuids: [SERVICE_UUID],
      }];
    }

    async write(bytes) {
      if (!this.writeChar) throw new Error('not connected');
      const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      if (this.writeChar.writeValueWithoutResponse) {
        await this.writeChar.writeValueWithoutResponse(data);
      } else if (this.writeChar.writeValue) {
        await this.writeChar.writeValue(data);
      } else {
        await this.writeChar.writeValueWithResponse(data);
      }
    }

    async connect() {
      const device = this.device;
      if (!device) throw new Error('Scan for the bike first.');
      if (this.connecting) return this.status();
      this.connecting = true;
      this.state = 'connecting';
      this.lastError = null;
      this.unlockAttempted = false;
      this.unlockSeen = false;
      this.latest = this.emptyMetrics();
      this.tracker.resetForConnection();
      this.log(`Connecting to ${device.name || 'Echelon device'}…`);
      this.broadcastStatus();

      try {
        const server = await device.gatt.connect();
        this.server = server;
        this.disconnectHandler = () => this.handleDisconnect();
        device.addEventListener('gattserverdisconnected', this.disconnectHandler);

        this.state = 'subscribing';
        this.broadcastStatus();
        const service = await server.getPrimaryService(SERVICE_UUID);
        const characteristics = await service.getCharacteristics();
        const byUuid = new Map(characteristics.map((char) => [char.uuid.toLowerCase(), char]));
        this.writeChar = byUuid.get(WRITE_UUID);
        if (!this.writeChar) throw new Error(`Expected characteristic ${WRITE_UUID} is missing.`);

        this.notifyChars = [];
        for (const uuid of NOTIFY_UUIDS) {
          const char = byUuid.get(uuid.toLowerCase());
          if (!char) throw new Error(`Expected characteristic ${uuid} is missing.`);
          char.addEventListener('characteristicvaluechanged', (event) => this.handleFrame(event.target.value));
          await char.startNotifications();
          this.notifyChars.push(char);
        }
        this.log('Subscribed to both QZ notification characteristics.');

        this.state = 'initializing';
        this.broadcastStatus();
        for (const frame of initFrames()) {
          await this.write(frame);
          await sleep(120);
        }
        if (!this.unlockAttempted) {
          await this.write(activationCommand());
          this.log('No challenge observed during init; sent standard QZ activation frame.');
        }

        this.state = 'waiting_for_telemetry';
        this.latest.connected = true;
        this.latest.state = this.state;
        this.startPolling();
        this.log('Sent QZ initialization frames; waiting for challenge/telemetry.');
        if (this.onConnect) this.onConnect();
        this.broadcastStatus();
        return this.status();
      } catch (error) {
        await this.teardown();
        this.lastError = error.message || String(error);
        this.state = 'error';
        this.log(`Connect/setup failed: ${this.lastError}`, 'error');
        this.broadcastStatus();
        throw error;
      } finally {
        this.connecting = false;
      }
    }

    async teardown() {
      this.stopPolling();
      const device = this.device;
      if (device && this.disconnectHandler) {
        try { device.removeEventListener('gattserverdisconnected', this.disconnectHandler); } catch { /* ignore */ }
        this.disconnectHandler = null;
      }
      this.server = null;
      this.writeChar = null;
      this.notifyChars = [];
      if (device && device.gatt && device.gatt.connected) {
        try { device.gatt.disconnect(); } catch { /* ignore */ }
      }
    }

    handleDisconnect() {
      const savedWorkout = this.finishWorkout(false);
      this.stopPolling();
      this.state = 'disconnected';
      this.latest.connected = false;
      this.latest.state = 'disconnected';
      this.log('Bike disconnected.');
      this.broadcastStatus();
      if (savedWorkout && this.onWorkout) this.onWorkout(savedWorkout);
    }

    async disconnect(quiet) {
      const savedWorkout = this.finishWorkout(false);
      await this.teardown();
      this.state = 'disconnected';
      this.latest.connected = false;
      this.latest.state = 'disconnected';
      if (!quiet) this.log('Disconnected by request.');
      this.broadcastStatus();
      if (savedWorkout && this.onWorkout) this.onWorkout(savedWorkout);
      return this.status();
    }

    startWorkout() {
      if (!this.tracker) return null;
      const summary = this.tracker.start('manual');
      this.tracker.autoPaused = false;
      this.log('Manual workout tracking started.');
      this.emit({ type: 'workout', event: 'started', workout: summary });
      this.broadcastStatus();
      return summary;
    }

    stopWorkout() {
      this.tracker.autoPaused = true;
      const summary = this.finishWorkout(true);
      this.broadcastStatus();
      return summary;
    }

    finishWorkout(manual) {
      const summary = this.tracker.stop();
      if (!summary) {
        if (manual) {
          this.log('Workout stopped without enough data to save.');
          this.emit({ type: 'workout', event: 'stopped', workout: null });
        }
        return null;
      }
      const minutes = Math.floor(summary.duration_seconds / 60);
      const seconds = summary.duration_seconds % 60;
      this.log(`Workout ${manual ? 'stopped' : 'saved'}: ${minutes}m ${String(seconds).padStart(2, '0')}s · `
        + `${summary.distance_km.toFixed(2)} km · avg ${Math.round(summary.avg_cadence || 0)} rpm`);
      this.emit({ type: 'workout', event: 'saved', workout: summary });
      return summary;
    }

    handleFrame(value) {
      const view = value instanceof DataView ? value : new DataView(value.buffer || value);
      const bytes = new Uint8Array(view.byteLength);
      for (let index = 0; index < view.byteLength; index += 1) bytes[index] = view.getUint8(index);
      this.ingest(bytes);
    }

    ingest(bytes) {
      const hex = hexOf(bytes);
      this.log(`BLE notification: ${hex}`);

      if (bytes.length === 8 && bytes[0] === 0xf0 && bytes[1] === 0xe0) {
        this.unlockSeen = true;
        if (!this.unlockAttempted) {
          this.unlockAttempted = true;
          let response = null;
          try {
            response = responseForChallenge(bytes);
          } catch (error) {
            this.lastError = error.message;
            this.log(`Challenge did not match QZ codec: ${error.message}`, 'error');
          }
          if (response) {
            this.log(`QZ challenge recognized; sending response ${hexOf(response)}.`);
            this.write(response)
              .then(() => sleep(500))
              .then(() => this.write(activationCommand()))
              .then(() => this.log(`Sent QZ activation command: ${hexOf(activationCommand())}`))
              .catch((error) => {
                this.lastError = error.message;
                this.log(`Unlock write failed: ${error.message}`, 'error');
              });
          }
        }
      }

      const parsed = decodeTelemetry(bytes);
      if (parsed) {
        this.latest = Object.assign({}, this.latest, parsed, {
          timestamp: new Date().toISOString(),
          connected: Boolean(this.device && this.server),
          state: 'streaming',
          last_frame_hex: hex,
        });
        this.latest.power_watts = this.estimatePower();
        this.state = 'streaming';
        const started = this.tracker.handle(parsed);
        if (started === 'started') {
          this.log('Workout tracking started automatically.');
          this.emit({ type: 'workout', event: 'started', workout: this.tracker.summary() });
        }
        this.emit({ type: 'telemetry', telemetry: Object.assign({}, this.latest) });
      }
      this.broadcastStatus();
    }

    estimatePower() {
      const cadence = this.latest.cadence_rpm;
      const resistance = this.latest.resistance;
      if (cadence === null || cadence === undefined) return null;
      if (resistance === null || resistance === undefined) return null;
      return calculateEchelonWatts(cadence, resistance);
    }

    startPolling() {      this.stopPolling();
      this.pollCounter = 1;
      this.pollTimer = setInterval(() => {
        if (!this.device || !this.device.gatt.connected) return;
        const frame = pollCommand(this.pollCounter);
        this.pollCounter = (this.pollCounter % 255) + 1;
        this.write(frame).catch((error) => {
          this.lastError = error.message;
          this.log(`Keepalive poll failed: ${error.message}`, 'error');
        });
      }, POLL_INTERVAL_SECONDS * 1000);
    }

    stopPolling() {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  window.EchelonBle = {
    supported: BikeBle.supported,
    create: () => new BikeBle(),
    codec: {
      responseForChallenge, decodeTelemetry, initFrames, pollCommand,
      activationCommand, hexOf, calculateWatts: calculateEchelonWatts,
    },
  };
})();
