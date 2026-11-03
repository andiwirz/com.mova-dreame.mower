'use strict';

const https  = require('https');
const crypto = require('crypto');
const zlib   = require('zlib');

// Verified against HA integration: DREAME_STRINGS / MOVA_STRINGS decoded from base64+gzip.
// Both brands share the same Basic auth and password salt (confirmed from const.py).
// sendCommand host segment is derived dynamically from the device's bindDomain field.
const BRANDS = {
  dreame: {
    host:           '.iot.dreame.tech',
    port:           13267,
    tenantId:       '000000',
    userAgent:      'Dreame_Smarthome/1.5.59 (iPhone; iOS 16.0; Scale/3.00)',
    fileBridgeAuth: 'Basic ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg=',
    mqttPrefix:     '10000',
    mqttFallback:   'app.mt.eu.iot.dreame.tech:19973',
  },
  mova: {
    host:           '.iot.mova-tech.com',
    port:           13267,
    tenantId:       '000002',
    userAgent:      'Mova_Smarthome/1.5.59 (iPhone; iOS 16.0; Scale/3.00)',
    fileBridgeAuth: 'Basic bW92YV9hcHA6VjdLb0NoTFc4dkhBQ3FHYg==',
    mqttPrefix:     '20000',
    mqttFallback:   'app.mt.eu.iot.mova-tech.com:19974',
  },
};

// Both brands share the same OAuth client credentials (from DREAME_STRINGS[5] / MOVA_STRINGS[5])
const BASIC_AUTH    = 'Basic ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg=';

const PASSWORD_SALT = 'RAylYC%fmSKp7%Tq';

// ─── Property identifiers [siid, piid] ────────────────────────────────────────
const PROP = {
  // Service 1 – device / firmware
  FIRMWARE_STATE:  [1, 2],

  // Service 2 – status & control
  STATUS:          [2, 1],
  DEVICE_CODE:     [2, 2],
  SCHEDULING_TASK: [2, 50],  // zone/edge/spot mowing payload + DND config
  SETTINGS_CFG:    [2, 51],  // CFG settings blob (device pushes full settings here)

  // Service 3 – battery
  BATTERY:         [3, 1],
  CHARGING_STATUS: [3, 2],

  // Service 4 – AutoSwitch settings (single JSON-string property, read + write)
  AUTO_SWITCH:     [4, 50],
};

// Properties requested every poll tick via getRawProperties.
// MOVA cloud ignores this list and returns its own key-value format
// (SETTINGS.0, OTA_INFO.0, …). The list covers standard MiOT devices.
const DEFAULT_POLL_PROPS = [
  PROP.FIRMWARE_STATE,
  PROP.STATUS,
  PROP.DEVICE_CODE,
  PROP.BATTERY,
  PROP.CHARGING_STATUS,
  PROP.SETTINGS_CFG,
  PROP.AUTO_SWITCH,
];

class MovaApi {
  constructor({ brand = 'dreame', region = 'eu', log = null } = {}) {
    this._brand    = brand;
    this._region   = region;
    this._config   = BRANDS[brand];
    if (!this._config) throw new Error(`Unknown brand: ${brand}`);

    this._baseUrl           = `${region}${this._config.host}`;
    this._port              = this._config.port;
    this._accessToken       = null;
    this._refreshToken      = null;
    this._tokenExpiry       = 0;
    this._username          = null;
    this._requestId         = 0;
    this._refreshPromise    = null;  // mutex: prevents concurrent refresh races
    // MAPI selects the cursor consumed by MAPD. Keep every MAPI/MAPD transfer
    // and captured map-screen sequence on one API-level queue so another caller
    // can never reselect that cursor in the middle of a direct snapshot.
    this._mapTransferTail   = Promise.resolve();
    this._log               = log || (() => {});
    this._sendCommandHost   = '';    // set via setBindDomain() once device info is known
    this._deviceListCache   = null;  // cached result of getDevices()
    this._deviceListCacheTs = 0;     // timestamp of last cache fill
  }

  // ─── Token helpers ────────────────────────────────────────────────────────

  setTokens({ accessToken, refreshToken, tokenExpiry }) {
    this._accessToken  = accessToken;
    this._refreshToken = refreshToken;
    this._tokenExpiry  = tokenExpiry || 0;
  }

  getTokens() {
    return {
      accessToken:  this._accessToken,
      refreshToken: this._refreshToken,
      tokenExpiry:  this._tokenExpiry,
    };
  }

  getBrand()    { return this._brand; }
  getRegion()   { return this._region; }
  getUsername() { return this._username; }
  getMqttConfig() { return { prefix: this._config.mqttPrefix, fallback: this._config.mqttFallback }; }

  /**
   * Set the sendCommand host segment from the device's bindDomain field.
   * Mirrors the HA integration logic:
   *   bindDomain "20000.iot.mova-tech.com" → host "-20000"
   *   bindDomain "" or null                → host ""
   * Call this once after device info is retrieved (during poll or pairing).
   */
  setBindDomain(bindDomain) {
    if (bindDomain && String(bindDomain).length > 0) {
      this._sendCommandHost = `-${String(bindDomain).split('.')[0]}`;
    } else {
      this._sendCommandHost = '';
    }
    this._log(`[api] sendCommandHost set to "${this._sendCommandHost}" from bindDomain "${bindDomain}"`);
  }

  getBindDomain() { return this._sendCommandHost; }

  // ─── Low-level HTTP ───────────────────────────────────────────────────────

