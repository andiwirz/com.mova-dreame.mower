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
  11: 'mapping',
  13: 'docked',
  14: 'updating',
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

// Error codes (2:2) that map to specific alarm states
const ERROR_TILT_CODES     = new Set([1]);
const ERROR_OBSTACLE_CODES = new Set([2, 12]);

// Statuses that count as "home" for mowing-completed detection
const HOME_STATUSES = new Set(['idle', 'docked', 'charging', 'standby', 'updating']);

// Capabilities added in v1.0.0 that must be migrated onto existing installs
const REQUIRED_CAPABILITIES = [
  'mower_status',
  'mower_mode',
  'mower_progress',
  'charging_status',
  'measure_battery',
  'alarm_generic',
  'alarm_obstacle',
  'alarm_tilt',
  'mower_task_status',
  'consumable_blade',
  'consumable_brush',
  'consumable_robot',
  'child_lock',
  'dnd_enabled',
  'mower_error_code',
];

class MowerDevice extends Homey.Device {

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onInit() {
    await this._migrate();

    this._api        = null;
    this._pollTimer  = null;
    this._wasMowing  = false;
    this._lowBatteryAlerted = false;

    // Consumable low alert state per item
    this._consumableLowAlerted = { blade: false, brush: false, robot: false };

    // Flow trigger cards
    this._trgStatusChanged    = this.homey.flow.getDeviceTriggerCard('mower_status_changed');
    this._trgChargingChanged  = this.homey.flow.getDeviceTriggerCard('charging_status_changed');
    this._trgMowingCompleted  = this.homey.flow.getDeviceTriggerCard('mowing_completed');
    this._trgError            = this.homey.flow.getDeviceTriggerCard('mower_error');
    this._trgDocked           = this.homey.flow.getDeviceTriggerCard('mower_docked');
    this._trgObstacle         = this.homey.flow.getDeviceTriggerCard('obstacle_detected');
    this._trgTilted           = this.homey.flow.getDeviceTriggerCard('mower_tilted');
    this._trgBatteryLow       = this.homey.flow.getDeviceTriggerCard('battery_low');
    this._trgConsumableLow    = this.homey.flow.getDeviceTriggerCard('consumable_low');

    // Capability listeners for setable capabilities
    this.registerCapabilityListener('mower_mode', async (mode) => {
      await this.setStoreValue('mowing_mode', mode);
    });

    this.registerCapabilityListener('child_lock', async (enabled) => {
      const did = this.getData().id;
      await this._api.setChildLock(did, enabled);
    });

    this.registerCapabilityListener('dnd_enabled', async (enabled) => {
      const did = this.getData().id;
      await this._api.setDND(did, enabled);
    });

    await this._initApi();
    this._startPolling();
  }

