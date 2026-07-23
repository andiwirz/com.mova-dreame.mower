'use strict';

const zlib   = require('zlib');
const crypto = require('crypto');
const mqtt   = require('mqtt');
const Homey = require('homey');
const MovaApi = require('../../lib/MovaApi');
const GarageSafetyEngine = require('../../lib/garage/GarageSafetyEngine');
const { resolveMaintenancePointIndex } = require('../../lib/garage/MaintenancePointResolver');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function safeGetStoreValue(device, key) {
  try {
    return await Promise.resolve(device.getStoreValue(key));
  } catch (_) {
    return null;
  }
}

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
  15: 'docked',         // CHARGING_PAUSED_HIGH_TEMPERATURE
  16: 'docked',         // CHARGING_PAUSED_LOW_TEMPERATURE
  23: 'remote_control', // REMOTE_CONTROL
  24: 'charging',       // SMART_CHARGING
  25: 'mowing',         // SECOND_CLEANING
  26: 'mowing',         // HUMAN_FOLLOWING
  27: 'mowing',         // SPOT_CLEANING
  29: 'idle',           // WAITING_FOR_TASK
  30: 'mowing',         // STATION_CLEANING
  75: 'paused',         // MAINTENANCE_PAUSED (paused at maintenance point)
  97: 'mowing',         // SHORTCUT
  98: 'mapping',        // MONITORING
  99: 'paused',         // MONITORING_PAUSED
};

// charging_status code → enum
// Source: EvotecIT/homeassistant-dreamelawnmower types.py DreameMowerChargingStatus enum
// Source: antondaubert/dreame-mower property/service5.py (code 16)
const CHARGING_MAP = {
  1:  'charging',
  2:  'not_charging',
  3:  'charging_completed',
  5:  'returning',
  15: 'paused_hot',
  16: 'paused_cold',        // CHARGING_PAUSED_LOW_TEMPERATURE
};

// Statuses that count as "home" for mowing-completed detection.
// 'updating' intentionally excluded — a firmware update is not a mowing completion.
const ERROR_DEVICE_CODES = new Set([
  1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,
  21,22,23,24,25,26,27,28,29,30,37,73,
]);
const WARNING_DEVICE_CODES = new Set([31,32,33,34,35,36,38,39,40,41,42,43,44,45]);

