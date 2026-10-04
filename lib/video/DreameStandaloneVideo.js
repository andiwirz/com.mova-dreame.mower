'use strict';

const http = require('http');
const { HomeyCamera } = require('./HomeyCamera');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const DreameXp2pRunner = require('./DreameXp2pRunner');

class DreameStandaloneVideo {
  constructor(device) {
    this.device = device;
    this.homey = device.homey;
    this.api = device._api;
    this.did = String(device.getData().id);
    this.video = null;
    this._lastProbeAt = 0;
    this._lastProbeOk = false;
    this._lastAutoLookupAt = 0;
    this._cachedDeviceMetadata = null;
    this._portDiscoveryPromise = null;
    this._xp2pDiagAt = 0;
    this._autoChannel = null;
    this._xp2pRunner = new DreameXp2pRunner(device);
    this.local = new HomeyCamera(device, this);
    this._videoUrlPromise = null;
    this._lastXp2pDiagnosticCode = null;
    this._flvRelayServer = null;
    this._flvRelayUrl = null;
    this._flvRelayUpstream = null;
    this._flvRelayPreferredVariant = null;
  }


  _ipv4ToInt(value) {
    const parts = String(value || '').split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  }

  _sameIpv4Subnet(a, b, netmask) {
    const ai = this._ipv4ToInt(a);
    const bi = this._ipv4ToInt(b);
    const mi = this._ipv4ToInt(netmask);
    if (ai == null || bi == null || mi == null) return false;
    return ((ai & mi) >>> 0) === ((bi & mi) >>> 0);
  }

  _selectRelayHost(targetHost = null) {
    const candidates = [];
    for (const entries of Object.values(os.networkInterfaces() || {})) {
      for (const entry of entries || []) {
        if (!entry || entry.internal || !['IPv4', 4].includes(entry.family) || !this._isPrivateIpv4(entry.address)) continue;
        candidates.push(entry);
      }
    }
    if (!candidates.length) return null;
    if (targetHost && this._isPrivateIpv4(targetHost)) {
      const match = candidates.find((entry) => this._sameIpv4Subnet(entry.address, targetHost, entry.netmask));
      if (match) return match.address;
    }
    const preferred = candidates.find((entry) => !/^172\.(?:1[6-9]|2\d|3[01])\./.test(entry.address)) || candidates[0];
    return preferred.address;
  }