  async onDeleted() {
    this._stopPolling();
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this._stopPolling();
      this._startPolling();
    }
  }

  // ─── Migration ─────────────────────────────────────────────────────────────

  async _migrate() {
    for (const cap of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch((e) => this.error('addCapability', cap, e.message));
      }
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

    // Persist refreshed tokens
    const tk = this._api.getTokens();
    await this.setStoreValue('access_token', tk.accessToken);
    await this.setStoreValue('refresh_token', tk.refreshToken);
    await this.setStoreValue('token_expiry',  tk.tokenExpiry);

    await this._applyProperties(props);

    if (!this.getAvailable()) await this.setAvailable();
  }

  // ─── Property → capability mapping ────────────────────────────────────────

  async _applyProperties(props) {
    const val = {};
    for (const p of props) {
      if (p && p.code === 0) val[`${p.siid}:${p.piid}`] = p.value;
    }

    if (val['3:1'] !== undefined) await this._applyBattery(val['3:1']);
    if (val['3:2'] !== undefined) await this._applyChargingStatus(val['3:2']);
    if (val['2:1'] !== undefined) await this._applyStatus(val['2:1']);
    if (val['2:2'] !== undefined) await this._applyErrorCode(val['2:2']);
    if (val['1:4'] !== undefined) await this._applyProgress(val['1:4']);
    if (val['5:104'] !== undefined) await this._applyTaskStatus(val['5:104']);

    await this._applyConsumable('blade', val['5:105']);
    await this._applyConsumable('brush', val['5:106']);
    await this._applyConsumable('robot', val['5:107']);
  }

  async _applyBattery(pct) {
    await this.setCapabilityValue('measure_battery', pct);

    if (pct < 20 && !this._lowBatteryAlerted) {
      this._lowBatteryAlerted = true;
      this._trgBatteryLow
        .trigger(this, {}, { threshold: 20 })
        .catch((e) => this.error('battery_low trigger:', e.message));
    } else if (pct >= 20) {
      this._lowBatteryAlerted = false;
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

    // Error alarm
    const isError = status === 'error';
    await this.setCapabilityValue('alarm_generic', isError);
    if (isError) {
      const code = this.getCapabilityValue('mower_error_code') || 0;
      this._trgError
        .trigger(this, { error_code: code }, {})
        .catch((e) => this.error('mower_error trigger:', e.message));
    }

    // Docked trigger
    if (status === 'docked' || status === 'charging') {
      this._trgDocked
        .trigger(this, {}, {})
        .catch((e) => this.error('mower_docked trigger:', e.message));
    }

    // Mowing completed: was mowing → now home
    if (this._wasMowing && HOME_STATUSES.has(status)) {
      this._trgMowingCompleted
        .trigger(this, {}, {})
        .catch((e) => this.error('mowing_completed trigger:', e.message));
    }

    this._wasMowing = status === 'mowing';
  }

  async _applyErrorCode(code) {
    await this.setCapabilityValue('mower_error_code', code);

    // Derive binary alarms from error code
    const isTilted   = ERROR_TILT_CODES.has(code);
    const isObstacle = ERROR_OBSTACLE_CODES.has(code);

    const prevTilted   = this.getCapabilityValue('alarm_tilt');
    const prevObstacle = this.getCapabilityValue('alarm_obstacle');

    await this.setCapabilityValue('alarm_tilt',     isTilted);
    await this.setCapabilityValue('alarm_obstacle',  isObstacle);

    if (isTilted && !prevTilted) {
      this._trgTilted
        .trigger(this, {}, {})
        .catch((e) => this.error('mower_tilted trigger:', e.message));
    }

    if (isObstacle && !prevObstacle) {
      this._trgObstacle
        .trigger(this, {}, {})
        .catch((e) => this.error('obstacle_detected trigger:', e.message));
    }
  }

  async _applyProgress(raw) {
    // Property 1:4 (POSE_COVERAGE) may be a JSON string or a plain number
    let pct = null;
    if (typeof raw === 'number') {
      pct = Math.min(100, Math.max(0, raw));
    } else if (typeof raw === 'string') {
      try {
        const obj = JSON.parse(raw);
        if (obj.coverage_target != null) {
          pct = Math.round(obj.coverage_target * 100);
        } else if (obj.current_area_sqm != null && obj.total_area_sqm) {
          pct = Math.round((obj.current_area_sqm / obj.total_area_sqm) * 100);
        }
      } catch { /* not JSON, ignore */ }
    }
    if (pct !== null) {
      await this.setCapabilityValue('mower_progress', Math.min(100, Math.max(0, pct)));
    }
  }

  async _applyTaskStatus(raw) {
    // Property 5:104 may be a JSON object or a numeric status code
    let status = 'inactive';
    if (typeof raw === 'string') {
      try {
        const obj = JSON.parse(raw);
        if (obj.execution_active)                          status = 'active';
        else if (obj.task_active && !obj.execution_active) status = 'paused';
        else if (obj.recharging)                           status = 'recharging';
      } catch { /* not JSON */ }
    } else if (typeof raw === 'number') {
      // Fallback numeric mapping (varies by firmware)
      const numMap = { 1: 'active', 2: 'paused', 3: 'recharging', 4: 'inactive' };
      status = numMap[raw] || 'inactive';
    }
    await this.setCapabilityValue('mower_task_status', status);
  }

  async _applyConsumable(item, usedMinutes) {
    if (usedMinutes == null) return;
    const pct = DreameApi.consumablePercent(usedMinutes, item);
    if (pct === null) return;

    const capId = `consumable_${item}`;
    await this.setCapabilityValue(capId, pct);

    // consumable_low trigger
    const threshold = 20;
    const alerted   = this._consumableLowAlerted[item];
    if (pct < threshold && !alerted) {
      this._consumableLowAlerted[item] = true;
      this._trgConsumableLow
        .trigger(this, {}, { consumable: item, threshold })
        .catch((e) => this.error('consumable_low trigger:', e.message));
    } else if (pct >= threshold) {
      this._consumableLowAlerted[item] = false;
    }
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
      default:
        await this._api.startMowing(did);
    }

    await this.setCapabilityValue('mower_status', 'mowing');
    this._wasMowing = true;
  }

  async cmdStartZoneMowing(zonesStr) {
    const did     = this.getData().id;
    const zoneIds = zonesStr.split(',').map((s) => s.trim()).filter(Boolean);
    await this.setStoreValue('mowing_zone_ids', zoneIds);
    await this.setCapabilityValue('mower_mode', 'zone');
    await this._api.startZoneMowing(did, zoneIds);
    await this.setCapabilityValue('mower_status', 'mowing');
    this._wasMowing = true;
  }

  async cmdStartEdgeMowing() {
    const did = this.getData().id;
    await this.setCapabilityValue('mower_mode', 'edge');
    await this._api.startEdgeMowing(did);
    await this.setCapabilityValue('mower_status', 'mowing');
    this._wasMowing = true;
  }

  async cmdStartSpotMowing(spotsStr) {
    const did     = this.getData().id;
    const spotIds = spotsStr.split(',').map((s) => s.trim()).filter(Boolean);
    await this.setStoreValue('mowing_spot_ids', spotIds);
    await this.setCapabilityValue('mower_mode', 'spot');
    await this._api.startSpotMowing(did, spotIds);
    await this.setCapabilityValue('mower_status', 'mowing');
    this._wasMowing = true;
  }

  async cmdPause() {
    const did = this.getData().id;
    await this._api.pause(did);
    await this.setCapabilityValue('mower_status', 'paused');
  }

  async cmdStop() {
    const did = this.getData().id;
    await this._api.stopMowing(did);
  }

  async cmdDock() {
    const did = this.getData().id;
    await this._api.dock(did);
    await this.setCapabilityValue('mower_status', 'returning');
  }

  async cmdFindBot() {
    await this._api.findBot(this.getData().id);
  }

  async cmdSuppressFault() {
    await this._api.suppressFault(this.getData().id);
  }

  async cmdSetMowingMode(mode) {
    await this.setCapabilityValue('mower_mode', mode);
    await this.setStoreValue('mowing_mode', mode);
  }

  async cmdResetConsumable(item) {
    await this._api.resetConsumable(this.getData().id, item);
    await this.setCapabilityValue(`consumable_${item}`, 100);
    this._consumableLowAlerted[item] = false;
  }

  async cmdSetChildLock(enabled) {
    await this._api.setChildLock(this.getData().id, enabled);
    await this.setCapabilityValue('child_lock', enabled);
  }

  async cmdSetDND(enabled) {
    await this._api.setDND(this.getData().id, enabled);
    await this.setCapabilityValue('dnd_enabled', enabled);
  }
}

module.exports = MowerDevice;
