'use strict';

const Homey = require('homey');
const DreameApi = require('../../lib/DreameApi');

// siid:piid → mower_status enum
const STATUS_MAP = {
  0:  'idle',
  1:  'mowing',
  2:  'standby',
  3:  'paused',
  4:  'error',
  5:  'returning',
  6:  'charging',
  7:  'error',       // ioBroker: ERROR
  8:  'paused',      // ioBroker: RAINING_PAUSE
  9:  'idle',        // ioBroker: INITIALIZING
  10: 'returning',   // ioBroker: LEAVING_STATION
  11: 'mapping',
  12: 'mowing',      // ioBroker: BORDER_MOWING
  13: 'docked',
  14: 'updating',
  // Extended codes from bhuebschen/dreame-mower HA integration + ioBroker
  15: 'idle',        // ioBroker: RELOCATING (was 'returning')
  16: 'mowing',      // ioBroker: TASK_NAVIGATING (was 'idle')
  23: 'idle',        // REMOTE_CONTROL
  24: 'charging',    // SMART_CHARGING
  25: 'mowing',      // SECOND_CLEANING — second pass
  26: 'mowing',      // HUMAN_FOLLOWING
  27: 'mowing',      // SPOT_CLEANING
  29: 'idle',        // WAITING_FOR_TASK
  30: 'docked',      // STATION_CLEANING
  97: 'mowing',      // SHORTCUT
  98: 'idle',        // MONITORING
  99: 'idle',        // MONITORING_PAUSED
};

// siid:piid (3:2) → charging_status enum
const CHARGING_MAP = {
  0:  'not_docked',
  1:  'charging',
  2:  'not_charging',
  3:  'docked',
  5:  'returning',
  16: 'paused_cold',
};

// piid (2:4) → mowing_speed enum (TODO: verify values on real device)
const MOWING_SPEED_MAP = { 0: 'slow', 1: 'normal', 2: 'fast' };

// Device codes (2:2) that map to specific alarm states
// Based on antondaubert/dreame-mower HA integration (mower-specific codes)
const ERROR_TILT_CODES     = new Set([1]);        // TILTED
const ERROR_OBSTACLE_CODES = new Set([2, 37]);     // TRAPPED/stuck, PATH_IMPASSABLE
const ERROR_LIFT_CODES     = new Set([73]);         // ROBOT_LIFTED (A1/A1 Pro) / TOP_COVER_OPEN
const ERROR_RAIN_CODES     = new Set([56, 57, 58]); // BAD_WEATHER, RAIN_INTERRUPTED, RAIN_SUSPENDED

// Statuses that count as "home" for mowing-completed detection
const HOME_STATUSES = new Set(['idle', 'docked', 'charging', 'standby', 'updating']);

// ─── Versioned migrations ─────────────────────────────────────────────────────
const MIGRATIONS = [
  {
    key: 'capabilities_migrated_v1',
    caps: [
      'mower_status', 'mower_mode', 'mower_progress', 'charging_status',
      'measure_battery', 'alarm_generic', 'alarm_obstacle', 'alarm_tilt',
      'mower_task_status', 'consumable_blade', 'consumable_brush',
      'consumable_robot', 'child_lock', 'dnd_enabled', 'mower_pattern', 'mower_error_code',
    ],
  },
  {
    key: 'capabilities_migrated_v2',
    caps: [
      'alarm_lift', 'rain_protection', 'night_mode',
      'firmware_update', 'measure_area', 'measure_duration',
    ],
  },
  {
    key: 'capabilities_migrated_v3',
    caps: ['mowing_speed', 'meter_area_total', 'meter_time_total'],
  },
  {
    key: 'capabilities_migrated_v4',
    caps: [
      'frost_protection', 'grass_protection', 'anti_theft',
      'collision_avoidance', 'auto_charging', 'mow_efficiency', 'meter_count_total',
    ],
  },
];

