'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const DreameXp2pRuntimeBootstrap = require('./DreameXp2pRuntimeBootstrap');

const REQUEST_MAGIC = Buffer.from('DXP1');
const RESPONSE_MAGIC = Buffer.from('DXR1');
const FIELD_COUNT = 20;
const MAX_RESPONSE = 64 * 1024;
const COMMAND_TIMEOUT_US = 7_500_000;
const HA_PARITY_STATUS_ATTEMPTS = 8;
const HA_PARITY_RETRY_MS = 500;
const HA_PARITY_DELEGATE_ATTEMPTS = 8;
const DIAGNOSTIC_STATUS_ATTEMPTS = 1;
const DIAGNOSTIC_RETRY_MS = 250;
const DIAGNOSTIC_DELEGATE_ATTEMPTS = 2;
const HA_PARITY_WATCHDOG_MS = 73_000;
const DIAGNOSTIC_WATCHDOG_MS = 10_000;

class DreameXp2pRunner {
  constructor(device) {
    this.device = device;
    this.homey = device.homey;
    this._process = null;
    this._streamUrl = null;
    this._runtime = null;
    this._bootstrap = new DreameXp2pRuntimeBootstrap(device);
  }

  _candidateRoots() {
    const appPath = this.homey?.app?.getPath?.() || process.cwd();
    return [
      path.join('/userdata', 'dreame-xp2p'),
      path.join(appPath, 'native', 'xp2p', 'runtime'),
      path.join(appPath, 'native', 'xp2p'),
    ];
  }

