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
  FIRMWARE_STATE:    [1, 2],
  POSE_COVERAGE:     [1, 4],   // mowing progress (JSON object)
  BLUETOOTH:         [1, 53],

  // Service 2 – status & control
  STATUS:            [2, 1],
  DEVICE_CODE:       [2, 2],
  SCHEDULING_TASK:   [2, 50],  // zone/edge/spot mowing payload + DND config

  // Service 3 – battery
  BATTERY:           [3, 1],
  CHARGING_STATUS:   [3, 2],

  // Service 5 – task
  TASK_STATUS:       [5, 104],
  // TODO: verify consumable property IDs – common Dreame pattern uses siid 13 or 11
  CONSUMABLE_BLADE:  [5, 105],  // used minutes – needs real-device verification
  CONSUMABLE_BRUSH:  [5, 106],  // used minutes – needs real-device verification
  CONSUMABLE_ROBOT:  [5, 107],  // used minutes – needs real-device verification
};

// Consumable total lifetimes in minutes (from antondaubert HA integration)
const CONSUMABLE_TOTAL_MIN = {
  blade: 6000,
  brush: 30000,
  robot: 3600,
};

// Properties polled every tick
const DEFAULT_POLL_PROPS = [
  PROP.STATUS,
  PROP.DEVICE_CODE,
  PROP.BATTERY,
  PROP.CHARGING_STATUS,
  PROP.POSE_COVERAGE,
  PROP.TASK_STATUS,
  PROP.CONSUMABLE_BLADE,
  PROP.CONSUMABLE_BRUSH,
  PROP.CONSUMABLE_ROBOT,
];

class DreameApi {
  constructor({ brand = 'dreame', region = 'eu' } = {}) {
    this._brand    = brand;
    this._region   = region;
    this._config   = BRANDS[brand];
    if (!this._config) throw new Error(`Unknown brand: ${brand}`);

    this._baseUrl      = `${region}${this._config.host}`;
    this._port         = this._config.port;
    this._accessToken  = null;
    this._refreshToken = null;
    this._tokenExpiry  = 0;
    this._username     = null;
    this._requestId    = 0;
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
      };

      headers['Tenant-Id'] = this._config.tenantId;
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
    if (Date.now() >= this._tokenExpiry - 120_000) await this._doRefresh();
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

  startMowing(did)   { return this.sendAction(did, 5, 1); }
  stopMowing(did)    { return this.sendAction(did, 5, 2); }
  dock(did)          { return this.sendAction(did, 5, 3); }
  pause(did)         { return this.sendAction(did, 5, 4); }

  /**
   * Start edge mowing (contour/perimeter).
   * Writes mowing task payload to SCHEDULING_TASK (2:50) then starts.
   */
  async startEdgeMowing(did) {
    // TODO: verify exact edge mowing payload format with a real device
    await this.setProperty(did, 2, 50, JSON.stringify({ type: 'edge' }));
    return this.startMowing(did);
  }

  /**
   * Start zone mowing.
   * @param {string[]} zoneIds  Array of zone IDs (integers)
   */
  async startZoneMowing(did, zoneIds) {
    // TODO: verify payload format with a real device
    const payload = { type: 'zone', zones: zoneIds.map((id) => ({ id: Number(id) })) };
    await this.setProperty(did, 2, 50, JSON.stringify(payload));
    return this.startMowing(did);
  }

  /**
   * Start spot mowing.
   * @param {string[]} spotIds  Array of spot IDs (integers)
   */
  async startSpotMowing(did, spotIds) {
    // TODO: verify payload format with a real device
    const payload = { type: 'spot', spots: spotIds.map((id) => ({ id: Number(id) })) };
    await this.setProperty(did, 2, 50, JSON.stringify(payload));
    return this.startMowing(did);
  }

  // ─── Utility commands ─────────────────────────────────────────────────────

  /**
   * Emit audible alert to locate the mower.
   * TODO: verify siid:aiid for find_bot on real device.
   */
  findBot(did) { return this.sendAction(did, 5, 5); }

  /**
   * Dismiss a recoverable fault so mowing can resume.
   * TODO: verify siid:aiid for suppress_fault on real device.
   */
  suppressFault(did) { return this.sendAction(did, 5, 6); }

  // ─── Configuration writes ─────────────────────────────────────────────────

  /**
   * Toggle child/safety lock.
   * TODO: verify property siid:piid for child lock on real device.
   */
  setChildLock(did, enabled) {
    return this.setProperty(did, 2, 51, enabled ? 1 : 0);
  }

  /**
   * Toggle Do-Not-Disturb mode.
   * Full DND config (start/end times) is written as JSON to SCHEDULING_TASK (2:50).
   * This simplified call only toggles the enabled flag.
   * TODO: verify property and payload format for DND on real device.
   */
  setDND(did, enabled) {
    return this.setProperty(did, 2, 52, enabled ? 1 : 0);
  }

  // ─── Consumable management ────────────────────────────────────────────────

  /**
   * Reset a consumable counter.
   * @param {string} item  'blade' | 'brush' | 'robot'
   * TODO: verify siid:aiid for consumable reset on real device.
   */
  resetConsumable(did, item) {
    const aiidMap = { blade: 10, brush: 11, robot: 12 };
    const aiid = aiidMap[item];
    if (!aiid) throw new Error(`Unknown consumable: ${item}`);
    return this.sendAction(did, 5, aiid);
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