class MowerDevice extends Homey.Device {

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onInit() {
    await this._migrate();

    this._api                  = null;
    this._pollTimer            = null;
    this._wasMowing            = false;
    this._sessionStartTime     = null;
    this._persistedTokenExpiry = 0;

    // Flow trigger cards
    this._trgStatusChanged    = this.homey.flow.getDeviceTriggerCard('mower_status_changed');
    this._trgChargingChanged  = this.homey.flow.getDeviceTriggerCard('charging_status_changed');
    this._trgMowingCompleted  = this.homey.flow.getDeviceTriggerCard('mowing_completed');
    this._trgError            = this.homey.flow.getDeviceTriggerCard('mower_error');
    this._trgDocked           = this.homey.flow.getDeviceTriggerCard('mower_docked');
    this._trgObstacle         = this.homey.flow.getDeviceTriggerCard('obstacle_detected');
    this._trgTilted           = this.homey.flow.getDeviceTriggerCard('mower_tilted');
    this._trgLifted           = this.homey.flow.getDeviceTriggerCard('mower_lifted');
    this._trgRainDetected     = this.homey.flow.getDeviceTriggerCard('rain_detected');
    this._trgFirmwareUpdate   = this.homey.flow.getDeviceTriggerCard('firmware_update_available');
    this._trgBatteryLow       = this.homey.flow.getDeviceTriggerCard('battery_low');
    this._trgConsumableLow    = this.homey.flow.getDeviceTriggerCard('consumable_low');

    // Capability listeners for setable capabilities
    this.registerCapabilityListener('mower_mode', async (mode) => {
      await this.setStoreValue('mowing_mode', mode);
    });

    this.registerCapabilityListener('mowing_speed', async (speed) => {
      await this._api.setMowingSpeed(this.getData().id, speed);
    });

    this.registerCapabilityListener('mower_pattern', async (pattern) => {
      await this._api.setMowingPattern(this.getData().id, pattern);
    });

    this.registerCapabilityListener('child_lock', async (enabled) => {
      await this._api.setChildLock(this.getData().id, enabled);
    });

    this.registerCapabilityListener('dnd_enabled', async (enabled) => {
      const did      = this.getData().id;
      const dndStart = this.getSetting('dnd_start');
      const dndEnd   = this.getSetting('dnd_end');
      if (dndStart && dndEnd) {
        await this._api.setDNDSchedule(did, enabled, dndStart, dndEnd);
      } else {
        await this._api.setDND(did, enabled);
      }
    });

    this.registerCapabilityListener('rain_protection', async (enabled) => {
      await this._api.setRainProtection(this.getData().id, enabled);
    });

    this.registerCapabilityListener('night_mode', async (enabled) => {
      await this._api.setNightMode(this.getData().id, enabled);
    });

    this.registerCapabilityListener('frost_protection', async (enabled) => {
      await this._api.setFrostProtection(this.getData().id, enabled);
    });

    this.registerCapabilityListener('grass_protection', async (enabled) => {
      await this._api.setGrassProtection(this.getData().id, enabled);
    });

    this.registerCapabilityListener('anti_theft', async (enabled) => {
      await this._api.setAntiTheft(this.getData().id, enabled);
    });

    this.registerCapabilityListener('collision_avoidance', async (enabled) => {
      await this._api.setCollisionAvoidance(this.getData().id, enabled);
    });

    this.registerCapabilityListener('auto_charging', async (enabled) => {
      await this._api.setAutoCharging(this.getData().id, enabled);
    });

    this.registerCapabilityListener('mow_efficiency', async (mode) => {
      const pre = await this._getPREArray();
      pre[1] = mode === 'efficient' ? 1 : 0;
      await this._api.setPREConfig(this.getData().id, pre);
      await this.setStoreValue('pre_cfg', pre);
    });

    await this._initApi();
    this._startPolling();
  }

  async onDeleted() {
    this._stopPolling();
  }