  _isExecutable(file) {
    try {
      fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch (_) { return false; }
  }

  _isFile(file) {
    try { return fs.statSync(file).isFile(); } catch (_) { return false; }
  }

  detectRuntime() {
    for (const root of this._candidateRoots()) {
      const workerCandidates = [
        path.join(root, 'bin', 'dreame-xp2p-host-runner'),
        path.join(root, 'dreame-xp2p-host-runner'),
      ];
      const linkerCandidates = [
        path.join(root, 'bin', 'linker64'),
        path.join(root, 'linker64'),
      ];
      const libraryCandidates = [
        path.join(root, 'lib', 'libiot_video_demo.so'),
        path.join(root, 'lib64', 'libiot_video_demo.so'),
        path.join(root, 'libiot_video_demo.so'),
      ];
      const worker = workerCandidates.find((f) => this._isExecutable(f));
      const linker = linkerCandidates.find((f) => this._isExecutable(f));
      const library = libraryCandidates.find((f) => this._isFile(f));
      if (!worker || !linker || !library) continue;

      const libDirs = [
        path.dirname(library),
        path.join(root, 'lib'),
        path.join(root, 'lib', 'bionic'),
        path.join(root, 'lib64'),
        path.join(root, 'lib64', 'bionic'),
      ].filter((dir, idx, all) => {
        try { return fs.statSync(dir).isDirectory() && all.indexOf(dir) === idx; } catch (_) { return false; }
      });
      this._runtime = { root, worker, linker, library, libDirs };
      return this._runtime;
    }
    this._runtime = null;
    return null;
  }

  runtimeSummary() {
    const runtime = this._runtime || this.detectRuntime();
    return {
      available: !!runtime,
      root: runtime ? runtime.root : null,
      architecture: process.arch,
      platform: process.platform,
    };
  }

  _u32(value) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value >>> 0, 0);
    return b;
  }

  _u64(value) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(Math.max(0, Number(value) || 0)), 0);
    return b;
  }


  _ensureStunFile(runtime) {
    try {
      const file = path.join(runtime.root, 'stun.txt');
      if (!fs.existsSync(file)) fs.writeFileSync(file, '43.158.113.38:20002\n', { mode: 0o600 });
      return file;
    } catch (err) {
      this.device.log(`[video-xp2p] STUN fallback file unavailable: ${err.message}`);
      return '';
    }
  }

  _encodeRequest(runtime, inputs) {
    // v37 keeps the native service identity and the delegate/channel identity
    // independent. Dreame's reference flow uses productId/deviceName for
    // startService + setDeviceXp2pInfo and channelId/deviceId for status/FLV.
    const serviceId = inputs.serviceId || (inputs.productId && inputs.deviceName ? `${inputs.productId}/${inputs.deviceName}` : null);
    const delegateId = inputs.delegateId || inputs.channelId || serviceId;
    const channel = String(inputs.streamChannel ?? 0);
    const fields = [
      runtime.library,
      this._ensureStunFile(runtime), // pinned Tencent fallback STUN endpoint
      serviceId,
      delegateId,
      inputs.productId,
      inputs.deviceName,
      inputs.p2pInfo,
      inputs.secretId || '',
      inputs.secretKey || '',
      `ipc.flv?action=live&channel=${channel}&quality=high&_crypto=on`,
      `action=inner_define&channel=${channel}&cmd=get_device_st&type=live&quality=standard`,
      'action=live',
      '',
      '',
      '20002',
      '2',
      '0',
      'cloud',
      '',
      '',
    ].map((v) => Buffer.from(String(v ?? ''), 'utf8'));

    if (fields.length !== FIELD_COUNT) throw new Error('XP2P request field count mismatch');
    const parts = [REQUEST_MAGIC, this._u32(FIELD_COUNT)];
    for (const field of fields) parts.push(this._u32(field.length), field);
    const haParity = true; // proven reference: eight status/delegate attempts
    const statusAttempts = haParity ? HA_PARITY_STATUS_ATTEMPTS : DIAGNOSTIC_STATUS_ATTEMPTS;
    const retryMs = haParity ? HA_PARITY_RETRY_MS : DIAGNOSTIC_RETRY_MS;
    const delegateAttempts = haParity ? HA_PARITY_DELEGATE_ATTEMPTS : DIAGNOSTIC_DELEGATE_ATTEMPTS;
    parts.push(
      this._u64(COMMAND_TIMEOUT_US),
      this._u32(statusAttempts), this._u32(retryMs),
      this._u32(delegateAttempts), this._u32(retryMs),
    );
    return Buffer.concat(parts);
  }

  _validateInputs(inputs) {
    const missing = [];
    for (const [key, label] of [
      ['productId', 'productId'],
      ['deviceName', 'deviceName'],
      ['p2pInfo', 'p2pInfo'],
    ]) if (!inputs?.[key]) missing.push(label);
    if (!(inputs?.serviceId || (inputs?.productId && inputs?.deviceName))) missing.push('serviceId');
    if (!(inputs?.delegateId || inputs?.channelId || inputs?.serviceId || (inputs?.productId && inputs?.deviceName))) missing.push('delegateId');
    if (missing.length) throw new Error(`XP2P Provisioning unvollständig: ${missing.join(', ')}`);
  }

  async start(inputs, { signal } = {}) {
    await this.stop();
    this._validateInputs(inputs);
    // A coarse runtime detection only proves that the worker, linker and
    // Tencent library exist.  It must not bypass manifest/hash validation:
    // runtime updates can add or rename dependencies (for example
    // libc++.so -> libstdc++.so) while the old three probe files remain.
    // Always validate the managed /userdata runtime before spawning it;
    // ensureInstalled() is cheap when every expected hash already matches.
    try {
      await this._bootstrap.ensureInstalled();
    } catch (err) {
      this.device.log(`[video-xp2p] runtime bootstrap failed: ${err.message}`);
      throw new Error(`XP2P runtime bootstrap failed: ${err.message}`);
    }
    if (signal?.aborted) { const error = new Error('Kamerastart abgebrochen'); error.code = 'CAMERA_ABORTED'; throw error; }
    const runtime = this.detectRuntime();
    if (!runtime) throw new Error('XP2P runtime installation completed but runtime was not detected');
    this.device.log(`[video-xp2p] verified native runtime detected root=${runtime.root}`);
    if (process.platform !== 'linux' || process.arch !== 'arm64') {
      throw new Error(`XP2P-Laufzeit erwartet Homey Linux/arm64, erkannt: ${process.platform}/${process.arch}`);
    }

    const env = { ...process.env, LD_LIBRARY_PATH: runtime.libDirs.join(':'), LD_PRELOAD: ['libnodelab_dnsfix.so','libnodelab_xnettrace.so'].map(n => path.join(runtime.root,'lib',n)).join(':'), NODELAB_DNSFIX: 'tencent-stun-only', NODELAB_XNETTRACE: '1' };
    this.device.log(`[video-xp2p] spawning Bionic worker linker=${runtime.linker} worker=${runtime.worker} libdirs=${runtime.libDirs.join(':')}`);
    const startedAt = Date.now();
    const proc = spawn(runtime.linker, [runtime.worker], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this._process = proc;
    const abort = () => { try { proc.stdin.end(); proc.kill('SIGTERM'); } catch (_) {} };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    let stderr = '';
    let workerStage = 'spawned';
    let sawEmptySuccessfulStatusResponse = false;
    let statusCommandTimer = null;
    let startupReject = null;
    const haParity = true; // proven reference: eight status/delegate attempts
    const statusAttempts = haParity ? HA_PARITY_STATUS_ATTEMPTS : DIAGNOSTIC_STATUS_ATTEMPTS;
    const retryMs = haParity ? HA_PARITY_RETRY_MS : DIAGNOSTIC_RETRY_MS;
    const delegateAttempts = haParity ? HA_PARITY_DELEGATE_ATTEMPTS : DIAGNOSTIC_DELEGATE_ATTEMPTS;
    const statusWatchdogMs = haParity ? HA_PARITY_WATCHDOG_MS : DIAGNOSTIC_WATCHDOG_MS;
    const profileName = haParity ? 'ha_parity' : 'diagnostic';
    const clearStatusCommandWatchdog = () => {
      if (statusCommandTimer) clearTimeout(statusCommandTimer);
      statusCommandTimer = null;
    };
    const armStatusCommandWatchdog = () => {
      clearStatusCommandWatchdog();
      workerStage = 'status_command_call';
      this.device.log(`[video-xp2p] stage=status_command_call profile=${profileName} commandTimeoutMs=${Math.floor(COMMAND_TIMEOUT_US / 1000)} attempts=${statusAttempts} retryMs=${retryMs} delegateAttempts=${delegateAttempts} watchdogMs=${statusWatchdogMs}`);
      statusCommandTimer = setTimeout(() => {
        workerStage = 'status_command_timeout';
        this.device.log(`[video-xp2p] stage=status_command_timeout profile=${profileName} attempts=${statusAttempts} watchdogMs=${statusWatchdogMs}`);
        const failure = makeFailure('XP2P Statuskommando hat das Zeitlimit überschritten', null, workerStage);
        if (startupReject) startupReject(failure);
        // A blocked native postCommandRequestSync cannot be interrupted from JS.
        // Terminate only this candidate worker so the identity matrix can
        // continue with the next delegate/service combination immediately.
        try { proc.kill('SIGKILL'); } catch (_) {}
      }, statusWatchdogMs);
    };
    const observeStage = (text) => {
      if (text.includes('runtime loaded')) workerStage = 'runtime_loaded';
      if (text.includes('symbols resolved')) workerStage = 'symbols_resolved';
      if (text.includes('optional configuration applied')) workerStage = 'optional_config_applied';
      if (text.includes('service started')) workerStage = 'service_started';
      if (text.includes('device configuration applied')) workerStage = 'device_configured';
      if (text.includes('ready event received')) armStatusCommandWatchdog();
      if (/status attempt=.*native=0 length=0 parsed=0/.test(text)) sawEmptySuccessfulStatusResponse = true;
      if (text.includes('device ready')) { clearStatusCommandWatchdog(); workerStage = 'status_ready'; }
      if (text.includes('FLV delegate ready')) {
        clearStatusCommandWatchdog();
        workerStage = 'delegate_ready';
        if (sawEmptySuccessfulStatusResponse) this.device.log('[video-xp2p] stage=empty_status_delegate_fallback result=delegate_ready');
      }
      if (text.includes('detect error event received')) { clearStatusCommandWatchdog(); workerStage = 'detect_error'; }
    };
    const makeFailure = (message, nativeCode = null, stage = workerStage) => {
      const failure = new Error(message);
      failure.nativeCode = nativeCode;
      failure.workerStage = stage;
      failure.durationMs = Date.now() - startedAt;
      return failure;
    };
    // Child stdio errors (especially EPIPE when the Android linker exits
    // immediately) are asynchronous EventEmitter errors. A try/catch around
    // write() cannot catch them; without listeners Node terminates the whole
    // Homey app process.
    const stdioFailure = (label, err) => {
      const failure = makeFailure(`XP2P ${label}: ${err?.code || err?.message || 'unbekannter Streamfehler'}`, null, workerStage);
      if (startupReject) startupReject(failure);
      else this.device.log(`[video-xp2p] ${failure.message}`);
    };
    proc.stdin.on('error', (err) => stdioFailure('stdin', err));
    proc.stdout.on('error', (err) => stdioFailure('stdout', err));
    proc.stderr.on('error', (err) => stdioFailure('stderr', err));
    proc.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
      const line = chunk.toString('utf8').trim();
      if (line) {
        observeStage(line);
        // Vendor/transport output may include credentials; do not forward it.
      }
    });

    const result = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const startupTimeoutMs = haParity ? 80_000 : 20_000;
      let timer = setTimeout(() => fail(makeFailure('XP2P-Start hat das Zeitlimit überschritten', null, workerStage)), startupTimeoutMs);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        clearStatusCommandWatchdog();
        reject(err);
      };
      startupReject = fail;
      proc.once('error', fail);
      proc.once('exit', (code, signal) => {
        if (timer) fail(makeFailure(`XP2P-Prozess wurde beendet (${code ?? signal ?? 'unbekannt'})`, Number.isInteger(code) ? code : null, workerStage));
      });
      proc.stdout.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 12) return;
        if (!buf.subarray(0, 4).equals(RESPONSE_MAGIC)) return fail(makeFailure('Ungültige XP2P-Worker-Antwort', null, 'response_decode'));
        const status = buf.readUInt32BE(4);
        const len = buf.readUInt32BE(8);
        if (len > MAX_RESPONSE) return fail(makeFailure('XP2P-Worker-Antwort zu groß', null, 'response_decode'));
        if (buf.length < 12 + len) return;
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        clearStatusCommandWatchdog();
        const payload = buf.subarray(12, 12 + len).toString('utf8');
        if (status !== 0) {
          if (status === 13) this.device.log('[video-xp2p] stage=status_command_result nativeResult=nonzero response=none delegateCalled=false');
          let statusDiag = null;
          if (status === 14) {
            const match = payload.match(/finalStatus=(-?\d+)\s+responseLength=(\d+)\s+parsed=([01])/i);
            statusDiag = match ? {
              finalDeviceStatus: Number(match[1]),
              responseLength: Number(match[2]),
              responseParsed: match[3] === '1',
            } : null;
            this.device.log(`[video-xp2p] stage=status_command_result nativeResult=0 attempts=${statusAttempts} responseLength=${statusDiag ? statusDiag.responseLength : 'unknown'} parsed=${statusDiag ? statusDiag.responseParsed : 'unknown'} finalStatus=${statusDiag ? statusDiag.finalDeviceStatus : 'unknown'} delegateCalled=false workerProtocol=v2`);
          }
          if (status === 16) this.device.log('[video-xp2p] stage=status_command_result nativeResult=0 statusAccepted=true delegateCalled=true delegateResult=empty');
          const stageByCode = {
            10: 'qcloud_configuration', 11: 'start_service', 12: 'set_device_xp2p_info',
            13: 'status_command_native', 14: 'status_command_response', 15: 'av_receive',
            16: 'delegate_http_flv', 17: 'ready_event_wait',
          };
          const failure = makeFailure(`XP2P-Worker Fehler ${status}: ${payload || 'ohne Details'}`, status, stageByCode[status] || workerStage);
          if (statusDiag) {
            failure.statusAttempts = statusAttempts;
            failure.finalDeviceStatus = statusDiag.finalDeviceStatus;
            failure.responseLength = statusDiag.responseLength;
            failure.responseParsed = statusDiag.responseParsed;
            failure.workerProtocol = 'v2';
          }
          return reject(failure);
        }
        this.device.log('[video-xp2p] stage=status_command_result nativeResult=0 statusAccepted=true delegateCalled=true delegateResult=ready');
        if (!payload.startsWith('C\n')) return reject(makeFailure('XP2P-Status nicht bestätigt',14,'status_command_response'));
        try { resolve(require('./LocalDelegate').localDelegateUrl(payload).toString()); } catch (_) { reject(makeFailure('Ungültiger lokaler Kamerastream',16,'delegate_http_flv')); }
      });
      try {
        const request = this._encodeRequest(runtime, inputs);
        proc.stdin.write(request, (err) => { if (err) fail(makeFailure(`XP2P stdin write: ${err.code || err.message}`, null, 'request_write')); });
      } catch (err) {
        fail(err);
      }
    }).finally(() => {
      startupReject = null;
      signal?.removeEventListener('abort', abort);
    });

    const routeCode = 0;
    const streamUrl = result;
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(streamUrl)) {
      await this.stop();
      throw new Error('XP2P-Worker lieferte keine lokale FLV-Adresse');
    }
    this._streamUrl = streamUrl;
    this.device.log(`[video-xp2p] local FLV delegate ready; routeCode=${Number.isFinite(routeCode) ? routeCode : 0} stage=delegate_ready durationMs=${Date.now() - startedAt}`);
    return streamUrl;
  }

  async stop() {
    if (this._stopPromise) return this._stopPromise;
    const proc = this._process; this._streamUrl = null;
    if (!proc) return;
    this._stopPromise = new Promise((resolve, reject) => {
      if (proc.exitCode != null || proc.signalCode != null) return resolve();
      let force, deadline;
      const done = () => { clearTimeout(force); clearTimeout(deadline); resolve(); };
      proc.once('exit', done);
      try { proc.stdin.end(); } catch (_) {}
      force = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 2500);
      deadline = setTimeout(() => { proc.off('exit', done); const error = new Error('Kamera-Prozessende nicht bestätigt'); error.code = 'CAMERA_STOP_FAILED'; reject(error); }, 5000);
    });
    try { await this._stopPromise; if (this._process === proc) this._process = null; }
    finally { this._stopPromise = null; }
  }
}

module.exports = DreameXp2pRunner;
