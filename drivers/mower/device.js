'use strict';

const Homey = require('homey');
const MovaApi = require('../../lib/MovaApi');

// latestStatus → mower_status enum
// Source: EvotecIT/homeassistant-dreamelawnmower types.py DreameMowerState enum
const STATUS_MAP = {
  1:  'mowing',         // MOWING
  2:  'idle',           // IDLE
  3:  'paused',         // PAUSED
  4:  'error',          // ERROR
  5:  'returning',      // RETURNING
  6:  'charging',       // CHARGING
  11: 'mapping',        // BUILDING (map building)
  13: 'docked',         // CHARGING_COMPLETED
  14: 'updating',       // UPGRADING
  15: 'mowing',         // CLEAN_SUMMON (auto-summon mowing)
  16: 'standby',        // STATION_RESET
  23: 'remote_control', // REMOTE_CONTROL
  24: 'charging',       // SMART_CHARGING
  25: 'mowing',         // SECOND_CLEANING
  26: 'mowing',         // HUMAN_FOLLOWING
  27: 'mowing',         // SPOT_CLEANING
  29: 'idle',           // WAITING_FOR_TASK
  30: 'mowing',         // STATION_CLEANING
  97: 'mowing',         // SHORTCUT
  98: 'mapping',        // MONITORING
  99: 'paused',         // MONITORING_PAUSED
};

// charging_status code → enum
// Source: EvotecIT/homeassistant-dreamelawnmower types.py DreameMowerChargingStatus enum
const CHARGING_MAP = {
  1: 'charging',
  2: 'not_charging',
  3: 'charging_completed',
  5: 'returning',
};

// Statuses that count as "home" for mowing-completed detection
const HOME_STATUSES = new Set(['idle', 'standby', 'docked', 'charging', 'updating']);

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
      'alarm_lift', 'night_mode',
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
  {
    key: 'capabilities_migrated_v7',
    caps: [],
  },
  {
    key: 'capabilities_migrated_v8',
    caps: [
      // Re-enabled as read-only sensors
      'mower_task_status', 'child_lock',
    ],
  },
  {
    key: 'capabilities_migrated_v9',
    caps: ['cmd_all_area', 'cmd_edge_mowing'],
  },
  {
    key: 'capabilities_migrated_v10',
    caps: ['cmd_dock'],
  },
  {
    key: 'capabilities_migrated_v11',
    caps: ['cmd_stop'],
  },
  {
    key: 'capabilities_migrated_v12',
    caps: ['cmd_pause'],
  },
  {
    key: 'capabilities_migrated_v13',
    caps: ['mower_volume'],
  },
  {
    key: 'capabilities_migrated_v14',
    caps: ['consumable_blade', 'consumable_brush', 'consumable_robot'],
  },
];