  async onSettings({ changedKeys, newSettings }) {
    if (changedKeys.includes('poll_interval')) {
      this._stopPolling();
      this._startPolling();
    }

    const did = this.getData().id;

    // Read-only fields: silently revert any accidental edits
    const readOnlyKeys = ['device_model'];
    if (changedKeys.some((k) => readOnlyKeys.includes(k))) {
      const model = await this.getStoreValue('model') || '';
      await this.setSettings({ device_model: model });
    }

    const heightKeys = ['cutting_height', 'cutting_height_min', 'cutting_height_max'];
    if (changedKeys.some((k) => heightKeys.includes(k))) {
      const min = newSettings.cutting_height_min;
      const max = newSettings.cutting_height_max;
      const val = newSettings.cutting_height;

      if (min >= max) {
        throw new Error(this.homey.__('error.cutting_height_range'));
      }
      if (val < min || val > max) {
        throw new Error(this.homey.__('error.cutting_height_bounds', { min, max }));
      }

      if (changedKeys.includes('cutting_height')) {
        await this._api.setCuttingHeight(did, val)
          .catch((e) => this.error('setCuttingHeight:', e.message));
      }
    }

    if (changedKeys.includes('auto_resume')) {
      await this._api.setAutoResume(did, newSettings.auto_resume)
        .catch((e) => this.error('setAutoResume:', e.message));
    }

    if (changedKeys.includes('border_first')) {
      await this._api.setBorderFirst(did, newSettings.border_first)
        .catch((e) => this.error('setBorderFirst:', e.message));
    }

    if (changedKeys.includes('obstacle_avoidance')) {
      await this._api.setObstacleAvoidance(did, newSettings.obstacle_avoidance)
        .catch((e) => this.error('setObstacleAvoidance:', e.message));
    }

    if (changedKeys.includes('return_battery_threshold')) {
      await this._api.setReturnBatteryThreshold(did, newSettings.return_battery_threshold)
        .catch((e) => this.error('setReturnBatteryThreshold:', e.message));
    }

    if (changedKeys.includes('resume_battery_threshold')) {
      await this._api.setResumeBatteryThreshold(did, newSettings.resume_battery_threshold)
        .catch((e) => this.error('setResumeBatteryThreshold:', e.message));
    }

    if (changedKeys.includes('volume')) {
      await this._api.setVolume(did, newSettings.volume)
        .catch((e) => this.error('setVolume:', e.message));
    }

    if (changedKeys.includes('dnd_start') || changedKeys.includes('dnd_end')) {
      const enabled = this.getCapabilityValue('dnd_enabled') || false;
      await this._api.setDNDSchedule(did, enabled, newSettings.dnd_start, newSettings.dnd_end)
        .catch((e) => this.error('setDNDSchedule:', e.message));
    }

    if (changedKeys.includes('edge_mowing')) {
      const pre = await this._getPREArray();
      pre[9] = newSettings.edge_mowing ? 1 : 0;
      await this._api.setPREConfig(did, pre)
        .catch((e) => this.error('setPREConfig (edge_mowing):', e.message));
      await this.setStoreValue('pre_cfg', pre);
    }
  }

  // ─── Migration ─────────────────────────────────────────────────────────────

  async _migrate() {
    for (const { key, caps } of MIGRATIONS) {
      if (await this.getStoreValue(key)) continue;
      for (const cap of caps) {
        if (!this.hasCapability(cap)) {
          await this.addCapability(cap).catch((e) => this.error('addCapability', cap, e.message));
        }
      }
      await this.setStoreValue(key, true);
    }
  }

  // ─── API ──────────────────────────────────────────────────────────────────

