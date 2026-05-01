'use strict';

const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

// Decoded from DREAME_STRINGS / MOVA_STRINGS (base64+gzip) in the HA integration
const BRANDS = {
  dreame: {
    host: '.iot.dreame.tech',
    port: 13267,
    tenantId: '000000',
    userAgent: 'Dreame_Smarthome/1.5.59 (iPhone; iOS 16.0; Scale/3.00)',
  },
  mova: {
    host: '.iot.mova-tech.com',
    port: 13267,
    tenantId: '000002',
    userAgent: 'Mova_Smarthome/1.5.59 (iPhone; iOS 16.0; Scale/3.00)',
  },
};

const PASSWORD_SALT = 'RAylYC%fmSKp7%Tq';
const BASIC_AUTH    = 'Basic ZHJlYW1lX2FwcHYxOkFQXmR2QHpAU1FZVnhOODg=';

// ─── Property identifiers [siid, piid] ────────────────────────────────────────
const PROP = {
  // Service 1 – device / firmware
  FIRMWARE_STATE:           [1, 2],
  POSE_COVERAGE:            [1, 4],   // mowing progress + area (JSON object)
  BLUETOOTH:                [1, 53],

  // Service 2 – status & control
  STATUS:                   [2, 1],
  DEVICE_CODE:              [2, 2],
  MOWING_SPEED:             [2, 4],   // TODO: verify piid on real device
  BORDER_FIRST:             [2, 6],   // TODO: verify piid on real device
  OBSTACLE_AVOIDANCE:       [2, 7],   // TODO: verify piid on real device
  SCHEDULING_TASK:          [2, 50],  // zone/edge/spot mowing payload + DND config
  RAIN_PROTECTION:          [2, 112], // TODO: verify piid on real device
  NIGHT_MODE:               [2, 113], // TODO: verify piid on real device
  VOLUME:                   [2, 114], // TODO: verify piid on real device

  // Service 3 – battery
  BATTERY:                  [3, 1],
  CHARGING_STATUS:          [3, 2],
  RETURN_BATTERY_THRESHOLD: [3, 10],  // TODO: verify piid on real device
  RESUME_BATTERY_THRESHOLD: [3, 11],  // TODO: verify piid on real device

  // Service 5 – task & consumables
  TASK_STATUS:       [5, 104],
  // TODO: verify consumable property IDs – common Dreame pattern uses siid 13 or 11
  CONSUMABLE_BLADE:  [5, 105],  // used minutes – needs real-device verification
  CONSUMABLE_BRUSH:  [5, 106],  // used minutes – needs real-device verification
  CONSUMABLE_ROBOT:  [5, 107],  // used minutes – needs real-device verification

  // Service 2 – CFG settings blob (read-only from cloud; device pushes full settings here)
  SETTINGS_CFG: [2, 51],

  // Service 4 – AutoSwitch settings (single JSON-string property, read + write)
  AUTO_SWITCH: [4, 50],

  // Service 12 – lifetime statistics (confirmed by ioBroker adapter)
  TOTAL_COUNT: [12, 1],  // total mow session count (TODO: verify piid on real device)
  TOTAL_TIME:  [12, 2],  // total mowing time in minutes (lifetime)
  TOTAL_AREA:  [12, 4],  // total area mowed in m² (lifetime)
};

// Consumable total lifetimes in minutes (from antondaubert HA integration)
const CONSUMABLE_TOTAL_MIN = {
  blade: 6000,
  brush: 30000,
  robot: 3600,
};

// Properties polled every tick
const DEFAULT_POLL_PROPS = [
  PROP.FIRMWARE_STATE,
  PROP.STATUS,
  PROP.DEVICE_CODE,
  PROP.BATTERY,
  PROP.CHARGING_STATUS,
  PROP.POSE_COVERAGE,
  PROP.TASK_STATUS,
  PROP.MOWING_SPEED,
  PROP.RAIN_PROTECTION,
  PROP.NIGHT_MODE,
  PROP.SETTINGS_CFG,
  PROP.AUTO_SWITCH,
  PROP.CONSUMABLE_BLADE,
  PROP.CONSUMABLE_BRUSH,
  PROP.CONSUMABLE_ROBOT,
  PROP.TOTAL_COUNT,
  PROP.TOTAL_TIME,
  PROP.TOTAL_AREA,
];