  async _stopFlvRelay(reason = 'stop') {
    const upstream = this._flvRelayUpstream;
    this._flvRelayUpstream = null;
    if (upstream) {
      try { upstream.destroy(); } catch (_) {}
    }
    const server = this._flvRelayServer;
    this._flvRelayServer = null;
    this._flvRelayUrl = null;
    if (!server) return;
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
        setTimeout(resolve, 1000).unref?.();
      } catch (_) { resolve(); }
    });
    this.device.log(`[video-xp2p] FLV relay stopped reason=${reason}`);
  }

  _buildA2FlvUpstreamCandidates(upstream) {
    const candidates = [];
    const seen = new Set();
    const add = (label, mutate) => {
      const url = new URL(upstream.toString());
      mutate(url.searchParams);
      const path = `${url.pathname}${url.search}`;
      if (seen.has(path)) return;
      seen.add(path);
      candidates.push({ label, path });
    };

    // The working MOVA iOS capture establishes the media flow only after the
    // live pull request. Tencent documents requester as the app role and the
    // A2 status preflight uses standard quality, so try those exact semantics
    // before the legacy HA-compatible path. No token/session material is added.
    add('a2_ios_standard', (q) => {
      q.set('action', 'live');
      q.set('channel', '0');
      q.set('quality', 'standard');
      q.set('_crypto', 'on');
      q.set('requester', 'app-ios');
    });
    add('a2_ios_high', (q) => {
      q.set('action', 'live');
      q.set('channel', '0');
      q.set('quality', 'high');
      q.set('_crypto', 'on');
      q.set('requester', 'app-ios');
    });
    add('legacy', () => {});
    add('a2_standard', (q) => {
      q.set('action', 'live');
      q.set('channel', '0');
      q.set('quality', 'standard');
      q.set('_crypto', 'on');
      q.delete('requester');
    });
    add('a2_android_standard', (q) => {
      q.set('action', 'live');
      q.set('channel', '0');
      q.set('quality', 'standard');
      q.set('_crypto', 'on');
      q.set('requester', 'app-android');
    });
    add('a2_android_high', (q) => {
      q.set('action', 'live');
      q.set('channel', '0');
      q.set('quality', 'high');
      q.set('_crypto', 'on');
      q.set('requester', 'app-android');
    });
    return candidates;
  }

  async _startFlvRelay(upstreamUrl) {
    await this._stopFlvRelay('replace').catch(() => {});
    const upstream = new URL(upstreamUrl);
    if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1') {
      throw new Error('XP2P relay requires a loopback HTTP upstream');
    }

    const mowerHost = await this._resolveHost().catch(() => null);
    const relayHost = this._selectRelayHost(mowerHost);
    if (!relayHost) throw new Error('Keine Homey-LAN-Adresse für XP2P-FLV-Relay gefunden');
    const relayToken = crypto.randomBytes(18).toString('hex');
    const relayPath = `/dreame-xp2p/${relayToken}.flv`;
    const upstreamCandidates = this._buildA2FlvUpstreamCandidates(upstream);
    this._flvRelayPreferredVariant = null;

    const server = http.createServer((req, res) => {
      if (req.method !== 'GET' || String(req.url || '').split('?')[0] !== relayPath) {
        res.writeHead(404, { Connection: 'close' });
        res.end();
        return;
      }

      this.device.log('[video-xp2p] FLV relay client connected; opening loopback delegate');
      let activeReq = null;
      let clientClosed = false;
      const ordered = (() => {
        if (!this._flvRelayPreferredVariant) return upstreamCandidates;
        const preferred = upstreamCandidates.find((item) => item.label === this._flvRelayPreferredVariant);
        return preferred ? [preferred, ...upstreamCandidates.filter((item) => item !== preferred)] : upstreamCandidates;
      })();

      const tryCandidate = (index) => {
        if (clientClosed || res.writableEnded) return;
        if (index >= ordered.length) {
          this.device.log(`[video-xp2p] FLV relay all upstream variants rejected count=${ordered.length}`);
          if (!res.headersSent) res.writeHead(502, { Connection: 'close' });
          if (!res.writableEnded) res.end();
          return;
        }
        const candidate = ordered[index];
        this.device.log(`[video-xp2p] FLV relay upstream attempt variant=${candidate.label}`);
        const upstreamReq = http.get({
          hostname: upstream.hostname,
          port: upstream.port,
          path: candidate.path,
          headers: {
            Accept: '*/*',
            Connection: 'close',
          },
        }, (upstreamRes) => {
          let sawFirstChunk = false;
          const statusCode = upstreamRes.statusCode || 502;
          if (statusCode < 200 || statusCode >= 300) {
            this.device.log(`[video-xp2p] FLV relay upstream variant=${candidate.label} HTTP ${statusCode}`);
            upstreamRes.resume();
            upstreamRes.once('end', () => tryCandidate(index + 1));
            upstreamRes.once('error', () => tryCandidate(index + 1));
            return;
          }
          this._flvRelayPreferredVariant = candidate.label;
          this.device.log(`[video-xp2p] FLV relay upstream accepted variant=${candidate.label} HTTP ${statusCode}`);
          res.writeHead(200, {
            'Content-Type': 'video/x-flv',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Pragma: 'no-cache',
            Connection: 'close',
            'Access-Control-Allow-Origin': '*',
          });
          upstreamRes.on('data', (chunk) => {
            if (!sawFirstChunk) {
              sawFirstChunk = true;
              const isFlv = chunk.length >= 3 && chunk[0] === 0x46 && chunk[1] === 0x4c && chunk[2] === 0x56;
              this.device.log(`[video-xp2p] FLV relay first upstream chunk variant=${candidate.label} bytes=${chunk.length} flvHeader=${isFlv}`);
            }
          });
          upstreamRes.once('end', () => this.device.log(`[video-xp2p] FLV relay upstream ended variant=${candidate.label}`));
          upstreamRes.once('error', (err) => this.device.log(`[video-xp2p] FLV relay upstream error variant=${candidate.label} error=${String(err?.message || err).slice(0, 180)}`));
          upstreamRes.pipe(res);
        });
        activeReq = upstreamReq;
        this._flvRelayUpstream = upstreamReq;
        upstreamReq.setTimeout(15000, () => upstreamReq.destroy(new Error('FLV relay upstream timeout')));
        upstreamReq.once('error', (err) => {
          if (clientClosed || res.writableEnded) return;
          this.device.log(`[video-xp2p] FLV relay upstream variant=${candidate.label} connectError=${String(err?.message || err).slice(0, 180)}`);
          tryCandidate(index + 1);
        });
      };

      tryCandidate(0);
      res.once('close', () => {
        clientClosed = true;
        if (this._flvRelayUpstream === activeReq) this._flvRelayUpstream = null;
        try { activeReq?.destroy(); } catch (_) {}
        this.device.log('[video-xp2p] FLV relay client disconnected');
      });
    });

    server.on('error', (err) => this.device.log(`[video-xp2p] FLV relay server error=${String(err?.message || err).slice(0, 180)}`));
    await new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '0.0.0.0');
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      try { server.close(); } catch (_) {}
      throw new Error('XP2P FLV relay could not allocate a TCP port');
    }
    this._flvRelayServer = server;
    this._flvRelayUrl = `http://${relayHost}:${address.port}${relayPath}`;
    this.device.log(`[video-xp2p] FLV relay ready host=${relayHost} port=${address.port}; upstream=loopback variants=${upstreamCandidates.length}`);
    return this._flvRelayUrl;
  }

  _safeFingerprint(value) {
    const text = value == null ? '' : String(value);
    if (!text) return 'none';
    return `${crypto.createHash('sha256').update(text).digest('hex').slice(0, 10)}:${text.length}`;
  }

  _diagnosticCodeForError(err) {
    if (err?.workerStage === 'status_command_timeout') return 'CHANNEL_COMMAND_TIMEOUT';
    const nativeCode = Number(err?.nativeCode);
    if (nativeCode === 11) return 'SERVICE_START_FAILED';
    if (nativeCode === 12) return 'P2P_INFO_REJECTED';
    if (nativeCode === 13) return 'CHANNEL_COMMAND_FAILED';
    if (nativeCode === 14) return 'CHANNEL_ID_UNRESOLVED';
    if (nativeCode === 16) return 'FLV_DELEGATE_FAILED';
    if (nativeCode === 17) return 'XP2P_READY_TIMEOUT';
    if (String(err?.message || '').includes('Zeitlimit')) return 'XP2P_STAGE_TIMEOUT';
    return 'XP2P_START_FAILED';
  }

  _friendlyXp2pError(code) {
    const lang = String(this.homey?.i18n?.getLanguage?.() || 'en').toLowerCase();
    if (lang.startsWith('de')) {
      return `XP2P-Gerätekanal konnte nicht aufgebaut werden. Diagnosecode: ${code}.`;
    }
    return `The XP2P device channel could not be established. Diagnostic code: ${code}.`;
  }

  enabled() {
    return this.device.getSetting('video_enabled') === true;
  }

  _storeGet(key) {
    try {
      return this.device.getStoreValue(key);
    } catch (_) {
      return null;
    }
  }

  async _storeSet(key, value) {
    try {
      await Promise.resolve(this.device.setStoreValue(key, value));
    } catch (_) {}
  }

  _isPrivateIpv4(value) {
    const m = String(value || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const octets = m.slice(1).map(Number);
    if (octets.some((n) => n < 0 || n > 255)) return false;
    const [a, b] = octets;
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }

  _findPrivateIpv4(value, depth = 0) {
    if (depth > 6 || value == null) return null;
    if (typeof value === 'string') {
      const candidates = value.match(/(?:\d{1,3}\.){3}\d{1,3}/g) || [];
      return candidates.find((ip) => this._isPrivateIpv4(ip)) || null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this._findPrivateIpv4(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value);
      entries.sort(([ka], [kb]) => {
        const score = (k) => /(?:^|_)(?:lan|local|ip|address|host)(?:_|$)/i.test(k) ? 0 : 1;
        return score(ka) - score(kb);
      });
      for (const [key, item] of entries) {
        if (/binddomain|domain|mqtt|cloud/i.test(key)) continue;
        const found = this._findPrivateIpv4(item, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  _extractVideoPortFromUrl(value) {
    if (typeof value !== 'string' || !/^(?:https?|rtsp|rtmp):\/\//i.test(value.trim())) return null;
    try {
      const parsed = new URL(value.trim());
      const p = Number(parsed.port || 0);
      return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
    } catch (_) {
      return null;
    }
  }

  _findVideoPort(value, keyHint = '', depth = 0) {
    if (depth > 7 || value == null) return null;

    const keyLooksVideo = /video|camera|ipc|stream|flv|p2p/i.test(String(keyHint));
    const keyLooksPort = /port/i.test(String(keyHint));

    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) {
      const port = Number(value);
      if (keyLooksVideo && keyLooksPort && Number.isInteger(port) && port > 0 && port <= 65535) return port;
      return null;
    }

    if (typeof value === 'string') {
      if (keyLooksVideo) {
        const urlPort = this._extractVideoPortFromUrl(value);
        if (urlPort) return urlPort;
      }
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this._findVideoPort(item, keyHint, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (/binddomain|mqtt|cloud/i.test(key)) continue;
        const combinedHint = keyLooksVideo ? `${keyHint}.${key}` : key;
        const found = this._findVideoPort(item, combinedHint, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  async _getOwnDeviceMetadata() {
    if (this._cachedDeviceMetadata) return this._cachedDeviceMetadata;
    const now = Date.now();
    if (now - this._lastAutoLookupAt < 30000) return null;
    this._lastAutoLookupAt = now;

    if (!this.api || typeof this.api.getDevices !== 'function') return null;
    try {
      const devices = await this.api.getDevices();
      const own = (devices || []).find((d) => String(d?.did) === this.did) || null;
      if (own) this._cachedDeviceMetadata = own;
      return own;
    } catch (err) {
      this.device.log(`[video] automatic device metadata lookup unavailable: ${err.message}`);
      return null;
    }
  }

  async _resolveHost() {
    const manual = String(this.device.getSetting('video_lan_host') || '').trim();
    if (manual) return manual;

    const stored = String(this._storeGet('video_auto_lan_host') || '').trim();
    if (this._isPrivateIpv4(stored)) return stored;

    const own = await this._getOwnDeviceMetadata();
    const found = this._findPrivateIpv4(own);
    if (found) {
      await this._storeSet('video_auto_lan_host', found);
      this.device.log(`[video] automatically resolved mower LAN address ${found}`);
      return found;
    }
    return null;
  }

  async _resolvePort(host = null) {
    const manual = Number(this.device.getSetting('video_lan_port') || 0);
    if (Number.isInteger(manual) && manual > 0 && manual <= 65535) return manual;

    const stored = Number(this._storeGet('video_auto_lan_port') || 0);
    if (Number.isInteger(stored) && stored > 0 && stored <= 65535) return stored;

    const own = await this._getOwnDeviceMetadata();
    const found = this._findVideoPort(own);
    if (found) {
      await this._storeSet('video_auto_lan_port', found);
      this.device.log(`[video] automatically resolved mower video port ${found} from device metadata`);
      return found;
    }

    const resolvedHost = host || await this._resolveHost();
    if (!resolvedHost) return null;
    return this._discoverVideoPort(resolvedHost);
  }

  _safeShape(value, depth = 0) {
    if (depth > 5 || value == null) return value == null ? null : typeof value;
    if (Array.isArray(value)) return { type: 'array', length: value.length, sample: value.slice(0, 3).map((v) => this._safeShape(v, depth + 1)) };
    if (typeof value !== 'object') return typeof value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      // Never log credentials or opaque session material. Key names and value
      // types are enough to identify the provisioning path during diagnostics.
      if (/token|secret|password|passwd|auth|sign|credential|cookie|session|key/i.test(key)) {
        out[key] = '<redacted>';
      } else {
        out[key] = this._safeShape(item, depth + 1);
      }
    }
    return out;
  }

  async _logXp2pDiagnostics(enableResponse = null) {
    const now = Date.now();
    if (now - this._xp2pDiagAt < 30000) return;
    this._xp2pDiagAt = now;
    try {
      if (enableResponse != null) {
        this.device.log(`[video-xp2p] camera-enable response shape=${JSON.stringify(this._safeShape(enableResponse)).slice(0, 1200)}`);
      }
      const own = await this._getOwnDeviceMetadata();
      if (own) {
        const interesting = {};
        const walk = (obj, path = '', depth = 0) => {
          if (!obj || depth > 6) return;
          if (Array.isArray(obj)) { obj.slice(0, 12).forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1)); return; }
          if (typeof obj !== 'object') return;
          for (const [k, v] of Object.entries(obj)) {
            const next = path ? `${path}.${k}` : k;
            if (/video|camera|ipc|stream|p2p|xp2p|tencent|rtc|peer|lan|local|ip|port/i.test(k)) {
              if (/token|secret|password|passwd|auth|sign|credential|cookie|session|key/i.test(k)) interesting[next] = '<redacted>';
              else if (v == null || ['string','number','boolean'].includes(typeof v)) {
                // Keys are enough: no cloud IPs, URLs, user IDs or opaque
                // values should be copied to Homey logs.
                interesting[next] = `<${typeof v}>`;
              } else interesting[next] = this._safeShape(v, depth + 1);
            }
            walk(v, next, depth + 1);
          }
        };
        walk(own);
        this.device.log(`[video-xp2p] device metadata video/p2p paths=${JSON.stringify(interesting).slice(0, 1800)}`);
      } else {
        this.device.log('[video-xp2p] no device metadata available for provisioning diagnosis');
      }
    } catch (err) {
      this.device.log('[video-xp2p] metadata diagnostic failed (details redacted)');
    }
  }

  async _tcpOpen(host, port, timeoutMs = 450) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  }

  async _discoverVideoPort(host) {
    if (this._portDiscoveryPromise) return this._portDiscoveryPromise;

    // Legacy HTTP-FLV fallback only. Current A2 research indicates normal video
    // uses Tencent XP2P, so this stays deliberately bounded and fast. First find
    // listening TCP candidates, then verify actual FLV and channel automatically.
    const candidates = [
      80, 81, 443, 554, 8000, 8001, 8080, 8081, 8090, 8181,
      1935, 8554, 8800, 8888, 8899, 9000, 9001, 9080, 9527, 9876, 10000, 10001,
      18080, 20000, 30000, 37777, 50000, 55555,
    ];
    const channels = [0, 1, 2, 3, 4];
    const configuredTimeout = Math.max(1000, Number(this.device.getSetting('video_probe_timeout_ms') || 5000));
    const discoveryTimeout = Math.min(1200, configuredTimeout);

    this._portDiscoveryPromise = (async () => {
      this.device.log(`[video] legacy FLV fallback: checking ${candidates.length} TCP candidates on ${host}; channel is automatic`);
      const checks = await Promise.all(candidates.map(async (port) => [port, await this._tcpOpen(host, port)]));
      const openPorts = checks.filter(([, ok]) => ok).map(([port]) => port);
      this.device.log(`[video] legacy FLV TCP listeners on ${host}: ${openPorts.length ? openPorts.join(',') : 'none'}`);
      for (const port of openPorts) {
        for (const channel of channels) {
          const url = `http://${host}:${port}/ipc.flv?action=live&_protocol=tcp&quality=high&_crypto=off&channel=${channel}`;
          try {
            await this._probeFlv(url, { timeoutMs: discoveryTimeout, bypassCache: true });
            await this._storeSet('video_auto_lan_port', port);
            await this._storeSet('video_auto_channel', channel);
            this._autoChannel = channel;
            this.device.log(`[video] auto-discovered verified legacy FLV endpoint ${host}:${port} channel=${channel}`);
            return port;
          } catch (_) {}
        }
      }
      this.device.log(`[video] no verified legacy FLV endpoint on ${host}; A2 likely requires XP2P provisioning`);
      return null;
    })();

    try { return await this._portDiscoveryPromise; }
    finally { this._portDiscoveryPromise = null; }
  }

  async _resolveChannel(host, port) {
    if (Number.isInteger(this._autoChannel) && this._autoChannel >= 0) return this._autoChannel;
    const stored = Number(this._storeGet('video_auto_channel'));
    if (Number.isInteger(stored) && stored >= 0 && stored <= 8) { this._autoChannel = stored; return stored; }
    if (!host || !port) return 0;
    for (const channel of [0,1,2,3,4]) {
      const url = `http://${host}:${port}/ipc.flv?action=live&_protocol=tcp&quality=high&_crypto=off&channel=${channel}`;
      try {
        await this._probeFlv(url, { timeoutMs: 1200, bypassCache: true });
        this._autoChannel = channel;
        await this._storeSet('video_auto_channel', channel);
        this.device.log(`[video] automatically resolved legacy FLV channel ${channel}`);
        return channel;
      } catch (_) {}
    }
    return 0;
  }

  async _endpoint() {
    const host = await this._resolveHost();
    const port = host ? await this._resolvePort(host) : await this._resolvePort();
    if (!host || !port) return null;
    const channel = await this._resolveChannel(host, port);
    return `http://${host}:${port}/ipc.flv?action=live&_protocol=tcp&quality=high&_crypto=off&channel=${channel}`;
  }

  async init() {
    if (!this.homey?.videos?.createVideoOther || typeof this.device.setCameraVideo !== 'function') {
      this.device.log('[video] Homey video API unavailable; requires Homey >= 12.7.0');
      return;
    }

    try {
      this.video = await this.homey.videos.createVideoOther();
      this.video.registerVideoUrlListener(async () => { this.device.log('[video-native] Homey video URL listener invoked'); try { const value = await this.getVideoUrl(); this.device.log('[video-native] Homey video URL listener ready'); return value; } catch (err) { this.device.error('[video-native] Homey video URL listener failed:', err?.message || String(err)); throw err; } });
      await this.device.setCameraVideo('mower_live', 'Live Video', this.video);
      this.device.log('[video] camera registered');
    } catch (err) {
      this.device.error('[video] registration failed:', err.message);
    }
  }

  async getVideoUrl() { return this.local.nativeUrl(); }

  async openNative(signal) {
    const check = () => { if (signal?.aborted) { const e = new Error('Kamerastart abgebrochen'); e.code = 'CAMERA_ABORTED'; throw e; } };
    check();
    if (!this.enabled()) throw new Error('Live Video ist deaktiviert');
    if (!this.local.outsideEvidence()) throw new Error('Frischer Stationsaustrittsnachweis fehlt');
    // Runtime installation is internal to the app and happens only on demand.
    await this._xp2pRunner._bootstrap.ensureInstalled(); check();
    // Release path: obtain the complete TX video identity from the already
    // authenticated Dreame/MOVA cloud session. No NodeLab, PC bridge or manual
    // identity import participates in camera startup.
    const inputs = await this.api.getTxVideoRuntimeInputs(this.did); check();
    const candidate = inputs.cloudIdentityReady
      ? inputs.identityCandidates?.find(c => c.delegateIdSource === 'cloud_identity_channel')
        || inputs.identityCandidates?.[0]
      : null;
    if (!candidate) throw new Error('Dreame/MOVA hat keine vollständige native Kameraidentität geliefert. Bitte Homey-App-Log ab [video-xp2p] prüfen.');
    if (!this.local.outsideEvidence()) throw new Error('Stationsaustrittsnachweis inzwischen veraltet');
    try {
      await this._ensureCameraEnabled(); check();
      return await this._xp2pRunner.start({ ...inputs, ...candidate }, { signal });
    }
    catch (error) { await this.stopNative(); throw error; }
  }

  async stopNative() {
    await this._xp2pRunner.stop();
    await this._disableCameraBestEffort('homey-local-stop');
  }

  async _ensureCameraEnabled() {
    if (!this.api || typeof this.api.setVideoEnabled !== 'function') return null;
    return this.api.setVideoEnabled(this.did, true);
  }

  async _disableCameraBestEffort(reason) {
    if (!this.api || typeof this.api.setVideoEnabled !== 'function') return;
    try {
      await this.api.setVideoEnabled(this.did, false);
      this.device.log(`[video-xp2p] camera disabled reason=${reason}`);
    } catch (err) {
      this.device.log(`[video-xp2p] cleanup warning stage=camera-disable reason=${reason} message=${String(err?.message || err).slice(0, 160)}`);
    }
  }

  async stop() {
    await this.local.stop();
    await this._stopFlvRelay('camera-stop');
  }

  async _probeFlv(url, { timeoutMs = null, bypassCache = false } = {}) {
    const now = Date.now();
    if (!bypassCache && this._lastProbeOk && now - this._lastProbeAt < 15000) return true;
    const parsed = new URL(url);
    const effectiveTimeoutMs = Math.max(250, Number(timeoutMs || this.device.getSetting('video_probe_timeout_ms') || 5000));

    await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        timeout: effectiveTimeoutMs,
        headers: { Range: 'bytes=0-16', Connection: 'close' },
      }, (res) => {
        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          res.destroy();
          err ? reject(err) : resolve();
        };
        res.once('data', (chunk) => {
          const ok = chunk.length >= 3 && chunk[0] === 0x46 && chunk[1] === 0x4c && chunk[2] === 0x56;
          finish(ok ? null : new Error(`Video-Endpunkt liefert keinen FLV-Stream (HTTP ${res.statusCode || 0})`));
        });
        res.once('end', () => finish(new Error('Video-Endpunkt hat keine Daten geliefert')));
        res.once('error', finish);
      });
      req.on('timeout', () => req.destroy(new Error('Video-Verbindung hat das Zeitlimit überschritten')));
      req.on('error', reject);
    });

    if (!bypassCache) {
      this._lastProbeAt = now;
      this._lastProbeOk = true;
    }
    return true;
  }
}

module.exports = DreameStandaloneVideo;