// Capabilities removed — stripped from existing installs on next init
const REMOVE_CAPABILITIES = [
  // v5: no API data
  'alarm_obstacle', 'alarm_tilt', 'alarm_lift',
  'mower_task_status',
  'mower_error_code',
  'mower_progress',
  'measure_area',
  'meter_area_total', 'meter_time_total', 'meter_count_total',
  // v9: replaced by action buttons
  'mower_mode',
  // v11: removed — redundant with mower_status
  'mower_docked', 'mower_mowing', 'mower_paused', 'mower_returning', 'task_active',
  // v11: removed — requires phone app to steer
  'cmd_manual_mowing',
  // v11: edge-zone buttons are managed dynamically by _syncZoneCapabilities
  // (listed here so stale installs get them removed before re-add in correct order)
  'cmd_edge_zone_1', 'cmd_edge_zone_2', 'cmd_edge_zone_3', 'cmd_edge_zone_4', 'cmd_edge_zone_5',
  // v6: write-only (setProperty returns 10007 on MOVA devices)
  'mowing_speed', 'mower_pattern',
  'dnd_enabled',
  'frost_protection', 'grass_protection',
  'night_mode', 'anti_theft', 'auto_charging',
  // v8: WRP CFG action returns 404 on MOVA devices — not supported
  'rain_protection',
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
    this._lastBindDomain       = null;  // track last seen bindDomain to avoid redundant setBindDomain calls
    this._activeMapIndex       = 0;     // active map index, updated from MAP data each poll
    this._activeZoneIds        = [];    // detected zone IDs from MAP data (e.g. [1, 2, 3])
    this._cfgPollCounter       = 0;     // reads CFG (WRP etc.) on first poll and every 10th thereafter

    // Flow trigger cards
    this._trgStatusChanged    = this.homey.flow.getDeviceTriggerCard('mower_status_changed');
    this._trgChargingChanged  = this.homey.flow.getDeviceTriggerCard('charging_status_changed');
    this._trgMowingCompleted  = this.homey.flow.getDeviceTriggerCard('mowing_completed');
    this._trgError            = this.homey.flow.getDeviceTriggerCard('mower_error');
    this._trgDocked           = this.homey.flow.getDeviceTriggerCard('mower_docked');
    this._trgFirmwareUpdate   = this.homey.flow.getDeviceTriggerCard('firmware_update_available');
    this._trgBatteryLow       = this.homey.flow.getDeviceTriggerCard('battery_low');

    // ── Action button listeners ────────────────────────────────────────────────
    // Each button is a momentary toggle: tap → command fires → resets to false.
    const did = this.getData().id;

    this.registerCapabilityListener('cmd_all_area', async (value) => {
      if (!value) return;
      try {
        this.log('[cmd] btn: all area → sendAction(5,1)');
        await this._safeWrite('cmd_all_area', () => this._api.startMowing(did));
        await this._setMowingStarted();
      } catch (err) {
        this.error('[cmd_all_area] listener error:', err.message);
      } finally {
        await this.setCapabilityValue('cmd_all_area', false).catch(() => {});
      }
    });

    this.registerCapabilityListener('cmd_edge_mowing', async (value) => {
      if (!value) return;
      try {
        const mapIdx = this._activeMapIndex ?? 0;
        this.log(`[cmd] btn: edge mapIndex=${mapIdx} → sendAction(2,50,{m:a,o:101,d:{}})`);
        await this._safeWrite('cmd_edge_mowing', () => this._api.startEdgeMowing(did, mapIdx));
        await this._setMowingStarted();
      } catch (err) {
        this.error('[cmd_edge_mowing] listener error:', err.message);
      } finally {
        await this.setCapabilityValue('cmd_edge_mowing', false).catch(() => {});
      }
    });

    this.registerCapabilityListener('cmd_stop', async (value) => {
      if (!value) return;
      try {
        this.log('[cmd] btn: stop → sendAction(5,2)');
        await this._safeWrite('cmd_stop', () => this._api.stopMowing(did));
      } catch (err) {
        this.error('[cmd_stop] listener error:', err.message);
      } finally {
        await this.setCapabilityValue('cmd_stop', false).catch(() => {});
      }
    });

    this.registerCapabilityListener('cmd_pause', async (value) => {
      if (!value) return;
      try {
        this.log('[cmd] btn: pause → sendAction(5,4)');
        await this._safeWrite('cmd_pause', () => this._api.pause(did));
        await this._applyStatus('paused');
      } catch (err) {
        this.error('[cmd_pause] listener error:', err.message);
      } finally {
        await this.setCapabilityValue('cmd_pause', false).catch(() => {});
      }
    });

    this.registerCapabilityListener('cmd_dock', async (value) => {
      if (!value) return;
      try {
        this.log('[cmd] btn: dock → dock()');
        await this._safeWrite('cmd_dock', () => this._api.dock(did));
        await this._applyStatus('returning');
      } catch (err) {
        this.error('[cmd_dock] listener error:', err.message);
      } finally {
        await this.setCapabilityValue('cmd_dock', false).catch(() => {});
      }
    });

    this.registerCapabilityListener('mower_volume', async (value) => {
      try {
        await this._safeWrite('mower_volume', () => this._api.setVolume(did, value));
      } catch (err) {
        this.error('[mower_volume] listener error:', err.message);
      }
    });

    // Zone buttons — register listeners for any zone capabilities already on device
    await this._syncZoneCapabilities();

    await this._initApi();

    // Fetch current device config before starting the poll loop so the settings
    // page always shows real device values the moment the user opens it.
    const cfg = await this._api.getCFG(did).catch((e) => {
      this.error('[init] getCFG failed:', e.message);
      return null;
    });
    if (cfg) await this._applyCFGSettings(cfg);

    // Skip the redundant getCFG on the very first poll since we just fetched it.
    this._cfgPollCounter = 1;

    this._startPolling();
  }

  async onDeleted() {
    this._stopPolling();
  }

  async onSettings({ changedKeys, newSettings }) {
    this.log('[settings] changed:', changedKeys.join(', '));
    const did = this.getData().id;

    if (changedKeys.includes('poll_interval')) {
      this.log(`[settings] poll_interval → ${newSettings.poll_interval}s`);
      this._stopPolling();
      this._startPolling();
    }

    // Child lock
    if (changedKeys.includes('cls_enabled')) {
      this.log(`[settings] CLS → enabled=${newSettings.cls_enabled}`);
      await this._safeWrite('cls', () => this._api.setChildLock(did, newSettings.cls_enabled));
      if (this.hasCapability('child_lock')) {
        await this._applyBoolCap('child_lock', newSettings.cls_enabled);
      }
    }

    // Frost protection
    if (changedKeys.includes('fdp_enabled')) {
      this.log(`[settings] FDP → enabled=${newSettings.fdp_enabled}`);
      await this._safeWrite('fdp', () => this._api.setFrostProtection(did, newSettings.fdp_enabled));
    }

    // AI obstacle photo capture
    if (changedKeys.includes('aop_enabled')) {
      this.log(`[settings] AOP → enabled=${newSettings.aop_enabled}`);
      await this._safeWrite('aop', () => this._api.setAIObstaclePhoto(did, newSettings.aop_enabled));
    }

    // Anti-theft alarm — write all three values together whenever any one changes
    const ATA_KEYS = ['ata_lift', 'ata_map_alarm', 'ata_realtime'];
    if (ATA_KEYS.some((k) => changedKeys.includes(k))) {
      this.log(`[settings] ATA → lift=${newSettings.ata_lift} mapAlarm=${newSettings.ata_map_alarm} realtime=${newSettings.ata_realtime}`);
      await this._safeWrite('ata', () => this._api.setAntiTheftAlarm(did, {
        lift:     newSettings.ata_lift,
        mapAlarm: newSettings.ata_map_alarm,
        realtime: newSettings.ata_realtime,
      }));
    }

    // Rain protection — write all three values together whenever any one changes
    const WRP_KEYS = ['wrp_enabled', 'wrp_sensitivity', 'wrp_wait_time'];
    if (WRP_KEYS.some((k) => changedKeys.includes(k))) {
      this.log(`[settings] WRP → enabled=${newSettings.wrp_enabled} sen=${newSettings.wrp_sensitivity} time=${newSettings.wrp_wait_time}h`);
      await this._safeWrite('wrp', () => this._api.setRainProtectionConfig(did, {
        enabled:     newSettings.wrp_enabled,
        sensitivity: newSettings.wrp_sensitivity,
        waitHours:   newSettings.wrp_wait_time,
      }));
    }

    // Lighting — write all values together whenever any one changes
    const LIT_KEYS = ['lit_enabled', 'lit_time_start', 'lit_time_end', 'lit_standby', 'lit_working', 'lit_charging', 'lit_error'];
    if (LIT_KEYS.some((k) => changedKeys.includes(k))) {
      const light = [
        newSettings.lit_standby  ? 1 : 0,
        newSettings.lit_working  ? 1 : 0,
        newSettings.lit_charging ? 1 : 0,
        newSettings.lit_error    ? 1 : 0,
      ];
      this.log(`[settings] LIT → enabled=${newSettings.lit_enabled} start=${newSettings.lit_time_start}h end=${newSettings.lit_time_end}h light=${JSON.stringify(light)}`);
      await this._safeWrite('lit', () => this._api.setLighting(did, {
        value:     newSettings.lit_enabled ? 1 : 0,
        timeStart: newSettings.lit_time_start,
        timeEnd:   newSettings.lit_time_end,
        light,
      }));
    }

    // Voice announcement modes — write all four together whenever any one changes
    const VOICE_KEYS = ['voice_notification', 'voice_work_status', 'voice_special_status', 'voice_error_status'];
    if (VOICE_KEYS.some((k) => changedKeys.includes(k))) {
      this.log(`[settings] VOICE → notification=${newSettings.voice_notification} work=${newSettings.voice_work_status} special=${newSettings.voice_special_status} error=${newSettings.voice_error_status}`);
      await this._safeWrite('voice', () => this._api.setVoiceModes(did, {
        notification:  newSettings.voice_notification,
        workStatus:    newSettings.voice_work_status,
        specialStatus: newSettings.voice_special_status,
        errorStatus:   newSettings.voice_error_status,
      }));
    }

    // Battery power config — write return %, resume % and schedule toggle together
    // (bat_schedule_start / bat_schedule_end write format not yet confirmed, read-only for now)
    const BAT_POWER_KEYS = ['bat_return_pct', 'bat_resume_pct', 'bat_auto_resume'];
    if (BAT_POWER_KEYS.some((k) => changedKeys.includes(k))) {
      this.log(`[settings] BAT power → return=${newSettings.bat_return_pct}% resume=${newSettings.bat_resume_pct}% autoResume=${newSettings.bat_auto_resume}`);
      await this._safeWrite('bat', () => this._api.setBatteryConfig(did, {
        returnPct:   newSettings.bat_return_pct,
        resumePct:   newSettings.bat_resume_pct,
        autoResume:  newSettings.bat_auto_resume,
      }));
    }

    // Low Speed at Night — write enabled + start + end together whenever any changes
    const LOW_KEYS = ['low_enabled', 'low_start', 'low_end'];
    if (LOW_KEYS.some((k) => changedKeys.includes(k))) {
      this.log(`[settings] LOW → enabled=${newSettings.low_enabled} start=${newSettings.low_start}h end=${newSettings.low_end}h`);
      await this._safeWrite('low', () => this._api.setLowSpeedNight(did, {
        enabled:  newSettings.low_enabled,
        startMin: newSettings.low_start * 60,
        endMin:   newSettings.low_end   * 60,
      }));
    }

    // Do Not Disturb — write enabled + start + end together whenever any changes
    const DND_KEYS = ['dnd_enabled', 'dnd_start', 'dnd_end'];
    if (DND_KEYS.some((k) => changedKeys.includes(k))) {
      this.log(`[settings] DND → enabled=${newSettings.dnd_enabled} start=${newSettings.dnd_start}h end=${newSettings.dnd_end}h`);
      await this._safeWrite('dnd', () => this._api.setDNDSchedule(did, {
        enabled:  newSettings.dnd_enabled,
        startMin: newSettings.dnd_start * 60,
        endMin:   newSettings.dnd_end   * 60,
      }));
    }

    // num_zones is a read-only label — users cannot change it, no handler needed.
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

    for (const cap of REMOVE_CAPABILITIES) {
      if (this.hasCapability(cap)) {
        await this.removeCapability(cap).catch((e) => this.error('removeCapability', cap, e.message));
      }
    }
  }

  // ─── API ──────────────────────────────────────────────────────────────────

  async _initApi() {
    const brand  = await this.getStoreValue('brand')  || this.getSetting('brand')  || 'dreame';
    const region = await this.getStoreValue('region') || this.getSetting('region') || 'eu';

    this._api = new MovaApi({ brand, region, log: (...a) => this.log(...a) });

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

    // Pre-load bindDomain so sendAction works before the first poll completes.
    // Also set _lastBindDomain so the first poll doesn't log a redundant update.
    const bindDomain = await this.getStoreValue('bind_domain');
    if (bindDomain) {
      this._api.setBindDomain(bindDomain);
      this._lastBindDomain = bindDomain;
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

  /**
   * Single poll cycle: fires getRawProperties (for SETTINGS.0) and
   * getDeviceStatus (device-list) in parallel, then maps results to capabilities.
   */
  async _poll() {
    const did = this.getData().id;

    const [rawResult, statusResult] = await Promise.allSettled([
      this._api.getRawProperties(did),
      this._api.getDeviceStatus(did),
    ]);

    await this._persistTokensIfChanged();

    // ── Device list: battery, status, online ────────────────────────────────
    if (statusResult.status === 'rejected') {
      await this._handlePollError(statusResult.reason);
      return;
    }

    const info = statusResult.value;
    if (!info) {
      this.error('Device not found in list for did:', did);
      await this.setUnavailable(this.homey.__('error.device_not_found'));
      return;
    }

    // ── bindDomain → sendCommand host (update only when value changes) ────────
    if (info.bindDomain != null && info.bindDomain !== this._lastBindDomain) {
      this._lastBindDomain = info.bindDomain;
      this._api.setBindDomain(info.bindDomain);
    }

    // ── Read-only device info → settings (change-guarded) ───────────────────
    {
      const infoUpdate = {};
      // Prefer the human-readable display name (e.g. "LiDAX Ultra 1200") over
      // the internal model string; fall back to info.model if absent.
      const displayName = info.deviceInfo?.displayName || info.model || '';
      if (displayName && displayName !== this.getSetting('device_model'))       infoUpdate.device_model     = displayName;
      if (info.ver    && info.ver    !== this.getSetting('firmware_version'))   infoUpdate.firmware_version = info.ver;
      if (info.sn     && info.sn     !== this.getSetting('serial_number'))      infoUpdate.serial_number    = info.sn;
      if (info.mac    && info.mac    !== this.getSetting('mac_address'))        infoUpdate.mac_address      = info.mac;
      if (Object.keys(infoUpdate).length > 0) {
        await this.setSettings(infoUpdate).catch(() => {});
      }
    }

    // child_lock may be present in the device-list response on some models
    if (info.childLock != null && this.hasCapability('child_lock')) {
      await this._applyBoolCap('child_lock', !!info.childLock);
    }

    if (info.battery      != null) await this._applyBattery(info.battery);
    if (info.latestStatus != null) {
      const mowerStatus = STATUS_MAP[info.latestStatus] ?? 'idle';
      // Dreame/MOVA device list may expose the fault code under different field names.
      const faultCode = info.latestFaultCode ?? info.faultCode ?? info.errorCode ?? 0;
      await this._applyStatus(mowerStatus, faultCode);

      // Derive charging_status from mower status.
      const chargingCode =
        mowerStatus === 'charging'  ? 1
        : mowerStatus === 'docked'  ? 3
        : mowerStatus === 'returning' ? 5
        : 2; // NOT_CHARGING for all other states
      await this._applyChargingStatus(chargingCode);
    }

    if (info.online === false) {
      await this.setUnavailable(this.homey.__('error.device_offline'));
      return;
    }

    // ── Session duration counter ─────────────────────────────────────────────
    if (this._wasMowing && this._sessionStartTime !== null) {
      const mins = Math.floor((Date.now() - this._sessionStartTime) / 60000);
      if (this.getCapabilityValue('measure_duration') !== mins) {
        await this.setCapabilityValue('measure_duration', mins);
      }
    }

    // ── CFG settings (WRP etc.) — first poll and every 10th thereafter ───────
    if (this._cfgPollCounter % 10 === 0) {
      const cfg = await this._api.getCFG(did).catch((e) => {
        this.error('[cfg] getCFG failed:', e.message);
        return null;
      });
      if (cfg) await this._applyCFGSettings(cfg);
    }
    this._cfgPollCounter++;

    // ── SETTINGS.0 / OTA_INFO.0 / MAP zone detection ────────────────────────
    if (rawResult.status === 'fulfilled') {
      const rawData = rawResult.value?.data;
      if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
        await this._applyMOVASettings(rawData);
        await this._detectAndSyncZones(rawData);
      }
    } else {
      this.error('[poll] rawProperties failed:', rawResult.reason?.message);
    }

    if (!this.getAvailable()) await this.setAvailable();
  }

  // ─── Write helper ─────────────────────────────────────────────────────────

  /**
   * Execute a cloud write and swallow any error so Homey never shows a red
   * error notification to the user. The next poll will restore the correct
   * capability value if the write was rejected by the API.
   */
  async _safeWrite(label, fn) {
    try {
      await fn();
    } catch (err) {
      this.error(`[write] ${label} rejected by API:`, err.message);
    }
  }

  // ─── Zone button management ───────────────────────────────────────────────

  /**
   * Add or remove cmd_zone_N capabilities based on the num_zones setting,
   * and register a capability listener for each newly added zone button.
   * Called on init and whenever num_zones changes in settings.
   */
  async _syncZoneCapabilities() {
    const count = Math.max(0, Math.min(5, parseInt(this.getSetting('num_zones'), 10) || 1));
    const did   = this.getData().id;

    // Phase 1: add / remove all zone capabilities (both mow and edge).
    // Must be completed before registering listeners because addCapability()
    // resets the Homey SDK's internal listener state, which would silently
    // drop any listener registered before the call.
    for (let i = 1; i <= 5; i++) {
      for (const prefix of ['cmd_zone_', 'cmd_edge_zone_']) {
        const capId = `${prefix}${i}`;
        if (i <= count) {
          if (!this.hasCapability(capId)) {
            await this.addCapability(capId)
              .catch((e) => this.error(`addCapability ${capId}:`, e.message));
          }
        } else if (this.hasCapability(capId)) {
          await this.removeCapability(capId)
            .catch((e) => this.error(`removeCapability ${capId}:`, e.message));
        }
      }
    }

    // Phase 2: register listeners for all active zone capabilities.
    // Done after all structural changes so no listener is lost.
    for (let i = 1; i <= count; i++) {
      if (this.hasCapability(`cmd_zone_${i}`)) {
        this._registerZoneListener(`cmd_zone_${i}`, i, did);
      }
      if (this.hasCapability(`cmd_edge_zone_${i}`)) {
        this._registerEdgeZoneListener(`cmd_edge_zone_${i}`, i, did);
      }
    }
  }

  /**
   * Scan the MAP.N chunks for mowingArea zone IDs and update num_zones + capabilities
   * automatically whenever the detected count differs from the stored setting.
   * Called every poll cycle (cheap: exits early when nothing changed).
   */
  async _detectAndSyncZones(raw) {
    const { ids: detectedIds, mapIndex } = this._extractMapInfo(raw);

    // Update active map index used by zone/edge mowing commands
    if (mapIndex !== this._activeMapIndex) {
      this.log(`[zones] active map index: ${this._activeMapIndex} → ${mapIndex}`);
      this._activeMapIndex = mapIndex;
    }

    // Always keep the zone ID list current (used for edge mowing)
    this._activeZoneIds = detectedIds;

    if (detectedIds.length === 0) return; // no map data yet

    const capped  = Math.min(detectedIds.length, 5);
    const current = parseInt(this.getSetting('num_zones'), 10) || 0;
    if (capped === current) return; // nothing changed

    this.log(`[zones] auto-detected ${detectedIds.length} zone(s) [${detectedIds.join(',')}] — updating num_zones ${current} → ${capped}`);
    await this.setSettings({ num_zones: String(capped) }).catch((e) => this.error('setSettings num_zones:', e.message));
    await this._syncZoneCapabilities();
  }

  /**
   * Concatenate MAP.N chunks and extract:
   *   - ids:      sorted list of distinct mowing zone IDs (e.g. [1, 2, 3])
   *   - mapIndex: the active map's mapIndex value (0-based)
   *
   * Zone entries look like: "value":[[1,{"id":1,...}],[2,{"id":2,...}]]
   * mapIndex appears as: "mapIndex":0
   * Returns { ids: [], mapIndex: 0 } when no map data is present.
   */
  _extractMapInfo(raw) {
    const parts = [];
    for (let i = 0; raw[`MAP.${i}`] != null; i++) parts.push(raw[`MAP.${i}`]);
    const mapStr = parts.join('');
    if (!mapStr) return { ids: [], mapIndex: 0 };

    // Extract active mapIndex (first occurrence — belongs to the active map)
    const mapIndexMatch = mapStr.match(/"mapIndex":(\d+)/);
    const mapIndex = mapIndexMatch ? parseInt(mapIndexMatch[1], 10) : 0;

    // Locate the first map's mowingAreas section
    const maIdx = mapStr.indexOf('mowingAreas');
    if (maIdx === -1) return { ids: [], mapIndex };

    // Limit search to the section before forbiddenAreas to avoid false matches
    const endIdx = mapStr.indexOf('forbiddenAreas', maIdx);
    const section = mapStr.slice(maIdx, endIdx === -1 ? maIdx + 4000 : endIdx);

    // Zone entries: [N,{ where N is the zone ID (1–99)
    const idSet = new Set();
    for (const m of section.matchAll(/\[(\d{1,3}),\{/g)) {
      const id = parseInt(m[1], 10);
      if (id >= 1 && id <= 99) idSet.add(id);
    }

    return { ids: [...idSet].sort((a, b) => a - b), mapIndex };
  }

  /** Register the momentary-button listener for a single zone mowing capability. */
  _registerZoneListener(capId, zoneNum, did) {
    this.registerCapabilityListener(capId, async (value) => {
      if (!value) return;
      try {
        const mapIdx = this._activeMapIndex ?? 0;
        this.log(`[cmd] btn: zone ${zoneNum} mapIndex=${mapIdx} → sendAction(2,50,{m:a,o:102,d:{region:[${zoneNum}]}})`);
        await this._safeWrite(capId, () => this._api.startZoneMowing(did, [zoneNum], mapIdx));
        await this._setMowingStarted();
      } catch (err) {
        this.error(`[${capId}] listener error:`, err.message);
      } finally {
        await this.setCapabilityValue(capId, false).catch(() => {});
      }
    });
  }

  /** Register the momentary-button listener for a single edge-zone mowing capability. */
  _registerEdgeZoneListener(capId, zoneNum, did) {
    this.registerCapabilityListener(capId, async (value) => {
      if (!value) return;
      try {
        const mapIdx = this._activeMapIndex ?? 0;
        this.log(`[cmd] btn: edge zone ${zoneNum} mapIndex=${mapIdx} → sendAction(2,50,{m:a,o:101,d:{edge:[[${zoneNum},${mapIdx}]]}})`);
        await this._safeWrite(capId, () => this._api.startEdgeZoneMowing(did, zoneNum, mapIdx));
        await this._setMowingStarted();
      } catch (err) {
        this.error(`[${capId}] listener error:`, err.message);
      } finally {
        await this.setCapabilityValue(capId, false).catch(() => {});
      }
    });
  }

  // ─── Poll helpers ─────────────────────────────────────────────────────────

  /** Persist refreshed tokens only when they actually changed (saves ~6,900 store writes/day). */
  async _persistTokensIfChanged() {
    const tk = this._api.getTokens();
    if (tk.tokenExpiry === this._persistedTokenExpiry) return;
    await this.setStoreValue('access_token',  tk.accessToken);
    await this.setStoreValue('refresh_token', tk.refreshToken);
    await this.setStoreValue('token_expiry',  tk.tokenExpiry);
    this._persistedTokenExpiry = tk.tokenExpiry;
  }

  async _handlePollError(err) {
    this.error('Poll error:', err.message);
    if (err.message === 'Device offline') {
      await this.setUnavailable(this.homey.__('error.device_offline'));
    } else if (err.message.includes('Auth failed') || err.message.includes('No refresh token')) {
      await this.setUnavailable(this.homey.__('error.auth_failed'));
    } else {
      await this.setUnavailable(this.homey.__('error.unreachable'));
    }
  }

  // ─── SETTINGS.0 / OTA_INFO.0 mapping ─────────────────────────────────────

  /**
   * Parse the SETTINGS.0 key-value blob and map known fields to
   * Homey capabilities and device settings.
   *
   * SETTINGS.0 is a JSON array where each element represents a mowing zone:
   *   [ { mode: 0, settings: { "0": { efficientMode, mowingHeight, … } } }, … ]
   * We use zone 0 / settings["0"] as the active device-wide configuration.
   */
  async _applyMOVASettings(raw) {
    // SETTINGS is paginated: SETTINGS.0, SETTINGS.1, … must be concatenated before parsing.
    const parts = [];
    for (let i = 0; raw[`SETTINGS.${i}`] != null; i++) parts.push(raw[`SETTINGS.${i}`]);
    const settingsStr = parts.join('');
    if (!settingsStr) return;

    let zones;
    try { zones = JSON.parse(settingsStr); } catch { return; }
    if (!Array.isArray(zones) || zones.length === 0) return;

    const s = zones[0]?.settings?.['0'];
    if (!s) return;

    // Capability updates (change-guarded)
    if (s.efficientMode != null) {
      const mode = s.efficientMode === 1 ? 'efficient' : 'standard';
      if (this.getCapabilityValue('mow_efficiency') !== mode) {
        await this.setCapabilityValue('mow_efficiency', mode);
      }
    }
    if (s.obstacleAvoidanceEnabled != null) {
      await this._applyBoolCap('collision_avoidance', s.obstacleAvoidanceEnabled);
    }

    // child_lock: MOVA may expose this as prop.s_child_lock
    const clProp = raw['prop.s_child_lock'] ?? raw['prop.child_lock'];
    if (clProp != null && this.hasCapability('child_lock')) {
      await this._applyBoolCap('child_lock', clProp === '1' || clProp === 1 || clProp === true);
    }

    // OTA_INFO.0 = "[state, updateAvailable]" — index 1 > 0 means update is available.
    const otaStr = raw['OTA_INFO.0'];
    if (otaStr) {
      try {
        const ota = JSON.parse(otaStr);
        if (Array.isArray(ota) && ota.length >= 2) {
          await this._applyFirmwareState(ota[1]);
        }
      } catch { /* malformed OTA_INFO, skip */ }
    }
  }

  /**
   * Apply CFG values returned by getCFG() to device settings.
   * Only updates keys that are actually present in the response (change-guarded).
   */
  async _applyCFGSettings(cfg) {
    this.log('[cfg] ' + Object.keys(cfg).map((k) => `${k} = ${JSON.stringify(cfg[k])}`).join(' | '));

    // CFG values come back either as scalars (0/1) or as objects ({ value: 0/1, ... }).
    // cfgBool handles both formats safely.
    const cfgBool = (v) => (typeof v === 'object' ? v.value : v) === 1;

    const update = {};

    // WRP — rain protection.
    // GET returns an array [enabled, waitTimeHours, sensitivity].
    // SET uses an object { value, sen, time } (confirmed via packet capture).
    if (cfg.WRP != null) {
      let enabled, waitTime, sensitivity;
      if (Array.isArray(cfg.WRP)) {
        enabled     = cfg.WRP[0] === 1;
        waitTime    = cfg.WRP[1] ?? 7;
        sensitivity = cfg.WRP[2] ?? 1;
      } else if (typeof cfg.WRP === 'object') {
        enabled     = cfg.WRP.value === 1;
        waitTime    = cfg.WRP.time  ?? 7;
        sensitivity = cfg.WRP.sen   ?? 1;
      } else {
        enabled     = cfg.WRP === 1;
        waitTime    = 7;
        sensitivity = 1;
      }
      if (this.getSetting('wrp_enabled')     !== enabled)     update.wrp_enabled     = enabled;
      if (this.getSetting('wrp_sensitivity') !== sensitivity) update.wrp_sensitivity = sensitivity;
      if (this.getSetting('wrp_wait_time')   !== waitTime)    update.wrp_wait_time   = waitTime;
    }

    // CLS — child lock: scalar 0/1 (confirmed via ioBroker: type:'number')
    if (cfg.CLS != null) {
      const clsEnabled = cfgBool(cfg.CLS);
      if (this.getSetting('cls_enabled') !== clsEnabled) update.cls_enabled = clsEnabled;
      if (this.hasCapability('child_lock')) await this._applyBoolCap('child_lock', clsEnabled);
    }

    // FDP — frost protection: scalar 0/1
    if (cfg.FDP != null) {
      const fdpEnabled = cfgBool(cfg.FDP);
      if (this.getSetting('fdp_enabled') !== fdpEnabled) update.fdp_enabled = fdpEnabled;
    }

    // AOP — AI obstacle photo capture: scalar 0/1
    if (cfg.AOP != null) {
      const aopEnabled = cfgBool(cfg.AOP);
      if (this.getSetting('aop_enabled') !== aopEnabled) update.aop_enabled = aopEnabled;
    }

    // ATA — anti-theft alarm: array [liftAlarm, mapAlarm, realtimeLocation]
    if (cfg.ATA != null) {
      const ata = Array.isArray(cfg.ATA) ? cfg.ATA : [cfgBool(cfg.ATA) ? 1 : 0, 0, 0];
      const ataLift     = ata[0] === 1;
      const ataMapAlarm = (ata[1] ?? 0) === 1;
      const ataRealtime = (ata[2] ?? 0) === 1;
      if (this.getSetting('ata_lift')      !== ataLift)     update.ata_lift      = ataLift;
      if (this.getSetting('ata_map_alarm') !== ataMapAlarm) update.ata_map_alarm = ataMapAlarm;
      if (this.getSetting('ata_realtime')  !== ataRealtime) update.ata_realtime  = ataRealtime;
    }

    // VOL — volume: scalar 0–100
    if (cfg.VOL != null && this.hasCapability('mower_volume')) {
      const vol = Number(cfg.VOL);
      if (this.getCapabilityValue('mower_volume') !== vol) {
        await this.setCapabilityValue('mower_volume', vol).catch((e) => this.error('setCapabilityValue mower_volume:', e.message));
      }
    }

    // VOICE — voice announcement modes: array [notification, workStatus, specialStatus, errorStatus]
    if (Array.isArray(cfg.VOICE) && cfg.VOICE.length >= 4) {
      const voiceNotification  = cfg.VOICE[0] === 1;
      const voiceWorkStatus    = cfg.VOICE[1] === 1;
      const voiceSpecialStatus = cfg.VOICE[2] === 1;
      const voiceErrorStatus   = cfg.VOICE[3] === 1;
      if (this.getSetting('voice_notification')  !== voiceNotification)  update.voice_notification  = voiceNotification;
      if (this.getSetting('voice_work_status')   !== voiceWorkStatus)    update.voice_work_status   = voiceWorkStatus;
      if (this.getSetting('voice_special_status') !== voiceSpecialStatus) update.voice_special_status = voiceSpecialStatus;
      if (this.getSetting('voice_error_status')  !== voiceErrorStatus)   update.voice_error_status  = voiceErrorStatus;
    }

    // LIT — lighting.
    // GET returns an array [enabled, startMin, endMin, standby, working, charging, error]
    // or (older firmware) an object { value, time:[startMin,endMin], light:[...] }.
    // All 7 values are readable; light scenarios are NOT write-only.
    if (cfg.LIT != null) {
      let litEnabled, litStart, litEnd, litStandby, litWorking, litCharging, litError;
      if (Array.isArray(cfg.LIT)) {
        litEnabled  = cfg.LIT[0] === 1;
        litStart    = Math.round((cfg.LIT[1] ?? 480)  / 60);
        litEnd      = Math.round((cfg.LIT[2] ?? 1200) / 60);
        litStandby  = cfg.LIT[3] === 1;
        litWorking  = cfg.LIT[4] === 1;
        litCharging = cfg.LIT[5] === 1;
        litError    = cfg.LIT[6] === 1;
      } else if (typeof cfg.LIT === 'object') {
        litEnabled  = cfg.LIT.value === 1;
        litStart    = Math.round((cfg.LIT.time?.[0] ?? 480)  / 60);
        litEnd      = Math.round((cfg.LIT.time?.[1] ?? 1200) / 60);
        if (Array.isArray(cfg.LIT.light)) {
          litStandby  = cfg.LIT.light[0] === 1;
          litWorking  = cfg.LIT.light[1] === 1;
          litCharging = cfg.LIT.light[2] === 1;
          litError    = cfg.LIT.light[3] === 1;
        }
      }
      if (litEnabled  !== undefined && this.getSetting('lit_enabled')    !== litEnabled)  update.lit_enabled    = litEnabled;
      if (litStart    !== undefined && this.getSetting('lit_time_start') !== litStart)    update.lit_time_start = litStart;
      if (litEnd      !== undefined && this.getSetting('lit_time_end')   !== litEnd)      update.lit_time_end   = litEnd;
      if (litStandby  !== undefined && this.getSetting('lit_standby')    !== litStandby)  update.lit_standby    = litStandby;
      if (litWorking  !== undefined && this.getSetting('lit_working')    !== litWorking)  update.lit_working    = litWorking;
      if (litCharging !== undefined && this.getSetting('lit_charging')   !== litCharging) update.lit_charging   = litCharging;
      if (litError    !== undefined && this.getSetting('lit_error')      !== litError)    update.lit_error      = litError;
    }

    // CMS — consumable maintenance: array [bladeMin, brushMin, robotMin] = minutes used since last replacement.
    // Max life: blade=6000 min (100h), brush=30000 min (500h), robot=3600 min (60h).
    // Confirmed via getCFG response and cross-checked against MOVA app percentages.
    if (Array.isArray(cfg.CMS) && cfg.CMS.length >= 3) {
      const CMS_MAX = [6000, 30000, 3600];
      const caps    = ['consumable_blade', 'consumable_brush', 'consumable_robot'];
      await Promise.all(caps.map((cap, i) => {
        if (!this.hasCapability(cap)) return null;
        const pct = Math.max(0, Math.round((1 - cfg.CMS[i] / CMS_MAX[i]) * 100));
        if (this.getCapabilityValue(cap) === pct) return null;
        return this.setCapabilityValue(cap, pct)
          .catch((e) => this.error(`setCapabilityValue ${cap}:`, e.message));
      }));
    }

    // BAT — battery config: GET returns [returnPct, resumePct, scheduleEnabled, ?, startMin, endMin]
    // SET type:'power' sends [returnPct, resumePct, scheduleEnabled] (confirmed via packet capture).
    // Schedule time window write (type:'schedule') is not yet confirmed — start/end are read-only for now.
    if (Array.isArray(cfg.BAT) && cfg.BAT.length >= 2) {
      const batReturn  = cfg.BAT[0];
      const batResume  = cfg.BAT[1];
      const batAutoResume = cfg.BAT[2] === 1;
      if (this.getSetting('bat_return_pct')  !== batReturn)     update.bat_return_pct  = batReturn;
      if (this.getSetting('bat_resume_pct')  !== batResume)     update.bat_resume_pct  = batResume;
      if (this.getSetting('bat_auto_resume') !== batAutoResume) update.bat_auto_resume = batAutoResume;
    }

    // LOW — Low Speed at Night: GET returns { value:0|1, time:[startMin,endMin] }
    if (cfg.LOW != null) {
      let lowEnabled, lowStart, lowEnd;
      if (Array.isArray(cfg.LOW)) {
        lowEnabled = cfg.LOW[0] === 1;
        lowStart   = Math.round((cfg.LOW[1] ?? 1200) / 60);
        lowEnd     = Math.round((cfg.LOW[2] ?? 480)  / 60);
      } else if (typeof cfg.LOW === 'object') {
        lowEnabled = cfg.LOW.value === 1;
        lowStart   = Math.round((cfg.LOW.time?.[0] ?? 1200) / 60);
        lowEnd     = Math.round((cfg.LOW.time?.[1] ?? 480)  / 60);
      } else {
        lowEnabled = cfg.LOW === 1;
        lowStart   = 20;
        lowEnd     = 8;
      }
      if (this.getSetting('low_enabled') !== lowEnabled) update.low_enabled = lowEnabled;
      if (this.getSetting('low_start')   !== lowStart)   update.low_start   = lowStart;
      if (this.getSetting('low_end')     !== lowEnd)     update.low_end     = lowEnd;
    }

    // DND — Do Not Disturb: GET returns { value:0|1, time:[startMin,endMin] }
    if (cfg.DND != null) {
      let dndEnabled, dndStart, dndEnd;
      if (Array.isArray(cfg.DND)) {
        dndEnabled = cfg.DND[0] === 1;
        dndStart   = Math.round((cfg.DND[1] ?? 1320) / 60);
        dndEnd     = Math.round((cfg.DND[2] ?? 480)  / 60);
      } else if (typeof cfg.DND === 'object') {
        dndEnabled = cfg.DND.value === 1;
        dndStart   = Math.round((cfg.DND.time?.[0] ?? 1320) / 60);
        dndEnd     = Math.round((cfg.DND.time?.[1] ?? 480)  / 60);
      } else {
        dndEnabled = cfg.DND === 1;
        dndStart   = 22;
        dndEnd     = 8;
      }
      if (this.getSetting('dnd_enabled') !== dndEnabled) update.dnd_enabled = dndEnabled;
      if (this.getSetting('dnd_start')   !== dndStart)   update.dnd_start   = dndStart;
      if (this.getSetting('dnd_end')     !== dndEnd)     update.dnd_end     = dndEnd;
    }

    if (Object.keys(update).length > 0) {
      this.log('[cfg] applying settings from CFG:', JSON.stringify(update));
      await this.setSettings(update).catch((e) => this.error('setSettings CFG:', e.message));
    }
  }

  // ─── Capability helpers ───────────────────────────────────────────────────

  async _applyFirmwareState(state) {
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

  async _applyBattery(pct) {
    const prev = this.getCapabilityValue('measure_battery');
    await this.setCapabilityValue('measure_battery', pct);
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

  async _applyStatus(status, faultCode = 0) {
    const prev = this.getCapabilityValue('mower_status');

    const isMowing    = status === 'mowing';
    const isReturning = status === 'returning';

    // Task status (enum)
    const taskStatus =
      isMowing || status === 'mapping' ? 'mowing'
      : isReturning                    ? 'docking'
      : 'idle';
    if (this.hasCapability('mower_task_status') &&
        this.getCapabilityValue('mower_task_status') !== taskStatus) {
      await this.setCapabilityValue('mower_task_status', taskStatus);
    }

    if (status === prev) return;

    await this.setCapabilityValue('mower_status', status);

    this._trgStatusChanged
      .trigger(this, { status }, {})
      .catch((e) => this.error('status_changed trigger:', e.message));

    // Session duration tracking
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
      this._trgError
        .trigger(this, {
          error_code:        faultCode,
          error_description: this.homey.__(`error_codes.${faultCode}`)
                          || this.homey.__('error_codes.unknown').replace('__code__', faultCode),
        }, {})
        .catch((e) => this.error('mower_error trigger:', e.message));
    }

    // Reset action buttons when the mower reaches a resting state
    if (HOME_STATUSES.has(status)) {
      if (this.hasCapability('cmd_dock')) await this.setCapabilityValue('cmd_dock', false).catch(() => {});
      if (this.hasCapability('cmd_stop')) await this.setCapabilityValue('cmd_stop', false).catch(() => {});
    }

    // Reset pause button once the mower confirms it is paused
    if (status === 'paused' && this.hasCapability('cmd_pause')) {
      await this.setCapabilityValue('cmd_pause', false).catch(() => {});
    }

    // Reset all mowing buttons when mowing stops
    if (!isMowing) {
      const mowCaps = ['cmd_all_area', 'cmd_edge_mowing'];
      for (let i = 1; i <= 5; i++) {
        mowCaps.push(`cmd_zone_${i}`, `cmd_edge_zone_${i}`);
      }
      for (const cap of mowCaps) {
        if (this.hasCapability(cap)) await this.setCapabilityValue(cap, false).catch(() => {});
      }
    }

    // Docked trigger
    if (status === 'docked' || status === 'charging' || status === 'charging_completed') {
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

  // ─── Shared mowing state helper ───────────────────────────────────────────

  async _setMowingStarted() {
    // Route through _applyStatus so the status-changed flow trigger fires
    // and session-start tracking is handled consistently.
    await this._applyStatus('mowing');
  }

  // ─── Public commands (called by flow cards) ────────────────────────────────

  async cmdStartMowing() {
    const did  = this.getData().id;
    const mode = await this.getStoreValue('mowing_mode') || 'all_area';
    this.log(`[cmd] startMowing mode=${mode}`);

    switch (mode) {
      case 'edge':
        await this._api.startEdgeMowing(did);
        break;
      case 'zone': {
        const ids    = (await this.getStoreValue('mowing_zone_ids')) || [];
        const mapIdx = this._activeMapIndex ?? 0;
        this.log(`[cmd] zone ids=${ids.join(',')}`);
        await this._api.startZoneMowing(did, ids, mapIdx);
        break;
      }
      case 'spot': {
        const ids = (await this.getStoreValue('mowing_spot_ids')) || [];
        this.log(`[cmd] spot ids=${ids.join(',')}`);
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

  async cmdStartZoneMowing(zonesStr) {
    const did     = this.getData().id;
    const zoneIds = zonesStr.split(',').map((s) => s.trim()).filter(Boolean);
    this.log(`[cmd] startZoneMowing zones=${zoneIds.join(',')}`);
    await this.setStoreValue('mowing_zone_ids', zoneIds);
    const mapIdx = this._activeMapIndex ?? 0;
    await this._api.startZoneMowing(did, zoneIds, mapIdx);
    await this._setMowingStarted();
  }

  async cmdStartEdgeMowing() {
    const did    = this.getData().id;
    const mapIdx = this._activeMapIndex ?? 0;
    this.log(`[cmd] startEdgeMowing mapIndex=${mapIdx}`);
    await this._api.startEdgeMowing(did, mapIdx);
    await this._setMowingStarted();
  }

  async cmdStartEdgeZoneMowing(zoneNum) {
    const did    = this.getData().id;
    const mapIdx = this._activeMapIndex ?? 0;
    this.log(`[cmd] startEdgeZoneMowing zone=${zoneNum} mapIndex=${mapIdx}`);
    await this._api.startEdgeZoneMowing(did, Number(zoneNum), mapIdx);
    await this._setMowingStarted();
  }

  async cmdStartSpotMowing(spotsStr) {
    const did     = this.getData().id;
    const spotIds = spotsStr.split(',').map((s) => s.trim()).filter(Boolean);
    this.log(`[cmd] startSpotMowing spots=${spotIds.join(',')}`);
    await this.setStoreValue('mowing_spot_ids', spotIds);
    await this._api.startSpotMowing(did, spotIds);
    await this._setMowingStarted();
  }

  async cmdPause() {
    this.log('[cmd] pause');
    await this._api.pause(this.getData().id);
    await this._applyStatus('paused');
  }

  async cmdStop() {
    this.log('[cmd] stop');
    await this._api.stopMowing(this.getData().id);
  }

  async cmdDock() {
    this.log('[cmd] dock');
    await this._api.dock(this.getData().id);
    await this._applyStatus('returning');
  }

  async cmdFindBot() {
    this.log('[cmd] findBot');
    await this._api.findBot(this.getData().id);
  }

  async cmdSuppressFault() {
    this.log('[cmd] suppressFault');
    await this._api.suppressFault(this.getData().id);
  }

  async cmdSetMowingMode(mode) {
    this.log(`[cmd] setMowingMode mode=${mode}`);
    await this.setStoreValue('mowing_mode', mode);
  }


  // ─── Debug API (called by settings/index.html via api.js) ─────────────────

  async getDebugPollData() {
    const did = this.getData().id;

    const [rawResponse, deviceStatus, cfgResult] = await Promise.allSettled([
      this._api.getRawProperties(did),
      this._api.getDeviceStatus(did),
      this._api.getCFG(did),
    ]);

    // Capability snapshot
    const capabilityValues = {};
    for (const cap of this.getCapabilities()) {
      capabilityValues[cap] = this.getCapabilityValue(cap);
    }

    // Store snapshot (non-sensitive keys only)
    const storeKeys = ['brand', 'region', 'model', 'bind_domain', 'token_expiry', 'mowing_mode'];
    const storeValues = {};
    for (const k of storeKeys) {
      storeValues[k] = await this.getStoreValue(k);
    }

    // Settings snapshot (no passwords)
    const settingKeys = [
      'brand', 'region', 'device_model', 'firmware_version',
      'serial_number', 'mac_address', 'poll_interval', 'num_zones',
      'cls_enabled', 'fdp_enabled', 'wrp_enabled', 'wrp_sensitivity', 'wrp_wait_time',
      'bat_return_pct', 'bat_resume_pct', 'bat_auto_resume',
      'low_enabled', 'low_start', 'low_end',
      'dnd_enabled', 'dnd_start', 'dnd_end',
      'lit_enabled', 'lit_time_start', 'lit_time_end', 'lit_standby', 'lit_working', 'lit_charging', 'lit_error',
      'consumable_blade', 'consumable_brush', 'consumable_robot',
    ];
    const deviceSettings = {};
    for (const k of settingKeys) {
      deviceSettings[k] = this.getSetting(k);
    }

    const cfgData = cfgResult.status === 'fulfilled' ? cfgResult.value : { error: cfgResult.reason?.message };
    // CMS is already included in the getCFG response — no separate API call needed.
    const cmsData = cfgData?.CMS ?? null;

    return {
      timestamp:        new Date().toISOString(),
      deviceId:         did,
      deviceName:       this.getName(),
      model:            this.getSetting('device_model') || '',
      available:        this.getAvailable(),
      rawResponse:      rawResponse.status  === 'fulfilled' ? rawResponse.value  : { error: rawResponse.reason?.message },
      deviceStatus:     deviceStatus.status === 'fulfilled' ? deviceStatus.value : { error: deviceStatus.reason?.message },
      cfgData,
      cmsData,
      capabilityValues,
      storeValues,
      deviceSettings,
    };
  }
}

module.exports = MowerDevice;