class DreameApi {
  constructor({ brand = 'dreame', region = 'eu' } = {}) {
    this._brand    = brand;
    this._region   = region;
    this._config   = BRANDS[brand];
    if (!this._config) throw new Error(`Unknown brand: ${brand}`);

    this._baseUrl        = `${region}${this._config.host}`;
    this._port           = this._config.port;
    this._accessToken    = null;
    this._refreshToken   = null;
    this._tokenExpiry    = 0;
    this._username       = null;
    this._requestId      = 0;
    this._refreshPromise = null; // mutex: prevents concurrent refresh races
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
        headers['Authorization'] = BASIC_AUTH;
      } else {
        headers['Dreame-Auth'] = this._accessToken;
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

  async getDevices() {
    await this._ensureAuth();
    const res = await this._request('/dreame-user-iot/iotuserbind/device/listV2', {});
    if (res.code !== 0) throw new Error(`getDevices (${res.code}): ${res.msg}`);
    const d = res.data || {};
    return d.list || d.records || (Array.isArray(d) ? d : []);
  }

  // ─── Properties ───────────────────────────────────────────────────────────

  async getProperties(did, props = DEFAULT_POLL_PROPS) {
    await this._ensureAuth();
    const model = props.map(([siid, piid]) => ({ siid, piid }));
    const res   = await this._request('/dreame-user-iot/iotuserdata/getDeviceData', { did, model });
    if (res.code === 80001) throw new Error('Device offline');
    if (res.code !== 0)    throw new Error(`getProperties (${res.code}): ${res.msg}`);
    return Array.isArray(res.data) ? res.data : [];
  }

  async setProperty(did, siid, piid, value) {
    await this._ensureAuth();
    const res = await this._request('/dreame-user-iot/iotuserdata/setDeviceData', {
      did,
      model: [{ siid, piid, value }],
    });
    if (res.code === 80001) throw new Error('Device offline');
    if (res.code !== 0)    throw new Error(`setProperty (${res.code}): ${res.msg}`);
    return res.data;
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  async sendAction(did, siid, aiid, params = []) {
    await this._ensureAuth();
    this._requestId++;
    const id  = this._requestId;
    const res = await this._request('/dreame-iot-com/device/sendCommand', {
      did,
      id,
      data: { did, id, method: 'action', params: { did, siid, aiid, in: params } },
    });
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
   * TODO: verify exact payload format with a real device.
   */
  async startEdgeMowing(did) {
    await this.setProperty(did, 2, 50, JSON.stringify({ type: 'edge' }));
    return this.startMowing(did);
  }

  /**
   * Start zone mowing.
   * @param {string[]} zoneIds  Zone IDs (integers as strings)
   * @param {number}   passes   Number of mowing passes per zone (default 1)
   * TODO: verify payload format with a real device.
   */
  async startZoneMowing(did, zoneIds, passes = 1) {
    const payload = {
      type: 'zone',
      zones: zoneIds.map((id) => ({ id: Number(id) })),
      count: Math.max(1, Math.round(passes)),
    };
    await this.setProperty(did, 2, 50, JSON.stringify(payload));
    return this.startMowing(did);
  }

  /**
   * Start spot mowing.
   * @param {string[]} spotIds  Spot IDs (integers as strings)
   * TODO: verify payload format with a real device.
   */
  async startSpotMowing(did, spotIds) {
    const payload = { type: 'spot', spots: spotIds.map((id) => ({ id: Number(id) })) };
    await this.setProperty(did, 2, 50, JSON.stringify(payload));
    return this.startMowing(did);
  }

  // ─── Utility commands ─────────────────────────────────────────────────────

  /**
   * Emit audible alert to locate the mower.
   * TODO: verify siid:aiid on real device.
   */
  findBot(did) { return this.sendAction(did, 5, 5); }

  /**
   * Dismiss a recoverable fault so mowing can resume.
   * TODO: verify siid:aiid on real device.
   */
  suppressFault(did) { return this.sendAction(did, 5, 6); }

  // ─── Configuration writes ─────────────────────────────────────────────────

  /**
   * Toggle child/safety lock.
   * TODO: verify piid on real device.
   */
  setChildLock(did, enabled) {
    return this.setProperty(did, 2, 51, enabled ? 1 : 0);
  }

  /**
   * Toggle Do-Not-Disturb (simple on/off).
   * TODO: verify piid on real device.
   */
  setDND(did, enabled) {
    return this.setProperty(did, 2, 52, enabled ? 1 : 0);
  }

  /**
   * Set Do-Not-Disturb with a time window.
   * TODO: verify property ID and payload format on real device.
   */
  setDNDSchedule(did, enabled, startTime, endTime) {
    const payload = JSON.stringify({ enabled: enabled ? 1 : 0, start: startTime, end: endTime });
    return this.setProperty(did, 2, 52, payload);
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
   * TODO: verify piid and value range on real device.
   */
  setObstacleAvoidance(did, level) {
    return this.setProperty(did, 2, 7, Math.min(3, Math.max(0, level)));
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
   * Enable or disable rain protection.
   * TODO: verify piid on real device.
   */
  setRainProtection(did, enabled) {
    return this.setProperty(did, 2, 112, enabled ? 1 : 0);
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
   * TODO: verify piid on real device.
   */
  setVolume(did, level) {
    return this.setProperty(did, 2, 114, level);
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

  // ─── Consumable management ────────────────────────────────────────────────

  /**
   * Reset a consumable counter.
   * @param {string} item  'blade' | 'brush' | 'robot'
   * TODO: verify siid:aiid on real device.
   */
  resetConsumable(did, item) {
    const aiidMap = { blade: 10, brush: 11, robot: 12 };
    const aiid = aiidMap[item];
    if (!aiid) throw new Error(`Unknown consumable: ${item}`);
    return this.sendAction(did, 5, aiid);
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

  /** Frost protection (FDP): 0=off, 1=on */
  setFrostProtection(did, enabled) {
    return this._sendCFG(did, 'FDP', enabled ? 1 : 0);
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
   * Calculate consumable health percentage from used minutes.
   */
  static consumablePercent(usedMinutes, item) {
    const total = CONSUMABLE_TOTAL_MIN[item];
    if (!total || usedMinutes == null) return null;
    return Math.max(0, Math.round((1 - usedMinutes / total) * 100));
  }
}

DreameApi.PROP                  = PROP;
DreameApi.DEFAULT_POLL_PROPS    = DEFAULT_POLL_PROPS;
DreameApi.CONSUMABLE_TOTAL_MIN  = CONSUMABLE_TOTAL_MIN;

module.exports = DreameApi;