  _request(path, body, isForm = false, options = {}) {
    return new Promise((resolve, reject) => {
      const bodyStr = isForm ? body : JSON.stringify(body || {});

      const headers = {
        'User-Agent':      this._config.userAgent,
        'Accept':          '*/*',
        'Accept-Language': 'en-US;q=0.8',
        'Content-Type':    isForm ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length':  Buffer.byteLength(bodyStr),
        'Tenant-Id':       this._config.tenantId,
      };

      if (isForm) {
        // OAuth token requests use Basic auth (same credentials for both brands)
        headers['Authorization'] = BASIC_AUTH;
      } else {
        // Stable mower API profile. Keep this unchanged for normal control/status.
        headers['Dreame-Auth'] = this._accessToken;
      }

      if (options.extraHeaders && typeof options.extraHeaders === 'object') {
        Object.assign(headers, options.extraHeaders);
      }

      const req = https.request(
        {
          hostname:           options.hostname || this._baseUrl,
          port:               options.port || this._port,
          path,
          method:             'POST',
          headers,
          rejectUnauthorized: true,
          timeout:            options.timeout || 20000,
        },
        (res) => {
          if (typeof options.onHttpStatus === 'function') {
            try { options.onHttpStatus(res.statusCode); } catch (_) {}
          }
          const chunks = [];
          let stream = res;
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
          if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
              resolve(JSON.parse(raw));
            } catch {
              // Some API responses (Dreame/MOVA) contain two kinds of malformed JSON:
              //
              //  1. "property": "{"lwt":1,"mac":"AA:BB:CC:DD:EE:FF"}"
              //     The value is a JSON object serialised as a string but with inner
              //     quotes unescaped. We inline it as a real JSON object so callers
              //     can read sub-fields (e.g. latestFaultCode, errCode).
              //
              //  2. "someField": ,   or   "someField": }
              //     Null-like values emitted without an explicit null literal.
              //     These are replaced with null.
              try {
                const sanitized = raw
                  .replace(/"property"\s*:\s*"\{([^}]*)\}"(,?)/g, (_, inner, comma) => {
                    try { JSON.parse(`{${inner}}`); return `"property": {${inner}}${comma}`; }
                    catch { return `"property": null${comma}`; }
                  })
                  .replace(/(:\s*)(,|}|])/g, '$1null$2');
                resolve(JSON.parse(sanitized));
              } catch {
                reject(new Error(`Invalid JSON from ${path}: ${raw.slice(0, 200)}`));
              }
            }
          });
          stream.on('error', reject);
        },
      );

      req.on('timeout', () => req.destroy(new Error(`Timeout: ${path}`)));
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });
  }

  async _ensureAuth() {
    if (!this._accessToken) throw new Error('Not authenticated');
    if (Date.now() >= this._tokenExpiry - 120_000) {
      await this._refreshOnce();
    }
  }

  /** Mutex: coalesce concurrent refresh calls into one request. */
  _refreshOnce() {
    if (!this._refreshPromise) {
      this._refreshPromise = this._doRefresh().finally(() => {
        this._refreshPromise = null;
      });
    }
    return this._refreshPromise;
  }

  /**
   * Refresh the access token even when the local expiry still looks valid.
   *
   * Used when a peer rejected the current token — the MQTT broker refusing the
   * CONNECT, for example. The server's verdict outranks our cached expiry, so
   * waiting for that expiry would keep replaying a token we already know is
   * dead. Shares the mutex above, so a concurrent poll cannot start a second
   * refresh.
   */
  async forceTokenRefresh() {
    if (!this._refreshToken) throw new Error('No refresh token');
    return this._refreshOnce();
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  async login(username, password) {
    this._username = username;
    const hash = crypto.createHash('md5').update(password + PASSWORD_SALT).digest('hex');
    const body = `platform=IOS&scope=all&grant_type=password&username=${encodeURIComponent(username)}&password=${hash}&type=account`;
    const res  = await this._request('/dreame-auth/oauth/token', body, true);
    this._storeTokens(res);
    return res;
  }

  async _doRefresh() {
    if (!this._refreshToken) throw new Error('No refresh token');
    const body = `platform=IOS&scope=all&grant_type=refresh_token&refresh_token=${encodeURIComponent(this._refreshToken)}`;
    const res  = await this._request('/dreame-auth/oauth/token', body, true);
    this._storeTokens(res);
  }

  _storeTokens(res) {
    if (!res.access_token) throw new Error(`Auth failed: ${JSON.stringify(res)}`);
    this._accessToken  = res.access_token;
    this._refreshToken = res.refresh_token;
    this._tokenExpiry  = Date.now() + ((res.expires_in || 7200) - 120) * 1000;
    if (res.uid) this._uid = String(res.uid);
    const localeHint = res.countryCode ?? res.country ?? res.location ?? res.serverSite;
    if (localeHint != null && String(localeHint).trim()) this._accountCountry = String(localeHint).trim();
  }

  getUid() { return this._uid; }

  // ─── Device discovery ─────────────────────────────────────────────────────

  /**
   * Fetch current status for a single device from the device-list endpoint.
   * Used as a fallback for MOVA / v2-API devices that don't expose MiOT
   * properties via getDeviceData (those return a key-value object instead of
   * the expected siid:piid array).
   *
   * The device list is cached for up to 60 s to avoid fetching all account
   * devices on every 30-second poll cycle. The cache is invalidated immediately
   * if the requested device is not found (stale list after re-pairing etc.).
   *
   * Returns the matching device object, or null if not found.
   */
  async getDeviceStatus(did) {
    const CACHE_TTL = 60_000; // ms
    const now = Date.now();
    if (!this._deviceListCache || now - this._deviceListCacheTs > CACHE_TTL) {
      this._deviceListCache   = await this.getDevices();
      this._deviceListCacheTs = now;
    }
    const device = this._deviceListCache.find((d) => String(d.did) === String(did));
    if (!device) {
      // Device not in cached list — force a fresh fetch next call.
      this._deviceListCache = null;
    }
    return device || null;
  }

  /** Return the complete raw API response for device discovery (used by the debug settings page). */
  async getRawDevices() {
    await this._ensureAuth();
    return this._request('/dreame-user-iot/iotuserbind/device/listV2', {});
  }

  async getDevices() {
    const res = await this.getRawDevices();
    if (res.code !== 0) throw new Error(`getDevices (${res.code}): ${res.msg}`);
    const d = res.data || {};
    // v2 API (MOVA/new Dreame): data.page.records
    // Older variants: data.list, data.records
    const list = (d.page && d.page.records)
        || d.list || d.records || d.devices || d.items
        || (Array.isArray(d) ? d : []);
    for (const dev of list) {
      if (dev && typeof dev.property === 'string' && dev.property.startsWith('{')) {
        try { dev.property = JSON.parse(dev.property); } catch {}
      }
    }
    return list;
  }

  // ─── Properties ───────────────────────────────────────────────────────────

  /**
   * Return the full raw API response from getDeviceData without normalising.
   * MOVA devices ignore the MiOT model list and return their own key-value
   * format (SETTINGS.0, OTA_INFO.0, prop.s_auto_upgrade, …).
   * Standard Dreame devices return an array of {siid, piid, value} objects.
   */
  async getRawProperties(did, props = DEFAULT_POLL_PROPS) {
    await this._ensureAuth();
    const model = props.map(([siid, piid]) => ({ siid, piid }));
    const res   = await this._request('/dreame-user-iot/iotuserdata/getDeviceData', { did, model });
    return res;
  }

  /**
   * Read named cloud device-data keys directly.  Unlike getRawProperties(),
   * which passes MiOT {siid,piid} selectors and relies on the mower backend to
   * return its MOVA key/value payload as a side effect, this asks explicitly
   * for the requested keys (for example MAP.0..MAP.127 + MAP.info).
   *
   * Official Dreame Android traffic captured on 2026-10-01 uses the `keys`
   * field for this v2 endpoint (`keys:[]` for a full device-data snapshot and
   * `keys:["FBD_NTYPE.0"]` for a named read).  Earlier test builds used
   * `model:["MAP.0", ...]`; that is not the vendor request shape and can be
   * ignored/fallback-cached by the A2 backend.  Keep this separate from the
   * standard-MiOT `model` selector used by getRawProperties().
   */
  async getRawDeviceDataKeys(did, keys = []) {
    await this._ensureAuth();
    const selected = Array.isArray(keys) ? keys.map(String) : [];
    return this._request('/dreame-user-iot/iotuserdata/getDeviceData', { did, keys: selected });
  }

  async getRawMapBatch(did) {
    const keys = Array.from({ length: 128 }, (_, i) => `MAP.${i}`);
    keys.push('MAP.info');
    return this.getRawDeviceDataKeys(did, keys);
  }

  /**
   * Read the v2 cloud key/value snapshot with the empty `keys:[]` request shape
   * observed in Dreame app traffic. Field verification on the A2 showed that the
   * returned MAP.* payload can lag a successful native edit, but the request is
   * still part of the captured vendor map-screen refresh sequence. Post-edit
   * confirmation therefore performs it and independently verifies direct MAPD.
   */
  async getRawDeviceDataSnapshot(did) {
    return this.getRawDeviceDataKeys(did, []);
  }

  /**
   * Legacy/experimental map-frame request retained only for compatibility with
   * older code paths. It was NOT present in the 2026-10-01 original-app map-open
   * capture and returned 80001 on the tested A2, so current map synchronization
   * must never depend on it. The verified path is the app-action map context +
   * keys:[] request and independent MAPI/MAPD readback.
   */
  async requestMapFrame(did) {
    return this.sendAction(did, 6, 1, [{
      piid: 2,
      value: JSON.stringify({ req_type: 1, frame_type: 'I', force_type: 1 }),
    }]);
  }

  async setProperty(did, siid, piid, value) {
    await this._ensureAuth();
    this._log(`[api] setProperty ${siid}:${piid} =`, JSON.stringify(value).slice(0, 120));
    const res = await this._request('/dreame-user-iot/iotuserdata/setDeviceData', {
      did,
      model: [{ siid, piid, value }],
    });
    this._log(`[api] setProperty ${siid}:${piid} → code ${res.code}${res.msg ? ' ' + res.msg : ''}`);
    if (res.code === 80001) throw new Error('Device offline');
    if (res.code !== 0)    throw new Error(`setProperty (${res.code}): ${res.msg}`);
    return res.data;
  }

  // ─── Property read via sendCommand ───────────────────────────────────────

  /**
   * Read siid:1 piid:4 — the mower's live position binary packet.
   * ioBroker.dreame receives this via MQTT push; we poll it via get_properties.
   * Binary format (7 bytes, header 0xce):
   *   byte[0]: 0xce (magic)
   *   bytes[1-3]: 20-bit signed x packed with lower nibble of byte[3]
   *   bytes[3-5]: 20-bit signed y packed with upper nibble of byte[3]
   *   byte[6]: angle (0–255 → 0–360°)
   * Returns { x, y, angle } in MAP mm (raw × 10), or null if unavailable.
   */
  async getMowerPosition(did) {
    const res = await this.getProperties(did, [[1, 4]]);
    if (res.code !== 0) return null;
    const prop = (res.data?.result || []).find((p) => p.siid === 1 && p.piid === 4);
    if (!prop || !Array.isArray(prop.value) || prop.value.length < 7) return null;
    const buf = Buffer.from(prop.value);
    if (buf[0] !== 0xce) return null;
    const x     = (buf[3] << 28 | buf[2] << 20 | buf[1] << 12) >> 12;
    const y     = (buf[5] << 24 | buf[4] << 16 | buf[3] << 8)  >> 12;
    const angle = Math.round(buf[6] / 255 * 360);
    return { x: x * 10, y: y * 10, angle };
  }

  async getProperties(did, props, requestOptions = {}) {
    await this._ensureAuth();
    this._requestId++;
    const id   = this._requestId;
    const path = `/dreame-iot-com${this._sendCommandHost}/device/sendCommand`;
    const params = props.map(([siid, piid]) => ({ siid, piid, did }));
    const res  = await this._request(path, {
      did,
      id,
      data: { did, id, method: 'get_properties', params },
    }, false, requestOptions);
    return res;
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  async sendAction(did, siid, aiid, params = [], requestOptions = {}) {
    await this._ensureAuth();
    this._requestId++;
    const id   = this._requestId;
    const path = `/dreame-iot-com${this._sendCommandHost}/device/sendCommand`;
    const nativeMapEdit = params.some((p) => p?.m === 'a' && (p.o === 215 || p.o === 218));
    const paramsLog = nativeMapEdit
      ? ' in=[native map edit redacted]'
      : params.length ? ' in=' + JSON.stringify(params).slice(0, 120) : '';
    this._log(`[api] sendAction ${siid}:${aiid}${paramsLog}`);
    const res  = await this._request(path, {
      did,
      id,
      data: { did, id, method: 'action', params: { did, siid, in: params, aiid } },
    }, false, requestOptions);
    this._log(`[api] sendAction ${siid}:${aiid} → code ${res.code}${res.msg ? ' ' + res.msg : ''}`);
    if (res.code === 80001) throw new Error('Device offline');
    if (res.code !== 0)    throw new Error(`sendAction ${siid}:${aiid} (${res.code}): ${res.msg}`);
    return res.data;
  }

  // ─── Mowing commands ──────────────────────────────────────────────────────

  startMowing(did)       { return this.sendAction(did, 5, 1); }
  stopMowing(did, requestOptions = {}) { return this.sendAction(did, 5, 2, [], requestOptions); }
  dock(did)              { return this.sendAction(did, 5, 3); }
  pause(did, requestOptions = {}) { return this.sendAction(did, 5, 4, [], requestOptions); }
  // START_SWEEP resumes an active mowing session; the firmware is context-aware.
  resume(did)            { return this.sendAction(did, 5, 1); }

  /**
   * Enter manual (remote-control) mode.
   * TODO: verify siid:aiid on real device.
   */
  startManualMowing(did) { return this.sendAction(did, 5, 7); }

  /**
   * Start edge mowing (contour/perimeter).
   * CONFIRMED WORKING on MOVA devices.
   *
   * Omitting the `edge` field entirely (d:{}) causes the device to mow all
   * stored boundaries automatically. Passing boundary IDs (e.g. [[0,0]]) causes
   * "zone unreachable" errors because those IDs are boundary-segment IDs from
   * the map — not zone IDs — and must not be guessed.
   *
   * @param {number}     mapIndex  Active map index (default 0)
   * @param {number[][]} edgeIds   Optional boundary ID pairs from map data.
   *                               Leave null to let the device use all boundaries.
   */
  startEdgeMowing(did, mapIndex = 0, edgeIds = null) {
    const d = edgeIds ? { edge: edgeIds } : {};
    return this.sendAction(did, 2, 50, [{ m: 'a', p: mapIndex, o: 101, d }]);
  }

  /**
   * Start edge mowing for a single zone (mow that zone's perimeter only).
   * Passes the zone ID as an edge pair [[zoneId, mapIndex]].
   * @param {number} zoneId    Zone/segment ID from map data
   * @param {number} mapIndex  Active map index
   */
  startEdgeZoneMowing(did, zoneId, mapIndex = 0) {
    return this.sendAction(did, 2, 50, [{ m: 'a', p: mapIndex, o: 101, d: { edge: [[zoneId, mapIndex]] } }]);
  }

  /**
   * Start border patrol for a zone (Randpatrouille): mower traces the zone boundary
   * without cutting — used to verify or demonstrate the boundary.
   * Source: packet capture — siid:2, aiid:50, o:108, d:{edge:[[zoneId, mapIndex]]}.
   * @param {number} zoneId    Zone/segment ID from map data
   * @param {number} mapIndex  Active map index
   */
  startBorderPatrol(did, zoneId, mapIndex = 0) {
    return this.sendAction(did, 2, 50, [{ m: 'a', p: mapIndex, o: 108, d: { edge: [[zoneId, mapIndex]] } }]);
  }

  /**
   * Start zone (segment) mowing.
   * @param {string[]} zoneIds  Zone IDs as shown in the MOVA/Dreame app map
   * @param {number}   passes   Number of mowing passes per zone (default 1)
   *
   * MOVA devices return 80001 for the standard Dreame START_CUSTOM action
   * (siid 4, aiid 1) — service 4 is not present in the MOVA cloud backend.
   * Confirmed payload (packet capture from MOVA app):
   *   { m:'a', p:mapIndex, o:102, d:{ region:[zoneId, ...] } }
   *   region = flat array of numeric zone IDs (no pairs, no count field)
   */
  startZoneMowing(did, zoneIds, mapIndex = 0) {
    const region = zoneIds.map((id) => Number(id));
    return this.sendAction(did, 2, 50, [
      { m: 'a', p: mapIndex, o: 102, d: { region } },
    ]);
  }

  /**
   * Start spot mowing.
   * Confirmed via packet capture — payload: { m:'a', p:mapIndex, o:103, d:{ area:[areaId, …] } }
   * The `area` array contains numeric area/spot IDs as shown in the MOVA/Dreame app map.
   * @param {string[]} spotIds   Spot/area IDs from the app map
   * @param {number}   mapIndex  Active map index (default 0)
   */
  startSpotMowing(did, spotIds, mapIndex = 0) {
    const area = spotIds.map((id) => Number(id));
    return this.sendAction(did, 2, 50, [{ m: 'a', p: mapIndex, o: 103, d: { area } }]);
  }

  // ─── Utility commands ─────────────────────────────────────────────────────

  /**
   * Emit audible alert to locate the mower.
   * Source: ioBroker.dreame apk.md — op-code 9 = findBot via app-action channel (siid:2, aiid:50).
   * Previously used siid:7, aiid:1 (HA types.py LOCATE) — app-channel is more reliable on MOVA.
   */
  findBot(did) {
    return this.sendAction(did, 2, 50, [{ m: 'a', p: 0, o: 9, d: {} }]);
  }

  /**
   * Send mower to its configured maintenance point.
   * Source: packet capture — op-code 109, d:{ point:[1] }, p:mapIndex (siid:2, aiid:50).
   */
  goToMaintenancePoint(did, mapIndex = 0, pointIndex = 1) {
    return this.sendAction(did, 2, 50, [{ m: 'a', p: mapIndex, o: 109, d: { point: [pointIndex] } }]);
  }

  switchMap(did, mapIndex) {
    return this.sendAction(did, 2, 50, [{ m: 'a', p: 0, o: 200, d: { idx: mapIndex } }]);
  }

  async getMapList(did) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'MAPL' }]);
    return data?.result?.out?.[0] ?? data;
  }

  /**
   * Fetch mowing history (session records).
   * Source: packet capture — siid:2, aiid:50, in:[{m:'g', t:'MIHIS'}].
   * Returns the raw action response data so callers can inspect the structure.
   */
  async getMowingHistory(did) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'MIHIS' }]);
    return data?.result?.out?.[0] ?? data;
  }

  /**
   * Dismiss a recoverable fault so mowing can resume.
   * Source: EvotecIT HA integration types.py — CLEAR_WARNING = siid:4, aiid:3
   * Note: siid 4 returns 80001 on MOVA devices (service not supported).
   */
  suppressFault(did) { return this.sendAction(did, 4, 3); }

  // ─── Configuration writes ─────────────────────────────────────────────────

  /**
   * Toggle child/safety lock.
   * Source: ioBroker.dreame — CFG key "CLS", value 0=off / 1=on.
   * piid 2:51 is the read-only SETTINGS_CFG blob — do not write to it directly.
   */
  setChildLock(did, enabled) {
    return this._sendCFG(did, 'CLS', enabled ? 1 : 0);
  }

  /**
   * Set Do-Not-Disturb with a time window.
   * Confirmed via packet capture — payload: { m:'s', t:'DND', d:{ value:0|1, time:[startMin,endMin] } }
   * Times are minutes since midnight (e.g. 1320=22:00, 480=08:00).
   * @param {boolean} enabled
   * @param {number}  startMin  Start of DND window in minutes since midnight
   * @param {number}  endMin    End of DND window in minutes since midnight
   */
  setDNDSchedule(did, { enabled, startMin, endMin }) {
    return this.sendAction(did, 2, 50, [{
      m: 's', t: 'DND',
      d: { value: enabled ? 1 : 0, time: [startMin, endMin] },
    }]);
  }

  /**
   * Set rain protection config.
   * Captured payload: { m:'s', t:'WRP', d:{ value:1, sen:1, time:7 } }
   *   value  — 1=enabled, 0=disabled
   *   sen    — sensitivity (1–3)
   *   time   — wait time in HOURS before resuming after rain
   */
  setRainProtectionConfig(did, { enabled, sensitivity, waitHours }) {
    return this.sendAction(did, 2, 50, [{
      m: 's',
      t: 'WRP',
      d: { value: enabled ? 1 : 0, sen: sensitivity, time: waitHours },
    }]);
  }

  /**
   * Set lighting config.
   * Captured payload: { m:'s', t:'LIT', d:{ value:0|1, time:[startMin,endMin], light:[...] } }
   *   value     — 0=disabled, 1=enabled
   *   timeStart — start hour (0–23), converted to minutes for the API
   *   timeEnd   — end hour (1–24), converted to minutes for the API
   *   light     — array of 4 LED values; preserved unchanged from the last device read
   */
  setLighting(did, { value, timeStart, timeEnd, light = [0, 0, 0, 0] }) {
    return this.sendAction(did, 2, 50, [{
      m: 's',
      t: 'LIT',
      d: {
        value,
        time:  [Math.round(timeStart * 60), Math.round(timeEnd * 60)],
        light,
      },
    }]);
  }

  /**
   * Read all mower CFG settings at once.
   * Returns the d-object: { WRP:{value,sen,time}, PRE:[...], DND:{...}, VOL:N, … }
   * or null if the response is malformed.
   */
  async getCFG(did) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'CFG' }]);
    return data?.result?.out?.[0]?.d ?? null;
  }

  /**
   * Source: packet capture — siid:2, aiid:50, in:[{m:'g', t:'DOCK'}].
   * Returns { x, y, near_x, near_y, yaw, connect_status } or null.
   * x/y and near_x/near_y are in raw map units; multiply by 10 to get mm in map coordinate space.
   */
  async getDockPosition(did) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'DOCK' }]);
    return data?.result?.out?.[0]?.d?.dock ?? null;
  }

  /**
   * Source: packet capture (official MOVA app) — siid:2, aiid:50, in:[{m:'g', t:'LOCN'}].
   * Returns the raw d object from the response, or null. Expected to contain current mower
   * position in map coordinates. Log the raw d to discover the field names on first use.
   */
  async getLOCN(did) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'LOCN' }]);
    return data?.result?.out?.[0]?.d ?? null;
  }

  /** Source: packet capture (official MOVA app) — returns map list. Structure TBD. */
  async getMAPL(did) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'MAPL' }]);
    return data?.result?.out?.[0]?.d ?? null;
  }

  /**
   * Source: packet capture — siid:2, aiid:50, in:[{m:'g', t:'MITRC', d:{idx, size}}].
   * Returns the raw base64 track string, or null.
   * Decode with Buffer.from(track, 'base64'), then parse as 5-byte records (see _parseMITRCPosition).
   */
  async getMITRC(did, idx = 0, size = 60) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'MITRC', d: { idx, size } }]);
    const d = data?.result?.out?.[0]?.d;
    if (d && !d.track) this._log(`[getMITRC] code=0 but no track — d keys: ${Object.keys(d).join(',')}`);
    return d?.track ?? null;
  }

  /**
   * Read the map-scoped PRE preference array from the mower.
   * Newer firmware (including the turning-method firmware family) exposes
   * PRE through the routed action endpoint with idx/region addressing.
   */
  async getPRE(did, idx = 0, region = 0) {
    const data = await this.sendAction(did, 2, 50, [{
      m: 'g', t: 'PRE', d: { idx: Number(idx), region: Number(region) },
    }]);
    const out = data?.result?.out?.[0];
    if (out && Number(out.r || 0) !== 0) {
      const err = new Error(`PRE read rejected (r=${out.r})`);
      err.preRejected = true;
      throw err;
    }
    return Array.isArray(out?.d) ? out.d : null;
  }

  /**
   * Write the complete PRE preference array. The caller must perform a
   * read-modify-write so unknown/new firmware fields remain untouched.
   */
  writePRE(did, preArray) {
    if (!Array.isArray(preArray) || preArray.length < 10) {
      throw new Error('PRE array is missing or incomplete');
    }
    return this.sendAction(did, 2, 50, [{ t: 'PRE', d: preArray, m: 's' }]);
  }

  /**
   * Fresh SETTINGS read used for map-scoped dual writes such as steeringMode.
   * MOVA returns SETTINGS as 1024-byte chunks in the device-data response.
   */
  async getSETTINGSBlob(did) {
    const raw = await this.getRawProperties(did);
    const data = raw?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    let joined = '';
    for (let i = 0; i < 16 && data[`SETTINGS.${i}`] != null; i++) joined += String(data[`SETTINGS.${i}`] ?? '');
    if (!joined) return null;
    const info = Number(data['SETTINGS.info']);
    if (Number.isFinite(info) && info > 0) joined = joined.slice(0, info);
    try {
      const parsed = JSON.parse(joined);
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      // Some responses omit SETTINGS.info. Fall back to the first prefix
      // that forms a complete JSON array.
      let prefix = '';
      for (let i = 0; i < 16 && data[`SETTINGS.${i}`] != null; i++) {
        prefix += String(data[`SETTINGS.${i}`] ?? '');
        try {
          const parsed = JSON.parse(prefix);
          if (Array.isArray(parsed)) return parsed;
        } catch (_) {}
      }
      return null;
    }
  }

  /**
   * Write one map-general SETTINGS field without clobbering other settings.
   * The cloud KV record is the original-app mirror; the device PRE write is
   * still authoritative and is performed separately by the caller.
   */
  async writeSETTINGSField(did, mapIndex, field, value) {
    const current = await this.getSETTINGSBlob(did);
    if (!Array.isArray(current)) throw new Error('SETTINGS could not be read for safe update');
    const idx = Number(mapIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) throw new Error('Invalid SETTINGS map index');
    const next = JSON.parse(JSON.stringify(current));
    const entry = next[idx];
    const settings = entry?.settings;
    const general = settings?.['0'] ?? (settings && !Array.isArray(settings) ? settings : null);
    if (!general || typeof general !== 'object' || Array.isArray(general)) throw new Error('SETTINGS general map section missing');
    general[field] = value;
    const text = JSON.stringify(next);
    const chunks = {};
    const CHUNK = 1024;
    for (let off = 0, n = 0; off < text.length; off += CHUNK, n++) chunks[`SETTINGS.${n}`] = text.slice(off, off + CHUNK);
    chunks['SETTINGS.info'] = String(text.length);
    await this._ensureAuth();
    const res = await this._request('/dreame-user-iot/iotuserdata/setDeviceData', { did, data: chunks });
    if (res?.code !== 0 && res?.success !== true) throw new Error(`SETTINGS write rejected (${res?.code ?? 'unknown'}): ${res?.msg || ''}`.trim());
    return res;
  }

  // ─── CFG command system (siid:2, aiid:50) ────────────────────────────────
  //
  // The device stores certain settings as opaque blobs.
  // Reading:  poll property 2:51 → device returns full JSON blob.
  // Writing:  MiOT action siid:2, aiid:50 with in:[{m:'s', t:'KEY', d:{value:X}}].
  // Confirmed via ioBroker adapter source (TA2k/ioBroker.dreame).

  /** @private Send a CFG set action (standard format: d = { value: X }). */
  _sendCFG(did, key, value) {
    return this.sendAction(did, 2, 50, [{ m: 's', t: key, d: { value } }]);
  }

  /**
   * Set battery power config (return threshold, resume threshold, schedule enabled).
   * Confirmed via packet capture — payload: { m:'s', t:'BAT', d:{ value:[returnPct, resumePct, scheduleEnabled], type:'power' } }
   * GET returns full BAT array [returnPct, resumePct, scheduleEnabled, ?, startMin, endMin].
   * Note: schedule time window write format (type:'schedule') is not yet confirmed.
   * @param {number}  returnPct       Battery % at which the mower returns to dock (e.g. 15)
   * @param {number}  resumePct       Battery % at which the mower resumes after charging (e.g. 100)
   * @param {boolean} autoResume  When true the mower resumes its unfinished task after charging completes
   */
  setBatteryConfig(did, { returnPct, resumePct, autoResume }) {
    return this.sendAction(did, 2, 50, [{
      m: 's', t: 'BAT',
      d: { value: [Math.round(returnPct), Math.round(resumePct), autoResume ? 1 : 0], type: 'power' },
    }]);
  }

  /**
   * Set Low Speed at Night.
   * Confirmed via packet capture — payload: { m:'s', t:'LOW', d:{ value:0|1, time:[startMin,endMin] } }
   * Times are minutes since midnight (e.g. 1200=20:00, 480=08:00).
   * When enabled the mower slows down automatically during the set window to protect animals.
   * @param {boolean} enabled
   * @param {number}  startMin  Start of low-speed window in minutes since midnight
   * @param {number}  endMin    End of low-speed window in minutes since midnight
   */
  setLowSpeedNight(did, { enabled, startMin, endMin }) {
    return this.sendAction(did, 2, 50, [{
      m: 's', t: 'LOW',
      d: { value: enabled ? 1 : 0, time: [startMin, endMin] },
    }]);
  }

  /** Frost protection (FDP): 0=off, 1=on */
  setFrostProtection(did, enabled) {
    return this._sendCFG(did, 'FDP', enabled ? 1 : 0);
  }

  /** Rasenpflege / grass protection: gentle turns, PROT 0=off, 1=on. */
  setGrassProtection(did, enabled) {
    return this._sendCFG(did, 'PROT', enabled ? 1 : 0);
  }

  /**
   * Set speaker volume (0–100).
   * Source: ioBroker.dreame — CFG key "VOL", numeric value 0–100.
   * setProperty(2,114) was a wrong guess; VOL goes through the CFG action channel.
   */
  setVolume(did, volume) {
    return this._sendCFG(did, 'VOL', Math.round(volume));
  }

  /**
   * Voice announcement modes (VOICE): array [notification, workStatus, specialStatus, errorStatus].
   *   [0] notification  — regular notification announcements
   *   [1] workStatus    — work status announcements (mowing started/stopped/returning …)
   *   [2] specialStatus — special status announcements
   *   [3] errorStatus   — error status announcements
   * Confirmed via packet capture — payload: { m:'s', t:'VOICE', d:{ value:[0|1, 0|1, 0|1, 0|1] } }
   * All four values must always be sent together.
   */
  setVoiceModes(did, { notification, workStatus, specialStatus, errorStatus }) {
    return this.sendAction(did, 2, 50, [{
      m: 's', t: 'VOICE',
      d: { value: [notification ? 1 : 0, workStatus ? 1 : 0, specialStatus ? 1 : 0, errorStatus ? 1 : 0] },
    }]);
  }

  /**
   * Anti-theft alarm (ATA): array [liftAlarm, mapAlarm, realtimeLocation].
   *   [0] liftAlarm       — locks mower and triggers alarm when lifted (confirmed via packet capture)
   *   [1] mapAlarm        — triggers alarm when mower leaves the map (requires Link module)
   *   [2] realtimeLocation — enables real-time GPS location tracking (requires Link module)
   * Payload: { m:'s', t:'ATA', d:{ value:[0|1, 0|1, 0|1] } }
   * All three values must always be sent together.
   */
  setAntiTheftAlarm(did, { lift, mapAlarm, realtime }) {
    return this.sendAction(did, 2, 50, [{
      m: 's', t: 'ATA',
      d: { value: [lift ? 1 : 0, mapAlarm ? 1 : 0, realtime ? 1 : 0] },
    }]);
  }

  /**
   * AI obstacle photo capture (AOP): 0=off, 1=on.
   * When enabled, the mower photographs obstacles detected by AI and stores them
   * so the user can tap obstacle icons on the map to see actual photos.
   * Confirmed via packet capture — payload: { m:'s', t:'AOP', d:{ value:0|1 } }
   */
  setAIObstaclePhoto(did, enabled) {
    return this._sendCFG(did, 'AOP', enabled ? 1 : 0);
  }

  // ─── New map / obstacle APIs (discovered via HAR capture 2026-06-13) ────────

  /**
   * MAPI — map metadata API.
   * Current A2 firmware (4.3.6_0668, captured 2026-10-01) returns only map
   * metadata such as {idx, hash, size}.  Older firmwares/regions may still
   * return a fuller object, so callers may retain it as a fallback but must not
   * assume it contains geometry. Current verification uses MAPI as metadata/cursor
   * around chunked MAPD and separately reproduces the vendor keys:[] cloud read.
   */
  _withMapTransferLock(fn) {
    // Lazy init also covers unit-test/prototype instances that bypass constructor.
    const previous = this._mapTransferTail || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    // A rejected operation must not poison the queue for the next reader.
    this._mapTransferTail = run.catch(() => {});
    return run;
  }

  async _getMAPIUnlocked(did, idx = 0) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'MAPI', d: { idx } }]);
    return data?.result?.out?.[0] ?? null;
  }

  async getMAPI(did, idx = 0) {
    return this._withMapTransferLock(() => this._getMAPIUnlocked(did, idx));
  }

  /**
   * MAPD — direct mower-side map payload chunk.
   *
   * Current A2 firmware exposes the JSON map selected by MAPI through repeated
   * read-only MAPD calls. `start` advances by the firmware-reported chunk size,
   * not necessarily by the UTF-8 byte length of the decoded JSON string: the
   * transport size may include JSON escape overhead. Keep this primitive small;
   * callers that need an authoritative snapshot should use getDirectMapSnapshot().
   */
  async _getMAPDUnlocked(did, start = 0, size = 400) {
    const offset = Number(start);
    const length = Number(size);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid MAPD start');
    if (!Number.isInteger(length) || length <= 0 || length > 400) throw new Error('Invalid MAPD size');
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'MAPD', d: { start: offset, size: length } }]);
    return data?.result?.out?.[0] ?? null;
  }

  async getMAPD(did, start = 0, size = 400) {
    return this._withMapTransferLock(() => this._getMAPDUnlocked(did, start, size));
  }

  _directMapMeta(mapi, idx) {
    const data = mapi?.d ?? mapi;
    const size = Number(data?.size);
    const hash = typeof data?.hash === 'string' ? data.hash.toLowerCase() : null;
    const reportedIdx = Number(data?.idx);
    if (!Number.isInteger(size) || size <= 0) throw new Error('MAPI missing valid map size');
    if (!hash || !/^[0-9a-f]{32}$/i.test(hash)) throw new Error('MAPI missing valid map hash');
    if (Number.isInteger(reportedIdx) && reportedIdx !== Number(idx)) throw new Error('MAPI map index mismatch');
    return { idx: Number(idx), size, hash };
  }

  async _downloadDirectMapSnapshotOnce(did, idx = 0, chunkSize = 400) {
    const beforeRaw = await this._getMAPIUnlocked(did, idx);
    const before = this._directMapMeta(beforeRaw, idx);
    let offset = 0;
    let chunkCount = 0;
    let payloadText = '';

    while (offset < before.size) {
      const requested = Math.min(chunkSize, before.size - offset);
      const out = await this._getMAPDUnlocked(did, offset, requested);
      const data = out?.d ?? out;
      if (!data || typeof data !== 'object') throw new Error(`MAPD invalid chunk at ${offset}`);
      const text = data.data;
      const returnedStart = Number(data.start);
      const returnedSize = Number(data.size);
      if (typeof text !== 'string' || text.length === 0) throw new Error(`MAPD empty chunk at ${offset}`);
      if (Number.isFinite(returnedStart) && returnedStart !== offset) throw new Error(`MAPD start mismatch at ${offset}`);
      const decodedBytes = Buffer.byteLength(text, 'utf8');
      if (decodedBytes > requested) throw new Error(`MAPD oversized chunk at ${offset}`);
      if (!Number.isInteger(returnedSize) || returnedSize < decodedBytes || returnedSize > requested) {
        throw new Error(`MAPD size mismatch at ${offset}`);
      }
      payloadText += text;
      offset += returnedSize;
      chunkCount++;
      if (chunkCount > Math.ceil(before.size / Math.max(1, chunkSize)) + 8) {
        throw new Error('MAPD chunk loop guard triggered');
      }
    }

    if (offset !== before.size) throw new Error(`MAPD incomplete snapshot ${offset}/${before.size}`);
    const md5 = crypto.createHash('md5').update(Buffer.from(payloadText, 'utf8')).digest('hex');
    if (md5 !== before.hash) throw new Error(`MAPD hash mismatch ${md5.slice(0, 8)} != ${before.hash.slice(0, 8)}`);

    let payload;
    try { payload = JSON.parse(payloadText); } catch (err) { throw new Error(`MAPD JSON parse failed: ${err.message}`); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('MAPD payload is not an object');

    // MAPI selects the cursor used by MAPD. Re-read metadata after the complete
    // download so a concurrent map change cannot be accepted as the current
    // snapshot. Hash verification protects the bytes; this second MAPI protects
    // the "current" identity of those bytes.
    const afterRaw = await this._getMAPIUnlocked(did, idx);
    const after = this._directMapMeta(afterRaw, idx);
    if (after.hash !== before.hash || after.size !== before.size) {
      throw new Error('MAPD map changed while reading');
    }

    return {
      idx: before.idx,
      hash: before.hash,
      size: before.size,
      receivedSize: offset,
      decodedSize: Buffer.byteLength(payloadText, 'utf8'),
      chunkCount,
      payload,
    };
  }

  /**
   * Read one complete mower-native map directly via MAPI + MAPD.
   *
   * This path is independent of the cloud MAP.N cache. It is therefore suited
   * to post-edit readback where MAPI has already advanced but getDeviceData may
   * still expose the previous MAP.* geometry. Only a fully reassembled,
   * MD5-verified and post-MAPI-stable payload is returned.
   */
  async getDirectMapSnapshot(did, idx = 0, options = {}) {
    const chunkSize = Math.trunc(Math.min(400, Math.max(1, Number(options.chunkSize) || 400)));
    const attempts = Math.trunc(Math.min(3, Math.max(1, Number(options.attempts) || 2)));
    return this._withMapTransferLock(async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await this._downloadDirectMapSnapshotOnce(did, idx, chunkSize);
        } catch (err) {
          lastError = err;
          this._log(`[api] direct MAPD snapshot attempt ${attempt}/${attempts} failed: ${err?.message || err}`);
        }
      }
      throw lastError || new Error('Direct MAPD snapshot unavailable');
    });
  }

  /**
   * Reproduce the read-only wake/context sequence observed in the 2026-10-01
   * Android capture.  Real-device 1.2.37 logs proved that this sequence alone
   * does not force stale cloud MAP.* to advance after a map edit.  It remains a
   * best-effort compatibility/warm-up step; 1.2.38 obtains authoritative
   * geometry separately through MAPI + chunked MAPD.
   *
   * Every operation here is read-only (`get_properties` or m:'g').  Individual
   * optional getters are best-effort so a firmware that omits one of them still
   * reaches MAPL/MAPI and the subsequent cloud snapshot read.
   */
  async refreshMapScreenContext(did, idx = 0) {
    return this._withMapTransferLock(async () => {
      const steps = [];
      const run = async (name, fn) => {
        try {
          const value = await fn();
          steps.push({ name, ok: true });
          return value;
        } catch (err) {
          steps.push({ name, ok: false, error: err?.message || String(err) });
          this._log(`[api] map-screen sync ${name} unavailable: ${err?.message || err}`);
          return null;
        }
      };

      // Initial live-device wake seen immediately when the map/device page opens.
      await run('state-1:1', () => this.getProperties(did, [[1, 1]]));
      await run('state-1:2', () => this.getProperties(did, [[1, 2]]));

      // Map-context getters in the captured Dreame app order. Keep MAPI on the
      // same transfer lock as MAPD so no concurrent Homey reader can reselect
      // the direct-map cursor.
      await run('MPOS', () => this.sendAction(did, 2, 50, [{ m: 'g', t: 'MPOS' }]));
      await run('DOCK', () => this.sendAction(did, 2, 50, [{ m: 'g', t: 'DOCK' }]));
      await run('AIOBS', () => this.sendAction(did, 2, 50, [{ m: 'g', t: 'AIOBS', d: { idx } }]));
      await run('DEV', () => this.sendAction(did, 2, 50, [{ m: 'g', t: 'DEV' }]));
      await run('MAPL', () => this.sendAction(did, 2, 50, [{ m: 'g', t: 'MAPL' }]));
      const mapi = await run('MAPI', () => this._getMAPIUnlocked(did, idx));

      await run('DOCK-2', () => this.sendAction(did, 2, 50, [{ m: 'g', t: 'DOCK' }]));
      await run('MPOS-2', () => this.sendAction(did, 2, 50, [{ m: 'g', t: 'MPOS' }]));
      await run('AIOBS-2', () => this.sendAction(did, 2, 50, [{ m: 'g', t: 'AIOBS', d: { idx } }]));

      // Critical parity with the captured Dreame app: the vendor map screen ends
      // this read-only context sequence with a full getDeviceData(keys:[]) read.
      // 1.2.40 could skip this entirely whenever MAPD parsed successfully, which
      // meant Homey did not actually reproduce the one action that field tests
      // showed can make stale cloud MAP.* catch up.
      const snapshot = await run('keys:[]', () => this.getRawDeviceDataSnapshot(did));
      return { mapi, snapshot, steps };
    });
  }

  // Manufacturer map editing is transactional:
  // o=200 select map -> o=204 begin edit -> mutation -> o=201 p=1 commit.
  // The commit is attempted even when an earlier leg is rejected so the mower
  // is never intentionally left in edit mode.
  _mapEditAccepted(result) {
    const out = result?.result?.out?.[0];
    if (!out) return true;
    if (out.status === false) return false;
    if (Number(out.error || 0) !== 0) return false;
    if (Number(out.r || 0) !== 0) return false;
    return true;
  }

  async runMapEditTransaction(did, mapIndex, mutation, options = {}) {
    const idx = Number(mapIndex);
    if (!Number.isInteger(idx) || idx < 0) throw new Error('Invalid map index');
    const legs = [];
    let firstError = null;
    const waitForTask = typeof options?.waitForTask === 'function' ? options.waitForTask : null;
    const taskTimeouts = { select: 7000, begin: 4500, mutation: 4500, commit: 4500, ...(options?.taskTimeouts || {}) };
    const send = async (name, payload, { waitTask = true } = {}) => {
      const sentAt = Date.now();
      const taskCursor = options.captureTaskCursor?.();
      // A return-zone checkpoint has an overall time budget. A stalled cloud
      // request must not initiate a new native mutation after that budget.
      const deadlineAt = Number(options.deadlineAt || 0);
      if (deadlineAt && Date.now() >= deadlineAt - 500) {
        if (!firstError) firstError = new Error('Return map-edit checkpoint expired');
        return null;
      }
      try {
        const sendTimeout = deadlineAt
          ? Math.max(500,Math.min(1800,deadlineAt-Date.now()-650)) : 20000;
        const result = await this.sendAction(did, 2, 50, [payload],
          deadlineAt ? {timeout:sendTimeout} : {});
        const accepted = this._mapEditAccepted(result);
        const leg = { name, accepted, result, opcode: Number(payload?.o), taskAck: null };
        legs.push(leg);
        if (!accepted) {
          if (!firstError) firstError = new Error(`Map edit ${name} rejected`);
          return result;
        }
        if (waitForTask && waitTask && Number.isInteger(Number(payload?.o))) {
          try {
            const remaining = deadlineAt ? Math.max(250,deadlineAt-Date.now()-700) : Infinity;
            const ack = await waitForTask(Number(payload.o), sentAt,
              Math.min(Number(taskTimeouts[name]) || 4500,remaining), taskCursor);
            // The earlier working 29-Oct delete returned TASK status:true
            // (including native id=102); subsequent *failed* deletes returned
            // status:false for 200/204/218/201, although HTTP code was zero.
            // A received TASK is NOT automatically a successful mower edit.
            const nativeTask = ack?.t === 'TASK' ? ack?.d : (ack?.value?.t === 'TASK' ? ack.value.d : null);
            if (nativeTask?.status === false || (nativeTask?.error != null && Number(nativeTask.error) !== 0)) {
              throw new Error(`Map edit ${name} TASK rejected by mower (status=${String(nativeTask.status)}, error=${String(nativeTask.error ?? '-')})`);
            }
            leg.taskAck = true;
            leg.task = ack || null;
          } catch (err) {
            leg.taskAck = false;
            leg.taskError = err.message;
            if (!firstError) firstError = String(err?.message || '').includes('TASK rejected by mower')
              ? err : new Error(`Map edit ${name} TASK confirmation timed out`);
          }
        }
        return result;
      } catch (err) {
        legs.push({ name, accepted: false, opcode: Number(payload?.o), error: err.message });
        if (!firstError) firstError = err;
        return null;
      }
    };

    // A2 field logs show that the routed-action HTTP verdict can arrive before
    // the mower has actually switched into the corresponding map-edit stage.
    // Therefore map editing is serialized against the mower's matching TASK
    // opcode when live MQTT is available. This prevents 204/215 from racing
    // ahead of a still-pending 200 map selection. Commit is always attempted so
    // a failed/timeout transaction does not leave native edit mode open.
    await send('select', { m: 'a', p: 0, o: 200, d: { idx } });
    if (!firstError) await send('begin', { m: 'a', p: 0, o: 204 });
    const mutations = Array.isArray(mutation) ? mutation : [mutation];
    for (let i = 0; i < mutations.length && !firstError; i += 1) {
      // The mower emits transient MOWING/MAPPING telemetry when entering its
      // editor (200/204). A callback can take a one-shot physical position
      // witness *after* BEGIN, while retaining the real STOP/ownership guard.
      // Awaiting also works with older synchronous canMutate callbacks.
      if (typeof options.canMutate === 'function'
          && await options.canMutate({ legs:legs.map(({name,accepted,opcode,taskAck}) =>
            ({name,accepted,opcode,taskAck})), mutationIndex:i }) !== true) {
        firstError = new Error('Map edit checkpoint expired before mutation');
        break;
      }
      const name = mutations.length === 1 ? 'mutation' : `mutation_${i + 1}`;
      await send(name, mutations[i]);
    }
    await send('commit', { m: 'a', p: 1, o: 201 }, { waitTask: !firstError });
    if (firstError) {
      firstError.mapEditLegs = legs.map(({ name, accepted, opcode, taskAck, taskError, error }) => ({ name, accepted, opcode, taskAck, taskError, error }));
      throw firstError;
    }
    return { ok: true, legs };
  }

  // Native map edit-frame coordinates are in metres.
  // The MOVA app exposes no-go zones as rectangular/polygonal areas with a
  // minimum size of 1 m × 1 m on this mower.  Keep the generic circle helper
  // for protocol diagnostics, but the Homey pylon protection path uses the
  // square polygon helper below because it matches the native shape=2 map
  // representation returned by this hardware.
  setForbiddenCircle(did, center, radiusM, id = -1, mapIndex = 0) {
    return this.runMapEditTransaction(did, mapIndex, {
      m: 'a', p: 0, o: 215,
      d: { id, type: 3, points: [[center.x, center.y]], radius: radiusM },
    });
  }

  setForbiddenPolygon(did, pointsM, id = -1, mapIndex = 0, options = {}) {
    if (!Array.isArray(pointsM) || pointsM.length < 3) {
      throw new Error('Forbidden polygon requires at least three points');
    }
    const points = pointsM.map((pt) => {
      if (!Array.isArray(pt) || pt.length !== 2
          || !Number.isFinite(Number(pt[0])) || !Number.isFinite(Number(pt[1]))) {
        throw new Error('Forbidden polygon contains an invalid point');
      }
      return [Number(pt[0]), Number(pt[1])];
    });
    return this.runMapEditTransaction(did, mapIndex, {
      m: 'a', p: 0, o: 215,
      d: { id, type: 2, points, radius: 0 },
    }, options);
  }

  deleteForbiddenArea(did, id, mapIndex = 0, options = {}) {
    return this.deleteForbiddenAreas(did, [id], mapIndex, options);
  }

  deleteForbiddenAreas(did, ids, mapIndex = 0, options = {}) {
    const uniqueIds = [...new Set((Array.isArray(ids) ? ids : [ids])
      .map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
    if (!uniqueIds.length) throw new Error('Forbidden delete requires at least one valid id');
    const mutations = uniqueIds.map((id) => ({
      m: 'a', p: 0, o: 218, d: { id, type: 0 },
    }));
    return this.runMapEditTransaction(did, mapIndex, mutations.length === 1 ? mutations[0] : mutations, options);
  }

  /**
   * AIOBS — AI obstacle observation list.
   * Returns a list of AI-detected obstacles with their map positions and
   * associated photo filenames (fetched separately via getAIObsFile).
   * Observed in HAR: { m:'g', t:'AIOBS', d:{ start:0, size:200, idx:0 } }
   * @param {number} start  Starting index
   * @param {number} size   Page size (max 200)
   * @param {number} idx    Map index
   */
  async getAIOBS(did, { start = 0, size = 200, idx = 0 } = {}) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'AIOBS', d: { start, size, idx } }]);
    return data?.result?.out?.[0]?.d ?? null;
  }

  /**
   * OBS — standard obstacle data.
   * Returns obstacle list without AI photo references.
   * Observed in HAR: { m:'g', t:'OBS', d:{ start:0, size:200, idx:1 } }
   * Note: HAR showed idx:1 (not 0) for this command.
   */
  async getOBS(did, { start = 0, size = 200, idx = 1 } = {}) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'OBS', d: { start, size, idx } }]);
    return data?.result?.out?.[0]?.d ?? null;
  }

  /**
   * Low-level binary fetch — returns a raw Buffer (no JSON parsing).
   * Used for file-bridge responses (application/octet-stream).
   */
  _requestRaw(path, body) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body || {});
      const headers = {
        'User-Agent':      this._config.userAgent,
        'Accept':          '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US;q=0.8',
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(bodyStr),
        'Tenant-Id':       this._config.tenantId,
        'Authorization':   this._config.fileBridgeAuth,
        'Dreame-Auth':     this._accessToken,
      };

      const req = https.request(
        {
          hostname:           this._baseUrl,
          port:               this._port,
          path,
          method:             'POST',
          headers,
          rejectUnauthorized: true,
          timeout:            20000,
        },
        (res) => {
          const chunks = [];
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          let stream = res;
          if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
          if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
          if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => resolve(Buffer.concat(chunks)));
          stream.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Timeout: ${path}`)));
      req.on('error', reject);
      req.write(bodyStr);
      req.end();
    });
  }

  /**
   * file-bridge — fetch an AI obstacle photo by filename.
   * Returns a raw Buffer (encrypted/compressed binary, ~61 KB).
   * Observed in HAR: POST /file-bridge/user/getDeiviceFile
   *   body: { did, fileinfo: '{"filename":"XXX.jpg","type":"ai_obs"}' }
   * Note: the API endpoint spells "Device" as "Deivice" (upstream typo).
   */
  async getAIObsFile(did, filename) {
    await this._ensureAuth();
    const fileinfo = JSON.stringify({ filename, type: 'ai_obs' });
    return this._requestRaw('/file-bridge/user/getDeiviceFile', { did, fileinfo });
  }

  /**
   * Activity session history — returns list of mowing sessions with OSS file references.
   * Observed in HAR: POST /dreame-user-iot/iotstatus/history
   *   body: { did, uid, region, key:'4.1', siid:'4', type:3, limit, time_start, time_end }
   * uid = device.uid from getDevices(); region = 'eu' etc.
   */
  async getActivityHistory(did, uid, { region = 'eu', limit = 20 } = {}) {
    await this._ensureAuth();
    const now = Math.floor(Date.now() / 1000);
    const res = await this._request('/dreame-user-iot/iotstatus/history', {
      did, uid, region,
      eiid: '1',
      key: '4.1',
      siid: '4',
      type: 3,
      limit,
      from: 0,
      time_start: 0,
      time_end: now,
    });
    return res;
  }

  /**
   * Get a signed OSS download URL for an activity session file.
   * Observed in HAR: POST /dreame-user-iot/iotfile/getDownloadUrl
   *   body: { did, uid, model, filename }
   * Returns the decrypted response (expected to contain a download URL).
   */
  async getActivityFileUrl(did, uid, model, filename) {
    await this._ensureAuth();
    const res = await this._request('/dreame-user-iot/iotfile/getDownloadUrl', {
      did, uid, model, filename,
    });
    return res;
  }

  /**
   * Fetch a plain-text activity JSON from an Alibaba OSS URL (no auth needed).
   * Returns the parsed JSON object or null.
   */
  async fetchActivityJson(url) {
    return new Promise((resolve) => {
      const https = require('https');
      https.get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null));
    });
  }

}

MovaApi.PROP               = PROP;
MovaApi.DEFAULT_POLL_PROPS = DEFAULT_POLL_PROPS;

module.exports = MovaApi;
