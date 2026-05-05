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
    host:      '.iot.dreame.tech',
    port:      13267,
    tenantId:  '000000',
    userAgent: 'Dreame_Smarthome/1.5.59 (iPhone; iOS 16.0; Scale/3.00)',
  },
  mova: {
    host:      '.iot.mova-tech.com',
    port:      13267,
    tenantId:  '000002',
    userAgent: 'Mova_Smarthome/1.5.59 (iPhone; iOS 16.0; Scale/3.00)',
  },
};

// Both brands share the same OAuth client credentials (from DREAME_STRINGS[5] / MOVA_STRINGS[5])
const BASIC_AUTH    = 'Basic ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg=';

const PASSWORD_SALT = 'RAylYC%fmSKp7%Tq';

// ─── Property identifiers [siid, piid] ────────────────────────────────────────
const PROP = {
  // Service 1 – device / firmware
  FIRMWARE_STATE:           [1, 2],
  BLUETOOTH:                [1, 53],

  // Service 2 – status & control
  STATUS:                   [2, 1],
  DEVICE_CODE:              [2, 2],
  MOWING_SPEED:             [2, 4],   // TODO: verify piid on real device
  BORDER_FIRST:             [2, 6],   // TODO: verify piid on real device
  OBSTACLE_AVOIDANCE:       [4, 21],  // Source: ioBroker.dreame (siid:4, piid:21)
  AI_DETECTION:             [4, 22],  // Source: ioBroker.dreame (siid:4, piid:22)
  SCHEDULING_TASK:          [2, 50],  // zone/edge/spot mowing payload + DND config
  SETTINGS_CFG:             [2, 51],  // CFG settings blob (device pushes full settings here)
  RAIN_PROTECTION:          [2, 112], // TODO: verify piid on real device
  NIGHT_MODE:               [2, 113], // TODO: verify piid on real device
  VOLUME:                   [2, 114], // TODO: verify piid on real device

  // Service 3 – battery
  BATTERY:                  [3, 1],
  CHARGING_STATUS:          [3, 2],
  RETURN_BATTERY_THRESHOLD: [3, 10],  // TODO: verify piid on real device
  RESUME_BATTERY_THRESHOLD: [3, 11],  // TODO: verify piid on real device

  // Service 4 – AutoSwitch settings (single JSON-string property, read + write)
  AUTO_SWITCH: [4, 50],
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
            try { resolve(JSON.parse(raw)); }
            catch { reject(new Error(`Invalid JSON from ${path}: ${raw.slice(0, 200)}`)); }
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
  }

  // ─── Device discovery ─────────────────────────────────────────────────────

  /**
   * Fetch current status for a single device from the device-list endpoint.
   * Used as a fallback for MOVA / v2-API devices that don't expose MiOT
   * properties via getDeviceData (those return a key-value object instead of
   * the expected siid:piid array).
   * Returns the matching device object, or null if not found.
   */
  async getDeviceStatus(did) {
    const devices = await this.getDevices();
    return devices.find((d) => String(d.did) === String(did)) || null;
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
      data: { did, id, method: 'action', params: { did, siid, aiid, in: params } },
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
   * @param {string[]} spotIds  Spot IDs from the MOVA/Dreame app map
   *
   * Note: the HA integration resolves spot IDs to XY map coordinates before
   * calling clean_spot(). Without map data, we pass IDs directly and hope
   * the device accepts them; otherwise falls back to full-area mowing.
   */
  async startSpotMowing(did, spotIds) {
    const ids = spotIds.map((id) => Number(id));

    // Attempt 1: app-action with op-code 103 (spot — unconfirmed)
    try {
      return await this.sendAction(did, 2, 50, [
        { m: 'a', p: 0, o: 103, d: { spots: ids } },
      ]);
    } catch { /* not supported */ }

    // Attempt 2: MiOT property write
    try {
      await this.setProperty(did, 2, 50, JSON.stringify({ type: 'spot', spots: ids }));
      return await this.startMowing(did);
    } catch { /* falls through */ }

    this._log('[api] startSpotMowing: spot selection not supported on this device — starting full-area mowing');
    return this.startMowing(did);
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
   * Set mowing speed.
   * @param {string} speed  'slow' | 'normal' | 'fast'
   * TODO: verify piid and value mapping on real device.
   */
  setMowingSpeed(did, speed) {
    const map = { slow: 0, normal: 1, fast: 2 };
    return this.setProperty(did, 2, 4, map[speed] ?? 1);
  }

  /**
   * Enable or disable border-first mowing (mow perimeter before main area).
   * TODO: verify piid on real device.
   */
  setBorderFirst(did, enabled) {
    return this.setProperty(did, 2, 6, enabled ? 1 : 0);
  }

  /**
   * Set obstacle avoidance sensitivity (0 = off, 1 = low, 2 = medium, 3 = high).
   * Source: ioBroker.dreame — siid:4, piid:21 (not siid:2, piid:7 as previously assumed).
   */
  setObstacleAvoidance(did, level) {
    return this.setProperty(did, 4, 21, Math.min(3, Math.max(0, level)));
  }

  /**
   * Set the mowing pattern.
   * @param {string} pattern  'zigzag' | 'checkerboard'
   * TODO: verify piid on real device.
   */
  setMowingPattern(did, pattern) {
    const map = { zigzag: 0, checkerboard: 1 };
    return this.setProperty(did, 2, 111, map[pattern] ?? 0);
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
   * Read consumable maintenance status (blades, brush, robot).
   * CFG key "CMS" — confirmed triggered by the "Verbrauchsmaterial & Wartung" screen.
   * Response format is unknown — raw result is exposed in the debug console.
   */
  async getCMS(did) {
    const data = await this.sendAction(did, 2, 50, [{ m: 'g', t: 'CMS' }]);
    return data?.result?.out?.[0] ?? null;
  }

  /**
   * Enable or disable night mode (reduced noise).
   * TODO: verify piid on real device.
   */
  setNightMode(did, enabled) {
    return this.setProperty(did, 2, 113, enabled ? 1 : 0);
  }

  /**
   * Set speaker volume (0–100).
   * Source: ioBroker.dreame — CFG key "VOL", numeric value 0–100.
   * setProperty(2,114) was a wrong guess; VOL goes through the CFG action channel.
   */
  setVolume(did, level) {
    return this._sendCFG(did, 'VOL', level);
  }

  /**
   * Set the blade cutting height in mm.
   * TODO: verify piid on real device.
   */
  setCuttingHeight(did, heightMm) {
    return this.setProperty(did, 2, 109, heightMm);
  }

  /**
   * Enable or disable auto-resume after mid-session recharge.
   * TODO: verify piid on real device.
   */
  setAutoResume(did, enabled) {
    return this.setProperty(did, 2, 110, enabled ? 1 : 0);
  }

  /**
   * Set battery return threshold (mower returns to dock when battery ≤ this %).
   * TODO: verify piid on real device.
   */
  setReturnBatteryThreshold(did, pct) {
    return this.setProperty(did, 3, 10, pct);
  }

  /**
   * Set battery resume threshold (mower resumes when battery ≥ this %).
   * TODO: verify piid on real device.
   */
  setResumeBatteryThreshold(did, pct) {
    return this.setProperty(did, 3, 11, pct);
  }

  // ─── CFG command system (siid:2, aiid:50) ────────────────────────────────
  //
  // The device stores certain settings as opaque blobs.
  // Reading:  poll property 2:51 → device returns full JSON blob.
  // Writing:  MiOT action siid:2, aiid:50 with in:[{m:'s', t:'KEY', d:{value:X}}].
  // Confirmed via ioBroker adapter source (TA2k/ioBroker.dreame).

  /** @private Send a CFG set action. */
  _sendCFG(did, key, value) {
    return this.sendAction(did, 2, 50, [{ m: 's', t: key, d: { value } }]);
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

  /** Volume (VOL): 0–100 */
  setVolume(did, volume) {
    return this._sendCFG(did, 'VOL', Math.round(volume));
  }

  /** Grass protection (PROT): 0=off, 1=on */
  setGrassProtection(did, enabled) {
    return this._sendCFG(did, 'PROT', enabled ? 1 : 0);
  }

  /** Anti-theft lock (STUN): 0=off, 1=on */
  setAntiTheft(did, enabled) {
    return this._sendCFG(did, 'STUN', enabled ? 1 : 0);
  }

  // ─── AutoSwitch settings (siid:4, piid:50) ───────────────────────────────
  //
  // AutoSwitch settings live in a single JSON property at siid:4, piid:50.
  // Writing: setProperty(4, 50, JSON.stringify({k:'KEY', v:0|1})).
  // Reading: poll 4:50 → parse JSON object with all AutoSwitch keys.
  // Confirmed via bhuebschen/dreame-mower + ioBroker adapter source.

  /** Collision avoidance (AutoSwitch LessColl): 0=off, 1=on */
  setCollisionAvoidance(did, enabled) {
    return this.setProperty(did, 4, 50, JSON.stringify({ k: 'LessColl', v: enabled ? 1 : 0 }));
  }

  /** Smart auto-charging (AutoSwitch SmartCharge): 0=off, 1=on */
  setAutoCharging(did, enabled) {
    return this.setProperty(did, 4, 50, JSON.stringify({ k: 'SmartCharge', v: enabled ? 1 : 0 }));
  }

  // ─── PRE settings (siid:2, aiid:50 with full 10-element array) ───────────
  //
  // PRE settings require read-modify-write of a 10-element array:
  //   Index 1 → mow mode (0=Standard, 1=Efficient)
  //   Index 2 → cutting height (mm)
  //   Index 5 → direction change (0=auto, 1=off)
  //   Index 8 → edge detection (0=off, 1=on)
  //   Index 9 → edge mowing (0=off, 1=on)
  // Caller must supply the current array (cached from last poll of 2:51).
  // Confirmed via ioBroker adapter source (TA2k/ioBroker.dreame).

  /** Write a full PRE config array back to the device. */
  setPREConfig(did, preArray) {
    return this._sendCFG(did, 'PRE', preArray);
  }

  /**
   * Set mow efficiency mode (index 1 of the PRE config array).
   * PRE requires read-modify-write — the caller must supply the current 10-element
   * array so that cutting height (index 2) and edge mowing (index 9) are preserved.
   * @param {number}   value     0 = Standard, 1 = Efficient
   * @param {number[]} preArray  Current PRE array (10 elements); defaults to all-zeros
   *                             if unavailable (safe only when no other PRE settings are set).
   */
  setEfficientMode(did, value, preArray = new Array(10).fill(0)) {
    const arr = [...preArray];
    arr[1] = value;
    return this._sendCFG(did, 'PRE', arr);
  }
}

MovaApi.PROP               = PROP;
MovaApi.DEFAULT_POLL_PROPS = DEFAULT_POLL_PROPS;

module.exports = MovaApi;