  async _initApi() {
    const brand  = await this.getStoreValue('brand')  || this.getSetting('brand')  || 'dreame';
    const region = await this.getStoreValue('region') || this.getSetting('region') || 'eu';

    this._api = new DreameApi({ brand, region });

    const accessToken  = await this.getStoreValue('access_token');
    const refreshToken = await this.getStoreValue('refresh_token');
    const tokenExpiry  = await this.getStoreValue('token_expiry') || 0;

    if (accessToken && refreshToken) {
      this._api.setTokens({ accessToken, refreshToken, tokenExpiry });
      this._persistedTokenExpiry = tokenExpiry;
    }

    // Populate read-only device model setting from store
    const model = await this.getStoreValue('model');
    if (model) {
      await this.setSettings({ device_model: model }).catch(() => {});
    }
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  _startPolling() {
    const ms = (this.getSetting('poll_interval') || 30) * 1000;
    this._poll().catch((e) => this.error('Initial poll:', e.message));
    this._pollTimer = this.homey.setInterval(
      () => this._poll().catch((e) => this.error('Poll:', e.message)),
      ms,
    );
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    const did = this.getData().id;
    let props;

    try {
      props = await this._api.getProperties(did);
    } catch (err) {
      this.error('getProperties:', err.message);
      if (err.message === 'Device offline') {
        await this.setUnavailable(this.homey.__('error.device_offline'));
      } else if (err.message.includes('Auth failed') || err.message.includes('No refresh token')) {
        await this.setUnavailable(this.homey.__('error.auth_failed'));
      } else {
        await this.setUnavailable(this.homey.__('error.unreachable'));
      }
      return;
    }

    // Persist refreshed tokens only when they actually changed (saves ~6,900 store writes/day)
    const tk = this._api.getTokens();
    if (tk.tokenExpiry !== this._persistedTokenExpiry) {
      await this.setStoreValue('access_token',  tk.accessToken);
      await this.setStoreValue('refresh_token', tk.refreshToken);
      await this.setStoreValue('token_expiry',  tk.tokenExpiry);
      this._persistedTokenExpiry = tk.tokenExpiry;
    }

    await this._applyProperties(props);

    if (!this.getAvailable()) await this.setAvailable();
  }

  // ─── Property → capability mapping ────────────────────────────────────────

  async _applyProperties(props) {
    const val = {};
    for (const p of props) {
      if (p && p.code === 0) val[`${p.siid}:${p.piid}`] = p.value;
    }

    if (val['1:2']   !== undefined) await this._applyFirmwareState(val['1:2']);
    if (val['3:1']   !== undefined) await this._applyBattery(val['3:1']);
    if (val['3:2']   !== undefined) await this._applyChargingStatus(val['3:2']);
    if (val['2:1']   !== undefined) await this._applyStatus(val['2:1']);
    if (val['2:2']   !== undefined) await this._applyErrorCode(val['2:2']);
    if (val['2:4']   !== undefined) await this._applyMowingSpeed(val['2:4']);
    if (val['1:4']   !== undefined) await this._applyProgress(val['1:4']);
    if (val['5:104'] !== undefined) await this._applyTaskStatus(val['5:104']);
    if (val['2:112'] !== undefined) await this._applyBoolCap('rain_protection', val['2:112']);
    if (val['2:113'] !== undefined) await this._applyBoolCap('night_mode', val['2:113']);

    if (val['2:51'] !== undefined) await this._applyCfg(val['2:51']);
    if (val['4:50'] !== undefined) await this._applyAutoSwitch(val['4:50']);

    await this._applyConsumable('blade', val['5:105']);
    await this._applyConsumable('brush', val['5:106']);
    await this._applyConsumable('robot', val['5:107']);

    await this._applyTotalStats(val['12:4'], val['12:2']);
    if (val['12:1'] !== undefined) await this._applyTotalCount(val['12:1']);

    // Update session duration counter while mowing is active
    if (this._wasMowing && this._sessionStartTime !== null) {
      const mins = Math.floor((Date.now() - this._sessionStartTime) / 60000);
      if (this.getCapabilityValue('measure_duration') !== mins) {
        await this.setCapabilityValue('measure_duration', mins);
      }
    }
  }

  async _applyFirmwareState(state) {
    // State 0 = up-to-date, 1 = update available (TODO: verify on real device)
    const updateAvailable = state === 1;
    const prev = this.getCapabilityValue('firmware_update');
    if (prev === updateAvailable) return;
    await this.setCapabilityValue('firmware_update', updateAvailable);
    if (updateAvailable && !prev) {
      this._trgFirmwareUpdate.trigger(this, {}, {})
        .catch((e) => this.error('firmware_update_available trigger:', e.message));
    }
  }

  async _applyBoolCap(capId, value) {
    const bool = value === 1 || value === true;
    if (this.getCapabilityValue(capId) === bool) return;
    await this.setCapabilityValue(capId, bool);
  }

  async _applyMowingSpeed(raw) {
    const speed = MOWING_SPEED_MAP[raw] ?? 'normal';
    if (this.getCapabilityValue('mowing_speed') === speed) return;
    await this.setCapabilityValue('mowing_speed', speed);
  }

  async _applyTotalStats(rawArea, rawMinutes) {
    if (rawArea != null) {
      const area = Math.round(rawArea);
      if (this.getCapabilityValue('meter_area_total') !== area) {
        await this.setCapabilityValue('meter_area_total', area);
      }
    }
    if (rawMinutes != null) {
      // Convert minutes to hours, 1 decimal place
      const hours = Math.round(rawMinutes / 6) / 10;
      if (this.getCapabilityValue('meter_time_total') !== hours) {
        await this.setCapabilityValue('meter_time_total', hours);
      }
    }
  }

  async _applyCfg(raw) {
    // Property 2:51 — device pushes full settings JSON when anything changes.
    // CFG blob contains: FDP (frost), PROT (grass), STUN (anti-theft), PRE (array).
    // AutoSwitch (collision, auto-charging) is in siid:4, piid:50 — handled separately.
    let cfg = {};
    if (typeof raw === 'string') {
      try { cfg = JSON.parse(raw); } catch { return; }
    } else if (raw !== null && typeof raw === 'object') {
      cfg = raw;
    }

    if (cfg.FDP  != null) await this._applyBoolCap('frost_protection', cfg.FDP);
    if (cfg.PROT != null) await this._applyBoolCap('grass_protection', cfg.PROT);
    if (cfg.STUN != null) await this._applyBoolCap('anti_theft',       cfg.STUN);

    // PRE is a 10-element array; cache it for read-modify-write on capability changes.
    // Index 1 = mow mode, Index 2 = cutting height, Index 9 = edge mowing.
    if (Array.isArray(cfg.PRE)) {
      await this.setStoreValue('pre_cfg', cfg.PRE).catch(() => {});
      const mowMode = cfg.PRE[1];
      if (mowMode != null) {
        const mode = mowMode === 1 ? 'efficient' : 'standard';
        if (this.getCapabilityValue('mow_efficiency') !== mode) {
          await this.setCapabilityValue('mow_efficiency', mode);
        }
      }
      const edgeMowing = cfg.PRE[9];
      if (edgeMowing != null) {
        await this.setSettings({ edge_mowing: edgeMowing === 1 }).catch(() => {});
      }
    }
  }

  async _applyAutoSwitch(raw) {
    // Property 4:50 — AutoSwitch settings JSON (collision avoidance, smart charging, etc.)
    // Written as {k:'LessColl', v:0|1}; read back as full object {LessColl:0, SmartCharge:1, ...}
    let sw = {};
    if (typeof raw === 'string') {
      try { sw = JSON.parse(raw); } catch { return; }
    } else if (raw !== null && typeof raw === 'object') {
      sw = raw;
    }
    if (sw.LessColl    != null) await this._applyBoolCap('collision_avoidance', sw.LessColl);
    if (sw.SmartCharge != null) await this._applyBoolCap('auto_charging',       sw.SmartCharge);
  }

  /** Return the cached PRE array, falling back to a zeroed 10-element array. */
  async _getPREArray() {
    const cached = await this.getStoreValue('pre_cfg');
    return Array.isArray(cached) ? [...cached] : new Array(10).fill(0);
  }

  async _applyTotalCount(raw) {
    if (raw == null) return;
    const count = Math.round(raw);
    if (this.getCapabilityValue('meter_count_total') !== count) {
      await this.setCapabilityValue('meter_count_total', count);
    }
  }

  async _applyBattery(pct) {
    const prev = this.getCapabilityValue('measure_battery');
    await this.setCapabilityValue('measure_battery', pct);
    // Fire on any decrease — run-listener in driver.js applies the user-configured threshold
    if (prev !== null && pct < prev) {
      this._trgBatteryLow.trigger(this, {}, {})
        .catch((e) => this.error('battery_low trigger:', e.message));
    }
  }

  async _applyChargingStatus(code) {
    const status = CHARGING_MAP[code] ?? 'not_docked';
    const prev   = this.getCapabilityValue('charging_status');
    if (status === prev) return;
    await this.setCapabilityValue('charging_status', status);
    this._trgChargingChanged
      .trigger(this, { status }, {})
      .catch((e) => this.error('charging_status_changed trigger:', e.message));
  }

  async _applyStatus(code) {
    const status = STATUS_MAP[code] ?? 'idle';
    const prev   = this.getCapabilityValue('mower_status');
    if (status === prev) return;

    await this.setCapabilityValue('mower_status', status);

    this._trgStatusChanged
      .trigger(this, { status }, {})
      .catch((e) => this.error('status_changed trigger:', e.message));

    // Session duration tracking
    const isMowing = status === 'mowing';
    if (isMowing && !this._wasMowing) {
      this._sessionStartTime = Date.now();
      if (this.hasCapability('measure_duration')) {
        await this.setCapabilityValue('measure_duration', 0);
      }
    }

    // Error alarm
    const isError = status === 'error';
    await this.setCapabilityValue('alarm_generic', isError);
    if (isError) {
      const errorCode = this.getCapabilityValue('mower_error_code') || 0;
      const errorDesc = this._getErrorDescription(errorCode);
      this._trgError
        .trigger(this, { error_code: errorCode, error_description: errorDesc }, {})
        .catch((e) => this.error('mower_error trigger:', e.message));
    }

    // Docked trigger
    if (status === 'docked' || status === 'charging') {
      this._trgDocked.trigger(this, {}, {})
        .catch((e) => this.error('mower_docked trigger:', e.message));
    }

    // Mowing completed: was mowing → now home
    if (this._wasMowing && HOME_STATUSES.has(status)) {
      this._trgMowingCompleted.trigger(this, {}, {})
        .catch((e) => this.error('mowing_completed trigger:', e.message));
    }

    this._wasMowing = isMowing;
  }

  async _applyErrorCode(code) {
    const prevCode = this.getCapabilityValue('mower_error_code') || 0;
    await this.setCapabilityValue('mower_error_code', code);

    const isTilted   = ERROR_TILT_CODES.has(code);
    const isObstacle = ERROR_OBSTACLE_CODES.has(code);
    const isLifted   = ERROR_LIFT_CODES.has(code);

    const prevTilted   = this.getCapabilityValue('alarm_tilt');
    const prevObstacle = this.getCapabilityValue('alarm_obstacle');
    const prevLifted   = this.getCapabilityValue('alarm_lift');

    await this.setCapabilityValue('alarm_tilt',     isTilted);
    await this.setCapabilityValue('alarm_obstacle',  isObstacle);
    await this.setCapabilityValue('alarm_lift',      isLifted);

    if (isTilted && !prevTilted) {
      this._trgTilted.trigger(this, {}, {})
        .catch((e) => this.error('mower_tilted trigger:', e.message));
    }
    if (isObstacle && !prevObstacle) {
      this._trgObstacle.trigger(this, {}, {})
        .catch((e) => this.error('obstacle_detected trigger:', e.message));
    }
    if (isLifted && !prevLifted) {
      this._trgLifted.trigger(this, {}, {})
        .catch((e) => this.error('mower_lifted trigger:', e.message));
    }
    if (ERROR_RAIN_CODES.has(code) && !ERROR_RAIN_CODES.has(prevCode)) {
      this._trgRainDetected.trigger(this, {}, {})
        .catch((e) => this.error('rain_detected trigger:', e.message));
    }
  }

  async _applyProgress(raw) {
    let pct = null;
    let areaSqm = null;

    if (typeof raw === 'number') {
      pct = raw;
    } else if (typeof raw === 'string') {
      try {
        const obj = JSON.parse(raw);
        if (obj.coverage_target != null) {
          pct = Math.round(obj.coverage_target * 100);
        } else if (obj.current_area_sqm != null && obj.total_area_sqm) {
          pct = Math.round((obj.current_area_sqm / obj.total_area_sqm) * 100);
        }
        if (obj.current_area_sqm != null) {
          areaSqm = Math.round(obj.current_area_sqm);
        }
      } catch { /* not JSON, ignore */ }
    }

    if (pct !== null) {
      const clamped = Math.min(100, Math.max(0, pct));
      if (this.getCapabilityValue('mower_progress') !== clamped) {
        await this.setCapabilityValue('mower_progress', clamped);
      }
    }
    if (areaSqm !== null && this.getCapabilityValue('measure_area') !== areaSqm) {
      await this.setCapabilityValue('measure_area', areaSqm);
    }
  }

  async _applyTaskStatus(raw) {
    let status = 'inactive';
    if (typeof raw === 'string') {
      try {
        const obj = JSON.parse(raw);
        if (obj.execution_active)                          status = 'active';
        else if (obj.task_active && !obj.execution_active) status = 'paused';
        else if (obj.recharging)                           status = 'recharging';
      } catch { /* not JSON */ }
    } else if (typeof raw === 'number') {
      const numMap = { 1: 'active', 2: 'paused', 3: 'recharging', 4: 'inactive' };
      status = numMap[raw] || 'inactive';
    }
    if (this.getCapabilityValue('mower_task_status') === status) return;
    await this.setCapabilityValue('mower_task_status', status);
  }

  async _applyConsumable(item, usedMinutes) {
    if (usedMinutes == null) return;
    const pct = DreameApi.consumablePercent(usedMinutes, item);
    if (pct === null) return;

    const capId = `consumable_${item}`;
    const prev  = this.getCapabilityValue(capId);
    await this.setCapabilityValue(capId, pct);

    if (prev !== null && pct < prev) {
      this._trgConsumableLow
        .trigger(this, { consumable: item }, {})
        .catch((e) => this.error('consumable_low trigger:', e.message));
    }
  }

  // ─── Error description helper ──────────────────────────────────────────────

  _getErrorDescription(code) {
    const key  = `error_codes.${code}`;
    const desc = this.homey.__(key);
    if (!desc || desc === key) {
      return this.homey.__('error_codes.unknown').replace('__code__', code);
    }
    return desc;
  }

  // ─── Shared mowing state helper ───────────────────────────────────────────

  async _setMowingStarted() {
    await this.setCapabilityValue('mower_status', 'mowing');
    if (!this._wasMowing) {
      this._sessionStartTime = Date.now();
      if (this.hasCapability('measure_duration')) {
        await this.setCapabilityValue('measure_duration', 0);
      }
    }
    this._wasMowing = true;
  }

  // ─── Public commands (called by flow cards) ────────────────────────────────

  async cmdStartMowing() {
    const did  = this.getData().id;
    const mode = await this.getStoreValue('mowing_mode') || 'all_area';

    switch (mode) {
      case 'edge':
        await this._api.startEdgeMowing(did);
        break;
      case 'zone': {
        const ids = (await this.getStoreValue('mowing_zone_ids')) || [];
        await this._api.startZoneMowing(did, ids);
        break;
      }
      case 'spot': {
        const ids = (await this.getStoreValue('mowing_spot_ids')) || [];
        await this._api.startSpotMowing(did, ids);
        break;
      }
      case 'manual':
        await this._api.startManualMowing(did);
        break;
      default:
        await this._api.startMowing(did);
    }

    await this._setMowingStarted();
  }

  async cmdStartZoneMowing(zonesStr, passes = 1) {
    const did     = this.getData().id;
    const zoneIds = zonesStr.split(',').map((s) => s.trim()).filter(Boolean);
    await this.setStoreValue('mowing_zone_ids', zoneIds);
    await this.setCapabilityValue('mower_mode', 'zone');
    await this._api.startZoneMowing(did, zoneIds, passes);
    await this._setMowingStarted();
  }

  async cmdStartEdgeMowing() {
    const did = this.getData().id;
    await this.setCapabilityValue('mower_mode', 'edge');
    await this._api.startEdgeMowing(did);
    await this._setMowingStarted();
  }

  async cmdStartSpotMowing(spotsStr) {
    const did     = this.getData().id;
    const spotIds = spotsStr.split(',').map((s) => s.trim()).filter(Boolean);
    await this.setStoreValue('mowing_spot_ids', spotIds);
    await this.setCapabilityValue('mower_mode', 'spot');
    await this._api.startSpotMowing(did, spotIds);
    await this._setMowingStarted();
  }

  async cmdPause() {
    await this._api.pause(this.getData().id);
    await this.setCapabilityValue('mower_status', 'paused');
  }

  async cmdStop() {
    await this._api.stopMowing(this.getData().id);
  }

  async cmdDock() {
    await this._api.dock(this.getData().id);
    await this.setCapabilityValue('mower_status', 'returning');
  }

  async cmdFindBot()       { await this._api.findBot(this.getData().id); }
  async cmdSuppressFault() { await this._api.suppressFault(this.getData().id); }

  async cmdSetMowingMode(mode) {
    await this.setCapabilityValue('mower_mode', mode);
    await this.setStoreValue('mowing_mode', mode);
  }

  async cmdSetMowingSpeed(speed) {
    await this._api.setMowingSpeed(this.getData().id, speed);
    await this.setCapabilityValue('mowing_speed', speed);
  }

  async cmdResetConsumable(item) {
    await this._api.resetConsumable(this.getData().id, item);
    await this.setCapabilityValue(`consumable_${item}`, 100);
  }

  async cmdSetChildLock(enabled) {
    await this._api.setChildLock(this.getData().id, enabled);
    await this.setCapabilityValue('child_lock', enabled);
  }

  async cmdSetDND(enabled) {
    await this._api.setDND(this.getData().id, enabled);
    await this.setCapabilityValue('dnd_enabled', enabled);
  }

  async cmdSetMowingPattern(pattern) {
    await this._api.setMowingPattern(this.getData().id, pattern);
    await this.setCapabilityValue('mower_pattern', pattern);
  }

  async cmdSetRainProtection(enabled) {
    await this._api.setRainProtection(this.getData().id, enabled);
    await this.setCapabilityValue('rain_protection', enabled);
  }

  async cmdSetNightMode(enabled) {
    await this._api.setNightMode(this.getData().id, enabled);
    await this.setCapabilityValue('night_mode', enabled);
  }

  // ─── Debug API (called by settings/index.html via api.js) ─────────────────

  async getDebugPollData() {
    const did   = this.getData().id;
    const props = await this._api.getProperties(did);
    return {
      timestamp:  new Date().toISOString(),
      deviceId:   did,
      deviceName: this.getName(),
      model:      this.getSetting('device_model') || '',
      available:  this.getAvailable(),
      properties: props,
    };
  }
}

module.exports = MowerDevice;
