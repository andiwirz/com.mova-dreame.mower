'use strict';

const https  = require('https');
const crypto = require('crypto');
const zlib   = require('zlib');

// Verified against HA integration: DREAME_STRINGS / MOVA_STRINGS decoded from base64+gzip.
// Both brands share the same Basic auth and password salt (confirmed from const.py).
// Dreame-Rlc is ONLY sent for the "cn" region — never for EU/US/etc.
// Dreame-Meta does NOT exist in the official client.
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

  _request(path, body, isForm = false) {
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
        // API requests use the bearer-style Dreame-Auth header
        headers['Dreame-Auth'] = this._accessToken;
        // Note: Dreame-Rlc is only sent for the "cn" region — omitted for EU/US/etc.
        // Note: Dreame-Meta does not exist in the official client.
      }

      const req = https.request(
        {
          hostname:           this._baseUrl,
          port:               this._port,
          path,
          method:             'POST',
          headers,
          rejectUnauthorized: false,
          timeout:            20000,
        },
        (res) => {
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
              //     quotes unescaped.  We strip it to "" — the field is never used.
              //
              //  2. "someField": ,   or   "someField": }
              //     Null-like values emitted without an explicit null literal.
              //     These are replaced with null.
              try {
                const sanitized = raw
                  .replace(/"property"\s*:\s*"\{[^}]*\}"(,?)/g, '"property": ""$1')
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
      // Mutex: coalesce concurrent refresh calls into one request
      if (!this._refreshPromise) {
        this._refreshPromise = this._doRefresh().finally(() => {
          this._refreshPromise = null;
        });
      }
      await this._refreshPromise;
    }
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
    return (d.page && d.page.records)
        || d.list || d.records || d.devices || d.items
        || (Array.isArray(d) ? d : []);
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
    const paramsLog = params.length ? ' in=' + JSON.stringify(params).slice(0, 120) : '';
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
  goToMaintenancePoint(did, mapIndex = 0) {
    return this.sendAction(did, 2, 50, [{ m: 'a', p: mapIndex, o: 109, d: { point: [1] } }]);
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
   * Write the full 19-element PRE config array to the device.
   * Callers must supply a complete array (reconstructed via _buildPREFromSettings)
   * with the desired field already modified — PRE[3]=efficientMode, PRE[4]=heightMm, etc.
   * @param {number[]} preArray  Complete 19-element PRE array
   */
  writePRE(did, preArray) {
    return this.sendAction(did, 2, 50, [{ t: 'PRE', d: preArray, m: 's' }]);
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
   * MAPI — dedicated map data API.
   * Returns the full map object (boundary, mowing areas, etc.) directly from
   * the device without relying on the chunk-based MAP.0 / MAP.1 properties.
   * Observed in HAR: { m:'g', t:'MAPI', d:{ idx:0 } }
   */
  async getMAPI(did, idx = 0) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'MAPI', d: { idx } }]);
    return data?.result?.out?.[0] ?? null;
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
          rejectUnauthorized: false,
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
