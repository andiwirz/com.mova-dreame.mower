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
  {
    key: 'capabilities_migrated_v15',
    caps: ['mow_zone', 'mow_spot'],
  },
  {
    key: 'capabilities_migrated_v16',
    caps: ['cmd_start_mowing'],
  },
  {
    key: 'capabilities_migrated_v17',
    caps: ['cmd_start_spot_mowing'],
  },
  {
    // Reorder migration: removes all capabilities then re-adds in the desired display order.
    key: 'capabilities_migrated_v18',
    reorder: [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'mower_status',
      'mow_zone',
      'mow_spot',
      'charging_status',
      'measure_battery',
      'alarm_generic',
      'mow_efficiency',
      'collision_avoidance',
      'firmware_update',
      'measure_duration',
      'child_lock',
      'mower_volume',
      'consumable_blade',
      'consumable_brush',
      'consumable_robot',
    ],
  },
  {
    // Move mower_volume (slider) to position 3.
    key: 'capabilities_migrated_v19',
    reorder: [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'mower_volume',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'mower_status',
      'mow_zone',
      'mow_spot',
      'charging_status',
      'measure_battery',
      'alarm_generic',
      'mow_efficiency',
      'collision_avoidance',
      'firmware_update',
      'measure_duration',
      'child_lock',
      'consumable_blade',
      'consumable_brush',
      'consumable_robot',
    ],
  },
  {
    // Add cutting_height slider at position 3 (above mower_volume).
    key: 'capabilities_migrated_v20',
    reorder: [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cutting_height',
      'mower_volume',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'mower_status',
      'mow_zone',
      'mow_spot',
      'charging_status',
      'measure_battery',
      'alarm_generic',
      'mow_efficiency',
      'collision_avoidance',
      'firmware_update',
      'measure_duration',
      'child_lock',
      'consumable_blade',
      'consumable_brush',
      'consumable_robot',
    ],
  },
  {
    // Move cutting_height above mower_volume.
    key: 'capabilities_migrated_v21',
    reorder: [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cutting_height',
      'mower_volume',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'mower_status',
      'mow_zone',
      'mow_spot',
      'charging_status',
      'measure_battery',
      'alarm_generic',
      'mow_efficiency',
      'collision_avoidance',
      'firmware_update',
      'measure_duration',
      'child_lock',
      'consumable_blade',
      'consumable_brush',
      'consumable_robot',
    ],
  },
  {
    // Move mower_status and mow_zone before cutting_height so the slider appears
    // at position 3 in the icon row (buttons render separately, not in the icon row).
    key: 'capabilities_migrated_v22',
    reorder: [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'mower_status',
      'mow_zone',
      'cutting_height',
      'mower_volume',
      'mow_spot',
      'charging_status',
      'measure_battery',
      'alarm_generic',
      'mow_efficiency',
      'collision_avoidance',
      'firmware_update',
      'measure_duration',
      'child_lock',
      'consumable_blade',
      'consumable_brush',
      'consumable_robot',
    ],
  },
  {
    // Recovery: ensure mow_zone and mow_spot are present. A previous addCapability()
    // call may have failed silently (logged but swallowed), leaving the capability
    // absent even though the migration key was marked done.
    key: 'capabilities_migrated_v23',
    caps: ['mow_zone', 'mow_spot'],
  },
  {
    // Re-add cutting_height so Homey picks up the new setable/slider/min/max/step
    // definition from the updated capability JSON. Full reorder preserves display order.
    key: 'capabilities_migrated_v24',
    reorder: [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'mower_status',
      'mow_zone',
      'cutting_height',
      'mower_volume',
      'mow_spot',
      'charging_status',
      'measure_battery',
      'alarm_generic',
      'mow_efficiency',
      'collision_avoidance',
      'firmware_update',
      'measure_duration',
      'child_lock',
      'consumable_blade',
      'consumable_brush',
      'consumable_robot',
    ],
  },
  {
    // Re-add mow_efficiency so Homey picks up the new setable/picker definition.
    key: 'capabilities_migrated_v25',
    reorder: [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'mower_status',
      'mow_zone',
      'cutting_height',
      'mower_volume',
      'mow_spot',
      'charging_status',
      'measure_battery',
      'alarm_generic',
      'mow_efficiency',
      'collision_avoidance',
      'firmware_update',
      'measure_duration',
      'child_lock',
      'consumable_blade',
      'consumable_brush',
      'consumable_robot',
    ],
  },
  {
    // Add cmd_maintenance_point button after cmd_dock.
    key: 'capabilities_migrated_v26',
    reorder: [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'cmd_maintenance_point',
      'mower_status',
      'mow_zone',
      'cutting_height',
      'mower_volume',
      'mow_spot',
      'charging_status',
      'measure_battery',
      'alarm_generic',
      'mow_efficiency',
      'collision_avoidance',
      'firmware_update',
      'measure_duration',
      'child_lock',
      'consumable_blade',
      'consumable_brush',
      'consumable_robot',
    ],
  },
  {
    // Re-add lifetime statistics capabilities sourced from MIHIS action (mowing history).
    // Previously removed due to missing API endpoint — now confirmed via packet capture.
    // caps-only (no reorder) to avoid resetting existing capability values on existing installs.
    key: 'capabilities_migrated_v27',
    caps: ['meter_area_total', 'meter_time_total', 'meter_count_total'],
  },
  {
    // Reorder to place the three MIHIS statistics after measure_duration.
    // Separated from v27 so the caps-add step doesn't accidentally clear existing values.
    key: 'capabilities_migrated_v28',
    reorder: [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'cmd_maintenance_point',
      'mower_status',
      'mow_zone',
      'cutting_height',
      'mower_volume',
      'mow_spot',
      'charging_status',
      'measure_battery',
      'alarm_generic',
      'mow_efficiency',
      'collision_avoidance',
      'firmware_update',
      'measure_duration',
      'meter_area_total',
      'meter_time_total',
      'meter_count_total',
      'child_lock',
      'consumable_blade',
      'consumable_brush',
      'consumable_robot',
    ],
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
  // v9: replaced by action buttons
  'mower_mode',
  // v11: removed — redundant with mower_status
  'mower_docked', 'mower_mowing', 'mower_paused', 'mower_returning', 'task_active',
  // v11: removed — requires phone app to steer
  'cmd_manual_mowing',
  // v15: replaced by mow_zone / mow_spot pickers
  'cmd_all_area', 'cmd_edge_mowing',
  'cmd_zone_1', 'cmd_zone_2', 'cmd_zone_3', 'cmd_zone_4', 'cmd_zone_5',
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
    // Initialise all instance fields first so getDebugPollData() and capability
    // listeners never see `undefined` even if _migrate() or _initApi() throws.
    this._api                  = null;
    this._pollTimer            = null;
    // Initialise from persisted state so the session timer survives app restarts.
    // If the mower was already mowing before the restart, _wasMowing stays true and
    // _sessionStartTime is restored from the store (falls back to now if not stored yet).
    this._wasMowing        = this.getCapabilityValue('mower_status') === 'mowing';
    this._sessionStartTime = (await this.getStoreValue('session_start_time'))
                             ?? (this._wasMowing ? Date.now() : null);
    this._persistedTokenExpiry = 0;
    this._lastBindDomain       = null;  // track last seen bindDomain to avoid redundant setBindDomain calls
    this._activeMapIndex       = 0;     // active map index, updated from MAP data each poll
    this._activeZoneIds        = [];    // detected zone IDs from MAP data (e.g. [1, 2, 3])
    this._lastZonePickerKey    = null;  // cache key for _updateZonePicker change-guard
    this._lastSpotPickerKey    = null;  // cache key for _updateSpotPicker change-guard
    this._cfgPollCounter       = 0;     // reads CFG (WRP etc.) on first poll and every 10th thereafter
    this._mihisPollCounter     = 0;     // reads MIHIS (lifetime stats) on first poll and every 10th thereafter
    this._cachedPRE              = await this.getStoreValue('cached_pre') ?? null;  // last known PRE array; used for cutting_height read-modify-write
    this._cuttingHeightWriteTs   = 0;    // timestamp of last successful cutting_height write; guards poll snap-back
    this._preWriteCuttingHeight  = null; // capability value before last write; used to detect snap-back vs external change

    await this._migrate();

    // Flow trigger cards
    this._trgStatusChanged    = this.homey.flow.getDeviceTriggerCard('mower_status_changed');
    this._trgChargingChanged  = this.homey.flow.getDeviceTriggerCard('charging_status_changed');
    this._trgMowingCompleted  = this.homey.flow.getDeviceTriggerCard('mowing_completed');
    this._trgMowingStarted    = this.homey.flow.getDeviceTriggerCard('mowing_started');
    this._trgError            = this.homey.flow.getDeviceTriggerCard('mower_error');
    this._trgDocked           = this.homey.flow.getDeviceTriggerCard('mower_docked');
    this._trgFirmwareUpdate   = this.homey.flow.getDeviceTriggerCard('firmware_update_available');
    this._trgBatteryLow       = this.homey.flow.getDeviceTriggerCard('battery_low');
    this._trgConsumable       = this.homey.flow.getDeviceTriggerCard('consumable_needs_replacement');

    // ── Picker listeners ───────────────────────────────────────────────────────
    const did = this.getData().id;

    if (this.hasCapability('mow_zone')) {
      this.registerCapabilityListener('mow_zone', (value) => {
        this.log(`[mow_zone] selected: ${value}`);
      });
    }

    if (this.hasCapability('mow_spot')) {
      this.registerCapabilityListener('mow_spot', (value) => {
        this.log(`[mow_spot] selected: ${value}`);
      });
    }

    // ── Start mowing button (zone) ─────────────────────────────────────────────
    this.registerCapabilityListener('cmd_start_mowing', async (value) => {
      if (!value) return;
      try {
        const zone   = this.getCapabilityValue('mow_zone') ?? 'none';
        const mapIdx = this._activeMapIndex ?? 0;

        if (zone === 'all') {
          this.log('[cmd] start mowing: all areas');
          await this._safeWrite('mow_zone:all', () => this._api.startMowing(did));
        } else if (zone === 'edge_all') {
          this.log(`[cmd] start mowing: edge all mapIndex=${mapIdx}`);
          await this._safeWrite('mow_zone:edge_all', () => this._api.startEdgeMowing(did, mapIdx));
        } else if (zone.startsWith('zone_')) {
          const zoneId = parseInt(zone.slice(5), 10);
          this.log(`[cmd] start mowing: zone ${zoneId} mapIndex=${mapIdx}`);
          await this._safeWrite(`mow_zone:zone_${zoneId}`, () => this._api.startZoneMowing(did, [zoneId], mapIdx));
        } else if (zone.startsWith('edge_')) {
          const zoneId = parseInt(zone.slice(5), 10);
          this.log(`[cmd] start mowing: edge zone ${zoneId} mapIndex=${mapIdx}`);
          await this._safeWrite(`mow_zone:edge_${zoneId}`, () => this._api.startEdgeZoneMowing(did, zoneId, mapIdx));
        } else {
          this.log('[cmd_start_mowing] no zone selected — nothing to start');
          return;
        }

        await this._setMowingStarted();
      } catch (err) {
        this.error('[cmd_start_mowing] listener error:', err.message);
      } finally {
        await this.setCapabilityValue('cmd_start_mowing', false).catch(() => {});
      }
    });

    // ── Start spot mowing button ───────────────────────────────────────────────
    this.registerCapabilityListener('cmd_start_spot_mowing', async (value) => {
      if (!value) return;
      try {
        const spot   = this.getCapabilityValue('mow_spot') ?? 'none';
        const mapIdx = this._activeMapIndex ?? 0;

        if (spot === 'none') {
          this.log('[cmd_start_spot_mowing] no spot selected — nothing to start');
          return;
        }

        const spotId = parseInt(spot.slice(5), 10); // 'spot_1002' → 1002
        this.log(`[cmd] start spot mowing: spot ${spotId} mapIndex=${mapIdx}`);
        await this._safeWrite(`mow_spot:${spotId}`, () => this._api.startSpotMowing(did, [spotId], mapIdx));
        await this._setMowingStarted();
      } catch (err) {
        this.error('[cmd_start_spot_mowing] listener error:', err.message);
      } finally {
        await this.setCapabilityValue('cmd_start_spot_mowing', false).catch(() => {});
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

    if (this.hasCapability('cmd_maintenance_point')) {
      this.registerCapabilityListener('cmd_maintenance_point', async (value) => {
        if (!value) return;
        try {
          this.log('[cmd] btn: maintenance point → goToMaintenancePoint()');
          await this._safeWrite('cmd_maintenance_point', () => this._api.goToMaintenancePoint(did, this._activeMapIndex ?? 0));
        } catch (err) {
          this.error('[cmd_maintenance_point] listener error:', err.message);
        } finally {
          await this.setCapabilityValue('cmd_maintenance_point', false).catch(() => {});
        }
      });
    }

    this.registerCapabilityListener('mower_volume', async (value) => {
      try {
        await this._safeWrite('mower_volume', () => this._api.setVolume(did, value));
      } catch (err) {
        this.error('[mower_volume] listener error:', err.message);
      }
    });

    this.registerCapabilityListener('cutting_height', async (value) => {
      try {
        this._ensureCachedPRE();
        const pre = [...this._cachedPRE];
        pre[4] = Math.round(value);
        this._preWriteCuttingHeight = this.getCapabilityValue('cutting_height');
        this.log(`[cutting_height] writing PRE[4]=${pre[4]}mm`);
        await this._api.writePRE(did, pre);
        this._cachedPRE            = pre;
        this._cuttingHeightWriteTs = Date.now();
        this.log('[cutting_height] write OK — poll overwrite suppressed for 90s');
      } catch (err) {
        this.error('[cutting_height] listener error:', err.message);
        throw err;
      }
    });

    this.registerCapabilityListener('mow_efficiency', async (value) => {
      try {
        this._ensureCachedPRE();
        const pre = [...this._cachedPRE];
        pre[3] = value === 'efficient' ? 1 : 0;
        this.log(`[mow_efficiency] writing PRE[3]=${pre[3]} (${value})`);
        await this._api.writePRE(did, pre);
        this._cachedPRE = pre;
        this.log('[mow_efficiency] write OK');
      } catch (err) {
        this.error('[mow_efficiency] listener error:', err.message);
        throw err;
      }
    });

    this._applyCuttingHeightOptions();

    await this._initApi();

    // Fetch current device config before starting the poll loop so the settings
    // page always shows real device values the moment the user opens it.
    const cfg = await this._api.getCFG(did).catch((e) => {
      this.error('[init] getCFG failed:', e.message);
      return null;
    });
    if (cfg) await this._applyCFGSettings(cfg);

    const mihis = await this._api.getMowingHistory(did).catch((e) => {
      this.error('[init] getMowingHistory failed:', e.message);
      return null;
    });
    if (mihis) await this._applyMIHIS(mihis);

    // Skip the redundant getCFG / MIHIS on the very first poll since we fetch them at init.
    this._cfgPollCounter   = 1;
    this._mihisPollCounter = 1;

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

    if (changedKeys.includes('cutting_height_min') || changedKeys.includes('cutting_height_max')) {
      this._applyCuttingHeightOptions(newSettings);
    }

    // PRE-backed settings: edge mowing + obstacle avoidance
    const PRE_SETTINGS_MAP = {
      edge_mowing_auto:     { index: 7,  bool: true },
      edge_mowing_safe:     { index: 8,  bool: true },
      edge_mowing_ultratrim:{ index: 9,  bool: true },
      edge_mowing_obstacle: { index: 11, bool: true },
      obstacle_lidar:       { index: 16, bool: true },
      obstacle_height:      { index: 13 },
      obstacle_distance:    { index: 14 },
      obstacle_ai:          { index: 15 },
    };
    const preKeys = Object.keys(PRE_SETTINGS_MAP).filter((k) => changedKeys.includes(k));
    if (preKeys.length > 0) {
      this._ensureCachedPRE();
      const pre = [...this._cachedPRE];
      for (const key of preKeys) {
        const { index, bool } = PRE_SETTINGS_MAP[key];
        pre[index] = bool ? (newSettings[key] ? 1 : 0) : Number(newSettings[key]);
      }
      this.log(`[settings] PRE update for: ${preKeys.join(', ')}`);
      await this._safeWrite('pre', () => this._api.writePRE(did, pre));
      this._cachedPRE = pre;
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

  }

  // ─── Migration ─────────────────────────────────────────────────────────────

  async _migrate() {
    // Fast-path for freshly paired devices: capabilities are already installed
    // in the correct final order by driver.compose.json, so historic migrations
    // (adds and reorders) are all no-ops. Mark them done immediately so we don't
    // run dozens of addCapability/removeCapability cycles on every new device.
    // Only the recovery migration (the last entry) is always allowed to run.
    const [firstMigration, ...rest] = MIGRATIONS;
    const lastMigration = rest.at(-1) ?? firstMigration;
    const isFirstRun = !(await this.getStoreValue(firstMigration.key));
    if (isFirstRun) {
      for (const { key } of MIGRATIONS) {
        if (key === lastMigration.key) continue; // let the recovery migration run
        await this.setStoreValue(key, true);
      }
    }

    for (const { key, caps, reorder } of MIGRATIONS) {
      if (await this.getStoreValue(key)) continue;

      if (reorder) {
        // Reorder migration: remove all listed capabilities, then re-add in the
        // desired order. Homey preserves add-order as the display order.
        for (const cap of reorder) {
          if (this.hasCapability(cap)) {
            await this.removeCapability(cap).catch((e) => this.error('removeCapability', cap, e.message));
          }
        }
        for (const cap of reorder) {
          await this.addCapability(cap).catch((e) => this.error('addCapability', cap, e.message));
        }
      } else {
        for (const cap of caps) {
          if (!this.hasCapability(cap)) {
            await this.addCapability(cap).catch((e) => this.error('addCapability', cap, e.message));
          }
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
      await this._setCap('measure_duration', mins);
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

    // ── Mowing history (MIHIS) — first poll and every 10th thereafter ─────────
    if (this._mihisPollCounter % 10 === 0) {
      const mihis = await this._api.getMowingHistory(did).catch((e) => {
        this.error('[mihis] getMowingHistory failed:', e.message);
        return null;
      });
      if (mihis) await this._applyMIHIS(mihis);
    }
    this._mihisPollCounter++;

    // ── SETTINGS.0 / OTA_INFO.0 / MAP zone detection ────────────────────────
    if (rawResult.status === 'fulfilled') {
      const rawData = rawResult.value?.data;
      if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
await this._applyMOVASettings(rawData);
        await this._applyOTAInfo(rawData);
        await this._detectAndSyncZones(rawData);
      }
    } else {
      this.error('[poll] rawProperties failed:', rawResult.reason?.message);
    }

    if (!this.getAvailable()) await this.setAvailable();
  }

  // ─── Write helper ─────────────────────────────────────────────────────────

  /**
   * Apply cutting_height min/max from device settings to the capability options.
   * Falls back to the global capability defaults (20–70 mm) when not configured.
   * @param {object} [s]  Settings object; omit to read from this.getSetting().
   */
  _applyCuttingHeightOptions(s) {
    const get = (key, def) => s ? (s[key] ?? def) : (this.getSetting(key) ?? def);
    const min = Number(get('cutting_height_min', 20)) || 20;
    const max = Number(get('cutting_height_max', 70)) || 70;
    this.log(`[cutting_height] options → min=${min}mm max=${max}mm`);
    this.setCapabilityOptions('cutting_height', { min, max }).catch((e) =>
      this.error('[cutting_height] setCapabilityOptions:', e.message),
    );
  }

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

  // ─── Picker management ────────────────────────────────────────────────────

  /**
   * Scan MAP.N chunks for zone and spot IDs, then update the num_zones setting
   * and both pickers. Exits early when nothing has changed.
   * Called every poll cycle (cheap due to change-guard caches).
   */
  async _detectAndSyncZones(raw) {
    const { ids: detectedIds, spotIds, mapIndex } = this._extractMapInfo(raw);

    if (mapIndex !== this._activeMapIndex) {
      this.log(`[zones] active map index: ${this._activeMapIndex} → ${mapIndex}`);
      this._activeMapIndex = mapIndex;
    }

    this._activeZoneIds = detectedIds;

    if (detectedIds.length > 0) {
      const capped  = Math.min(detectedIds.length, 5);
      const current = parseInt(this.getSetting('num_zones'), 10) || 0;
      if (capped !== current) {
        this.log(`[zones] auto-detected ${detectedIds.length} zone(s) [${detectedIds.join(',')}] — updating num_zones ${current} → ${capped}`);
        await this.setSettings({ num_zones: String(capped) }).catch((e) => this.error('setSettings num_zones:', e.message));
      }
      await this._updateZonePicker(detectedIds);
    }

    if (spotIds.length > 0) {
      await this._updateSpotPicker(spotIds);
    }
  }

  /**
   * Concatenate MAP.N chunks and extract:
   *   - ids:      sorted list of distinct mowing zone IDs (e.g. [1, 2, 3])
   *   - spotIds:  sorted list of distinct clean spot IDs (e.g. [1001, 1002])
   *   - mapIndex: the active map's mapIndex value (0-based)
   *
   * Zone entries: [N,{ where N is 1–99 inside the mowingAreas section.
   * Spot entries: [N,{ where N is 1000–9999 inside the cleanSpots section.
   * Returns { ids: [], spotIds: [], mapIndex: 0 } when no map data is present.
   */
  _extractMapInfo(raw) {
    const parts = [];
    for (let i = 0; raw[`MAP.${i}`] != null; i++) parts.push(raw[`MAP.${i}`]);
    const mapStr = parts.join('');
    if (!mapStr) return { ids: [], spotIds: [], mapIndex: 0 };

    // Extract active mapIndex (first occurrence — belongs to the active map)
    const mapIndexMatch = mapStr.match(/"mapIndex":(\d+)/);
    const mapIndex = mapIndexMatch ? parseInt(mapIndexMatch[1], 10) : 0;

    // ── Zone IDs from mowingAreas section ──────────────────────────────────
    const idSet = new Set();
    const maIdx = mapStr.indexOf('mowingAreas');
    if (maIdx !== -1) {
      const endIdx = mapStr.indexOf('forbiddenAreas', maIdx);
      const section = mapStr.slice(maIdx, endIdx === -1 ? maIdx + 4000 : endIdx);
      for (const m of section.matchAll(/\[(\d{1,3}),\{/g)) {
        const id = parseInt(m[1], 10);
        if (id >= 1 && id <= 99) idSet.add(id);
      }
    }

    // ── Spot IDs ────────────────────────────────────────────────────────────
    // Spot IDs are ≥ 1000. The containing key varies by firmware/brand:
    // known candidates are cleanSpots, spots, customAreas, virtualSpots.
    // Strategy: try each candidate name; if none matched, fall back to a
    // whole-map scan for [NNNN,{ patterns outside the mowingAreas section.
    const spotSet = new Set();
    const SPOT_SECTION_NAMES = ['cleanSpots', 'spots', 'customAreas', 'virtualSpots'];
    let spotSectionFound = false;

    for (const name of SPOT_SECTION_NAMES) {
      const idx = mapStr.indexOf(name);
      if (idx === -1) continue;
      spotSectionFound = true;
      const section = mapStr.slice(idx, idx + 8000);
      for (const m of section.matchAll(/\[(\d{4,5}),\{/g)) {
        const id = parseInt(m[1], 10);
        if (id >= 1000 && id <= 99999) spotSet.add(id);
      }
      // Also match {"id":NNNN} style entries in the same section
      for (const m of section.matchAll(/"id"\s*:\s*(\d{4,5})/g)) {
        const id = parseInt(m[1], 10);
        if (id >= 1000 && id <= 99999) spotSet.add(id);
      }
      break;
    }

    if (!spotSectionFound) {
      // Fallback: scan the whole MAP string (excluding mowingAreas) for 4-digit IDs

      // Still try to find 4-digit IDs outside of the mowingAreas section
      const noMa = maIdx !== -1 ? mapStr.slice(0, maIdx) + mapStr.slice(maIdx + 4000) : mapStr;
      for (const m of noMa.matchAll(/\[(\d{4,5}),\{/g)) {
        const id = parseInt(m[1], 10);
        if (id >= 1000 && id <= 99999) spotSet.add(id);
      }
      for (const m of noMa.matchAll(/"id"\s*:\s*(\d{4,5})/g)) {
        const id = parseInt(m[1], 10);
        if (id >= 1000 && id <= 99999) spotSet.add(id);
      }
    }

    return {
      ids:      [...idSet].sort((a, b) => a - b),
      spotIds:  [...spotSet].sort((a, b) => a - b),
      mapIndex,
    };
  }

  /**
   * Rebuild the mow_zone picker values from detected zone IDs.
   * Adds: all areas, per-zone entries, edge: all areas, per-zone edge entries.
   * Change-guarded — no-ops when the zone list is unchanged.
   */
  async _updateZonePicker(zoneIds) {
    const key = zoneIds.join(',');
    if (key === this._lastZonePickerKey) return;
    this._lastZonePickerKey = key;

    const values = [
      { id: 'none',     title: { en: '— Select —',      de: '— Auswählen —' } },
      { id: 'all',      title: { en: 'All areas',        de: 'Alle Flächen' } },
    ];
    for (const id of zoneIds) {
      values.push({ id: `zone_${id}`, title: { en: `Zone ${id}`, de: `Zone ${id}` } });
    }
    values.push({ id: 'edge_all', title: { en: 'Edge: all areas', de: 'Kante: Alle Flächen' } });
    for (const id of zoneIds) {
      values.push({ id: `edge_${id}`, title: { en: `Edge: Zone ${id}`, de: `Kante: Zone ${id}` } });
    }

    this.log(`[picker] mow_zone updated: ${values.map((v) => v.id).join(', ')}`);
    await this.setCapabilityOptions('mow_zone', { values })
      .catch((e) => this.error('setCapabilityOptions mow_zone:', e.message));
  }

  /**
   * Rebuild the mow_spot picker values from detected spot IDs.
   * Change-guarded — no-ops when the spot list is unchanged.
   */
  async _updateSpotPicker(spotIds) {
    const key = spotIds.join(',');
    if (key === this._lastSpotPickerKey) return;
    this._lastSpotPickerKey = key;

    const values = [
      { id: 'none', title: { en: '— Select spot —', de: '— Spot auswählen —' } },
    ];
    for (const id of spotIds) {
      values.push({ id: `spot_${id}`, title: { en: `Spot ${id}`, de: `Spot ${id}` } });
    }

    this.log(`[picker] mow_spot updated: ${values.map((v) => v.id).join(', ')}`);
    await this.setCapabilityOptions('mow_spot', { values })
      .catch((e) => this.error('setCapabilityOptions mow_spot:', e.message));
  }

  // ─── Repair / re-authentication ───────────────────────────────────────────

  /**
   * Called by the repair flow after the user has re-authenticated.
   * Updates the in-memory API instance and forces the next _persistTokensIfChanged
   * to write the new tokens to the store immediately.
   */
  async updateTokens({ accessToken, refreshToken, tokenExpiry }) {
    this._api.setTokens({ accessToken, refreshToken, tokenExpiry });
    this._persistedTokenExpiry = 0; // force persist on next successful poll
    await Promise.all([
      this.setStoreValue('access_token',  accessToken),
      this.setStoreValue('refresh_token', refreshToken),
      this.setStoreValue('token_expiry',  tokenExpiry),
    ]);
    await this.setAvailable();
    this.log('[repair] tokens updated — device marked available');
  }

  // ─── Poll helpers ─────────────────────────────────────────────────────────

  /** Persist refreshed tokens only when they actually changed (saves ~6,900 store writes/day). */
  async _persistTokensIfChanged() {
    const tk = this._api.getTokens();
    if (tk.tokenExpiry === this._persistedTokenExpiry) return;
    await Promise.all([
      this.setStoreValue('access_token',  tk.accessToken),
      this.setStoreValue('refresh_token', tk.refreshToken),
      this.setStoreValue('token_expiry',  tk.tokenExpiry),
    ]);
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
   * Build a fallback PRE array from current Homey capability values and device settings.
   * Used when _cachedPRE is null (SETTINGS.0 not yet received after a restart).
   * All obstacle/edge fields are read from synced device settings; height and efficiency
   * from current capability values. Remaining fields use confirmed safe defaults.
   */
  /** Ensure _cachedPRE is populated, falling back to a device-settings reconstruction. */
  _ensureCachedPRE() {
    if (!this._cachedPRE || this._cachedPRE.length < 19) {
      this.log('[pre] _cachedPRE unavailable — rebuilding from device settings');
      this._cachedPRE = this._buildPREFallback();
    }
  }

  _buildPREFallback() {
    const b = (v) => (v ? 1 : 0);
    const heightMm = this.getCapabilityValue('cutting_height') ?? 40;
    return [
      0,                                                                         // [0]  reserved
      0,                                                                         // [1]  reserved
      0,                                                                         // [2]  reserved
      this.getCapabilityValue('mow_efficiency') === 'efficient' ? 1 : 0,        // [3]  efficientMode
      Math.round(heightMm),                                                      // [4]  mowingHeight (mm)
      1,                                                                         // [5]  edgeMowingWalkMode
      0,                                                                         // [6]  mowingDirection
      b(this.getSetting('edge_mowing_auto')      ?? true),                       // [7]  edgeMowingAuto
      b(this.getSetting('edge_mowing_safe')      ?? true),                       // [8]  edgeMowingSafe
      b(this.getSetting('edge_mowing_ultratrim') ?? true),                       // [9]  cutterPosition
      1,                                                                         // [10] edgeMowingNum
      b(this.getSetting('edge_mowing_obstacle')  ?? true),                       // [11] edgeMowingObstacleAvoidance
      1,                                                                         // [12] mowingDirectionMode
      Number(this.getSetting('obstacle_height')   ?? 15),                        // [13] obstacleAvoidanceHeight
      Number(this.getSetting('obstacle_distance') ?? 15),                        // [14] obstacleAvoidanceDistance
      Number(this.getSetting('obstacle_ai')       ?? 7),                         // [15] obstacleAvoidanceAi
      b(this.getSetting('obstacle_lidar')         ?? true),                      // [16] obstacleAvoidanceEnabled
      1,                                                                         // [17] ridingMowingmode
      5,                                                                         // [18] ridingMowingDistance
    ];
  }

  /**
   * Reconstruct the 19-element PRE config array from the zone-0 SETTINGS object.
   *
   * The device does not expose PRE via any readable API (getCFG returns a [0,0]
   * stub; a direct getPRE action returns r:3). Instead we rebuild it here from the
   * SETTINGS fields the device reports on every poll. The field-to-index mapping
   * was confirmed by correlating a live packet capture of the official MOVA app
   * writing PRE with the simultaneously reported SETTINGS values.
   *
   * @param {object} s  Zone-0 settings object (mapEntry.settings["0"])
   * @returns {number[]|null}  19-element PRE array, or null if mowingHeight absent
   */
  _buildPREFromSettings(s) {
    if (!s || s.mowingHeight == null) return null;
    return [
      0,                                          // [0]  reserved
      0,                                          // [1]  reserved
      0,                                          // [2]  reserved
      s.efficientMode               ?? 1,         // [3]  efficientMode
      Math.round(Number(s.mowingHeight) * 10),    // [4]  mowingHeight cm → mm
      s.edgeMowingWalkMode          ?? 1,         // [5]  edgeMowingWalkMode
      s.mowingDirection             ?? 0,         // [6]  mowingDirection (angle)
      s.edgeMowingAuto              ?? 1,         // [7]  edgeMowingAuto
      s.edgeMowingSafe              ?? 1,         // [8]  edgeMowingSafe
      s.cutterPosition              ?? 1,         // [9]  cutterPosition
      s.edgeMowingNum               ?? 1,         // [10] edgeMowingNum
      s.edgeMowingObstacleAvoidance ?? 1,         // [11] edgeMowingObstacleAvoidance
      s.mowingDirectionMode         ?? 1,         // [12] mowingDirectionMode
      s.obstacleAvoidanceHeight     ?? 15,        // [13] obstacleAvoidanceHeight
      s.obstacleAvoidanceDistance   ?? 15,        // [14] obstacleAvoidanceDistance
      s.obstacleAvoidanceAi         ?? 7,         // [15] obstacleAvoidanceAi
      s.obstacleAvoidanceEnabled    ?? 1,         // [16] obstacleAvoidanceEnabled
      s.ridingMowingmode            ?? 1,         // [17] ridingMowingmode
      s.ridingMowingDistance        ?? 5,         // [18] ridingMowingDistance
    ];
  }

  /**
   * Apply lifetime mowing statistics from the MIHIS action response.
   *
   * MIHIS response d-object: { area: m², count: sessions, time: minutes, start: unixTs }
   * Confirmed via packet capture — siid:2, aiid:50, in:[{m:'g', t:'MIHIS'}].
   * @param {object} result  The out[0] object returned by getMowingHistory()
   */
  async _applyMIHIS(result) {
    const d = result?.d;
    if (!d) {
      this.error('[mihis] no d-object in result:', JSON.stringify(result));
      return;
    }
    this.log(`[mihis] area=${d.area} time=${d.time} count=${d.count}`);
    await Promise.all([
      d.area  != null && this.hasCapability('meter_area_total')  && this._setCap('meter_area_total',  Math.round(d.area)),
      // d.time is total minutes; convert to hours with 1 decimal: Math.round(min/6)/10 = Math.round(h*10)/10
      d.time  != null && this.hasCapability('meter_time_total')  && this._setCap('meter_time_total',  Math.round(d.time / 6) / 10),
      d.count != null && this.hasCapability('meter_count_total') && this._setCap('meter_count_total', d.count),
    ]);
  }

  /**
   * Parse the SETTINGS.0 key-value blob and map known fields to
   * Homey capabilities and device settings.
   *
   * SETTINGS.0 is a JSON array where each element represents a mowing zone:
   *   [ { mode: 0, settings: { "0": { efficientMode, mowingHeight, … } } }, … ]
   * We use zone 0 / settings["0"] as the active device-wide configuration.
   */
  async _applyMOVASettings(raw) {
    // SETTINGS pages are byte-chunked. Each boundary may land mid-JSON, so we concatenate
    // pages one-by-one and stop at the first successful parse. Known behaviour: SETTINGS.0
    // alone is truncated; SETTINGS.0+SETTINGS.1 produces a complete zones array. Additional
    // pages (SETTINGS.2+) contain supplementary zone data that would overflow the closed array
    // — they cannot be appended and are intentionally ignored here.
    let zones = null;
    let accumulated = '';
    for (let i = 0; raw[`SETTINGS.${i}`] != null; i++) {
      accumulated += raw[`SETTINGS.${i}`] ?? '';
      try {
        const parsed = JSON.parse(accumulated);
        if (Array.isArray(parsed) && parsed.length > 0) { zones = parsed; break; }
      } catch { /* incomplete chunk — append next page and retry */ }
    }
    if (accumulated === '') {
      this.log('[settings] SETTINGS.0 not present in this poll response');
      return;
    }
    if (!zones) {
      this.log('[settings] could not parse SETTINGS into a valid zones array');
      return;
    }

    // Use the active map's settings; fall back to map 0 if not yet detected.
    const mapEntry = zones[this._activeMapIndex ?? 0] ?? zones[0];
    const s = mapEntry?.settings?.['0'] ?? mapEntry?.settings ?? mapEntry ?? {};

    // Rebuild the PRE array from SETTINGS fields on every poll so it's always
    // fresh and ready for cutting_height write operations (read-modify-write).
    // The device doesn't expose PRE via any readable API; we reconstruct it here.
    const builtPRE = this._buildPREFromSettings(s);
    if (builtPRE) {
      const changed = JSON.stringify(builtPRE) !== JSON.stringify(this._cachedPRE);
      this._cachedPRE = builtPRE;
      if (changed) this.setStoreValue('cached_pre', builtPRE).catch((e) => this.error('[settings] cached_pre store failed:', e.message));
    }

    // Capability updates (change-guarded)
    if (s.efficientMode != null) {
      await this._setCap('mow_efficiency', s.efficientMode === 1 ? 'efficient' : 'standard');
    }
    if (s.obstacleAvoidanceEnabled != null) {
      await this._applyBoolCap('collision_avoidance', s.obstacleAvoidanceEnabled);
    }

    // mowingHeight is stored in centimetres in SETTINGS (e.g. 4.5 cm = 45 mm).
    // Multiply by 10 to convert to mm for the capability display.
    // Skip the update for 90s after a slider write so the mower has time to apply
    // the new height before SETTINGS.0 reflects it (avoids the slider snapping back).
    if (s.mowingHeight != null && this.hasCapability('cutting_height')) {
      const height = Math.round(Number(s.mowingHeight) * 10);
      const zoneHeights = Object.entries(mapEntry?.settings ?? {})
        .map(([k, v]) => `zone${k}=${v?.mowingHeight}cm`)
        .join(' | ');
      this.log(`[settings] mowingHeight=${s.mowingHeight}cm → ${height}mm | ${zoneHeights}`);
      const withinWindow = Date.now() - this._cuttingHeightWriteTs < 90_000;
      const isSnapBack   = withinWindow && height === this._preWriteCuttingHeight;
      if (isSnapBack) {
        // Device still reporting the old value while our write propagates — suppress snap-back.
        this.log('[settings] cutting_height poll suppressed (device still applying write)');
      } else {
        if (withinWindow) this._cuttingHeightWriteTs = 0; // write confirmed or external change — stop suppressing
        await this._setCap('cutting_height', height);
      }
    }

    // Sync edge-mowing + obstacle-avoidance device settings from SETTINGS poll.
    // Change-guarded: only calls setSettings when at least one value differs.
    {
      const update = {};
      const b = (v) => v === 1 || v === true;
      if (s.edgeMowingAuto              != null && this.getSetting('edge_mowing_auto')      !== b(s.edgeMowingAuto))              update.edge_mowing_auto      = b(s.edgeMowingAuto);
      if (s.edgeMowingSafe              != null && this.getSetting('edge_mowing_safe')      !== b(s.edgeMowingSafe))              update.edge_mowing_safe      = b(s.edgeMowingSafe);
      if (s.cutterPosition              != null && this.getSetting('edge_mowing_ultratrim') !== b(s.cutterPosition))              update.edge_mowing_ultratrim = b(s.cutterPosition);
      if (s.edgeMowingObstacleAvoidance != null && this.getSetting('edge_mowing_obstacle')  !== b(s.edgeMowingObstacleAvoidance)) update.edge_mowing_obstacle  = b(s.edgeMowingObstacleAvoidance);
      if (s.obstacleAvoidanceEnabled    != null && this.getSetting('obstacle_lidar')        !== b(s.obstacleAvoidanceEnabled))    update.obstacle_lidar        = b(s.obstacleAvoidanceEnabled);
      if (s.obstacleAvoidanceHeight     != null && this.getSetting('obstacle_height')       !== String(s.obstacleAvoidanceHeight)) update.obstacle_height      = String(s.obstacleAvoidanceHeight);
      if (s.obstacleAvoidanceDistance   != null && this.getSetting('obstacle_distance')     !== String(s.obstacleAvoidanceDistance)) update.obstacle_distance  = String(s.obstacleAvoidanceDistance);
      if (s.obstacleAvoidanceAi         != null && this.getSetting('obstacle_ai')           !== String(s.obstacleAvoidanceAi))    update.obstacle_ai           = String(s.obstacleAvoidanceAi);
      if (Object.keys(update).length > 0) {
        await this.setSettings(update).catch((e) => this.error('[settings] setSettings failed:', e.message));
      }
    }

    // child_lock: MOVA may expose this as prop.s_child_lock
    const clProp = raw['prop.s_child_lock'] ?? raw['prop.child_lock'];
    if (clProp != null && this.hasCapability('child_lock')) {
      await this._applyBoolCap('child_lock', clProp === '1' || clProp === 1 || clProp === true);
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

    // PRE is not readable via getCFG (returns stub [0,0]) — reconstructed from SETTINGS instead.

    // VOL — volume: scalar 0–100
    if (cfg.VOL != null && this.hasCapability('mower_volume')) {
      await this._setCap('mower_volume', Number(cfg.VOL));
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
      const CMS_MAX   = [6000, 30000, 3600];
      const caps      = ['consumable_blade', 'consumable_brush', 'consumable_robot'];
      const typeNames = ['blade', 'brush', 'robot'];
      await Promise.all(caps.map(async (cap, i) => {
        if (!this.hasCapability(cap)) return;
        const prev = this.getCapabilityValue(cap);
        const pct  = Math.max(0, Math.round((1 - cfg.CMS[i] / CMS_MAX[i]) * 100));
        await this._setCap(cap, pct);
        // Fire consumable trigger when value decreases (threshold filtering handled by run-listener)
        if (prev !== null && pct < prev) {
          this._trgConsumable
            .trigger(this, { consumable_type: typeNames[i], remaining_pct: pct }, { pct })
            .catch((e) => this.error('consumable_needs_replacement trigger:', e.message));
        }
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

  /**
   * Parse OTA_INFO.0 from the raw poll response and update firmware_update capability.
   * Called directly from the poll loop so it runs even when SETTINGS.0 is absent.
   * OTA_INFO.0 = JSON array "[state, updateAvailable]" — index 1 === 1 means update available.
   */
  async _applyOTAInfo(raw) {
    const otaStr = raw['OTA_INFO.0'];
    if (!otaStr) return;
    try {
      const ota = JSON.parse(otaStr);
      if (Array.isArray(ota) && ota.length >= 2) {
        await this._applyFirmwareState(ota[1]);
      }
    } catch { /* malformed OTA_INFO, skip */ }
  }

  // ─── Capability helpers ───────────────────────────────────────────────────

  async _applyFirmwareState(state) {
    const updateAvailable = state === 1;
    const prev = this.getCapabilityValue('firmware_update');
    await this._setCap('firmware_update', updateAvailable);
    if (updateAvailable && !prev) {
      this._trgFirmwareUpdate.trigger(this, {}, {})
        .catch((e) => this.error('firmware_update_available trigger:', e.message));
    }
  }

  async _setCap(capId, value) {
    const prev = this.getCapabilityValue(capId);
    if (prev === value) return;
    this.log(`[cap] ${capId}: ${JSON.stringify(prev)} → ${JSON.stringify(value)}`);
    await this.setCapabilityValue(capId, value).catch((e) => this.error(`[cap] setCapabilityValue ${capId}:`, e.message));
  }

  async _applyBoolCap(capId, value) {
    await this._setCap(capId, value === 1 || value === true);
  }

  async _applyBattery(pct) {
    const prev = this.getCapabilityValue('measure_battery');
    await this._setCap('measure_battery', pct);
    if (prev !== null && pct < prev) {
      this._trgBatteryLow.trigger(this, {}, {})
        .catch((e) => this.error('battery_low trigger:', e.message));
    }
  }

  async _applyChargingStatus(code) {
    const status = CHARGING_MAP[code] ?? 'not_docked';
    if (status === this.getCapabilityValue('charging_status')) return;
    await this._setCap('charging_status', status);
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
    if (this.hasCapability('mower_task_status')) {
      await this._setCap('mower_task_status', taskStatus);
    }

    if (status === prev) return;

    await this._setCap('mower_status', status);

    this._trgStatusChanged
      .trigger(this, { status }, {})
      .catch((e) => this.error('status_changed trigger:', e.message));

    // Session duration tracking
    if (isMowing && !this._wasMowing) {
      // New mowing session started — record and persist the start time.
      this._sessionStartTime = Date.now();
      this.setStoreValue('session_start_time', this._sessionStartTime).catch(() => {});
      if (this.hasCapability('measure_duration')) {
        await this._setCap('measure_duration', 0);
      }
      this._trgMowingStarted.trigger(this, {}, {})
        .catch((e) => this.error('mowing_started trigger:', e.message));
    } else if (!isMowing && this._wasMowing) {
      // Session ended — clear the persisted start time.
      this._sessionStartTime = null;
      this.setStoreValue('session_start_time', null).catch(() => {});
    }

    // Error alarm
    const isError = status === 'error';
    await this._setCap('alarm_generic', isError);
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
      if (this.hasCapability('cmd_dock'))                await this.setCapabilityValue('cmd_dock',                false).catch(() => {});
      if (this.hasCapability('cmd_stop'))                await this.setCapabilityValue('cmd_stop',                false).catch(() => {});
      if (this.hasCapability('cmd_start_mowing'))        await this.setCapabilityValue('cmd_start_mowing',        false).catch(() => {});
      if (this.hasCapability('cmd_start_spot_mowing'))   await this.setCapabilityValue('cmd_start_spot_mowing',   false).catch(() => {});
      if (this.hasCapability('cmd_maintenance_point'))   await this.setCapabilityValue('cmd_maintenance_point',   false).catch(() => {});
    }

    // Reset pause button once the mower confirms it is paused
    if (status === 'paused' && this.hasCapability('cmd_pause')) {
      await this.setCapabilityValue('cmd_pause', false).catch(() => {});
    }
    // Pickers (mow_zone / mow_spot) intentionally keep their selection so the user
    // can re-run the same zone or spot by pressing cmd_start_mowing again.

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

  async cmdStartBorderPatrol(zoneNum) {
    const did    = this.getData().id;
    const mapIdx = this._activeMapIndex ?? 0;
    this.log(`[cmd] startBorderPatrol zone=${zoneNum} mapIndex=${mapIdx}`);
    await this._api.startBorderPatrol(did, Number(zoneNum), mapIdx);
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

  async cmdSetCuttingHeight(height) {
    this.log(`[cmd] setCuttingHeight height=${height}mm`);
    this._ensureCachedPRE();
    const pre = [...this._cachedPRE];
    pre[4] = Math.round(height);
    this._preWriteCuttingHeight = this.getCapabilityValue('cutting_height');
    await this._api.writePRE(this.getData().id, pre);
    this._cachedPRE            = pre;
    this._cuttingHeightWriteTs = Date.now();
    await this._setCap('cutting_height', height);
  }

  async cmdGoToMaintenancePoint() {
    this.log('[cmd] goToMaintenancePoint');
    await this._api.goToMaintenancePoint(this.getData().id, this._activeMapIndex ?? 0);
  }

  async cmdSetEfficiencyMode(mode) {
    this.log(`[cmd] setEfficiencyMode mode=${mode}`);
    this._ensureCachedPRE();
    const pre = [...this._cachedPRE];
    pre[3] = mode === 'efficient' ? 1 : 0;
    await this._api.writePRE(this.getData().id, pre);
    this._cachedPRE = pre;
    await this._setCap('mow_efficiency', mode);
  }

  // ─── Debug API (called by settings/index.html via api.js) ─────────────────

  async getDebugPollData() {
    if (!this._api) throw new Error('Device not initialised yet — please wait and try again');

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

    // Settings snapshot — all keys, no passwords in this driver's settings
    const deviceSettings = this.getSettings();

    // Picker options currently shown in the UI
    const zoneOptions = this.hasCapability('mow_zone')
      ? (this.getCapabilityOptions('mow_zone')?.values ?? []).map((v) => v.id)
      : [];
    const spotOptions = this.hasCapability('mow_spot')
      ? (this.getCapabilityOptions('mow_spot')?.values ?? []).map((v) => v.id)
      : [];

    const cfgData = cfgResult.status === 'fulfilled' ? cfgResult.value : { error: cfgResult.reason?.message };

    return {
      timestamp:        new Date().toISOString(),
      appVersion:       this.homey.manifest.version,
      deviceId:         did,
      deviceName:       this.getName(),
      model:            this.getSetting('device_model') || '',
      available:        this.getAvailable(),
      activeMapIndex:   this._activeMapIndex,
      activeZoneIds:    this._activeZoneIds,
      zonePickerOptions: zoneOptions,
      spotPickerOptions: spotOptions,
      rawResponse:      rawResponse.status  === 'fulfilled' ? rawResponse.value  : { error: rawResponse.reason?.message },
      deviceStatus:     deviceStatus.status === 'fulfilled' ? deviceStatus.value : { error: deviceStatus.reason?.message },
      cfgData,
      capabilityValues,
      storeValues,
      deviceSettings,
    };
  }
}

module.exports = MowerDevice;