const HOME_STATUSES = new Set(['idle', 'standby', 'docked', 'charging']);
const ACTIVE_WORK_STATUSES = new Set(['mowing', 'mapping', 'returning', 'remote_control']);

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
      // Re-enabled as read-only sensor. mower_task_status intentionally excluded:
      // it is listed in REMOVE_CAPABILITIES and would be stripped again immediately.
      'child_lock',
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
      'cmd_resume',
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
    // v21 was identical to v20 — converted to no-op to avoid a redundant reorder cycle.
    key: 'capabilities_migrated_v21',
    caps: [],
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
  {
    // Re-add firmware_update as a 4-state enum (was boolean).
    // States: up_to_date / available / installing / download_failed.
    // Source: antondaubert/dreame-mower OTA_INFO.0 install_state values.
    key: 'capabilities_migrated_v29',
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
  {
    key: 'capabilities_migrated_v30',
    reorder: [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'cmd_maintenance_point',
      'mower_status',
      'mow_map',
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
  {
    key: 'capabilities_migrated_v31',
    reorder: [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'cmd_maintenance_point',
      'cmd_refresh',
      'mower_status',
      'mow_map',
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
  {
    key: 'capabilities_migrated_garage_v120',
    caps: ['cmd_garage_pause_mode','cmd_garage_test_exit','cmd_garage_save_danger_center','cmd_garage_save_safety_line_a','cmd_garage_save_safety_line_b','garage_door_status','garage_safety_status','garage_sensor_available_status','garage_sensor_battery'],
  },
  {
    // v1.2.22: keep marker buttons installed. Earlier builds removed them
    // dynamically after saving; stale Homey mobile views could then call a
    // missing capability and show "Invalid Capability".
    key: 'capabilities_migrated_garage_v1222_marker_buttons',
    caps: ['cmd_garage_save_danger_center','cmd_garage_save_safety_line_a','cmd_garage_save_safety_line_b'],
  },


  {
    // v1.2.9: visible garage safety state for warnings, blocks and emergencies.
    key: 'capabilities_migrated_garage_v129',
    caps: ['garage_safety_status'],
  },
  {
    // RC78 / upstream 1.1.21: expose human-readable native mower warnings/errors.
    key: 'capabilities_migrated_upstream_v121_error',
    caps: ['mower_error'],
  },
];

// Capabilities removed — stripped from existing installs on next init
const REMOVE_CAPABILITIES = [
  // v1.2.13: internal-only garage values; not shown as separate dashboard tiles.
  'garage_home_status', 'garage_sensor_contact_status', 'garage_sensor_mode_status',
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

  log(...args) {
    super.log(...args);
    try { this.homey.app._pushLog('log', args.join(' ')); } catch {}
  }

  error(...args) {
    super.error(...args);
    try { this.homey.app._pushLog('error', args.join(' ')); } catch {}
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onInit() {
    // Initialise all instance fields first so getDebugPollData() and capability
    // listeners never see `undefined` even if _migrate() or _initApi() throws.
    this._api                  = null;
    this._pollTimer            = null;
    this._garageFastPollTimer = null;
    this._garageFastPollBusy = false;
    // Initialise from persisted state so the session timer survives app restarts.
    // If the mower was already mowing before the restart, _wasMowing stays true and
    // _sessionStartTime is restored from the store (falls back to now if not stored yet).
    this._wasMowing        = this.getCapabilityValue('mower_status') === 'mowing';
    this._wasMowingSession = ['mowing', 'paused', 'returning'].includes(this.getCapabilityValue('mower_status'));
    this._returnSnapshot   = null; // battery/settings captured at returning, for charge-break detection on dock
    this._sessionStartTime = (await this.getStoreValue('session_start_time'))
                             ?? (this._wasMowing ? Date.now() : null);
    this._persistedTokenExpiry = 0;
    this._lastBindDomain       = null;  // track last seen bindDomain to avoid redundant setBindDomain calls
    // The MOVA device-list endpoint can briefly report online=false although the
    // property endpoint still answers normally. Treat that flag as an advisory
    // hint and require repeated, corroborated failures before marking Homey offline.
    this._offlineHintCount     = 0;
    this._lastPollSuccessAt    = 0;
    this._activeMapIndex       = (await this.getStoreValue('active_map_index')) ?? 0;
    this._cmdLocks             = new Set();
    this._momentButtonLocks    = new Map();
    this._activeZoneIds        = [];    // detected zone IDs from MAP data (e.g. [1, 2, 3])
    this._discoveredMaps       = [];    // all discovered maps [{ index, name }] for autocomplete
    this._mapSwitchCooldown    = 0;     // timestamp until which MAPL override is suppressed after manual switch
    this._lastMapPickerKey     = null;  // cache key for _updateMapPicker change-guard
    this._lastZonePickerKey    = null;  // cache key for _updateZonePicker change-guard
    this._lastSpotPickerKey    = null;  // cache key for _updateSpotPicker change-guard
    this._cfgPollCounter       = 0;     // reads CFG (WRP etc.) on poll 0, 10, 20, …
    this._mihisPollCounter     = 5;     // reads MIHIS (lifetime stats) on poll 5, 15, 25, … (staggered vs CFG)
    this._dockPollCounter      = 3;     // reads DOCK position on poll 3, 13, 23, … (staggered vs CFG/MIHIS)
    this._obsPollCounter       = 7;     // reads MAPI/AIOBS/OBS on poll 7, 17, 27, … (staggered vs others)
    this._dockPos              = null;  // last known dock position { x, y } in map mm (raw × 10)
    this._dockYaw              = null;  // dock orientation in degrees (from DOCK API), used for map rotation
    this._dockGPS              = null;  // dock GPS reference { lon, lat } captured from LOCN while docked
    this._devUid               = null;  // masterUid (e.g. "UG006574") for activity history API calls
    this._devModel             = null;  // device model string (e.g. "mova.mower.g2529d") for activity file URL
    this._livePos              = null;  // last known live position { x, y, ts } in map mm
    this._lastLivePos          = null;  // buffered position used across short cloud outages
    this._lastLivePosAt        = 0;
    // RC82: one accepted native-map position stream for map + garage logic.
    // Conflicting source jumps are quarantined until independently confirmed.
    this._positionCandidate    = null;
    this._positionRejectLogAt  = 0;
    // v1.2.1: native maintenance coordinates are accepted adaptively, but only
    // after stable repetition. This prevents a transient map payload from moving
    // the marker while still allowing a genuine map change to be learned.
    this._maintenancePointCandidate = null;
    this._maintenancePointLogAt = 0;
    this._positionSourcePriority = { mqtt: 50, 'siid:1:4': 45, 'garage-marker-direct': 45, locn: 30, mitrc: 20, unknown: 0 };
    this._cachedPRE              = await this.getStoreValue('cached_pre') ?? null;  // last known PRE array; used for cutting_height read-modify-write
    this._cuttingHeightWriteTs   = 0;    // timestamp of last successful cutting_height write; guards poll snap-back
    this._preWriteCuttingHeight  = null; // capability value before last write; used to detect snap-back vs external change
    this._cachedMapData          = null; // last parsed map data for the map widget
    this._cachedObstacles        = null; // last obstacle data { aiobs, obs } from AIOBS/OBS commands
    this._cachedMAPI             = null; // last MAPI response (raw, for format discovery)
    this._lastMapNoDataLogAt     = 0;    // garage map diagnostic throttle
    this._cachedArMapPos         = null; // last parsed ARMap robot/charger position from binary blob
    this._mqttErrorCode          = null; // latest native MQTT device/error code
    this._garageSafety          = new GarageSafetyEngine(this);
    this._commandGeneration      = 0;
    this._resumeGuardUntil       = 0; // suppress garage external-start detection after Pause→Resume
    this._resumeSemanticUntil    = 0; // RC112: treat stale cloud 'paused' as mowing after an explicit resume

    await this._migrate();
    await this._migrateMaintenancePointSchema();

    // Upstream 1.1.21 self-heal: repair corrupted picker capabilities without
    // removing any garage extension capabilities.
    for (const cap of ['mow_zone', 'mow_spot', 'mow_map']) {
      if (!this.hasCapability(cap)) continue;
      try {
        this.getCapabilityValue(cap);
      } catch (e) {
        this.log(`[heal] ${cap} is corrupted (${e.message}) — removing and re-adding`);
        await this.removeCapability(cap).catch(() => {});
        await this.addCapability(cap).catch((err) => this.error(`[heal] addCapability ${cap}:`, err.message));
      }
    }

    await this._garageSafety.init();

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
    this._trgReturning        = this.homey.flow.getDeviceTriggerCard('mower_returning');
    this._trgMapChanged       = this.homey.flow.getDeviceTriggerCard('active_map_changed');

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

    if (this.hasCapability('mow_map')) {
      this.registerCapabilityListener('mow_map', async (value) => {
        const idx = parseInt(value.replace('map_', ''), 10);
        this.log(`[mow_map] selected: ${value} → mapIndex=${idx}`);
        if (idx !== this._activeMapIndex) {
          await this._api.switchMap(did, idx);
          this._activeMapIndex = idx;
          this._mapSwitchCooldown = Date.now() + 120000;
          await this.setStoreValue('active_map_index', idx);
          this._lastZonePickerKey = null;
          this._lastSpotPickerKey = null;
          if (this._lastRawData) await this._detectAndSyncZones(this._lastRawData);
          this._fireMapChangedTrigger(idx);
        }
      });
    }

    // ── Start mowing button (zone) ─────────────────────────────────────────────
    this.registerCapabilityListener('cmd_start_mowing', async (value) => {
      if (!value) return;
      if (!(await this._momentButtonPressed('cmd_start_mowing', 'start_mowing', 15000))) return;
      try {
        const zone   = this.getCapabilityValue('mow_zone') ?? 'none';
        const mapIdx = this._activeMapIndex ?? 0;
        if (!['all', 'edge_all'].includes(zone) && !zone.startsWith('zone_') && !zone.startsWith('edge_')) {
          this.log('[cmd_start_mowing] no zone selected — start blocked before garage action');
          return;
        }

        this._activeCommandMode = 'mowing';
        await this.setStoreValue('active_command_mode', this._activeCommandMode).catch(() => {});
        const startFn = async () => {
          const stBefore = this._nativeMowerStatus || this.getCapabilityValue('mower_status');
          if (['mowing','paused','returning','mapping'].includes(stBefore) && this._garageSafety && this._garageSafety.lastRequestedAction !== 'button_start_mowing') {
            await this._safeWrite('switch_to_mowing_stop_previous', () => this._api.stopMowing(did)).catch(() => {});
          }
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
        };
        const garage = this._garageSafety;
        const garageEnabled = !!garage?.enabled?.();
        const nativeStatus = String(this._nativeMowerStatus || this.getCapabilityValue('mower_status') || 'unknown').toLowerCase();
        const secureHome = garageEnabled && !!garage.isDockedHomeStatus?.();
        const returnActive = garageEnabled && !!garage.isReturnCycleActive?.();
        // RC110: a cloud/home status can remain stale while the live map already
        // proves that the mower is outside. For a paused mower, outside evidence
        // must win over stale dock/home state so Start Mowing enters the exact
        // same robust resume path as Pause/Resume and never starts a new garage
        // cycle or leaves the paused-return detector armed.
        const outsideEvidence = garageEnabled && (!!garage.isMissionOutside?.() || !!garage.positionKnown?.());
        const pausedOutside = garageEnabled && this._isPausedLike() && outsideEvidence;
        const activeOutside = garageEnabled && outsideEvidence && ['mowing', 'leaving', 'remote_control', 'mapping'].includes(nativeStatus);

        // RC103: the Start button is contextual in garage mode. A paused mower
        // on the lawn must resume without opening the gate or creating a new
        // Ausfahrt/Justieren/Positionieren cycle. Only a securely docked/charging
        // mower may enter the full garage start sequence.
        if (returnActive) {
          garage.log('start button ignored', 'safe return active');
          this.log('[cmd_start_mowing] ignored: safe return active');
          this._fireBtnTrigger('btn_start_mowing');
          return;
        }

        if (pausedOutside) {
          garage.noteUserResumeRequested?.();
          garage.log('start button outside while paused', 'handled as resume; gate remains closed');
          this._runBackgroundCommand('cmd_start_mowing_as_resume', async () => {
            this.log('[cmd_start_mowing] paused outside → resume; no garage start cycle');
            await this._resumeMowingRobust('cmd_start_as_resume');
            await this._applyStatus('mowing').catch(() => {});
            this.homey.setTimeout(() => this._poll().catch(() => {}), 2500);
            this.homey.setTimeout(() => this._poll().catch(() => {}), 7000);
            this._fireBtnTrigger('btn_start_mowing');
          }, 'start_mowing', 'cmd_start_mowing');
          return;
        }

        if (activeOutside) {
          garage.log('start button ignored', 'mowing mission already active outside');
          this.log(`[cmd_start_mowing] ignored: already active outside (${nativeStatus})`);
          this._fireBtnTrigger('btn_start_mowing');
          return;
        }

        if (garageEnabled && !secureHome) {
          const posKnown = !!garage.positionKnown?.();
          const outsideRecovery = posKnown || !!garage.isMissionOutside?.();
          if (outsideRecovery) {
            // RC109: an interrupted outbound handshake may leave the mower outside
            // in ready/idle. In that state Start is a recovery command: send the
            // native mowing command directly, never reopen the garage or create a
            // second outbound cycle.
            garage.log('start button outside recovery', `status=${nativeStatus}; position=${posKnown ? 'known' : 'missing'}; gate unchanged`);
            this._runBackgroundCommand('cmd_start_mowing_outside_recovery', async () => {
              await startFn();
              await this._applyStatus('mowing').catch(() => {});
              this.homey.setTimeout(() => this._poll().catch(() => {}), 2500);
              this.homey.setTimeout(() => this._poll().catch(() => {}), 7000);
              this._fireBtnTrigger('btn_start_mowing');
            }, 'start_mowing', 'cmd_start_mowing');
            return;
          }
          // With no trustworthy position and no outside mission evidence, keep the
          // existing fail-safe and do not guess that a new gate cycle is safe.
          garage.log('start button blocked', `mower not securely home; status=${nativeStatus}; position=missing`);
          this.log(`[cmd_start_mowing] blocked: mower not securely home (${nativeStatus}, position=missing)`);
          await garage.safetyWarning?.('start_blocked_not_securely_home').catch(() => {});
          this._fireBtnTrigger('btn_start_mowing');
          return;
        }

        this._runBackgroundCommand('cmd_start_mowing', async () => {
          await garage.startRequested('button_start_mowing', startFn);
          this._fireBtnTrigger('btn_start_mowing');
        }, 'start_mowing', 'cmd_start_mowing');
        return;
      } catch (err) {
        this.error('[cmd_start_mowing] listener error:', err.message);
      } finally {
        this._releaseMomentCommand('start_mowing', 'cmd_start_mowing');
        await this.setCapabilityValue('cmd_start_mowing', false).catch(() => {});
      }
    });

    // ── Start spot mowing button ───────────────────────────────────────────────
    this.registerCapabilityListener('cmd_start_spot_mowing', async (value) => {
      if (!value) return;
      if (!(await this._momentButtonPressed('cmd_start_spot_mowing', 'start_spot', 15000))) return;
      try {
        const spot   = this.getCapabilityValue('mow_spot') ?? 'none';
        const mapIdx = this._activeMapIndex ?? 0;

        if (spot === 'none') {
          this.log('[cmd_start_spot_mowing] no spot selected — nothing to start');
          return;
        }

        this._activeCommandMode = 'spot';
        await this.setStoreValue('active_command_mode', this._activeCommandMode).catch(() => {});
        const spotId = parseInt(spot.slice(5), 10); // 'spot_1002' → 1002
        this.log(`[cmd] start spot mowing: spot ${spotId} mapIndex=${mapIdx}`);
        this._runBackgroundCommand('cmd_start_spot_mowing', async () => {
          await this._garageSafety.startRequested('button_start_spot', async () => {
            const stBefore = this._nativeMowerStatus || this.getCapabilityValue('mower_status');
            if (['mowing','paused','returning','mapping'].includes(stBefore) && this._garageSafety && this._garageSafety.lastRequestedAction !== 'button_start_spot') {
              await this._safeWrite('switch_to_spot_stop_previous', () => this._api.stopMowing(did)).catch(() => {});
            }
            await this._safeWrite(`mow_spot:${spotId}`, () => this._api.startSpotMowing(did, [spotId], mapIdx));
            await this._setMowingStarted();
          });
          this._fireBtnTrigger('btn_start_spot_mowing');
        }, 'start_spot', 'cmd_start_spot_mowing');
        return;
      } catch (err) {
        this.error('[cmd_start_spot_mowing] listener error:', err.message);
      } finally {
        this._releaseMomentCommand('start_spot', 'cmd_start_spot_mowing');
        await this.setCapabilityValue('cmd_start_spot_mowing', false).catch(() => {});
      }
    });

    this.registerCapabilityListener('cmd_stop', async (value) => {
      if (!value) return;
      if (!(await this._momentButtonPressed('cmd_stop', 'stop', 30000))) return;
      this._runBackgroundCommand('cmd_stop', async () => {
        this.log('[cmd] btn: stop → sendAction(5,2)');
        await this._safeWrite('cmd_stop', () => this._api.stopMowing(did));
        this._activeCommandMode = null;
        await this.setStoreValue('active_command_mode', null).catch(() => {});
        this._fireBtnTrigger('btn_stop');
        this.homey.setTimeout(() => this._poll().catch(() => {}), 2000);
      }, 'stop', 'cmd_stop');
      return;
    });

    this.registerCapabilityListener('cmd_pause', async (value) => {
      if (!value) return;
      if (!(await this._momentButtonPressed('cmd_pause', 'pause', 30000))) return;
      const resumeRequested = this._isPausedLike();
      if (resumeRequested) {
        if (this._garageSafety?.enabled?.() && typeof this._garageSafety.noteUserResumeRequested === 'function') this._garageSafety.noteUserResumeRequested();
        this._pauseButtonHoldMode = 'pause';
        this._pauseButtonHoldUntil = Date.now() + 120000;
        await this._updateCommandButtonUi('mowing').catch(() => {});
      } else {
        // An explicit Pause must end every semantic resume override immediately;
        // the next native paused status is real and must update tile/button state.
        this._resumeSemanticUntil = 0;
        if (this._garageSafety?.enabled?.() && typeof this._garageSafety.noteUserPauseRequested === 'function') this._garageSafety.noteUserPauseRequested();
        this._pauseButtonHoldMode = 'resume';
        this._pauseButtonHoldUntil = Date.now() + 120000;
        await this._updateCommandButtonUi('paused').catch(() => {});
      }
      this._runBackgroundCommand('cmd_pause', async () => {
        if (resumeRequested) {
          this.log('[cmd] btn: resume → sendAction(5,4)');
          await this._resumeMowingRobust('cmd_resume');
          await this._applyStatus('mowing').catch(() => {});
          this.homey.setTimeout(async () => {
            await this._poll().catch(() => {});
            if (this._isPausedLike()) {
              this.log('[cmd] resume still paused after delay → retry once');
              await this._resumeMowingRobust('cmd_resume_retry');
              this.homey.setTimeout(() => this._poll().catch(() => {}), 2500);
            }
          }, 2500);
        } else {
          this.log('[cmd] btn: pause → sendAction(5,4)');
          await this._safeWrite('cmd_pause', () => this._api.pause(did));
          await this._applyStatus('paused');
          this.homey.setTimeout(() => this._poll().catch(() => {}), 2500);
          this.homey.setTimeout(() => this._poll().catch(() => {}), 7000);
        }
        this._fireBtnTrigger('btn_pause');
      }, 'pause', 'cmd_pause');
      return;
    });

    if (this.hasCapability('cmd_resume')) {
      this.registerCapabilityListener('cmd_resume', async (value) => {
        if (!value) return;
        try {
          // Native upstream resume path. Garage mode may add safety guards through
          // the shared robust resume helper, but disabled mode remains equivalent.
          this.log('[cmd] btn: resume');
          if (this._garageSafety?.enabled?.()) await this._resumeMowingRobust('cmd_resume');
          else await this._safeWrite('cmd_resume', () => this._api.startMowing(did));
          this._fireBtnTrigger('btn_resume');
        } catch (err) {
          this.error('[cmd_resume] listener error:', err.message);
        } finally {
          await this.setCapabilityValue('cmd_resume', false).catch(() => {});
        }
      });
    }

    this.registerCapabilityListener('cmd_dock', async (value) => {
      if (!value) return;
      if (!(await this._momentButtonPressed('cmd_dock', 'dock', 120000))) return;
      try {
        this.log('[cmd] btn: dock → dock()');
        this._runBackgroundCommand('cmd_dock', async () => {
          await this._garageSafety.returnRequested('button_dock', async () => {
            await this._safeWrite('cmd_dock', () => this._api.dock(did));
            await this._applyStatus('returning');
          }, async () => this._goToMaintenancePointGuarded('button_maintenance'));
          this._fireBtnTrigger('btn_return_to_dock');
        }, 'dock', 'cmd_dock');
        return;
      } catch (err) {
        this.error('[cmd_dock] listener error:', err.message);
      } finally {
        this._releaseMomentCommand('dock', 'cmd_dock');
        await this.setCapabilityValue('cmd_dock', false).catch(() => {});
      }
    });

    if (this.hasCapability('cmd_maintenance_point')) {
      this.registerCapabilityListener('cmd_maintenance_point', async (value) => {
        if (!value) return;
        if (!(await this._momentButtonPressed('cmd_maintenance_point', 'maintenance', 120000))) return;
        try {
          this.log('[cmd] btn: maintenance point → goToMaintenancePoint()');
          this._runBackgroundCommand('cmd_maintenance_point', async () => {
            await this._garageSafety.maintenanceRequested('button_maintenance', async () => this._safeWrite('cmd_maintenance_point', () => this._goToMaintenancePointGuarded('button_maintenance')));
            this._fireBtnTrigger('btn_maintenance_point');
          }, 'maintenance', 'cmd_maintenance_point');
          return;
        } catch (err) {
          this.error('[cmd_maintenance_point] listener error:', err.message);
        } finally {
          this._releaseMomentCommand('maintenance', 'cmd_maintenance_point');
          await this.setCapabilityValue('cmd_maintenance_point', false).catch(() => {});
        }
      });
    }

    if (this.hasCapability('cmd_refresh')) {
      this.registerCapabilityListener('cmd_refresh', async (value) => {
        if (!value) return;
        await this.setCapabilityValue('cmd_refresh', false).catch(() => {});
        this.homey.setTimeout(() => this.setCapabilityValue('cmd_refresh', false).catch(() => {}), 40);
        if (!(await this._momentButtonPressed('cmd_refresh', 'refresh', 10000))) return;
        await this.setCapabilityValue('cmd_refresh', false).catch(() => {});
        this.homey.setTimeout(() => this.setCapabilityValue('cmd_refresh', false).catch(() => {}), 50);
        this._refreshInProgress = true;
        this._runBackgroundCommand('cmd_refresh', async () => {
          try {
            this.log('[cmd] btn: refresh → forcing full poll');
            this._cfgPollCounter   = 0;
            this._mihisPollCounter = 0;
            this._dockPollCounter  = 0;
            this._obsPollCounter   = 0;
            this._lastZonePickerKey  = null;
            this._lastSpotPickerKey  = null;
            this._lastMapPickerKey   = null;
            await this._poll();
          } finally {
            this._refreshInProgress = false;
          }
        }, 'refresh', 'cmd_refresh');
        return;
      });
    }


    if (this.hasCapability('cmd_garage_pause_mode')) {
      this.registerCapabilityListener('cmd_garage_pause_mode', async (value) => {
        if (!value) return;
        if (!(await this._momentButtonPressed('cmd_garage_pause_mode', 'garage_pause', 3000))) return;
        this._garageSafety.paused = !this._garageSafety.paused;
        this.log(`[garage] mode ${this._garageSafety.paused ? 'paused' : 'active'}`);
        await this.setCapabilityOptions('cmd_garage_pause_mode', {
          title: {
            en: this._garageSafety.paused ? 'Resume garage mode' : 'Pause garage mode',
            de: this._garageSafety.paused ? 'Garagenmodus fortsetzen' : 'Garagenmodus pausieren',
          },
          icon: this._garageSafety.paused ? '/assets/capabilities/cmd_resume.svg' : '/assets/capabilities/cmd_pause.svg',
        }).catch(() => {});
        await this._garageSafety.refreshTileStatus(this._garageSafety.paused ? 'garage paused' : 'garage resumed').catch(() => {});
        this._releaseMomentCommand('garage_pause', 'cmd_garage_pause_mode');
        await this.setCapabilityValue('cmd_garage_pause_mode', false).catch(() => {});
      });
    }
    if (this.hasCapability('cmd_garage_test_exit')) {
      this.registerCapabilityListener('cmd_garage_test_exit', async (value) => {
        if (!value) return;
        if (!(await this._momentButtonPressed('cmd_garage_test_exit', 'garage_test_exit', 60000))) return;
        try {
          this._activeCommandMode = 'test';
          await this.setStoreValue('active_command_mode', this._activeCommandMode).catch(() => {});
          await this._setCommandVisualState('cmd_garage_test_exit', false, { en: 'Test drive started', de: 'Testfahrt gestartet' }).catch(() => {});
          this._runBackgroundCommand('cmd_garage_test_exit', async () => this._garageSafety.testExit(), 'garage_test_exit', 'cmd_garage_test_exit');
          return;
        }
        catch (err) { this.error('[cmd_garage_test_exit] listener error:', err.message); }
        finally { this._releaseMomentCommand('garage_test_exit', 'cmd_garage_test_exit'); await this.setCapabilityValue('cmd_garage_test_exit', false).catch(() => {}); }
      });
    }
    const garageMarkerMap = {
      cmd_garage_save_danger_center: 'danger',
      cmd_garage_save_safety_line_a: 'line_a',
      cmd_garage_save_safety_line_b: 'line_b',
    };
    for (const [cap, kind] of Object.entries(garageMarkerMap)) {
      // Register unconditionally. Marker buttons are intentionally added/removed
      // after setup/reset, and Homey must still have a listener after a restart
      // when the reset setting re-adds them.
      this.registerCapabilityListener(cap, async (value) => {
        if (!value) return;
        const lockKey = `marker_${kind}`;
        if (!(await this._momentButtonPressed(cap, lockKey, 10000))) return;
        try { await this._garageSafety.saveMarker(kind); }
        catch (err) { this.error(`[${cap}] listener error:`, err.message); }
        finally {
          await this._releaseMomentCommand(lockKey, cap);
          if (this.hasCapability(cap)) await this.setCapabilityValue(cap, false).catch(() => {});
        }
      });
    }

    // garage_home_status is a read-only garage state indicator. It is no longer
    // used as a picker in the controls view; the tile display is derived by the
    // GarageSafetyEngine.

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

    const dock = await this._api.getDockPosition(did).catch((e) => {
      this.error('[init] getDockPosition failed:', e.message);
      return null;
    });
    if (dock) {
      this._dockPos = { x: dock.x * 10, y: dock.y * 10 };
      this._dockYaw = dock.yaw ?? null;
      this.log(`[init] dockPos: (${this._dockPos.x}, ${this._dockPos.y}) mm  yaw=${this._dockYaw}`);
    }

    // Detect active map from MAPL (d[i][1]===1 = active)
    const mapl = await this._api.getMapList(did).catch(() => null);
    if (mapl?.d && Array.isArray(mapl.d)) {
      const active = mapl.d.find((e) => Array.isArray(e) && e[1] === 1);
      if (active) {
        this._activeMapIndex = active[0];
        await this.setStoreValue('active_map_index', active[0]);
        this.log(`[init] active map from MAPL: ${active[0]}`);
      }
    }

    // Cache masterUid for activity history API (used for AI photo/obstacle post-session data)
    const devInfo = await this._api.getDeviceStatus(did).catch(() => null);
    if (devInfo) {
      this._devUid   = devInfo.masterUid ?? devInfo.uid ?? null;
      this._devModel = devInfo.model ?? null;
    }

    // Skip the redundant getCFG / MIHIS / DOCK on the very first poll since we fetch them at init.
    this._cfgPollCounter   = 1;
    this._mihisPollCounter = 1;
    this._dockPollCounter  = 1;


    this._startPolling();
    this._connectMqtt();
  }

  async onDeleted() {
    this._stopPolling();
    this._disconnectMqtt();
  }

  async onSettings({ changedKeys, newSettings }) {
    this.log('[settings] changed:', changedKeys.join(', '));
    const did = this.getData().id;

    if (this._garageSafety && typeof this._garageSafety.onSettings === 'function') {
      await this._garageSafety.onSettings(newSettings, changedKeys).catch((e) => this.error('[garage] settings hook:', e.message));
    }

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
    // RC43: external Dreame/MOVA returns must be detected before the mower reaches a closed gate.
    // Keep the original poll interval, but add a guarded 5 s safety poll only while garage mode is active and the mower is outside/working.
    this._garageFastPollTimer = this.homey.setInterval(async () => {
      if (this._garageFastPollBusy || !this.getSetting('garage_mode_enabled')) return;
      const st = this.getCapabilityValue('mower_status');
      const outside = !!(this._garageSafety && (this._garageSafety._missionOutside || this._garageSafety._outbound));
      if (!outside && !['mowing','mapping','paused','returning','error','remote_control'].includes(st)) return;
      this._garageFastPollBusy = true;
      try { await this._poll(); } catch (e) { this.log('[garage-fast-poll]', e.message); }
      finally { this._garageFastPollBusy = false; }
    }, 5000);
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._garageFastPollTimer) {
      this.homey.clearInterval(this._garageFastPollTimer);
      this._garageFastPollTimer = null;
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
    // Do not let a transient failure of the device-list endpoint take the mower
    // offline when getRawProperties still succeeds. The latter is direct proof
    // that the cloud/device path is alive and is also what the original app uses
    // for most live state reads.
    let info = null;
    if (statusResult.status === 'fulfilled') {
      info = statusResult.value;
    } else if (rawResult.status === 'fulfilled') {
      this.log('[poll] device-list temporarily unavailable; raw properties succeeded — keeping device online:', statusResult.reason?.message);
    } else {
      await this._handlePollError(statusResult.reason);
      return;
    }

    if (!info && rawResult.status !== 'fulfilled') {
      this.error('Device not found in list for did:', did);
      await this.setUnavailable(this.homey.__('error.device_not_found'));
      return;
    }

    // ── bindDomain → sendCommand host (update only when value changes) ────────
    if (info && info.bindDomain != null && info.bindDomain !== this._lastBindDomain) {
      this._lastBindDomain = info.bindDomain;
      this._api.setBindDomain(info.bindDomain);
    }

    // ── Read-only device info → settings (change-guarded) ───────────────────
    if (info) {
      const infoUpdate = {};
      // Prefer the human-readable display name (e.g. "LiDAX Ultra 1200") over
      // the internal model string; fall back to info.model if absent.
      const displayName = info.deviceInfo?.displayName || info.model || '';
      if (displayName && displayName !== this.getSetting('device_model'))       infoUpdate.device_model     = displayName;
      const modelId = info.model || '';
      if (modelId && modelId !== this.getSetting('device_model_id'))            infoUpdate.device_model_id  = modelId;
      if (info.ver    && info.ver    !== this.getSetting('firmware_version'))   infoUpdate.firmware_version = info.ver;
      if (info.sn     && info.sn     !== this.getSetting('serial_number'))      infoUpdate.serial_number    = info.sn;
      if (info.mac    && info.mac    !== this.getSetting('mac_address'))        infoUpdate.mac_address      = info.mac;
      if (Object.keys(infoUpdate).length > 0) {
        await this.setSettings(infoUpdate).catch(() => {});
      }
    }

    // child_lock may be present in the device-list response on some models
    if (info && info.childLock != null && this.hasCapability('child_lock')) {
      await this._applyBoolCap('child_lock', !!info.childLock);
    }

    if (info && info.battery      != null) await this._applyBattery(info.battery);
    if (info && info.latestStatus != null) {
      const rawStatus = STATUS_MAP[info.latestStatus] ?? 'idle';
      const prop = (info.property && typeof info.property === 'object') ? info.property : {};
      const faultCode = info.latestFaultCode ?? info.faultCode ?? info.errorCode
                     ?? info.deviceCode ?? info.device_code ?? info.latestCode ?? info.errCode
                     ?? prop.latestFaultCode ?? prop.faultCode ?? prop.errorCode
                     ?? prop.deviceCode ?? prop.device_code ?? prop.latestCode ?? prop.errCode
                     ?? this._mqttErrorCode ?? 0;
      const effectiveFaultCode = faultCode !== 0 ? faultCode : (this._mqttErrorCode ?? 0);
      const isMova = (this.getSetting('device_model') || '').startsWith('mova.');
      const isEffectiveError = ERROR_DEVICE_CODES.has(effectiveFaultCode)
                            || (isMova && this._mqttErrorCode === 0);
      const mowerStatus = (rawStatus === 'paused' && isEffectiveError) ? 'error' : rawStatus;
      if (mowerStatus === 'error' || rawStatus === 'paused') {
        this.log(`[diag] latestStatus=${info.latestStatus} rawStatus=${rawStatus} effective=${mowerStatus} faultCode=${faultCode} mqttErrorCode=${this._mqttErrorCode ?? 'none'}`);
      }
      await this._applyStatus(mowerStatus, effectiveFaultCode);

      // Derive charging_status from mower status.
      const chargingCode =
        mowerStatus === 'charging'  ? 1
        : mowerStatus === 'docked'  ? 3
        : mowerStatus === 'returning' ? 5
        : 2; // NOT_CHARGING for all other states
      await this._applyChargingStatus(chargingCode);
    }

    if (info && info.online === false) {
      // A single online=false response is frequently stale for MOVA/Dreame
      // mowers. If raw properties answered, the mower is demonstrably reachable.
      if (rawResult.status === 'fulfilled') {
        this._offlineHintCount = 0;
        this.log('[poll] ignored stale online=false flag because raw properties succeeded');
      } else {
        this._offlineHintCount += 1;
        this.log(`[poll] online=false corroborated by raw failure (${this._offlineHintCount}/3)`);
        if (this._offlineHintCount >= 3) {
          await this.setUnavailable(this.homey.__('error.device_offline'));
          return;
        }
      }
    } else {
      this._offlineHintCount = 0;
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
        this._lastRawData = rawData;
        await this._applyMOVASettings(rawData);
        await this._applyOTAInfo(rawData);
        await this._detectAndSyncZones(rawData);
      }
    } else {
      this.error('[poll] rawProperties failed:', rawResult.reason?.message);
    }

    // ── Live position — every poll ────────────────────────────────────────────
    // Priority: LOCN (official app method) → siid:1:4 → MITRC (fallback)
    const posStatus = this._nativeMowerStatus || this.getCapabilityValue('mower_status');
    const ACTIVE_STATUSES = ['mowing', 'edge_mowing', 'leaving', 'returning', 'paused', 'remote_control', 'idle', 'standby', 'garage'];
    // Keep the last known live position. Do not clear _livePos at the start of
    // each poll: the original map widget expects buffered data while LOCN/MITRC
    // briefly drop out, otherwise Homey shows "No map data yet" although a map
    // exists. Fallbacks below overwrite it only when a fresh fix is available.

    // RC82 position arbitration: prefer the mower's native map coordinate
    // (siid:1:4, also used by MQTT). LOCN and MITRC are fallback sources only.
    // A fresh accepted position is shared by the widget and every garage guard.
    let freshPositionThisPoll = false;

    if (ACTIVE_STATUSES.includes(posStatus)) {
      const mowerPos = await this._api.getMowerPosition(did).catch(() => null);
      if (mowerPos && Number.isFinite(Number(mowerPos.x)) && Number.isFinite(Number(mowerPos.y))) {
        this.log(`[pos1:4] x=${mowerPos.x} y=${mowerPos.y} angle=${mowerPos.angle} status=${posStatus}`);
        freshPositionThisPoll = this._setLivePosition({ x: mowerPos.x, y: mowerPos.y }, 'siid:1:4') || freshPositionThisPoll;
      }
    }

    // LOCN remains useful as a fallback and as dock GPS anchor, but may not
    // overwrite a fresh higher-priority native map coordinate.
    const AT_DOCK_STATUSES = ['docked', 'charging', 'idle', 'standby'];
    const locn = await this._api.getLOCN(did).catch(() => null);
    const locnPos = locn?.pos && Array.isArray(locn.pos) && locn.pos.length >= 2 ? locn.pos : null;
    if (locnPos) {
      const [lon, lat] = locnPos;
      if (AT_DOCK_STATUSES.includes(posStatus)) {
        this._dockGPS = { lon, lat };
        this.log(`[locn] docked — GPS anchor: lon=${lon} lat=${lat}`);
      } else if (!freshPositionThisPoll && ACTIVE_STATUSES.includes(posStatus) && this._dockGPS && this._dockPos) {
        const R = 111320000;
        const dx = (lon - this._dockGPS.lon) * R * Math.cos(lat * Math.PI / 180);
        const dy = (lat - this._dockGPS.lat) * R;
        const mapX = this._dockPos.x + dx;
        const mapY = this._dockPos.y + dy;
        this.log(`[locn] GPS→map fallback: map=(${mapX.toFixed(0)},${mapY.toFixed(0)}) status=${posStatus}`);
        freshPositionThisPoll = this._setLivePosition({ x: mapX, y: mapY }, 'locn') || freshPositionThisPoll;
      }
    }

    if (!freshPositionThisPoll && ACTIVE_STATUSES.includes(posStatus)) {
      const mitrcTrack = await this._api.getMITRC(did, this._activeMapIndex, 65535).catch(() => null);
      if (mitrcTrack) {
        const pos = this._parseMITRCPosition(mitrcTrack);
        const mapPos = (pos && this._dockPos)
          ? { x: this._dockPos.x + pos.x, y: this._dockPos.y - pos.y }
          : null;
        this.log('[mitrc] fallback map=' + (mapPos ? mapPos.x + ',' + mapPos.y : 'null') + ' status=' + posStatus);
        if (mapPos) freshPositionThisPoll = this._setLivePosition(mapPos, 'mitrc') || freshPositionThisPoll;
      } else if (!locnPos) {
        if (this._getBufferedLivePosition()) this.log('[pos] transient position outage; using buffered accepted position');
        else this.log('[pos] no position data (siid:1:4 null, LOCN null, MITRC null)');
      }
    }

    if (this._garageSafety && typeof this._garageSafety.updatePositionGuards === 'function') {
      await this._garageSafety.updatePositionGuards().catch((e) => this.error('[garage] position guard:', e.message));
    }

    // ── Dock position — first poll and every 10th thereafter ─────────────────
    if (this._dockPollCounter % 10 === 0) {
      const dock = await this._api.getDockPosition(did).catch((e) => {
        this.error('[dock] getDockPosition failed:', e.message);
        return null;
      });
      if (dock) {
        this._dockPos = { x: dock.x * 10, y: dock.y * 10 };
        this._dockYaw = dock.yaw ?? this._dockYaw;
        if (this._cachedMapData) this._cachedMapData.chargerPos = this._dockPos;
      }
    }
    this._dockPollCounter++;

    // ── MAPL — active map detection, every poll ────────────────────────────────
    if (Date.now() > this._mapSwitchCooldown) {
      const mapl = await this._api.getMapList(did).catch(() => null);
      if (mapl?.d && Array.isArray(mapl.d)) {
        const active = mapl.d.find((e) => Array.isArray(e) && e[1] === 1);
        if (active && active[0] !== this._activeMapIndex) {
          this.log(`[mapl] active map changed: ${this._activeMapIndex} → ${active[0]}`);
          this._activeMapIndex = active[0];
          await this.setStoreValue('active_map_index', active[0]);
          this._lastZonePickerKey = null;
          this._lastSpotPickerKey = null;
          if (this.hasCapability('mow_map')) {
            await this.setCapabilityValue('mow_map', `map_${active[0]}`).catch(() => {});
          }
          if (this._lastRawData) await this._detectAndSyncZones(this._lastRawData);
          this._fireMapChangedTrigger(active[0]);
        }
      }
    }

    // ── MAPI / AIOBS / OBS — every 10th poll (staggered) ─────────────────────
    if (this._obsPollCounter % 10 === 0) {
      const [mapiRes, aiobsRes, obsRes] = await Promise.allSettled([
        this._api.getMAPI(did, this._activeMapIndex),
        this._api.getAIOBS(did, { idx: this._activeMapIndex }),
        this._api.getOBS(did, { idx: this._activeMapIndex }),
      ]);

      if (mapiRes.status === 'fulfilled') {
        this._cachedMAPI = mapiRes.value;
        this.log('[mapi] response:', JSON.stringify(this._cachedMAPI)?.slice(0, 400));
        const directMap = this._parseDirectMapData(this._cachedMAPI);
        if (directMap && (!this._cachedMapData || directMap.md5sum !== this._cachedMapData.md5sum)) {
          this._cachedMapData = directMap;
          this.log(`[map] cached from MAPI: ${directMap.name}, ${directMap.mowingAreas.length} zones`);
        }
      } else {
        this.log('[mapi] failed:', mapiRes.reason?.message);
      }

      const aiobs = aiobsRes.status === 'fulfilled' ? aiobsRes.value : null;
      const obs   = obsRes.status   === 'fulfilled' ? obsRes.value   : null;
      if (aiobs !== null || obs !== null) {
        this._cachedObstacles = { aiobs, obs };
        this.log('[aiobs] response:', JSON.stringify(aiobs)?.slice(0, 600));
        this.log('[obs]   response:', JSON.stringify(obs)?.slice(0, 300));
      } else {
        this.log('[aiobs] failed:', aiobsRes.reason?.message);
        this.log('[obs]   failed:', obsRes.reason?.message);
      }
    }
    this._obsPollCounter++;

    this._lastPollSuccessAt = Date.now();
    this._offlineHintCount = 0;
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


  async _setCommandVisualState(cap, available, activeLabel = null) {
    if (!this.hasCapability(cap)) return;
    const baseTitles = {
      cmd_start_mowing: { en: 'Start Mowing', de: 'Mähen starten' },
      cmd_start_spot_mowing: { en: 'Start Spot Mowing', de: 'Spot-Mähen starten' },
      cmd_stop: { en: 'Stop', de: 'Stoppen' },
      cmd_dock: { en: 'Return to Dock', de: 'Zur Ladestation' },
      cmd_maintenance_point: { en: 'Maintenance Point', de: 'Wartungspunkt' },
      cmd_refresh: { en: 'Refresh', de: 'Aktualisieren' },
      cmd_garage_test_exit: { en: 'Test Exit', de: 'Test-Ausfahrt' },
    };
    const title = activeLabel || baseTitles[cap];
    const opts = { disabled: !available };
    if (title) opts.title = title;
    await this.setCapabilityOptions(cap, opts).catch(() => {});
    await this.setCapabilityValue(cap, false).catch(() => {});
  }

  async _updateCommandButtonUi(status = null) {
    const rawNativeStatus = status || this._nativeMowerStatus || this.getCapabilityValue('mower_status') || 'unknown';
    let nativeStatus = rawNativeStatus;
    if (this._pauseButtonHoldUntil && Date.now() < this._pauseButtonHoldUntil && this._pauseButtonHoldMode) {
      nativeStatus = this._pauseButtonHoldMode === 'resume' ? 'paused' : 'mowing';
    }
    const busy = ACTIVE_WORK_STATUSES.has(nativeStatus);
    const paused = nativeStatus === 'paused';

    // Pause is one physical command button. Make the visible label match the real
    // command that will be sent next: pause while mowing/returning/mapping,
    // resume while paused. Homey still treats it as a momentary button and we
    // always reset the value to false.
    if (this.hasCapability('cmd_pause')) {
      const resume = paused;
      await this.setCapabilityOptions('cmd_pause', {
        title: {
          en: resume ? 'Resume Mowing' : 'Pause Mowing',
          de: resume ? 'Mähen fortsetzen' : 'Mähen pausieren',
        },
        icon: resume ? '/assets/capabilities/cmd_resume.svg' : '/assets/capabilities/cmd_pause.svg',
      }).catch(() => {});
      await this.setCapabilityValue('cmd_pause', false).catch(() => {});
    }

    if (this.hasCapability('cmd_garage_pause_mode') && this._garageSafety) {
      const garagePaused = !!this._garageSafety.paused;
      await this.setCapabilityOptions('cmd_garage_pause_mode', {
        title: {
          en: garagePaused ? 'Resume garage mode' : 'Pause garage mode',
          de: garagePaused ? 'Garagenmodus fortsetzen' : 'Garagenmodus pausieren',
        },
        icon: garagePaused ? '/assets/capabilities/cmd_resume.svg' : '/assets/capabilities/cmd_pause.svg',
      }).catch(() => {});
      await this.setCapabilityValue('cmd_garage_pause_mode', false).catch(() => {});
    }

    // Command tiles are visually button-like but Homey does not expose a reliable
    // runtime disabled state for every client. Therefore the real protection is
    // implemented in _commandUnavailableReason(); this UI sync only makes sure no
    // unavailable command remains visually active/white.
    const momentCaps = [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'cmd_maintenance_point',
      'cmd_refresh',
      'cmd_garage_test_exit',
      'cmd_garage_pause_mode',
    ];
    for (const cap of momentCaps) {
      if (this.hasCapability(cap)) await this.setCapabilityValue(cap, false).catch(() => {});
    }

    const locks = this._momentButtonLocks || new Map();
    const currentAction = this._garageSafety ? String(this._garageSafety.lastRequestedAction || '') : '';
    const activeMode = this._activeCommandMode || null;
    const startActive = locks.has('start_mowing') || currentAction.includes('start_mowing') || (activeMode === 'mowing' && ['mowing','paused'].includes(nativeStatus));
    const spotActive = locks.has('start_spot') || currentAction.includes('start_spot') || (activeMode === 'spot' && ['mowing','paused'].includes(nativeStatus));
    const dockActive = locks.has('dock') || nativeStatus === 'returning';
    const maintenanceActive = locks.has('maintenance') || currentAction.includes('maintenance');

    // Best-effort visual availability. Homey clients still render moment buttons
    // differently, so the guard below remains the source of truth, but this makes
    // the device view much closer to the intended state: the active command looks
    // unavailable while alternative commands remain selectable as deliberate mode
    // switches.
    await this._setCommandVisualState('cmd_start_mowing', !startActive, startActive ? { en: 'Mowing started', de: 'Mähen gestartet' } : null);
    await this._setCommandVisualState('cmd_start_spot_mowing', !spotActive, spotActive ? { en: 'Spot mowing started', de: 'Spot-Mähen gestartet' } : null);
    await this._setCommandVisualState('cmd_stop', busy || paused, null);
    await this._setCommandVisualState('cmd_dock', !dockActive, dockActive ? { en: 'Returning', de: 'Rückkehr läuft' } : null);
    await this._setCommandVisualState('cmd_maintenance_point', !maintenanceActive, maintenanceActive ? { en: 'Driving to maintenance point', de: 'Wartungspunkt läuft' } : null);
    await this._setCommandVisualState('cmd_refresh', true, null);

    await this._resetAllMomentButtons().catch(() => {});
  }

  _commandLockFromCapability(capabilityId) {
    return {
      cmd_start_mowing: 'start_mowing',
      cmd_start_spot_mowing: 'start_spot',
      cmd_dock: 'dock',
      cmd_maintenance_point: 'maintenance',
      cmd_stop: 'stop',
      cmd_pause: 'pause',
    }[capabilityId] || capabilityId;
  }

  _clearSupersededCommandLocks(activeLock) {
    if (!this._momentButtonLocks) this._momentButtonLocks = new Map();
    const superseded = ['start_mowing', 'start_spot', 'dock', 'maintenance'];
    for (const key of superseded) {
      if (key === activeLock) continue;
      const timer = this._momentButtonLocks.get(key);
      if (timer) this.homey.clearTimeout(timer);
      this._momentButtonLocks.delete(key);
    }
  }

  _isPausedLike() {
    // RC112: while an explicit resume is semantically active, stale raw/cloud
    // pause strings must not make the next Pause/Fortsetzen press look like yet
    // another Resume. The hold mode `pause` means the mower is considered active
    // and the next physical button press must issue Pause.
    if (this._resumeSemanticUntil && Date.now() < this._resumeSemanticUntil
        && this._pauseButtonHoldMode === 'pause') return false;
    const status = this._nativeMowerStatus || this.getCapabilityValue('mower_status') || '';
    const last = String(this._lastRawStatus || this._lastMowerStatus || '').toLowerCase();
    return status === 'paused' || last.includes('pause') || last.includes('paused');
  }

  _commandUnavailableReason(capabilityId) {
    const status = this._nativeMowerStatus || this.getCapabilityValue('mower_status') || 'unknown';
    const isBusy = ACTIVE_WORK_STATUSES.has(status);
    const isPaused = status === 'paused';
    const isHomeOrIdle = HOME_STATUSES.has(status) || status === 'idle' || status === 'standby' || status === 'docked' || status === 'charging';

    if (capabilityId === 'cmd_start_mowing' || capabilityId === 'cmd_start_spot_mowing') {
      if (this._momentButtonLocks && (this._momentButtonLocks.has('start_mowing') || this._momentButtonLocks.has('start_spot'))) {
        return 'another_start_command_running';
      }
      // Start/Spot may be used as an intentional mode switch: the listener stops
      // the current job first and then starts the requested one. Only duplicate
      // start commands are blocked by the lock above.
      if (status === 'returning' && capabilityId === 'cmd_start_spot_mowing') return `mower_busy_${status}`;
    }

    if (capabilityId === 'cmd_pause' && !['mowing', 'paused', 'returning', 'mapping'].includes(status)) {
      return `pause_not_available_${status}`;
    }

    if (capabilityId === 'cmd_stop' && !isBusy && !isPaused) {
      return `stop_not_available_${status}`;
    }

    if ((capabilityId === 'cmd_dock' || capabilityId === 'cmd_maintenance_point')) {
      const garageActive = this._garageSafety && this._garageSafety.enabled && this._garageSafety.enabled();
      const garageHome = garageActive && this._garageSafety._homeState === 'home';
      const charging = this.getCapabilityValue('charging_status');
      const outsideEvidence = garageActive && (!!this._garageSafety.positionKnown?.() || !!this._garageSafety.isMissionOutside?.());
      const reallyHome = !outsideEvidence && (['docked', 'charging', 'charging_completed'].includes(status)
        || ['charging', 'charging_completed', 'docked'].includes(charging)
        || garageHome);
      // Docking while already home is meaningless, but the maintenance-point
      // button is a valid garage departure: GarageSafetyEngine opens the door
      // first and releases native maintenance point index 2 only after the door
      // is safely open.
      if (reallyHome && capabilityId === 'cmd_dock' && garageActive && !this._garageSafety.paused) {
        return `transit_not_available_home`;
      }
    }

    if ((capabilityId === 'cmd_stop' || capabilityId === 'cmd_dock' || capabilityId === 'cmd_maintenance_point')
        && ['unknown'].includes(status)) {
      return `command_state_unknown_${status}`;
    }

    return null;
  }

  async _resetConflictingButtons(capabilityId) {
    const reset = async (cap) => { if (this.hasCapability(cap)) await this.setCapabilityValue(cap, false).catch(() => {}); };
    if (capabilityId === 'cmd_start_mowing') await reset('cmd_start_spot_mowing');
    if (capabilityId === 'cmd_start_spot_mowing') await reset('cmd_start_mowing');
    if (capabilityId === 'cmd_stop') {
      await reset('cmd_start_mowing');
      await reset('cmd_start_spot_mowing');
      await reset('cmd_pause');
      await reset('cmd_dock');
      await reset('cmd_maintenance_point');
    }
  }

  /**
   * Momentary command button guard.
   *
   * Homey command capabilities are visually toggle-like, but for mower commands
   * we treat them as momentary buttons. This helper makes every button behave
   * the same way:
   *   - ignore duplicate taps while the command is busy
   *   - run the listener once
   *   - always reset the UI value back to false exactly once
   *
   * The actual API command is executed by the listener; this method only gates
   * and normalises the UI state.
   */
  async _momentButtonPressed(capabilityId, lockKey = capabilityId, timeoutMs = 15000) {
    if (!this._momentButtonLocks) this._momentButtonLocks = new Map();
    const unavailable = this._commandUnavailableReason(capabilityId);
    if (unavailable) {
      this.log(`[button] ${capabilityId} blocked: ${unavailable}`);
      if (this._garageSafety && this._garageSafety.log) this._garageSafety.log('button blocked', capabilityId, unavailable);
      if (this._garageSafety && ['cmd_start_mowing','cmd_start_spot_mowing','cmd_dock','cmd_maintenance_point','cmd_stop'].includes(capabilityId)) {
        this._commandGeneration = (this._commandGeneration || 0) + 1;
        this._garageSafety.cancelPendingCommand(`blocked_${capabilityId}_${unavailable}`);
      }
      await this.setCapabilityValue(capabilityId, false).catch(() => {});
      return false;
    }
    const normalizedLock = this._commandLockFromCapability(capabilityId);
    if (['start_mowing','start_spot','dock','maintenance','stop'].includes(normalizedLock)) {
      this._commandGeneration = (this._commandGeneration || 0) + 1;
      this._clearSupersededCommandLocks(normalizedLock);
      if (this._garageSafety) this._garageSafety.beginUserCommand(normalizedLock);
    }
    await this._resetConflictingButtons(capabilityId);
    if (this._garageSafety && this._garageSafety.log) this._garageSafety.log('button pressed', capabilityId, 'lock=', lockKey);
    if (this._momentButtonLocks.has(lockKey)) {
      this.log(`[button] ${capabilityId} ignored: ${lockKey} already running`);
      if (this._garageSafety && this._garageSafety.log) this._garageSafety.log('button ignored duplicate', capabilityId, lockKey);
      await this.setCapabilityValue(capabilityId, false).catch(() => {});
      return false;
    }

    // Action capabilities are pure moment buttons. Reset immediately and again
    // shortly afterwards so the mobile UI only shows the native press feedback
    // and never keeps the tile selected/white. The lock remains active until the
    // command finishes, so this does not allow double commands.
    if (this.hasCapability(capabilityId)) {
      await this.setCapabilityValue(capabilityId, false).catch(() => {});
      this.homey.setTimeout(() => this.setCapabilityValue(capabilityId, false).catch(() => {}), 40);
      this.homey.setTimeout(() => this.setCapabilityValue(capabilityId, false).catch(() => {}), 250);
      this.homey.setTimeout(() => this.setCapabilityValue(capabilityId, false).catch(() => {}), 1000);
    }

    const timer = this.homey.setTimeout(() => {
      this._momentButtonLocks.delete(lockKey);
      if (this.hasCapability(capabilityId)) {
        this.setCapabilityValue(capabilityId, false).catch(() => {});
      }
      this.log(`[button] ${capabilityId} lock timeout released`);
    }, timeoutMs);

    this._momentButtonLocks.set(lockKey, timer);
    return true;
  }

  async _releaseMomentCommand(lockKey, capabilityId = null) {
    if (!this._momentButtonLocks) this._momentButtonLocks = new Map();
    const timer = this._momentButtonLocks.get(lockKey);
    if (timer) {
      this.homey.clearTimeout(timer);
      this._momentButtonLocks.delete(lockKey);
    }
    if (capabilityId && this.hasCapability(capabilityId)) {
      await this.setCapabilityValue(capabilityId, false).catch(() => {});
      this.homey.setTimeout(() => this.setCapabilityValue(capabilityId, false).catch(() => {}), 40);
      this.homey.setTimeout(() => this.setCapabilityValue(capabilityId, false).catch(() => {}), 250);
      this.homey.setTimeout(() => this.setCapabilityValue(capabilityId, false).catch(() => {}), 1000);
    }
  }

  async _resetAllMomentButtons() {
    const caps = [
      'cmd_start_mowing',
      'cmd_start_spot_mowing',
      'cmd_pause',
      'cmd_stop',
      'cmd_dock',
      'cmd_maintenance_point',
      'cmd_refresh',
      'cmd_garage_pause_mode',
      'cmd_garage_test_exit',
      'cmd_garage_save_danger_center',
      'cmd_garage_save_safety_line_a',
      'cmd_garage_save_safety_line_b',
    ];
    await Promise.all(caps.map((cap) => this.hasCapability(cap)
      ? this.setCapabilityValue(cap, false).catch(() => {})
      : Promise.resolve()));
  }

  _runBackgroundCommand(label, fn, releaseKey = null, cap = null) {
    const commandGeneration = this._commandGeneration || 0;
    // Homey mobile shows "Timeout after 10000ms" if a capability listener
    // waits for door sensors, maintenance point, or docking. Start those long
    // garage sequences in the background and return from the listener quickly.
    Promise.resolve()
      .then(async () => {
        if (commandGeneration !== (this._commandGeneration || 0)) {
          this.log(`[${label}] background command skipped: superseded`);
          return;
        }
        return fn();
      })
      .catch((err) => this.error(`[${label}] background error:`, err.message))
      .finally(() => {
        if (releaseKey) this._releaseMomentCommand(releaseKey, cap).catch(() => {});
        if (cap && this.hasCapability(cap)) this.setCapabilityValue(cap, false).catch(() => {});
      });
  }

  /**
   * Execute a cloud write and swallow any error so Homey never shows a red
   * error notification to the user. The next poll will restore the correct
   * capability value if the write was rejected by the API.
   */
  async _safeWrite(label, fn) {
    try {
      if (this._garageSafety && this._garageSafety.log) this._garageSafety.log('command released', label);
      await fn();
      return true;
    } catch (err) {
      this.error(`[write] ${label} rejected by API:`, err.message);
      if (this._garageSafety && this._garageSafety.log) this._garageSafety.log('command rejected', label, err.message);
      return false;
    }
  }

  // ─── Map helpers ──────────────────────────────────────────────────────────

  /**
   * Parse a MITRC base64 track string into the most recent mower position.
   * Binary format: 5-byte records — int16LE x, int16LE y, uint8 flag.
   *   flag=0x00, x≠32767 → position point (dock-relative mm)
   *   flag=0xF8, x=32767 → pen-lift (session boundary)
   *   flag≠0             → metadata / heading records (ignored)
   * Returns dock-relative {x, y} in mm (same axis orientation as MAP). Caller adds dock position.
   */
  _parseMITRCPosition(track) {
    const buf = Buffer.from(track, 'base64');
    let lastX = null;
    let lastY = null;
    const flagCounts = {};
    for (let i = 0; i + 4 < buf.length; i += 5) {
      const x    = buf.readInt16LE(i);
      const y    = buf.readInt16LE(i + 2);
      const flag = buf[i + 4];
      flagCounts[flag] = (flagCounts[flag] || 0) + 1;
      if (flag === 0 && x !== 32767) { lastX = x; lastY = y; }
    }
    this.log(`[mitrc] records=${Math.floor(buf.length / 5)} flags=${JSON.stringify(flagCounts)} last=(${lastX},${lastY})`);
    return lastX !== null ? { x: lastX, y: lastY } : null;
  }

  /**
   * Decode the ARMap binary blob embedded in the MAP JSON.
   * Format: base64([optional-AES-key,]deflated-binary)
   * Binary header (little-endian):
   *   bytes  0–1: map_id      bytes  4: frame_type (must be 73)
   *   bytes  5–6: robotPos.x  bytes  7–8: robotPos.y   bytes  9–10: robotPos.angle
   *   bytes 11–12: chargerPos.x  bytes 13–14: chargerPos.y
   *   bytes 17–18: gridWidth (mm/cell)  bytes 19–20: width  bytes 21–22: height
   *   bytes 23–24: originX    bytes 25–26: originY
   *   bytes 27+: mapInfo (width×height bytes) + JSON expands
   * Returns { robot:{x,y,angle}, charger:{x,y}, gridWidth } or null.
   */
  _parseARMap(arMapStr) {
    if (!arMapStr || typeof arMapStr !== 'string') return null;
    try {
      let base64Data = arMapStr;
      let encKey = null;
      if (arMapStr.includes(',')) {
        const parts = arMapStr.split(',');
        base64Data = parts[0];
        encKey = parts[1];
      }
      base64Data = base64Data.replace(/-/g, '+').replace(/_/g, '/');
      let buf = Buffer.from(base64Data, 'base64');

      if (encKey) {
        const keyHex = crypto.createHash('sha256').update(encKey).digest('hex');
        const aesKey = Buffer.from(keyHex.slice(0, 32), 'utf8');
        const iv = Buffer.alloc(16, 0);
        const dec = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
        buf = Buffer.concat([dec.update(buf), dec.final()]);
      }

      let inflated;
      try { inflated = zlib.inflateSync(buf); } catch (_) { inflated = zlib.inflateRawSync(buf); }
      if (inflated.length < 27) return null;

      const frameType = inflated.readInt8(4);
      if (frameType !== 73) { this.log('[armap] frame_type=' + frameType + ' (expected 73)'); return null; }

      let robotX   = inflated.readInt16LE(5);
      let robotY   = inflated.readInt16LE(7);
      let robotAng = inflated.readInt16LE(9);
      let chargerX = inflated.readInt16LE(11);
      let chargerY = inflated.readInt16LE(13);
      const gridWidth = inflated.readInt16LE(17);
      const mapW      = inflated.readInt16LE(19);
      const mapH      = inflated.readInt16LE(21);
      const originX   = inflated.readInt16LE(23);
      const originY   = inflated.readInt16LE(25);

      // expands JSON (may override header positions)
      const dataEnd = 27 + mapW * mapH;
      if (inflated.length > dataEnd) {
        try {
          const expStr = inflated.slice(dataEnd).toString('utf8').replace(/\0+$/, '');
          const exp = JSON.parse(expStr);
          if (Array.isArray(exp.robot)   && exp.robot.length   >= 2) { robotX = exp.robot[0];   robotY = exp.robot[1];   }
          if (Array.isArray(exp.charger) && exp.charger.length >= 2) { chargerX = exp.charger[0]; chargerY = exp.charger[1]; }
        } catch (_) {}
      }

      return { robot: { x: robotX, y: robotY, angle: robotAng }, charger: { x: chargerX, y: chargerY }, gridWidth, mapW, mapH, originX, originY };
    } catch (e) {
      this.log('[armap] parse error:', e.message);
      return null;
    }
  }

  // ─── Picker management ────────────────────────────────────────────────────

  /**
   * Scan MAP.N chunks for zone and spot IDs, then update the num_zones setting
   * and both pickers. Exits early when nothing has changed.
   * Called every poll cycle (cheap due to change-guard caches).
   */
  async _detectAndSyncZones(raw) {
    const { ids: detectedIds, spotIds, maps } = this._extractMapInfo(raw);

    this._activeZoneIds = detectedIds;

    if (maps.length > 0) {
      this._discoveredMaps = maps;
      await this._updateMapPicker(maps);
    }

    // Parse and cache map data for the map widget.
    // Map geometry (zones, forbidden areas) only changes when md5sum changes.
    // livePath (M_PATH) updates every poll during mowing — refresh it independently.
    // When livePath is empty (mower docked, M_PATH.0="[]"), preserve last known
    // position so the robot marker stays visible on the map.
    const parsed = this._parseMapDataChunks(raw) || this._parseDirectMapData(this._cachedMAPI);
    if (parsed) {
      if (parsed.md5sum !== this._cachedMapData?.md5sum) {
        this._cachedMapData = parsed;
        this.log(`[map] cached: ${parsed.name}, ${parsed.mowingAreas.length} zones, ${parsed.livePath.length} path pts`);
      } else if (this._cachedMapData && parsed.livePath.length > 0) {
        this._cachedMapData = { ...this._cachedMapData, livePath: parsed.livePath, chargerPos: parsed.chargerPos };
      } else if (this._cachedMapData) {
        this._cachedMapData = { ...this._cachedMapData, chargerPos: parsed.chargerPos || this._cachedMapData.chargerPos };
      }
    }

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
   * Concatenate MAP.N chunks, parse the outer JSON array, and extract:
   *   - ids:      sorted zone IDs from the active map (e.g. [1, 2, 3])
   *   - spotIds:  sorted spot IDs from the active map (e.g. [1001, 1002])
   *   - maps:     all discovered maps [{ index, name }]
   *
   * Zone/spot extraction is scoped to the map entry matching _activeMapIndex.
   * Returns { ids: [], spotIds: [], maps: [] } when no MAP data is present.
   */
  _extractMapInfo(raw) {
    const parts = [];
    for (let i = 0; raw[`MAP.${i}`] != null; i++) parts.push(raw[`MAP.${i}`]);
    const mapStr = parts.join('');
    if (!mapStr) return { ids: [], spotIds: [], maps: [] };

    // MAP chunks form a JSON array of double-encoded strings: ["<map0>","<map1>"]
    // Parse the outer array to discover maps and extract zones/spots per map.
    const maps = [];
    let activeMapStr = null;
    try {
      let combined = mapStr;
      {
        let depth = 0, inStr = false, esc = false;
        for (let ci = 0; ci < combined.length; ci++) {
          const ch = combined[ci];
          if (esc)               { esc = false; continue; }
          if (ch === '\\' && inStr) { esc = true; continue; }
          if (ch === '"')         { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '[' || ch === '{') depth++;
          if ((ch === ']' || ch === '}') && --depth === 0) { combined = combined.slice(0, ci + 1); break; }
        }
      }
      const outer = JSON.parse(combined);
      if (Array.isArray(outer)) {
        const seen = new Set();
        for (const entry of outer) {
          if (typeof entry !== 'string') continue;
          try {
            const m = JSON.parse(entry);
            const idx = typeof m.mapIndex === 'number' ? m.mapIndex : -1;
            if (idx < 0 || seen.has(idx)) continue;
            if (!m.boundary) continue;
            seen.add(idx);
            maps.push({ index: idx, name: m.name || `Map ${idx + 1}` });
            if (idx === this._activeMapIndex) activeMapStr = entry;
          } catch {}
        }
        maps.sort((a, b) => a.index - b.index);
      }
    } catch {}

    // Use only the active map's JSON for zone/spot extraction
    const searchStr = activeMapStr || mapStr;

    // ── Zone IDs from mowingAreas section ──────────────────────────────────
    const idSet = new Set();
    const maIdx = searchStr.indexOf('mowingAreas');
    if (maIdx !== -1) {
      const endIdx = searchStr.indexOf('forbiddenAreas', maIdx);
      const section = searchStr.slice(maIdx, endIdx === -1 ? maIdx + 4000 : endIdx);
      for (const m of section.matchAll(/\[(\d{1,3}),\{/g)) {
        const id = parseInt(m[1], 10);
        if (id >= 1 && id <= 99) idSet.add(id);
      }
    }

    // ── Spot IDs ────────────────────────────────────────────────────────────
    const spotSet = new Set();
    const SPOT_SECTION_NAMES = ['cleanSpots', 'spots', 'customAreas', 'virtualSpots'];
    let spotSectionFound = false;

    for (const name of SPOT_SECTION_NAMES) {
      const idx = searchStr.indexOf(name);
      if (idx === -1) continue;
      spotSectionFound = true;
      const section = searchStr.slice(idx, idx + 8000);
      for (const m of section.matchAll(/\[(\d{4,5}),\{/g)) {
        const id = parseInt(m[1], 10);
        if (id >= 1000 && id <= 99999) spotSet.add(id);
      }
      for (const m of section.matchAll(/"id"\s*:\s*(\d{4,5})/g)) {
        const id = parseInt(m[1], 10);
        if (id >= 1000 && id <= 99999) spotSet.add(id);
      }
      break;
    }

    if (!spotSectionFound) {
      const noMa = maIdx !== -1 ? searchStr.slice(0, maIdx) + searchStr.slice(maIdx + 4000) : searchStr;
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
      maps,
    };
  }

  /**
   * Rebuild the mow_map picker values from discovered maps.
   * Change-guarded — no-ops when the map list is unchanged.
   */
  async _updateMapPicker(maps) {
    if (!this.hasCapability('mow_map')) return;
    const key = maps.map((m) => `${m.index}:${m.name}`).join(',');
    if (key === this._lastMapPickerKey) return;
    this._lastMapPickerKey = key;

    const values = maps.map((m) => ({
      id: `map_${m.index}`,
      title: { en: m.name, de: m.name },
    }));

    this.log(`[picker] mow_map updated: ${values.map((v) => `${v.id} "${v.title.en}"`).join(', ')}`);
    await this.setCapabilityOptions('mow_map', { values })
      .catch((e) => this.error('setCapabilityOptions mow_map:', e.message));

    const currentVal = this.getCapabilityValue('mow_map');
    const activeId = `map_${this._activeMapIndex}`;
    if (currentVal !== activeId && values.some((v) => v.id === activeId)) {
      await this.setCapabilityValue('mow_map', activeId).catch(() => {});
    }
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
    // Max life configurable per device (default: blade=100h, brush=500h, robot=60h).
    if (Array.isArray(cfg.CMS) && cfg.CMS.length >= 3) {
      const CMS_MAX = [
        (this.getSetting('cms_blade_max') || 100) * 60,
        (this.getSetting('cms_brush_max') || 500) * 60,
        (this.getSetting('cms_robot_max') || 60)  * 60,
      ];
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
   *
   * OTA_INFO.0 = JSON array "[installState, flag]"
   *   installState (index 0): 1=up_to_date, 2=available, 3=installing, 4=download_failed
   *   flag         (index 1): legacy boolean-like fallback (1 = update available)
   *
   * Source: antondaubert/dreame-mower property/device.py OTA_INFO handling
   */
  async _applyOTAInfo(raw) {
    const otaStr = raw['OTA_INFO.0'];
    if (!otaStr) return;
    try {
      const ota = JSON.parse(otaStr);
      if (Array.isArray(ota) && ota.length >= 2) {
        await this._applyFirmwareState(ota[0], ota[1]);
      }
    } catch { /* malformed OTA_INFO, skip */ }
  }

  // ─── Capability helpers ───────────────────────────────────────────────────

  /**
   * Map OTA install-state code to the firmware_update enum capability.
   * @param {number} installState  0 index of OTA_INFO array (1–4)
   * @param {number} fallbackFlag  1 index of OTA_INFO array (legacy boolean-like)
   */
  async _applyFirmwareState(installState, fallbackFlag = 0) {
    let state;
    switch (installState) {
      case 1:  state = 'up_to_date';      break;
      case 2:  state = 'available';       break;
      case 3:  state = 'installing';      break;
      case 4:  state = 'download_failed'; break;
      default: state = fallbackFlag === 1 ? 'available' : 'up_to_date';
    }

    const prev = this.getCapabilityValue('firmware_update');
    await this._setCap('firmware_update', state);
    if (state === 'available' && prev !== 'available') {
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
    // Pass { pct, prev } as trigger state so the run-listener can detect an exact
    // threshold crossing (prev >= threshold > pct). This ensures each configured
    // threshold fires at most once per descent, rather than on every poll decrement.
    if (prev !== null && pct < prev) {
      this._trgBatteryLow.trigger(this, {}, { pct, prev })
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

    // Charging/docked information is often more reliable than latestStatus during
    // the final garage return. Feed it into the garage state machine so Zuhause
    // and the final close request are not missed when latestStatus remains idle.
    if (this._garageSafety && ['charging', 'charging_completed', 'docked'].includes(status)) {
      this._garageSafety.onStatus('charging', this._nativeMowerStatus || 'unknown')
        .catch((e) => this.error('[garage] charging status hook:', e.message));
    }
    await this._updateCommandButtonUi(this._nativeMowerStatus || this.getCapabilityValue('mower_status')).catch(() => {});
  }

  async _applyStatus(status, faultCode = 0) {
    const validMowerStatuses = new Set(['idle', 'mowing', 'standby', 'paused', 'error', 'returning', 'charging', 'mapping', 'docked', 'updating', 'remote_control', 'garage']);
    if (!validMowerStatuses.has(status)) {
      const retained = this._nativeMowerStatus || this.getCapabilityValue('mower_status') || 'idle';
      this.log(`[status] unsupported native value ${JSON.stringify(status)} ignored; retaining ${retained}`);
      return;
    }
    // Keep the real Dreame/Mova status separate from the optional garage display
    // status. The garage extension may show "Zuhause", "Justieren",
    // "Garage öffnet" or "Garage schließt" on the tile, but the state
    // machine still evaluates the original raw mower status.
    const prev = this._nativeMowerStatus || this.getCapabilityValue('mower_status');

    // RC34: Pause debounce/hold. After pressing Pause, the cloud/device may
    // still publish one or more stale "mowing" states although the mower has
    // already accepted the pause command. During that short window, keep the
    // UI and command semantics in PAUSED/RESUME mode. This is deliberately
    // local to the button state and does not touch garage return handling.
    if (this._pauseButtonHoldUntil && Date.now() < this._pauseButtonHoldUntil
        && this._pauseButtonHoldMode === 'resume' && status === 'mowing') {
      this.log('[cmd] stale native mowing ignored during pause button hold');
      status = 'paused';
    }

    // RC112: after an explicit Resume (including Start Mowing used as Resume),
    // MOVA cloud telemetry can keep publishing stale `paused` although the mower
    // is physically moving and mowing. While the resume semantic latch is active
    // and the next button action is Pause, keep the internal/UI state on mowing.
    // A real user Pause clears the latch before sending the command, so genuine
    // paused telemetry still passes through immediately.
    if (status === 'paused'
        && this._resumeSemanticUntil && Date.now() < this._resumeSemanticUntil
        && this._pauseButtonHoldMode === 'pause') {
      this.log('[cmd] stale native paused ignored during confirmed resume latch');
      status = 'mowing';
    }

    this._nativeMowerStatus = status;

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

    const requestedDisplayStatus = this._garageSafety && this._garageSafety.getTileStatus
      ? this._garageSafety.getTileStatus(status)
      : status;
    // Homey's mower_status capability is a strict enum. Never write transient
    // internal values such as "unknown" into it. Keep the last valid visible
    // state (or the valid native state) until fresh telemetry arrives.
    const validDisplayStatuses = new Set([
      'idle', 'mowing', 'standby', 'paused', 'error', 'returning', 'charging',
      'mapping', 'docked', 'updating', 'remote_control', 'garage_home',
      'garage_exiting', 'garage_adjusting', 'garage_opening', 'garage_closing',
      'garage_maintenance_transit', 'garage_maintenance_reached', 'garage_free_drive', 'garage_positioning', 'garage_app_control',
    ]);
    const currentDisplayStatus = this.getCapabilityValue('mower_status');
    const displayStatus = validDisplayStatuses.has(requestedDisplayStatus)
      ? requestedDisplayStatus
      : (validDisplayStatuses.has(currentDisplayStatus)
        ? currentDisplayStatus
        : (validDisplayStatuses.has(status) ? status : 'idle'));
    if (displayStatus !== requestedDisplayStatus) {
      this.log(`[status] invalid display value ${JSON.stringify(requestedDisplayStatus)} suppressed; retaining ${displayStatus}`);
    }

    await this._updateCommandButtonUi(status).catch((e) => this.error('[buttons] update UI:', e.message));

    if (status === prev && this.getCapabilityValue('mower_status') === displayStatus) return;

    await this._setCap('mower_status', displayStatus);
    const resumeGuardActive = this._resumeGuardUntil && Date.now() < this._resumeGuardUntil;
    if (status === 'mowing' && prev !== 'mowing' && !resumeGuardActive) {
      this._garageSafety.onExternalMowingDetected().catch((e) => this.error('[garage] external start guard:', e.message));
    } else if (status === 'mowing' && prev !== 'mowing' && resumeGuardActive) {
      this.log('[garage] mowing after resume accepted without garage start flow');
    }
    this._garageSafety.onStatus(status, prev).catch((e) => this.error('[garage] status hook:', e.message));

    this._trgStatusChanged
      .trigger(this, { status }, {})
      .catch((e) => this.error('status_changed trigger:', e.message));

    // Session duration tracking
    if (isMowing && !this._wasMowing) {
      // RC82: keep the last accepted native position until a fresh consistent
      // update arrives. Clearing it here caused the marker to jump to the dock or
      // to a lower-priority fallback at every new mowing session.
      this._positionCandidate = null;
      // Record and persist the start time.
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

    // Upstream 1.1.21 error classification: true errors alarm, warnings are
    // displayed without promoting the mower to an error state, info codes stay silent.
    const isError = status === 'error';
    const isWarning = !isError && WARNING_DEVICE_CODES.has(faultCode);
    await this._setCap('alarm_generic', isError);
    if (isError || isWarning) {
      const errorDescription = this.homey.__(`error_codes.${faultCode}`)
                            || this.homey.__('error_codes.unknown').replace('__code__', faultCode);
      if (this.hasCapability('mower_error')) await this._setCap('mower_error', errorDescription);
      if (isError) {
        this._trgError.trigger(this, { error_code: faultCode, error_description: errorDescription }, {})
          .catch((e) => this.error('mower_error trigger:', e.message));
      }
    } else if (this.hasCapability('mower_error')) {
      await this._setCap('mower_error', null);
    }

    // Reset action buttons when the mower reaches a resting state
    if (HOME_STATUSES.has(status)) {
      if (this.hasCapability('cmd_dock'))                await this.setCapabilityValue('cmd_dock',                false).catch(() => {});
      if (this.hasCapability('cmd_stop'))                await this.setCapabilityValue('cmd_stop',                false).catch(() => {});
      if (this.hasCapability('cmd_start_mowing'))        await this.setCapabilityValue('cmd_start_mowing',        false).catch(() => {});
      if (this.hasCapability('cmd_start_spot_mowing'))   await this.setCapabilityValue('cmd_start_spot_mowing',   false).catch(() => {});
      if (this.hasCapability('cmd_maintenance_point'))   await this.setCapabilityValue('cmd_maintenance_point',   false).catch(() => {});
    }

    // Reset pause button once the mower confirms it is paused, but keep the
    // label/icon in Resume mode so the next tap really resumes.
    if (status === 'paused' && this.hasCapability('cmd_pause')) {
      this._pauseButtonHoldMode = 'resume';
      this._pauseButtonHoldUntil = Math.max(this._pauseButtonHoldUntil || 0, Date.now() + 120000);
      await this._updateCommandButtonUi('paused').catch(() => {});
      await this.setCapabilityValue('cmd_pause', false).catch(() => {});
    }
    // Pickers (mow_zone / mow_spot) intentionally keep their selection so the user
    // can re-run the same zone or spot by pressing cmd_start_mowing again.

    // Returning trigger
    if (status === 'returning') {
      this._trgReturning.trigger(this, {}, {})
        .catch((e) => this.error('mower_returning trigger:', e.message));
    }

    // Docked trigger
    if (status === 'docked' || status === 'charging' || status === 'charging_completed') {
      this._trgDocked.trigger(this, {}, {})
        .catch((e) => this.error('mower_docked trigger:', e.message));
    }

    // Mowing completed — fire once when the session definitively ends.
    //
    // The trigger must NOT fire on every mowing→returning transition because some mowers
    // (e.g. with automatic edge-mowing enabled) cycle returning→mowing between phases.
    // Strategy: snapshot battery/settings on the first returning transition; fire (or
    // suppress for charge-break) only when the mower reaches a true resting state.
    //
    // Cases covered:
    // A. mowing → returning → home: normal end or "Return to Dock"
    //    Snapshot battery at returning (most accurate for charge-break check); fire at home.
    // B. mowing → home (no returning): manual "End" in Dreame app.
    //    No snapshot captured; check live battery.
    // C. mowing → paused → home: paused then ended.
    //    _wasMowingSession preserved through paused; caught by case B.
    // D. mowing → returning → mowing (mid-session, e.g. edge phase after main area):
    //    _wasMowingSession preserved through returning; snapshot cleared when mowing resumes.
    if (this._wasMowingSession && isReturning && !this._returnSnapshot) {
      // Capture charge-break data at the moment the mower decides to return.
      this._returnSnapshot = {
        battery:    this.getCapabilityValue('measure_battery') ?? 100,
        returnPct:  this.getSetting('bat_return_pct')  ?? 15,
        autoResume: this.getSetting('bat_auto_resume') ?? false,
      };
    }

    if (this._wasMowingSession && HOME_STATUSES.has(status)) {
      const snap        = this._returnSnapshot ?? {};
      const battery     = snap.battery    ?? (this.getCapabilityValue('measure_battery') ?? 100);
      const returnPct   = snap.returnPct  ?? (this.getSetting('bat_return_pct')  ?? 15);
      const autoResume  = snap.autoResume ?? (this.getSetting('bat_auto_resume') ?? false);
      const isChargeBreak = autoResume && battery <= (returnPct + 2);
      if (!isChargeBreak) {
        this._trgMowingCompleted.trigger(this, {}, {})
          .catch((e) => this.error('mowing_completed trigger:', e.message));
      } else {
        this.log(`[trigger] mowing_completed suppressed — charge break (battery=${battery}% ≤ returnPct=${returnPct}%+2)`);
      }
      this._returnSnapshot = null;
    }

    this._wasMowing = isMowing;
    if (isMowing) {
      this._wasMowingSession = true;
      this._returnSnapshot   = null; // mid-session return; clear snapshot so next return re-captures
    } else if (!isReturning && status !== 'paused' && status !== 'error') {
      this._wasMowingSession = false;
    }
  }

  // ─── Shared mowing state helper ───────────────────────────────────────────

  async _setMowingStarted() {
    // In garage mode the original command has only been released; the mower may
    // still be under the gate and orienting. Do not optimistically switch the
    // native state to mowing. The real Dreame/Mova status update will do that.
    if (this._garageSafety && this._garageSafety.enabled && this._garageSafety.enabled()) {
      await this._garageSafety.refreshTileStatus('start command sent; waiting for native mowing').catch(() => {});
      return;
    }
    await this._applyStatus('mowing');
  }

  // ─── Public commands (called by flow cards) ────────────────────────────────

  async cmdStartMowing() {
    const did  = this.getData().id;
    const mode = await this.getStoreValue('mowing_mode') || 'all_area';
    this.log(`[cmd] startMowing mode=${mode}`);

    switch (mode) {
      case 'edge':
        if (await this._garageSafety.startRequested('flow_start_edge', async () => this._api.startEdgeMowing(did))) await this._setMowingStarted();
        break;
      case 'zone': {
        const ids    = (await this.getStoreValue('mowing_zone_ids')) || [];
        const mapIdx = this._activeMapIndex ?? 0;
        this.log(`[cmd] zone ids=${ids.join(',')}`);
        if (await this._garageSafety.startRequested('flow_start_zone', async () => this._api.startZoneMowing(did, ids, mapIdx))) await this._setMowingStarted();
        break;
      }
      case 'spot': {
        const ids = (await this.getStoreValue('mowing_spot_ids')) || [];
        this.log(`[cmd] spot ids=${ids.join(',')}`);
        if (await this._garageSafety.startRequested('flow_start_spot_mode', async () => this._api.startSpotMowing(did, ids))) await this._setMowingStarted();
        break;
      }
      case 'manual':
        if (await this._garageSafety.startRequested('flow_start_manual', async () => this._api.startManualMowing(did))) await this._setMowingStarted();
        break;
      default:
        if (await this._garageSafety.startRequested('flow_start_all', async () => this._api.startMowing(did))) await this._setMowingStarted();
    }
  }

  async cmdStartZoneMowing(zonesStr) {
    const did     = this.getData().id;
    const zoneIds = zonesStr.split(',').map((s) => s.trim()).filter(Boolean);
    this.log(`[cmd] startZoneMowing zones=${zoneIds.join(',')}`);
    await this.setStoreValue('mowing_zone_ids', zoneIds);
    const mapIdx = this._activeMapIndex ?? 0;
    if (await this._garageSafety.startRequested('flow_start_zone', async () => this._api.startZoneMowing(did, zoneIds, mapIdx))) await this._setMowingStarted();
  }

  async cmdStartEdgeMowing() {
    const did    = this.getData().id;
    const mapIdx = this._activeMapIndex ?? 0;
    this.log(`[cmd] startEdgeMowing mapIndex=${mapIdx}`);
    if (await this._garageSafety.startRequested('flow_start_edge', async () => this._api.startEdgeMowing(did, mapIdx))) await this._setMowingStarted();
  }

  async cmdStartEdgeZoneMowing(zoneNum) {
    const did    = this.getData().id;
    const mapIdx = this._activeMapIndex ?? 0;
    this.log(`[cmd] startEdgeZoneMowing zone=${zoneNum} mapIndex=${mapIdx}`);
    if (await this._garageSafety.startRequested('flow_start_edge_zone', async () => this._api.startEdgeZoneMowing(did, Number(zoneNum), mapIdx))) await this._setMowingStarted();
  }

  async cmdStartBorderPatrol(zoneNum) {
    const did    = this.getData().id;
    const mapIdx = this._activeMapIndex ?? 0;
    this.log(`[cmd] startBorderPatrol zone=${zoneNum} mapIndex=${mapIdx}`);
    if (await this._garageSafety.startRequested('flow_start_border', async () => this._api.startBorderPatrol(did, Number(zoneNum), mapIdx))) await this._setMowingStarted();
  }

  async cmdStartSpotMowing(spotsStr) {
    const did     = this.getData().id;
    const spotIds = spotsStr.split(',').map((s) => s.trim()).filter(Boolean);
    this.log(`[cmd] startSpotMowing spots=${spotIds.join(',')}`);
    await this.setStoreValue('mowing_spot_ids', spotIds);
    if (await this._garageSafety.startRequested('flow_start_spot', async () => this._api.startSpotMowing(did, spotIds))) await this._setMowingStarted();
  }


  async _resumeMowingRobust(label = 'resume') {
    const did = this.getData().id;
    this._pauseButtonHoldMode = 'pause';
    this._pauseButtonHoldUntil = Date.now() + 120000;
    // Keep command semantics, tile state and the next Pause/Fortsetzen action in
    // mowing mode even when the cloud remains stale on paused after movement has
    // resumed. Every robust resume entry point gets the same latch and garage
    // pause-return cancellation, including Start Mowing used as Resume.
    this._resumeSemanticUntil = Date.now() + 120000;
    if (this._garageSafety?.enabled?.() && typeof this._garageSafety.noteUserResumeRequested === 'function') {
      this._garageSafety.noteUserResumeRequested();
    }
    // Pause→Resume is not a new start. Guard the garage state machine against
    // interpreting the following mowing status as an external start. Do not
    // optimistically trust a single cloud status flip: the A2 can briefly show
    // mowing while the physical mower is still paused. Therefore a resume press
    // always gets one delayed original-start fallback, which behaves like resume
    // for the current task but does not enter the garage start flow.
    this._resumeGuardUntil = Date.now() + 120000;
    if (this._garageSafety && typeof this._garageSafety.markResumeInProgress === 'function') {
      this._garageSafety.markResumeInProgress(120000, label);
    }
    let ok = await this._safeWrite(label, () => this._api.resume(did));
    await sleep(1800);
    await this._poll().catch(() => {});
    if (this._isPausedLike() || this._nativeMowerStatus !== 'mowing') {
      ok = await this._safeWrite(`${label}_fallback_start`, () => this._api.startMowing(did));
      await sleep(1500);
      await this._poll().catch(() => {});
    } else {
      // Even when the cloud already says mowing, send one idempotent resume/start
      // stabilizer shortly after the button press. Field tests showed this is the
      // difference between a visual resume and actual blade/drive movement.
      this.homey.setTimeout(() => this._safeWrite(`${label}_stabilize_start`, () => this._api.startMowing(did)).catch(() => {}), 1200);
    }
    await this._applyStatus('mowing').catch(() => {});
    await this._updateCommandButtonUi('mowing').catch(() => {});
    this.homey.setTimeout(() => this._poll().catch(() => {}), 3000);
    return ok;
  }

  async cmdPause() {
    const status = this._nativeMowerStatus || this.getCapabilityValue('mower_status');
    if (status === 'paused') {
      this.log('[cmd] resume');
      this._pauseButtonHoldMode = 'pause';
      this._pauseButtonHoldUntil = Date.now() + 90000;
      await this._resumeMowingRobust('flow_resume');
    } else {
      this.log('[cmd] pause');
      this._pauseButtonHoldMode = 'resume';
      this._pauseButtonHoldUntil = Date.now() + 90000;
      await this._api.pause(this.getData().id);
      await this._applyStatus('paused');
    }
  }

  async cmdResume() {
    const did = this.getData().id;
    if (this._garageSafety?.enabled?.()) return this._resumeMowingRobust('flow_resume');
    return this._safeWrite('flow_resume', () => this._api.startMowing(did));
  }

  async cmdStop() {
    this.log('[cmd] stop');
    await this._api.stopMowing(this.getData().id);
  }

  async cmdDock() {
    this.log('[cmd] dock');
    await this._garageSafety.returnRequested('flow_dock', async () => {
      await this._api.dock(this.getData().id);
      await this._applyStatus('returning');
    }, async () => this._goToMaintenancePointGuarded('flow_maintenance'));
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


  _maintenancePointIndex() {
    return resolveMaintenancePointIndex(this);
  }

  async _goToMaintenancePointGuarded(label = 'maintenance') {
    const did = this.getData().id;
    const mapIdx = this._activeMapIndex ?? 0;
    const pointIndex = this._maintenancePointIndex();
    this.log(`[maintenance] ${label}: opcode 109 map=${mapIdx} point=${pointIndex}`);
    return this._safeWrite(`${label}:maintenance:${pointIndex}`, () => this._api.goToMaintenancePoint(did, mapIdx, pointIndex));
  }

  async cmdGoToMaintenancePoint() {
    this.log('[cmd] goToMaintenancePoint');
    await this._garageSafety.maintenanceRequested('flow_maintenance', async () => this._goToMaintenancePointGuarded('flow_maintenance'));
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


  async cmdGarageSetDoorState(state) {
    await this._garageSafety.setDoorState(state);
  }

  async cmdGarageSetSensorAvailable(status) {
    await this._garageSafety.setSensorAvailable(status);
  }

  async cmdGarageSetSensorBattery(battery) {
    await this._garageSafety.setSensorBattery(battery);
  }

  async cmdGarageSafeReturn() {
    await this._garageSafety.returnRequested('flow_garage_safe_return', async () => this._api.dock(this.getData().id), async () => this._goToMaintenancePointGuarded('flow_maintenance'));
  }

  _fireBtnTrigger(cardId) {
    this.homey.flow.getDeviceTriggerCard(cardId).trigger(this).catch(() => {});
  }

  async cmdSetLiftAlarm(enabled) {
    this.log(`[cmd] setLiftAlarm enabled=${enabled}`);
    const did = this.getData().id;
    const lift     = enabled;
    const mapAlarm = this.getSetting('ata_map_alarm') ?? false;
    const realtime = this.getSetting('ata_realtime')  ?? false;
    await this._api.setAntiTheftAlarm(did, { lift, mapAlarm, realtime });
    await this.setSettings({ ata_lift: enabled });
  }

  async cmdSetChildLock(enabled) {
    this.log(`[cmd] setChildLock enabled=${enabled}`);
    const did = this.getData().id;
    await this._api.setChildLock(did, enabled);
    await this.setSettings({ cls_enabled: enabled });
    if (this.hasCapability('child_lock')) await this._applyBoolCap('child_lock', enabled);
  }

  async cmdSetActiveMap(mapIndex) {
    this.log(`[cmd] setActiveMap mapIndex=${mapIndex}`);
    const did = this.getData().id;
    await this._api.switchMap(did, mapIndex);
    this._activeMapIndex = mapIndex;
    this._mapSwitchCooldown = Date.now() + 120000;
    await this.setStoreValue('active_map_index', mapIndex);
    this._lastZonePickerKey = null;
    this._lastSpotPickerKey = null;
    if (this.hasCapability('mow_map')) {
      await this.setCapabilityValue('mow_map', `map_${mapIndex}`).catch(() => {});
    }
    if (this._lastRawData) await this._detectAndSyncZones(this._lastRawData);
    this._fireMapChangedTrigger(mapIndex);
  }

  async cmdRefreshData() {
    this.log('[cmd] refreshData → forcing full poll');
    this._cfgPollCounter   = 0;
    this._mihisPollCounter = 0;
    this._dockPollCounter  = 0;
    this._obsPollCounter   = 0;
    this._lastZonePickerKey  = null;
    this._lastSpotPickerKey  = null;
    this._lastMapPickerKey   = null;
    await this._poll();
  }

  getMapAutocomplete(query) {
    const maps = this._discoveredMaps || [];
    const q = (query || '').toLowerCase();
    return maps
      .filter((m) => m.name.toLowerCase().includes(q))
      .map((m) => ({ id: String(m.index), name: m.name }));
  }

  _fireMapChangedTrigger(mapIndex) {
    const maps = this._discoveredMaps || [];
    const map = maps.find((m) => m.index === mapIndex);
    const name = map ? map.name : `Map ${mapIndex + 1}`;
    this._trgMapChanged.trigger(this, { map_name: name, map_index: mapIndex }).catch(() => {});
  }

  _appendLiveRoutePoint(pos, source = '') {
    if (!pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) return;
    if (String(source || '').startsWith('garage-marker')) return;
    const status = String(this._nativeMowerStatus || this.getCapabilityValue('mower_status') || '').toLowerCase();
    const active = new Set(['mowing', 'edge_mowing', 'leaving', 'returning', 'paused', 'remote_control', 'adjusting', 'positioning']);
    if (!active.has(status)) return;

    if (!Array.isArray(this._liveRouteTrail)) this._liveRouteTrail = [];
    const point = [Math.round(Number(pos.x)), Math.round(Number(pos.y))];
    let last = null;
    for (let i = this._liveRouteTrail.length - 1; i >= 0; i--) {
      if (this._liveRouteTrail[i][0] !== 32767) { last = this._liveRouteTrail[i]; break; }
    }
    if (last) {
      const distance = Math.hypot(point[0] - last[0], point[1] - last[1]);
      if (distance < 80) return;
      if (distance > 3000) this._liveRouteTrail.push([32767, -32768]);
    }
    this._liveRouteTrail.push(point);
    if (this._liveRouteTrail.length > 800) this._liveRouteTrail = this._liveRouteTrail.slice(-800);
  }

  _setLivePosition(pos, source = '') {
    if (!pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) return false;
    const now = Date.now();
    const src = String(source || 'unknown');
    const next = { x: Number(pos.x), y: Number(pos.y), ts: Number(pos.ts) || now, source: src };
    const current = this._livePos && Number.isFinite(Number(this._livePos.x)) && Number.isFinite(Number(this._livePos.y))
      ? this._livePos : null;

    if (!current || now - Number(current.ts || 0) > 30000) {
      this._livePos = next;
      this._lastLivePos = next;
      this._lastLivePosAt = next.ts;
      this._positionCandidate = null;
      this._appendLiveRoutePoint(next, src);
      return true;
    }

    const dtMs = Math.max(1, next.ts - Number(current.ts || now));
    const distance = Math.hypot(next.x - Number(current.x), next.y - Number(current.y));
    const currentPriority = Number(this._positionSourcePriority?.[current.source] ?? 0);
    const nextPriority = Number(this._positionSourcePriority?.[src] ?? 0);
    const maxPlausibleSpeedMmS = 1200; // >2x normal A2 mowing speed, still rejects map-scale teleports.
    const allowedDistance = 900 + maxPlausibleSpeedMmS * (dtMs / 1000);
    const lowerPriorityOverride = nextPriority < currentPriority && now - Number(current.ts || 0) < 12000;

    if (!lowerPriorityOverride && distance <= allowedDistance) {
      this._livePos = next;
      this._lastLivePos = next;
      this._lastLivePosAt = next.ts;
      this._positionCandidate = null;
      this._appendLiveRoutePoint(next, src);
      return true;
    }

    // A large/source-conflicting jump is accepted only after two mutually
    // consistent samples. Until then both map and safety logic retain the last
    // plausible position, eliminating alternating correct/incorrect markers.
    const candidate = this._positionCandidate;
    const matchesCandidate = candidate
      && candidate.source === src
      && now - Number(candidate.firstAt || 0) <= 15000
      && Math.hypot(next.x - candidate.x, next.y - candidate.y) <= 800;
    if (matchesCandidate) {
      candidate.hits += 1;
      candidate.x = next.x;
      candidate.y = next.y;
      candidate.ts = next.ts;
    } else {
      this._positionCandidate = { ...next, hits: 1, firstAt: now };
    }

    if (this._positionCandidate.hits >= 2 && !lowerPriorityOverride) {
      const accepted = { x: this._positionCandidate.x, y: this._positionCandidate.y, ts: this._positionCandidate.ts, source: src };
      this._livePos = accepted;
      this._lastLivePos = accepted;
      this._lastLivePosAt = accepted.ts;
      this._positionCandidate = null;
      this.log(`[pos] confirmed source transition ${current.source || '-'} -> ${src}; jump=${Math.round(distance)}mm`);
      this._appendLiveRoutePoint(accepted, src);
      return true;
    }

    if (!this._positionRejectLogAt || now - this._positionRejectLogAt > 10000) {
      this._positionRejectLogAt = now;
      this.log(`[pos] implausible/conflicting update held: source=${src}; current=${current.source || '-'}; jump=${Math.round(distance)}mm; dt=${dtMs}ms`);
    }
    return false;
  }

  _getBufferedLivePosition(maxAgeMs = 45000) {
    const now = Date.now();
    if (this._livePos
      && Number.isFinite(Number(this._livePos.x))
      && Number.isFinite(Number(this._livePos.y))
      && now - Number(this._livePos.ts || this._lastLivePosAt || 0) <= maxAgeMs) return this._livePos;
    if (this._lastLivePos
      && Number.isFinite(Number(this._lastLivePos.x))
      && Number.isFinite(Number(this._lastLivePos.y))
      && now - Number(this._lastLivePosAt || this._lastLivePos.ts || 0) <= maxAgeMs) return this._lastLivePos;
    return null;
  }

  async _getFreshGarageMarkerPosition() {
    // RC86 marker capture: use a short burst of native positions and persist the
    // median only after the samples agree. A single cloud response may be stale
    // or may briefly use another coordinate source, which previously made B
    // reuse A or placed the line outside the map.
    const did = this.getData().id;
    const samples = [];
    const collect = async () => {
      const p = await this._api.getMowerPosition(did).catch((e) => {
        this.error('[garage] fresh marker position:', e.message);
        return null;
      });
      if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
        samples.push({ x: Number(p.x), y: Number(p.y), ts: Date.now() });
      }
    };

    for (let i = 0; i < 5; i += 1) {
      await collect();
      if (i < 4) await new Promise((resolve) => setTimeout(resolve, 350));
    }

    if (samples.length < 3) {
      await this._poll().catch(() => {});
      const live = this._getBufferedLivePosition(2500);
      if (live && Number.isFinite(Number(live.x)) && Number.isFinite(Number(live.y))) {
        samples.push({ x: Number(live.x), y: Number(live.y), ts: Number(live.ts) || Date.now() });
      }
    }
    if (samples.length < 3) return null;

    const median = (values) => {
      const a = values.slice().sort((x, y) => x - y);
      const m = Math.floor(a.length / 2);
      return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    };
    const x = median(samples.map((p) => p.x));
    const y = median(samples.map((p) => p.y));
    const deviations = samples.map((p) => Math.hypot(p.x - x, p.y - y)).sort((a, b) => a - b);
    const p80 = deviations[Math.min(deviations.length - 1, Math.floor(deviations.length * 0.8))];
    if (!Number.isFinite(p80) || p80 > 450) {
      this.log(`[garage] marker capture rejected: unstable native positions; spread=${Math.round(p80 || 0)}mm`);
      return null;
    }

    const direct = { x: Math.round(x), y: Math.round(y), ts: Date.now(), source: 'garage-marker-direct' };

    // RC87: a repeated cloud property can be internally stable but several
    // seconds old. Marker setup happens mainly while paused/remote-controlled,
    // so compare the direct burst with the freshest accepted native/map stream.
    // If Homey's currently displayed native point is fresh and the cloud burst
    // disagrees by more than 0.8 m, use the fresh displayed point instead of
    // persisting a stale coordinate. This keeps marker, robot and overlay in one
    // coordinate/time frame and prevents danger centre/A/B from jumping to an
    // earlier maintenance or dock position.
    const buffered = this._getBufferedLivePosition(8000);
    const tail = this._lastMPathPos();
    const bufferedPoint = buffered && Number.isFinite(Number(buffered.x)) && Number.isFinite(Number(buffered.y))
      ? { x: Number(buffered.x), y: Number(buffered.y), ts: Number(buffered.ts) || Date.now(), source: buffered.source || 'accepted-live' }
      : null;
    const tailPoint = Array.isArray(tail) && Number.isFinite(Number(tail[0])) && Number.isFinite(Number(tail[1]))
      ? { x: Number(tail[0]), y: Number(tail[1]), ts: Date.now(), source: 'm-path-tail' }
      : null;

    let selected = direct;
    if (bufferedPoint) {
      const directVsBuffered = Math.hypot(direct.x - bufferedPoint.x, direct.y - bufferedPoint.y);
      const bufferedVsTail = tailPoint ? Math.hypot(bufferedPoint.x - tailPoint.x, bufferedPoint.y - tailPoint.y) : null;
      if (directVsBuffered > 800 && (bufferedVsTail === null || bufferedVsTail <= 1000)) {
        selected = { ...bufferedPoint, ts: Date.now(), source: 'garage-marker-fresh-live' };
        this.log(`[garage] stale direct marker position replaced: direct/live delta=${Math.round(directVsBuffered)}mm`);
      }
    }

    // Feed the selected marker point back through the normal arbitration so the
    // map immediately shows the exact coordinate that was persisted.
    this._setLivePosition(selected, selected.source || 'garage-marker-selected');
    return { x: Math.round(selected.x), y: Math.round(selected.y), ts: Date.now(), source: selected.source };
  }

  // ─── MQTT live position ─────────────────────────────────────────────────

  _connectMqtt() {
    const did = this.getData().id;
    const tokens = this._api.getTokens();
    const { fallback } = this._api.getMqttConfig();
    const bindDomain = this.getStoreValue('bind_domain');
    const uid = this._api.getUid() || this._devUid || 'homey';
    const model = this._devModel || this.getSetting('device_model_id') || '';
    const region = this.getSetting('region') || 'eu';

    const host = bindDomain || fallback;
    const url = `mqtts://${host}`;
    const clientId = `p_${crypto.randomBytes(8).toString('hex')}`;

    this._mqttTopic = `/status/${did}/${uid}/${model}/${region}/`;
    this.log(`[mqtt] connecting to ${url} uid=${uid} topic=${this._mqttTopic}`);

    try {
      this._mqttClient = mqtt.connect(url, {
        clientId,
        username: String(uid),
        password: tokens.accessToken,
        rejectUnauthorized: false,
        reconnectPeriod: 30000,
        connectTimeout: 10000,
      });

      this._mqttClient.on('connect', () => {
        this.log(`[mqtt] connected — subscribing to ${this._mqttTopic}`);
        this._mqttClient.subscribe(this._mqttTopic, (err) => {
          if (err) this.error('[mqtt] subscribe error:', err.message);
          else this.log('[mqtt] subscribed successfully');
        });
      });

      this._mqttClient.on('message', async (topic, message) => {
        try {
          await this._handleMqttMessage(topic, message);
        } catch (e) {
          this.error('[mqtt] message error:', e.message);
        }
      });

      this._mqttClient.on('error', (err) => {
        this.error('[mqtt] error:', err.message);
      });

      this._mqttClient.on('close', () => {
        this.log('[mqtt] connection closed');
      });
    } catch (e) {
      this.error('[mqtt] connect failed:', e.message);
    }
  }

  _disconnectMqtt() {
    if (this._mqttClient) {
      this._mqttClient.end(true);
      this._mqttClient = null;
      this.log('[mqtt] disconnected');
    }
  }

  async _handleMqttMessage(topic, message) {
    let parsed;
    try {
      parsed = JSON.parse(message.toString());
    } catch {
      this.log(`[mqtt] non-JSON message: ${message.toString().substring(0, 200)}`);
      return;
    }

    if (parsed.data?.method === 'properties_changed' && Array.isArray(parsed.data.params)) {
      for (const prop of parsed.data.params) {
        if (prop.siid === 1 && prop.piid === 4) {
          const val = prop.value;
          const buf = Array.isArray(val) ? Buffer.from(val) : null;
          if (buf && buf.length >= 6 && buf[0] === 0xce) {
            const x     = (buf[3] << 28 | buf[2] << 20 | buf[1] << 12) >> 12;
            const y     = (buf[5] << 24 | buf[4] << 16 | buf[3] << 8)  >> 12;
            const angle = buf.length > 6 ? Math.round(buf[6] / 255 * 360) : 0;
            const newPos = { x: x * 10, y: y * 10 };
            const moved = !this._livePos || Math.abs(newPos.x - this._livePos.x) > 50 || Math.abs(newPos.y - this._livePos.y) > 50;
            this._setLivePosition(newPos, 'mqtt');
            if (moved) {
              this.log(`[mqtt] pos: (${newPos.x}, ${newPos.y}) angle=${angle}°`);
              if (this._garageSafety && typeof this._garageSafety.updatePositionGuards === 'function') {
                this._garageSafety.updatePositionGuards().catch((e) => this.error('[garage] mqtt position guard:', e.message));
              }
            }
          } else {
            this.log(`[mqtt] siid:1 piid:4 value: ${JSON.stringify(val)?.substring(0, 200)}`);
          }
        } else if (prop.siid === 2 && prop.piid === 1) {
          this.log(`[mqtt] status: ${prop.value}`);
        } else if (prop.siid === 2 && prop.piid === 2) {
          this.log(`[mqtt] error_code: ${prop.value}`);
          this._mqttErrorCode = prop.value;
        } else if (prop.siid === 2 && prop.piid === 57) {
          this.log(`[mqtt] power_state: ${prop.value}`);
          if (prop.value === 1) await this._applyStatus('standby', 0);
        }
      }
    } else if (parsed.data?.method === 'event_occured' && Array.isArray(parsed.data.params)) {
      for (const event of parsed.data.params) {
        if (event.siid === 4 && event.eiid === 1) {
          const stopReason = event.arguments?.find((a) => a.piid === 1)?.value ?? event.value ?? '?';
          this.log(`[mqtt] mission_completion: stop_reason=${stopReason}`);
        } else {
          this.log(`[mqtt] event siid:${event.siid} eiid:${event.eiid}`);
        }
      }
    } else if (parsed.data?.method === 'props' && parsed.data.params != null && typeof parsed.data.params === 'object') {
      const mqttProps = parsed.data.params;
      if ('ota_state' in mqttProps || 'ota_progress' in mqttProps) {
        this.log(`[mqtt] ota: state=${mqttProps.ota_state ?? '-'} progress=${mqttProps.ota_progress ?? '-'}%`);
      } else {
        this.log(`[mqtt] props: ${JSON.stringify(mqttProps).substring(0, 200)}`);
      }
    } else {
      this.log(`[mqtt] unhandled method=${parsed.data?.method}`);
    }
  }

  // ─── Map widget data ──────────────────────────────────────────────────────


  /** Normalize direct MAPI map objects. This keeps the original MAP.N parser intact,
   * but fixes firmwares/cloud regions where MAP chunks are absent while MAPI returns
   * the exact same map object used by the official app. */
  _normalizeBoundary(boundary, points = []) {
    const nums = (v) => Number.isFinite(Number(v));
    if (boundary && typeof boundary === 'object') {
      const x1 = boundary.x1 ?? boundary.minX ?? boundary.left ?? boundary[0]?.[0] ?? boundary[0];
      const y1 = boundary.y1 ?? boundary.minY ?? boundary.top ?? boundary[0]?.[1] ?? boundary[1];
      const x2 = boundary.x2 ?? boundary.maxX ?? boundary.right ?? boundary[1]?.[0] ?? boundary[2];
      const y2 = boundary.y2 ?? boundary.maxY ?? boundary.bottom ?? boundary[1]?.[1] ?? boundary[3];
      if ([x1, y1, x2, y2].every(nums)) return { x1: Number(x1), y1: Number(y1), x2: Number(x2), y2: Number(y2) };
    }
    const pts = [];
    const walk = (v) => {
      if (!v) return;
      if (Array.isArray(v)) {
        if (v.length >= 2 && nums(v[0]) && nums(v[1])) pts.push([Number(v[0]), Number(v[1])]);
        else v.forEach(walk);
      } else if (typeof v === 'object') {
        if (nums(v.x) && nums(v.y)) pts.push([Number(v.x), Number(v.y)]);
        else Object.values(v).forEach(walk);
      }
    };
    points.forEach(walk);
    if (!pts.length) return null;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const pad = 1000;
    return { x1: Math.min(...xs) - pad, y1: Math.min(...ys) - pad, x2: Math.max(...xs) + pad, y2: Math.max(...ys) + pad };
  }

  _asArrayMaybe(v) {
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.value)) return v.value;
    if (v && Array.isArray(v.points)) return v.points;
    if (v && Array.isArray(v.polygon)) return v.polygon;
    return [];
  }

  _unwrapDirectMapObject(mapi) {
    if (!mapi || typeof mapi !== 'object') return null;
    let candidate = mapi;
    if (candidate.d != null) candidate = candidate.d;
    if (candidate.data != null && typeof candidate.data === 'object') candidate = candidate.data;
    if (Array.isArray(candidate)) {
      candidate = candidate.find((e) => e && typeof e === 'object' && (e.boundary || e.mowingAreas || e.zones || e.areas)) || candidate[0];
    }
    if (typeof candidate === 'string') {
      try { candidate = JSON.parse(candidate); } catch (e) { return null; }
      if (Array.isArray(candidate)) {
        candidate = candidate.find((e) => e && typeof e === 'object' && (e.boundary || e.mowingAreas || e.zones || e.areas)) || candidate[0];
      }
    }
    return candidate && typeof candidate === 'object' ? candidate : null;
  }

  _parseDirectMapData(mapi) {
    const mapObj = this._unwrapDirectMapObject(mapi);
    if (!mapObj || typeof mapObj !== 'object') return null;
    const mowingAreas = this._asArrayMaybe(mapObj.mowingAreas || mapObj.areas || mapObj.zoneAreas || mapObj.zones || mapObj.workZones);
    const forbiddenAreas = this._asArrayMaybe(mapObj.forbiddenAreas || mapObj.noGoAreas || mapObj.no_mop || mapObj.virtualWalls);
    const spotAreas = this._asArrayMaybe(mapObj.spotAreas || mapObj.cleanSpots || mapObj.spots);
    const contours = this._asArrayMaybe(mapObj.contours || mapObj.outline || mapObj.boundaries);
    const obstacles = this._asArrayMaybe(mapObj.obstacles || mapObj.mapObstacles);
    const chargerPos = this._dockPos || (Array.isArray(mapObj.charger) && mapObj.charger.length >= 2 ? { x: Number(mapObj.charger[0]) * 10, y: Number(mapObj.charger[1]) * 10 } : null);
    const pointFromMap = (v) => {
      if (!v) return null;
      if (Array.isArray(v) && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) return { x: Number(v[0]), y: Number(v[1]) };
      if (typeof v === 'object' && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y))) return { x: Number(v.x), y: Number(v.y) };
      return null;
    };
    // RC108-compatible marker source: the original MOVA map exposes the visual
    // maintenance coordinate in the singular maintenance/service-point field.
    // This map coordinate is independent from opcode 109's command parameter.
    // The mower command therefore remains on confirmed native index 2, while the
    // marker is read exactly as it was in the last known-good map implementation.
    const maintenancePoint = pointFromMap(
      mapObj.maintenancePoint
      || mapObj.maintenance
      || mapObj.servicePoint
      || mapObj.repairPoint
      || mapObj.cleaningPoint,
    );
    const boundary = this._normalizeBoundary(mapObj.boundary, [mowingAreas, forbiddenAreas, spotAreas, contours, obstacles, chargerPos, maintenancePoint, this._livePos, this._cachedMapData?.livePath]);
    if (!boundary) return null;
    return {
      boundary,
      name:           mapObj.name || mapObj.mapName || `Map ${this._activeMapIndex + 1}`,
      md5sum:         mapObj.md5sum || mapObj.md5 || `mapi_${this._activeMapIndex}_${JSON.stringify(boundary)}`,
      mowingAreas,
      forbiddenAreas,
      spotAreas,
      contours,
      mapObstacles:   obstacles,
      chargerPos,
      maintenancePoint: maintenancePoint ? { ...maintenancePoint, source: 'native_map_original' } : null,
      mapRawKeys:     Object.keys(mapObj),
      mapTrSample:    mapObj.tr ? String(mapObj.tr).slice(0, 300) : null,
      livePath:       this._cachedMapData?.livePath || [],
    };
  }

  async _migrateMaintenancePointSchema() {
    const schemaVersion = 2;
    const markerKey = 'garage_maintenance_point_schema_version';
    const currentVersion = Number(await safeGetStoreValue(this, markerKey)) || 0;
    if (currentVersion >= schemaVersion) return;

    // Versions prior to schema v2 persisted untyped maintenance coordinates.
    // Those values were not reliably bound to a map and could therefore survive
    // app downgrades, map replacements and parser changes. Clear only these known
    // legacy cache keys once; normal user settings, flows and garage geometry are
    // deliberately untouched.
    const legacyKeys = [
      'garage_maintenance_point_verified_index2',
      'garage_maintenance_point_last_valid',
      'garage_maintenance_point',
      'maintenance_point',
      'garage_maintenance_point_candidate',
      'garage_maintenance_point_lock',
      'garage_maintenance_point_source_migrated_v1',
      'maintenance_point_source_migrated_v1',
    ];
    for (const key of legacyKeys) {
      try {
        if (typeof this.unsetStoreValue === 'function') await this.unsetStoreValue(key);
        else await this.setStoreValue(key, null);
      } catch (err) {
        this.error(`[maintenance] unable to clear legacy store key ${key}:`, err.message);
      }
    }
    this._maintenancePointCandidate = null;
    await this.setStoreValue(markerKey, schemaVersion);
    this.log(`[maintenance] schema migration v${schemaVersion} completed; legacy unbound point cache cleared`);
  }

  _maintenanceMapKey() {
    const map = this._cachedMapData || {};
    const identity = map.md5sum || map.mapId || map.id || map.uuid || map.name;
    return `${Number(this._activeMapIndex) || 0}:${String(identity || 'unknown')}`;
  }

  async _resolveStableMaintenancePoint() {
    const asPoint = (v, fallbackSource = 'stored') => {
      if (!v) return null;
      if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch (_) { return null; }
      }
      if (Array.isArray(v) && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) {
        return { x: Number(v[0]), y: Number(v[1]), source: fallbackSource };
      }
      if (typeof v === 'object' && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y))) {
        return {
          x: Number(v.x), y: Number(v.y),
          source: String(v.source || fallbackSource),
          savedAt: Number(v.savedAt) || undefined,
          mapKey: v.mapKey ? String(v.mapKey) : undefined,
          schemaVersion: Number(v.schemaVersion) || undefined,
          verifiedBy: v.verifiedBy || undefined,
        };
      }
      return null;
    };
    const distance = (a, b) => (a && b)
      ? Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y)) : Infinity;
    const mapKey = this._maintenanceMapKey();
    const schemaVersion = 2;
    const isCurrent = (p) => !!(p && p.schemaVersion === schemaVersion && p.mapKey === mapKey);
    const logOnce = (message, detail = '') => {
      const now = Date.now();
      if (now - Number(this._maintenancePointLogAt || 0) < 15000) return;
      this._maintenancePointLogAt = now;
      this.log(`[maintenance] ${message}${detail ? `: ${detail}` : ''}`);
    };

    // Native map data is always the primary source. A verified robot position is
    // only a fallback for firmware/map formats where no definite native marker is
    // exposed. This keeps the implementation generic and avoids user-specific
    // coordinates while still supporting devices with incomplete map metadata.
    const nativeMapPoint = asPoint(this._cachedMapData?.maintenancePoint, 'native-map');
    const storedNative = asPoint(await safeGetStoreValue(this, 'garage_maintenance_point_native_v2'), 'native-map');
    const verified = asPoint(await safeGetStoreValue(this, 'garage_maintenance_point_verified_v2'), 'verified');

    // A position physically reached through the mower's native maintenance command
    // is the strongest available evidence. It therefore overrides stale or
    // ambiguous map metadata for the same map. This is generic: no coordinates or
    // device IDs are hard-coded, and the point is captured only after a deliberate
    // maintenance trip from confirmed home with stable live telemetry.
    if (isCurrent(verified) && String(verified.verifiedBy || '').startsWith('manual_home_index2')) {
      logOnce('using physically verified native maintenance point', `map=${mapKey}`);
      return verified;
    }

    if (nativeMapPoint) {
      const candidate = {
        x: nativeMapPoint.x,
        y: nativeMapPoint.y,
        source: 'native-map',
        mapKey,
        schemaVersion,
      };
      const currentStoredNative = isCurrent(storedNative) ? storedNative : null;

      if (!currentStoredNative) {
        const stable = { ...candidate, savedAt: Date.now() };
        await this.setStoreValue('garage_maintenance_point_native_v2', stable).catch(() => {});
        this._maintenancePointCandidate = null;
        logOnce('native maintenance point acquired', `${Math.round(stable.x)},${Math.round(stable.y)} map=${mapKey}`);
        return stable;
      }

      if (distance(currentStoredNative, candidate) <= 100) {
        this._maintenancePointCandidate = null;
        return currentStoredNative;
      }

      const previous = this._maintenancePointCandidate;
      if (previous && previous.mapKey === mapKey && distance(previous, candidate) <= 80) {
        previous.hits = Number(previous.hits || 1) + 1;
        previous.lastSeenAt = Date.now();
      } else {
        this._maintenancePointCandidate = { ...candidate, hits: 1, firstSeenAt: Date.now(), lastSeenAt: Date.now() };
      }

      const motionLocked = !!this._garageSafety?._manualMaintenanceTransit
        || !!this._garageSafety?._safeReturnInProgress
        || !!this._garageSafety?._returnGuardActive;
      if (!motionLocked && Number(this._maintenancePointCandidate?.hits || 0) >= 4) {
        const stable = { ...candidate, savedAt: Date.now() };
        await this.setStoreValue('garage_maintenance_point_native_v2', stable).catch(() => {});
        this._maintenancePointCandidate = null;
        logOnce('native maintenance point adaptively updated', `${Math.round(stable.x)},${Math.round(stable.y)} map=${mapKey}`);
        return stable;
      }

      logOnce('native maintenance point change pending', `hits=${Number(this._maintenancePointCandidate?.hits || 0)} map=${mapKey}`);
      return currentStoredNative;
    }

    this._maintenancePointCandidate = null;
    if (isCurrent(storedNative)) return storedNative;
    if (isCurrent(verified)) {
      logOnce('using verified maintenance point fallback', `map=${mapKey}`);
      return verified;
    }

    // Legacy/unbound values are intentionally ignored. They may still exist after
    // a downgrade, but schema v2 never renders or uses them.
    return null;
  }

  async _storeVerifiedIndex2MaintenancePoint(position, source = 'native_index2_arrival') {
    if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) return null;
    const mapKey = this._maintenanceMapKey();
    const stable = {
      x: Number(position.x),
      y: Number(position.y),
      source: 'verified',
      verifiedBy: source,
      mapKey,
      schemaVersion: 2,
      savedAt: Date.now(),
    };
    this._maintenancePointCandidate = null;
    await this.setStoreValue('garage_maintenance_point_verified_v2', stable).catch(() => {});
    this.log(`[maintenance] verified maintenance point stored for map ${mapKey}`);
    return stable;
  }

  async _fallbackMapFromTelemetry() {
    const overlay = this._garageSafety && typeof this._garageSafety.getGarageOverlayData === 'function'
      ? await this._garageSafety.getGarageOverlayData().catch(() => null) : null;
    const safetyPos = this._garageSafety && typeof this._garageSafety.pos === 'function' ? this._garageSafety.pos() : null;

    // RC37: never return "No map data" while we have any usable garage marker
    // or live coordinate. The official map may still be unavailable from the cloud,
    // but the widget can render a small diagnostic/fallback canvas with robot,
    // safety point/line, danger center and maintenance point.
    const asPoint = (v) => {
      if (!v) return null;
      if (Array.isArray(v) && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) return { x: Number(v[0]), y: Number(v[1]) };
      if (typeof v === 'object' && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y))) return { x: Number(v.x), y: Number(v.y) };
      return null;
    };
    const storedLineA = asPoint(await safeGetStoreValue(this, 'garage_line_a'));
    const storedLineB = asPoint(await safeGetStoreValue(this, 'garage_line_b'));
    const storedDanger = asPoint(await safeGetStoreValue(this, 'garage_danger_center'));
    const storedMaint = await this._resolveStableMaintenancePoint();
    const effectiveOverlay = overlay || {};
    if (!effectiveOverlay.lineA && storedLineA) effectiveOverlay.lineA = storedLineA;
    if (!effectiveOverlay.lineB && storedLineB) effectiveOverlay.lineB = storedLineB;
    if (!effectiveOverlay.dangerCenter && storedDanger) effectiveOverlay.dangerCenter = storedDanger;
    if (!effectiveOverlay.maintenancePoint && storedMaint) effectiveOverlay.maintenancePoint = storedMaint;
    if (!effectiveOverlay.dangerRadius) effectiveOverlay.dangerRadius = Number(this.getSetting('garage_danger_radius_mm') || 0) || undefined;
    if (!effectiveOverlay.cautionRadius) effectiveOverlay.cautionRadius = Number(this.getSetting('garage_caution_radius_mm') || 0) || undefined;

    const robot = this._livePos || safetyPos || null;
    const points = [robot, this._dockPos, this._cachedMapData?.livePath,
      effectiveOverlay.dangerCenter, effectiveOverlay.lineA, effectiveOverlay.lineB, effectiveOverlay.maintenancePoint];
    let boundary = this._normalizeBoundary(null, points);
    if (!boundary) return null;
    // If only a single point exists, give the SVG a real size.
    if (Math.abs(boundary.x2 - boundary.x1) < 1000 || Math.abs(boundary.y2 - boundary.y1) < 1000) {
      const cx = (boundary.x1 + boundary.x2) / 2;
      const cy = (boundary.y1 + boundary.y2) / 2;
      boundary = { x1: cx - 3500, y1: cy - 3500, x2: cx + 3500, y2: cy + 3500 };
    }
    return {
      boundary,
      name: 'Garage/Live fallback',
      md5sum: `telemetry_${JSON.stringify(boundary)}_${robot ? `${Math.round(robot.x)},${Math.round(robot.y)}` : 'no_robot'}`,
      mowingAreas: [], forbiddenAreas: [], spotAreas: [], contours: [], mapObstacles: [],
      chargerPos: this._dockPos || null,
      mapRawKeys: ['telemetryFallback'],
      mapTrSample: null,
      livePath: this._cachedMapData?.livePath || [],
      robotPos: robot ? [robot.x, robot.y] : null,
      garageOverlay: Object.keys(effectiveOverlay).length ? effectiveOverlay : null,
      mapFallbackReason: 'no_official_map_payload',
    };
  }

  /**
   * Parse MAP.N + M_PATH.N raw chunks into structured polygon data for the map widget.
   * Returns null when no MAP data is present.
   *
   * MAP.N chunks form a JSON array of double-encoded strings:
   *   ["<map0-json-string>", "<map1-json-string>"]
   * Each inner string is a full map object with mowingAreas, forbiddenAreas, etc.
   *
   * M_PATH.N chunks form a flat JSON array of [x,y] coordinate pairs; [32767,-32768]
   * marks a pen-lift (start new sub-path); null entries are inert gaps.
   */
  _parseMapDataChunks(raw) {
    // ── MAP chunks → zone polygons ─────────────────────────────────────────
    const mapParts = [];
    for (let i = 0; raw[`MAP.${i}`] != null; i++) mapParts.push(raw[`MAP.${i}`]);
    if (!mapParts.length) return null;

    let mapObj = null;
    try {
      // Some firmware appends extra data after the closing ] of the outer array.
      // Walk the string character-by-character to find where the first top-level
      // JSON array actually ends, then truncate before passing to JSON.parse.
      let combined = mapParts.join('');
      {
        let depth = 0, inStr = false, esc = false;
        for (let ci = 0; ci < combined.length; ci++) {
          const ch = combined[ci];
          if (esc)               { esc = false; continue; }
          if (ch === '\\' && inStr) { esc = true; continue; }
          if (ch === '"')         { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '[' || ch === '{') depth++;
          if ((ch === ']' || ch === '}') && --depth === 0) { combined = combined.slice(0, ci + 1); break; }
        }
      }
      const outer = JSON.parse(combined);
      if (Array.isArray(outer)) {
        // Prefer the entry whose mapIndex matches the active map; fall back to first with boundary
        const candidates = outer.filter((e) => typeof e === 'string');
        for (const pass of [0, 1]) {
          for (const entry of candidates) {
            try {
              const m = JSON.parse(entry);
              if (!m.boundary) continue;
              if (pass === 0 && Number(m.mapIndex) !== Number(this._activeMapIndex)) continue;
              mapObj = m;
              break;
            } catch {}
          }
          if (mapObj) break;
        }
      }
    } catch (e) {
      this.error('[map] outer parse error:', e.message);
      return null;
    }
    if (!mapObj) return null;

    // Log all top-level keys and flag any position/path candidates
    this.log('[map] keys:', Object.keys(mapObj).join(', '));
    const posKeys = Object.keys(mapObj).filter(k => /pos|robot|cur|loc|coord|point|r_p|rp|rob|^tr$|^path|^track|trajec/i.test(k));
    if (posKeys.length) this.log('[map] position/path keys:', JSON.stringify(Object.fromEntries(posKeys.map(k => [k, typeof mapObj[k] === 'string' ? mapObj[k].slice(0, 120) : mapObj[k]]))));
    if (mapObj.tr) this.log('[map] tr sample:', String(mapObj.tr).slice(0, 200));
    if (mapObj.obstacles) this.log('[map] obstacles raw:', JSON.stringify(mapObj.obstacles).slice(0, 600));

    // ── ARMap binary → extract robot + charger position ───────────────────
    {
      const arRaw = mapObj.ARMap;
      const arType = typeof arRaw;
      const arLen  = arRaw ? String(arRaw).length : 0;
      this.log(`[armap] field: type=${arType} len=${arLen} truthy=${!!arRaw}`);
      if (arRaw) {
        const ar = this._parseARMap(arRaw);
        if (ar) {
          const dockStr = this._dockPos ? `dock=(${this._dockPos.x},${this._dockPos.y})` : 'dock=?';
          this.log(`[armap] robot=(${ar.robot.x},${ar.robot.y}) angle=${ar.robot.angle}`
            + ` charger=(${ar.charger.x},${ar.charger.y})`
            + ` grid=${ar.gridWidth}mm origin=(${ar.originX},${ar.originY})`
            + ` map=${ar.mapW}×${ar.mapH} ${dockStr}`);
          this._cachedArMapPos = ar;
        }
      }
    }

    // ── M_PATH chunks → live mowing path ──────────────────────────────────
    const pathParts = [];
    for (let i = 0; raw[`M_PATH.${i}`] != null; i++) pathParts.push(raw[`M_PATH.${i}`]);

    let livePath = [];
    if (pathParts.length) {
      // Use regex instead of JSON.parse: chunks split at byte boundaries mean the joined
      // string is not valid JSON. M_PATH.info is the number of leading chars to skip
      // (e.g. "2" skips the "[]" placeholder in M_PATH.0). Regex finds all complete
      // [x,y] pairs regardless of chunk boundaries — same approach as the HA integration.
      const pathStr = pathParts.join('');
      const skip = parseInt(raw['M_PATH.info'] || '0', 10) || 0;
      const searchStr = skip > 0 ? pathStr.slice(skip) : pathStr;
      const re = /\[(-?\d+),(-?\d+)\]/g;
      const rawPts = [];
      let m;
      while ((m = re.exec(searchStr)) !== null) {
        const px = parseInt(m[1], 10), py = parseInt(m[2], 10);
        rawPts.push(px === 32767 && py === -32768 ? [32767, -32768] : [px * 10, py * 10]);
      }
      // Insert pen-lifts at session boundaries: M_PATH contains multiple recorded sessions
      // concatenated without sentinels between them. A jump > 3 m signals a session break.
      const JUMP_SQ = 3000 * 3000;
      const allPts = [];
      let prevReal = null;
      for (const pt of rawPts) {
        if (pt[0] === 32767) {
          allPts.push(pt);
          prevReal = null;
        } else {
          if (prevReal !== null) {
            const dx = pt[0] - prevReal[0], dy = pt[1] - prevReal[1];
            if (dx * dx + dy * dy > JUMP_SQ) allPts.push([32767, -32768]);
          }
          allPts.push(pt);
          prevReal = pt;
        }
      }
      // Downsample real coordinate points to max 800 to keep widget payload manageable.
      // Always include the last real point so the robot marker is at the true last position.
      const realCount = allPts.filter((p) => p[0] !== 32767).length;
      const step = realCount > 800 ? Math.ceil(realCount / 800) : 1;
      let ri = 0;
      let lastRealIdx = -1;
      for (let i = allPts.length - 1; i >= 0; i--) {
        if (allPts[i][0] !== 32767) { lastRealIdx = i; break; }
      }
      for (let i = 0; i < allPts.length; i++) {
        const pt = allPts[i];
        if (pt[0] === 32767 && pt[1] === -32768) { livePath.push(pt); continue; }
        if (ri++ % step === 0 || i === lastRealIdx) livePath.push(pt);
      }
    }

    // Use the dock position reported directly by the device (fetched via t:"DOCK" action).
    // Falls back to null if not yet fetched; getMapData() will omit the robot marker when null.
    const chargerPos = this._dockPos ?? null;

    // paths.value is a planned mowing path (sparse waypoints), not the actual robot track.
    // Log its structure for reference but do not use it for position.

    // Parse obstacle list from the MAP JSON.
    // Format varies: value is either a flat array of {x,y,...} objects,
    // or a Map-style [[id, {x,y,...}], ...] array.
    // Coordinates are in map units (÷10 = mm, same as mowingArea boundary points).
    const mapObstacles = (() => {
      const raw = mapObj.obstacles?.value;
      if (!Array.isArray(raw) || raw.length === 0) return [];
      const first = raw[0];
      // Map-style: [[id, obj], ...]
      if (Array.isArray(first) && first.length === 2 && typeof first[1] === 'object') {
        return raw.map(([, obj]) => obj).filter(Boolean);
      }
      // Flat style: [{x,y,...}, ...]
      return raw.filter((o) => o && typeof o === 'object');
    })();

    return {
      boundary:       mapObj.boundary,
      name:           mapObj.name           || 'Map',
      md5sum:         mapObj.md5sum         || '',
      mowingAreas:    mapObj.mowingAreas?.value    || [],
      forbiddenAreas: mapObj.forbiddenAreas?.value || [],
      spotAreas:      mapObj.spotAreas?.value      || [],
      contours:       mapObj.contours?.value       || [],
      mapObstacles,
      chargerPos,
      mapRawKeys:     Object.keys(mapObj),
      mapTrSample:    mapObj.tr ? String(mapObj.tr).slice(0, 300) : null,
      livePath,
    };
  }

  async updateGarageOverlayMarkers(payload = {}) {
    const asEditablePoint = (value, name) => {
      if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) {
        throw new Error(`Invalid ${name} marker coordinates`);
      }
      return { x: Math.round(Number(value.x)), y: Math.round(Number(value.y)), ts: Date.now(), source: 'map_editor' };
    };

    const lineA = asEditablePoint(payload.lineA, 'A');
    const lineB = asEditablePoint(payload.lineB, 'B');
    const dangerCenter = asEditablePoint(payload.dangerCenter, 'danger');
    const maintenancePoint = payload.maintenancePoint
      ? asEditablePoint(payload.maintenancePoint, 'maintenance')
      : null;
    const lineLength = Math.hypot(lineA.x - lineB.x, lineA.y - lineB.y);
    if (!Number.isFinite(lineLength) || lineLength < 250) {
      throw new Error('Safety line points A and B must be at least 250 mm apart');
    }

    // Persist all three points as one user-confirmed edit. The safety engine,
    // map renderer and marker diagnosis consume these exact store keys.
    await this.setStoreValue('garage_line_a', lineA);
    await this.setStoreValue('garage_line_b', lineB);
    await this.setStoreValue('garage_danger_center', dangerCenter);
    if (maintenancePoint) {
      if (typeof this._storeVerifiedIndex2MaintenancePoint === 'function') {
        await this._storeVerifiedIndex2MaintenancePoint(maintenancePoint, 'map_editor');
      } else {
        await this.setStoreValue('garage_maintenance_point', maintenancePoint);
      }
    }

    if (this._garageSafety?.markers?.resetRuntime) this._garageSafety.markers.resetRuntime();
    if (typeof this._garageSafety?.refreshOverlay === 'function') await this._garageSafety.refreshOverlay().catch(() => {});
    if (typeof this._garageSafety?.updateMarkerDiagnosis === 'function') await this._garageSafety.updateMarkerDiagnosis().catch(() => {});
    if (typeof this._garageSafety?.updatePositionGuards === 'function') await this._garageSafety.updatePositionGuards().catch(() => {});

    this.log('[map-editor] garage markers saved', { lineA, lineB, dangerCenter, maintenancePoint });
    return { ok: true, lineA, lineB, dangerCenter, maintenancePoint };
  }

  async getMapData() {
    // RC32: keep the original cached map path, but actively refresh the cache when
    // the widget is opened before the next poll. This prevents Homey from showing
    // "No map data yet" while MAP.N/MAPI data exists in the cloud.
    if (!this._cachedMapData && this._cachedMAPI) this._cachedMapData = this._parseDirectMapData(this._cachedMAPI);
    if (!this._cachedMapData && this._api) {
      const did = this.getData().id;
      const raw = await this._api.getRawProperties(did).catch((e) => { this.log('[map] widget raw refresh failed:', e.message); return null; });
      const rawData = raw?.data;
      if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
        this._lastRawData = rawData;
        const parsed = this._parseMapDataChunks(rawData);
        if (parsed) {
          this._cachedMapData = parsed;
          this.log(`[map] widget refreshed from MAP chunks: ${parsed.name}, ${parsed.mowingAreas.length} zones`);
        }
      }
      if (!this._cachedMapData) {
        const tryIdx = [];
        if (Number.isFinite(Number(this._activeMapIndex))) tryIdx.push(Number(this._activeMapIndex));
        const mapl = await this._api.getMapList(did).catch((e) => { this.log('[map] widget MAPL refresh failed:', e.message); return null; });
        const entries = Array.isArray(mapl?.d) ? mapl.d : (Array.isArray(mapl) ? mapl : []);
        for (const e of entries) {
          if (Array.isArray(e) && Number.isFinite(Number(e[0]))) tryIdx.push(Number(e[0]));
          else if (e && typeof e === 'object' && Number.isFinite(Number(e.index ?? e.idx ?? e.mapIndex))) tryIdx.push(Number(e.index ?? e.idx ?? e.mapIndex));
        }
        for (let i = 0; i <= 5; i++) tryIdx.push(i);
        const uniqueIdx = [...new Set(tryIdx.filter((v) => Number.isFinite(v)))];
        for (const idx of uniqueIdx) {
          const mapi = await this._api.getMAPI(did, idx).catch((e) => { this.log(`[map] widget MAPI idx=${idx} failed:`, e.message); return null; });
          if (!mapi) continue;
          this._cachedMAPI = mapi;
          const direct = this._parseDirectMapData(mapi);
          if (direct) {
            this._activeMapIndex = idx;
            this._cachedMapData = direct;
            this.log(`[map] widget refreshed from MAPI idx=${idx}: ${direct.name}, ${direct.mowingAreas.length} zones`);
            break;
          }
        }
      }
    }
    let garageOverlay = null;
    const garageMode = !!this.getSetting('garage_mode_enabled');
    const showGarageOverlay = garageMode && !!this.getSetting('garage_map_overlay_enabled');
    const showMaintenancePoint = this.getSetting('map_show_maintenance_point') !== false;
    if ((showGarageOverlay || showMaintenancePoint) && this._garageSafety && typeof this._garageSafety.getGarageOverlayData === 'function') {
      const rawOverlay = await this._garageSafety.getGarageOverlayData().catch(() => null);
      // RC50: never make stored marker rendering depend on a non-null runtime
      // overlay. After restart or while the safety engine is still initialising,
      // getGarageOverlayData() can temporarily return null although the persisted
      // A/B/danger/maintenance coordinates are valid. Start with an empty object
      // and always merge the store, which is the durable source of truth.
      garageOverlay = rawOverlay && typeof rawOverlay === 'object' ? { ...rawOverlay } : {};
      const asMapPoint = (v) => {
        if (!v) return null;
        if (typeof v === 'string') {
          try { v = JSON.parse(v); } catch (_) {
            const m = v.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;| ]\s*(-?\d+(?:\.\d+)?)\s*$/);
            if (m) return { x: Number(m[1]), y: Number(m[2]) };
            return null;
          }
        }
        if (Array.isArray(v) && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) return { x: Number(v[0]), y: Number(v[1]) };
        if (typeof v === 'object' && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y))) return { x: Number(v.x), y: Number(v.y), ...(v.source ? { source: v.source } : {}) };
        return null;
      };
      const primaryLineA = asMapPoint(await safeGetStoreValue(this, 'garage_line_a'));
      const primaryLineB = asMapPoint(await safeGetStoreValue(this, 'garage_line_b'));
      const legacyLineA = asMapPoint(await safeGetStoreValue(this, 'garage_safety_line_a'));
      const legacyLineB = asMapPoint(await safeGetStoreValue(this, 'garage_safety_line_b'));
      const primaryDanger = asMapPoint(await safeGetStoreValue(this, 'garage_danger_center'));
      // RC91: the maintenance/service point supplied by the native map is the
      // authoritative visual position. Older marker-capture builds could persist
      // a transient robot/dock coordinate under garage_maintenance_point.
      const storedMaint = asMapPoint(await this._resolveStableMaintenancePoint());
      // RC93: older marker-capture builds could write the maintenance point into
      // A/B or danger. Merely reading separate keys is therefore insufficient.
      // Reject coordinates that are effectively identical to the verified native
      // maintenance point. Prefer an independent legacy endpoint where available;
      // otherwise suppress the invalid line instead of drawing a false one.
      const pointDistance = (a, b) => (a && b)
        ? Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y)) : Infinity;
      const coupledToMaintenance = (p) => !!(p && storedMaint && pointDistance(p, storedMaint) < 350);
      // RC95: B remains the explicitly stored endpoint. A must not visually
      // collapse onto the native maintenance point. Prefer an independent legacy
      // A when available. For installations whose old primary A was corrupted to
      // the maintenance coordinate, reconstruct only the DISPLAY endpoint from
      // the garage-to-B geometry. This does not modify the persisted marker or any
      // safety/state-machine calculation.
      const storedLineB = primaryLineB || legacyLineB || null;
      let storedLineA = primaryLineA || legacyLineA || null;
      let lineAVisualRecovery = false;
      if (storedLineA && coupledToMaintenance(storedLineA)) {
        if (legacyLineA && !coupledToMaintenance(legacyLineA)) {
          storedLineA = legacyLineA;
        } else if (storedLineB) {
          const garageReference = asMapPoint(this._cachedMapData?.chargerPos)
            || asMapPoint(this._dockPos)
            || primaryDanger;
          if (garageReference) {
            const gx = Number(storedLineB.x) - Number(garageReference.x);
            const gy = Number(storedLineB.y) - Number(garageReference.y);
            const glen = Math.hypot(gx, gy);
            if (Number.isFinite(glen) && glen > 1) {
              const requestedLength = pointDistance(storedLineB, primaryLineA);
              const segmentLength = Math.max(350, Math.min(1600,
                Number.isFinite(requestedLength) ? requestedLength : 700));
              const candidates = [
                { x: Number(storedLineB.x) + (-gy / glen) * segmentLength, y: Number(storedLineB.y) + (gx / glen) * segmentLength },
                { x: Number(storedLineB.x) - (-gy / glen) * segmentLength, y: Number(storedLineB.y) - (gx / glen) * segmentLength },
              ];
              storedLineA = candidates.sort((a, b) => pointDistance(a, storedMaint) - pointDistance(b, storedMaint))[0];
              lineAVisualRecovery = true;
            }
          }
        }
      }
      const storedLineLength = storedLineA && storedLineB
        ? pointDistance(storedLineA, storedLineB) : 0;
      const storedLineValid = Number.isFinite(storedLineLength) && storedLineLength >= 25;

      if (storedLineValid) {
        garageOverlay.lineA = storedLineA;
        garageOverlay.lineB = storedLineB;
      } else {
        delete garageOverlay.lineA;
        delete garageOverlay.lineB;
      }

      // The danger circle belongs at the garage/gate. If the persisted point is
      // the same corrupted maintenance coordinate, use only the native dock from
      // the original map as a visual recovery. Safety calculations remain untouched.
      const nativeDock = asMapPoint(this._cachedMapData?.chargerPos) || asMapPoint(this._dockPos);
      const displayDanger = primaryDanger && !coupledToMaintenance(primaryDanger)
        ? primaryDanger
        : (nativeDock || null);
      if (displayDanger) garageOverlay.dangerCenter = displayDanger;
      else delete garageOverlay.dangerCenter;

      // The native map service/maintenance point remains the authoritative
      // visual source and is deliberately independent from A, B and danger.
      if (storedMaint) garageOverlay.maintenancePoint = storedMaint;
      else delete garageOverlay.maintenancePoint;

      if (this.getSetting('garage_debug_logging')) {
        const now = Date.now();
        if (!this._lastRc92OverlayDebugAt || now - this._lastRc92OverlayDebugAt > 30000) {
          this._lastRc92OverlayDebugAt = now;
          this.log('[map-overlay RC95] decoupled line A renderer', JSON.stringify({
            lineA: garageOverlay.lineA || null,
            lineB: garageOverlay.lineB || null,
            danger: garageOverlay.dangerCenter || null,
            rawLineA: primaryLineA || null,
            rawLineB: primaryLineB || null,
            rawDanger: primaryDanger || null,
            lineAVisualRecovery,
            maintenance: garageOverlay.maintenancePoint || null,
            dock: this._cachedMapData?.chargerPos || this._dockPos || null,
            robot: this._livePos || null,
          }));
        }
      }
      if (showGarageOverlay) {
        if (!Number.isFinite(Number(garageOverlay.dangerRadius))) garageOverlay.dangerRadius = Number(this.getSetting('garage_danger_radius_mm') || 1200);
        if (!Number.isFinite(Number(garageOverlay.cautionRadius))) garageOverlay.cautionRadius = Number(this.getSetting('garage_caution_radius_mm') || 0) || undefined;
      }
      // Maintenance point is independent from garage mode and from the garage overlay master switch.
      if (!showMaintenancePoint) delete garageOverlay.maintenancePoint;
      // Every other garage-specific element is controlled by one master switch and is impossible with garage mode off.
      if (!showGarageOverlay) {
        delete garageOverlay.lineA;
        delete garageOverlay.lineB;
        delete garageOverlay.dangerCenter;
        delete garageOverlay.dangerRadius;
        delete garageOverlay.cautionRadius;
        delete garageOverlay.garagePoint;
        delete garageOverlay.exitPoint;
        delete garageOverlay.markers;
      }
      if (!Object.keys(garageOverlay).length) garageOverlay = null;
    }
    const overlayVisibility = {
      showRobot: this.getSetting('map_show_robot_position') !== false,
      showDirection: this.getSetting('map_show_direction') !== false,
      showRoute: this.getSetting('map_show_route') !== false,
      showMaintenancePoint,
      showGarageOverlay,
      garageMode,
    };
    if (!this._cachedMapData) {
      const fallback = await this._fallbackMapFromTelemetry();
      if (fallback) {
        // Keep the exact same overlay visibility contract as the normal map path.
        // Without this, the widget treated fallback payloads as garage mode OFF and
        // silently hid Safety-Line A/B although the persisted markers were present.
        fallback.overlayVisibility = overlayVisibility;
        let fo = fallback.garageOverlay && typeof fallback.garageOverlay === 'object'
          ? { ...fallback.garageOverlay } : {};
        if (!showMaintenancePoint) delete fo.maintenancePoint;
        if (!showGarageOverlay) {
          delete fo.lineA; delete fo.lineB; delete fo.dangerCenter;
          delete fo.dangerRadius; delete fo.cautionRadius;
          delete fo.garagePoint; delete fo.exitPoint; delete fo.markers;
        }
        fallback.garageOverlay = Object.keys(fo).length ? fo : null;
        return fallback;
      }
      const now = Date.now();
      if (!this._lastMapNoDataLogAt || now - this._lastMapNoDataLogAt > 60000) {
        this._lastMapNoDataLogAt = now;
        this.log('[map] no map data available for widget',
          'MAP-cache=', !!this._lastRawMap,
          'MAPI-cache=', !!this._cachedMAPI,
          'livePos=', !!this._livePos,
          'dock=', this._dockPos ? 'yes' : 'no');
      }
      return null;
    }
    const cachedLivePath = Array.isArray(this._cachedMapData.livePath) ? this._cachedMapData.livePath : [];
    const telemetryTrail = Array.isArray(this._liveRouteTrail) ? this._liveRouteTrail : [];
    let effectiveLivePath = cachedLivePath;
    if (telemetryTrail.length) {
      const merged = cachedLivePath.slice();
      let lastCached = null;
      for (let i = merged.length - 1; i >= 0; i--) {
        if (merged[i][0] !== 32767) { lastCached = merged[i]; break; }
      }
      const firstTelemetry = telemetryTrail.find((pt) => pt[0] !== 32767);
      if (lastCached && firstTelemetry
        && Math.hypot(firstTelemetry[0] - lastCached[0], firstTelemetry[1] - lastCached[1]) > 3000) {
        merged.push([32767, -32768]);
      }
      merged.push(...telemetryTrail);
      effectiveLivePath = merged.slice(-1000);
    }
    const base = {
      ...this._cachedMapData,
      livePath: effectiveLivePath,
      mapRotation: this._dockYaw ?? 0,
      robotAngle: this._cachedArMapPos?.robot?.angle ?? null,
      obstacles: this._cachedObstacles,
      garageOverlay,
      overlayVisibility,
      // Explicit aliases keep older Homey widget caches compatible and make the
      // two required overlays available even when a client cached an older schema.
      safetyLineA: garageOverlay?.lineA || null,
      safetyLineB: garageOverlay?.lineB || null,
      maintenancePoint: garageOverlay?.maintenancePoint || null,
      dangerCenter: garageOverlay?.dangerCenter || null,
    };
    const status = this._nativeMowerStatus || this.getCapabilityValue('mower_status');
    const ACTIVE = ['mowing', 'edge_mowing', 'leaving', 'returning', 'paused', 'remote_control'];
    const CONFIRMED_DOCK = ['docked', 'charging', 'charging_completed'];

    // RC86: a confirmed native dock/charge state is authoritative for display.
    // Do not let a stale buffered outdoor point keep the robot beside the garage
    // while the mower is physically docked and charging.
    if (CONFIRMED_DOCK.includes(status) && this._cachedMapData.chargerPos) {
      const { x, y } = this._cachedMapData.chargerPos;
      return { ...base, robotPos: [x, y] };
    }

    // For every non-docked state, prefer the accepted native position stream and
    // never snap paused/idle/standby to the charger.
    const buffered = typeof this._getBufferedLivePosition === 'function'
      ? this._getBufferedLivePosition(15000) : this._livePos;
    if (buffered && Number.isFinite(Number(buffered.x)) && Number.isFinite(Number(buffered.y))) {
      return { ...base, robotPos: [Number(buffered.x), Number(buffered.y)] };
    }

    // Fallback for active or ambiguous outdoor states: use the current-session
    // M_PATH tail instead of snapping to the charger.
    if (ACTIVE.includes(status) || ['idle', 'standby'].includes(status)) {
      const tail = this._lastMPathPos();
      if (tail) return { ...base, robotPos: tail };
      return base;
    }

    return base;
  }

  /** Return the last real [x, y] from the cached livePath (M_PATH), in map mm. */
  _lastMPathPos() {
    const path = this._cachedMapData?.livePath;
    if (!path) return null;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i][0] !== 32767) return path[i];
    }
    return null;
  }

  // ─── Debug API (called by settings/index.html via api.js) ─────────────────

  async getDebugPollData() {
    if (!this._api) throw new Error('Device not initialised yet — please wait and try again');

    const did = this.getData().id;

    const [rawResponse, deviceStatus, cfgResult, mihisResult] = await Promise.allSettled([
      this._api.getRawProperties(did),
      this._api.getDeviceStatus(did),
      this._api.getCFG(did),
      this._api.getMowingHistory(did),
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

    // Include decoded map snapshot (omit livePath coords to keep payload small)
    const cachedMap = this._cachedMapData ? {
      name:            this._cachedMapData.name,
      md5sum:          this._cachedMapData.md5sum,
      mowingAreas:     this._cachedMapData.mowingAreas,
      forbiddenAreas:  this._cachedMapData.forbiddenAreas,
      spotAreas:       this._cachedMapData.spotAreas,
      contours:        this._cachedMapData.contours,
      boundary:        this._cachedMapData.boundary,
      chargerPos:      this._cachedMapData.chargerPos,
      mapRawKeys:      this._cachedMapData.mapRawKeys,
      mapTrSample:     this._cachedMapData.mapTrSample,
      lastMPathPos:    this._lastMPathPos(),
      livePathLength:  this._cachedMapData.livePath?.length ?? 0,
      livePathHead:    this._cachedMapData.livePath?.slice(0, 5),
      livePathTail:    this._cachedMapData.livePath?.slice(-5),
    } : null;

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
      mihisData:        mihisResult.status === 'fulfilled' ? mihisResult.value : { error: mihisResult.reason?.message },
      cachedMapData:    cachedMap,
      cachedObstacles:  this._cachedObstacles,
      cachedMAPI:       this._cachedMAPI,
      capabilityValues,
      storeValues,
      deviceSettings,
    };
  }

  // ─── Activity history (history widget) ──────────────────────────────────────

  async getActivitySessions(limit = 30) {
    if (!this._devUid) return [];
    const did = this.getData().id;
    const res = await this._api.getActivityHistory(did, this._devUid, { limit }).catch(() => null);
    const records = res?.data?.list ?? [];
    if (records.length > 0) {
      let firstProps = [];
      try { firstProps = JSON.parse(records[0].history); } catch { /* */ }
      this.log('[history] available piids in first record:', JSON.stringify(firstProps.map((p) => ({ piid: p.piid, value: p.value }))));
    }
    return records.map((r) => {
      let props = [];
      try { props = JSON.parse(r.history); } catch { /* */ }
      const get = (piid) => props.find((p) => p.piid === piid)?.value ?? null;
      return {
        id:         r.id,
        startTs:    get(8),
        filename:   get(9),
        area:       get(60),
        duration:   get(14),
        mapName:    get(16),
        mode:       get(4),
        status:     get(7),
        zoneCount:  get(15),
        coverage:   get(1),
      };
    }).filter((s) => s.filename);
  }

  async getSessionPhotos(filename) {
    if (!this._devUid) return { photos: [], trajectory: [], dock: null };
    const did = this.getData().id;
    const urlRes = await this._api.getActivityFileUrl(did, this._devUid, this._devModel, filename).catch(() => null);
    const ossUrl = urlRes?.data ?? null;
    if (!ossUrl) return { photos: [], trajectory: [], dock: null };
    const actJson = await this._api.fetchActivityJson(ossUrl).catch(() => null);
    const photos        = actJson?.ai_obstacle    ?? [];
    const trajectory    = actJson?.trajectory     ?? [];
    const dock          = actJson?.dock           ?? null;
    const areas         = actJson?.areas          ?? null;
    const faults        = actJson?.faults         ?? [];
    const humanDetected = actJson?.human_detected ?? null;
    const trap          = actJson?.trap           ?? [];
    const mode          = actJson?.mode           ?? null;
    this.log('[history] ai_obstacle:', photos.length, 'trajectory segments:', trajectory.length,
      'faults:', JSON.stringify(faults).substring(0, 200),
      'human_detected:', JSON.stringify(humanDetected),
      'trap:', JSON.stringify(trap).substring(0, 200),
      'mode:', mode);
    if (areas != null) this.log('[history] areas:', JSON.stringify(areas).substring(0, 600));
    return { photos, trajectory, dock, areas, faults, humanDetected, trap, mode };
  }

  async getObstaclePhotoBase64(photoId) {
    const did = this.getData().id;
    const filename = /\.\w{2,4}$/.test(photoId) ? photoId : photoId + '.jpg';
    const buf = await this._api.getAIObsFile(did, filename).catch(() => null);
    if (!buf || buf.length < 200) return null;
    const mime = buf[0] === 0xFF && buf[1] === 0xD8 ? 'image/jpeg'
               : buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png'
               : 'application/octet-stream';
    return { data: buf.toString('base64'), mime, size: buf.length };
  }
}

module.exports = MowerDevice;
