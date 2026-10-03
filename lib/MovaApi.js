'use strict';

const https  = require('https');
const crypto = require('crypto');
const zlib   = require('zlib');
const { VIDEO_TOKEN_PATH, VIDEO_IDENTITY_PATH, videoTokenBody, videoIdentityBody } = require('./video_identity_contract');

// Verified against HA integration: DREAME_STRINGS / MOVA_STRINGS decoded from base64+gzip.
// Both brands share the same Basic auth and password salt (confirmed from const.py).
// Ordinary mower requests keep the proven legacy profile below. TX-video
// requests use a separate Android/Dio-parity profile because the original
// Dreamehome TX client runs through DMHttpManager interceptors (Auth/Tenant,
// AppInfo/dreame-meta and RLC). Keeping this scoped to video avoids changing
// the stable mower-control API surface.
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
// Static Dreame app transport material used only to reproduce the public
// Dreame-RLC client header for authenticated TX-video requests. It is an app
// constant, never a user/account secret.
const DREAME_RLC_KEY = 'EETjszu*XI5znHsI';
const DREAME_ANDROID_META = 'cv=a_102060400';

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
    this._accountCountry     = null;  // optional cloud-provided locale hint for video RLC
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

  _makeDreameRlc() {
    if (this._brand !== 'dreame') return null;
    try {
      const country = String(this._accountCountry || 'GB').replace(/[^A-Za-z-]/g, '').slice(0, 8) || 'GB';
      const plain = `${this._region}|en|${country}`;
      const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(DREAME_RLC_KEY, 'utf8'), null);
      cipher.setAutoPadding(true);
      return Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]).toString('base64');
    } catch (_) {
      return null;
    }
  }

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

      if (!isForm && options.videoProfile) {
        // The original Android TX client is built on DMHttpManager.dio. Its
        // interceptors add app/auth context outside the small {did,os} JSON
        // contract. Reproduce only the non-secret, evidence-backed pieces here.
        headers['Authorization'] = BASIC_AUTH;
        const token = String(this._accessToken || '').trim();
        if (token) headers['Dreame-Auth'] = /^bearer\s/i.test(token) ? token : `bearer ${token}`;
        if (this._brand === 'dreame') {
          headers['Dreame-Meta'] = DREAME_ANDROID_META;
          const rlc = this._makeDreameRlc();
          if (rlc) headers['Dreame-Rlc'] = rlc;
        }
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
                reject(new Error(`Invalid JSON from ${path}: ${path.startsWith('/dreame-third-video/') ? '[redacted video response]' : raw.slice(0, 200)}`));
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

  async getProperties(did, props) {
    await this._ensureAuth();
    this._requestId++;
    const id   = this._requestId;
    const path = `/dreame-iot-com${this._sendCommandHost}/device/sendCommand`;
    const params = props.map(([siid, piid]) => ({ siid, piid, did }));
    const res  = await this._request(path, {
      did,
      id,
      data: { did, id, method: 'get_properties', params },
    });
    return res;
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  async sendAction(did, siid, aiid, params = []) {
    await this._ensureAuth();
    this._requestId++;
    const id   = this._requestId;
    const path = `/dreame-iot-com${this._sendCommandHost}/device/sendCommand`;
    const nativeMapEdit = params.some((p) => p?.m === 'a' && (p.o === 215 || p.o === 218));
    const sensitiveCameraAction = Number(siid) === 10001;
    const paramsLog = nativeMapEdit
      ? ' in=[native map edit redacted]'
      : sensitiveCameraAction
        ? (params.length ? ' in=[camera stream params redacted]' : '')
        : params.length ? ' in=' + JSON.stringify(params).slice(0, 120) : '';
    this._log(`[api] sendAction ${siid}:${aiid}${paramsLog}`);
    const res  = await this._request(path, {
      did,
      id,
      data: { did, id, method: 'action', params: { did, siid, in: params, aiid } },
    });
    this._log(`[api] sendAction ${siid}:${aiid} → code ${res.code}${res.msg ? ' ' + res.msg : ''}`);
    if (res.code === 80001) throw new Error('Device offline');
    if (res.code !== 0)    throw new Error(`sendAction ${siid}:${aiid} (${res.code}): ${res.msg}`);
    return res.data;
  }

  // ─── Mowing commands ──────────────────────────────────────────────────────

  startMowing(did)       { return this.sendAction(did, 5, 1); }
  stopMowing(did)        { return this.sendAction(did, 5, 2); }
  dock(did)              { return this.sendAction(did, 5, 3); }
  pause(did)             { return this.sendAction(did, 5, 4); }
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
  /**
   * Toggle the mower camera stream using the same app action used by Dreame/MOVA.
   * Captured/reference payload: { m:'a', p:0, o:400, d:{ on:true|false } }.
   */
  setVideoEnabled(did, enabled) {
    return this.sendAction(did, 2, 50, [{ m: 'a', p: 0, o: 400, d: { on: !!enabled } }]);
  }

  /**
   * Fetch the Tencent XP2P provisioning inputs used by the official mower app.
   * Source/reference: Dreame Home TX-video endpoints confirmed by the public
   * Home Assistant mower implementation. Sensitive values are returned to the
   * caller only and must never be written to logs.
   */
  async getTxVideoRuntimeInputs(did, { allowPairRepair = false, identityTransportCheck = false, identityCloudDiagnostics = false } = {}) {
    await this._ensureAuth();

    const findText = (value, keys, depth = 0) => {
      if (value == null || depth > 8) return null;
      if (Array.isArray(value)) {
        for (const item of value) { const found = findText(item, keys, depth + 1); if (found) return found; }
        return null;
      }
      if (typeof value !== 'object') return null;
      for (const [k, v] of Object.entries(value)) {
        if (keys.includes(String(k).toLowerCase()) && (typeof v === 'string' || typeof v === 'number')) {
          const text = String(v).trim();
          if (text) return text;
        }
      }
      for (const v of Object.values(value)) { const found = findText(v, keys, depth + 1); if (found) return found; }
      return null;
    };

    const unwrap = (res, label) => {
      if (!res || (typeof res.code === 'number' && res.code !== 0)) {
        throw new Error(`${label} fehlgeschlagen${res?.code != null ? ` (${res.code})` : ''}`);
      }
      return res?.data ?? res;
    };

    const accessRaw = await this._request(VIDEO_TOKEN_PATH, videoTokenBody(), false, { videoProfile: true });
    const access = unwrap(accessRaw, 'TX-Video Zugriff');
    const accessToken = findText(access, ['accesstoken', 'token']);
    const accessUserId = findText(access, ['userid', 'user_id', 'uid']);

    let own = null;
    try {
      const devices = await this.getDevices();
      own = (devices || []).find((d) => String(d?.did) === String(did)) || null;
    } catch (_) {}

    // Match the reference's get_device_info_v2 first. The TX-token user ID is
    // an account identity, NOT automatically the device UID. Read-only request.
    let detailedInfo = null;
    let detailedInfoCode = null;
    try {
      const detailRaw = await this._request('/dreame-user-iot/iotuserbind/device/info', { did: String(did) });
      detailedInfoCode = Number.isInteger(detailRaw?.code) ? detailRaw.code : null;
      if (detailedInfoCode === 0) {
        const detail = detailRaw?.data?.data ?? detailRaw?.data;
        if (detail && typeof detail === 'object' && !Array.isArray(detail) &&
            (detail.did == null || String(detail.did) === String(did))) detailedInfo = detail;
      }
    } catch (_) { detailedInfoCode = -1; }
    this._log(`[video-xp2p] detailed device info code=${detailedInfoCode??'unknown'} uidPresent=${!!(detailedInfo?.uid)} modelPresent=${!!(detailedInfo?.model)}`);
    // Detailed device values take priority; the original device list remains
    // available for non-video display metadata and explicitly unverified fallbacks.
    const identityMetadata = { ...(own || {}), ...(detailedInfo || {}) };

    const uid = detailedInfo?.uid ?? own?.uid;
    const uidSource = detailedInfo?.uid != null ? 'device_info_uid'
      : (own?.uid != null ? 'device_list_uid' : 'missing');
    const model = detailedInfo?.model ?? own?.model ?? own?.deviceInfo?.model;
    // Build the native TX-video identity request from the already-authenticated
    // Dreame/MOVA session. The original Android TxRtcInfoReq serializer contains
    // exactly two fields: did + os, with the repository supplying os='android'.
    // TX/account context is carried by the DMHttpManager-style HTTP profile,
    // not by speculative uid/model/token fields in this JSON body.
    const responseCode = (value) => Number(value?.code ?? 0);
    const safeShape = (value) => ({
      code: Number.isSafeInteger(value?.code) ? value.code : null,
      success: value?.success === true ? true : (value?.success === false ? false : null),
      data: !!value?.data,
      messageClass: require('./identity_diagnostics').vendorMessageClass(value),
    });
    const ownerUid = [detailedInfo?.masterUid, own?.masterUid, detailedInfo?.master_uid, own?.master_uid]
      .find(value => (typeof value === 'string' || typeof value === 'number') && String(value).trim()) ?? null;
    const identityBody = videoIdentityBody(did);
    this._log(`[video-xp2p] native identity request prepared body=did+os(android) txToken=${!!accessToken} accountToken=${!!this._accessToken} ownerUidAvailable=${!!ownerUid} modelAvailable=${!!model} transport=android-dio-parity-v180 values=redacted`);
    this._log(`[video-xp2p] native transport profile basicAuth=true bearerAuth=${!!this._accessToken} appMeta=${this._brand==='dreame'} rlc=${this._brand==='dreame'&&!!this._makeDreameRlc()} bodySignature=not_applied_unverified hostSource=account_region values=redacted`);
    if (identityCloudDiagnostics) {
      // Exactly one canonical JSON identity query; owner UID experiments are
      // only available via the separately invoked identityTransportCheck.
      const { summarizeCloudReply, cloudEndpointContext, safeTransportError,
        summarizeEligibility } = require('./identity_diagnostics');
      const requestBody = identityBody;
      const uidSourceForRequest = ownerUid ? 'device_owner_master_uid' : 'missing';
      const observe = async (path, body) => {
        let httpStatus = null;
        try {
          const reply = await this._request(path, body, false,
            { videoProfile:true, onHttpStatus: status => { httpStatus = status; } });
          return { response:reply, summary:summarizeCloudReply(reply,httpStatus) };
        } catch (error) {
          return { response:null, summary:{...summarizeCloudReply(null,httpStatus),
            transportError:safeTransportError(error) } };
        }
      };
      const identityCheck = await observe(VIDEO_IDENTITY_PATH, requestBody);
      const p2pCheck = await observe('/dreame-third-video/tx/dev/getP2PInfo', {
        did:String(did), os:'android',
      });
      const associationCheck = await observe('/dreame-third-video/tx/dev/isDevUser', {
        did:String(did), os:'android',
      });
      const identityPayload = identityCheck.response?.data?.data ?? identityCheck.response?.data;
      const p2pPayload = p2pCheck.response?.data?.data ?? p2pCheck.response?.data;
      const identityAccepted = identityCheck.summary.httpStatus === 200 && identityCheck.summary.vendorCode === 0;
      const p2pAccepted = p2pCheck.summary.httpStatus === 200 && p2pCheck.summary.vendorCode === 0;
      return {
        mode:'read_only_cloud_identity_diagnostics_v858',
        reference:'original Android did+os body with reconstructed DMHttpManager header context; body signature remains unverified',
        requestShape:{ contentType:'application/json', tokenPresent:!!accessToken,
          uidSource:uidSourceForRequest, modelPresent:!!model,
          sameApiSession:true, requestCount:3 },
        context:cloudEndpointContext(this._brand,this._region,this._config.host,this._bindDomainFamily),
        identity:{...identityCheck.summary, fields:{
          productId:identityAccepted && !!findText(identityPayload,['productid','product_id','productkey','product_key']),
          deviceName:identityAccepted && !!findText(identityPayload,['devicename','device_name','devname','dev_name']),
          channelId:identityAccepted && !!findText(identityPayload,['channelid','channel_id','deviceid','device_id']),
          encryptedPair:identityAccepted && !!findText(identityPayload,['secretid','secret_id']) &&
            !!findText(identityPayload,['secretkey','secret_key']),
        }},
        p2p:{...p2pCheck.summary, p2pInfoPresent:p2pAccepted &&
          !!findText(p2pPayload,['p2pinfo','p2p_info','xp2pinfo','xp2p_info','initstringapp','apilicense'])},
        association:{...associationCheck.summary, associated:associationCheck.summary.httpStatus === 200 ? summarizeEligibility(associationCheck.response) : null},
        sdkStarted:false, cameraAction:false, paired:false, configChanged:false,
      };
    }
    if (identityTransportCheck) {
      // Read-only parity with the actual MOVA HA source. Its MOVA_STRINGS[8]
      // is "masterUid" and get_tx_video_device_identity() sends self._uid as
      // the `uid` parameter. The reference's effective Content-Type is JSON.
      // This is an OWNER UID, not a proven XP2P device name/channel ID.
      const path = VIDEO_IDENTITY_PATH;
      const baseBody = identityBody;
      const summarize = (response) => {
        const payload = response?.data?.data ?? response?.data;
        const ok = Number.isInteger(response?.code) && response.code === 0;
        return {
          code: Number.isInteger(response?.code) ? response.code : null,
          success: response?.success === true,
          productId: ok && !!findText(payload, ['productid', 'product_id', 'productkey', 'product_key']),
          deviceName: ok && !!findText(payload, ['devicename', 'device_name', 'devname', 'dev_name']),
          channelId: ok && !!findText(payload, ['channelid', 'channel_id', 'deviceid', 'device_id']),
          encryptedPair: ok && !!findText(payload, ['secretid', 'secret_id']) &&
            !!findText(payload, ['secretkey', 'secret_key']),
        };
      };
      const baseline = summarize(await this._request(path, baseBody, false, { videoProfile:true }));
      const withOwnerUid = null;
      // Never log or return owner UID, TX token, IDs, secrets or raw response.
      return {
        mode:'read_only_mova_master_uid_parity',
        contentType:'application/json',
        source:'mova_ha_reference_masterUid',
        inputPresence:{accessToken:!!accessToken, uidInBaseline:!!baseBody.uid,
          ownerUid:!!ownerUid, model:!!model},
        sameBaseRequest:true,
        baselineJson:baseline,
        ownerUidJson:withOwnerUid,
        ownerUidAttempted:!!withOwnerUid,
        sdkStarted:false, cameraAction:false, paired:false,
      };
    }
    // Mirror cloudBindDevice's safe first step: read the existing association
    // before getTxRtcInfo. Never repair/pair automatically. The real app would
    // enter a bind/share branch only when this check is false; Homey deliberately
    // stops there because pairing is a server-side mutation.
    let associationRaw = null;
    try {
      associationRaw = await this._request('/dreame-third-video/tx/dev/isDevUser',
        { did:String(did), os:'android' }, false, { videoProfile:true });
      const { summarizeEligibility } = require('./identity_diagnostics');
      const associated = responseCode(associationRaw) === 0 ? summarizeEligibility(associationRaw) : null;
      this._log(`[video-xp2p] association preflight code=${Number.isSafeInteger(associationRaw?.code) ? associationRaw.code : 'unknown'} associated=${associated === true ? 'true' : associated === false ? 'false' : 'unknown'} values=redacted`);
      if (associated === false) {
        throw new Error('TX-Video ist für dieses Konto nicht mit dem Gerät verknüpft; automatische Kopplung ist aus Sicherheitsgründen deaktiviert');
      }
    } catch (error) {
      if (/nicht mit dem Gerät verknüpft/.test(String(error?.message || ''))) throw error;
      this._log(`[video-xp2p] association preflight unavailable; continuing read-only identity path (${String(error?.message || 'unknown').slice(0,120)})`);
    }

    // One evidence-based native identity attempt only. No speculative body
    // variants, no implicit association repair and NO pairing.
    const identityRaw = await this._request(VIDEO_IDENTITY_PATH, identityBody, false, { videoProfile:true });
    if (responseCode(identityRaw) !== 0) {
      const { vendorMessageClass } = require('./identity_diagnostics');
      this._log(`[video-xp2p] native identity rejected code=${Number.isSafeInteger(identityRaw?.code) ? identityRaw.code : 'unknown'} messageClass=${vendorMessageClass(identityRaw)} transport=android-dio-parity-v180; no automatic pair/retry`);
    } else {
      this._log('[video-xp2p] native identity accepted transport=android-dio-parity-v180 values=redacted');
    }

    // P2P was already proven to work in the established Homey path. Keep its
    // request contract unchanged so the identity correction cannot regress it.
    const p2pRaw = await this._request('/dreame-third-video/tx/dev/getP2PInfo', {
      did: String(did), os: 1,
      ...(accessToken ? { accesstoken: accessToken, accessToken } : {}),
    });
    this._log(`[video-xp2p] P2P info ${JSON.stringify(safeShape(p2pRaw))}`);
    // Do not put arbitrary vendor object keys into ordinary video logs.
    const identity = responseCode(identityRaw) === 0 ? unwrap(identityRaw, 'TX-Video Identität') : {};
    const p2p = responseCode(p2pRaw) === 0 ? unwrap(p2pRaw, 'TX-Video P2P') : {};

    const identityChannelId = findText(identity, ['channelid', 'channel_id', 'deviceid', 'device_id', 'xp2pid', 'xp2p_id']);
    const p2pChannelId = findText(p2p, ['channelid', 'channel_id', 'deviceid', 'device_id', 'xp2pid', 'xp2p_id']);
    const channelId = identityChannelId || p2pChannelId;
    const cloudIdentityProductId = findText(identity, ['productid', 'product_id', 'productkey', 'product_key']);
    const identityProductId = cloudIdentityProductId
      || findText(p2p, ['productid', 'product_id', 'productkey', 'product_key']);
    const metadataProductId = findText(identityMetadata?.deviceInfo, ['productid', 'product_id', 'productkey', 'product_key']);
    const productId = identityProductId || metadataProductId;
    const cloudIdentityDeviceName = findText(identity, ['devicename', 'device_name', 'devname', 'dev_name']);
    const identityDeviceName = cloudIdentityDeviceName
      || findText(p2p, ['devicename', 'device_name', 'devname', 'dev_name']);
    // Generic mower-list SN/product fields are NOT proof that Tencent has
    // provisioned the device's video identity. In field logs getIdentity
    // returned code 10000 while getP2PInfo still returned a nonempty string.
    // Preserve both facts separately, rather than labeling the fallback as a
    // valid cloud video identity.
    const cloudIdentityCode = responseCode(identityRaw);
    const cloudIdentityReady = cloudIdentityCode === 0 &&
      !!cloudIdentityProductId && !!cloudIdentityDeviceName;

    // v37: keep Tencent's three identity roles separate. The Dreame reference
    // flow uses productId/deviceName as serviceId (startService +
    // setDeviceXp2pInfo) and a returned channelId/deviceId as delegateId for
    // postCommandRequestSync + delegateHttpFlv. Never manufacture channelId
    // from serviceId here; that was the v36 ambiguity.
    const valueAtPath = (obj, dottedPath) => {
      let cur = obj;
      for (const part of dottedPath.split('.')) {
        if (!cur || typeof cur !== 'object') return null;
        cur = cur[part];
      }
      if (cur == null || !['string', 'number'].includes(typeof cur)) return null;
      const text = String(cur).trim();
      return text || null;
    };
    const dedupeNamed = (entries) => {
      const seen = new Set();
      const result = [];
      for (const entry of entries) {
        const value = entry?.value == null ? '' : String(entry.value).trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.push({ source: entry.source, value });
      }
      return result;
    };

    const deviceNameCandidates = dedupeNamed([
      { source: 'cloud_identity_device_name', value: identityDeviceName },
      { source: 'device_info_device_name', value: detailedInfo?.deviceName ?? detailedInfo?.device_name },
      { source: 'metadata_device_name', value: own?.deviceName ?? own?.device_name ?? own?.devName ?? own?.dev_name },
      { source: 'metadata_deviceinfo_device_name', value: valueAtPath(own, 'deviceInfo.deviceName') ?? valueAtPath(own, 'deviceInfo.device_name') },
      { source: 'metadata_sn', value: own?.sn },
      { source: 'metadata_deviceinfo_sn', value: valueAtPath(own, 'deviceInfo.sn') ?? valueAtPath(own, 'deviceInfo.serialNumber') },
      { source: 'metadata_did', value: own?.did ?? did },
      { source: 'metadata_id', value: own?.id },
      { source: 'metadata_deviceinfo_device_id', value: valueAtPath(own, 'deviceInfo.deviceId') ?? valueAtPath(own, 'deviceInfo.device_id') },
    ]).slice(0, 8);
    const deviceName = deviceNameCandidates[0]?.value || null;

    // Delegate/channel candidates are independently sourced. serviceId fallback
    // is added later per deviceName candidate because it depends on productId.
    const delegateCandidates = dedupeNamed([
      { source: 'cloud_identity_channel', value: identityChannelId },
      { source: 'p2p_channel', value: p2pChannelId },
      { source: 'metadata_channel', value: own?.channelId ?? own?.channel_id ?? own?.deviceId ?? own?.device_id ?? own?.xp2pId ?? own?.xp2p_id },
      { source: 'metadata_deviceinfo_channel', value: valueAtPath(own, 'deviceInfo.channelId') ?? valueAtPath(own, 'deviceInfo.channel_id')
        ?? valueAtPath(own, 'deviceInfo.deviceId') ?? valueAtPath(own, 'deviceInfo.device_id') },
      { source: 'metadata_did', value: own?.did ?? did },
      { source: 'metadata_id', value: own?.id },
      { source: 'metadata_sn', value: own?.sn },
    ]).slice(0, 7);

    const secretId = findText(identity, ['secretid', 'secret_id']) || findText(p2p, ['secretid', 'secret_id']);
    const secretKey = findText(identity, ['secretkey', 'secret_key']) || findText(p2p, ['secretkey', 'secret_key']);
    const p2pInfo = findText(p2p, ['p2pinfo', 'p2p_info', 'xp2pinfo', 'xp2p_info', 'initstringapp', 'apilicense']);
    const appId = findText(identity, ['appid', 'app_id', 'appkey', 'app_key'])
      || findText(p2p, ['appid', 'app_id', 'appkey', 'app_key']);
    let appSecret = findText(identity, ['appsecret', 'app_secret', 'xp2p_secretkey', 'xp2p_secret_key'])
      || findText(p2p, ['appsecret', 'app_secret', 'xp2p_secretkey', 'xp2p_secret_key']);
    const { deriveTxVideoAppCredentials } = require('./video_credentials');
    const derived = deriveTxVideoAppCredentials(secretId, secretKey);
    const resolvedAppId = appId || derived.appId;
    appSecret = appSecret || derived.appSecret;
    this._log(`[video-xp2p] credential presence encryptedPair=${!!(secretId&&secretKey)} appPair=${!!(resolvedAppId&&appSecret)} derived=${!!(derived.appId&&derived.appSecret)} values=redacted`);

    // OAuth/MQTT uid and TX-access-token uid are account/user identities in
    // this client, not mower deviceName values. masterUid is used by this app
    // for history/owner scoping. Surface only their semantic presence so a
    // future capture can revisit this without leaking identifiers.
    const excludedIdentitySources = {
      mqttOauthUid: !!this.getUid(),
      txAccessUserId: !!accessUserId,
      masterUid: !!(own?.masterUid ?? own?.master_uid),
      reason: 'account_or_owner_identity_not_device_name',
    };

    this._log(`[video-xp2p-diag] field availability=${JSON.stringify({
      channelId: !!channelId,
      productId: !!productId,
      deviceName: !!deviceName,
      p2pInfo: !!p2pInfo,
      secretId: !!secretId,
      secretKey: !!secretKey,
      appId: !!resolvedAppId,
      appSecret: !!appSecret,
      productIdSource: identityProductId ? 'cloud_identity' : (metadataProductId ? 'device_metadata' : 'missing'),
      deviceNameSource: deviceNameCandidates[0]?.source || 'missing',
      deviceNameCandidateCount: deviceNameCandidates.length,
      delegateCandidateCount: delegateCandidates.length,
      modelMetadata: !!model,
      uidMetadata: uid != null && String(uid).length > 0,
      uidSource,
      excludedIdentitySources,
    })}`);
    if (!productId || !deviceName || !p2pInfo) {
      const identityCode = responseCode(identityRaw);
      const p2pCode = responseCode(p2pRaw);
      throw new Error(`TX-Video Geräteidentität nicht bereitgestellt (identity=${identityCode}, p2p=${p2pCode})`);
    }

    const matrix = [];
    const matrixSeen = new Set();
    const addMatrix = (deviceEntry, delegateEntry) => {
      const serviceId = `${productId}/${deviceEntry.value}`;
      const delegateId = delegateEntry?.value || serviceId;
      const delegateSource = delegateEntry?.source || 'service_id_fallback';
      const key = `${serviceId}\u0000${delegateId}`;
      if (matrixSeen.has(key) || matrix.length >= 12) return;
      matrixSeen.add(key);
      matrix.push({
        variant: `${deviceEntry.source}+${delegateSource}`,
        productId,
        deviceName: deviceEntry.value,
        serviceId,
        delegateId,
        deviceNameSource: deviceEntry.source,
        serviceIdSource: 'product_id/device_name',
        delegateIdSource: delegateSource,
      });
    };

    // v39: prioritize the Home Assistant/Tencent SDK fallback first:
    // serviceId = productId/deviceName and delegateId = serviceId. The v38
    // capture proved that metadata-derived delegate ids can reach ready but
    // then block in postCommandRequestSync, while HA intentionally falls back
    // to the service id when no real cloud channel id is returned. Keep the
    // bounded alternate matrix after the HA-parity candidates for diagnostics.
    if (identityChannelId && cloudIdentityReady && deviceNameCandidates.length)
      addMatrix(deviceNameCandidates[0], {source:'cloud_identity_channel',value:identityChannelId});
    for (const deviceEntry of deviceNameCandidates) addMatrix(deviceEntry, null);
    for (const deviceEntry of deviceNameCandidates) {
      for (const delegateEntry of delegateCandidates) addMatrix(deviceEntry, delegateEntry);
    }

    const first = matrix[0] || null;
    return {
      did: String(did), channelId, productId, deviceName, p2pInfo,
      secretId, secretKey, appId:resolvedAppId, appSecret,
      serviceId: first?.serviceId || `${productId}/${deviceName}`,
      delegateId: first?.delegateId || channelId || `${productId}/${deviceName}`,
      streamChannel: 0,
      identityCandidates: matrix,
      cloudIdentityCode,
      cloudIdentityReady,
      cloudIdentityFields: {
        productId: !!cloudIdentityProductId,
        deviceName: !!cloudIdentityDeviceName,
        channelId: !!identityChannelId,
        secretId: !!findText(identity, ['secretid', 'secret_id']),
        secretKey: !!findText(identity, ['secretkey', 'secret_key']),
      },
      excludedIdentitySources,
      accessTokenPresent: !!accessToken,
    };
  }


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
      throw new Error(`PRE read rejected (r=${out.r})`);
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
      try {
        const result = await this.sendAction(did, 2, 50, [payload]);
        const accepted = this._mapEditAccepted(result);
        const leg = { name, accepted, result, opcode: Number(payload?.o), taskAck: null };
        legs.push(leg);
        if (!accepted) {
          if (!firstError) firstError = new Error(`Map edit ${name} rejected`);
          return result;
        }
        if (waitForTask && waitTask && Number.isInteger(Number(payload?.o))) {
          try {
            const ack = await waitForTask(Number(payload.o), sentAt, Number(taskTimeouts[name]) || 4500);
            leg.taskAck = true;
            leg.task = ack || null;
          } catch (err) {
            leg.taskAck = false;
            leg.taskError = err.message;
            if (!firstError) firstError = new Error(`Map edit ${name} TASK confirmation timed out`);
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
