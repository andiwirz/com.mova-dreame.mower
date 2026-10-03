'use strict';

const zlib   = require('zlib');
const crypto = require('crypto');
const mqtt   = require('mqtt');
const Homey = require('homey');
const util = require('node:util');
const MovaApi = require('../../lib/MovaApi');
const GarageSafetyEngine = require('../../lib/garage/GarageSafetyEngine');
const { resolveMaintenancePointIndex } = require('../../lib/garage/MaintenancePointResolver');
const { DurableRoute } = require('../../lib/map/DurableRoute');
const DreameStandaloneVideo = require('../../lib/video/DreameStandaloneVideo');
const { isSessionTransientStatus, isRouteSessionActive, isChargeBreakContinuation, compactRouteTrail } = require('../../lib/map/RouteSessionPolicy');
const { renderMapPng } = require('../../lib/widgets/MapPngRenderer');

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
  21,22,23,24,25,26,27,28,29,30,37,46,73,
]);
const WARNING_DEVICE_CODES = new Set([31,32,33,34,35,36,38,39,40,41,42,43,44,45]);

const HOME_STATUSES = new Set(['idle', 'standby', 'docked', 'charging']);
const ACTIVE_WORK_STATUSES = new Set(['mowing', 'mapping', 'returning', 'remote_control']);

// Native map edits on the A2 are acknowledged immediately, while the cloud
// MAP.* snapshot may remain stale until the vendor map screen performs another
// full read.  Pending therefore means exactly that: keep showing the real map
// geometry and keep verifying read-only until native geometry confirms the edit.
// 480 s is only the end of the dense initial verification schedule; it is NOT a
// timeout that releases the operation.  Afterwards a low-frequency recheck runs
// until confirmation (or an explicit new app lifecycle resets the timers).
const PYLON_PENDING_TIMEOUT_MS = 480_000;
const PYLON_PENDING_RECHECK_MS = 120_000;
// A geometry-verified g2408 MAPD frame is current mower truth. If repeated
// direct readback still does not contain the requested geometry after this
// window, the native edit did not commit and the UI must be unlocked.
const PYLON_DIRECT_MISS_RELEASE_MS = 15_000;
const PYLON_LIFECYCLE_MODES = new Set([
  'permanent', 'days_3', 'days_7', 'days_14',
  'departure', 'departure_mowing', 'mowing', 'mowing_return', 'return',
]);
const PYLON_TIMED_LIFECYCLE_DAYS = Object.freeze({ days_3: 3, days_7: 7, days_14: 14 });

// Capabilities that are only visible when garage mode is enabled
const GARAGE_DISPLAY_CAPS = [
  'cmd_garage_pause_mode',
  'cmd_garage_test_exit',
  'cmd_garage_save_danger_center',
  'cmd_garage_save_safety_line_a',
  'cmd_garage_save_safety_line_b',
  'garage_door_status',
  'garage_safety_status',
  'garage_sensor_available_status',
  'garage_sensor_battery',
];

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
    // v1.2.19: original enum surface. Superseded in 1.2.20 by a native boolean
    // toggle because the Homey device UI could keep the enum picker visually
    // stale even though setCapabilityValue() had already updated its backend value.
    key: 'capabilities_migrated_v32_turning_method',
    caps: ['turning_method'],
  },
  {
    // v1.2.20: one authoritative realtime Homey surface for Dreame's
    // steeringMode (false=Effizient, true=Rasenpflege).
    key: 'capabilities_migrated_v33_lawn_care_mode',
    caps: ['lawn_care_mode'],
  },
  {
    // v1.2.21: restore the native picker surface requested for the device view.
    // It remains the only Homey steeringMode surface; Advanced Settings stays removed.
    key: 'capabilities_migrated_v34_turning_picker',
    caps: ['turning_method'],
  },
  {
    key: 'capabilities_migrated_garage_v120',
    caps: ['cmd_garage_pause_mode','cmd_garage_test_exit','garage_door_status','garage_safety_status','garage_sensor_available_status','garage_sensor_battery'],
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
  // v1.2.21: boolean toggle replaced by the realtime enum picker again.
  'lawn_care_mode',
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
  // v1.1.31: marker buttons moved out of driver.compose.json; now managed by
  // _applyGarageCapabilityVisibility (present only when garage mode is enabled).
  'cmd_garage_save_danger_center', 'cmd_garage_save_safety_line_a', 'cmd_garage_save_safety_line_b',
];

class MowerDevice extends Homey.Device {
  _formatDeviceLog(args) {
    return args.map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.stack || value.message || String(value);
      return util.inspect(value, { depth: 4, breakLength: 180, maxArrayLength: 40 });
    }).join(' ');
  }

  log(...args) {
    super.log(...args);
    try {
      const name = this.getName?.() || this.getData?.()?.id || 'mower';
      this.homey?.app?._pushLog?.('info', `[${name}] ${this._formatDeviceLog(args)}`);
    } catch (_) {}
  }

  error(...args) {
    super.error(...args);
    try {
      const name = this.getName?.() || this.getData?.()?.id || 'mower';
      this.homey?.app?._pushLog?.('error', `[${name}] ${this._formatDeviceLog(args)}`);
    } catch (_) {}
  }


  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async onInit() {
    // Initialise all instance fields first so getDebugPollData() and capability
    // listeners never see `undefined` even if _migrate() or _initApi() throws.
    this._api                  = null;
    this._standaloneVideo      = null;
    this._pollTimer            = null;
    this._garageFastPollTimer = null;
    this._garageFastPollBusy = false;
    // Initialise from persisted state so the session timer survives app restarts.
    // If the mower was already mowing before the restart, _wasMowing stays true and
    // _sessionStartTime is restored from the store (falls back to now if not stored yet).
    const restoredMowerStatus = this.getCapabilityValue('mower_status');
    const storedSessionStart = await this.getStoreValue('session_start_time');
    this._chargeBreakResumeUntil = Number(await this.getStoreValue('charge_break_resume_until') || 0);
    const restoredChargeBreak = isChargeBreakContinuation(this._chargeBreakResumeUntil);
    this._wasMowing        = restoredMowerStatus === 'mowing';
    // During a persisted automatic charging break the logical mowing job is kept
    // by session_start_time + charge_break_resume_until, but _wasMowingSession
    // stays false while physically home. This prevents the first post-restart
    // charging poll from being mistaken for another completion event.
    this._wasMowingSession = !restoredChargeBreak && (isSessionTransientStatus(restoredMowerStatus)
      || (Number.isFinite(Number(storedSessionStart)) && Number(storedSessionStart) > 0));
    this._returnSnapshot   = null; // battery/settings captured at returning, for charge-break detection on dock
    this._sessionStartTime = (Number.isFinite(Number(storedSessionStart)) && Number(storedSessionStart) > 0)
      ? Number(storedSessionStart)
      : (this._wasMowingSession ? Date.now() : null);
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
    this._maplPollCounter      = 1;     // reads MAPL on poll 1, 11, 21, … (staggered vs others)
    this._locnPollCounter      = 2;     // reads LOCN when docked on poll 2, 12, 22, … (staggered vs others)
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
    // v5: garage/safety position authority. Fresh MQTT position packets are
    // authoritative; HTTP/native polling sources become fallback-only until
    // MQTT has been silent long enough to be considered stale.
    this._mqttPositionFreshMs  = 8000;
    this._lastMqttPositionAt   = 0;
    this._positionAuthorityMode = null;
    // v1.2.1: native maintenance coordinates are accepted adaptively, but only
    // after stable repetition. This prevents a transient map payload from moving
    // the marker while still allowing a genuine map change to be learned.
    this._maintenancePointCandidate = null;
    this._maintenancePointLogAt = 0;
    this._nativeMaintenanceCommandAt = 0;
    this._pendingNativeMaintenanceArrival = null;
    this._nativeMaintenanceArrivalLatched = false;
    this._nativeMaintenanceStableArrival = null;
    this._positionSourcePriority = { mqtt: 50, 'siid:1:4': 45, 'garage-marker-direct': 45, locn: 30, mitrc: 20, unknown: 0 };
    this._cachedPRE              = await this.getStoreValue('cached_pre') ?? null;  // last known PRE array; used for cutting_height read-modify-write
    this._cuttingHeightWriteTs   = 0;    // timestamp of last successful cutting_height write; guards poll snap-back
    this._preWriteCuttingHeight  = null; // capability value before last write; used to detect snap-back vs external change
    this._turningWriteBusy       = false; // suppress native PRE mirror while Homey is doing the verified dual write
    this._cachedMapData          = null; // last parsed map data for the map widget
    this._durableRoute = new DurableRoute(await this.getStoreValue('durable_mowing_route'));
    if (this._durableRoute.entry(this._activeMapIndex)?.active && !restoredChargeBreak) this._wasMowingSession = true;
    this._routeSaveChain = Promise.resolve();
    this._routeSaveAt = 0;
    this._completedMapRoute      = await this.getStoreValue('completed_map_route') ?? null; // last completed mowing route; protects the widget from stale/short M_PATH after completion
    this._cachedObstacles        = await safeGetStoreValue(this, 'obstacle_payload_cache_v1') || null; // last non-empty Dreame obstacle data
    this._obstacleDiagSignature  = '';   // change guard for AIOBS/OBS diagnostics
    this._obstacleDiagUpdatedAt  = 0;
    this._obsFetchInFlight       = false; // prevent overlapping slow AIOBS/OBS refreshes
    this._obstacleRulesCache     = await safeGetStoreValue(this, 'obstacle_rules_v1') || {};
    // 1.2.37: Homey-local names for native forbidden zones, including zones
    // created in the original Dreame/MOVA app. These labels are never written
    // to the mower. Identity includes map + native id + quantized geometry so a
    // recycled Dreame id at a different position cannot inherit an old name.
    this._nativeZoneLabelsCache  = await safeGetStoreValue(this, 'native_zone_labels_v1') || {};
    // Lifecycle metadata for native zones that were created outside Homey
    // (for example in the original MOVA/Dreame app). The identity is geometry-
    // based so a firmware-recycled native id cannot inherit another zone's rule.
    // Homey may temporarily remove/recreate these zones only after the user has
    // explicitly assigned a non-permanent lifecycle in the map editor.
    this._nativeZonePoliciesCache = await safeGetStoreValue(this, 'native_zone_policies_v1') || {};
    // Durable readback watches for direct native deletes. A label is removed only
    // after a later complete/fresh native-map read proves that the exact labelled
    // geometry is gone. Keeping this separate from the short UI pending state also
    // survives app restarts and stale/temporarily incomplete cloud snapshots.
    this._nativeZoneLabelDeleteWatches = await safeGetStoreValue(this, 'native_zone_label_delete_watches_v1') || {};
    // Direct red-zone deletes use the same durable geometry watch as local-name
    // cleanup. Rebuild the short-lived UI/readback state after MAPL has selected
    // the active map, so a Homey restart cannot silently drop an unconfirmed
    // native delete.
    this._directNativeDeleteUi   = new Map();
    this._cachedMAPI             = null; // last MAPI response (raw, for format discovery)
    this._lastMapStr             = '';   // last MAP.N concatenated string — change-guard for _extractMapInfo/_parseMapDataChunks
    this._lastMapNoDataLogAt     = 0;    // garage map diagnostic throttle
    this._cachedArMapPos         = null; // last parsed ARMap robot/charger position from binary blob
    this._mqttErrorCode          = null; // latest native MQTT device/error code
    this._lastFaultAnnouncementKey = ''; // de-duplicate localized mower error/warning timeline notifications
    this._lastFaultAnnouncementAt = 0;   // keep same fault suppressed across transient paused/error telemetry
    this._garageSafety          = new GarageSafetyEngine(this);
    this._commandGeneration      = 0;
    this._resumeGuardUntil       = 0; // suppress garage external-start detection after Pause→Resume
    this._resumeSemanticUntil    = 0; // RC112: treat stale cloud 'paused' as mowing after an explicit resume
    this._dockCommandIntentUntil = 0; // suppress pause/resume for 3 min after dock command
    this._pauseButtonHoldUntil   = 0;
    this._mapCameraImage         = null;
    this._mapCameraUpdateTimer   = null;
    this._mapCameraLastUpdateAt  = 0;
    this._pollInFlight           = null;
    this._pylonLifecycleSyncPromise = null;
    this._pylonLifecycleSyncTimer = null;
    this._mapPublishPromise      = null; // serialize vendor map-screen wake sequences with post-edit readback
    this._nativeMapReadbackBusy = false; // keep slow-poll MAPI from disturbing an active MAPI→MAPD cursor
    this._lastVendorMapScreenSnapshot = null; // one-shot full keys:[] response captured by the exact vendor map-screen sequence

    await this._migrate();
    await this._applyGarageCapabilityVisibility();
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

    // Homey persists momentary command capabilities. Clear stale button values
    // before listeners are registered, especially cmd_maintenance_point after a
    // hot/test-channel reinstall.
    for (const cap of [
      'cmd_start_mowing', 'cmd_start_spot_mowing', 'cmd_pause', 'cmd_stop',
      'cmd_dock', 'cmd_maintenance_point', 'cmd_resume', 'cmd_refresh',
      'cmd_garage_pause_mode', 'cmd_garage_test_exit',
    ]) {
      if (this.hasCapability(cap)) await this.setCapabilityValue(cap, false).catch(() => {});
    }

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
        const pausedOutside = garageEnabled && this._canResumePausedOutside();
        const activeOutside = garageEnabled && outsideEvidence && ['mowing', 'leaving', 'remote_control', 'mapping'].includes(nativeStatus);

        // RC103: the Start button is contextual in garage mode. A paused mower
        // on the lawn must resume without opening the gate or creating a new
        // Ausfahrt/Justieren/Positionieren cycle. Only a securely docked/charging
        // mower may enter the full garage start sequence.
        if (returnActive && !garage.isVerifiedMaintenanceStart?.()) {
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
            if (await this._resumeMowingRobust('cmd_start_as_resume') === false) return;
            // 1.2.13: do not fabricate native mowing. The robust resume helper
            // updates command/button intent immediately and fresh telemetry owns
            // the physical mower status.
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

        if (!['all', 'edge_all'].includes(zone) && !zone.startsWith('zone_') && !zone.startsWith('edge_')) {
          this.log('[cmd_start_mowing] no zone selected — start blocked before garage action');
          return;
        }

        // Outside/maintenance starts are classified centrally by GarageSafetyEngine.
        // Do not pre-block here: the engine refreshes stale stationary positions,
        // can re-confirm the maintenance point with native opcode 109, and allows
        // all/zone/edge starts from a proven lawn-side position without touching
        // the garage door.

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
            if (['mowing','paused','returning','mapping'].includes(stBefore) && this._garageSafety
                && !this._garageSafety.isVerifiedMaintenanceStart?.()
                && this._garageSafety.lastRequestedAction !== 'button_start_spot') {
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
      const returnIntentActive = (this._dockCommandIntentUntil && Date.now() < this._dockCommandIntentUntil)
        || !!this._garageSafety?.isReturnCycleActive?.();
      if (returnIntentActive) {
        this.log('[cmd_pause] ignored: return command active');
        await this.setCapabilityValue('cmd_pause', false).catch(() => {});
        return;
      }
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
        this._lastUserPauseAt = Date.now();
        await this._updateCommandButtonUi('paused').catch(() => {});
      }
      this._runBackgroundCommand('cmd_pause', async () => {
        // Re-check inside the asynchronous task: Return may have been pressed
        // after this Pause/Resume listener started but before its cloud write ran.
        if ((this._dockCommandIntentUntil && Date.now() < this._dockCommandIntentUntil)
            || this._garageSafety?.isReturnCycleActive?.()) {
          this.log('[cmd_pause] queued command cancelled: return command active');
          return;
        }
        if (resumeRequested) {
          this.log('[cmd] btn: resume → sendAction(5,4)');
          if (await this._resumeMowingRobust('cmd_resume') === false) return;
          // 1.2.13: command intent and native telemetry stay separate. A
          // successful write is not itself proof that the mower is physically
          // mowing again.
          this.homey.setTimeout(async () => {
            await this._poll().catch(() => {});
            if ((this._dockCommandIntentUntil && Date.now() < this._dockCommandIntentUntil)
                || this._garageSafety?.isReturnCycleActive?.()) {
              this.log('[cmd] resume retry cancelled: return command active');
              return;
            }
            if (this._isPausedLike()) {
              this.log('[cmd] resume still paused after delay → retry once');
              await this._resumeMowingRobust('cmd_resume_retry');
              this.homey.setTimeout(() => this._poll().catch(() => {}), 2500);
            }
          }, 2500);
        } else {
          this.log('[cmd] btn: pause → sendAction(5,4)');
          await this._safeWrite('cmd_pause', () => this._api.pause(did));
          await this._applyStatus('paused', 0, false);
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
      // Latch the user's return intent immediately. A delayed Pause/Resume task
      // from a rapid previous tap must never run after Return and switch the mower
      // back to mowing. The garage return state takes over from this point.
      this._dockCommandIntentUntil = Date.now() + 180000;
      this._resumeSemanticUntil = 0;
      this._resumeGuardUntil = 0;
      this._pauseButtonHoldUntil = 0;
      try {
        this.log('[cmd] btn: dock → dock()');
        this._runBackgroundCommand('cmd_dock', async () => {
          await this._garageSafety.returnRequested('button_dock', async () => {
            const accepted = await this._safeWrite('cmd_dock', () => this._api.dock(did));
            if (accepted === false) return false;
            await this._applyStatus('returning', 0, false);
            return true;
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
            await this._garageSafety.maintenanceRequested('button_maintenance', async () => this._goToMaintenancePointGuarded('button_maintenance'));
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
        await this._setCapabilityOptionsIfChanged('cmd_garage_pause_mode', {
          title: {
            en: this._garageSafety.paused ? 'Resume garage mode' : 'Pause garage mode',
            de: this._garageSafety.paused ? 'Garagenmodus fortsetzen' : 'Garagenmodus pausieren',
          },
          icon: this._garageSafety.paused ? '/assets/capabilities/cmd_resume.svg' : '/assets/capabilities/cmd_pause.svg',
        });
        await this._garageSafety.refreshTileStatus(this._garageSafety.paused ? 'garage paused' : 'garage resumed').catch(() => {});
        if (!this._garageSafety.paused) {
          this.homey.setTimeout(() => this._refreshPositionBeforeGarageCommand('cmd_dock').catch(() => {}), 50);
        }
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

    if (this.hasCapability('turning_method')) {
      this.registerCapabilityListener('turning_method', async (value) => {
        const targetMode = value === 'lawn_care' ? 1 : 0;
        try {
          await this._writeTurningMethod(targetMode, 'capability');
        } catch (err) {
          this.error('[turning_method] listener error:', err.message);
          // Restore the last confirmed native state if the dual write failed.
          const native = Number(this._lastNativeSteeringMode);
          if ([0, 1].includes(native) && this.hasCapability('turning_method')) {
            await this.setCapabilityValue('turning_method', native === 1 ? 'lawn_care' : 'efficient').catch(() => {});
          }
          throw err;
        }
      });
    }

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

    // Remove old Homey-only Pending projections whose source pylon no longer
    // exists before resuming legitimate current verification. This specifically
    // cleans test-build "ghost squares" without touching any native MAP.* zone.
    await this._purgeStaleOrphanPylonRules('startup').catch((e) =>
      this.log('[pylon-native] stale orphan cleanup failed:', e.message));

    // Resume persisted native verification after an app restart. Pending stays
    // pending until geometry confirms; restarting Homey must not turn an accepted
    // edit into an apparently retryable/finished one.
    this._resumePendingPylonVerification();
    this._resumeDirectNativeDeleteVerification();

    // Skip the redundant getCFG / MIHIS / DOCK on the very first poll since we fetch them at init.
    this._cfgPollCounter   = 1;
    this._mihisPollCounter = 1;
    this._dockPollCounter  = 1;


    // MQTT live-feed state. _mqttGeneration rises on every client teardown so
    // callbacks from a replaced client can identify themselves as superseded.
    this._mqttClient      = null;
    this._mqttGeneration  = 0;
    this._mqttFailCount   = 0;
    this._mqttStopped     = false;
    this._mqttAuthFailed  = false;
    this._mqttAuthRetried = false;
    this._mqttToken       = null;

    // Native A2 dock-state telemetry. Besides diagnostics this is now used as a
    // narrow-garage safety signal: IN_STATION + undocking is the earliest precise
    // indication we observed for a real station departure, without extra polling.
    this._mowerBinaryDiag = null;
    this._mowerBinaryDiagAt = 0;

    this._startPolling();
    this._connectMqtt();

    // Best-effort native media landing order: Homey currently exposes no SDK
    // method to select the default media source. Field tests show that registering
    // the passive Mähkarte first gives it priority on a fresh device-media view.
    // Homey may still remember the user's last manual selection. Live Video stays
    // lazy and starts only when its URL listener is requested.
    await this._initMapCameraImage();
    this._standaloneVideo = new DreameStandaloneVideo(this);
    await this._standaloneVideo.init();
  }

  async onDeleted() {
    this._stopPolling();
    this._disconnectMqtt();
    if (this._mapCameraUpdateTimer) { clearTimeout(this._mapCameraUpdateTimer); this._mapCameraUpdateTimer = null; }
    if (this._pylonLifecycleSyncTimer) { clearTimeout(this._pylonLifecycleSyncTimer); this._pylonLifecycleSyncTimer = null; }
    try { await this._mapCameraImage?.unregister?.(); } catch (_) {}
    try { await this._standaloneVideo?.stop?.(); } catch (_) {}
  }

  async _initMapCameraImage() {
    if (!this.homey?.images?.createImage || typeof this.setCameraImage !== 'function') {
      this.log('[map-media] Homey image API unavailable; native Mähkarte media source skipped');
      return;
    }
    try {
      const image = await this.homey.images.createImage();
      image.setStream(async (stream) => {
        let png = null;
        try { png = renderMapPng(await this.getMapData()); } catch (err) {
          this.log('[map-media] PNG render failed:', err.message);
        }
        if (!png) {
          // A valid tiny PNG fallback is preferable to SVG here: Homey's native
          // device media renderer does not reliably display SVG camera images on iOS.
          png = renderMapPng({ boundary:{x1:0,y1:0,x2:1000,y2:700}, mowingAreas:[], livePath:[] });
        }
        stream.filename = 'maehkarte.png';
        stream.contentType = 'image/png';
        stream.contentLength = png.length;
        stream.end(png);
      });
      await this.setCameraImage('mower_map', 'Mähkarte', image);
      this._mapCameraImage = image;
      this.log('[map-media] native Mähkarte media source registered');
    } catch (err) {
      this.error('[map-media] registration failed:', err.message);
    }
  }

  _scheduleMapCameraImageUpdate() {
    if (!this._mapCameraImage || this._mapCameraUpdateTimer) return;
    const now = Date.now();
    const delay = Math.max(0, 8000 - (now - Number(this._mapCameraLastUpdateAt || 0)));
    this._mapCameraUpdateTimer = setTimeout(async () => {
      this._mapCameraUpdateTimer = null;
      this._mapCameraLastUpdateAt = Date.now();
      try { await this._mapCameraImage?.update?.(); }
      catch (err) { this.log('[map-media] image refresh failed:', err?.message || String(err)); }
    }, delay);
    this._mapCameraUpdateTimer.unref?.();
  }

  /**
   * Read the mower's live PRE[19] steering value directly and mirror it to the
   * Homey picker.  SETTINGS.* from getRawProperties can lag an original-app
   * change; PRE is the device-applied value and is therefore the authoritative
   * fallback for Dreame/MOVA -> Homey synchronization.
   *
   * This method is read-only and capability-only.  It never calls
   * _writeTurningMethod(), so an original-app change cannot echo back to the
   * mower.
   */
  async _syncTurningMethodFromNativePRE(did) {
    if (this._turningWriteBusy || !this._api || !this.hasCapability('turning_method')) return;
    const mapIndex = Number.isInteger(Number(this._activeMapIndex)) && Number(this._activeMapIndex) >= 0
      ? Number(this._activeMapIndex) : 0;
    let pre = null;
    try {
      pre = await this._api.getPRE(did, mapIndex, 0);
    } catch (err) {
      this.log('[settings] native PRE steering poll failed:', err.message);
      return;
    }
    if (!Array.isArray(pre) || pre.length <= 19 || ![0, 1].includes(Number(pre[19]))) return;
    const nativeMode = Number(pre[19]);
    const turningMethod = nativeMode === 1 ? 'lawn_care' : 'efficient';
    const previousMode = Number(this._lastNativeSteeringMode);
    const changed = previousMode !== nativeMode;
    await this._setCap('turning_method', turningMethod);
    this._lastNativeSteeringMode = nativeMode;
    if (changed) {
      await this.setStoreValue('native_steering_mode_v1', nativeMode).catch(() => {});
      this.log(`[settings] native PRE[19] synchronized to Homey: map=${mapIndex} mode=${nativeMode} turning_method=${turningMethod}`);
    }
  }

  async _writeTurningMethod(targetMode, source = 'homey') {
    this._turningWriteBusy = true;
    try {
    targetMode = Number(targetMode) === 1 ? 1 : 0;
    const lawnCare = targetMode === 1;
    const did = this.getData().id;
    const mapIndex = Number.isInteger(Number(this._activeMapIndex)) && Number(this._activeMapIndex) >= 0
      ? Number(this._activeMapIndex) : 0;
    this.log(`[settings] Wendemethode steeringMode/PRE[19] → map=${mapIndex} mode=${targetMode} source=${source}`);

    let pre;
    try { pre = await this._api.getPRE(did, mapIndex, 0); }
    catch (err) { throw new Error(`Wendemethode konnte nicht gelesen werden: ${err.message}`); }
    if (!Array.isArray(pre) || pre.length <= 19) {
      throw new Error('Diese Mäher-Firmware liefert PRE[19] für die Wendemethode nicht. Einstellung wurde nicht geändert.');
    }
    const next = [...pre];
    next[0] = 0; next[1] = mapIndex; next[2] = 0; next[19] = targetMode;

    const preWriteOk = await this._safeWrite('turning_pre19', async () => {
      const result = await this._api.writePRE(did, next);
      const out = result?.result?.out?.[0];
      if (out?.status === false || Number(out?.error || 0) !== 0 || Number(out?.r || 0) !== 0) {
        throw new Error(`PRE[19] abgelehnt${out?.r ? ` (r=${out.r})` : out?.error ? ` (${out.error})` : ''}`);
      }
    });
    if (!preWriteOk) throw new Error('Wendemethode konnte am Mäher nicht eingestellt werden.');

    const settingsWriteOk = await this._safeWrite('turning_settings', () =>
      this._api.writeSETTINGSField(did, mapIndex, 'steeringMode', targetMode));
    if (!settingsWriteOk) {
      throw new Error('Wendemethode wurde am Mäher gesetzt, aber die Original-App-Synchronisation konnte nicht geschrieben werden.');
    }
    this._cachedPRE = next;
    await this.setStoreValue('cached_pre', next).catch(() => {});

    let preActual = null, settingsActual = null, confirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, [700, 1400, 2600][attempt - 1]));
      try {
        const checkPre = await this._api.getPRE(did, mapIndex, 0);
        if (Array.isArray(checkPre) && checkPre.length > 19) preActual = Number(checkPre[19]);
      } catch (err) { this.log(`[settings] steering PRE readback attempt=${attempt + 1} failed: ${err.message}`); }
      try {
        const blob = await this._api.getSETTINGSBlob(did);
        const entry = Array.isArray(blob) ? blob[mapIndex] : null;
        const general = entry?.settings?.['0'] ?? entry?.settings ?? entry;
        if (general?.steeringMode != null) settingsActual = Number(general.steeringMode);
      } catch (err) { this.log(`[settings] steering SETTINGS readback attempt=${attempt + 1} failed: ${err.message}`); }
      this.log(`[settings] steering readback attempt=${attempt + 1} PRE19=${preActual} SETTINGS=${settingsActual} target=${targetMode}`);
      if (preActual === targetMode && settingsActual === targetMode) { confirmed = true; break; }
    }
    if (!confirmed) throw new Error(`Wendemethode nicht vollständig bestätigt (PRE[19]=${preActual ?? '—'}, SETTINGS.steeringMode=${settingsActual ?? '—'}).`);

    this._lastNativeSteeringMode = targetMode;
    await this.setStoreValue('native_steering_mode_v1', targetMode).catch(() => {});
    // One authoritative Homey surface only: the live enum picker.
    // Do not mirror this into Advanced Settings; setSettings() while onSettings
    // is pending is rejected by Homey and created the stale two-surface state.
    if (typeof this.hasCapability === 'function' && this.hasCapability('turning_method')) {
      await this._setCap('turning_method', lawnCare ? 'lawn_care' : 'efficient');
    }
    return true;
    } finally {
      this._turningWriteBusy = false;
    }
  }

  async onSettings({ changedKeys, newSettings }) {
    this.log('[settings] changed:', changedKeys.join(', '));
    const did = this.getData().id;

    if (changedKeys.includes('map_safe_mowing') && !newSettings.map_safe_mowing
        && Object.values(this._obstacleRulesCache || {}).some((r) => r?.nativeId != null || r?.pending)) {
      throw new Error('Bitte zuerst alle Homey-Sperrzonen im Karteneditor löschen.');
    }
    // This switch only gates explicit edits in Homey. Do not run garage hooks
    // or cloud reads while Homey is waiting for the settings-save response.
    if (changedKeys.length === 1 && changedKeys[0] === 'map_safe_mowing') {
      this.log('[settings] Sicher mähen', newSettings.map_safe_mowing ? 'enabled' : 'disabled');
      return;
    }

    if (changedKeys.includes('garage_mission_push_notifications')
        && newSettings.garage_mission_push_notifications
        && !newSettings.garage_mode_enabled) {
      throw new Error('Mäher-Hinweise können nur bei aktiviertem Garagenmodus aktiviert werden.');
    }
    if (changedKeys.includes('garage_mode_enabled') && !newSettings.garage_mode_enabled
        && newSettings.garage_mission_push_notifications) {
      newSettings.garage_mission_push_notifications = false;
      await this.setSettings({ garage_mission_push_notifications: false }).catch(() => {});
    }

    if (changedKeys.includes('video_enabled') && !newSettings.video_enabled) {
      try { await this._standaloneVideo?.stop?.(); } catch (e) { this.error('[video] disable:', e.message); }
    }

    if (changedKeys.some((key) => ['garage_mode_enabled', 'garage_sensor_enabled', 'garage_reset_markers'].includes(key))
        && this._garageSafety && typeof this._garageSafety.onSettings === 'function') {
      await this._garageSafety.onSettings(newSettings, changedKeys).catch((e) => this.error('[garage] settings hook:', e.message));
    }

    if (changedKeys.includes('garage_mode_enabled')) {
      await this._applyGarageCapabilityVisibility();
      if (newSettings.garage_mode_enabled) {
        this._startGarageFastPoll();
      } else if (this._garageFastPollTimer) {
        this.homey.clearInterval(this._garageFastPollTimer);
        this._garageFastPollTimer = null;
      }
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

    // Native LOW is the mower's confirmed "Low Speed at Night" schedule.
    // It is intentionally not exposed as a permanent slow-motion override because
    // the protocol does not provide a general live wheel-speed control.
    const LOW_KEYS = ['low_enabled', 'low_start', 'low_end'];
    if (LOW_KEYS.some((k) => changedKeys.includes(k))) {
      const lowEnabled = !!newSettings.low_enabled;
      const startMin = Number(newSettings.low_start) * 60;
      const endMin = Number(newSettings.low_end) * 60;
      this.log(`[settings] LOW → enabled=${lowEnabled} startMin=${startMin} endMin=${endMin}`);
      await this._safeWrite('low', () => this._api.setLowSpeedNight(did, {
        enabled: lowEnabled, startMin, endMin,
      }));
    }

    // Do Not Disturb — ordinary native mower setting. Garage mode does not
    // manipulate DND; field testing on A2 showed DND does not block a manual start.
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

  async _applyGarageCapabilityVisibility() {
    const enabled = !!this.getSetting('garage_mode_enabled');
    for (const cap of GARAGE_DISPLAY_CAPS) {
      if (enabled && !this.hasCapability(cap)) {
        await this.addCapability(cap).catch((e) => this.error(`[garage] addCapability ${cap}:`, e.message));
      } else if (!enabled && this.hasCapability(cap)) {
        await this.removeCapability(cap).catch((e) => this.error(`[garage] removeCapability ${cap}:`, e.message));
      }
    }
  }

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
    // Only start the 5 s safety poll when garage mode is actually enabled — avoid 720 wakeups/hour for non-garage users.
    if (this.getSetting('garage_mode_enabled')) {
      this._startGarageFastPoll();
    }
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

  _startGarageFastPoll() {
    if (this._garageFastPollTimer) return;
    this._garageFastPollTimer = this.homey.setInterval(async () => {
      if (this._garageFastPollBusy) return;
      const st = this.getCapabilityValue('mower_status');
      const outside = !!(this._garageSafety && (this._garageSafety._missionOutside || this._garageSafety._outbound));
      if (!outside && !['mowing','mapping','paused','returning','error','remote_control'].includes(st)) return;
      this._garageFastPollBusy = true;
      try { await this._poll(); } catch (e) { this.log('[garage-fast-poll]', e.message); }
      finally { this._garageFastPollBusy = false; }
    }, 5000);
  }

  /**
   * Single poll cycle: fires getRawProperties (for SETTINGS.0) and
   * getDeviceStatus (device-list) in parallel, then maps results to capabilities.
   */
  async _poll() {
    if (this._pollInFlight) return this._pollInFlight;
    const run = this._pollCore();
    this._pollInFlight = run;
    try {
      return await run;
    } finally {
      if (this._pollInFlight === run) this._pollInFlight = null;
    }
  }

  async _pollCore() {
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
      this._latestNativeStatusCode = Number(info.latestStatus);
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
      await this._observeNativeMaintenanceArrival(this._latestNativeStatusCode, mowerStatus, effectiveFaultCode).catch((e) => this.error('[maintenance] native arrival observer:', e.message));

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
        // getRawProperties/SETTINGS may be a stale cloud snapshot after a
        // change made in the original Dreame/MOVA app.  Read live PRE[19]
        // once per normal poll so the Homey Wendemodus follows the mower
        // without requiring an app restart or a Homey-originated write.
        await this._syncTurningMethodFromNativePRE(did).catch((e) =>
          this.log('[settings] native PRE steering sync skipped:', e.message));
        await this._applyOTAInfo(rawData);
        await this._detectAndSyncZones(rawData);
      }
    } else {
      this.error('[poll] rawProperties failed:', rawResult.reason?.message);
    }

    // ── Live position — every poll ────────────────────────────────────────────
    // Authority: fresh MQTT → siid:1:4 → LOCN → MITRC fallback
    const posStatus = this._nativeMowerStatus || this.getCapabilityValue('mower_status');
    const ACTIVE_STATUSES = ['mowing', 'edge_mowing', 'leaving', 'returning', 'paused', 'remote_control', 'idle', 'standby', 'garage'];
    // Keep the last known live position. Do not clear _livePos at the start of
    // each poll: the original map widget expects buffered data while LOCN/MITRC
    // briefly drop out, otherwise Homey shows "No map data yet" although a map
    // exists. Fallbacks below overwrite it only when a fresh fix is available.

    // v5 position arbitration: a fresh MQTT live coordinate is authoritative
    // for garage/safety. Do not keep polling competing position sources while
    // MQTT is healthy; they may be delayed by several seconds and previously
    // caused alternating safety-line / danger-area evaluations. When MQTT has
    // been silent for >8s, siid:1:4 -> LOCN -> MITRC become fallbacks again.
    let freshPositionThisPoll = false;
    const mqttPositionAuthoritative = this._isMqttPositionFresh();
    this._notePositionAuthority(mqttPositionAuthoritative ? 'mqtt_live' : 'fallback',
      mqttPositionAuthoritative ? 'fresh MQTT position; HTTP position polling suppressed' : 'MQTT stale/missing; fallback positions enabled');

    if (!mqttPositionAuthoritative && ACTIVE_STATUSES.includes(posStatus)) {
      const mowerPos = await this._api.getMowerPosition(did).catch(() => null);
      if (mowerPos && Number.isFinite(Number(mowerPos.x)) && Number.isFinite(Number(mowerPos.y))) {
        this.log(`[pos1:4] x=${mowerPos.x} y=${mowerPos.y} angle=${mowerPos.angle} status=${posStatus}`);
        freshPositionThisPoll = this._setLivePosition({ x: mowerPos.x, y: mowerPos.y }, 'siid:1:4') || freshPositionThisPoll;
      }
    }

    // LOCN remains useful as a fallback and as dock GPS anchor. While outside
    // the dock and MQTT is fresh, do not fetch it at all. At the dock we retain
    // the low-frequency anchor refresh because it serves map conversion rather
    // than live garage safety.
    const AT_DOCK_STATUSES = ['docked', 'charging', 'idle', 'standby'];
    const isAtDock = AT_DOCK_STATUSES.includes(posStatus);
    const fetchLocn = isAtDock ? (this._locnPollCounter % 10 === 0) : !mqttPositionAuthoritative;
    const locn = fetchLocn ? await this._api.getLOCN(did).catch(() => null) : null;
    const locnPos = locn?.pos && Array.isArray(locn.pos) && locn.pos.length >= 2 ? locn.pos : null;
    if (locnPos) {
      const [lon, lat] = locnPos;
      if (isAtDock) {
        const anchorChanged = !this._dockGPS || this._dockGPS.lon !== lon || this._dockGPS.lat !== lat;
        this._dockGPS = { lon, lat };
        if (anchorChanged) this.log(`[locn] GPS anchor: lon=${lon} lat=${lat}`);
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
    if (isAtDock) this._locnPollCounter++;

    if (!mqttPositionAuthoritative && !freshPositionThisPoll && ACTIVE_STATUSES.includes(posStatus)) {
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

    // ── MAPL — active map detection, every 10th poll ──────────────────────────
    if (this._maplPollCounter % 10 === 0 && Date.now() > this._mapSwitchCooldown) {
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
    this._maplPollCounter++;

    // ── MAPI / AIOBS / OBS — every 10th poll (staggered) ─────────────────────
    if (this._obsPollCounter % 10 === 0 && !this._pylonNativeWriteBusy && !this._nativeMapReadbackBusy) {
      // Fetch MAPI first to get the hash, then only fetch AIOBS/OBS if the map changed.
      const mapiRaw = await this._api.getMAPI(did, this._activeMapIndex).catch((e) => {
        this.log('[mapi] failed:', e.message);
        return null;
      });

      if (mapiRaw) {
        const incomingHash = mapiRaw?.d?.hash ?? null;
        const incomingMeta = mapiRaw?.d ?? mapiRaw;
        if (incomingMeta && typeof incomingMeta === 'object') this._lastVendorMapMeta = incomingMeta;
        const cachedHash   = this._cachedMapData?.md5sum ?? null;
        const mapChanged   = !incomingHash || incomingHash !== cachedHash;

        const directMap = this._parseDirectMapData(mapiRaw);
        // A MAPI partial response can carry updated native forbidden areas even
        // when it lacks mowing zones and is correctly rejected for map rendering.
        // Inspect it separately without replacing the complete cached map.
        if (directMap) this._logNativeForbiddenReadOnly(directMap, 'MAPI');
        if (directMap && (!this._cachedMapData || directMap.md5sum !== this._cachedMapData.md5sum)) {
          // RC-x: never downgrade a zone-complete map to a zone-less one. A zone-less
          // MAPI response (wrong _activeMapIndex, transient cloud state) would cause
          // the widget to zoom in on the robot position instead of the full garden.
          const incomingHasZones = directMap.mowingAreas && directMap.mowingAreas.length > 0;
          const cacheHasZones    = this._cachedMapData?.mowingAreas?.length > 0;
          if (incomingHasZones || !cacheHasZones) {
            this._cachedMapData = directMap;
            this.log(`[map] cached from MAPI: ${directMap.name}, ${directMap.mowingAreas.length} zones`);
          } else {
            this.log(`[map] skipped MAPI update: incoming has no zones, cache has ${this._cachedMapData.mowingAreas.length} zones`);
          }
        }
        this._cachedMAPI = directMap ? null : mapiRaw;

        // Pylon/obstacle telemetry can change without the map hash changing.
        // Fetch it independently through the shared guarded helper.
        await this._refreshObstacleTelemetry(did, 'slow-poll');
      } else {
        // OBS is independent from MAPI. A transient/empty MAPI response must not
        // make the five original-app warning markers disappear from Homey.
        await this._refreshObstacleTelemetry(did, 'slow-poll-no-mapi');
      }
    } else if (this._obsPollCounter % 10 === 0 && (this._pylonNativeWriteBusy || this._nativeMapReadbackBusy)) {
      this.log('[map-edit] background MAPI/OBS refresh skipped while native edit/readback is active');
    }
    this._obsPollCounter++;

    // Time/mission-controlled pylon rules are changed only while the mower is
    // stationary. Normal/fast polling merely schedules the serialized lifecycle
    // synchronizer; it never races a native map edit.
    const lifecyclePhase = this._currentPylonLifecyclePhase();
    if (this._mapEditStationary() && this._pylonLifecycleNeedsTransition(lifecyclePhase)) {
      this._schedulePylonLifecycleSync(lifecyclePhase, 'poll');
    }

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
    this._setCapabilityOptionsIfChanged('cutting_height', { min, max }).catch((e) =>
      this.error('[cutting_height] setCapabilityOptions:', e.message),
    );
  }


  // Homey reinitialises the device (and recreates all flow cards) on every
  // setCapabilityOptions() call. Guard every call-site so we only write when
  // the options actually differ from what was last written.
  async _setCapabilityOptionsIfChanged(cap, opts) {
    if (!this.hasCapability(cap)) return;
    const key = JSON.stringify(opts);
    if (!this._capabilityOptionsCache) this._capabilityOptionsCache = new Map();
    if (this._capabilityOptionsCache.get(cap) === key) return;
    // RC-x: the in-memory cache is empty after every app (re)start, so without
    // this seed the very first call per capability always wrote — recreating all
    // flow cards on app start even when nothing changed. Compare against the
    // options Homey already has persisted and skip the write when identical.
    if (!this._capabilityOptionsCache.has(cap)) {
      try {
        const current = this.getCapabilityOptions(cap) || {};
        const same = Object.keys(opts).every(
          (k) => JSON.stringify(current[k]) === JSON.stringify(opts[k]),
        );
        if (same) {
          this._capabilityOptionsCache.set(cap, key);
          return;
        }
      } catch (e) { /* no stored options yet — fall through and write */ }
    }
    await this.setCapabilityOptions(cap, opts).catch(() => {});
    this._capabilityOptionsCache.set(cap, key);
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
    // RC-x: Do NOT include `disabled` or dynamic activeLabel titles in
    // setCapabilityOptions — Homey recreates all flow cards on every
    // setCapabilityOptions() call, so any per-transition change (disabled flag,
    // "Mowing started"/"Returning" labels) reinitialised all flow cards on every
    // mowing start/stop. Titles stay static; the activeLabel argument is kept
    // for call-site compatibility but intentionally ignored. Functional button
    // guards are enforced by _commandUnavailableReason(); writing the static
    // base title once also self-heals devices that still carry a stale dynamic
    // title from an older version.
    void activeLabel;
    const title = baseTitles[cap];
    if (title) {
      await this._setCapabilityOptionsIfChanged(cap, { title });
    }
    await this.setCapabilityValue(cap, false).catch(() => {});
  }

  async _updateCommandButtonUi(status = null) {
    const rawNativeStatus = status || this._nativeMowerStatus || this.getCapabilityValue('mower_status') || 'unknown';
    let nativeStatus = rawNativeStatus;
    if (this._pauseButtonHoldUntil && Date.now() < this._pauseButtonHoldUntil && this._pauseButtonHoldMode) {
      nativeStatus = this._pauseButtonHoldMode === 'resume' ? 'paused' : 'mowing';
    }
    const busy = ACTIVE_WORK_STATUSES.has(nativeStatus);
    const paused = nativeStatus === 'paused' || this._recoverablePausedOutsideError();

    // Pause is one physical command button. Make the visible label match the real
    // command that will be sent next: pause while mowing/returning/mapping,
    // resume while paused. Homey still treats it as a momentary button and we
    // always reset the value to false.
    if (this.hasCapability('cmd_pause')) {
      const resume = paused;
      await this._setCapabilityOptionsIfChanged('cmd_pause', {
        title: {
          en: resume ? 'Resume Mowing' : 'Pause Mowing',
          de: resume ? 'Mähen fortsetzen' : 'Mähen pausieren',
        },
        icon: resume ? '/assets/capabilities/cmd_resume.svg' : '/assets/capabilities/cmd_pause.svg',
      });
      await this.setCapabilityValue('cmd_pause', false).catch(() => {});
    }

    if (this.hasCapability('cmd_garage_pause_mode') && this._garageSafety) {
      const garagePaused = !!this._garageSafety.paused;
      await this._setCapabilityOptionsIfChanged('cmd_garage_pause_mode', {
        title: {
          en: garagePaused ? 'Resume garage mode' : 'Pause garage mode',
          de: garagePaused ? 'Garagenmodus fortsetzen' : 'Garagenmodus pausieren',
        },
        icon: garagePaused ? '/assets/capabilities/cmd_resume.svg' : '/assets/capabilities/cmd_pause.svg',
      });
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

  _recoverablePausedOutsideError() {
    const garage = this._garageSafety;
    const status = String(this._nativeMowerStatus || '').toLowerCase();
    const code = Number(this._lastObservedFaultCode || this._mqttErrorCode);
    const sincePause = Date.now() - Number(this._lastUserPauseAt || 0);
    // Only the observed positioning error after an explicit Homey pause may
    // reuse the outdoor mission. Other faults retain their normal block.
    return status === 'error' && code === 27 && sincePause >= 0 && sincePause <= 300000
      && !!garage?.enabled?.() && !!garage.isMissionOutside?.()
      && !garage.isReturnCycleActive?.() && !garage._manualGateStopped
      && !garage._emergencyGateContext && !['opening', 'closing'].includes(garage.doorState());
  }

  _isPausedLike() {
    if (this._recoverablePausedOutsideError()) return true;
    // RC112: while an explicit resume is semantically active, stale raw/cloud
    // pause strings must not make the next Pause/Fortsetzen press look like yet
    // another Resume. The hold mode `pause` means the mower is considered active
    // and the next physical button press must issue Pause.
    if (this._resumeSemanticUntil && Date.now() < this._resumeSemanticUntil
        && this._pauseButtonHoldMode === 'pause') return false;
    const status = this._nativeMowerStatus || this.getCapabilityValue('mower_status') || '';
    if (this._pauseButtonHoldMode === 'resume' && Date.now() < Number(this._pauseButtonHoldUntil || 0)
        && ['idle', 'standby', 'paused'].includes(status)) return true;
    const last = String(this._lastRawStatus || this._lastMowerStatus || '').toLowerCase();
    return status === 'paused' || last.includes('pause') || last.includes('paused');
  }

  _canResumePausedOutside() {
    const garage = this._garageSafety;
    if (!garage?.enabled?.() || !this._isPausedLike() || garage.isReturnCycleActive?.()
        || garage._manualGateStopped || garage._emergencyGateContext
        || ['opening', 'closing'].includes(garage.doorState())) return false;
    const diag = this._mowerBinaryDiag;
    const age = Date.now() - Number(this._mowerBinaryDiagAt || 0);
    if (diag && age >= 0 && age <= 15000 && diag.dockingState === 'IN_STATION') return false;
    // Proximity to the stationary gate alone must not turn a paused outdoor
    // mission into a new station departure. A map coordinate alone is not enough.
    return !!garage.isMissionOutside?.();
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

    if (capabilityId === 'cmd_pause'
        && !['mowing', 'paused', 'returning', 'mapping'].includes(status)
        && !this._recoverablePausedOutsideError()) {
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
      // first and releases the native maintenance point command only after the door
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

  async _refreshPositionBeforeGarageCommand(capabilityId) {
    if (!['cmd_dock', 'cmd_maintenance_point', 'cmd_start_mowing'].includes(capabilityId)) return;
    const garage = this._garageSafety;
    if (!garage?.enabled?.()) return;
    const buffered = this._getBufferedLivePosition?.(8000);
    if (buffered) {
      await garage.reconcilePhysicalHomeStateForCommand?.(`fresh_buffer_${capabilityId}`);
      return;
    }

    const did = this.getData().id;
    let source = 'none';
    const direct = await this._api.getMowerPosition(did).catch(() => null);
    if (direct && Number.isFinite(Number(direct.x)) && Number.isFinite(Number(direct.y))) {
      if (this._setLivePosition({ x: direct.x, y: direct.y }, 'siid:1:4')) source = 'siid:1:4';
    }
    if (source === 'none') {
      const mitrc = await this._api.getMITRC(did, this._activeMapIndex, 65535).catch(() => null);
      const relative = mitrc ? this._parseMITRCPosition(mitrc) : null;
      if (relative && this._dockPos) {
        const point = { x: this._dockPos.x + relative.x, y: this._dockPos.y - relative.y };
        if (this._setLivePosition(point, 'mitrc')) source = 'MITRC';
      }
    }
    this.log(`[garage] command position refresh capability=${capabilityId} source=${source}`);
    await garage.updatePositionGuards?.().catch(() => {});
    await garage.reconcilePhysicalHomeStateForCommand?.(`refresh_${capabilityId}`);
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

    // Homey renders these boolean command capabilities as selected/white while
    // their value is true. Clear the value before any network/position await so
    // a slow refresh can never make a single-press command look latched. The
    // command lock below remains authoritative and still blocks duplicate writes.
    if (this.hasCapability(capabilityId)) {
      await this.setCapabilityValue(capabilityId, false).catch(() => {});
      this.homey.setTimeout(() => this.setCapabilityValue(capabilityId, false).catch(() => {}), 40);
      this.homey.setTimeout(() => this.setCapabilityValue(capabilityId, false).catch(() => {}), 250);
      this.homey.setTimeout(() => this.setCapabilityValue(capabilityId, false).catch(() => {}), 1000);
    }

    await this._refreshPositionBeforeGarageCommand(capabilityId).catch((e) => {
      this.log(`[garage] command position refresh failed capability=${capabilityId}: ${e.message}`);
    });
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
   * Join the cloud MAP.N blob using MAP.info as the authoritative payload
   * length when available.
   *
   * The official Dreame Android app's getDeviceData(keys:[]) response captured
   * on 2026-10-01 contained MAP.info="8155": MAP.0..MAP.7 formed exactly those
   * 8155 characters, while MAP.8..MAP.52 were stale leftovers from an older,
   * larger snapshot.  Concatenating every present MAP.N key therefore makes the
   * cache look changed even when the current map did not change and can expose
   * stale post-edit data to diagnostics.  Geometry parsing already truncated at
   * the first complete JSON array as a defensive fallback; this helper makes the
   * vendor length marker explicit and also lets targeted readback reject a
   * genuinely incomplete chunk set.
   */
  _joinNativeMapChunks(raw) {
    const parts = [];
    for (let i = 0; i < 128 && raw?.[`MAP.${i}`] != null; i++) parts.push(String(raw[`MAP.${i}`] ?? ''));
    const joined = parts.join('');
    const expected = Number(raw?.['MAP.info']);
    if (Number.isFinite(expected) && expected > 0) {
      return {
        text: joined.slice(0, expected),
        complete: joined.length >= expected,
        expectedLength: expected,
        availableLength: joined.length,
        chunkCount: parts.length,
        staleTailLength: Math.max(0, joined.length - expected),
      };
    }
    return {
      text: joined,
      complete: joined.length > 0,
      expectedLength: null,
      availableLength: joined.length,
      chunkCount: parts.length,
      staleTailLength: 0,
    };
  }

  /**
   * Scan MAP.N chunks for zone and spot IDs, then update the num_zones setting
   * and both pickers. Exits early when nothing has changed.
   * Called every poll cycle; _extractMapInfo and _parseMapDataChunks are skipped
   * when the raw MAP string is identical to the previous call.
   */
  async _detectAndSyncZones(raw) {
    // Build MAP string to check for changes before doing any parsing work.
    const mapEnvelope = this._joinNativeMapChunks(raw);
    const mapStr = mapEnvelope.text;
    const mapChanged = mapStr !== this._lastMapStr;
    if (mapStr) this._lastMapStr = mapStr;

    let detectedIds = [];
    let spotIds = [];
    let maps = [];

    if (mapChanged) {
      ({ ids: detectedIds, spotIds, maps } = this._extractMapInfo(raw));
    } else {
      detectedIds = this._activeZoneIds || [];
      maps = this._discoveredMaps || [];
    }

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
    // Full map parse (MAP chunks) is skipped when the MAP string is unchanged — only M_PATH is re-parsed.
    let parsed = mapChanged
      ? (this._parseMapDataChunks(raw) || this._parseDirectMapData(this._cachedMAPI))
      : this._parseLivePathOnly(raw);
    // A hash-verified MAPD snapshot is newer than a stale cloud MAP.* blob. Do
    // not let the regular poll visually undo a just-confirmed native edit while
    // MAPI still points at that same direct snapshot. As soon as cloud geometry
    // catches up, or MAPI advances to another map revision, normal replacement
    // resumes automatically.
    if (mapChanged && parsed?.mowingAreas && this._cachedMapData?.directMapdGeometryVerified === true
        && Number(this._cachedMapData.directMapdMapIndex) === Number(this._activeMapIndex)) {
      const directHash = String(this._cachedMapData.directMapdHash || '');
      const currentMetaHash = String(this._lastVendorMapMeta?.hash || '');
      const sameRevision = !currentMetaHash || !directHash || currentMetaHash === directHash;
      const cloudCaughtUp = this._nativeForbiddenGeometryEquivalent(
        parsed.forbiddenAreas, this._cachedMapData.forbiddenAreas,
      );
      if (sameRevision && !cloudCaughtUp) {
        parsed = {
          ...parsed,
          forbiddenAreas: this._cachedMapData.forbiddenAreas,
          md5sum: this._cachedMapData.md5sum,
          directMapdVerified: true,
          directMapdMapIndex: this._cachedMapData.directMapdMapIndex,
          directMapdScale: this._cachedMapData.directMapdScale,
          directMapdHash: this._cachedMapData.directMapdHash,
          directMapdSize: this._cachedMapData.directMapdSize,
          directMapdChunks: this._cachedMapData.directMapdChunks,
        };
        if (!this._directMapdCloudLagLogged) {
          this._directMapdCloudLagLogged = true;
          this.log('[map] cloud MAP.* still behind verified MAPD geometry; keeping direct native zones');
        }
      } else if (cloudCaughtUp) {
        this._directMapdCloudLagLogged = false;
      }
    }
    if (parsed) {
      if (parsed.md5sum !== this._cachedMapData?.md5sum && parsed.mowingAreas) {
        // Full parse (parseMapDataChunks / parseDirectMapData) — replace cache entirely,
        // but never downgrade a zone-complete map to a zone-less one (transient parse).
        const parsedHasZones = parsed.mowingAreas.length > 0;
        const cacheHasZones  = this._cachedMapData?.mowingAreas?.length > 0;
        if (parsedHasZones || !cacheHasZones) {
          this._cachedMapData = parsed;
          this.log(`[map] cached: ${parsed.name}, ${parsed.mowingAreas.length} zones, ${parsed.livePath.length} path pts`);
        }
      } else if (this._cachedMapData && parsed.livePath.length > 0) {
        this._cachedMapData = { ...this._cachedMapData, livePath: parsed.livePath, chargerPos: parsed.chargerPos };
      } else if (this._cachedMapData) {
        this._cachedMapData = { ...this._cachedMapData, chargerPos: parsed.chargerPos || this._cachedMapData.chargerPos };
      }
      // If _parseLivePathOnly ran but _cachedMapData is not yet initialised (no full
      // MAP parse received yet), skip the merge — a lightweight result must never
      // replace a null cache entry because it lacks zones, contours and name.
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
    const mapEnvelope = this._joinNativeMapChunks(raw);
    const mapStr = mapEnvelope.text;
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
    await this._setCapabilityOptionsIfChanged('mow_map', { values })
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
    await this._setCapabilityOptionsIfChanged('mow_zone', { values })
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
    await this._setCapabilityOptionsIfChanged('mow_spot', { values })
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
    // Re-auth replaces the broker password too; without this the live feed
    // would keep retrying with the token the user just invalidated.
    this.onMqttTokenRotated();
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
    // The MQTT broker password is this access token. Tell the live feed about
    // the rotation so a dropped link never reconnects with the dead one.
    this.onMqttTokenRotated();
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
    const legacy = [
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
    // Firmware with Turning Method has a 21-int PRE. Preserve the unknown
    // firmware-owned tail from a real PRE read; never fabricate PRE[20].
    if (Array.isArray(this._cachedPRE) && this._cachedPRE.length >= 21) {
      legacy.push(s.steeringMode != null ? Number(s.steeringMode) : Number(this._cachedPRE[19]));
      legacy.push(Number(this._cachedPRE[20]));
    }
    return legacy;
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

    // Read-only native protocol diagnosis. Never reconstruct/write a 21-field
    // steering preference from the legacy 19-field PRE cache based on guesses.
    const preferenceRows = Object.entries(mapEntry?.settings ?? {})
      .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
      .map(([zone, value]) => ({
        zone: /^\d{1,3}$/.test(zone) ? zone : '?',
        steeringMode: [0, 1].includes(Number(value.steeringMode)) && value.steeringMode != null
          ? Number(value.steeringMode) : null,
        steeringFieldPresent: Object.hasOwn(value, 'steeringMode'),
        obstacleSensitivityPresent: Object.hasOwn(value, 'obstacleAvoidanceSensitivity'),
        edgeCuttingAttachmentPresent: Object.hasOwn(value, 'edgeCuttingAttachment'),
        cutterPositionHeightPresent: Object.hasOwn(value, 'cutterPositionHeight'),
      }));
    const preferenceSignature = JSON.stringify([this._activeMapIndex, preferenceRows]);
    if (preferenceSignature !== this._nativePreferenceDiagSignature) {
      this._nativePreferenceDiagSignature = preferenceSignature;
      this.log('[native-pref-readonly]', preferenceSignature);
    }

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

      // SETTINGS.steeringMode can lag the device-applied PRE[19] value by
      // several polls. Keep it as a diagnostic/fallback observation only;
      // _syncTurningMethodFromNativePRE() is authoritative for the live Homey
      // picker and prevents the 0→1 flicker seen when the two sources disagree.
      if (s.steeringMode != null && [0, 1].includes(Number(s.steeringMode))) {
        this._lastSettingsSteeringMode = Number(s.steeringMode);
      }
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

    // CFG.PROT is a separate manufacturer grass-protection setting and is not
    // the Wendemodus picker. turning_method is synchronized from
    // SETTINGS.steeringMode / PRE[19] in _applyMOVASettings().

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
        lowStart   = Math.min(23, Math.floor(Math.max(0, cfg.LOW[1] ?? 1200) / 60));
        lowEnd     = Math.min(23, Math.floor(Math.max(0, cfg.LOW[2] ?? 480)  / 60));
      } else if (typeof cfg.LOW === 'object') {
        lowEnabled = cfg.LOW.value === 1;
        lowStart   = Math.min(23, Math.floor(Math.max(0, cfg.LOW.time?.[0] ?? 1200) / 60));
        lowEnd     = Math.min(23, Math.floor(Math.max(0, cfg.LOW.time?.[1] ?? 480)  / 60));
      } else {
        lowEnabled = cfg.LOW === 1;
        lowStart   = 20;
        lowEnd     = 8;
      }
      if (this.getSetting('low_enabled') !== lowEnabled) update.low_enabled = lowEnabled;
      if (this.getSetting('low_start')   !== lowStart)   update.low_start   = lowStart;
      if (this.getSetting('low_end')     !== lowEnd)     update.low_end     = lowEnd;
    }

    // DND — ordinary native mower setting. It is not tied to garage state.
    if (cfg.DND != null) {
      let dndEnabled, dndStart, dndEnd;
      if (Array.isArray(cfg.DND)) {
        dndEnabled = cfg.DND[0] === 1;
        dndStart   = Math.min(23, Math.floor(Math.max(0, cfg.DND[1] ?? 1320) / 60));
        dndEnd     = Math.min(23, Math.floor(Math.max(0, cfg.DND[2] ?? 480)  / 60));
      } else if (typeof cfg.DND === 'object') {
        dndEnabled = cfg.DND.value === 1;
        dndStart   = Math.min(23, Math.floor(Math.max(0, cfg.DND.time?.[0] ?? 1320) / 60));
        dndEnd     = Math.min(23, Math.floor(Math.max(0, cfg.DND.time?.[1] ?? 480)  / 60));
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
    this._chargingStatusAt = Date.now();
    // Repeated identical charging frames are still fresh physical evidence. Feed
    // every such frame into the 15 s home-close proof before the capability-value
    // fast path drops duplicates.
    this._garageSafety?.noteHomeChargingTelemetry?.(status, this._chargingStatusAt);
    if (status === this.getCapabilityValue('charging_status')) return;
    await this._setCap('charging_status', status);
    this._trgChargingChanged
      .trigger(this, { status }, {})
      .catch((e) => this.error('charging_status_changed trigger:', e.message));

    // Charging/docked information is often more reliable than latestStatus during
    // the final garage return. Feed it into the garage state machine so Zuhause
    // and the final close request are not missed when latestStatus remains idle.
    if (this._garageSafety && ['charging', 'charging_completed', 'docked'].includes(status)) {
      this._garageSafety.onStatus(status, this._nativeMowerStatus || 'unknown')
        .catch((e) => this.error('[garage] charging status hook:', e.message));
    }
    await this._updateCommandButtonUi(this._nativeMowerStatus || this.getCapabilityValue('mower_status')).catch(() => {});
  }

  async _announceMowerFault(kind, faultCode, description) {
    const code = Number(faultCode);
    const key = `${kind}:${Number.isFinite(code) ? code : String(faultCode)}:${description}`;
    // Dreame can alternate error/paused/error while one physical fault is still
    // active. Do not create a new Homey notification for that same fault merely
    // because a transient non-error status arrived between packets.
    if (key === this._lastFaultAnnouncementKey && Date.now() - Number(this._lastFaultAnnouncementAt || 0) < 10 * 60 * 1000) return;
    this._lastFaultAnnouncementKey = key;
    this._lastFaultAnnouncementAt = Date.now();

    const titleKey = kind === 'warning' ? 'fault_notice.warning' : 'fault_notice.error';
    let title = this.homey.__(titleKey);
    if (!title || title === titleKey) title = kind === 'warning' ? 'Mäher-Warnung' : 'Mäher-Fehler';

    const actionKey = Number.isFinite(code) ? `fault_actions.${code}` : '';
    let action = actionKey ? this.homey.__(actionKey) : '';
    if (!action || action === actionKey) {
      action = this.homey.__('fault_actions.default');
      if (!action || action === 'fault_actions.default') action = '';
    }

    const codeText = Number.isFinite(code) && code > 0 ? ` (Code ${code})` : '';
    const excerpt = `[Mäher] ${title}: ${description}${codeText}${action ? ` — ${action}` : ''}`;
    this.log(`[fault] ${excerpt}`);
    try {
      if (this.homey.notifications && typeof this.homey.notifications.createNotification === 'function') {
        await this.homey.notifications.createNotification({ excerpt });
      }
    } catch (e) {
      this.log(`[fault] timeline notification failed: ${e.message}`);
    }
  }

  async _isOutsideGarageMissionResume(prevStatus) {
    if (!this._garageSafety?.enabled?.()) return false;
    const prev = String(prevStatus || '').toLowerCase();
    if (!['error', 'paused', 'standby', 'idle'].includes(prev)) return false;
    // 1.2.12: A native `mowing` frame while the garage state machine already
    // owns a return/maintenance mission is transit telemetry, never a user
    // Pause→Resume or a new mowing start. The previous classifier only checked
    // "mission outside" and could therefore hijack an active maintenance return.
    if (this._garageSafety.isReturnCycleActive?.()) return false;
    if (this._dockCommandIntentUntil && Date.now() < this._dockCommandIntentUntil) return false;
    if (!this._garageSafety.isMissionOutside?.()) return false;

    const posTs = Number(this._lastLivePosAt || this._livePos?.ts || 0);
    if (!posTs || Date.now() - posTs > 10000) return false;

    let danger = null;
    try { danger = await this._garageSafety.markers?.dangerState?.(); } catch (_) {}
    if (!danger || danger.known === false || danger.inside !== false) return false;

    this.log(`[garage] resume classifier: previous=${prev} outside=true distance=${Math.round(Number(danger.distance) || 0)}mm`);
    return true;
  }

  async _freezeCompletedMapRouteForDisplay(reason = 'route_complete', { definitive = false } = {}) {
    const mapIndex = Number(this._activeMapIndex);
    const existing = this._completedMapRoute;
    if (existing?.visualFinal === true
        && Number(existing.mapIndex) === mapIndex
        && Array.isArray(existing.path)
        && existing.path.length > 1) {
      // Once the mowing part has been frozen, never replace it later with the
      // drive back to the station. A later strong completion signal only upgrades
      // the same snapshot from a visual candidate to a definitive completion.
      if (definitive && existing.definitive !== true) {
        this._completedMapRoute = { ...existing, definitive:true, definitiveAt:Date.now(), finalReason:reason };
        await this.setStoreValue('completed_map_route', this._completedMapRoute).catch(() => {});
        this._scheduleMapCameraImageUpdate();
      }
      return true;
    }

    this._collectDurableRoute();
    const durablePath = this._durableRoute?.path(mapIndex);
    const cachedPath = Array.isArray(this._cachedMapData?.livePath) ? this._cachedMapData.livePath : [];
    const telemetryPath = Array.isArray(this._liveRouteTrail) ? this._liveRouteTrail : [];
    let completedPath = Array.isArray(durablePath) && durablePath.length > 1 ? durablePath.slice() : cachedPath.slice();

    // Older/restored sessions can have no durable entry yet. In that case retain
    // the previous merge behaviour so the last telemetry-only lanes are not lost.
    if ((!Array.isArray(durablePath) || durablePath.length <= 1) && telemetryPath.length) {
      let lastCached = null;
      for (let i = completedPath.length - 1; i >= 0; i--) {
        if (completedPath[i]?.[0] !== 32767) { lastCached = completedPath[i]; break; }
      }
      const firstTelemetry = telemetryPath.find((pt) => pt?.[0] !== 32767);
      if (lastCached && firstTelemetry
          && Math.hypot(firstTelemetry[0] - lastCached[0], firstTelemetry[1] - lastCached[1]) > 3000) {
        completedPath.push([32767, -32768]);
      }
      completedPath.push(...telemetryPath);
    }

    if (completedPath.length <= 1) return false;
    this._completedMapRoute = {
      mapIndex,
      path: completedPath,
      completedAt: Date.now(),
      visualFinal: true,
      definitive: !!definitive,
      finalReason: reason,
    };
    await this.setStoreValue('completed_map_route', this._completedMapRoute).catch(() => {});
    this.log(`[map] mowing route frozen for final lane render: ${completedPath.length} pts on map ${mapIndex} reason=${reason}${definitive ? ' definitive' : ''}`);
    this._scheduleMapCameraImageUpdate();
    return true;
  }

  async _clearVisualRouteCompletion(reason = 'mowing_resumed') {
    if (!this._completedMapRoute?.visualFinal) return;
    this.log(`[map] final lane render cancelled because mowing resumed reason=${reason}`);
    this._completedMapRoute = null;
    await this.setStoreValue('completed_map_route', null).catch(() => {});
    this._scheduleMapCameraImageUpdate();
  }

  async _applyStatus(status, faultCode = 0, nativeEvidence = true) {
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
    if (nativeEvidence) {
      if (status === 'error' && Number(faultCode) > 0) this._lastObservedFaultCode = Number(faultCode);
      else if (status !== 'error') this._lastObservedFaultCode = 0;
      this._observedMowerStatus = status;
      this._observedMowerStatusAt = Date.now();
    }
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

    // 1.2.12: Never rewrite an actually observed `paused` frame to `mowing`.
    // The next button action is kept separately by _pauseButtonHoldMode, while
    // _observedMowerStatus/_nativeMowerStatus continue to reflect device evidence.
    // This avoids a stale cloud frame turning into synthetic native state that can
    // interfere with the return/maintenance owner. Resume confirmation is handled
    // by fresh post-command observations in _resumeMowingRobust().

    // Count outbound MOWING evidence only after the pause/resume stale-status
    // filters above. The shortcut is intentionally based on the effective native
    // state, not on a raw packet we just classified as stale. Keep this before the
    // unchanged-status fast path so two genuinely repeated MOWING samples can be
    // observed without forcing a Homey capability change.
    if (nativeEvidence && this._garageSafety?.observeNativeStatusSample) {
      await this._garageSafety.observeNativeStatusSample(status).catch((e) => this.error('[garage] status sample hook:', e.message));
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
    if (status === 'mowing' && prev !== 'mowing') {
      const resumeOutsideGarage = !resumeGuardActive
        ? await this._isOutsideGarageMissionResume(prev)
        : false;
      if (resumeGuardActive || resumeOutsideGarage) {
        if (resumeOutsideGarage) {
          this._resumeGuardUntil = Math.max(Number(this._resumeGuardUntil || 0), Date.now() + 120000);
          this._resumeSemanticUntil = Math.max(Number(this._resumeSemanticUntil || 0), Date.now() + 120000);
          this.log(`[garage] mower mission resumed outside garage after ${prev}; no gate cycle`);
          this._garageSafety?.realtimeTimelineEvent?.('resume_outside', `previous=${prev}`);
        } else {
          this.log('[garage] mowing after resume accepted without garage start flow');
        }
      } else {
        this._garageSafety.onExternalMowingDetected().catch((e) => this.error('[garage] external start guard:', e.message));
      }
    }
    this._garageSafety.onStatus(status, prev).catch((e) => this.error('[garage] status hook:', e.message));

    this._trgStatusChanged
      .trigger(this, { status }, {})
      .catch((e) => this.error('status_changed trigger:', e.message));

    // Session duration + route ownership.
    //
    // IMPORTANT: "mowing" can disappear temporarily during pause/error/returning
    // phases of the SAME job. v1.1.66 treated every later mowing packet as a new
    // session and cleared the already driven route. A low-battery automatic
    // charge break did the same on resume. Only a genuinely new mission may
    // clear the previous completed route / live trail.
    const confirmedSessionHome = nativeEvidence && HOME_STATUSES.has(status)
      && !!this._garageSafety?._strongDockCloseProof?.() && !this._garageSafety?._outbound;
    let preserveSessionAcrossHome = false;
    if (isMowing && !this._wasMowing) {
      if (this._completedMapRoute?.visualFinal) {
        await this._clearVisualRouteCompletion('native_mowing_resumed');
      }
      const chargeBreakContinuation = isChargeBreakContinuation(this._chargeBreakResumeUntil);
      const newMission = !this._wasMowingSession && !chargeBreakContinuation && !this._durableRoute?.entry(this._activeMapIndex)?.active;
      this._durableRoute?.begin(this._activeMapIndex, { fresh: newMission, blockedPath: this._cachedMapData?.livePath || [] });
      this._persistDurableRoute(true);
      if (newMission) {
        this._completedMapRoute = null;
        this.setStoreValue('completed_map_route', null).catch(() => {});
        if (Array.isArray(this._liveRouteTrail)) this._liveRouteTrail = [];
        this._positionCandidate = null;
        this._sessionStartTime = Date.now();
        this.setStoreValue('session_start_time', this._sessionStartTime).catch(() => {});
        if (this.hasCapability('measure_duration')) {
          await this._setCap('measure_duration', 0);
        }
        this._trgMowingStarted.trigger(this, {}, {})
          .catch((e) => this.error('mowing_started trigger:', e.message));
      } else {
        // Same mission resumed: preserve every already drawn lane. Ensure the
        // timer also survives older installations where it was cleared on pause.
        if (!Number.isFinite(Number(this._sessionStartTime)) || Number(this._sessionStartTime) <= 0) {
          this._sessionStartTime = Date.now();
          this.setStoreValue('session_start_time', this._sessionStartTime).catch(() => {});
        }
        this.log(`[map] mowing resumed within existing session; route preserved${chargeBreakContinuation ? ' (charge break)' : ''}`);
      }
      if (chargeBreakContinuation) {
        this._chargeBreakResumeUntil = 0;
        this.setStoreValue('charge_break_resume_until', 0).catch(() => {});
      }
    }

    // Upstream 1.1.21 error classification: true errors alarm, warnings are
    // displayed without promoting the mower to an error state, info codes stay silent.
    const isError = status === 'error';
    const isWarning = !isError && WARNING_DEVICE_CODES.has(faultCode);
    const recoverablePauseFault = isError && Number(faultCode) === 27 && this._recoverablePausedOutsideError();
    // Code 27 immediately after an explicit outdoor pause is a known temporary
    // positioning side-effect on A2. Preserve the raw status/code for diagnostics
    // and resume logic, but do not raise a user-facing hard fault/alarm for it.
    await this._setCap('alarm_generic', isError && !recoverablePauseFault);
    if ((isError || isWarning) && !recoverablePauseFault) {
      // Code 0 means 'normal operation' in Dreame's error-code table and must
      // never be presented as the description of an actual error state. Some
      // status packets arrive before the concrete error code, so use a neutral
      // localized error description until a real code follows.
      const errorDescription = isError && Number(faultCode) === 0
        ? (this.homey.__('fault_notice.generic_error') || 'Mäher meldet einen Fehler')
        : (this.homey.__(`error_codes.${faultCode}`)
          || this.homey.__('error_codes.unknown').replace('__code__', faultCode));
      if (this.hasCapability('mower_error')) await this._setCap('mower_error', errorDescription);
      await this._announceMowerFault(isError ? 'error' : 'warning', faultCode, errorDescription);
      if (isError) {
        this._trgError.trigger(this, { error_code: faultCode, error_description: errorDescription }, {})
          .catch((e) => this.error('mower_error trigger:', e.message));
      }
    } else {
      if (recoverablePauseFault) this.log('[fault] code 27 after explicit outdoor pause kept as recoverable pause state');
      // Keep the announcement key/time. A physical fault often produces a short
      // paused packet between two error packets; clearing the key here caused
      // duplicate/triplicate timeline notifications. A different fault code or
      // the 10-minute re-notification window can still produce a new notice.
      if (this.hasCapability('mower_error')) await this._setCap('mower_error', null);
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
      // The mowing geometry ends when the mower changes into RETURNING. Freeze it
      // here, not only after a successful dock. This keeps a failed/blocked garage
      // return from leaving the finished lawn in the wavy live-route presentation.
      // A predicted automatic charge break is excluded because that same mowing
      // mission is expected to continue after charging.
      const likelyChargeBreak = this._returnSnapshot.autoResume
        && this._returnSnapshot.battery <= (this._returnSnapshot.returnPct + 2);
      if (!likelyChargeBreak) {
        await this._freezeCompletedMapRouteForDisplay('returning_transition', { definitive:false });
      }
    }

    if (this._wasMowingSession && confirmedSessionHome) {
      const snap        = this._returnSnapshot ?? {};
      const battery     = snap.battery    ?? (this.getCapabilityValue('measure_battery') ?? 100);
      const returnPct   = snap.returnPct  ?? (this.getSetting('bat_return_pct')  ?? 15);
      const autoResume  = snap.autoResume ?? (this.getSetting('bat_auto_resume') ?? false);
      const isChargeBreak = autoResume && battery <= (returnPct + 2);
      if (!isChargeBreak) {
        // Upgrade the already frozen mowing snapshot to definitive completion. Do
        // not rebuild it here: positions driven during the return belong to docking,
        // not to the final mowing pattern.
        await this._freezeCompletedMapRouteForDisplay('confirmed_home', { definitive:true });
        this._durableRoute?.finish(this._activeMapIndex);
        this._persistDurableRoute(true);
        this._chargeBreakResumeUntil = 0;
        this.setStoreValue('charge_break_resume_until', 0).catch(() => {});
        this._trgMowingCompleted.trigger(this, {}, {})
          .catch((e) => this.error('mowing_completed trigger:', e.message));
      } else {
        // A temporary charge break is not a new mowing job. Keep the route and
        // session timer alive for a bounded window so automatic resume can append
        // to the existing mowing pattern instead of erasing it.
        this._chargeBreakResumeUntil = Date.now() + 6 * 60 * 60 * 1000;
        this.setStoreValue('charge_break_resume_until', this._chargeBreakResumeUntil).catch(() => {});
        preserveSessionAcrossHome = true;
        this.log(`[trigger] mowing_completed suppressed — charge break (battery=${battery}% ≤ returnPct=${returnPct}%+2); route preserved for resume`);
      }
      this._returnSnapshot = null;
    }

    this._wasMowing = isMowing;
    if (isMowing) {
      this._wasMowingSession = true;
      this._returnSnapshot   = null; // mid-session return; clear snapshot so next return re-captures
    } else if (isReturning || isSessionTransientStatus(status) || !confirmedSessionHome) {
      // Same mission is still in progress; keep route + timer.
      this._wasMowingSession = this._wasMowingSession || !!this._sessionStartTime;
    } else {
      // A home/resting state is a definitive session boundary unless the mower
      // is in the bounded automatic charge-break window above.
      this._wasMowingSession = false;
      if (!preserveSessionAcrossHome) {
        this._sessionStartTime = null;
        this.setStoreValue('session_start_time', null).catch(() => {});
      }
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
    await this._applyStatus('mowing', 0, false);
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
    if (this._garageSafety?._manualGateStopped) throw new Error('Tor manuell gestoppt – zuerst Tor sicher freigeben');
    const did = this.getData().id;
    if ((this._dockCommandIntentUntil && Date.now() < this._dockCommandIntentUntil)
        || this._garageSafety?.isReturnCycleActive?.()
        || this._garageSafety?._manualGateStopped
        || this._garageSafety?._emergencyGateContext
        || ['opening', 'closing'].includes(this._garageSafety?.doorState?.())) {
      this.log(`[${label}] resume suppressed: return/safety gate active`);
      return false;
    }
    const recoveringPositionError = this._recoverablePausedOutsideError();
    const wasPausedAtResume = this._isPausedLike();
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
    this._resumeCommandSentAt = Date.now();
    let ok = await this._safeWrite(label, () => this._api.resume(did));
    await sleep(1800);
    await this._poll().catch(() => {});
    if ((this._dockCommandIntentUntil && Date.now() < this._dockCommandIntentUntil)
        || this._garageSafety?.isReturnCycleActive?.()) {
      this.log(`[${label}] fallback suppressed: return command became active`);
      return false;
    }
    if (this._isPausedLike() || this._nativeMowerStatus !== 'mowing') {
      ok = await this._safeWrite(`${label}_fallback_start`, () => this._api.startMowing(did));
      await sleep(1500);
      await this._poll().catch(() => {});
    } else {
      // Even when the cloud already says mowing, send one idempotent resume/start
      // stabilizer shortly after the button press. Field tests showed this is the
      // difference between a visual resume and actual blade/drive movement.
      this.homey.setTimeout(() => {
        if ((this._dockCommandIntentUntil && Date.now() < this._dockCommandIntentUntil)
            || this._garageSafety?.isReturnCycleActive?.()) {
          this.log(`[${label}] stabilize start cancelled: return command active`);
          return;
        }
        this._safeWrite(`${label}_stabilize_start`, () => this._api.startMowing(did)).catch(() => {});
      }, 1200);
    }
    const freshMowingConfirmed = this._observedMowerStatus === 'mowing'
      && Number(this._observedMowerStatusAt || 0) >= Number(this._resumeCommandSentAt || 0);
    if (ok === false || (recoveringPositionError && !freshMowingConfirmed)) {
      if (wasPausedAtResume) {
        this._pauseButtonHoldMode = 'resume';
        this._resumeSemanticUntil = 0;
        await this._updateCommandButtonUi('error').catch(() => {});
        this.log(`[${label}] resume not confirmed; keeping pause/error command semantics`);
      }
      return false;
    }
    // Do not fabricate native `mowing` here. The button already flips to the
    // next action (Pause) through the command-intent latch; the physical/native
    // status changes only when fresh telemetry confirms it.
    await this._updateCommandButtonUi(freshMowingConfirmed ? 'mowing' : (this._nativeMowerStatus || 'paused')).catch(() => {});
    this.homey.setTimeout(() => this._poll().catch(() => {}), 3000);
    return ok;
  }

  async cmdPause() {
    // 1.2.13: every Pause/Fortsetzen entry point uses the same semantic
    // resolver. This includes the recoverable code-27 state after an explicit
    // outdoor pause; a Flow must not send another Pause while the device button
    // correctly offers Fortsetzen.
    const resumeRequested = this._isPausedLike();
    if (resumeRequested) {
      this.log('[cmd] resume');
      this._pauseButtonHoldMode = 'pause';
      this._pauseButtonHoldUntil = Date.now() + 90000;
      await this._resumeMowingRobust('flow_resume');
    } else {
      this.log('[cmd] pause');
      this._resumeSemanticUntil = 0;
      this._pauseButtonHoldMode = 'resume';
      this._pauseButtonHoldUntil = Date.now() + 90000;
      this._lastUserPauseAt = Date.now();
      if (this._garageSafety?.enabled?.() && typeof this._garageSafety.noteUserPauseRequested === 'function') {
        this._garageSafety.noteUserPauseRequested();
      }
      await this._safeWrite('flow_pause', () => this._api.pause(this.getData().id));
      await this._applyStatus('paused', 0, false);
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
      const accepted = await this._api.dock(this.getData().id);
      if (accepted === false) return false;
      await this._applyStatus('returning', 0, false);
      return true;
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
    // The original MOVA/Dreame command and the successful A2 field test both use
    // native maintenance point 1. Keep this fixed so every garage path sends the
    // exact same upstream command.
    const pointIndex = resolveMaintenancePointIndex(this);
    this.log(`[maintenance] point-index fixed: model=${this._devModel || this.getSetting('device_model_id') || '?'} resolved=${pointIndex}`);
    return pointIndex;
  }

  async _goToMaintenancePointGuarded(label = 'maintenance') {
    const did = this.getData().id;
    const mapIdx = this._activeMapIndex ?? 0;
    const pointIndex = this._maintenancePointIndex();
    this._nativeMaintenanceCommandAt = Date.now();
    this._pendingNativeMaintenanceArrival = null;
    this._nativeMaintenanceArrivalLatched = false;
    this._nativeMaintenanceStableArrival = null;
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

  _collectDurableRoute() {
    const map = this._activeMapIndex;
    if (!this._durableRoute) return;
    if (!this._durableRoute.entry(map) && this._wasMowingSession) this._durableRoute.begin(map);
    this._durableRoute.ingest(map, this._cachedMapData?.livePath, { cloud: true });
    if (this._routeTrailMap === map) this._durableRoute.ingest(map, this._liveRouteTrail);
    this._persistDurableRoute();
  }

  _persistDurableRoute(force = false) {
    if (!this._durableRoute || (!force && Date.now() - this._routeSaveAt < 20000)) return;
    this._routeSaveAt = Date.now();
    const snapshot = this._durableRoute.snapshot();
    this._routeSaveChain = (this._routeSaveChain || Promise.resolve()).catch(() => {})
      .then(() => this.setStoreValue('durable_mowing_route', snapshot))
      .catch(() => { this._routeSaveAt = 0; this.error('[map] route persistence failed'); });
  }

  _appendLiveRoutePoint(pos, source = '') {
    if (!pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) return;
    if (String(source || '').startsWith('garage-marker')) return;
    const status = String(this._nativeMowerStatus || this.getCapabilityValue('mower_status') || '').toLowerCase();
    const active = new Set(['mowing', 'edge_mowing', 'leaving', 'returning', 'paused', 'remote_control', 'adjusting', 'positioning']);
    if (!active.has(status)) return;

    if (this._routeTrailMap !== this._activeMapIndex) { this._liveRouteTrail = []; this._routeTrailMap = this._activeMapIndex; }
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
    if (last) this._durableRoute?.ingest(this._activeMapIndex, [last, point]);
    this._persistDurableRoute();
    // Never drop only the oldest part of a long mowing job: that made the route
    // visibly "disappear from behind" once 800 telemetry samples were reached.
    // Compact the WHOLE history instead. Sentinels remain as pen-up boundaries,
    // while every second real point is retained. Repeated compaction therefore
    // preserves the full time span with progressively lower spatial density.
    if (this._liveRouteTrail.length > 1600) {
      const before = this._liveRouteTrail.length;
      this._liveRouteTrail = compactRouteTrail(this._liveRouteTrail, 1600);
      this.log(`[map] live route compacted ${before}->${this._liveRouteTrail.length} points; full session span retained`);
    }
  }

  _isMqttPositionFresh(maxAgeMs = null) {
    const ageLimit = Number.isFinite(Number(maxAgeMs)) ? Number(maxAgeMs) : Number(this._mqttPositionFreshMs || 8000);
    return Number(this._lastMqttPositionAt || 0) > 0 && (Date.now() - Number(this._lastMqttPositionAt)) <= ageLimit;
  }

  _notePositionAuthority(mode, detail = '') {
    const next = String(mode || 'fallback');
    if (this._positionAuthorityMode === next) return;
    this._positionAuthorityMode = next;
    if (next === 'mqtt_live') this.log(`[pos] authority=mqtt_live; ${detail || 'fallback sources suppressed for garage safety'}`);
    else this.log(`[pos] authority=fallback; ${detail || 'MQTT position stale/missing'}`);
  }

  _setLivePosition(pos, source = '') {
    if (!pos || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) return false;
    const now = Date.now();
    const src = String(source || 'unknown');
    if (src === 'mqtt') {
      // Receipt time, not accepted-position time, controls source authority. If
      // a malformed/teleporting MQTT coordinate is quarantined, safety keeps
      // the last plausible position instead of immediately trusting a delayed
      // cloud fallback.
      this._lastMqttPositionAt = now;
      this._notePositionAuthority('mqtt_live', 'fresh MQTT position; fallback updates suppressed');
    } else if (['siid:1:4', 'locn', 'mitrc'].includes(src) && this._isMqttPositionFresh()) {
      // Hard arbitration gate. Priority numbers alone were not enough because a
      // plausible delayed fallback could still trigger another garage geometry
      // pass. While MQTT is fresh these sources are map/history diagnostics only.
      return false;
    }
    const next = { x: Number(pos.x), y: Number(pos.y), ts: Number(pos.ts) || now, source: src };
    const current = this._livePos && Number.isFinite(Number(this._livePos.x)) && Number.isFinite(Number(this._livePos.y))
      ? this._livePos : null;

    if (!current || now - Number(current.ts || 0) > 30000) {
      this._livePos = next;
      this._lastLivePos = next;
      this._lastLivePosAt = next.ts;
      this._positionCandidate = null;
      this._appendLiveRoutePoint(next, src);
      this._scheduleMapCameraImageUpdate();
      this._commitPendingNativeMaintenanceArrival().catch((e) => this.error('[maintenance] pending arrival commit:', e.message));
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
      this._scheduleMapCameraImageUpdate();
      this._commitPendingNativeMaintenanceArrival().catch((e) => this.error('[maintenance] pending arrival commit:', e.message));
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
      this._scheduleMapCameraImageUpdate();
      this._commitPendingNativeMaintenanceArrival().catch((e) => this.error('[maintenance] pending arrival commit:', e.message));
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

  /** True when an MQTT error/close was caused by rejected credentials. */
  _isMqttAuthError(err) {
    if (!err) return false;
    const msg = String(err.message || '').toLowerCase();
    // mqtt.js surfaces CONNACK return codes 4 (bad username/password) and
    // 5 (not authorized) both as `err.code` and in the message text.
    return err.code === 4 || err.code === 5
      || msg.includes('not authorized')
      || msg.includes('bad user name')
      || msg.includes('bad username');
  }

  /**
   * (Re)connect the MQTT live-position feed.
   *
   * The broker password is the OAuth access token, which the API rotates about
   * every two hours. mqtt.js `reconnect()` replays the options the client was
   * built with, so a reconnect after a rotation would authenticate with a dead
   * token forever. Therefore every attempt builds a *new* client from the token
   * that is current at that moment, and `_mqttGeneration` invalidates callbacks
   * belonging to a client we have already replaced.
   */
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

    // Tear down any previous client first; its callbacks are muted by the
    // generation bump inside _destroyMqttClient().
    this._destroyMqttClient();
    this._mqttStopped = false;
    this._mqttToken = tokens.accessToken;

    this._mqttTopic = `/status/${did}/${uid}/${model}/${region}/`;
    this.log(`[mqtt] connecting to ${url} uid=${uid} topic=${this._mqttTopic}`);

    try {
      const generation = this._mqttGeneration;
      const client = mqtt.connect(url, {
        clientId,
        username: String(uid),
        password: tokens.accessToken,
        rejectUnauthorized: false,
        reconnectPeriod: 0,   // manual backoff below
        connectTimeout: 10000,
      });
      this._mqttClient = client;

      const isCurrent = () => generation === this._mqttGeneration;

      client.on('connect', () => {
        if (!isCurrent()) return;
        this._mqttFailCount = 0;
        this._mqttAuthRetried = false;
        this.log(`[mqtt] connected — subscribing to ${this._mqttTopic}`);
        client.subscribe(this._mqttTopic, (err) => {
          if (err) this.error('[mqtt] subscribe error:', err.message);
          else this.log('[mqtt] subscribed successfully');
        });
      });

      client.on('message', async (topic, message) => {
        if (!isCurrent()) return;
        try {
          await this._handleMqttMessage(topic, message);
        } catch (e) {
          this.error('[mqtt] message error:', e.message);
        }
      });

      client.on('error', (err) => {
        if (!isCurrent()) return;
        this.error('[mqtt] error:', err.message);
        if (this._isMqttAuthError(err)) this._mqttAuthFailed = true;
      });

      client.on('close', () => {
        if (!isCurrent() || this._mqttStopped) return; // superseded or intentional
        // Rejected credentials are not a network problem: retrying the same dead
        // token on a 30s→10min ladder only wastes the attempt budget. Refresh
        // once and reconnect immediately; only if that also fails do we back off.
        if (this._mqttAuthFailed && !this._mqttAuthRetried) {
          this._mqttAuthFailed = false;
          this._mqttAuthRetried = true;
          this.log('[mqtt] auth rejected — refreshing token and reconnecting');
          this._reconnectMqttWithFreshToken('auth_rejected');
          return;
        }
        this._mqttAuthFailed = false;
        this._mqttFailCount = (this._mqttFailCount || 0) + 1;
        if (this._mqttFailCount > 10) {
          this.log('[mqtt] too many failures — giving up');
          return;
        }
        // exponential backoff: 30s → 60s → 120s → … capped at 10 min
        const delay = Math.min(30000 * (2 ** (this._mqttFailCount - 1)), 600000);
        this.log(`[mqtt] connection closed — retry in ${delay / 1000}s (attempt ${this._mqttFailCount})`);
        this.homey.setTimeout(() => {
          if (!isCurrent() || this._mqttStopped) return;
          this._connectMqtt();
        }, delay);
      });
    } catch (e) {
      this.error('[mqtt] connect failed:', e.message);
    }
  }

  /** Force a refresh so the new client authenticates with a valid token. */
  async _reconnectMqttWithFreshToken(reason) {
    try {
      await this._api.forceTokenRefresh();
    } catch (e) {
      this.error('[mqtt] token refresh failed:', e.message);
    }
    if (this._mqttStopped) return;
    this.log(`[mqtt] reconnecting (${reason})`);
    this._connectMqtt();
  }

  /**
   * Called after the API rotated its tokens. An established session keeps
   * working — brokers only check credentials at CONNECT — so this does not
   * reconnect a healthy link; it only makes sure a *dropped* one comes back
   * with the current token instead of the one captured at app start.
   */
  onMqttTokenRotated() {
    if (!this._mqttClient || this._mqttStopped) return;
    const current = this._api.getTokens().accessToken;
    if (!current || current === this._mqttToken) return;
    this._mqttToken = current;
    if (this._mqttClient.connected) {
      this.log('[mqtt] token rotated — live session kept, next reconnect uses the new token');
      return;
    }
    this.log('[mqtt] token rotated while disconnected — reconnecting now');
    this._connectMqtt();
  }

  /** Drop the current client and mute every callback still referencing it. */
  _destroyMqttClient() {
    this._mqttGeneration = (this._mqttGeneration || 0) + 1;
    this._mqttAuthFailed = false;
    if (this._mqttClient) {
      try { this._mqttClient.end(true); } catch (_) { /* force-close errors are irrelevant */ }
      this._mqttClient = null;
    }
  }

  _disconnectMqtt() {
    if (!this._mqttClient) return;
    this._mqttStopped = true;
    this._destroyMqttClient();
    this.log('[mqtt] disconnected');
  }

  _decodeMowerBinaryState(value) {
    const buf = Array.isArray(value) ? Buffer.from(value) : null;
    if (!buf || buf.length < 20 || buf[0] !== 0xce || buf[19] !== 0xce) return null;

    const batteryByte = Number(buf[11]);
    const stateByte = Number(buf[14]);
    const dockingCode = (stateByte >> 2) & 0x07;
    const dockingNames = [
      'IN_STATION',
      'OUT_OF_STATION',
      'PAUSE_DOCKING',
      'FINISH_DOCKING',
      'DOCKING_FAILED',
      'DOCKING_IN_BASE',
    ];
    const signed8 = (v) => (v > 127 ? v - 256 : v);

    return {
      dockingCode,
      dockingState: dockingNames[dockingCode] || `UNKNOWN_${dockingCode}`,
      locationState: stateByte & 0x03,
      chargingLive: (batteryByte & 0x80) !== 0,
      batteryLive: batteryByte & 0x7f,
      pinState: (stateByte >> 5) & 0x01,
      undocking: (stateByte >> 6) & 0x01,
      cameraState: (stateByte >> 7) & 0x01,
      bleRssi: signed8(Number(buf[16])),
      wifiRssi: signed8(Number(buf[17])),
      lteRssi: signed8(Number(buf[18])),
      frameHex: buf.toString('hex'),
    };
  }

  _logMowerDockDiagnostic(reason, extra = null, force = false) {
    const d = this._mowerBinaryDiag;
    if (!d) {
      if (force) this.log(`[dockdiag] ${reason} | binary-state=not-seen-yet${extra ? ` | ${JSON.stringify(extra).substring(0, 240)}` : ''}`);
      return;
    }
    const age = this._mowerBinaryDiagAt ? Date.now() - this._mowerBinaryDiagAt : null;
    const nativeCode = this._latestNativeStatusCode ?? '-';
    const nativeName = Number.isFinite(Number(nativeCode)) ? (STATUS_MAP[Number(nativeCode)] || '-') : '-';
    const task = this._mqttTaskCandidate?.d || null;
    const livePos = this._livePos ? `${Math.round(this._livePos.x)},${Math.round(this._livePos.y)}` : '-';
    const detail = extra ? ` | extra=${JSON.stringify(extra).substring(0, 240)}` : '';
    this.log(`[dockdiag] ${reason} | dock=${d.dockingState}(${d.dockingCode}) loc=${d.locationState} undock=${d.undocking} charge=${d.chargingLive ? 1 : 0} batt=${d.batteryLive}% age=${age ?? '-'}ms native=${nativeCode}/${nativeName} task=${task ? JSON.stringify(task).substring(0, 100) : '-'} pos=${livePos}${detail}`);
  }

  async _handleMqttMessage(topic, message) {
    let parsed;
    try {
      parsed = JSON.parse(message.toString());
    } catch {
      this.log(`[mqtt] non-JSON message: ${message.toString().substring(0, 200)}`);
      return;
    }

    // Dreame/MOVA brokers have been observed with both envelope variants:
    //   { data: { method, params } }  and  { method, params }.
    // Accept both so live command/status interception does not depend on a
    // cloud-region-specific wrapper.
    const payload = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
    const method = payload?.method;
    const params = payload?.params;

    if (method === 'properties_changed' && Array.isArray(params)) {
      for (const prop of params) {
        if (prop.siid === 1 && prop.piid === 1) {
          const diag = this._decodeMowerBinaryState(prop.value);
          if (diag) {
            const prev = this._mowerBinaryDiag;
            this._mowerBinaryDiag = diag;
            this._mowerBinaryDiagAt = Date.now();
            this._garageSafety?.noteHomeDockTelemetry?.(diag);
            const changed = !prev
              || prev.dockingCode !== diag.dockingCode
              || prev.locationState !== diag.locationState
              || prev.undocking !== diag.undocking
              || prev.chargingLive !== diag.chargingLive
              || prev.pinState !== diag.pinState;
            if (changed) {
              const nowDiag = Date.now();
              const deltaMs = this._mowerBinaryDiagChangeAt ? nowDiag - this._mowerBinaryDiagChangeAt : null;
              this._mowerBinaryDiagChangeAt = nowDiag;
              this._mowerDockTraceSeq = Number(this._mowerDockTraceSeq || 0) + 1;
              this._logMowerDockDiagnostic('binary-state-change', {
                seq: this._mowerDockTraceSeq,
                deltaMs,
                from: prev ? {
                  dock: prev.dockingState,
                  loc: prev.locationState,
                  undock: prev.undocking,
                  charge: prev.chargingLive ? 1 : 0,
                  pin: prev.pinState,
                } : null,
                to: {
                  dock: diag.dockingState,
                  loc: diag.locationState,
                  undock: diag.undocking,
                  charge: diag.chargingLive ? 1 : 0,
                  pin: diag.pinState,
                },
                wifi: diag.wifiRssi,
                frame: diag.frameHex,
              }, true);
              if (this._garageSafety && typeof this._garageSafety.noteExternalRecoveryDockTelemetry === 'function') {
                this._garageSafety.noteExternalRecoveryDockTelemetry(diag, prev);
              }
            }

            // Earliest confirmed station-start edge seen in the A2 tests:
            // IN_STATION with undocking changing 0 -> 1. Trigger the garage
            // handshake immediately instead of waiting for TASK/native mowing,
            // which arrived later and was too slow for a narrow garage.
            const nativeUndockStarted = diag.dockingState === 'IN_STATION'
              && Number(diag.undocking) === 1
              && (!prev || Number(prev.undocking) !== 1 || prev.dockingState !== 'IN_STATION');
            if (nativeUndockStarted
              && this._garageSafety
              && typeof this._garageSafety.shouldInterceptExternalStartIntent === 'function'
              && this._garageSafety.shouldInterceptExternalStartIntent()
              && typeof this._garageSafety.onExternalStartIntent === 'function') {
              this._logMowerDockDiagnostic('native-undock-start-intercept', { source: 'mqtt_1_1' }, true);
              this._garageSafety.onExternalStartIntent('mqtt_native_undock_1_1', {
                dockingState: diag.dockingState,
                undocking: diag.undocking,
              }).catch((e) => this.error('[garage] native undock start intercept:', e.message));
            }
          } else {
            const raw = Array.isArray(prop.value) ? Buffer.from(prop.value).toString('hex').substring(0, 120) : JSON.stringify(prop.value)?.substring(0, 120);
            this.log(`[dockdiag] unsupported siid:1 piid:1 frame len=${Array.isArray(prop.value) ? prop.value.length : '-'} raw=${raw}`);
          }
        } else if (prop.siid === 1 && prop.piid === 4) {
          const val = prop.value;
          const buf = Array.isArray(val) ? Buffer.from(val) : null;
          if (buf && buf.length >= 6 && buf[0] === 0xce) {
            const x     = (buf[3] << 28 | buf[2] << 20 | buf[1] << 12) >> 12;
            const y     = (buf[5] << 24 | buf[4] << 16 | buf[3] << 8)  >> 12;
            const angle = buf.length > 6 ? Math.round(buf[6] / 255 * 360) : 0;
            const newPos = { x: x * 10, y: y * 10 };
            const moved = !this._livePos || Math.abs(newPos.x - this._livePos.x) > 50 || Math.abs(newPos.y - this._livePos.y) > 50;
            const acceptedLivePosition = this._setLivePosition(newPos, 'mqtt');
            if (acceptedLivePosition && this._garageSafety && typeof this._garageSafety.onRealtimeMaintenancePosition === 'function') {
              this._garageSafety.onRealtimeMaintenancePosition('mqtt')
                .catch((e) => this.error('[maintenance] mqtt realtime verification:', e.message));
            }
            if (moved) {
              this._mqttPosLogCounter = ((this._mqttPosLogCounter || 0) + 1) % 20;
              if (this._mqttPosLogCounter === 0) this.log(`[mqtt] pos: (${newPos.x}, ${newPos.y}) angle=${angle}°`);
              if (this._garageSafety && typeof this._garageSafety.updatePositionGuards === 'function') {
                this._garageSafety.updatePositionGuards().catch((e) => this.error('[garage] mqtt position guard:', e.message));
              }
            }
          } else {
            this.log(`[mqtt] siid:1 piid:4 value: ${JSON.stringify(val)?.substring(0, 200)}`);
          }
        } else if (prop.siid === 2 && prop.piid === 1) {
          // Live native state. Previously this was only logged and Homey waited
          // for the next HTTP poll. Feed it into the same status state machine
          // immediately so external start/return commands can be intercepted on
          // the MQTT push itself.
          const nativeCode = Number(prop.value);
          this.log(`[mqtt] status: ${prop.value}`);
          if (Number.isFinite(nativeCode) && STATUS_MAP[nativeCode]) {
            this._latestNativeStatusCode = nativeCode;
            const rawStatus = STATUS_MAP[nativeCode];
            const effectiveFaultCode = this._mqttErrorCode ?? 0;
            const mowerStatus = rawStatus === 'paused' && ERROR_DEVICE_CODES.has(effectiveFaultCode)
              ? 'error'
              : rawStatus;

            // If the original app starts mowing while the garage is still closed,
            // do not first publish that 'mowing' edge into the normal status state
            // machine. Launch the guarded garage intercept in the background; it
            // safety-pauses, opens the gate and owns the recovery sequence. This
            // adds no polling and does not block the MQTT receive loop.
            if (mowerStatus === 'mowing' || mowerStatus === 'returning' || mowerStatus === 'paused') {
              this._logMowerDockDiagnostic(`native-status-${mowerStatus}`, { nativeCode }, true);
            }
            if (mowerStatus === 'mowing' && this._mqttTaskCandidateAt) {
              const candidateAge = Date.now() - this._mqttTaskCandidateAt;
              if (candidateAge >= 0 && candidateAge < 15000) {
                this.log(`[mqtt] external-start correlation: TASK→native mowing ${candidateAge}ms`);
              }
            }
            const mqttResumeOutside = mowerStatus === 'mowing'
              ? await this._isOutsideGarageMissionResume(this._nativeMowerStatus)
              : false;
            if (mqttResumeOutside) {
              this._resumeGuardUntil = Math.max(Number(this._resumeGuardUntil || 0), Date.now() + 120000);
              this._resumeSemanticUntil = Math.max(Number(this._resumeSemanticUntil || 0), Date.now() + 120000);
              // A confirmed outside resume means the next command semantics are
              // Pause. This also lets _applyStatus reject stale cloud `paused`
              // packets that otherwise leave the Homey tile stuck on Pausiert.
              this._pauseButtonHoldMode = 'pause';
              this._pauseButtonHoldUntil = 0;
              this.log('[garage] MQTT mowing edge classified as outside mission resume; external-start intercept suppressed');
              this._garageSafety?.realtimeTimelineEvent?.('resume_outside', 'mqtt_status');
            }
            const shouldInterceptMowing = mowerStatus === 'mowing'
              && !mqttResumeOutside
              && this._garageSafety
              && typeof this._garageSafety.shouldInterceptExternalStartIntent === 'function'
              && this._garageSafety.shouldInterceptExternalStartIntent();
            if (shouldInterceptMowing && typeof this._garageSafety.onExternalStartIntent === 'function') {
              this._garageSafety.onExternalStartIntent('mqtt_status_2_1_mowing', { nativeCode })
                .catch((e) => this.error('[garage] mqtt status start intercept:', e.message));
              continue;
            }

            if (mowerStatus === 'returning' && this._garageSafety && typeof this._garageSafety.realtimeTimelineEvent === 'function') {
              this._garageSafety.realtimeTimelineEvent('return', 'mqtt_status');
            }
            await this._applyStatus(mowerStatus, effectiveFaultCode);
            await this._observeNativeMaintenanceArrival(nativeCode, mowerStatus, effectiveFaultCode)
              .catch((e) => this.error('[maintenance] mqtt native arrival observer:', e.message));
          }
        } else if (prop.siid === 2 && prop.piid === 2) {
          this.log(`[mqtt] error_code: ${prop.value}`);
          this._mqttErrorCode = prop.value;
        } else if (prop.siid === 2 && prop.piid === 50) {
          // 2:50 is a generic Dreame TASK descriptor, not a mowing-only event.
          // Current firmware also emits it for settings changes, so never pause
          // the mower from this property alone. Keep it only as lightweight
          // correlation/diagnostic data; 2:56 or live native status performs the
          // actual start interception.
          const value = prop.value;
          const task = value && typeof value === 'object' ? value.d : null;
          // Preserve start intent independently from TASK.status. On the A2 the
          // original vendor-app opcode can already arrive with status=false after
          // our emergency PAUSE, while it is still the only reliable distinction
          // between mowing/zone/edge/spot and maintenance (109).
          const taskOpcode = Number(task?.o);
          const restorableIntent = value?.t === 'TASK' && task?.exe === true
            && [100, 101, 102, 103, 109].includes(taskOpcode);
          if (restorableIntent) {
            this._mqttTaskIntentCandidateAt = Date.now();
            this._mqttTaskIntentCandidate = value;
            this.log(`[mqtt] restorable task intent candidate opcode=${taskOpcode} status=${task?.status === true ? 'true' : 'false'}`);
          }
          this._garageSafety?.noteExternalStartTask?.(value);
          const activeTask = value?.t === 'TASK' && task && task.status === true && task.exe === true;
          this.log(`[mqtt] scheduling_task: ${JSON.stringify(value)?.substring(0, 240)}`);
          if (activeTask) {
            this._mqttTaskCandidateAt = Date.now();
            this._mqttTaskCandidate = value;
            this._logMowerDockDiagnostic('task-active-2:50', value, true);
            // Keep TASK strictly as correlation/diagnostic data. Tests show that
            // opcodes here also represent return/maintenance/settings activity, so
            // it must never be the primary garage-start trigger. Native 1:1
            // undocking and, as a fallback, 2:56/native mowing own interception.
          }
        } else if (prop.siid === 2 && prop.piid === 56) {
          // Mower-control status is another push path used by current Dreame
          // firmware: [[zone,0]] means Continue/active, 4 Pause, 2 Complete and
          // -1 Queued. Treat Continue as a fallback early-start intent, guarded
          // inside GarageSafetyEngine so repeats during normal mowing are ignored.
          const value = prop.value;
          const statusArray = value && typeof value === 'object' && Array.isArray(value.status) ? value.status : [];
          const activeEntry = statusArray.find((entry) => Array.isArray(entry) && Number(entry[1]) === 0);
          this.log(`[mqtt] mower_control_status: ${JSON.stringify(value)?.substring(0, 240)}`);
          if (activeEntry) this._logMowerDockDiagnostic('control-active-2:56', value, true);
          if (activeEntry && this._garageSafety && typeof this._garageSafety.onExternalStartIntent === 'function') {
            const controlResumeOutside = await this._isOutsideGarageMissionResume(this._nativeMowerStatus);
            if (controlResumeOutside) {
              this._resumeGuardUntil = Math.max(Number(this._resumeGuardUntil || 0), Date.now() + 120000);
              this._resumeSemanticUntil = Math.max(Number(this._resumeSemanticUntil || 0), Date.now() + 120000);
              this._pauseButtonHoldMode = 'pause';
              this._pauseButtonHoldUntil = 0;
              this.log('[garage] MQTT control Continue classified as outside mission resume; gate remains unchanged');
              // 2:56 Continue is an immediate positive resume signal. Reflect it
              // on the tile now; subsequent stale `paused` telemetry is filtered
              // by the semantic latch above.
              await this._applyStatus('mowing', this._mqttErrorCode ?? 0);
              this._garageSafety?.realtimeTimelineEvent?.('resume_outside', 'mqtt_control');
            } else {
              if (this._mqttTaskCandidateAt) {
                const candidateAge = Date.now() - this._mqttTaskCandidateAt;
                if (candidateAge >= 0 && candidateAge < 15000) {
                  this.log(`[mqtt] external-start correlation: TASK→control 2:56 ${candidateAge}ms`);
                }
              }
              this._garageSafety.onExternalStartIntent('mqtt_control_2_56', value)
                .catch((e) => this.error('[garage] mqtt control start intent:', e.message));
            }
          }
        } else if (prop.siid === 2 && prop.piid === 57) {
          this.log(`[mqtt] power_state: ${prop.value}`);
          if (prop.value === 1) await this._applyStatus('standby', 0);
        }
      }
    } else if (method === 'event_occured' && Array.isArray(params)) {
      for (const event of params) {
        if (event.siid === 4 && event.eiid === 1) {
          const stopReason = event.arguments?.find((a) => a.piid === 1)?.value ?? event.value ?? '?';
          this.log(`[mqtt] mission_completion: stop_reason=${stopReason}`);
        } else {
          this.log(`[mqtt] event siid:${event.siid} eiid:${event.eiid}`);
        }
      }
    } else if (method === 'props' && params != null && typeof params === 'object') {
      const mqttProps = params;
      if ('ota_state' in mqttProps || 'ota_progress' in mqttProps) {
        this.log(`[mqtt] ota: state=${mqttProps.ota_state ?? '-'} progress=${mqttProps.ota_progress ?? '-'}%`);
      } else {
        this.log(`[mqtt] props: ${JSON.stringify(mqttProps).substring(0, 200)}`);
      }
    } else {
      this.log(`[mqtt] unhandled method=${method}`);
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

  _normalizeNativeForbiddenAreas(list) {
    if (!Array.isArray(list)) return [];
    // Do not guess the unit of arbitrary manufacturer circles. For a compact
    // center+radius representation, only expand it for rendering when it can be
    // tied unambiguously to one of Homey's pylon rules. The matcher below tries
    // raw-mm, cm×10 and native metres×1000, so this also avoids corrupting unrelated native
    // forbidden zones whose firmware representation may differ.
    let pylons = [];
    try { pylons = this._buildObstaclePylons(); } catch (_) {}
    return list.map((entry) => {
      const pair = Array.isArray(entry) && entry.length === 2 && entry[1] && typeof entry[1] === 'object';
      const id = pair ? entry[0] : entry?.id;
      const area = pair ? entry[1] : entry;
      if (!area || typeof area !== 'object') return entry;
      const shape = Number(area.shapeType ?? area.shape ?? area.type);
      if (shape !== 3 || (Array.isArray(area.path) && area.path.length >= 8)) return entry;

      const candidates = pylons.map((pylon) => {
        const radiusMm = Number(pylon?.rule?.radius);
        if (!Number.isFinite(radiusMm) || radiusMm <= 0) return null;
        const metrics = this._nativeCircleMatchMetrics(area, pylon, radiusMm);
        return metrics?.matched ? { pylon, radiusMm, metrics } : null;
      }).filter(Boolean);
      if (candidates.length !== 1) return entry;

      const { metrics } = candidates[0];
      const first = Array.isArray(area.points) ? area.points[0] : null;
      const cx = Array.isArray(first) ? Number(first[0]) : Number(first?.x);
      const cy = Array.isArray(first) ? Number(first[1]) : Number(first?.y);
      const radius = Number(area.radius ?? area.r);
      if (![cx, cy, radius].every(Number.isFinite) || radius <= 0) return entry;
      const scale = Number(metrics.scale || 1);
      const centerX = cx * scale, centerY = cy * scale, radiusMm = radius * scale;
      const path = Array.from({ length: 32 }, (_, i) => {
        const a = 2 * Math.PI * i / 32;
        return { x: centerX + radiusMm * Math.cos(a), y: centerY + radiusMm * Math.sin(a) };
      });
      const normalized = {
        ...area, shapeType: 3, path,
        nativeCircleCenter: { x: cx, y: cy }, nativeCircleRadius: radius,
        nativeCircleScale: scale,
      };
      return pair ? [id, normalized] : normalized;
    });
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
    const forbiddenAreas = this._normalizeNativeForbiddenAreas(
      this._asArrayMaybe(mapObj.forbiddenAreas || mapObj.noGoAreas || mapObj.no_mop || mapObj.virtualWalls),
    );
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
    // The mower command remains on the confirmed native point index 1, while the
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
      // Keep the raw native marker separate from the stable display marker. A
      // transient map response may omit it; the UI must continue to show the last
      // verified point while this raw field remains available for change detection.
      nativeMaintenancePointRaw: maintenancePoint ? { ...maintenancePoint, source: 'native_map_original' } : null,
      maintenancePoint: maintenancePoint ? { ...maintenancePoint, source: 'native_map_original' } : null,
      maintenanceObservationId: `${Date.now()}:${this._maintenanceMapObservationSeq = (this._maintenanceMapObservationSeq || 0) + 1}`,
      mapRawKeys:     Object.keys(mapObj),
      mapTrSample:    mapObj.tr ? String(mapObj.tr).slice(0, 300) : null,
      livePath:       this._cachedMapData?.livePath || [],
    };
  }

  /**
   * Parse the mower-native JSON returned by the A2 MAPI/MAPD app-action path.
   *
   * This is deliberately separate from _parseMapDataChunks(): MAPD is a direct
   * mower read and uses the compact Dreame app-map schema (`map`, `spot`, ...),
   * while MAP.N is the cloud-side double-encoded Homey map schema.  For native
   * create/delete verification we only need the authoritative forbidden-zone
   * geometry; keep the already validated cloud/base lawn geometry for the UI so
   * this readback fix cannot perturb route/safety rendering.
   */
  _parseAppActionMapPayload(snapshot, baseMap = this._cachedMapData) {
    const payload = snapshot?.payload ?? snapshot;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const records = payload.map;
    if (!Array.isArray(records)) return null;

    const modelId = String(this._devModel
      || (typeof this.getSetting === 'function' ? (this.getSetting('device_model_id') || this.getSetting('device_model')) : '')
      || '');
    const isRealG2408 = /g2408/i.test(modelId);

    const rawPoints = (item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];

      // Real g2408 MAPD captures (2026-10-02) store native type-2 zone identity
      // on the outer payload.map[] record, but put the polygon one level deeper:
      //   { id: 103, type: 2, description: { type: 2, points: [[x,y], ...] } }
      // Older/public A2 fixtures place the polygon directly in `data`. Keep both
      // families; direct `points` is accepted for compatibility with compact
      // nested records, while the authoritative id still comes from the outer
      // record selected by isNativeForbiddenObject().
      const source = Array.isArray(item.data)
        ? item.data
        : (Array.isArray(item.points)
          ? item.points
          : (Array.isArray(item.description?.points) ? item.description.points : null));
      if (!Array.isArray(source)) return [];
      return source.map((pt) => Array.isArray(pt)
        ? [Number(pt[0]), Number(pt[1])]
        : [Number(pt?.x), Number(pt?.y)])
        .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
    };
    const isPathway = (item) => {
      if (!item || typeof item !== 'object') return false;
      const id = Number(item.id);
      return Number(item.type) === 1 || (Number.isInteger(id) && id >= 200 && id < 300);
    };
    const isNativeForbiddenObject = (item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const id = Number(item.id);
      return Number.isInteger(id) && id >= 100 && Number(item.type) === 2 && rawPoints(item).length >= 3;
    };

    // Build lawn geometry only from the documented payload.map family. A native
    // restriction that happened to be found elsewhere must never become a lawn.
    const lawnRaw = records.filter((item) => !isNativeForbiddenObject(item) && !isPathway(item) && rawPoints(item).length >= 3);

    // 1.2.44 field correction: on the real dreame.mower.g2408, payload.map[] is
    // itself the authoritative native map object list. The 1.2.43 parser finally
    // decoded description.points, but then still discarded every top-level type-2
    // object that was not already witnessed by stale cloud MAP.*. That is why the
    // Dreame app showed five red zones while Homey rendered only three and kept
    // two pylons Pending. For this measured model we therefore validate the whole
    // top-level family structurally and, when complete, trust ALL of it.
    const topLevelDeclared = records
      .map((item, index) => ({ item, path:`$.map[${index}]` }))
      .filter(({ item }) => item && typeof item === 'object' && !Array.isArray(item)
        && Number.isInteger(Number(item.id)) && Number(item.id) >= 100 && Number(item.type) === 2);
    const topLevelMalformedIds = topLevelDeclared
      .filter(({ item }) => rawPoints(item).length < 3)
      .map(({ item }) => Number(item.id)).sort((a,b)=>a-b);
    const topLevelValid = topLevelDeclared.filter(({ item }) => rawPoints(item).length >= 3);
    const topLevelIdCounts = new Map();
    for (const { item } of topLevelValid) {
      const id = Number(item.id);
      topLevelIdCounts.set(id, Number(topLevelIdCounts.get(id) || 0) + 1);
    }
    const topLevelDuplicateIds = [...topLevelIdCounts.entries()]
      .filter(([, count]) => count > 1).map(([id]) => id).sort((a,b)=>a-b);
    const g2408TopLevelAuthoritative = isRealG2408
      && lawnRaw.length > 0
      && topLevelMalformedIds.length === 0
      && topLevelDuplicateIds.length === 0;

    // Keep the recursive scanner for older/public A2 payload families where the
    // restriction record may live outside payload.map. It is fallback-only on a
    // real g2408 once the measured top-level schema passes the checks above.
    const recursiveCandidateRecords = [];
    const visit = (value, path = '$', depth = 0) => {
      if (depth > 10 || value == null) return;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) visit(value[i], `${path}[${i}]`, depth + 1);
        return;
      }
      if (typeof value !== 'object') return;
      if (isNativeForbiddenObject(value)) recursiveCandidateRecords.push({ item:value, path });
      for (const [key, child] of Object.entries(value)) {
        if (key === 'data' && isNativeForbiddenObject(value)) continue;
        visit(child, `${path}.${key}`, depth + 1);
      }
    };
    visit(payload);

    const candidateRecords = g2408TopLevelAuthoritative ? topLevelValid : recursiveCandidateRecords;

    // One native id must identify one current polygon. Duplicate appearances of
    // the same id are ambiguous evidence in fallback schemas. The strict g2408
    // top-level family already rejects duplicates before reaching this point.
    const candidateById = new Map();
    const duplicateCandidateIds = new Set();
    for (const rec of candidateRecords) {
      const id = Number(rec.item.id);
      if (candidateById.has(id)) duplicateCandidateIds.add(id);
      else candidateById.set(id, rec);
    }
    const forbiddenRaw = [...candidateById.values()].map((rec) => rec.item);
    const candidateIds = [...candidateById.keys()].sort((a, b) => a - b);
    const candidatePaths = [...candidateById.values()].map((rec) => rec.path);
    // A verified compact snapshot may still be useful for restriction readback
    // when the lawn itself is retained from the already validated cloud map.
    if (!lawnRaw.length && !(baseMap?.boundary && Array.isArray(baseMap?.mowingAreas) && baseMap.mowingAreas.length)) return null;

    const bboxCenter = (pts, scale = 1) => {
      if (!Array.isArray(pts) || !pts.length) return null;
      const xs = pts.map((p) => Number(p[0]) * scale);
      const ys = pts.map((p) => Number(p[1]) * scale);
      if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return null;
      return { x:(Math.min(...xs) + Math.max(...xs)) / 2, y:(Math.min(...ys) + Math.max(...ys)) / 2 };
    };
    const nativeAreaCenter = (area) => {
      const source = Array.isArray(area?.path) ? area.path : Array.isArray(area?.points) ? area.points : [];
      const pts = source.map((pt) => Array.isArray(pt)
        ? [Number(pt[0]), Number(pt[1])]
        : [Number(pt?.x), Number(pt?.y)])
        .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
      return bboxCenter(pts, 1);
    };

    // MAPD coordinates on the current A2 are centimetre-like map units (x10
    // gives the millimetre coordinate system used by the Homey renderer and
    // pylon rules). Calibrate against any still-existing native id from the
    // previously validated map when possible.
    let scale = 10;
    const baseById = new Map();
    for (const entry of (Array.isArray(baseMap?.forbiddenAreas) ? baseMap.forbiddenAreas : [])) {
      const id = Number(Array.isArray(entry) ? entry[0] : entry?.id);
      const area = Array.isArray(entry) ? entry[1] : entry;
      const center = nativeAreaCenter(area);
      if (Number.isInteger(id) && center) baseById.set(id, { center, area });
    }
    const scaleScores = [1, 10, 1000].map((candidate) => {
      let total = 0, count = 0;
      for (const item of forbiddenRaw) {
        const id = Number(item.id);
        const known = baseById.get(id)?.center;
        const direct = bboxCenter(rawPoints(item), candidate);
        if (!known || !direct) continue;
        total += Math.hypot(direct.x - known.x, direct.y - known.y);
        count++;
      }
      return { candidate, count, score: count ? total / count : Number.POSITIVE_INFINITY };
    }).filter((entry) => entry.count > 0).sort((a, b) => a.score - b.score);
    if (scaleScores.length && Number.isFinite(scaleScores[0].score)) scale = scaleScores[0].candidate;

    const toPath = (item) => rawPoints(item).map(([x, y]) => ({ x:x * scale, y:y * scale }));
    const directForbiddenAreas = forbiddenRaw.map((item) => {
      const id = Number(item.id);
      return [id, {
        id,
        type: 2,
        shapeType: 2,
        path: toPath(item),
        nativeMapdType: Number(item.type),
        nativeMapdScale: scale,
      }];
    });

    // Safety rule for direct MAPD authority: a compact-map parser is only
    // allowed to replace the current forbidden-zone set if every unrelated
    // native id that was present in the last complete cloud map is still found.
    // During a Homey delete the exact ids currently being deleted are exempt;
    // all other Dreame/Homey zones MUST survive. This prevents the 1.2.38
    // regression where one delete turned an unrecognised MAPD payload into an
    // authoritative empty list and visually removed every native zone.
    const baseIds = [...baseById.keys()].sort((a, b) => a - b);
    const pendingDeleteIds = new Set();
    for (const rule of Object.values(this._obstacleRulesCache || {})) {
      if (!rule || rule.pending !== 'delete') continue;
      const ruleMap = Number(rule.mapIndex);
      if (Number.isInteger(ruleMap) && ruleMap !== Number(this._activeMapIndex)) continue;
      const ids = Array.isArray(rule.pendingDeleteIds) && rule.pendingDeleteIds.length
        ? rule.pendingDeleteIds : (Array.isArray(rule.nativeMatchIds) && rule.nativeMatchIds.length
          ? rule.nativeMatchIds : [rule.nativeId]);
      for (const id of ids) if (Number.isInteger(Number(id))) pendingDeleteIds.add(Number(id));
    }
    // Direct red-zone deletes are tracked outside obstacle_rules_v1 so the
    // original manufacturer zone never becomes Homey-owned. They are still the
    // *intended* missing ids for this verification pass and therefore must be
    // exempt from the 1.2.39 unrelated-zone preservation guard. Without this, a
    // perfectly correct MAPD snapshot after deleting native #103 is rejected
    // precisely because #103 is gone, forcing Homey back to stale cloud MAP.*.
    if (this._directNativeDeleteUi instanceof Map) {
      for (const [nativeId, op] of this._directNativeDeleteUi.entries()) {
        if (Number(op?.mapIndex) !== Number(this._activeMapIndex)) continue;
        if (Number.isInteger(Number(nativeId))) pendingDeleteIds.add(Number(nativeId));
      }
    }
    const requiredBaseIds = baseIds.filter((id) => !pendingDeleteIds.has(id));
    const missingBaseIds = requiredBaseIds.filter((id) => !candidateById.has(id));
    const ambiguousIds = [...duplicateCandidateIds].sort((a, b) => a - b);

    // Do not trust a type=2/id>=100 record merely because the number exists.
    // The public A2 MAPD research proves the transport/schema shape, but does not
    // independently prove that every such record is a no-go area. Use the cloud-
    // established native ids AND their geometry as witnesses. A semantic mismatch
    // therefore cannot replace the known forbidden set or confirm a delete.
    const directAreaById = new Map(directForbiddenAreas.map((entry) => [Number(entry[0]), entry[1]]));

    // A Homey Save with an already-owned nativeId is an in-place o=215 update,
    // not a new object. Its geometry is EXPECTED to differ from the cloud/base
    // snapshot (for example radius 60 cm -> 100 cm) while retaining the same
    // native id. 1.2.41 accidentally classified exactly that intended geometry
    // change as a semantic mismatch and therefore rejected the otherwise valid
    // MAPD snapshot, forcing confirmation back to lagging cloud MAP.*. Build the
    // expected update set first and trust such a changed base id only when its
    // direct geometry matches the pending pylon/radius exactly.
    const verificationPylons = this._buildObstaclePylons();
    const pendingUpdatedIds = new Set();
    const pendingUpdateClaims = new Map();
    for (const [ruleId, rule] of Object.entries(this._obstacleRulesCache || {})) {
      if (!rule || rule.pending !== 'create' || Number(rule.mapIndex) !== Number(this._activeMapIndex)) continue;
      const nativeId = Number(rule.nativeId);
      if (!Number.isInteger(nativeId) || nativeId <= 0 || !candidateById.has(nativeId)) continue;
      const pylon = this._findPylonForRule(ruleId, rule, verificationPylons);
      const directArea = directAreaById.get(nativeId);
      if (!pylon || !directArea || !this._nativePylonZoneMatches(directArea, pylon, rule)) continue;
      pendingUpdateClaims.set(nativeId, Number(pendingUpdateClaims.get(nativeId) || 0) + 1);
      pendingUpdatedIds.add(nativeId);
    }
    // Multiple pending Homey rules claiming the same native id are ambiguous;
    // never let that condition become direct MAPD authority.
    for (const [nativeId, count] of pendingUpdateClaims.entries()) {
      if (count > 1) pendingUpdatedIds.delete(nativeId);
    }

    const mismatchedBaseIds = [];
    const matchedBaseIds = [];
    for (const id of requiredBaseIds) {
      if (!candidateById.has(id)) continue;
      if (pendingUpdatedIds.has(id)) continue; // changed geometry is the validated pending update target
      const baseArea = baseById.get(id)?.area;
      const directArea = directAreaById.get(id);
      const baseIdent = this._nativeZoneLabelIdentity(id, baseArea, this._activeMapIndex);
      const directIdent = this._nativeZoneLabelIdentity(id, directArea, this._activeMapIndex);
      if (baseIdent && directIdent && this._nativeZoneLabelDescriptorMatches(baseIdent, directIdent)) matchedBaseIds.push(id);
      else mismatchedBaseIds.push(id);
    }

    // New Homey-created zones have no cloud-established id yet. They become a
    // trusted MAPD witness only when exactly one new type-2 polygon matches the
    // pending square geometry. Unknown extra type-2 records are never promoted
    // to Homey forbidden areas solely from MAPD.
    const pendingCreateIds = new Set();
    for (const [ruleId, rule] of Object.entries(this._obstacleRulesCache || {})) {
      if (!rule || rule.pending !== 'create' || Number(rule.mapIndex) !== Number(this._activeMapIndex)) continue;
      const pylon = this._findPylonForRule(ruleId, rule, verificationPylons);
      if (!pylon) continue;
      const beforeIds = new Set(Array.isArray(rule.beforeIds) ? rule.beforeIds.map(Number) : []);
      const matches = directForbiddenAreas.filter(([id, area]) => !beforeIds.has(Number(id))
        && this._nativePylonZoneMatches(area, pylon, rule));
      const candidateId = Number(rule.nativeCandidateId);
      const preferred = Number.isInteger(candidateId) ? matches.find(([id]) => Number(id) === candidateId) : null;
      const chosen = preferred || (matches.length === 1 ? matches[0] : null);
      if (chosen) pendingCreateIds.add(Number(chosen[0]));
    }

    const trustedIds = g2408TopLevelAuthoritative
      ? new Set(candidateIds)
      : new Set([...matchedBaseIds, ...pendingUpdatedIds, ...pendingCreateIds]);
    const trustedDirectForbiddenAreas = directForbiddenAreas.filter(([id]) => trustedIds.has(Number(id)));
    // On the measured g2408, a transport-stable, structurally complete top-level
    // map[] is current mower truth, including unknown new zones and even an empty
    // restriction set after deleting the last zone. Older schemas retain the
    // conservative cloud-witness guard.
    const geometryVerified = g2408TopLevelAuthoritative
      ? true
      : (trustedIds.size > 0
        && missingBaseIds.length === 0
        && mismatchedBaseIds.length === 0
        && ambiguousIds.length === 0);

    const directMowingAreas = lawnRaw.map((item, index) => {
      const rawId = item?.id;
      const id = Number.isInteger(Number(rawId)) && Number(rawId) > 0 ? Number(rawId) : index + 1;
      return [id, { id, path:toPath(item), area:item?.area ?? null, type:item?.type ?? null }];
    });
    const mowingAreas = Array.isArray(baseMap?.mowingAreas) && baseMap.mowingAreas.length
      ? baseMap.mowingAreas : directMowingAreas;
    const spotAreas = Array.isArray(baseMap?.spotAreas) ? baseMap.spotAreas : [];
    const contours = Array.isArray(baseMap?.contours) ? baseMap.contours : [];
    const forbiddenAreas = geometryVerified
      ? trustedDirectForbiddenAreas
      : (Array.isArray(baseMap?.forbiddenAreas) ? baseMap.forbiddenAreas : []);
    const boundary = baseMap?.boundary || this._normalizeBoundary(null, [directMowingAreas, forbiddenAreas]);
    if (!boundary || !mowingAreas.length) return null;

    const hash = typeof snapshot?.hash === 'string' ? snapshot.hash : null;
    return {
      ...(baseMap && typeof baseMap === 'object' ? baseMap : {}),
      boundary,
      name: payload.name || baseMap?.name || `Map ${this._activeMapIndex + 1}`,
      md5sum: geometryVerified && hash ? `mapd_${hash}` : (baseMap?.md5sum || `mapd_unverified_${Date.now()}`),
      mowingAreas,
      forbiddenAreas,
      spotAreas,
      contours,
      mapObstacles: Array.isArray(baseMap?.mapObstacles) ? baseMap.mapObstacles : [],
      chargerPos: baseMap?.chargerPos || this._dockPos || null,
      nativeMaintenancePointRaw: baseMap?.nativeMaintenancePointRaw || null,
      maintenancePoint: baseMap?.maintenancePoint || null,
      livePath: baseMap?.livePath || [],
      mapRawKeys: Object.keys(payload),
      directMapdTransportVerified: true,
      directMapdGeometryVerified: geometryVerified,
      directMapdVerified: geometryVerified,
      directMapdMapIndex: Number.isInteger(Number(snapshot?.idx)) ? Number(snapshot.idx) : Number(this._activeMapIndex),
      directMapdScale: scale,
      directMapdHash: hash,
      directMapdSize: Number(snapshot?.size) || null,
      directMapdChunks: Number(snapshot?.chunkCount) || null,
      directMapdCandidateIds: candidateIds,
      directMapdCandidatePaths: candidatePaths,
      directMapdMissingBaseIds: missingBaseIds,
      directMapdMismatchedBaseIds: mismatchedBaseIds,
      directMapdMatchedBaseIds: matchedBaseIds,
      directMapdPendingUpdatedIds: [...pendingUpdatedIds].sort((a, b) => a - b),
      directMapdPendingCreateIds: [...pendingCreateIds].sort((a, b) => a - b),
      directMapdTrustedIds: [...trustedIds].sort((a, b) => a - b),
      directMapdAmbiguousIds: ambiguousIds,
      directMapdBaseIds: baseIds,
      directMapdPendingDeleteIds: [...pendingDeleteIds].sort((a, b) => a - b),
      directMapdAuthority: g2408TopLevelAuthoritative ? 'g2408_top_level_map' : 'legacy_witness_guard',
      directMapdModelId: modelId || null,
      directMapdTopLevelDeclaredIds: topLevelDeclared.map(({item}) => Number(item.id)).sort((a,b)=>a-b),
      directMapdTopLevelMalformedIds: topLevelMalformedIds,
      directMapdTopLevelDuplicateIds: topLevelDuplicateIds,
    };
  }

  _nativeForbiddenGeometryEquivalent(a, b) {
    const rows = (list) => (Array.isArray(list) ? list : []).map((entry) => ({
      id: Number(Array.isArray(entry) ? entry[0] : entry?.id),
      area: Array.isArray(entry) ? entry[1] : entry,
    })).filter((entry) => Number.isInteger(entry.id) && entry.id > 0 && entry.area);
    const left = rows(a), right = rows(b);
    if (left.length !== right.length) return false;
    for (const item of left) {
      const other = right.find((candidate) => candidate.id === item.id);
      if (!other) return false;
      const li = this._nativeZoneLabelIdentity(item.id, item.area, this._activeMapIndex);
      const ri = this._nativeZoneLabelIdentity(other.id, other.area, this._activeMapIndex);
      if (!li || !ri) return false;
      if (!this._nativeZoneLabelDescriptorMatches({ ...li }, ri)) return false;
    }
    return true;
  }

  async _migrateMaintenancePointSchema() {
    const schemaVersion = 6;
    const markerKey = 'garage_maintenance_point_schema_version';
    const currentVersion = Number(await safeGetStoreValue(this, markerKey)) || 0;
    if (currentVersion >= schemaVersion) return;

    const asPoint = (value, source = 'legacy-migration') => {
      if (!value) return null;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (_) {
          const m = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;| ]\s*(-?\d+(?:\.\d+)?)\s*$/);
          if (!m) return null;
          value = { x: Number(m[1]), y: Number(m[2]) };
        }
      }
      if (Array.isArray(value)) value = { x: value[0], y: value[1] };
      if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return null;
      return { ...value, x: Number(value.x), y: Number(value.y), source: value.source || source };
    };

    // Released 1.1.3x versions (schema v2) stored the point in the *_v2 keys —
    // those installs are in the field and must keep their verified point across
    // this upgrade. The physically verified point outranks the map-observed one.
    // The plain unversioned keys are pre-v2 legacy and checked last.
    const legacyAuthorityKeys = [
      'garage_maintenance_point_verified_v2',
      'garage_maintenance_point_native_v2',
      'garage_maintenance_point',
      'maintenance_point',
    ];
    let recovered = asPoint(await safeGetStoreValue(this, 'garage_maintenance_authority'), 'maintenance-authority');
    let recoveredKey = recovered ? 'garage_maintenance_authority' : null;
    if (!recovered) {
      for (const key of legacyAuthorityKeys) {
        const point = asPoint(await safeGetStoreValue(this, key), key);
        if (point) { recovered = point; recoveredKey = key; break; }
      }
    }

    if (recovered) {
      const now = Date.now();
      const authority = {
        ...recovered,
        source: recovered.source || 'migration',
        verifiedBy: recovered.verifiedBy || `schema_v6_recovered:${recoveredKey}`,
        authorityKind: recovered.authorityKind || 'migrated_verified',
        authorityReason: recovered.authorityReason || `schema_v6_recovered:${recoveredKey}`,
        mapKey: this._maintenanceMapKey(),
        schemaVersion,
        confirmedAt: Number(recovered.confirmedAt || recovered.savedAt) || now,
        savedAt: now,
      };
      await this.setStoreValue('garage_maintenance_authority', authority);
      await this.setStoreValue('garage_maintenance_point', authority);
      this.log(`[maintenance] schema v${schemaVersion}: preserved ${recoveredKey} at ${Math.round(authority.x)},${Math.round(authority.y)}`);
    }

    // Remove obsolete transient keys after the one-time import. The *_v2 keys
    // have been imported into garage_maintenance_authority above and are no
    // longer read by any code path.
    const obsoleteKeys = [
      'garage_maintenance_point_last_valid',
      'garage_maintenance_point_candidate',
      'garage_maintenance_point_lock',
      'garage_maintenance_point_verified_v2',
      'garage_maintenance_point_native_v2',
    ];
    for (const key of obsoleteKeys) {
      try {
        if (typeof this.unsetStoreValue === 'function') await this.unsetStoreValue(key);
        else await this.setStoreValue(key, null);
      } catch (err) {
        this.error(`[maintenance] unable to clear obsolete key ${key}:`, err.message);
      }
    }
    this._maintenancePointCandidate = null;
    await this.setStoreValue(markerKey, schemaVersion);
  }


  _maintenanceMapKey() {
    // The map checksum changes when the original app edits map metadata, including
    // the maintenance point itself. Binding the marker to that checksum made a
    // valid point disappear exactly after such an edit. Device store is already
    // scoped per mower, so active map index is the stable identity required here.
    return `map:${Number(this._activeMapIndex) || 0}`;
  }

  async _resolveStableMaintenancePoint() {
    const schemaVersion = 6;
    const mapKey = this._maintenanceMapKey();
    const asPoint = (v, fallbackSource = 'stored') => {
      if (!v) return null;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return null; } }
      if (Array.isArray(v)) v = { x: v[0], y: v[1] };
      if (!v || !Number.isFinite(Number(v.x)) || !Number.isFinite(Number(v.y))) return null;
      return { ...v, x: Number(v.x), y: Number(v.y), source: String(v.source || fallbackSource) };
    };
    const distance = (a, b) => a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity;
    const normalize = (p, extra = {}) => p ? ({
      ...p, ...extra, mapKey, schemaVersion, savedAt: Number(p.savedAt) || Date.now(),
    }) : null;
    const showStable = (point) => {
      if (point && this._cachedMapData) this._cachedMapData.maintenancePoint = { ...point };
      return point;
    };

    // Maintenance authority model:
    // - opcode 109/index 1 is authoritative for the target identity inside the mower;
    // - a confirmed native arrival is authoritative for its physical coordinate;
    // - a native map marker becomes authoritative only after independent confirmation;
    // - a manual point is an explicit fallback and is never erased by a missing map packet.
    let authority = asPoint(await safeGetStoreValue(this, 'garage_maintenance_authority'), 'maintenance-authority');
    if (!authority) {
      // Compatibility mirror only; schema migration normally imports this first.
      authority = asPoint(await safeGetStoreValue(this, 'garage_maintenance_point'), 'maintenance-point-mirror');
      if (authority) {
        authority = normalize(authority, {
          authorityKind: authority.authorityKind || 'migrated_verified',
          authorityReason: authority.authorityReason || 'mirror_recovery',
          confirmedAt: Number(authority.confirmedAt || authority.savedAt) || Date.now(),
        });
        await this.setStoreValue('garage_maintenance_authority', authority).catch(() => {});
      }
    }

    const native = asPoint(this._cachedMapData?.nativeMaintenancePointRaw, 'native-map-raw');
    if (!native) {
      // A partial/empty map response is never evidence that the point was deleted.
      return authority ? showStable(normalize(authority)) : null;
    }

    const nativeStable = normalize(native, { source: 'native-map', verifiedBy: 'native_map_observation' });
    const observationId = String(this._cachedMapData?.maintenanceObservationId || this._cachedMapData?.md5sum || 'unknown');
    const now = Date.now();

    // Keep the previously observed raw native marker as the change baseline.
    // A physically confirmed/manual authority must not be replaced merely because
    // the same stale native marker is returned twice after a map refresh.
    const previousRaw = asPoint(await safeGetStoreValue(this, 'garage_maintenance_raw_marker'), 'native-raw-marker');
    const rawMarkerActuallyChanged = previousRaw ? distance(previousRaw, nativeStable) > 350 : false;
    await this.setStoreValue('garage_maintenance_raw_marker', {
      ...nativeStable, lastObservationId: observationId, observedAt: now,
    }).catch(() => {});

    // Small map drift cannot displace a physically/manual confirmed authority.
    if (authority && distance(authority, nativeStable) <= 350) {
      if (String(authority.authorityKind || '').startsWith('native_map')) {
        authority = normalize(nativeStable, {
          authorityKind: 'native_map_confirmed',
          authorityReason: 'native_map_small_correction',
          confirmedAt: Number(authority.confirmedAt) || now,
        });
        await this.setStoreValue('garage_maintenance_authority', authority).catch(() => {});
        await this.setStoreValue('garage_maintenance_point', authority).catch(() => {});
      }
      await this.unsetStoreValue?.('garage_maintenance_candidate').catch(() => {});
      return showStable(normalize(authority));
    }

    // A physically confirmed or manual authority may only be displaced after the
    // original app's *raw* marker itself has genuinely moved. If no prior raw
    // baseline exists, record this observation as the baseline and keep the
    // stronger authority. This prevents a stale native marker from pulling the
    // point back after a successful physical calibration.
    const authorityKind = String(authority?.authorityKind || '');
    const authorityIsStrongerThanMap = authority && !authorityKind.startsWith('native_map');
    let candidate = asPoint(await safeGetStoreValue(this, 'garage_maintenance_candidate'), 'native-candidate');
    const continuingChangedMarkerCandidate = candidate
      && candidate.mapKey === mapKey
      && now - Number(candidate.firstAt || 0) <= 5 * 60 * 1000
      && distance(candidate, nativeStable) <= 300;
    if (authorityIsStrongerThanMap
        && !continuingChangedMarkerCandidate
        && (!previousRaw || !rawMarkerActuallyChanged)) {
      await this.unsetStoreValue?.('garage_maintenance_candidate').catch(() => {});
      this._maintenancePointCandidate = null;
      return showStable(normalize(authority));
    }

    // New or substantially changed original-app marker: require two independent
    // complete map observations. The old authority remains visible and usable meanwhile.
    const sameCandidate = candidate
      && candidate.mapKey === mapKey
      && now - Number(candidate.firstAt || 0) <= 5 * 60 * 1000
      && distance(candidate, nativeStable) <= 300;
    const independent = !sameCandidate || String(candidate.lastObservationId || '') !== observationId;
    if (!sameCandidate) {
      candidate = {
        ...nativeStable, source: 'native-candidate', mapKey, schemaVersion,
        hits: 1, firstAt: now, lastAt: now, lastObservationId: observationId,
      };
    } else if (independent) {
      candidate = {
        ...candidate, x: nativeStable.x, y: nativeStable.y,
        hits: Number(candidate.hits || 1) + 1, lastAt: now, lastObservationId: observationId,
      };
    }
    await this.setStoreValue('garage_maintenance_candidate', candidate).catch(() => {});
    this._maintenancePointCandidate = candidate;

    if (Number(candidate.hits || 0) >= 2) {
      const confirmed = normalize(nativeStable, {
        source: 'native-map', verifiedBy: 'native_map_sync_confirmed',
        authorityKind: 'native_map_confirmed',
        authorityReason: authority ? 'original_app_point_changed' : 'original_app_point_discovered',
        confirmedAt: now,
      });
      await this.setStoreValue('garage_maintenance_authority', confirmed).catch(() => {});
      await this.setStoreValue('garage_maintenance_point', confirmed).catch(() => {});
      await this.unsetStoreValue?.('garage_maintenance_candidate').catch(() => {});
      this._maintenancePointCandidate = null;
      this.log(`[maintenance] authority changed to confirmed original-app marker: ${Math.round(confirmed.x)},${Math.round(confirmed.y)} ${mapKey}`);
      return showStable(confirmed);
    }

    return authority ? showStable(normalize(authority)) : null;
  }

  async _storeVerifiedMaintenancePoint(position, source = 'native_maintenance_arrival') {
    if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) return null;
    const sourceText = String(source || 'native_maintenance_arrival');
    // A firmware-confirmed/native-command arrival is the strongest available
    // coordinate authority. The mower itself owns the native index-1 target;
    // Homey only learns its physical coordinate from the confirmed arrival.
    const nativeArrivalConfirmed = /native_status_75|native_command_arrival|explicit_native_maintenance_arrival|maintenance_arrival_nearby_realign|maintenance_arrival_initial_set/.test(sourceText);
    const authorityKind = nativeArrivalConfirmed
      ? 'native_arrival_confirmed'
      : (/manual_current_position|map_editor/.test(sourceText) ? 'manual_fallback' : 'physically_verified');
    const now = Date.now();
    const stable = {
      x: Number(position.x), y: Number(position.y), source: 'verified',
      verifiedBy: sourceText, authorityKind, authorityReason: sourceText,
      mapKey: this._maintenanceMapKey(), schemaVersion: 6,
      confirmedAt: now, savedAt: now,
    };
    this._maintenancePointCandidate = null;
    await this.setStoreValue('garage_maintenance_authority', stable).catch(() => {});

    // Preserve only the actual raw original-app marker as comparison baseline.
    // Never copy the stable display marker here, because it may already be the
    // learned physical coordinate and would hide a later real app-side change.
    const rawNative = this._cachedMapData?.nativeMaintenancePointRaw;
    if (rawNative && Number.isFinite(Number(rawNative.x)) && Number.isFinite(Number(rawNative.y))) {
      await this.setStoreValue('garage_maintenance_raw_marker', {
        x: Number(rawNative.x), y: Number(rawNative.y), source: 'native-map-raw',
        observedAt: now, mapKey: this._maintenanceMapKey(), schemaVersion: 6,
      }).catch(() => {});
    }

    await this.unsetStoreValue?.('garage_maintenance_candidate').catch(() => {});
    await this.setStoreValue('garage_maintenance_point', stable).catch(() => {});
    if (this._cachedMapData) this._cachedMapData.maintenancePoint = { ...stable };
    this.log(`[maintenance] authority set: kind=${authorityKind} reason=${sourceText} point=${Math.round(stable.x)},${Math.round(stable.y)}`);
    return stable;
  }


  async _commitPendingNativeMaintenanceArrival() {
    const pending = this._pendingNativeMaintenanceArrival;
    if (!pending || Date.now() > Number(pending.expiresAt || 0)) {
      this._pendingNativeMaintenanceArrival = null;
      return false;
    }

    const live = typeof this._getBufferedLivePosition === 'function'
      ? this._getBufferedLivePosition(20000)
      : this._livePos;
    if (!live || !Number.isFinite(Number(live.x)) || !Number.isFinite(Number(live.y))) return false;

    const liveTs = Number(live.ts || this._lastLivePosAt || 0);
    // The final position packet may arrive shortly before or shortly after status
    // 75. Reject genuinely old coordinates, but accept the normal cloud ordering.
    if (!liveTs || liveTs < Number(pending.at || 0) - 12000 || Date.now() - liveTs > 20000) return false;

    const observationKey = `${Math.round(Number(live.x) / 50)}:${Math.round(Number(live.y) / 50)}`;
    if (this._nativeMaintenanceArrivalLatched === observationKey) {
      this._pendingNativeMaintenanceArrival = null;
      return true;
    }

    // A completed native maintenance command proves ARRIVAL, not a new target
    // coordinate. The original-app/native maintenance marker stays authoritative
    // when it already exists. This matters because the robot may stop a few cm
    // beside the marker and older code slowly moved the saved target to the wheel
    // position on every successful trip. Only first discovery may learn a point.
    const stablePoint = typeof this._resolveStableMaintenancePoint === 'function'
      ? await this._resolveStableMaintenancePoint().catch(() => null)
      : null;
    let confirmedTarget = stablePoint;
    if (!confirmedTarget) {
      confirmedTarget = await this._storeVerifiedMaintenancePoint(
        { x: Math.round(Number(live.x)), y: Math.round(Number(live.y)) },
        'maintenance_arrival_initial_set',
      );
      if (!confirmedTarget) return false;
      if (this._cachedMapData) this._cachedMapData.maintenancePoint = { ...confirmedTarget };
      this.log(`[maintenance] initial native maintenance point learned at ${confirmedTarget.x},${confirmedTarget.y} (${pending.reason})`);
    } else {
      const distance = Math.hypot(Number(live.x) - Number(confirmedTarget.x), Number(live.y) - Number(confirmedTarget.y));
      this.log(`[maintenance] native arrival confirmed; preserving existing point ${Math.round(confirmedTarget.x)},${Math.round(confirmedTarget.y)} distance=${Math.round(distance)}mm (${pending.reason})`);
    }

    this._nativeMaintenanceArrivalLatched = observationKey;
    this._pendingNativeMaintenanceArrival = null;
    this._nativeMaintenanceStableArrival = null;
    this._nativeMaintenanceCommandAt = 0;
    this._maintenancePointCandidate = null;
    // Complete the active garage maintenance journey immediately. Geometry still
    // decides whether a status/error-code hint is allowed to reach this path.
    if (this._garageSafety && typeof this._garageSafety.confirmNativeMaintenanceArrival === 'function') {
      await this._garageSafety.confirmNativeMaintenanceArrival(
        pending.reason || 'native_command_arrival',
        { x: Number(live.x), y: Number(live.y), ts: liveTs },
      ).catch((e) => this.error('[maintenance] garage arrival confirmation:', e.message));
    }
    return true;
  }

  async _observeNativeMaintenanceArrival(rawStatusCode, effectiveStatus = '', faultCode = 0) {
    // Status 75 (MAINTENANCE_PAUSED) is useful firmware evidence, but it is
    // committed immediately only when fresh geometry also matches the known target. Some A2/cloud combinations only expose a generic
    // paused/standby state after opcode 109. That fallback is deliberately more
    // conservative: two independent, fault-free observations with a stable fresh
    // position are required, so an immediate command rejection or transient pause
    // cannot overwrite the valid maintenance point.
    const now = Date.now();
    const raw75 = Number(rawStatusCode) === 75;
    // On the measured A2, a successful maintenance-point arrival can also be
    // emitted as device/error code 75 while native status becomes idle (2). It is
    // therefore not treated as a generic fault during a recent opcode-109 task.
    // Just like raw status 75, code 75 is only accepted with target geometry.
    const maintenanceCode75 = Number(faultCode) === 75;
    const status = String(effectiveStatus || '').toLowerCase();
    const commandAge = this._nativeMaintenanceCommandAt
      ? now - Number(this._nativeMaintenanceCommandAt)
      : Number.POSITIVE_INFINITY;
    const recentNativeCommand = commandAge >= 0 && commandAge <= 3 * 60 * 1000;
    const commandHadTimeToStart = commandAge >= 5000;
    const noFault = Number(faultCode || 0) === 0;

    const activeMaintenanceContext = !!(this._garageSafety?.isReturnCycleActive?.()
      && (this._garageSafety?._returnContext === 'MAINTENANCE'
        || this._garageSafety?._manualMaintenanceTransit
        || String(this._garageSafety?.lastRequestedAction || '').toLowerCase().includes('maintenance')));
    const raw75GeometryCandidate = raw75 && noFault && (recentNativeCommand || activeMaintenanceContext);
    const code75GeometryCandidate = maintenanceCode75 && (recentNativeCommand || activeMaintenanceContext);
    if (raw75GeometryCandidate || code75GeometryCandidate) {
      const live = typeof this._getBufferedLivePosition === 'function'
        ? this._getBufferedLivePosition(15000)
        : this._livePos;
      const stablePoint = typeof this._resolveStableMaintenancePoint === 'function'
        ? await this._resolveStableMaintenancePoint().catch(() => null)
        : null;
      if (stablePoint && live && Number.isFinite(Number(live.x)) && Number.isFinite(Number(live.y))) {
        const distance = Math.hypot(Number(live.x) - Number(stablePoint.x), Number(live.y) - Number(stablePoint.y));
        if (!Number.isFinite(distance) || distance > 700) {
          this._nativeMaintenanceStableArrival = null;
          this.log(`[maintenance] native ${raw75 ? 'status' : 'code'} 75 ignored outside target radius distance=${Number.isFinite(distance) ? Math.round(distance) : 'unknown'}mm`);
          // Code 75 is not promoted to a real fault during an active maintenance
          // trip, but it also cannot complete the trip from the wrong location.
          return false;
        }
        this._nativeMaintenanceStableArrival = null;
        this._pendingNativeMaintenanceArrival = {
          at: now,
          expiresAt: now + 45000,
          reason: raw75 ? 'native_status_75_geometry_confirmed' : 'native_code_75_geometry_confirmed',
        };
        return this._commitPendingNativeMaintenanceArrival();
      }
      // Without a known point, a 75 signal is only a candidate. Let the stable
      // paused/standby fallback below require independent position proof.
    }

    const fallbackState = status === 'paused' || status === 'standby';
    const effectiveNoFault = noFault || (maintenanceCode75 && (recentNativeCommand || activeMaintenanceContext));
    if (!recentNativeCommand || !commandHadTimeToStart || !fallbackState || !effectiveNoFault) {
      if (!recentNativeCommand) {
        this._nativeMaintenanceArrivalLatched = false;
        this._nativeMaintenanceStableArrival = null;
      } else if (!effectiveNoFault || status === 'error') {
        // A genuine red/error response after opcode 109 is a failed task, never
        // arrival. A2 code 75 is excluded here while maintenance context is live.
        this._nativeMaintenanceStableArrival = null;
        this._pendingNativeMaintenanceArrival = null;
        this._nativeMaintenanceCommandAt = 0;
      }
      return false;
    }

    const live = typeof this._getBufferedLivePosition === 'function'
      ? this._getBufferedLivePosition(15000)
      : this._livePos;
    if (!live || !Number.isFinite(Number(live.x)) || !Number.isFinite(Number(live.y))) return false;
    const liveTs = Number(live.ts || this._lastLivePosAt || 0);
    if (!liveTs || now - liveTs > 15000 || liveTs < Number(this._nativeMaintenanceCommandAt) - 12000) return false;

    // Generic paused/standby after opcode 109 is not arrival proof by itself.
    // The mower can remain physically stationary after an accepted command (the
    // exact field failure fixed in 1.1.95). Require either proven departure from
    // the command-start position or proximity to the already verified native
    // maintenance point. Raw firmware status 75 remains authoritative above.
    let departureOrTargetProof = false;
    if (this._garageSafety && typeof this._garageSafety._maintenanceMovedEnough === 'function') {
      departureOrTargetProof = !!this._garageSafety._maintenanceMovedEnough();
    }
    if (!departureOrTargetProof && typeof this._resolveStableMaintenancePoint === 'function') {
      const stablePoint = await this._resolveStableMaintenancePoint().catch(() => null);
      if (stablePoint) {
        const distance = Math.hypot(Number(live.x) - Number(stablePoint.x), Number(live.y) - Number(stablePoint.y));
        departureOrTargetProof = Number.isFinite(distance) && distance <= 700;
      }
    }
    if (!departureOrTargetProof) {
      this._nativeMaintenanceStableArrival = null;
      this.log('[maintenance] generic paused/standby not accepted as arrival without movement/target proof');
      return false;
    }

    const previous = this._nativeMaintenanceStableArrival;
    const sameState = previous && previous.phase === 'stationary';
    const independent = previous
      && now - Number(previous.firstAt || 0) >= 4000
      && Number(liveTs) > Number(previous.liveTs || 0);
    const withinWindow = previous && now - Number(previous.firstAt || 0) <= 45000;
    const stablePosition = previous
      && Math.hypot(Number(live.x) - Number(previous.x), Number(live.y) - Number(previous.y)) <= 350;

    if (sameState && independent && withinWindow && stablePosition) {
      this._nativeMaintenanceStableArrival = null;
      this._pendingNativeMaintenanceArrival = {
        at: now,
        expiresAt: now + 45000,
        reason: `native_command_arrival_stable_${status}`,
      };
      this.log(`[maintenance] stable ${status} after native command confirmed at ${Math.round(Number(live.x))},${Math.round(Number(live.y))}`);
      return this._commitPendingNativeMaintenanceArrival();
    }

    // Start/restart the confirmation window. Repeated processing of the same poll
    // does not count because the second observation must be at least four seconds
    // later and carry a fresh accepted position timestamp.
    if (!previous || !sameState || !withinWindow || !stablePosition) {
      this._nativeMaintenanceStableArrival = {
        phase: 'stationary',
        status,
        x: Number(live.x),
        y: Number(live.y),
        liveTs,
        firstAt: now,
        observedAt: now,
      };
      this.log(`[maintenance] stable-arrival candidate: ${status} at ${Math.round(Number(live.x))},${Math.round(Number(live.y))}`);
    }
    return false;
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
    const persistedRoute = this._durableRoute?.path(this._activeMapIndex) || this._completedMapRoute?.path || [];
    const points = [robot, this._dockPos, persistedRoute, this._cachedMapData?.livePath,
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
      livePath: persistedRoute.length ? persistedRoute : (this._cachedMapData?.livePath || []),
      robotPos: robot ? [robot.x, robot.y] : null,
      obstaclePylons: this._buildObstaclePylons(),
      mapSafeMowing: this.getSetting('map_safe_mowing') === true,
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
    const mapEnvelope = this._joinNativeMapChunks(raw);
    if (!mapEnvelope.text) return null;
    if (!mapEnvelope.complete) {
      this.log('[map] MAP.* chunk set incomplete',
        `available=${mapEnvelope.availableLength}`, `expected=${mapEnvelope.expectedLength}`,
        `chunks=${mapEnvelope.chunkCount}`);
      return null;
    }

    let mapObj = null;
    try {
      // Some firmware appends extra data after the closing ] of the outer array.
      // Walk the string character-by-character to find where the first top-level
      // JSON array actually ends, then truncate before passing to JSON.parse.
      let combined = mapEnvelope.text;
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

    // ── ARMap binary → extract robot + charger position ───────────────────
    {
      const arRaw = mapObj.ARMap;
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
      forbiddenAreas: this._normalizeNativeForbiddenAreas(mapObj.forbiddenAreas?.value || []),
      spotAreas:      mapObj.spotAreas?.value      || [],
      contours:       mapObj.contours?.value       || [],
      mapObstacles,
      chargerPos,
      mapRawKeys:     Object.keys(mapObj),
      mapTrSample:    mapObj.tr ? String(mapObj.tr).slice(0, 300) : null,
      livePath,
    };
  }

  // Lightweight variant of _parseMapDataChunks used when MAP chunks are unchanged.
  // Re-parses only M_PATH (live mowing trail) and returns a minimal object compatible
  // with the merge logic in _detectAndSyncZones.  Returns null when no M_PATH exists.
  _parseLivePathOnly(raw) {
    const pathParts = [];
    for (let i = 0; raw[`M_PATH.${i}`] != null; i++) pathParts.push(raw[`M_PATH.${i}`]);
    if (!pathParts.length) return null;

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
    const JUMP_SQ = 3000 * 3000;
    const allPts = [];
    let prevReal = null;
    for (const pt of rawPts) {
      if (pt[0] === 32767) { allPts.push(pt); prevReal = null; }
      else {
        if (prevReal !== null) {
          const dx = pt[0] - prevReal[0], dy = pt[1] - prevReal[1];
          if (dx * dx + dy * dy > JUMP_SQ) allPts.push([32767, -32768]);
        }
        allPts.push(pt); prevReal = pt;
      }
    }
    const realCount = allPts.filter((p) => p[0] !== 32767).length;
    const step = realCount > 800 ? Math.ceil(realCount / 800) : 1;
    let ri = 0, lastRealIdx = -1;
    for (let i = allPts.length - 1; i >= 0; i--) { if (allPts[i][0] !== 32767) { lastRealIdx = i; break; } }
    const livePath = [];
    for (let i = 0; i < allPts.length; i++) {
      const pt = allPts[i];
      if (pt[0] === 32767 && pt[1] === -32768) { livePath.push(pt); continue; }
      if (ri++ % step === 0 || i === lastRealIdx) livePath.push(pt);
    }

    return { md5sum: this._cachedMapData?.md5sum ?? '', livePath, chargerPos: this._dockPos ?? null };
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
      await this._storeVerifiedMaintenancePoint(maintenancePoint, 'map_editor');
    }

    if (this._garageSafety?.markers?.resetRuntime) this._garageSafety.markers.resetRuntime();
    if (typeof this._garageSafety?.refreshOverlay === 'function') await this._garageSafety.refreshOverlay().catch(() => {});
    if (typeof this._garageSafety?.updateMarkerDiagnosis === 'function') await this._garageSafety.updateMarkerDiagnosis().catch(() => {});
    if (typeof this._garageSafety?.updatePositionGuards === 'function') await this._garageSafety.updatePositionGuards().catch(() => {});

    this.log('[map-editor] garage markers saved', { lineA, lineB, dangerCenter, maintenancePoint });
    return { ok: true, lineA, lineB, dangerCenter, maintenancePoint };
  }

  _obsPolygonEntries(value) {
    value = this._obstaclePayloadObject(value);
    const candidates = [];
    const walk = (v, depth = 0) => {
      if (depth > 5 || v == null) return;
      v = this._obstaclePayloadObject(v);
      if (Array.isArray(v)) {
        for (const item of v) walk(item, depth + 1);
        return;
      }
      if (typeof v !== 'object') return;
      if (Array.isArray(v.data)
          && v.data.length >= 2
          && v.data.every((pt) => Array.isArray(pt) && Number.isFinite(Number(pt[0])) && Number.isFinite(Number(pt[1])))) {
        candidates.push(v);
      }
      // Prefer known Dreame containers, but still recurse because firmware
      // variants wrap OBS differently (obs/data/result/out).
      for (const [k, child] of Object.entries(v)) {
        if (/photo|image|base64|thumbnail/i.test(k)) continue;
        if (child && (typeof child === 'object' || typeof child === 'string')) walk(child, depth + 1);
      }
    };
    walk(value);
    const byId = new Map();
    for (const item of candidates) {
      const id = item?.id ?? item?.obs_id ?? item?.obstacle_id ?? item?.index ?? item?.idx;
      const key = id != null ? `id:${String(id)}` : JSON.stringify(item.data);
      if (!byId.has(key)) byId.set(key, item);
    }
    return [...byId.values()];
  }

  _knownA2ObstacleFallback(activeMap) {
    // Last verified non-empty OBS payload received from this paired A2. It is
    // only a cold-start safety net for the g2408's map 0 until Dreame returns
    // OBS again; every later non-empty live payload replaces and persists it.
    if (Number(activeMap) !== 0 || !/g2408/i.test(String(this._devModel || ''))) return null;
    return { idx: 0, obstacle: [
      { data: [[-328,-55],[-338,-65],[-353,-50]], id: 1, type: 0 },
      { data: [[-208,-40],[-178,-10],[-113,-10],[-138,-25],[-148,-55],[-128,-65],[-113,-45],[-63,-60],[-53,-80],[-98,-85],[-128,-70],[-173,-85],[-178,-65]], id: 2, type: 0 },
      { data: [[-608,-45],[-568,-30],[-458,-30],[-428,-65],[-438,-80],[-488,-60],[-533,-85],[-593,-85]], id: 3, type: 0 },
      { data: [[-778,-100],[-798,-75],[-788,-60]], id: 4, type: 0 },
      { data: [[-673,-230],[-683,-210],[-668,-215]], id: 5, type: 0 },
      { data: [[-773,-260],[-783,-250],[-778,-205],[-768,-205],[-763,-230]], id: 6, type: 0 },
      { data: [[-758,-310],[-763,-295],[-743,-285],[-743,-305]], id: 7, type: 0 },
      { data: [[-558,-385],[-583,-350],[-568,-325],[-578,-200],[-523,-200],[-508,-230],[-518,-260],[-508,-380]], id: 8, type: 0 },
    ] };
  }

  async _refreshObstacleTelemetry(did, reason = 'poll') {
    if (!this._api || this._obsFetchInFlight || this._pylonNativeWriteBusy) return false;
    this._obsFetchInFlight = true;
    try {
      const active = Number.isFinite(Number(this._activeMapIndex)) ? Number(this._activeMapIndex) : 0;
      // A2 firmware has been observed to expose persistent problem markers on
      // OBS idx=1 even while the visible/current map is idx=0. Query both 0/1
      // and select the payload with the most explicit OBS polygons. This is
      // read-only and runs on the existing slow cadence / map-open refresh.
      const obsIndexes = [...new Set([active, 0, 1])];
      const requests = [
        this._api.getAIOBS(did, { idx: active }),
        ...obsIndexes.map((idx) => this._api.getOBS(did, { idx })),
      ];
      const results = await Promise.allSettled(requests);
      const aiobs = results[0].status === 'fulfilled' ? results[0].value : null;
      let chosenObs = null, chosenIdx = null, chosenCount = -1;
      const obsDiag = [];
      for (let i = 0; i < obsIndexes.length; i++) {
        const r = results[i + 1];
        const value = r.status === 'fulfilled' ? r.value : null;
        const entries = this._obsPolygonEntries(value);
        obsDiag.push({ idx: obsIndexes[i], ok: r.status === 'fulfilled', polygons: entries.length, present: value != null });
        if (entries.length > chosenCount || (entries.length === chosenCount && obsIndexes[i] === active)) {
          chosenCount = entries.length;
          chosenObs = value;
          chosenIdx = obsIndexes[i];
        }
      }
      if (aiobs === null && chosenObs === null) {
        this.log('[pylon-diag] obstacle refresh failed', { reason, activeMap: active, obs: obsDiag });
        return false;
      }

      const incoming = { aiobs, obs: chosenObs, obsIndex: chosenIdx };
      const incomingPylons = (() => {
        const previous = this._cachedObstacles;
        this._cachedObstacles = incoming;
        const value = this._buildObstaclePylons();
        this._cachedObstacles = previous;
        return value;
      })();
      const cachedPylons = this._buildObstaclePylons();
      // OBS is occasionally returned as an empty array while mowing although
      // the persistent warning polygons still exist in the Dreame map. Never
      // erase a known non-empty set merely because of that transient reply.
      if (!incomingPylons.length && cachedPylons.length) {
        this._obstacleDiagUpdatedAt = Date.now();
        this.log(`[pylon-diag] empty OBS reply ignored; retaining ${cachedPylons.length} cached pylons reason=${reason}`);
        return true;
      }

      if (!incomingPylons.length && !cachedPylons.length) {
        const fallback = this._knownA2ObstacleFallback(active);
        if (fallback) {
          this._cachedObstacles = { aiobs, obs: fallback, obsIndex: 0 };
          this._obstacleDiagUpdatedAt = Date.now();
          await Promise.resolve(this.setStoreValue('obstacle_payload_cache_v1', this._cachedObstacles)).catch(() => {});
          this.log('[pylon-diag] empty OBS reply; restored 8 last-known A2 pylons and persisted cache');
          return true;
        }
      }

      this._cachedObstacles = incoming;
      if (incomingPylons.length) {
        await Promise.resolve(this.setStoreValue('obstacle_payload_cache_v1', incoming)).catch(() => {});
      }
      this._obstacleDiagUpdatedAt = Date.now();
      const pylons = this._buildObstaclePylons();
      const signature = JSON.stringify({ aiobs, obs: chosenObs, obsIndex: chosenIdx });
      if (signature !== this._obstacleDiagSignature) {
        this._obstacleDiagSignature = signature;
        this.log(`[pylon-diag] obstacle payload changed activeMap=${active} selectedObsIdx=${chosenIdx} obsPolygons=${chosenCount} pylons=${pylons.length} reason=${reason}`);
        this.log('[pylon-diag] OBS index scan:', JSON.stringify(obsDiag));
        this.log('[pylon-diag] AIOBS:', JSON.stringify(aiobs)?.slice(0, 1400));
        this.log('[pylon-diag] OBS:', JSON.stringify(chosenObs)?.slice(0, 2400));
        if (pylons.length) this.log('[pylon-diag] normalized:', JSON.stringify(pylons.slice(0, 20))?.slice(0, 3200));
      } else if (reason === 'map-open') {
        this.log(`[pylon-diag] map-open cache selectedObsIdx=${chosenIdx} obsPolygons=${chosenCount} pylons=${pylons.length}`);
      }
      return true;
    } finally {
      this._obsFetchInFlight = false;
    }
  }

  _obstaclePayloadObject(value) {
    if (value == null) return value;
    if (typeof value === 'string') {
      const t = value.trim();
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { return this._obstaclePayloadObject(JSON.parse(t)); } catch (_) { return value; }
      }
    }
    return value;
  }

  _obstacleCoordinateFromObject(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const pairs = [
      [obj.x, obj.y], [obj.px, obj.py], [obj.pos_x, obj.pos_y], [obj.posX, obj.posY],
      [obj.longitude_x, obj.latitude_y],
      [obj.position?.x, obj.position?.y], [obj.pos?.x, obj.pos?.y], [obj.point?.x, obj.point?.y],
    ];
    for (const [x0, y0] of pairs) {
      const x = Number(x0), y = Number(y0);
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    }
    if (Array.isArray(obj.position) && Number.isFinite(Number(obj.position[0])) && Number.isFinite(Number(obj.position[1]))) {
      return { x: Number(obj.position[0]), y: Number(obj.position[1]) };
    }
    if (Array.isArray(obj.pos) && Number.isFinite(Number(obj.pos[0])) && Number.isFinite(Number(obj.pos[1]))) {
      return { x: Number(obj.pos[0]), y: Number(obj.pos[1]) };
    }
    // A2 OBS payloads can encode one persistent problem/obstacle as a polygon:
    // { id, type, data: [[x,y], ...] }. Use the polygon centroid as the
    // clickable Homey pylon position while keeping the original shape untouched.
    if (Array.isArray(obj.data)) {
      const pts = obj.data
        .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
        .map((p) => ({ x: Number(p[0]), y: Number(p[1]) }));
      if (pts.length) {
        let area2 = 0, cx6a = 0, cy6a = 0;
        if (pts.length >= 3) {
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            const cross = a.x * b.y - b.x * a.y;
            area2 += cross;
            cx6a += (a.x + b.x) * cross;
            cy6a += (a.y + b.y) * cross;
          }
        }
        if (Math.abs(area2) > 1e-9) {
          return { x: cx6a / (3 * area2), y: cy6a / (3 * area2), polygon: pts };
        }
        return {
          x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
          y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
          polygon: pts,
        };
      }
    }
    return null;
  }

  _obstacleCoordinateToMap(point, source = '') {
    if (!point) return null;

    // Persistent A2 OBS polygons use the same native x10 coordinate conversion
    // as M_PATH/MAP geometry. Do not use the old boundary heuristic here:
    // small raw OBS coordinates can still fall inside a large mm boundary and
    // would then be rendered clustered near the garage.
    if (source === 'obs') {
      return { x: Number(point.x) * 10, y: Number(point.y) * 10, scale: 10, transform: 'obs_native_x10' };
    }

    const b = this._cachedMapData?.boundary;
    const inside = (x, y, pad = 2500) => !b || (
      x >= Number(b.x1) - pad && x <= Number(b.x2) + pad
      && y >= Number(b.y1) - pad && y <= Number(b.y2) + pad
    );
    if (inside(point.x, point.y)) return { x: point.x, y: point.y, scale: 1, transform: 'as_is' };
    if (inside(point.x * 10, point.y * 10)) return { x: point.x * 10, y: point.y * 10, scale: 10, transform: 'heuristic_x10' };
    return { x: point.x, y: point.y, scale: 1, transform: 'uncertain', uncertainScale: true };
  }

  _nativeZoneLabelIdentity(nativeId, area, mapIndex = this._activeMapIndex) {
    const id = Number(nativeId);
    const map = Number.isInteger(Number(mapIndex)) ? Number(mapIndex) : 0;
    const source = Array.isArray(area?.path) ? area.path
      : Array.isArray(area?.points) ? area.points
        : Array.isArray(area?.polygon) ? area.polygon : [];
    const pts = source.map((pt) => Array.isArray(pt)
      ? { x:Number(pt[0]), y:Number(pt[1]) }
      : { x:Number(pt?.x), y:Number(pt?.y) })
      .filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
    if (!Number.isInteger(id) || id <= 0 || pts.length < 3) return null;
    const xs = pts.map((pt) => pt.x), ys = pts.map((pt) => pt.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const q = (value) => Math.round(Number(value) / 50) * 50;
    const centerX = q((minX + maxX) / 2), centerY = q((minY + maxY) / 2);
    const width = q(maxX - minX), height = q(maxY - minY);
    let twiceArea = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      twiceArea += (a.x * b.y) - (b.x * a.y);
    }
    // sqrt(area) keeps the shape-size discriminator in millimetre-like units,
    // making the same tolerance meaningful for both small and large zones.
    const areaScale = q(Math.sqrt(Math.abs(twiceArea) / 2));
    const shape = Number(this._nativeForbiddenShape(area) ?? 0);
    const pointCount = pts.length;
    const key = `map:${map}|id:${id}|shape:${shape}|c:${centerX},${centerY}|s:${width},${height}|a:${areaScale}|p:${pointCount}`;
    return { key, mapIndex:map, nativeId:id, shape, centerX, centerY, width, height, areaScale, pointCount };
  }

  _nativeZoneLabelDescriptorMatches(entry, ident) {
    if (!entry || !ident) return false;
    if (Number(entry.mapIndex) !== ident.mapIndex || Number(entry.nativeId) !== ident.nativeId) return false;
    if (Number.isFinite(Number(entry.shape)) && Number(entry.shape) !== Number(ident.shape)) return false;
    const dc = Math.hypot(Number(entry.centerX) - ident.centerX, Number(entry.centerY) - ident.centerY);
    const ds = Math.max(Math.abs(Number(entry.width) - ident.width), Math.abs(Number(entry.height) - ident.height));
    const oldArea = Number(entry.areaScale);
    const da = Number.isFinite(oldArea) ? Math.abs(oldArea - ident.areaScale) : 0; // v1 compatibility
    return Number.isFinite(dc) && Number.isFinite(ds) && Number.isFinite(da)
      && dc <= 125 && ds <= 125 && da <= 175;
  }

  _nativeZoneLabelFor(nativeId, area, mapIndex = this._activeMapIndex) {
    const ident = this._nativeZoneLabelIdentity(nativeId, area, mapIndex);
    if (!ident) return null;
    const labels = this._nativeZoneLabelsCache && typeof this._nativeZoneLabelsCache === 'object'
      ? this._nativeZoneLabelsCache : {};
    const exact = labels[ident.key];
    if (exact && String(exact.note || '').trim()) return { ...exact, key:ident.key };
    // Small parser/rounding changes must not make a user label disappear, but a
    // reused native id at a different place/shape must never inherit it. If more
    // than one stored geometry is equally plausible, refuse automatic adoption.
    const candidates = [];
    for (const [key, entry] of Object.entries(labels)) {
      if (!this._nativeZoneLabelDescriptorMatches(entry, ident)) continue;
      const dc = Math.hypot(Number(entry.centerX) - ident.centerX, Number(entry.centerY) - ident.centerY);
      const ds = Math.max(Math.abs(Number(entry.width) - ident.width), Math.abs(Number(entry.height) - ident.height));
      const da = Number.isFinite(Number(entry.areaScale)) ? Math.abs(Number(entry.areaScale) - ident.areaScale) : 0;
      candidates.push({ ...entry, key, score:dc + ds + da });
    }
    candidates.sort((a,b) => a.score - b.score);
    if (!candidates.length || !String(candidates[0].note || '').trim()) return null;
    if (candidates.length > 1 && Math.abs(candidates[1].score - candidates[0].score) < 25) return null;
    return candidates[0];
  }

  _matchingPylonRulesForNativeArea(nativeId, area, mapIndex = this._activeMapIndex) {
    const id = Number(nativeId);
    const map = Number(mapIndex);
    const shape = this._nativeForbiddenShape(area);
    const rules = this._obstacleRulesCache && typeof this._obstacleRulesCache === 'object'
      ? this._obstacleRulesCache : {};
    const matches = [];
    for (const [ruleId, rule] of Object.entries(rules)) {
      if (!rule || Number(rule.mapIndex) !== map) continue;
      const ids = new Set(Array.isArray(rule.nativeMatchIds) ? rule.nativeMatchIds.map(Number) : []);
      if (Number.isInteger(Number(rule.nativeId))) ids.add(Number(rule.nativeId));
      if (!ids.has(id)) continue;
      const pylon = { x:Number(rule.centerX), y:Number(rule.centerY) };
      const radius = Number(rule.radius);
      if (![pylon.x, pylon.y, radius].every(Number.isFinite) || radius <= 0) continue;
      const geometricallySame = shape === 2
        ? this._nativeSquareMatchesPylon(area, pylon, radius)
        : shape === 3 ? this._nativeCircleMatchesPylon(area, pylon, radius) : false;
      if (geometricallySame) matches.push({ ruleId, rule });
    }
    return matches;
  }

  _nativeZoneLabelsForMap(map = this._cachedMapData) {
    if (!map || !Array.isArray(map.forbiddenAreas)) return [];
    const out = [];
    for (const entry of map.forbiddenAreas) {
      const id = Number(Array.isArray(entry) ? entry[0] : entry?.id);
      const area = Array.isArray(entry) ? entry[1] : entry;
      const local = this._nativeZoneLabelFor(id, area, this._activeMapIndex);
      let note = local ? String(local.note || '').slice(0,120) : '';
      let updatedAt = Number(local?.updatedAt || 0);
      if (!note) {
        const policy = this._nativeZonePolicyFor(id, area, this._activeMapIndex);
        if (policy && String(policy.note || '').trim()) {
          note = String(policy.note || '').trim().slice(0,120);
          updatedAt = Number(policy.updatedAt || 0);
        }
      }
      if (!note) {
        // Only bridge a pylon note when exactly one Homey rule matches this same
        // native id AND its current native geometry. Native id alone is unsafe
        // because Dreame may recycle ids after a delete/recreate cycle.
        const matches = this._matchingPylonRulesForNativeArea(id, area, this._activeMapIndex)
          .filter(({ rule }) => String(rule?.note || '').trim());
        if (matches.length === 1) {
          const rule = matches[0].rule;
          note = String(rule.note || '').trim().slice(0,120);
          updatedAt = Number(rule.updatedAt || 0);
        }
      }
      if (!note) continue;
      out.push({ nativeId:id, note, updatedAt });
    }
    return out;
  }

  async _setNativeZoneLabel(body = {}) {
    const nativeId = Number(body.nativeZoneId);
    if (!Number.isInteger(nativeId) || nativeId <= 0) throw new Error('Ungültige native Sperrzonen-ID.');
    const mapIndex = Number(this._activeMapIndex);
    if (!Number.isInteger(mapIndex) || mapIndex < 0) throw new Error('Aktive Karte unbekannt.');
    const entry = (this._cachedMapData?.forbiddenAreas || []).find((e) =>
      Number(Array.isArray(e) ? e[0] : e?.id) === nativeId);
    if (!entry) throw new Error(`Native Sperrzone #${nativeId} ist in der aktuellen Mäherkarte nicht mehr vorhanden.`);
    const area = Array.isArray(entry) ? entry[1] : entry;
    const ident = this._nativeZoneLabelIdentity(nativeId, area, mapIndex);
    if (!ident) throw new Error('Geometrie dieser Sperrzone konnte nicht stabil identifiziert werden.');
    const labels = { ...(this._nativeZoneLabelsCache && typeof this._nativeZoneLabelsCache === 'object'
      ? this._nativeZoneLabelsCache : {}) };
    // A direct user edit establishes the current geometry for this map/id. Drop
    // older variants only as local metadata; no native map command is involved.
    for (const [key, value] of Object.entries(labels)) {
      if (Number(value?.mapIndex) === mapIndex && Number(value?.nativeId) === nativeId) delete labels[key];
    }
    const note = String(body.note || '').trim().slice(0, 120);
    if (note) labels[ident.key] = { ...ident, note, updatedAt:Date.now() };
    this._nativeZoneLabelsCache = labels;
    await this.setStoreValue('native_zone_labels_v1', labels);

    // Keep an already-owned pylon rule consistent when this red native area is
    // actually the Homey-managed protection for exactly one physical pylon.
    const matches = this._matchingPylonRulesForNativeArea(nativeId, area, mapIndex);
    const requestedLifecycle = body.lifecycle != null ? this._normalizePylonLifecycle(body.lifecycle) : null;
    const phaseLifecycle = ['departure','departure_mowing','mowing','mowing_return','return'].includes(requestedLifecycle);
    if (phaseLifecycle && this.getSetting('garage_mode_enabled') !== true) {
      throw new Error('Fahrphasen-Sperrzonen benötigen einen aktivierten Garagenmodus.');
    }

    let lifecycleResult = null;
    if (matches.length === 1) {
      const rules = { ...(this._obstacleRulesCache && typeof this._obstacleRulesCache === 'object'
        ? this._obstacleRulesCache : {}) };
      const { ruleId, rule } = matches[0];
      let next = { ...rule, note, updatedAt:Date.now() };
      if (requestedLifecycle) {
        const timedDays = PYLON_TIMED_LIFECYCLE_DAYS[requestedLifecycle] || 0;
        const oldLifecycle = this._normalizePylonLifecycle(rule.lifecycle);
        let lifecycleExpiresAt = null;
        if (timedDays) {
          lifecycleExpiresAt = oldLifecycle === requestedLifecycle && Number(rule.lifecycleExpiresAt || 0) > Date.now()
            ? Number(rule.lifecycleExpiresAt)
            : Date.now() + timedDays * 24 * 60 * 60 * 1000;
        }
        next = { ...next, lifecycle:requestedLifecycle, lifecycleExpiresAt };
        const desired = this._pylonLifecycleDesiredActive(next, this._currentPylonLifecyclePhase());
        const active = this._pylonLifecycleNativeActive(next);
        next.lifecycleTransitionPending = desired === active ? null : (desired ? 'activate' : 'deactivate');
        next.lifecycleSuspended = !active;
      }
      rules[ruleId] = next;
      this._obstacleRulesCache = rules;
      await this.setStoreValue('obstacle_rules_v1', rules);
      lifecycleResult = {
        lifecycle:this._normalizePylonLifecycle(next.lifecycle), lifecycleExpiresAt:Number(next.lifecycleExpiresAt || 0) || null,
        lifecycleSuspended:next.lifecycleSuspended === true, lifecycleTransitionPending:next.lifecycleTransitionPending || null,
        managedBy:'pylon', ruleId,
      };
    } else if (requestedLifecycle) {
      const identPolicy = this._nativeZonePolicyIdentity(nativeId, area, mapIndex);
      const geometry = this._nativeZonePolicyGeometry(area);
      if (!identPolicy) throw new Error('Geometrie dieser Sperrzone konnte nicht stabil für die Zeitsteuerung identifiziert werden.');
      if (phaseLifecycle && (geometry.shape !== 2 || geometry.pointsMm.length < 3)) {
        throw new Error('Diese native Sperrzonenform unterstützt keine sichere Fahrphasen-Automatik.');
      }
      const policies = { ...(this._nativeZonePoliciesCache && typeof this._nativeZonePoliciesCache === 'object'
        ? this._nativeZonePoliciesCache : {}) };
      const previous = this._nativeZonePolicyFor(nativeId, area, mapIndex) || {};
      // Remove older near-identical geometry keys so there is one authoritative
      // local policy even if parsing/rounding changed slightly.
      for (const [key, value] of Object.entries(policies)) {
        if (this._nativeZonePolicyDescriptorMatches(value, identPolicy)) delete policies[key];
      }
      const timedDays = PYLON_TIMED_LIFECYCLE_DAYS[requestedLifecycle] || 0;
      const oldLifecycle = this._normalizePylonLifecycle(previous.lifecycle);
      let lifecycleExpiresAt = null;
      if (timedDays) {
        lifecycleExpiresAt = oldLifecycle === requestedLifecycle && Number(previous.lifecycleExpiresAt || 0) > Date.now()
          ? Number(previous.lifecycleExpiresAt)
          : Date.now() + timedDays * 24 * 60 * 60 * 1000;
      }
      let policy = { ...identPolicy, ...geometry, nativeId, note,
        lifecycle:requestedLifecycle, lifecycleExpiresAt,
        lifecycleSuspended:false, lifecycleTransitionPending:null,
        verification:'native_policy_saved', verificationAt:Date.now(), updatedAt:Date.now() };
      const desired = this._pylonLifecycleDesiredActive(policy, this._currentPylonLifecyclePhase());
      if (!desired) policy.lifecycleTransitionPending = 'deactivate';
      policies[identPolicy.key] = policy;
      this._nativeZonePoliciesCache = policies;
      await this.setStoreValue('native_zone_policies_v1', policies);
      lifecycleResult = {
        lifecycle:requestedLifecycle, lifecycleExpiresAt,
        lifecycleSuspended:false, lifecycleTransitionPending:policy.lifecycleTransitionPending,
        managedBy:'native', policyKey:identPolicy.key,
      };
    }

    this._pylonUiRevision = Number(this._pylonUiRevision || 0) + 1;
    if (lifecycleResult?.lifecycleTransitionPending && this._mapEditStationary()) {
      this._schedulePylonLifecycleSync(this._currentPylonLifecyclePhase(), 'native-zone-user-save');
    }
    this._scheduleMapCameraImageUpdate();
    this.log('[pylon-native] Homey local native-zone metadata saved', `nativeId=${nativeId}`,
      note ? `chars=${note.length}` : 'label=cleared', requestedLifecycle ? `lifecycle=${requestedLifecycle}` : '');
    return { ok:true, id:`native-zone:${nativeId}`, nativeZoneId:nativeId, nativeDirect:true, note,
      labelOnly:!requestedLifecycle, policy:lifecycleResult, deferred:!!lifecycleResult?.lifecycleTransitionPending };
  }

  async _rememberNativeZoneLabelDeleteWatch(nativeId, area, mapIndex = this._activeMapIndex, metadata = {}) {
    const ident = this._nativeZoneLabelIdentity(nativeId, area, mapIndex);
    if (!ident) return false;
    const watches = { ...(this._nativeZoneLabelDeleteWatches && typeof this._nativeZoneLabelDeleteWatches === 'object'
      ? this._nativeZoneLabelDeleteWatches : {}) };
    const revisionBefore = this._normalizeNativeMapRevision(metadata?.mapRevisionBefore);
    watches[ident.key] = { ...ident, requestedAt:Date.now(),
      ...(revisionBefore ? { mapRevisionBefore:revisionBefore } : {}) };
    this._nativeZoneLabelDeleteWatches = watches;
    await this.setStoreValue('native_zone_label_delete_watches_v1', watches);
    return true;
  }

  _nativeMapRevisionReadyForConfirmation(record, map) {
    // A hash- and geometry-verified direct MAPD frame is already current mower
    // evidence. Cloud MAP.* is accepted as destructive confirmation only after
    // MAPI has moved away from the pre-edit revision when such a checkpoint is
    // available. This prevents a fresh HTTP response carrying an older cloud
    // snapshot from clearing Pending or purging local identity metadata.
    if (map?.directMapdVerified === true && map?.directMapdGeometryVerified === true) return true;
    const before = this._normalizeNativeMapRevision(record?.mapRevisionBefore);
    if (!before) return true;
    if (Number(record?.mapRevisionAdvancedAt || 0) > 0) return true;
    const current = this._normalizeNativeMapRevision(this._lastVendorMapMeta);
    return !!current && (current.hash !== before.hash || current.size !== before.size);
  }

  async _reconcileNativeZoneLabelDeleteWatches(map, { fresh = false } = {}) {
    if (!fresh || !map || !Array.isArray(map.forbiddenAreas)) return 0;
    const mapIndex = Number(this._activeMapIndex);
    const watches = { ...(this._nativeZoneLabelDeleteWatches && typeof this._nativeZoneLabelDeleteWatches === 'object'
      ? this._nativeZoneLabelDeleteWatches : {}) };
    const labels = { ...(this._nativeZoneLabelsCache && typeof this._nativeZoneLabelsCache === 'object'
      ? this._nativeZoneLabelsCache : {}) };
    let removed = 0, watchesChanged = false, labelsChanged = false;
    for (const [watchKey, watch] of Object.entries(watches)) {
      if (Number(watch?.mapIndex) !== mapIndex) continue;
      const sameIdAreas = map.forbiddenAreas
        .filter((entry) => Number(Array.isArray(entry) ? entry[0] : entry?.id) === Number(watch.nativeId))
        .map((entry) => Array.isArray(entry) ? entry[1] : entry);
      const oldGeometryStillPresent = sameIdAreas.some((area) => {
        const ident = this._nativeZoneLabelIdentity(watch.nativeId, area, mapIndex);
        return this._nativeZoneLabelDescriptorMatches(watch, ident);
      });
      if (oldGeometryStillPresent) continue;
      const directOp = this._directNativeDeleteUi instanceof Map
        ? this._directNativeDeleteUi.get(Number(watch.nativeId)) : null;
      const revisionRecord = directOp?.mapRevisionBefore ? directOp : watch;
      if (!this._nativeMapRevisionReadyForConfirmation(revisionRecord, map)) continue;

      // A complete fresh readback plus current-revision evidence proved the watched geometry is gone. Purge
      // only labels matching that old geometry; a recycled id at a new position
      // keeps its own independently saved name.
      for (const [labelKey, label] of Object.entries(labels)) {
        if (!this._nativeZoneLabelDescriptorMatches(label, watch)) continue;
        delete labels[labelKey]; labelsChanged = true; removed += 1;
      }
      delete watches[watchKey]; watchesChanged = true;
    }
    if (labelsChanged) {
      this._nativeZoneLabelsCache = labels;
      await this.setStoreValue('native_zone_labels_v1', labels);
    }
    if (watchesChanged) {
      this._nativeZoneLabelDeleteWatches = watches;
      await this.setStoreValue('native_zone_label_delete_watches_v1', watches);
    }
    if (removed) this.log('[pylon-native] purged Homey label after confirmed fresh native deletion', `count=${removed}`, `map=${mapIndex}`);
    return removed;
  }

  // Kept for compatibility with older internal callers/tests. Ordinary missing
  // snapshots are deliberately not authoritative enough to purge local labels.
  async _purgeNativeZoneLabelsForMissingMapObjects() {
    return 0;
  }

  _stablePylonRuleKey(pylon, mapIndex = this._activeMapIndex) {
    if (!pylon || !Number.isFinite(Number(pylon.x)) || !Number.isFinite(Number(pylon.y))) return null;
    const map = Number.isInteger(Number(mapIndex)) ? Number(mapIndex) : 0;
    const qx = Math.round(Number(pylon.x) / 50) * 50;
    const qy = Math.round(Number(pylon.y) / 50) * 50;
    return `geo:${map}:${qx}:${qy}`;
  }

  _pylonRuleCanBind(rule, pylon, toleranceMm = 350) {
    if (!rule || !pylon) return false;
    const ruleMap = Number(rule.mapIndex);
    if (Number.isInteger(ruleMap) && Number.isInteger(Number(this._activeMapIndex))
        && ruleMap !== Number(this._activeMapIndex)) return false;

    // 1.2.34: once a rule has a real native map id, the native square geometry
    // is a stronger identity signal than an old stored OBS centroid. Dreame can
    // recycle obs:1/obs:2 and can also slightly change the reported obstacle
    // polygon, while the actual forbidden map object remains stable. Therefore
    // a present native id that geometrically matches the current pylon is
    // allowed to re-bind even when the historical centerX/centerY is stale.
    const nativeId = Number(rule.nativeId);
    if (Number.isInteger(nativeId) && nativeId > 0) {
      const entry = (this._cachedMapData?.forbiddenAreas || []).find((e) =>
        Number(Array.isArray(e) ? e[0] : e?.id) === nativeId);
      if (entry) {
        const area = Array.isArray(entry) ? entry?.[1] : entry;
        if (!area) return false;
        if (this._nativePylonZoneMatches(area, pylon, rule)) return true;
        // Some older Homey rules predate nativeWriteVersion but already point
        // to a real square id. The explicit native id is provenance enough;
        // allow square geometry to repair the stale local metadata.
        if (this._nativeForbiddenShape(area) === 2) {
          return this._nativeSquareAnyRadiusMetrics(area, pylon).matched === true;
        }
        return false;
      }
    }

    const cx = Number(rule.centerX), cy = Number(rule.centerY);
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      return Math.hypot(cx - Number(pylon.x), cy - Number(pylon.y)) <= toleranceMm;
    }
    return false;
  }

  _resolvePylonRuleBinding(pylon, rules = this._obstacleRulesCache || {}, preferredRuleId = null, usedRuleIds = null) {
    const used = usedRuleIds || new Set();
    const eligible = (key) => key && !used.has(key) && rules[key] && this._pylonRuleCanBind(rules[key], pylon);
    if (preferredRuleId && eligible(String(preferredRuleId))) {
      return { ruleId: String(preferredRuleId), rule: rules[String(preferredRuleId)] };
    }
    const stable = this._stablePylonRuleKey(pylon);
    if (eligible(stable)) return { ruleId: stable, rule: rules[stable] };
    if (eligible(pylon?.id)) return { ruleId: pylon.id, rule: rules[pylon.id] };

    let best = null;
    for (const [key, rule] of Object.entries(rules || {})) {
      if (used.has(key) || !this._pylonRuleCanBind(rule, pylon)) continue;
      const cx = Number(rule.centerX), cy = Number(rule.centerY);
      const distance = Number.isFinite(cx) && Number.isFinite(cy)
        ? Math.hypot(cx - Number(pylon.x), cy - Number(pylon.y)) : 999999;
      if (!best || distance < best.distance || (distance === best.distance && Number(rule.updatedAt || 0) > Number(best.rule.updatedAt || 0))) {
        best = { ruleId: key, rule, distance };
      }
    }
    return best ? { ruleId: best.ruleId, rule: best.rule } : { ruleId: null, rule: null };
  }

  _collectObstaclePylonsRaw() {
    const found = [];
    const explicitIdKeys = ['id', 'obs_id', 'obstacle_id', 'obstacleId', 'oid', 'uuid', 'index', 'idx'];
    const typeKeys = ['type', 'kind', 'category', 'reason', 'name', 'label', 'class', 'obstacle_type'];
    const push = (obj, source, path) => {
      const rawPoint = this._obstacleCoordinateFromObject(obj);
      if (!rawPoint) return;
      const pt = this._obstacleCoordinateToMap(rawPoint, source);
      let explicitId = null;
      for (const k of explicitIdKeys) if (obj?.[k] != null && String(obj[k]).length) { explicitId = String(obj[k]); break; }
      let type = null;
      for (const k of typeKeys) if (obj?.[k] != null && typeof obj[k] !== 'object') { type = String(obj[k]); break; }
      const qx = Math.round(pt.x / 50) * 50, qy = Math.round(pt.y / 50) * 50;
      const id = `${source}:${explicitId || `${qx}:${qy}:${type || 'unknown'}`}`;
      found.push({
        id, x: pt.x, y: pt.y, source, type: type || 'unknown',
        sourceId: explicitId, path, coordinateScale: pt.scale,
        coordinateScaleUncertain: !!pt.uncertainScale, coordinateTransform: pt.transform || null,
        polygonPointCount: Array.isArray(rawPoint.polygon) ? rawPoint.polygon.length : 0,
      });
    };
    const walk = (value, source, path = '$', depth = 0) => {
      if (depth > 7 || value == null) return;
      value = this._obstaclePayloadObject(value);
      if (Array.isArray(value)) {
        value.slice(0, 400).forEach((v, i) => walk(v, source, `${path}[${i}]`, depth + 1));
        return;
      }
      if (typeof value !== 'object') return;
      push(value, source, path);
      for (const [k, v] of Object.entries(value)) {
        if (['photo', 'image', 'base64', 'thumbnail'].some((n) => k.toLowerCase().includes(n))) continue;
        if (v && (typeof v === 'object' || typeof v === 'string')) walk(v, source, `${path}.${k}`, depth + 1);
      }
    };
    walk(this._cachedObstacles?.aiobs, 'aiobs');
    walk(this._cachedObstacles?.obs, 'obs');
    walk(this._cachedMapData?.mapObstacles, 'map');

    const merged = [];
    for (const p of found) {
      const same = merged.find((m) => {
        if (p.source === 'obs' && m.source === 'obs'
            && p.sourceId && m.sourceId && p.sourceId !== m.sourceId) return false;
        return Math.hypot(m.x - p.x, m.y - p.y) < 180;
      });
      if (!same) { merged.push(p); continue; }
      if (same.source !== p.source) same.source = `${same.source}+${p.source}`;
      if (same.type === 'unknown' && p.type !== 'unknown') same.type = p.type;
    }
    return merged.slice(0, 200);
  }

  _findPylonForRule(ruleId, rule, pylons = null) {
    const list = Array.isArray(pylons) ? pylons : this._buildObstaclePylons();
    if (!rule) return list.find((p) => p.id === ruleId) || null;
    const cx = Number(rule.centerX), cy = Number(rule.centerY);
    const exact = list.find((p) => p.id === ruleId);
    // Compatibility for legacy/incomplete telemetry: if the current pylon entry
    // carries no usable coordinates, its id is the only identity signal we have.
    // Real OBS/AIOBS pylons always carry coordinates, so recycled ids there are
    // still rejected by the physical-anchor logic below.
    if (exact && (!Number.isFinite(Number(exact.x)) || !Number.isFinite(Number(exact.y)))) return exact;
    // Compatibility for pre-anchor metadata/tests: once a rule has a physical
    // center we deliberately ignore recycled OBS ids, but truly legacy rules
    // without an anchor may still resolve by their original id.
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      if (exact) return exact;
    }
    const anchored = list.filter((p) => this._pylonRuleCanBind(rule, p));
    if (!anchored.length) return null;
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      anchored.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    }
    return anchored[0] || null;
  }

  _buildObstaclePylons() {
    const rules = this._obstacleRulesCache && typeof this._obstacleRulesCache === 'object' ? this._obstacleRulesCache : {};
    const managedNativeIds = new Set();
    for (const rule of Object.values(rules)) {
      if (!rule) continue;
      if (Number.isInteger(Number(rule.nativeId)) && Number(rule.nativeId) > 0) managedNativeIds.add(Number(rule.nativeId));
      if (Array.isArray(rule.nativeMatchIds)) {
        for (const id of rule.nativeMatchIds) if (Number.isInteger(Number(id)) && Number(id) > 0) managedNativeIds.add(Number(id));
      }
    }
    const raw = this._collectObstaclePylonsRaw();
    const usedRuleIds = new Set();
    const result = [];
    for (const p of raw) {
      const binding = this._resolvePylonRuleBinding(p, rules, null, usedRuleIds);
      const rule = binding.rule || {};
      const ruleId = binding.ruleId || this._stablePylonRuleKey(p);
      if (binding.ruleId) usedRuleIds.add(binding.ruleId);
      // Only explicit user removals hide the same physical marker. A hidden rule
      // may never jump to a reused OBS id because binding is anchor-based above.
      if (rule.hidden === true && rule.hiddenByUser === true) continue;
      const uiState = this._pylonUiState(rule);
      const mapEntries = (this._cachedMapData?.forbiddenAreas || []).map((e) => ({
        id:Number(Array.isArray(e) ? e[0] : e?.id), area:Array.isArray(e) ? e?.[1] : e,
      }));
      const nativeEntry = rule.nativeId != null ? mapEntries.find((e) => e.id === Number(rule.nativeId)) : null;
      const nativePresentById = !!nativeEntry;
      const explicitNativeAnyRadius = nativePresentById && this._nativeForbiddenShape(nativeEntry.area) === 2
        ? this._nativeSquareAnyRadiusMetrics(nativeEntry.area, p) : null;
      const nativeConfirmedById = nativePresentById && (
        this._nativePylonZoneMatches(nativeEntry.area, p, rule)
        || explicitNativeAnyRadius?.matched === true
      );

      // 1.2.34: if the local Homey rule was lost/detached but the real red
      // square still exists at this physical pylon, expose that native object
      // immediately in the menu. This is read-only discovery; persistence is
      // handled by Save/reconcile. It restores the native ID without trusting
      // recyclable OBS ids.
      const discovered = !rule.pending && !nativeConfirmedById
        ? this._nativeSquareCandidatesForPylon(mapEntries.filter((entry) => managedNativeIds.has(entry.id)), p, Number(rule.radius) || null)
        : [];
      const preferredDiscovered = discovered.find((entry) => entry.id === Number(rule.nativeId))
        || discovered.find((entry) => entry.id === Number(rule.nativeCandidateId))
        || discovered[0] || null;
      const effectiveNativeId = nativeConfirmedById ? Number(rule.nativeId) : (preferredDiscovered?.id ?? null);
      const nativeConfirmed = nativeConfirmedById || !!preferredDiscovered;
      const nativePresent = nativePresentById || !!preferredDiscovered;
      const staleBinding = rule.nativeId != null && !nativeConfirmedById && !preferredDiscovered && !rule.pending;
      const effectiveRadius = nativeConfirmedById && explicitNativeAnyRadius?.matched
        ? Number(explicitNativeAnyRadius.radius || rule.radius || 500)
        : (preferredDiscovered?.radius || Number(rule.radius) || 500);
      const effectiveMatchIds = discovered.length
        ? discovered.map((entry) => entry.id).slice(0,12)
        : (Array.isArray(rule.nativeMatchIds) ? rule.nativeMatchIds.slice(0,12) : []);
      result.push({
        ...p,
        ruleId,
        rule: {
          // Pending is a verification state, never a projected map mutation.
          // During delete the still-present native square remains protected and
          // visible; during create we do not claim protection until geometry is
          // actually returned by the mower/cloud map.
          action: nativeConfirmed ? 'avoid' : 'observe',
          radius: Math.max(500, Math.min(3000, effectiveRadius)),
          note: String(rule.note || '').slice(0, 120),
          enforcement: rule.pending
            ? 'pending_readback'
            : nativeConfirmed ? (nativeConfirmedById ? 'native_geometry_confirmed' : 'native_geometry_discovered')
              : staleBinding ? 'stale_binding_detached' : 'diagnostic_only',
          nativeId: nativeConfirmed ? effectiveNativeId : null,
          storedNativeId: rule.nativeId ?? null,
          nativePresent,
          nativeConfirmed,
          staleBinding,
          nativeCandidateId: rule.nativeCandidateId ?? null,
          nativeMatchIds: effectiveMatchIds,
          pending: rule.pending || null,
          uiPending: uiState.uiPending,
          uiOptimistic: uiState.optimistic,
          verification: preferredDiscovered && !nativeConfirmedById
            ? 'native_geometry_discovered'
            : staleBinding ? 'native_binding_mismatch' : (rule.verification || null),
          lifecycle: this._normalizePylonLifecycle(rule.lifecycle),
          lifecycleExpiresAt: Number(rule.lifecycleExpiresAt || 0) || null,
          lifecycleSuspended: rule.lifecycleSuspended === true,
          lifecycleTransitionPending: rule.lifecycleTransitionPending || null,
        },
      });
    }
    return result;
  }


  _normalizePylonLifecycle(value) {
    const mode = String(value || 'permanent').trim().toLowerCase();
    return PYLON_LIFECYCLE_MODES.has(mode) ? mode : 'permanent';
  }

  _currentPylonLifecyclePhase() {
    const status = String(this._nativeMowerStatus || this.getCapabilityValue?.('mower_status') || '').toLowerCase();
    const garage = this._garageSafety;
    if (garage?.isReturnCycleActive?.() || status === 'returning') return 'return';
    if (garage?._outbound || ['leaving', 'adjusting', 'positioning'].includes(status)) return 'departure';
    const physicallyHome = garage?.isDockedHomeStatus?.()
      || (!garage?._missionOutside && ['idle', 'standby', 'docked', 'charging', 'charging_completed'].includes(status));
    if (physicallyHome) return 'departure_ready';
    if (garage?._missionOutside || ['mowing', 'edge_mowing', 'remote_control'].includes(status)) return 'mowing';
    return 'idle';
  }

  _pylonLifecycleDesiredActive(rule, phase = this._currentPylonLifecyclePhase(), now = Date.now()) {
    const mode = this._normalizePylonLifecycle(rule?.lifecycle);
    const phaseMode = ['departure','departure_mowing','mowing','mowing_return','return'].includes(mode);
    // Mission-phase policies belong to Garage Mode. If Garage Mode is disabled,
    // restore a zone Homey had suspended and then leave it active; no departure/
    // return interception is performed while Garage Mode is off.
    if (phaseMode && this.getSetting('garage_mode_enabled') !== true) return true;
    const days = PYLON_TIMED_LIFECYCLE_DAYS[mode];
    if (days) {
      const expiresAt = Number(rule?.lifecycleExpiresAt || 0);
      return !expiresAt || now < expiresAt;
    }
    if (mode === 'permanent') return true;
    if (mode === 'departure') return phase === 'departure_ready' || phase === 'departure';
    if (mode === 'departure_mowing') return ['departure_ready', 'departure', 'mowing'].includes(phase);
    if (mode === 'mowing') return phase === 'mowing';
    if (mode === 'mowing_return') return phase === 'mowing' || phase === 'return';
    if (mode === 'return') return phase === 'return';
    return true;
  }

  _mapEditStationary() {
    const status = String(this._nativeMowerStatus || this.getCapabilityValue?.('mower_status') || '').toLowerCase();
    if (['mowing', 'edge_mowing', 'leaving', 'returning', 'remote_control', 'mapping'].includes(status)) return false;
    if (this._garageSafety?._outbound || this._garageSafety?._safeReturnInProgress || this._garageSafety?._manualMaintenanceTransit) return false;
    // Unknown/bootstrapping states remain compatible with the pre-existing native
    // edit path; runtime movement is rejected only when we have positive evidence.
    return true;
  }

  _pylonLifecycleNativeActive(rule) {
    const nativeId = Number(rule?.nativeId);
    if (!Number.isInteger(nativeId) || nativeId <= 0) return false;
    const areas = this._cachedMapData?.forbiddenAreas;
    if (!Array.isArray(areas) || !areas.length) return true;
    return areas.some((entry) => Number(Array.isArray(entry) ? entry[0] : entry?.id) === nativeId);
  }

  _nativeZonePolicyIdentity(nativeId, area, mapIndex = this._activeMapIndex) {
    const ident = this._nativeZoneLabelIdentity(nativeId, area, mapIndex);
    if (!ident) return null;
    const key = `map:${ident.mapIndex}|shape:${ident.shape}|c:${ident.centerX},${ident.centerY}|s:${ident.width},${ident.height}|a:${ident.areaScale}|p:${ident.pointCount}`;
    return { ...ident, key };
  }

  _nativeZonePolicyDescriptorMatches(entry, ident) {
    if (!entry || !ident) return false;
    if (Number(entry.mapIndex) !== Number(ident.mapIndex)) return false;
    if (Number.isFinite(Number(entry.shape)) && Number(entry.shape) !== Number(ident.shape)) return false;
    const dc = Math.hypot(Number(entry.centerX) - Number(ident.centerX), Number(entry.centerY) - Number(ident.centerY));
    const ds = Math.max(Math.abs(Number(entry.width) - Number(ident.width)), Math.abs(Number(entry.height) - Number(ident.height)));
    const oldArea = Number(entry.areaScale);
    const da = Number.isFinite(oldArea) ? Math.abs(oldArea - Number(ident.areaScale)) : 0;
    const oldCount = Number(entry.pointCount);
    const countOk = !Number.isFinite(oldCount) || Math.abs(oldCount - Number(ident.pointCount)) <= 2;
    return Number.isFinite(dc) && Number.isFinite(ds) && Number.isFinite(da)
      && dc <= 125 && ds <= 125 && da <= 175 && countOk;
  }

  _nativeZonePolicyGeometry(area) {
    const source = Array.isArray(area?.path) ? area.path
      : Array.isArray(area?.points) ? area.points
        : Array.isArray(area?.polygon) ? area.polygon : [];
    const pointsMm = source.map((pt) => Array.isArray(pt)
      ? [Number(pt[0]), Number(pt[1])]
      : [Number(pt?.x), Number(pt?.y)])
      .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
    return { shape:Number(this._nativeForbiddenShape(area) ?? 0), pointsMm };
  }

  _nativeZonePolicyFor(nativeId, area, mapIndex = this._activeMapIndex) {
    const ident = this._nativeZonePolicyIdentity(nativeId, area, mapIndex);
    if (!ident) return null;
    const policies = this._nativeZonePoliciesCache && typeof this._nativeZonePoliciesCache === 'object'
      ? this._nativeZonePoliciesCache : {};
    if (policies[ident.key]) return { ...policies[ident.key], key:ident.key };
    const candidates = [];
    for (const [key, entry] of Object.entries(policies)) {
      if (!this._nativeZonePolicyDescriptorMatches(entry, ident)) continue;
      const dc = Math.hypot(Number(entry.centerX) - ident.centerX, Number(entry.centerY) - ident.centerY);
      const ds = Math.max(Math.abs(Number(entry.width) - ident.width), Math.abs(Number(entry.height) - ident.height));
      const da = Number.isFinite(Number(entry.areaScale)) ? Math.abs(Number(entry.areaScale) - ident.areaScale) : 0;
      candidates.push({ ...entry, key, score:dc + ds + da });
    }
    candidates.sort((a,b) => a.score - b.score);
    if (!candidates.length) return null;
    if (candidates.length > 1 && Math.abs(candidates[1].score - candidates[0].score) < 25) return null;
    return candidates[0];
  }

  _nativeZonePolicyCurrentEntry(policy, map = this._cachedMapData) {
    if (!policy || !Array.isArray(map?.forbiddenAreas)) return null;
    const entries = map.forbiddenAreas.map((entry) => ({
      id:Number(Array.isArray(entry) ? entry[0] : entry?.id),
      area:Array.isArray(entry) ? entry[1] : entry,
    })).filter((entry) => Number.isInteger(entry.id) && entry.id > 0 && entry.area);
    const matches = entries.filter((entry) => {
      const ident = this._nativeZonePolicyIdentity(entry.id, entry.area, policy.mapIndex);
      return ident && this._nativeZonePolicyDescriptorMatches(policy, ident);
    });
    if (!matches.length) return null;
    const preferred = matches.find((entry) => entry.id === Number(policy.nativeId));
    return preferred || (matches.length === 1 ? matches[0] : null);
  }

  _nativeZonePoliciesForMap(map = this._cachedMapData) {
    if (!map || !Array.isArray(map.forbiddenAreas)) return [];
    const out = [];
    for (const entry of map.forbiddenAreas) {
      const nativeId = Number(Array.isArray(entry) ? entry[0] : entry?.id);
      const area = Array.isArray(entry) ? entry[1] : entry;
      const policy = this._nativeZonePolicyFor(nativeId, area, this._activeMapIndex);
      if (!policy) continue;
      out.push({
        nativeId,
        lifecycle:this._normalizePylonLifecycle(policy.lifecycle),
        lifecycleExpiresAt:Number(policy.lifecycleExpiresAt || 0) || null,
        lifecycleSuspended:policy.lifecycleSuspended === true,
        lifecycleTransitionPending:policy.lifecycleTransitionPending || null,
        updatedAt:Number(policy.updatedAt || 0),
      });
    }
    return out;
  }

  async _removeNativeZonePolicyFor(nativeId, area, mapIndex = this._activeMapIndex) {
    const ident = this._nativeZonePolicyIdentity(nativeId, area, mapIndex);
    if (!ident) return false;
    const policies = { ...(this._nativeZonePoliciesCache && typeof this._nativeZonePoliciesCache === 'object'
      ? this._nativeZonePoliciesCache : {}) };
    let changed = false;
    for (const [key, entry] of Object.entries(policies)) {
      if (!this._nativeZonePolicyDescriptorMatches(entry, ident)) continue;
      delete policies[key];
      changed = true;
    }
    if (changed) {
      this._nativeZonePoliciesCache = policies;
      await this.setStoreValue('native_zone_policies_v1', policies);
    }
    return changed;
  }

  _nativeZonePolicyNeedsTransition(policy, phase = this._currentPylonLifecyclePhase(), map = this._cachedMapData) {
    if (!policy) return false;
    const mode = this._normalizePylonLifecycle(policy.lifecycle);
    if (mode === 'permanent') return policy.lifecycleSuspended === true;
    const active = !!this._nativeZonePolicyCurrentEntry(policy, map);
    const desired = this._pylonLifecycleDesiredActive(policy, phase);
    if (policy.lifecycleTransitionPending) return true;
    if (!desired && active) return true;
    // Recreate only a zone that Homey itself suspended. If it disappears from
    // the original app for another reason, do not resurrect it automatically.
    if (desired && !active && policy.lifecycleSuspended === true) return true;
    return false;
  }

  async _waitForNativeZonePolicyTransition(policyKey, desiredActive, timeoutMs = 55_000) {
    const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 55_000);
    while (Date.now() < deadline) {
      try { await this.refreshMapData(); } catch (_) {}
      const policy = this._nativeZonePoliciesCache?.[policyKey] || null;
      const active = !!this._nativeZonePolicyCurrentEntry(policy, this._cachedMapData);
      if (policy && active === !!desiredActive) return true;
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
    const policy = this._nativeZonePoliciesCache?.[policyKey] || null;
    return !!policy && (!!this._nativeZonePolicyCurrentEntry(policy, this._cachedMapData) === !!desiredActive);
  }

  async _createNativeZoneFromPolicy(policyKey, policy, phase) {
    const pointsMm = Array.isArray(policy?.pointsMm) ? policy.pointsMm : [];
    if (Number(policy?.shape) !== 2 || pointsMm.length < 3) {
      throw new Error('Diese native Sperrzonenform kann nicht sicher automatisch wiederhergestellt werden.');
    }
    const did = this.getData().id;
    const mapIndex = Number(policy.mapIndex);
    const pointsM = pointsMm.map((pt) => [Number(pt[0]) / 1000, Number(pt[1]) / 1000]);
    this.log('[native-zone-lifecycle] recreating original-app zone', `policy=${String(policyKey).slice(0,80)}`, `phase=${phase}`);
    const result = await this._api.setForbiddenPolygon(did, pointsM, -1, mapIndex, this._pylonMapEditTaskOptions());
    const answer = result?.result?.out?.[0];
    if (answer?.status === false || Number(answer?.error || 0) !== 0) throw new Error('Mäher hat die native Sperrzone nicht wiederhergestellt.');
    return result;
  }

  _pylonLifecycleNeedsTransition(phase = this._currentPylonLifecyclePhase()) {
    const rules = this._obstacleRulesCache || {};
    for (const rule of Object.values(rules)) {
      if (!rule || !rule.lifecycle || rule.hidden === true) continue;
      if (Number.isInteger(Number(rule.mapIndex)) && Number(rule.mapIndex) !== Number(this._activeMapIndex)) continue;
      if (rule.pending || rule.lifecycleTransitionPending) return true;
      if (this._pylonLifecycleDesiredActive(rule, phase) !== this._pylonLifecycleNativeActive(rule)) return true;
    }
    const policies = this._nativeZonePoliciesCache && typeof this._nativeZonePoliciesCache === 'object'
      ? this._nativeZonePoliciesCache : {};
    for (const policy of Object.values(policies)) {
      if (!policy || Number(policy.mapIndex) !== Number(this._activeMapIndex)) continue;
      if (this._nativeZonePolicyNeedsTransition(policy, phase, this._cachedMapData)) return true;
    }
    return false;
  }

  _schedulePylonLifecycleSync(phase = this._currentPylonLifecyclePhase(), reason = 'scheduled') {
    if (this._pylonLifecycleSyncTimer || this._pylonLifecycleSyncPromise) return;
    this._pylonLifecycleSyncTimer = setTimeout(() => {
      this._pylonLifecycleSyncTimer = null;
      this._syncPylonLifecyclePhase(phase, { reason })
        .catch((err) => this.log('[pylon-lifecycle] scheduled sync failed:', err?.message || String(err)));
    }, 250);
    this._pylonLifecycleSyncTimer.unref?.();
  }

  async _waitForPylonPendingResolution(ruleId, timeoutMs = 55_000) {
    const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 55_000);
    while (Date.now() < deadline) {
      const before = this._obstacleRulesCache?.[ruleId];
      if (!before?.pending) return true;
      try { await this.refreshMapData(); } catch (_) {}
      const after = this._obstacleRulesCache?.[ruleId];
      if (!after?.pending) return true;
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
    return !this._obstacleRulesCache?.[ruleId]?.pending;
  }

  async _waitForPylonLifecycleTransition(ruleId, desiredActive, timeoutMs = 55_000) {
    const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 55_000);
    while (Date.now() < deadline) {
      try { await this.refreshMapData(); } catch (_) {}
      const rule = this._obstacleRulesCache?.[ruleId] || null;
      const active = this._pylonLifecycleNativeActive(rule);
      if (rule && !rule.pending && active === !!desiredActive) return true;
      if (rule && /unconfirmed_retryable/.test(String(rule.verification || ''))) return false;
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }
    return false;
  }

  async _syncPylonLifecyclePhase(phase = this._currentPylonLifecyclePhase(), { reason = 'phase' } = {}) {
    if (this._pylonLifecycleSyncPromise) return this._pylonLifecycleSyncPromise;
    const run = (async () => {
      if (!this._api) return { ok:false, deferred:true, reason:'not_connected' };
      if (!this._mapEditStationary()) {
        this.log('[pylon-lifecycle] sync deferred until mower is stationary', `phase=${phase}`, reason);
        return { ok:false, deferred:true, reason:'mower_moving' };
      }
      const entries = Object.entries(this._obstacleRulesCache || {})
        .filter(([, rule]) => rule && rule.lifecycle && rule.hidden !== true
          && (!Number.isInteger(Number(rule.mapIndex)) || Number(rule.mapIndex) === Number(this._activeMapIndex)));
      let changed = 0;
      for (const [ruleId] of entries) {
        let rule = this._obstacleRulesCache?.[ruleId];
        if (!rule) continue;
        if (rule.pending) {
          const settled = await this._waitForPylonPendingResolution(ruleId);
          rule = this._obstacleRulesCache?.[ruleId];
          if (!settled || rule?.pending) return { ok:false, deferred:false, reason:'native_edit_pending_timeout', ruleId };
        }
        const desired = this._pylonLifecycleDesiredActive(rule, phase);
        const active = this._pylonLifecycleNativeActive(rule);
        const transition = String(rule.lifecycleTransitionPending || '');

        if (desired === active && transition !== 'update') {
          if (rule.lifecycleTransitionPending || rule.lifecycleSuspended !== !desired) {
            const next = { ...rule, lifecycleTransitionPending:null, lifecycleSuspended:!desired, updatedAt:Date.now() };
            this._obstacleRulesCache = { ...this._obstacleRulesCache, [ruleId]:next };
            await this.setStoreValue('obstacle_rules_v1', this._obstacleRulesCache);
            this._pylonUiRevision = Number(this._pylonUiRevision || 0) + 1;
          }
          continue;
        }

        if (!desired && active) {
          const nativeId = Number(rule.nativeId);
          this.log('[pylon-lifecycle] deactivating native zone', `ruleId=${String(ruleId).slice(0,64)}`, `nativeId=${nativeId}`, `phase=${phase}`);
          await this.updateObstacleRule({
            id:ruleId, ruleId, nativeZoneId:nativeId, deleteForbidden:true,
            action:'observe', lifecycleInternal:true, lifecyclePhase:phase,
          });
          const ok = await this._waitForPylonLifecycleTransition(ruleId, false);
          if (!ok) return { ok:false, deferred:false, reason:'deactivate_unconfirmed', ruleId };
          changed += 1;
        } else if (desired && (!active || transition === 'update')) {
          rule = this._obstacleRulesCache?.[ruleId] || rule;
          const pylon = this._findPylonForRule(ruleId, rule);
          if (!pylon) {
            this.log('[pylon-lifecycle] activation deferred: source pylon unavailable', `ruleId=${String(ruleId).slice(0,64)}`, `phase=${phase}`);
            return { ok:false, deferred:false, reason:'pylon_unavailable', ruleId };
          }
          const radiusCm = Math.max(50, Math.min(300, Math.round(Number(rule.radius || 500) / 10)));
          this.log('[pylon-lifecycle] activating native zone', `ruleId=${String(ruleId).slice(0,64)}`, `phase=${phase}`, `radiusCm=${radiusCm}`);
          await this.updateObstacleRule({
            id:pylon.id, ruleId, action:'avoid', radiusCm, note:String(rule.note || ''),
            lifecycle:rule.lifecycle, lifecycleExpiresAt:rule.lifecycleExpiresAt,
            lifecycleInternal:true, lifecyclePhase:phase,
          });
          const ok = await this._waitForPylonLifecycleTransition(ruleId, true);
          if (!ok) return { ok:false, deferred:false, reason:'activate_unconfirmed', ruleId };
          changed += 1;
        }

        rule = this._obstacleRulesCache?.[ruleId];
        if (rule) {
          const desiredNow = this._pylonLifecycleDesiredActive(rule, phase);
          const next = { ...rule, lifecycleTransitionPending:null, lifecycleSuspended:!desiredNow, updatedAt:Date.now() };
          this._obstacleRulesCache = { ...this._obstacleRulesCache, [ruleId]:next };
          await this.setStoreValue('obstacle_rules_v1', this._obstacleRulesCache);
          this._pylonUiRevision = Number(this._pylonUiRevision || 0) + 1;
        }
      }
      // Apply the same lifecycle policy to native zones that originated in the
      // MOVA/Dreame app. These zones are adopted only after the user selects a
      // lifecycle in Homey; permanent zones are never rewritten automatically.
      const directPolicies = Object.entries(this._nativeZonePoliciesCache || {})
        .filter(([, policy]) => policy && Number(policy.mapIndex) === Number(this._activeMapIndex));
      for (const [policyKey] of directPolicies) {
        let policies = { ...(this._nativeZonePoliciesCache || {}) };
        let policy = policies[policyKey];
        if (!policy) continue;
        const mode = this._normalizePylonLifecycle(policy.lifecycle);
        let entry = this._nativeZonePolicyCurrentEntry(policy, this._cachedMapData);
        let active = !!entry;
        const desired = this._pylonLifecycleDesiredActive(policy, phase);

        if (entry && Number(policy.nativeId) !== Number(entry.id)) {
          policy = { ...policy, nativeId:Number(entry.id), updatedAt:Date.now() };
          policies[policyKey] = policy;
          this._nativeZonePoliciesCache = policies;
          await this.setStoreValue('native_zone_policies_v1', policies);
        }

        if (mode === 'permanent') {
          if (policy.lifecycleSuspended === true && !active) {
            // Garage Mode may have been disabled while Homey had this zone
            // suspended. Restore it once, then permanent means no automation.
          } else {
            if (policy.lifecycleTransitionPending || policy.lifecycleSuspended) {
              policies = { ...(this._nativeZonePoliciesCache || {}) };
              policies[policyKey] = { ...policy, lifecycleTransitionPending:null, lifecycleSuspended:false, updatedAt:Date.now() };
              this._nativeZonePoliciesCache = policies;
              await this.setStoreValue('native_zone_policies_v1', policies);
            }
            continue;
          }
        }

        if (!desired && active) {
          const nativeId = Number(entry.id);
          this.log('[native-zone-lifecycle] deactivating original-app zone', `nativeId=${nativeId}`, `phase=${phase}`, `mode=${mode}`);
          await this.updateObstacleRule({
            id:`native-zone:${nativeId}`, nativeZoneId:nativeId, deleteForbidden:true,
            action:'observe', lifecycleInternal:true, preserveNativeMetadata:true,
          });
          const ok = await this._waitForNativeZonePolicyTransition(policyKey, false);
          if (!ok) return { ok:false, deferred:false, reason:'native_zone_deactivate_unconfirmed', policyKey };
          policies = { ...(this._nativeZonePoliciesCache || {}) };
          policy = policies[policyKey] || policy;
          policies[policyKey] = { ...policy, lastNativeId:nativeId, nativeId:null,
            lifecycleSuspended:true, lifecycleTransitionPending:null,
            verification:'native_lifecycle_suspended', verificationAt:Date.now(), updatedAt:Date.now() };
          this._nativeZonePoliciesCache = policies;
          await this.setStoreValue('native_zone_policies_v1', policies);
          changed += 1;
          continue;
        }

        if (desired && !active && policy.lifecycleSuspended === true) {
          try {
            await this._createNativeZoneFromPolicy(policyKey, policy, phase);
          } catch (err) {
            this.log('[native-zone-lifecycle] recreate failed:', err.message);
            return { ok:false, deferred:false, reason:'native_zone_recreate_failed', policyKey };
          }
          const ok = await this._waitForNativeZonePolicyTransition(policyKey, true);
          if (!ok) return { ok:false, deferred:false, reason:'native_zone_recreate_unconfirmed', policyKey };
          entry = this._nativeZonePolicyCurrentEntry(this._nativeZonePoliciesCache?.[policyKey] || policy, this._cachedMapData);
          policies = { ...(this._nativeZonePoliciesCache || {}) };
          policy = policies[policyKey] || policy;
          policies[policyKey] = { ...policy, nativeId:Number(entry?.id || policy.nativeId || 0) || null,
            lifecycleSuspended:false, lifecycleTransitionPending:null,
            verification:'native_lifecycle_active', verificationAt:Date.now(), updatedAt:Date.now() };
          this._nativeZonePoliciesCache = policies;
          await this.setStoreValue('native_zone_policies_v1', policies);
          changed += 1;
          continue;
        }

        // If the user deleted/changed the zone in the original app while it was
        // supposed to be active, do not recreate it. Only Homey-suspended zones
        // are automatically restored.
        if (desired && !active && policy.lifecycleSuspended !== true && policy.lifecycleTransitionPending) {
          policies = { ...(this._nativeZonePoliciesCache || {}) };
          policies[policyKey] = { ...policy, lifecycleTransitionPending:null,
            verification:'native_missing_external', verificationAt:Date.now(), updatedAt:Date.now() };
          this._nativeZonePoliciesCache = policies;
          await this.setStoreValue('native_zone_policies_v1', policies);
        } else if (active && desired && (policy.lifecycleTransitionPending || policy.lifecycleSuspended)) {
          policies = { ...(this._nativeZonePoliciesCache || {}) };
          policies[policyKey] = { ...policy, nativeId:Number(entry?.id || policy.nativeId || 0) || null,
            lifecycleTransitionPending:null, lifecycleSuspended:false, updatedAt:Date.now() };
          this._nativeZonePoliciesCache = policies;
          await this.setStoreValue('native_zone_policies_v1', policies);
        }
      }

      if (changed) this._scheduleMapCameraImageUpdate();
      return { ok:true, changed, phase };
    })();
    this._pylonLifecycleSyncPromise = run;
    try {
      return await run;
    } finally {
      if (this._pylonLifecycleSyncPromise === run) this._pylonLifecycleSyncPromise = null;
    }
  }

  _noteMapEditTask(value) {
    const task = value?.t === 'TASK' && value?.d && typeof value.d === 'object' ? value.d : null;
    const opcode = Number(task?.o);
    if (!task || task.exe !== true || !Number.isInteger(opcode)) return;
    if (!this._mapEditTaskLatest) this._mapEditTaskLatest = new Map();
    if (!this._mapEditTaskWaiters) this._mapEditTaskWaiters = new Map();
    const event = { ts: Date.now(), value };
    this._mapEditTaskLatest.set(opcode, event);
    const waiters = this._mapEditTaskWaiters.get(opcode) || [];
    if (!waiters.length) return;
    const remaining = [];
    for (const waiter of waiters) {
      if (event.ts < Number(waiter.afterTs || 0)) { remaining.push(waiter); continue; }
      try { this.homey?.clearTimeout ? this.homey.clearTimeout(waiter.timer) : clearTimeout(waiter.timer); } catch (_) {}
      try { waiter.resolve(value); } catch (_) {}
    }
    if (remaining.length) this._mapEditTaskWaiters.set(opcode, remaining);
    else this._mapEditTaskWaiters.delete(opcode);
  }

  _waitForMapEditTask(opcode, afterTs, timeoutMs = 5000) {
    const op = Number(opcode);
    const after = Number(afterTs || 0);
    if (!Number.isInteger(op)) return Promise.reject(new Error('Ungültiger Kartenedit-TASK Opcode.'));
    if (!this._mapEditTaskLatest) this._mapEditTaskLatest = new Map();
    if (!this._mapEditTaskWaiters) this._mapEditTaskWaiters = new Map();
    const latest = this._mapEditTaskLatest.get(op);
    if (latest && Number(latest.ts) >= after) return Promise.resolve(latest.value);
    return new Promise((resolve, reject) => {
      const waiter = { afterTs: after, resolve, reject, timer: null };
      const finishTimeout = () => {
        const current = this._mapEditTaskWaiters?.get(op) || [];
        const next = current.filter((entry) => entry !== waiter);
        if (next.length) this._mapEditTaskWaiters.set(op, next);
        else this._mapEditTaskWaiters?.delete(op);
        reject(new Error(`TASK o=${op} nicht innerhalb von ${Math.round(Number(timeoutMs) || 5000)}ms bestätigt.`));
      };
      waiter.timer = this.homey?.setTimeout
        ? this.homey.setTimeout(finishTimeout, Number(timeoutMs) || 5000)
        : setTimeout(finishTimeout, Number(timeoutMs) || 5000);
      const list = this._mapEditTaskWaiters.get(op) || [];
      list.push(waiter);
      this._mapEditTaskWaiters.set(op, list);
    });
  }

  _pylonMapEditTaskOptions() {
    return {
      waitForTask: (opcode, afterTs, timeoutMs) => this._waitForMapEditTask(opcode, afterTs, timeoutMs),
      taskTimeouts: { select: 7000, begin: 4500, mutation: 4500, commit: 4500 },
    };
  }

  _normalizeNativeMapRevision(value) {
    const data = value?.d ?? value;
    const hash = typeof data?.hash === 'string' ? data.hash.toLowerCase() : null;
    const size = Number(data?.size);
    if (!hash || !Number.isFinite(size) || size <= 0) return null;
    return { hash, size };
  }

  async _captureNativeMapRevision(did, mapIndex) {
    if (!this._api || typeof this._api.getMAPI !== 'function') return this._normalizeNativeMapRevision(this._lastVendorMapMeta);
    try {
      let timer;
      const meta = await Promise.race([
        this._api.getMAPI(did, mapIndex),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MAPI revision timeout')), 5000); }),
      ]).finally(() => clearTimeout(timer));
      const revision = this._normalizeNativeMapRevision(meta);
      if (revision) this._lastVendorMapMeta = { idx:Number(mapIndex), ...revision };
      return revision;
    } catch (err) {
      this.log('[pylon-native] pre-edit map revision unavailable:', err.message);
      return this._normalizeNativeMapRevision(this._lastVendorMapMeta);
    }
  }

  async _noteNativeMapRevisionProgress(meta) {
    const current = this._normalizeNativeMapRevision(meta);
    if (!current) return false;
    const rules = this._obstacleRulesCache && typeof this._obstacleRulesCache === 'object'
      ? { ...this._obstacleRulesCache } : {};
    let rulesChanged = false;
    for (const [id, rule] of Object.entries(rules)) {
      if (!rule?.pending || Number(rule.mapIndex) !== Number(this._activeMapIndex) || rule.mapRevisionAdvancedAt) continue;
      const before = this._normalizeNativeMapRevision(rule.mapRevisionBefore);
      if (!before || (before.hash === current.hash && before.size === current.size)) continue;
      rules[id] = { ...rule, mapRevisionAfter:current, mapRevisionAdvancedAt:Date.now() };
      rulesChanged = true;
      this.log('[pylon-native] mower map revision advanced; geometry confirmation still pending',
        `id=${String(id).slice(0,64)}`, `pending=${rule.pending}`,
        `before=${String(before.hash).slice(0,16)}/${before.size}`,
        `after=${String(current.hash).slice(0,16)}/${current.size}`);
    }
    if (rulesChanged) {
      this._obstacleRulesCache = rules;
      await this.setStoreValue('obstacle_rules_v1', rules);
    }
    if (this._directNativeDeleteUi instanceof Map) {
      for (const [nativeId, op] of this._directNativeDeleteUi.entries()) {
        if (Number(op?.mapIndex) !== Number(this._activeMapIndex) || op?.mapRevisionAdvancedAt) continue;
        const before = this._normalizeNativeMapRevision(op?.mapRevisionBefore);
        if (!before || (before.hash === current.hash && before.size === current.size)) continue;
        const next = { ...op, mapRevisionAfter:current, mapRevisionAdvancedAt:Date.now() };
        this._directNativeDeleteUi.set(nativeId, next);
        this.log('[pylon-native] mower map revision advanced; direct delete geometry confirmation still pending',
          `nativeId=${Number(nativeId)}`,
          `before=${String(before.hash).slice(0,16)}/${before.size}`,
          `after=${String(current.hash).slice(0,16)}/${current.size}`);
      }
    }
    return rulesChanged;
  }

  async updateObstacleRule(body = {}) {
    const id = String(body.id || '').trim();
    if (!id || id.length > 240) throw new Error('Invalid obstacle id');
    const rules = { ...(this._obstacleRulesCache && typeof this._obstacleRulesCache === 'object' ? this._obstacleRulesCache : {}) };
    if (body.action === 'label' && Number.isInteger(Number(body.nativeZoneId))) {
      return this._setNativeZoneLabel(body);
    }
    if (body.action === 'avoid' || body.deleteForbidden === true) {
      return this._updatePylonForbiddenArea(body, rules);
    }
    const pylon = this._buildObstaclePylons().find((entry) => entry.id === id) || null;
    if (!pylon) throw new Error('Pylone ist in den aktuellen Mäherdaten nicht mehr vorhanden.');
    const requestedRuleId = body.ruleId ? String(body.ruleId) : null;
    const binding = this._resolvePylonRuleBinding(pylon, rules, requestedRuleId);
    const ruleId = requestedRuleId ? (binding.ruleId || requestedRuleId) : (binding.ruleId || id);
    const previous = rules[ruleId] || binding.rule || {};
    if (!ruleId) throw new Error('Pylonen-Zuordnung konnte nicht stabilisiert werden.');
    if (body.remove === true) {
      if (previous.nativeId != null && this._pylonRuleCanBind(previous, pylon)) throw new Error('Zuerst die Sperrzone dieser Pylone löschen.');
      rules[ruleId] = { ...previous, centerX:pylon.x, centerY:pylon.y, mapIndex:Number(this._activeMapIndex), hidden: true, hiddenByUser: true, updatedAt: Date.now() };
      this.log(`[pylon-diag] Homey pylon hidden id=${id} ruleId=${ruleId}`);
    } else {
      const action = 'observe';
      const radius = Math.max(500, Math.min(3000, Number(body.radius) || 500));
      rules[ruleId] = { ...previous, action, radius, centerX:pylon.x, centerY:pylon.y, mapIndex:Number(this._activeMapIndex), note: String(body.note || '').slice(0, 120), hidden: false, hiddenByUser: false, updatedAt: Date.now() };
      this.log(`[pylon-diag] Homey pylon rule id=${id} ruleId=${ruleId} action=${action} radius=${radius}mm enforcement=diagnostic_only`);
    }
    this._obstacleRulesCache = rules;
    await this.setStoreValue('obstacle_rules_v1', rules);
    return { ok: true, id, ruleId, rule: rules[ruleId] };
  }

  async _updatePylonForbiddenArea(body, rules) {
    const selectedId = String(body.id || '');
    const directNativeId = Number(body.nativeZoneId);
    const nativeHintId = Number(body.nativeHintId);
    const directNativeDelete = body.deleteForbidden === true && Number.isInteger(directNativeId) && directNativeId > 0;
    this.log('[pylon-native] request', body.deleteForbidden === true ? 'delete' : 'save',
      'id=', selectedId.slice(0, 64), directNativeDelete ? `nativeZone=${directNativeId}` : '');
    if (this._pylonNativeWriteBusy) throw new Error('Eine Kartenänderung läuft bereits.');
    if (!this._api) throw new Error('Mäher nicht verbunden.');
    if (body.deleteForbidden !== true && !this.getSetting('map_safe_mowing')) throw new Error('Bitte zuerst „Sicher mähen“ in den Geräteeinstellungen aktivieren.');

    const mapIndex = Number(this._activeMapIndex);
    if (!Number.isInteger(mapIndex) || mapIndex < 0) throw new Error('Aktive Karte unbekannt.');
    const pylon = directNativeDelete ? null : this._buildObstaclePylons().find((entry) => entry.id === selectedId);
    if (!directNativeDelete && (!pylon || pylon.coordinateScaleUncertain || pylon.source !== 'obs')) {
      throw new Error('Position dieser Pylone ist nicht sicher genug für eine native Sperrzone.');
    }
    const requestedRuleId = body.ruleId ? String(body.ruleId) : null;
    const binding = pylon
      ? this._resolvePylonRuleBinding(pylon, rules, requestedRuleId)
      : { ruleId:null, rule:null };
    const ruleId = pylon
      ? (requestedRuleId ? (binding.ruleId || requestedRuleId) : (binding.ruleId || selectedId))
      : null;
    let previous = pylon ? (rules[ruleId] || binding.rule || {}) : {};
    if (pylon && !ruleId) throw new Error('Pylonen-Zuordnung konnte nicht stabilisiert werden.');

    if (pylon && body.action === 'avoid' && body.deleteForbidden !== true) {
      const lifecycle = this._normalizePylonLifecycle(body.lifecycle ?? previous.lifecycle);
      const phaseLifecycle = ['departure','departure_mowing','mowing','mowing_return','return'].includes(lifecycle);
      if (!body.lifecycleInternal && body.lifecycle != null && phaseLifecycle && !this.getSetting('garage_mode_enabled')) {
        throw new Error('Fahrphasen-Sperrzonen benötigen einen aktivierten Garagenmodus.');
      }
      const timedDays = PYLON_TIMED_LIFECYCLE_DAYS[lifecycle] || 0;
      let lifecycleExpiresAt = null;
      if (timedDays) {
        const suppliedExpiry = Number(body.lifecycleExpiresAt || 0);
        if (body.lifecycleInternal && suppliedExpiry > 0) lifecycleExpiresAt = suppliedExpiry;
        else if (body.lifecycle != null) lifecycleExpiresAt = Date.now() + timedDays * 24 * 60 * 60 * 1000;
        else lifecycleExpiresAt = Number(previous.lifecycleExpiresAt || 0) || (Date.now() + timedDays * 24 * 60 * 60 * 1000);
      }
      const requestedRadiusCm = Number(body.radiusCm);
      if (!Number.isInteger(requestedRadiusCm) || requestedRadiusCm < 50 || requestedRadiusCm > 300) {
        throw new Error('Radius muss zwischen 50 und 300 cm liegen (mindestens 1 m Durchmesser).');
      }
      const requestedRadius = requestedRadiusCm * 10;
      const active = this._pylonLifecycleNativeActive(previous);
      const configured = {
        ...previous,
        centerX:pylon.x, centerY:pylon.y, mapIndex,
        radius:requestedRadius, note:String(body.note || previous.note || '').slice(0,120),
        lifecycle, lifecycleExpiresAt,
      };
      const lifecyclePhase = String(body.lifecyclePhase || this._currentPylonLifecyclePhase());
      const desired = this._pylonLifecycleDesiredActive(configured, lifecyclePhase);
      const geometryChanged = active && Number(previous.radius || requestedRadius) !== requestedRadius;

      // The A2 can acknowledge a map-edit transaction during motion without ever
      // publishing the requested geometry to current MAPD. Persist the user's
      // policy immediately, but defer the native write to a safe stationary
      // checkpoint instead of creating a permanent misleading Pending state.
      if (!desired || (!body.lifecycleInternal && !this._mapEditStationary())) {
        const transition = desired
          ? (!active ? 'activate' : (geometryChanged ? 'update' : null))
          : (active ? 'deactivate' : null);
        rules[ruleId] = {
          ...configured,
          action:active ? 'avoid' : 'observe',
          lifecycleSuspended:!desired && !active,
          lifecycleTransitionPending:transition,
          verification:transition ? 'lifecycle_transition_deferred' : (previous.verification || 'lifecycle_configured_inactive'),
          verificationAt:Date.now(), updatedAt:Date.now(),
        };
        this._obstacleRulesCache = rules;
        await this.setStoreValue('obstacle_rules_v1', rules);
        this._pylonUiRevision = Number(this._pylonUiRevision || 0) + 1;
        if (this._mapEditStationary() && transition) this._schedulePylonLifecycleSync(lifecyclePhase, 'user_save');
        this._scheduleMapCameraImageUpdate();
        return { ok:true, id:selectedId, ruleId, rule:rules[ruleId], pending:false, deferred:!!transition };
      }

      // Note/lifecycle-only changes do not need another native map transaction
      // when the confirmed square already has the requested geometry.
      if (active && !geometryChanged) {
        rules[ruleId] = {
          ...configured, action:'avoid', lifecycleSuspended:false,
          lifecycleTransitionPending:null, updatedAt:Date.now(),
        };
        this._obstacleRulesCache = rules;
        await this.setStoreValue('obstacle_rules_v1', rules);
        this._pylonUiRevision = Number(this._pylonUiRevision || 0) + 1;
        this._scheduleMapCameraImageUpdate();
        return { ok:true, id:selectedId, ruleId, rule:rules[ruleId], pending:false };
      }
      previous = configured;
    }

    if (previous.nativeId != null && Number(previous.mapIndex) !== mapIndex) {
      throw new Error('Die Sperrzone gehört zu einer anderen Karte.');
    }
    if (previous.pending) throw new Error('Vorherige Kartenänderung ist noch nicht bestätigt. Weitere Änderungen an dieser Pylone sind gesperrt.');

    const did = this.getData().id;
    this._pylonNativeWriteBusy = true;
    try {
      const readMap = async (allowMAPIFallback = false) => {
        // 1.2.44: edit preflight must use the same current mower truth that now
        // drives confirmation. Field logs proved MAP.* can remain several edits
        // behind while MAPI/MAPD already contains the accepted create/delete.
        // Reading stale cloud geometry here caused both false "no matching zone"
        // errors and stale beforeIds/provisional-id collisions.
        let directError = null;
        if (typeof this._api.getDirectMapSnapshot === 'function') {
          try {
            let timeoutId;
            const snapshot = await Promise.race([
              this._api.getDirectMapSnapshot(did, mapIndex, { chunkSize:400, attempts:2 }),
              new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('Direct MAPD timeout')), 15000); }),
            ]).finally(() => clearTimeout(timeoutId));
            const direct = this._parseAppActionMapPayload(snapshot, this._cachedMapData);
            if (direct?.directMapdGeometryVerified === true
                && direct?.mowingAreas?.length && Array.isArray(direct.forbiddenAreas)) {
              this._logNativeForbiddenReadOnly(direct, 'MAPD-edit-readback');
              this.log('[pylon-native] using current direct MAPD for edit preflight',
                `authority=${direct.directMapdAuthority || 'verified'}`,
                `zones=${direct.forbiddenAreas.length}`,
                `candidates=${Array.isArray(direct.directMapdCandidateIds) ? direct.directMapdCandidateIds.join(',') : '-'}`);
              return direct;
            }
            directError = new Error('Direkte Mäherkarte war nicht geometrisch verifiziert.');
          } catch (err) {
            directError = err;
            this.log('[pylon-native] direct MAPD edit preflight unavailable:', err.message);
          }
        }

        // Compatibility fallback for regions/models without a verified direct
        // map schema. Never prefer this stale cloud path over verified g2408 MAPD.
        // Never let a complete MAP.* read be overwritten by a stale MAPI snapshot.
        let rawError = null;
        try {
          let timeoutId;
          const raw = await Promise.race([
            this._api.getRawProperties(did),
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error('Zeitüberschreitung beim Lesen der Mäherkarte.')), 20000);
            }),
          ]).finally(() => clearTimeout(timeoutId));
          const data = raw?.data;
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            const map = this._parseMapDataChunks(data);
            if (map?.mowingAreas?.length && Array.isArray(map.forbiddenAreas)) {
              this._logNativeForbiddenReadOnly(map, 'MAP-readback');
              this.log('[pylon-native] using cloud MAP.* edit preflight fallback');
              return map;
            }
          }
          rawError = new Error('Vollständige native MAP-Karte fehlt.');
        } catch (err) { rawError = err; }

        if (allowMAPIFallback && typeof this._api.getMAPI === 'function') {
          try {
            let timeoutId;
            const mapi = await Promise.race([
              this._api.getMAPI(did, mapIndex),
              new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('MAPI timeout')), 8000); }),
            ]).finally(() => clearTimeout(timeoutId));
            const direct = this._parseDirectMapData(mapi);
            if (direct?.mowingAreas?.length && Array.isArray(direct.forbiddenAreas)) {
              this._logNativeForbiddenReadOnly(direct, 'MAPI-fallback');
              this.log('[pylon-native] using legacy MAPI edit preflight fallback');
              // using MAPI only because complete MAP.* readback was unavailable
              return direct;
            }
          } catch (err) { this.log('[pylon-native] MAPI readback unavailable:', err.message); }
        }
        throw rawError || directError || new Error('Vollständige native Karte fehlt.');
      };

      this.log('[pylon-native] checking current manufacturer map');
      const before = await readMap(true);
      const entries = (map) => map.forbiddenAreas.map((e) => ({ id: Number(Array.isArray(e) ? e[0] : e?.id), area: Array.isArray(e) ? e[1] : e }));
      const old = entries(before);
      // Read-only revision checkpoint. A later MAPI hash/size change proves the
      // mower committed a new map revision, but never substitutes for geometry
      // confirmation. This lets us distinguish write progress from stale MAP.*.
      const mapRevisionBefore = await this._captureNativeMapRevision(did, mapIndex);

      // A red native zone is an edit target in its own right. This is essential
      // when Dreame has renumbered/removed the OBS pylon that originally created
      // it: the user can still click the real square and remove the real map
      // object without relying on a stale obs:* identifier.
      if (directNativeDelete) {
        const target = old.find((entry) => entry.id === directNativeId);
        if (!target) throw new Error(`Native Sperrzone #${directNativeId} ist in der aktuellen Mäherkarte nicht mehr vorhanden.`);
        let result;
        if (typeof this._api.deleteForbiddenAreas === 'function') {
          result = await this._api.deleteForbiddenAreas(did, [directNativeId], mapIndex, this._pylonMapEditTaskOptions());
        } else {
          result = await this._api.deleteForbiddenArea(did, directNativeId, mapIndex, this._pylonMapEditTaskOptions());
        }
        this.log('[pylon-native] direct native delete transaction', `nativeId=${directNativeId}`,
          JSON.stringify((result?.legs || []).map((leg) => ({ name:leg.name, accepted:leg.accepted, taskAck:leg.taskAck }))));
        const answer = result?.result?.out?.[0];
        if (answer?.status === false || Number(answer?.error || 0) !== 0) throw new Error('Mäher hat das Löschen abgelehnt.');

        const affectedRuleIds = [];
        for (const [key, rule] of Object.entries(rules)) {
          if (!rule || (Number.isInteger(Number(rule.mapIndex)) && Number(rule.mapIndex) !== mapIndex)) continue;
          const ids = new Set(Array.isArray(rule.nativeMatchIds) ? rule.nativeMatchIds.map(Number) : []);
          if (Number.isInteger(Number(rule.nativeId))) ids.add(Number(rule.nativeId));
          if (!ids.has(directNativeId)) continue;
          // Direct native-zone editing must never turn a Homey pylon rule into a
          // persistent pending lock. The red MAP.* object is the authority here;
          // keep the rule usable until the native id actually disappears.
          rules[key] = { ...rule, directNativeDeleteRequestedAt:Date.now(),
            verification:'native_direct_delete_requested', verificationAt:Date.now() };
          affectedRuleIds.push(key);
        }
        if (body.preserveNativeMetadata !== true) {
          await this._rememberNativeZoneLabelDeleteWatch(directNativeId, target.area, mapIndex, { mapRevisionBefore });
          await this._removeNativeZonePolicyFor(directNativeId, target.area, mapIndex);
        }
        if (!this._directNativeDeleteUi) this._directNativeDeleteUi = new Map();
        this._directNativeDeleteUi.set(directNativeId, { updatedAt:Date.now(), mapIndex, affectedRuleIds, mapRevisionBefore });
        this._obstacleRulesCache = rules;
        await this.setStoreValue('obstacle_rules_v1', rules);
        this._pylonUiRevision = Number(this._pylonUiRevision || 0) + 1;
        this._scheduleDirectNativeDeleteReadback(directNativeId);
        this._requestMowerMapPublish('native-zone-delete-accepted').catch(() => {});
        this.log('[pylon-native] direct native deletion accepted; readback pending',
          `nativeId=${directNativeId}`, `affectedRules=${affectedRuleIds.join(',') || 'none'}`);
        return { ok:true, id:selectedId, nativeZoneId:directNativeId, nativeDirect:true, pending:true };
      }

      if (body.deleteForbidden === true) {
        let nativeId = Number(previous.nativeId);
        let deleteRule = previous;
        const preferredRadiusMm = Number(previous.radius) || (Number(body.radiusCm) * 10) || null;
        const geometryMatches = this._nativeSquareCandidatesForPylon(old, pylon, preferredRadiusMm);
        const knownManagedIds = new Set(Array.isArray(previous.nativeMatchIds)
          ? previous.nativeMatchIds.map(Number).filter(Number.isInteger) : []);
        if (Number.isInteger(Number(previous.nativeId))) knownManagedIds.add(Number(previous.nativeId));
        if (Number.isInteger(Number(previous.nativeCandidateId))) knownManagedIds.add(Number(previous.nativeCandidateId));
        let managedGeometryMatches = geometryMatches.filter((entry) => knownManagedIds.has(entry.id));
        // A pending/timed-out Homey create may not yet know the final id. In
        // that case only a geometrically matching id that did not exist before
        // the Homey write may be recovered as managed ownership.
        if (!managedGeometryMatches.length && Array.isArray(previous.beforeIds)
            && Number(previous.nativeWriteVersion || 0) >= 3) {
          const beforeIds = new Set(previous.beforeIds.map(Number));
          managedGeometryMatches = geometryMatches.filter((entry) => !beforeIds.has(entry.id));
        }
        let ownedEntry = Number.isInteger(nativeId)
          ? managedGeometryMatches.find((e) => e.id === nativeId)
          : null;
        if (!ownedEntry && Number.isInteger(nativeHintId) && nativeHintId > 0 && knownManagedIds.has(nativeHintId)) {
          ownedEntry = managedGeometryMatches.find((e) => e.id === nativeHintId) || null;
        }
        if (!ownedEntry) {
          const candidateId = Number(previous.nativeCandidateId);
          ownedEntry = Number.isInteger(candidateId) ? managedGeometryMatches.find((e) => e.id === candidateId) : null;
          if (!ownedEntry && managedGeometryMatches.length) ownedEntry = managedGeometryMatches[0];
        }
        if (ownedEntry) {
          nativeId = ownedEntry.id;
          const matchIds = managedGeometryMatches.map((e) => e.id).sort((a,b)=>a-b);
          deleteRule = { ...previous, nativeId, nativeMatchIds:matchIds,
            radius:Number(previous.radius) || Number(ownedEntry.radius) || 500,
            nativeWriteVersion:Math.max(6, Number(previous.nativeWriteVersion || 0)),
            nativeBindingVersion:3, action:'avoid', centerX:pylon.x, centerY:pylon.y, mapIndex,
            verification:previous.verification || 'native_geometry_adopted_for_delete', verificationAt:Date.now() };
          rules[ruleId] = deleteRule;
          this._obstacleRulesCache = rules;
          await this.setStoreValue('obstacle_rules_v1', rules);
          this.log('[pylon-native] recovered late native ownership for delete (geometry)',
            `id=${selectedId.slice(0,64)}`, `ruleId=${ruleId}`, `nativeId=${nativeId}`, `matches=${matchIds.join(',')}`);
        }
        if (!ownedEntry) throw new Error('Keine zu diesem Pylon passende native Sperrzone gefunden. Rote Sperrzone direkt in der Karte auswählen.');

        const managedIds = new Set(Array.isArray(deleteRule.nativeMatchIds)
          ? deleteRule.nativeMatchIds.map(Number).filter(Number.isInteger) : []);
        managedIds.add(Number(nativeId));
        // Delete all geometrically overlapping Homey-sized squares at this
        // pylon. This also cleans up duplicates created by older builds while
        // never relying on a recyclable OBS id.
        const deleteIds = managedGeometryMatches
          .filter((e) => managedIds.has(Number(e.id)))
          .map((e) => Number(e.id)).filter(Number.isInteger).sort((a,b) => a-b);
        if (!deleteIds.length) deleteIds.push(Number(nativeId));

        this.log('[pylon-native] deleting owned native no-go zone(s)', deleteIds.join(','), `ruleId=${ruleId}`);
        let result;
        if (typeof this._api.deleteForbiddenAreas === 'function') {
          result = await this._api.deleteForbiddenAreas(did, deleteIds, mapIndex, this._pylonMapEditTaskOptions());
        } else {
          for (const deleteId of deleteIds) {
            result = await this._api.deleteForbiddenArea(did, deleteId, mapIndex, this._pylonMapEditTaskOptions());
          }
        }
        this.log('[pylon-native] delete transaction', JSON.stringify((result?.legs || []).map((leg) => ({ name:leg.name, accepted:leg.accepted, taskAck:leg.taskAck }))));
        const answer = result?.result?.out?.[0];
        if (answer?.status === false || Number(answer?.error || 0) !== 0) throw new Error('Mäher hat das Löschen abgelehnt.');
        rules[ruleId] = { ...deleteRule, centerX:pylon.x, centerY:pylon.y, mapIndex,
          nativeId, nativeMatchIds:deleteIds, pendingDeleteIds:deleteIds,
          pending:'delete', verification:null, verificationAt:null, mapRevisionBefore,
          mapRevisionAfter:null, mapRevisionAdvancedAt:null, updatedAt:Date.now() };
        this._obstacleRulesCache = rules;
        await this.setStoreValue('obstacle_rules_v1', rules);
        this.log('[pylon-native] deletion accepted; native readback pending', `mapIndex=${mapIndex}`, `ruleId=${ruleId}`);
        this._requestMowerMapPublish('pylon-delete-accepted').catch(() => {});
        this._schedulePendingPylonReadback(ruleId);
        return { ok:true, id:selectedId, ruleId, rule:rules[ruleId], pending:true };
      }

      const radiusCm = Number(body.radiusCm);
      if (!Number.isInteger(radiusCm) || radiusCm < 50 || radiusCm > 300) throw new Error('Radius muss zwischen 50 und 300 cm liegen (mindestens 1 m Durchmesser).');
      const radiusMm = radiusCm * 10;
      let nativeId = previous.nativeId == null ? -1 : Number(previous.nativeId);
      const currentGeometryMatches = this._nativeSquareCandidatesForPylon(old, pylon, radiusMm);
      const hintedEntry = Number.isInteger(nativeHintId) && nativeHintId > 0
        ? currentGeometryMatches.find((entry) => entry.id === nativeHintId) : null;
      const storedEntry = nativeId !== -1 ? currentGeometryMatches.find((entry) => entry.id === nativeId) : null;

      if (nativeId !== -1 && !storedEntry) {
        // A recycled OBS id must never force the new physical pylon to update an
        // unrelated old native square. Detach the stale local relation, but do
        // not immediately create a duplicate: the geometry scan below may find
        // the real square under another native id.
        this.log('[pylon-native] stale pylon/native binding detached before save',
          `id=${selectedId.slice(0,64)}`, `ruleId=${ruleId}`, `storedNativeId=${nativeId}`);
        previous = { ...previous, nativeId:null, nativeCandidateId:null, nativeMatchIds:[], pendingDeleteIds:[],
          verification:'native_binding_mismatch_detached', verificationAt:Date.now() };
        nativeId = -1;
      }

      // If the frontend supplied a native hint, only use it when it already
      // belongs to this Homey rule. Unknown native squares are never silently
      // claimed; they remain available through the direct red-zone editor.
      if (nativeId === -1 && hintedEntry && Number.isInteger(Number(previous.nativeId))
          && Number(previous.nativeId) === hintedEntry.id) {
        nativeId = hintedEntry.id;
      }

      if (nativeId === -1 && ['native_create_unconfirmed_timeout','native_create_unconfirmed_retryable'].includes(previous.verification)) {
        const ownedIds = new Set(Object.entries(rules)
          .filter(([otherId, rule]) => otherId !== ruleId && rule?.nativeId != null)
          .map(([, rule]) => Number(rule.nativeId)));
        const lateMatches = this._nativeSquareCandidatesForPylon(old.filter((entry) => !ownedIds.has(entry.id)), pylon, radiusMm);
        const candidateId = Number(previous.nativeCandidateId);
        const preferred = Number.isInteger(candidateId) ? lateMatches.find((entry) => entry.id === candidateId) : null;
        const chosen = preferred || lateMatches[0] || null;
        if (chosen) {
          rules[ruleId] = { ...previous, nativeId:chosen.id, nativeCandidateId:null, pending:null, beforeIds:null,
            nativeMatchIds:lateMatches.map((entry)=>entry.id).sort((a,b)=>a-b),
            action:'avoid', radius:radiusMm, centerX:pylon.x, centerY:pylon.y, mapIndex,
            nativeWriteVersion:Math.max(6, Number(previous.nativeWriteVersion || 0)), nativeBindingVersion:3,
            verification:'native_late_create_adopted', verificationAt:Date.now(), updatedAt:Date.now() };
          this._obstacleRulesCache = rules;
          await this.setStoreValue('obstacle_rules_v1', rules);
          this.log('[pylon-native] adopted late native square after timeout',
            `id=${selectedId.slice(0,64)}`, `ruleId=${ruleId}`, `nativeId=${chosen.id}`, `matches=${lateMatches.map((entry)=>entry.id).join(',')}`);
          return { ok:true, id:selectedId, ruleId, rule:rules[ruleId], adopted:true, nativeConfirmed:true };
        }
      }

      const center = { x:Math.round(pylon.x) / 1000, y:Math.round(pylon.y) / 1000 };
      const halfM = radiusCm / 100;
      const pointsM = [
        [center.x-halfM, center.y-halfM], [center.x+halfM, center.y-halfM],
        [center.x+halfM, center.y+halfM], [center.x-halfM, center.y+halfM],
      ];
      this.log('[pylon-native] writing native square', nativeId === -1 ? 'new' : 'update',
        `map=${mapIndex}`, `centerM=${center.x},${center.y}`, 'radiusCm=', radiusCm,
        `sizeM=${(halfM*2).toFixed(3)}x${(halfM*2).toFixed(3)}`, `ruleId=${ruleId}`);
      const result = await this._api.setForbiddenPolygon(did, pointsM, nativeId, mapIndex, this._pylonMapEditTaskOptions());
      this.log('[pylon-native] create transaction', JSON.stringify((result?.legs || []).map((leg) => ({ name:leg.name, accepted:leg.accepted, taskAck:leg.taskAck }))));
      const answer = result?.result?.out?.[0];
      if (answer?.status === false || Number(answer?.error || 0) !== 0) throw new Error('Mäher hat die Sperrzone abgelehnt.');
      const mutationTask = (result?.legs || []).find((leg) => leg?.name === 'mutation')?.task;
      const assignedNativeId = Number(mutationTask?.d?.id);
      const beforeIds = old.map((e)=>e.id);
      const candidateIsNew = Number.isInteger(assignedNativeId) && assignedNativeId > 0 && !beforeIds.includes(assignedNativeId);
      if (Number.isInteger(assignedNativeId) && assignedNativeId > 0) {
        if (candidateIsNew) this.log('[pylon-native] mower assigned provisional native id', assignedNativeId);
        else this.log('[pylon-native] ignored colliding provisional native id already present before write', assignedNativeId);
      }
      // Legacy stores may contain nativeBindingVersion:2; new writes use 3
      // because native-id geometry now takes precedence over stale OBS anchors.
      rules[ruleId] = { ...previous, pending:'create', beforeIds,
        centerX:pylon.x, centerY:pylon.y, mapIndex, radius:radiusCm*10,
        note:String(body.note || previous.note || '').slice(0,120), action:'observe',
        lifecycleSuspended:false, lifecycleTransitionPending:null,
        nativeWriteVersion:6, nativeWriteProtocol:'map_edit_polygon_square_m_task_serialized_map_readback', nativeBindingVersion:3,
        nativeCandidateId:candidateIsNew ? assignedNativeId : null,
        verification:null, verificationAt:null, mapRevisionBefore,
        mapRevisionAfter:null, mapRevisionAdvancedAt:null, updatedAt:Date.now() };
      // Publish the new pending state before any delayed verifier is armed.
      this._obstacleRulesCache = rules;
      await this.setStoreValue('obstacle_rules_v1', rules);
      this.log('[pylon-native] square accepted; native readback pending', `mapIndex=${mapIndex}`,
        `candidate=${rules[ruleId].nativeCandidateId ?? 'none'}`, `ruleId=${ruleId}`);
      this._requestMowerMapPublish('pylon-create-accepted').catch(() => {});
      this._schedulePendingPylonReadback(ruleId);
      const id = selectedId;
      if (ruleId === id) return { ok: true, id, rule: rules[id], pending: true };
      return { ok:true, id:selectedId, ruleId, rule:rules[ruleId], pending:true };
    } finally {
      this._obstacleRulesCache = rules;
      this._pylonNativeWriteBusy = false;
    }
  }

  _nativeForbiddenShape(area) {
    const value = area?.shapeType ?? area?.shape ?? area?.type;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  _nativeCircleMatchMetrics(area, pylon, radiusMm) {
    if (!area || !pylon) return { matched: false, reason: 'missing_area_or_pylon' };
    const expectedRadius = Number(radiusMm);
    if (!Number.isFinite(expectedRadius) || expectedRadius <= 0) return { matched: false, reason: 'invalid_expected_radius' };

    // MAP chunks often expose a circle as an expanded perimeter path in map-mm.
    const pts = area?.path;
    if (Array.isArray(pts) && pts.length >= 8
        && pts.every((pt) => Number.isFinite(Number(pt?.x)) && Number.isFinite(Number(pt?.y)))) {
      const xs = pts.map((pt) => Number(pt.x)), ys = pts.map((pt) => Number(pt.y));
      const rawCx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const rawCy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const rawRadius = (Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)) / 4;
      const options = [
        { scale: 1, representation: 'path_mm' },
        { scale: 10, representation: 'path_cm_x10' },
        { scale: 1000, representation: 'path_m_x1000' },
      ].map((option) => {
        const cx = rawCx * option.scale;
        const cy = rawCy * option.scale;
        const measured = rawRadius * option.scale;
        return {
          ...option,
          centerDelta: Math.hypot(cx - Number(pylon.x), cy - Number(pylon.y)),
          radiusDelta: Math.abs(measured - expectedRadius),
          measuredRadius: measured,
        };
      }).sort((a, b) => (a.centerDelta + a.radiusDelta) - (b.centerDelta + b.radiusDelta));
      const best = options[0];
      return { ...best, matched: best.centerDelta <= 120 && best.radiusDelta <= 120 };
    }

    // Direct MAPI readback can preserve the manufacturer's circle command form
    // instead: one center point plus radius. Firmware/cloud variants have exposed
    // this either as map-mm, centimetres or the native edit-frame metres. Accept a
    // scale only when both center AND radius unambiguously fit the known pylon.
    const directPoint = (() => {
      const points = Array.isArray(area?.points) ? area.points : null;
      const first = points?.[0];
      if (Array.isArray(first) && Number.isFinite(Number(first[0])) && Number.isFinite(Number(first[1]))) {
        return { x: Number(first[0]), y: Number(first[1]) };
      }
      if (first && Number.isFinite(Number(first.x)) && Number.isFinite(Number(first.y))) {
        return { x: Number(first.x), y: Number(first.y) };
      }
      const center = area?.center || area?.centre || area?.centerPoint;
      if (Array.isArray(center) && Number.isFinite(Number(center[0])) && Number.isFinite(Number(center[1]))) {
        return { x: Number(center[0]), y: Number(center[1]) };
      }
      if (center && Number.isFinite(Number(center.x)) && Number.isFinite(Number(center.y))) {
        return { x: Number(center.x), y: Number(center.y) };
      }
      if (Number.isFinite(Number(area?.x)) && Number.isFinite(Number(area?.y))) {
        return { x: Number(area.x), y: Number(area.y) };
      }
      return null;
    })();
    const rawRadius = Number(area?.radius ?? area?.r);
    if (!directPoint || !Number.isFinite(rawRadius) || rawRadius <= 0) {
      return { matched: false, reason: 'unsupported_circle_representation' };
    }
    const options = [
      { scale: 1, representation: 'direct_mm' },
      { scale: 10, representation: 'direct_cm_x10' },
      { scale: 1000, representation: 'direct_m_x1000' },
    ].map((option) => {
      const cx = directPoint.x * option.scale;
      const cy = directPoint.y * option.scale;
      const measured = rawRadius * option.scale;
      return {
        ...option,
        centerDelta: Math.hypot(cx - Number(pylon.x), cy - Number(pylon.y)),
        radiusDelta: Math.abs(measured - expectedRadius),
        measuredRadius: measured,
      };
    }).sort((a, b) => (a.centerDelta + a.radiusDelta) - (b.centerDelta + b.radiusDelta));
    const best = options[0];
    return { ...best, matched: best.centerDelta <= 120 && best.radiusDelta <= 120 };
  }

  _nativeCircleMatchesPylon(area, pylon, radiusMm) {
    return this._nativeCircleMatchMetrics(area, pylon, radiusMm).matched === true;
  }

  _nativeSquareMatchMetrics(area, pylon, radiusMm) {
    if (!area || !pylon) return { matched: false, reason: 'missing_area_or_pylon' };
    const expectedHalf = Number(radiusMm);
    if (!Number.isFinite(expectedHalf) || expectedHalf <= 0) return { matched: false, reason: 'invalid_expected_radius' };
    const source = (() => {
      if (Array.isArray(area?.path) && area.path.length >= 4) {
        return area.path.map((pt) => Array.isArray(pt) ? [Number(pt[0]), Number(pt[1])] : [Number(pt?.x), Number(pt?.y)]);
      }
      if (Array.isArray(area?.points) && area.points.length >= 4) {
        return area.points.map((pt) => Array.isArray(pt) ? [Number(pt[0]), Number(pt[1])] : [Number(pt?.x), Number(pt?.y)]);
      }
      if (Array.isArray(area?.polygon) && area.polygon.length >= 4) {
        return area.polygon.map((pt) => Array.isArray(pt) ? [Number(pt[0]), Number(pt[1])] : [Number(pt?.x), Number(pt?.y)]);
      }
      return null;
    })();
    if (!source || !source.every((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]))) {
      return { matched: false, reason: 'unsupported_polygon_representation' };
    }
    const xs = source.map((pt) => pt[0]);
    const ys = source.map((pt) => pt[1]);
    const rawCx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const rawCy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const rawHalfX = (Math.max(...xs) - Math.min(...xs)) / 2;
    const rawHalfY = (Math.max(...ys) - Math.min(...ys)) / 2;
    const options = [
      { scale: 1, representation: 'polygon_mm' },
      { scale: 10, representation: 'polygon_cm_x10' },
      { scale: 1000, representation: 'polygon_m_x1000' },
    ].map((option) => {
      const cx = rawCx * option.scale;
      const cy = rawCy * option.scale;
      const halfX = rawHalfX * option.scale;
      const halfY = rawHalfY * option.scale;
      return {
        ...option,
        centerDelta: Math.hypot(cx - Number(pylon.x), cy - Number(pylon.y)),
        radiusDelta: Math.max(Math.abs(halfX - expectedHalf), Math.abs(halfY - expectedHalf)),
        measuredHalfX: halfX,
        measuredHalfY: halfY,
      };
    }).sort((a, b) => (a.centerDelta + a.radiusDelta) - (b.centerDelta + b.radiusDelta));
    const best = options[0];
    return { ...best, matched: best.centerDelta <= 120 && best.radiusDelta <= 120 };
  }

  _nativeSquareMatchesPylon(area, pylon, radiusMm) {
    return this._nativeSquareMatchMetrics(area, pylon, radiusMm).matched === true;
  }

  _nativeSquareAnyRadiusMetrics(area, pylon) {
    if (!area || !pylon || this._nativeForbiddenShape(area) !== 2) {
      return { matched:false, reason:'not_square_or_missing' };
    }
    let best = null;
    // Homey's pylon editor allows 50..300 cm radius (half-size). Probe that
    // range coarsely; the native matcher itself tolerates 120 mm, so a 50 mm
    // step is more than sufficient and avoids depending on the stored rule.
    for (let radius = 500; radius <= 3000; radius += 50) {
      const metrics = this._nativeSquareMatchMetrics(area, pylon, radius);
      if (!metrics || !Number.isFinite(Number(metrics.centerDelta))) continue;
      const score = Number(metrics.centerDelta || 0) + Number(metrics.radiusDelta || 0);
      if (!best || score < best.score) best = { ...metrics, radius, score };
    }
    return best || { matched:false, reason:'no_square_metrics' };
  }

  _nativeSquareCandidatesForPylon(entries, pylon, preferredRadiusMm = null) {
    const list = Array.isArray(entries) ? entries : [];
    const preferred = Number(preferredRadiusMm);
    const out = [];
    for (const entry of list) {
      const area = entry?.area ?? (Array.isArray(entry) ? entry[1] : null);
      const id = Number(entry?.id ?? (Array.isArray(entry) ? entry[0] : null));
      if (!Number.isInteger(id) || id <= 0 || this._nativeForbiddenShape(area) !== 2) continue;
      let metrics = Number.isFinite(preferred) && preferred > 0
        ? this._nativeSquareMatchMetrics(area, pylon, preferred)
        : this._nativeSquareAnyRadiusMetrics(area, pylon);
      if (!metrics?.matched && Number.isFinite(preferred) && preferred > 0) {
        // Radius may have changed in the editor. Still detect a square at the
        // same physical pylon so Save can update it instead of creating a duplicate.
        const any = this._nativeSquareAnyRadiusMetrics(area, pylon);
        if (any?.matched) metrics = { ...any, preferredRadiusMatched:false };
      }
      if (metrics?.matched) out.push({ id, area, metrics, radius:Number(metrics.radius || preferred || 500) });
    }
    out.sort((a,b) => {
      const da = Number(a.metrics?.centerDelta || 0) + Number(a.metrics?.radiusDelta || 0);
      const db = Number(b.metrics?.centerDelta || 0) + Number(b.metrics?.radiusDelta || 0);
      return da - db || b.id - a.id;
    });
    return out;
  }

  _nativePylonZoneMatches(area, pylon, rule = {}) {
    const shape = this._nativeForbiddenShape(area);
    const radius = Number(rule?.radius);
    const version = Number(rule?.nativeWriteVersion || 0);
    if (version >= 3) return shape === 2 && this._nativeSquareMatchesPylon(area, pylon, radius);
    return shape === 3 && this._nativeCircleMatchesPylon(area, pylon, radius);
  }

  _logPylonReadbackSummary(stage, areas, pylon, radiusMm, previousIds = []) {
    try {
      const rows = (areas || []).slice(0, 40).map((entry) => {
        const id = Number(entry.id);
        const shape = this._nativeForbiddenShape(entry.area);
        const metrics = shape === 2
          ? this._nativeSquareMatchMetrics(entry.area, pylon, radiusMm)
          : shape === 3 ? this._nativeCircleMatchMetrics(entry.area, pylon, radiusMm) : null;
        return {
          id: Number.isFinite(id) ? id : null,
          shape,
          old: previousIds.includes(id),
          repr: metrics?.representation || metrics?.reason || null,
          centerDeltaMm: Number.isFinite(metrics?.centerDelta) ? Math.round(metrics.centerDelta) : null,
          radiusDeltaMm: Number.isFinite(metrics?.radiusDelta) ? Math.round(metrics.radiusDelta) : null,
          match: metrics?.matched === true,
        };
      });
      this.log('[pylon-native] readback summary', stage, JSON.stringify({ mapIndex: this._activeMapIndex, count: (areas || []).length, rows }));
    } catch (e) {
      this.log('[pylon-native] readback summary failed', stage, e.message);
    }
  }


  _clearPendingPylonReadback(id) {
    if (!id || !this._pendingPylonReadbackTimers) return;
    const timers = this._pendingPylonReadbackTimers.get(id) || [];
    timers.forEach((timer) => {
      try { this.homey?.clearTimeout ? this.homey.clearTimeout(timer) : clearTimeout(timer); } catch (_) {}
    });
    this._pendingPylonReadbackTimers.delete(id);
  }

  _schedulePendingPylonReadback(id) {
    if (!id) return;
    if (!this._pendingPylonReadbackTimers) this._pendingPylonReadbackTimers = new Map();
    this._clearPendingPylonReadback(id);
    const timers = [];
    const ruleAtSchedule = this._obstacleRulesCache?.[id];
    if (!ruleAtSchedule?.pending) return;
    const startedAt = Number(ruleAtSchedule.updatedAt || 0);
    const age = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
    const deadlines = [2000, 5000, 15000, 35000, 75000, 120000, 150000, 180000,
      210000, 240000, 270000, 300000, 330000, 360000, 420000, PYLON_PENDING_TIMEOUT_MS];

    const arm = (delay, label) => {
      const cb = async () => {
        const rule = this._obstacleRulesCache?.[id];
        if (!rule?.pending) return;
        this.log('[pylon-native] delayed readback', `id=${String(id).slice(0,64)}`,
          label, `age=${Date.now() - Number(rule.updatedAt || Date.now())}ms`);
        try { await this.refreshMapData(); } catch (e) { this.log('[pylon-native] delayed readback failed:', e.message); }
      };
      const timer = this.homey?.setTimeout ? this.homey.setTimeout(cb, Math.max(150, delay)) : setTimeout(cb, Math.max(150, delay));
      timer?.unref?.();
      timers.push(timer);
    };

    for (const deadline of deadlines) {
      if (deadline > age || deadline === PYLON_PENDING_TIMEOUT_MS) {
        arm(deadline - age, `deadline=${deadline}ms`);
      }
    }

    // After the dense first eight minutes, keep one low-frequency read-only
    // verifier alive until native geometry actually confirms the create/delete.
    // This specifically covers the A2 cloud lag where MAP.* updates only after
    // the vendor map screen has been opened. No map-write is retried here.
    const armPersistent = (delay) => {
      let timer = null;
      const cb = async () => {
        const pos = timers.indexOf(timer);
        if (pos >= 0) timers.splice(pos, 1);
        const rule = this._obstacleRulesCache?.[id];
        if (!rule?.pending) return;
        this.log('[pylon-native] persistent geometry readback', `id=${String(id).slice(0,64)}`,
          `pending=${rule.pending}`, `age=${Date.now() - Number(rule.updatedAt || Date.now())}ms`);
        try { await this.refreshMapData(); } catch (e) { this.log('[pylon-native] persistent readback failed:', e.message); }
        if (this._obstacleRulesCache?.[id]?.pending) armPersistent(PYLON_PENDING_RECHECK_MS);
      };
      timer = this.homey?.setTimeout ? this.homey.setTimeout(cb, Math.max(150, delay)) : setTimeout(cb, Math.max(150, delay));
      timer?.unref?.();
      timers.push(timer);
    };
    const firstPersistentAt = PYLON_PENDING_TIMEOUT_MS + PYLON_PENDING_RECHECK_MS;
    armPersistent(Math.max(150, firstPersistentAt - age));
    this._pendingPylonReadbackTimers.set(id, timers);
  }

  _clearDirectNativeDeleteReadback(nativeId) {
    const id = Number(nativeId);
    if (!Number.isInteger(id) || !this._directNativeDeleteTimers) return;
    const timers = this._directNativeDeleteTimers.get(id) || [];
    timers.forEach((timer) => {
      try { this.homey?.clearTimeout ? this.homey.clearTimeout(timer) : clearTimeout(timer); } catch (_) {}
    });
    this._directNativeDeleteTimers.delete(id);
  }

  _scheduleDirectNativeDeleteReadback(nativeId) {
    const id = Number(nativeId);
    if (!Number.isInteger(id) || id <= 0) return;
    if (!this._directNativeDeleteTimers) this._directNativeDeleteTimers = new Map();
    this._clearDirectNativeDeleteReadback(id);
    const timers = [];
    const opAtSchedule = this._directNativeDeleteUi instanceof Map ? this._directNativeDeleteUi.get(id) : null;
    if (!opAtSchedule) return;
    const startedAt = Number(opAtSchedule.updatedAt || 0);
    const age = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
    const deadlines = [2000, 5000, 15000, 35000, 75000, 120000, 180000, 300000, PYLON_PENDING_TIMEOUT_MS];

    const arm = (delay, label) => {
      const cb = async () => {
        if (!(this._directNativeDeleteUi instanceof Map) || !this._directNativeDeleteUi.has(id)) return;
        this.log('[pylon-native] direct native delete readback', `nativeId=${id}`, label,
          `age=${Date.now() - Number(this._directNativeDeleteUi.get(id)?.updatedAt || Date.now())}ms`);
        try { await this.refreshMapData(); } catch (e) { this.log('[pylon-native] direct delete readback failed:', e.message); }
      };
      const timer = this.homey?.setTimeout ? this.homey.setTimeout(cb, Math.max(150, delay)) : setTimeout(cb, Math.max(150, delay));
      timer?.unref?.();
      timers.push(timer);
    };
    for (const deadline of deadlines) {
      if (deadline > age || deadline === PYLON_PENDING_TIMEOUT_MS) arm(deadline - age, `deadline=${deadline}ms`);
    }

    const armPersistent = (delay) => {
      let timer = null;
      const cb = async () => {
        const pos = timers.indexOf(timer);
        if (pos >= 0) timers.splice(pos, 1);
        if (!(this._directNativeDeleteUi instanceof Map) || !this._directNativeDeleteUi.has(id)) return;
        this.log('[pylon-native] persistent direct-delete geometry readback', `nativeId=${id}`,
          `age=${Date.now() - Number(this._directNativeDeleteUi.get(id)?.updatedAt || Date.now())}ms`);
        try { await this.refreshMapData(); } catch (e) { this.log('[pylon-native] persistent direct-delete readback failed:', e.message); }
        if (this._directNativeDeleteUi instanceof Map && this._directNativeDeleteUi.has(id)) armPersistent(PYLON_PENDING_RECHECK_MS);
      };
      timer = this.homey?.setTimeout ? this.homey.setTimeout(cb, Math.max(150, delay)) : setTimeout(cb, Math.max(150, delay));
      timer?.unref?.();
      timers.push(timer);
    };
    const firstPersistentAt = PYLON_PENDING_TIMEOUT_MS + PYLON_PENDING_RECHECK_MS;
    armPersistent(Math.max(150, firstPersistentAt - age));
    this._directNativeDeleteTimers.set(id, timers);
  }

  _resumeDirectNativeDeleteVerification() {
    if (!(this._directNativeDeleteUi instanceof Map)) this._directNativeDeleteUi = new Map();
    const watches = this._nativeZoneLabelDeleteWatches && typeof this._nativeZoneLabelDeleteWatches === 'object'
      ? this._nativeZoneLabelDeleteWatches : {};
    const grouped = new Map();
    for (const watch of Object.values(watches)) {
      const nativeId = Number(watch?.nativeId);
      const mapIndex = Number(watch?.mapIndex);
      if (!Number.isInteger(nativeId) || nativeId <= 0 || mapIndex !== Number(this._activeMapIndex)) continue;
      const requestedAt = Number(watch?.requestedAt || Date.now());
      const previous = grouped.get(nativeId);
      if (!previous || requestedAt < previous.updatedAt) grouped.set(nativeId, {
        updatedAt:requestedAt, mapIndex, affectedRuleIds:[],
        ...(this._normalizeNativeMapRevision(watch?.mapRevisionBefore)
          ? { mapRevisionBefore:this._normalizeNativeMapRevision(watch.mapRevisionBefore) } : {}),
      });
    }
    for (const [nativeId, op] of grouped) {
      if (!this._directNativeDeleteUi.has(nativeId)) this._directNativeDeleteUi.set(nativeId, op);
      this._scheduleDirectNativeDeleteReadback(nativeId);
    }
    if (grouped.size) this.log('[pylon-native] resuming durable direct native delete verification',
      `count=${grouped.size}`, `mapIndex=${this._activeMapIndex}`);
  }

  async _purgeStaleOrphanPylonRules(reason = 'startup') {
    const rules = this._obstacleRulesCache && typeof this._obstacleRulesCache === 'object'
      ? this._obstacleRulesCache : {};
    const now = Date.now();
    const livePylons = this._buildObstaclePylons();
    const purged = [];
    for (const [id, rule] of Object.entries(rules)) {
      if (!rule?.pending) continue;
      // 1.2.40: a current accepted native edit is never purged just because
      // OBS temporarily loses the pylon or MAP.* remains stale. Preserve current
      // v6 creates and deletes that carry explicit native ids; truly legacy
      // orphan projections without such transaction identity may still be cleaned.
      const durableCurrentEdit = (rule.pending === 'create' && Number(rule.nativeWriteVersion || 0) >= 6)
        || (rule.pending === 'delete' && (Array.isArray(rule.pendingDeleteIds) && rule.pendingDeleteIds.length));
      if (durableCurrentEdit) continue;
      const startedAt = Number(rule.updatedAt || 0);
      const age = startedAt > 0 ? Math.max(0, now - startedAt) : PYLON_PENDING_TIMEOUT_MS + 1;
      if (age <= PYLON_PENDING_TIMEOUT_MS || this._findPylonForRule(id, rule, livePylons)) continue;
      // Local metadata only: removing an orphan rule never sends a native map
      // command and never deletes a Dreame/MOVA forbidden area. Any real native
      // area remains visible from MAP.*. This only removes stale Homey projections
      // for pylons that no longer exist in the current OBS/AIOBS payload.
      this._clearPendingPylonReadback(id);
      delete rules[id];
      purged.push(id);
    }
    if (!purged.length) return 0;
    this._obstacleRulesCache = rules;
    await this.setStoreValue('obstacle_rules_v1', rules);
    this._pylonUiRevision = Number(this._pylonUiRevision || 0) + 1;
    this.log('[pylon-native] purged stale orphan pending rules',
      `reason=${reason}`, `count=${purged.length}`, `ids=${purged.map((id) => String(id).slice(0,64)).join(',')}`);
    return purged.length;
  }

  _resumePendingPylonVerification() {
    const rules = this._obstacleRulesCache || {};
    const pending = Object.entries(rules).filter(([, rule]) => {
      if (!rule?.pending) return false;
      const ruleMap = Number(rule.mapIndex);
      return !Number.isInteger(ruleMap) || ruleMap === Number(this._activeMapIndex);
    });
    if (!pending.length) return;
    this.log('[pylon-native] resuming persisted pending verification', `count=${pending.length}`,
      `mapIndex=${this._activeMapIndex}`);
    for (const [id] of pending) this._schedulePendingPylonReadback(id);
  }

  async _reconcilePylonNativeRules(map, { fresh = false } = {}) {
    const rules = this._obstacleRulesCache;
    await this._reconcileNativeZoneLabelDeleteWatches(map, { fresh });
    if (!rules || !Array.isArray(map?.forbiddenAreas)) return;
    const readbackSource = map?.directMapdVerified === true ? 'MAPD' : 'MAP.*';
    const directCurrentG2408 = map?.directMapdVerified === true
      && map?.directMapdAuthority === 'g2408_top_level_map';
    const areas = map.forbiddenAreas.map((e) => ({ id: Number(Array.isArray(e) ? e[0] : e?.id),
      area: Array.isArray(e) ? e[1] : e }));
    const rawPylons = this._buildObstaclePylons();
    let changed = false;
    if (this._directNativeDeleteUi instanceof Map) {
      for (const [nativeId, op] of [...this._directNativeDeleteUi.entries()]) {
        const numericId = Number(nativeId);
        const stillPresent = areas.some((entry) => Number(entry.id) === numericId);
        const age = Date.now() - Number(op?.updatedAt || 0);
        const revisionReady = this._nativeMapRevisionReadyForConfirmation(op, map);
        if (fresh && revisionReady && !stillPresent) {
          this._directNativeDeleteUi.delete(nativeId);
          this._clearDirectNativeDeleteReadback(numericId);
          // Native MAP.* is authoritative: only now detach Homey metadata from
          // this id. If duplicates remain on the same rule, keep the next one.
          for (const [ruleId, rule] of Object.entries(rules)) {
            if (!rule) continue;
            const ids = new Set(Array.isArray(rule.nativeMatchIds) ? rule.nativeMatchIds.map(Number) : []);
            if (Number.isInteger(Number(rule.nativeId))) ids.add(Number(rule.nativeId));
            if (!ids.has(numericId)) continue;
            ids.delete(numericId);
            const remainingIds = [...ids].filter((id) => areas.some((entry) => Number(entry.id) === id)).sort((a,b) => a-b);
            const nextId = remainingIds.length ? remainingIds[remainingIds.length - 1] : null;
            rules[ruleId] = { ...rule,
              nativeId: nextId, nativeMatchIds: remainingIds, pendingDeleteIds: [], pending: null,
              action: nextId == null ? 'observe' : 'avoid',
              directNativeDeleteRequestedAt: null,
              verification: nextId == null ? 'native_direct_delete_confirmed' : 'native_direct_delete_partial_confirmed',
              verificationAt: Date.now(), updatedAt: Date.now() };
            changed = true;
          }
          // Homey-only label cleanup is geometry-aware and durable. It is handled
          // by _reconcileNativeZoneLabelDeleteWatches() only on a complete fresh
          // readback, so a recycled numeric id at another position is protected.
          this.log(`[pylon-native] direct native delete confirmed from ${readbackSource}`,
            `nativeId=${numericId}`, `age=${Math.max(0, age)}ms`);
          this._pylonUiRevision = Number(this._pylonUiRevision || 0) + 1;
        } else if (fresh && directCurrentG2408 && revisionReady && stillPresent && age >= 15000) {
          // A verified g2408 top-level MAPD snapshot is current mower truth. If
          // the zone is still present after the edit window, stop spinning and
          // return control to the user instead of waiting for stale cloud MAP.*.
          this._directNativeDeleteUi.delete(nativeId);
          this._clearDirectNativeDeleteReadback(numericId);
          for (const ruleId of (op?.affectedRuleIds || [])) {
            const rule = rules[ruleId];
            if (!rule) continue;
            rules[ruleId] = { ...rule, directNativeDeleteRequestedAt:null,
              verification:'native_direct_delete_unconfirmed_retryable', verificationAt:Date.now() };
            changed = true;
          }
          this._pylonUiRevision = Number(this._pylonUiRevision || 0) + 1;
          this.log('[pylon-native] direct native delete not reflected in current MAPD; retry unlocked',
            `nativeId=${numericId}`, `age=${Math.max(0, age)}ms`);
        } else if (fresh && age >= 15000 && op && op.waitingLogged !== true) {
          // Compatibility path for cloud/legacy schemas that can still lag.
          op.waitingLogged = true;
          this._directNativeDeleteUi.set(numericId, op);
          this.log('[pylon-native] direct native delete still awaiting geometry confirmation',
            `nativeId=${numericId}`, `age=${Math.max(0, age)}ms`);
        }
      }
    }
    // Do not purge labels merely because one fresh-looking cloud snapshot omits
    // a zone: this A2 can serve stale MAP.* until a map-screen sync. Confirmed
    // direct deletion removes the label explicitly above.
    for (const [id, rule] of Object.entries(rules)) {
      const ruleMap = Number(rule?.mapIndex);
      if (Number.isInteger(ruleMap) && ruleMap !== Number(this._activeMapIndex)) continue;

      // A delete can be device-confirmed while an older Homey build times out
      // against a stale MAP.* snapshot. If a later *fresh targeted* map no
      // longer contains any of the Homey-owned ids, adopt that late delete
      // instead of leaving a ghost red square forever.
      if (!rule?.pending && ['native_delete_partial_timeout','native_delete_unconfirmed_timeout'].includes(rule?.verification)) {
        const managed = new Set(Array.isArray(rule.nativeMatchIds) && rule.nativeMatchIds.length
          ? rule.nativeMatchIds.map(Number) : [Number(rule.nativeId)]);
        // Delete confirmation is identity-based. Once Homey has explicit native
        // ids, OBS/pylon geometry must not be consulted because Dreame can
        // renumber or move the telemetry pylon independently of the map object.
        const remaining = areas.filter((e) => managed.has(Number(e.id))
          && this._nativeForbiddenShape(e.area) === 2);
        if (fresh && managed.size && !remaining.length) {
          rules[id] = { ...rule, nativeId:null, nativeCandidateId:null, nativeMatchIds:[], pendingDeleteIds:[],
            pending:null, action:'observe', beforeIds:null,
            verification:'native_late_delete_confirmed', verificationAt:Date.now(), updatedAt:Date.now() };
          this.log(`[pylon-native] late timed-out delete confirmed from fresh ${readbackSource}`,
            `id=${String(id).slice(0,64)}`, `deleted=${[...managed].filter(Number.isInteger).join(',')}`);
          changed = true;
        }
        continue;
      }

      // A real A2 field write can appear in MAP.* around three minutes after
      // the mower already acknowledged o=215. If an older local timeout has
      // already released the UI lock, adopt the late exact square on any later
      // map poll instead of waiting for another Save (and never create a duplicate).
      if (!rule?.pending && ['native_create_unconfirmed_timeout','native_create_unconfirmed_retryable'].includes(rule?.verification)
          && Number(rule.nativeWriteVersion || 0) >= 3) {
        const pylon = this._findPylonForRule(id, rule, rawPylons);
        if (pylon) {
          const exact = areas.filter((e) => this._nativeForbiddenShape(e.area) === 2
            && this._nativePylonZoneMatches(e.area, pylon, rule));
          const candidateId = Number(rule.nativeCandidateId);
          const preferred = Number.isInteger(candidateId) ? exact.find((e) => e.id === candidateId) : null;
          const chosen = preferred || (exact.length ? [...exact].sort((a,b) => b.id - a.id)[0] : null);
          if (chosen) {
            rules[id] = { ...rule, nativeId: chosen.id, nativeCandidateId: null,
              nativeMatchIds: exact.map((e) => e.id).sort((a,b) => a-b), pending: null,
              action: 'avoid', beforeIds: null, verification: 'native_late_create_adopted',
              verificationAt: Date.now(), updatedAt: Date.now() };
            this.log('[pylon-native] late timeout square adopted during map reconcile',
              `id=${String(id).slice(0,64)}`, `nativeId=${chosen.id}`, `matches=${exact.map((e)=>e.id).join(',')}`);
            changed = true;
          }
        }
        continue;
      }

      if (!rule?.pending) continue;
      if (Number.isInteger(ruleMap) && ruleMap !== Number(this._activeMapIndex)) continue;
      if (rule.pending === 'delete') {
        // 1.2.24 persisted only nativeMatchIds during Delete. Treat that
        // existing exact managed set as the intended delete set so a restart or
        // upgrade cannot falsely declare success merely because primary
        // nativeId vanished while an overlapping duplicate is still present.
        // Confirmation is native-id based only; current OBS geometry is not a
        // valid identity source during delete verification.
        const legacyDeleteIds = Array.isArray(rule.nativeMatchIds) && rule.nativeMatchIds.length
          ? rule.nativeMatchIds.map(Number) : [Number(rule.nativeId)];
        const pendingDeleteIds = new Set(Array.isArray(rule.pendingDeleteIds) && rule.pendingDeleteIds.length
          ? rule.pendingDeleteIds.map(Number) : legacyDeleteIds);
        const remaining = areas.filter((e) => pendingDeleteIds.has(Number(e.id))
          && this._nativeForbiddenShape(e.area) === 2);
        const revisionReady = this._nativeMapRevisionReadyForConfirmation(rule, map);
        if (fresh && revisionReady && !remaining.length) {
          rules[id] = { ...rule, nativeId: null, nativeCandidateId: null, nativeMatchIds: [], pendingDeleteIds: [],
            pending: null, action: 'observe', beforeIds: null,
            verification: 'native_delete_confirmed', verificationAt: Date.now() };
          this._clearPendingPylonReadback(id);
          this.log(`[pylon-native] pending delete confirmed from ${readbackSource}`,
            `id=${String(id).slice(0,64)}`, `deleted=${[...pendingDeleteIds].join(',')}`,
            `age=${Date.now()-Number(rule.updatedAt||Date.now())}ms`);
          changed = true;
        } else if (fresh) {
          const age = Number(rule.updatedAt || 0) > 0 ? Date.now() - Number(rule.updatedAt) : 0;
          const revisionAdvanced = Number(rule.mapRevisionAdvancedAt || 0) > 0;
          if (directCurrentG2408 && revisionReady && age >= PYLON_DIRECT_MISS_RELEASE_MS && remaining.length) {
            const next = [...remaining].sort((a,b) => b.id - a.id)[0];
            rules[id] = { ...rule, nativeId: next?.id ?? rule.nativeId,
              nativeMatchIds: remaining.map((e) => e.id).sort((a,b) => a-b),
              pendingDeleteIds:[], pending:null, action:'avoid', beforeIds:null,
              verification:'native_delete_unconfirmed_retryable', verificationAt:Date.now() };
            this._clearPendingPylonReadback(id);
            this.log('[pylon-native] current MAPD still contains deleted zone; Pending released for retry',
              `id=${String(id).slice(0,64)}`, `remaining=${remaining.map((e)=>e.id).join(',')}`,
              `age=${Math.round(age)}ms`);
            changed = true;
          } else if (age >= 15000 && rule.verification !== 'native_delete_waiting_for_map_sync') {
            const next = [...remaining].sort((a,b) => b.id - a.id)[0];
            rules[id] = { ...rule, nativeId: next?.id ?? rule.nativeId,
              nativeMatchIds: remaining.map((e) => e.id).sort((a,b) => a-b),
              // Legacy/cloud schemas may still lag. Keep the original pending
              // operation until a trustworthy geometry source resolves it.
              verification: 'native_delete_waiting_for_map_sync', verificationAt: Date.now() };
            this.log('[pylon-native] pending delete still present; keeping Pending until geometry confirms',
              `id=${String(id).slice(0,64)}`, `remaining=${remaining.map((e)=>e.id).join(',')}`,
              `age=${Math.round(age)}ms`);
            changed = true;
          }
        }
      } else if (rule.pending === 'create') {
        const pylon = this._findPylonForRule(id, rule, rawPylons);
        if (!pylon) continue;
        const version = Number(rule.nativeWriteVersion || 0);
        const matches = areas.filter((e) =>
          (rule.nativeId != null ? e.id === Number(rule.nativeId) : !rule.beforeIds?.includes(e.id))
          && this._nativePylonZoneMatches(e.area, pylon, rule));
        const candidateId = Number(rule.nativeCandidateId);
        const candidateMatch = Number.isInteger(candidateId) ? matches.find((e) => e.id === candidateId) : null;
        let confirmed = candidateMatch || (matches.length === 1 ? matches[0] : null);
        let confirmationMatches = matches;
        let recoveredStaleBeforeIds = false;
        const revisionReady = this._nativeMapRevisionReadyForConfirmation(rule, map);

        // Upgrade recovery for pending operations created by 1.2.38-1.2.43:
        // their beforeIds came from lagging cloud MAP.* and can therefore already
        // contain the mower's eventual reused id. On a current g2408 MAPD frame,
        // one exact unowned square at this pylon is sufficient to recover it.
        if (!confirmed && fresh && directCurrentG2408 && revisionReady && version >= 3) {
          const ownedElsewhere = new Set();
          for (const [otherRuleId, otherRule] of Object.entries(rules)) {
            if (otherRuleId === id || !otherRule) continue;
            if (Number.isInteger(Number(otherRule.nativeId))) ownedElsewhere.add(Number(otherRule.nativeId));
            for (const ownedId of (Array.isArray(otherRule.nativeMatchIds) ? otherRule.nativeMatchIds : [])) {
              if (Number.isInteger(Number(ownedId))) ownedElsewhere.add(Number(ownedId));
            }
          }
          const exactAll = areas.filter((e) => !ownedElsewhere.has(Number(e.id))
            && this._nativeForbiddenShape(e.area) === 2
            && this._nativePylonZoneMatches(e.area, pylon, rule));
          if (exactAll.length === 1) {
            confirmed = exactAll[0];
            confirmationMatches = exactAll;
            recoveredStaleBeforeIds = true;
          } else if (exactAll.length > 1) {
            this._logPylonReadbackSummary('pending-create-ambiguous-g2408', areas, pylon, Number(rule.radius), rule.beforeIds || []);
          }
        }

        if (fresh && revisionReady && confirmed) {
          rules[id] = { ...rule, nativeId: confirmed.id, nativeCandidateId: null,
            nativeMatchIds: confirmationMatches.map((e) => e.id).sort((a,b) => a-b),
            pending: null, action: 'avoid', beforeIds: null,
            verification: recoveredStaleBeforeIds ? 'native_square_create_confirmed_recovered'
              : (version >= 3 ? 'native_square_create_confirmed' : 'native_create_confirmed'),
            verificationAt: Date.now() };
          this._clearPendingPylonReadback(id);
          this.log(`[pylon-native] pending create confirmed from ${readbackSource}`,
            `id=${String(id).slice(0,64)}`, `nativeId=${confirmed.id}`,
            recoveredStaleBeforeIds ? 'recovered=stale-beforeIds' : '',
            `age=${Date.now()-Number(rule.updatedAt||Date.now())}ms`);
          changed = true;
        } else if (fresh && version < 3) {
          // 1.2.16 and older used either a non-transactional write or a
          // transactional type=3 circle. A fresh map miss releases that legacy
          // lock immediately so it can be retried with the verified polygon path.
          rules[id] = { ...rule, nativeId: null, pending: null, beforeIds: null, action: 'observe',
            verification: version >= 2 ? 'legacy_circle_unconfirmed_cleared' : 'legacy_unconfirmed_cleared',
            verificationAt: Date.now() };
          this._clearPendingPylonReadback(id);
          this.log('[pylon-native] released legacy pending after fresh native map miss',
            `id=${String(id).slice(0,64)}`, `mapIndex=${this._activeMapIndex}`, `writeVersion=${version}`);
          changed = true;
        } else if (fresh) {
          const age = Number(rule.updatedAt || 0) > 0 ? Date.now() - Number(rule.updatedAt) : 0;
          const revisionAdvanced = Number(rule.mapRevisionAdvancedAt || 0) > 0;
          if (directCurrentG2408 && revisionReady && age >= PYLON_DIRECT_MISS_RELEASE_MS) {
            this._logPylonReadbackSummary('pending-create-no-match-g2408', areas, pylon, Number(rule.radius), rule.beforeIds || []);
            const keepNativeId = Number(rule.nativeId);
            const keepExisting = Number.isInteger(keepNativeId)
              && areas.some((entry) => Number(entry.id) === keepNativeId);
            rules[id] = { ...rule,
              nativeId:keepExisting ? keepNativeId : null, nativeCandidateId:null,
              nativeMatchIds:keepExisting ? [keepNativeId] : [],
              pending:null, beforeIds:null, action:keepExisting ? 'avoid' : 'observe',
              verification:keepExisting ? 'native_update_unconfirmed_retryable' : 'native_create_unconfirmed_retryable',
              verificationAt:Date.now() };
            this._clearPendingPylonReadback(id);
            this.log('[pylon-native] current MAPD has no exact pending square; Pending released for retry',
              `id=${String(id).slice(0,64)}`, `age=${Math.round(age)}ms`, `writeVersion=${version}`);
            changed = true;
          } else if (age >= PYLON_PENDING_TIMEOUT_MS && rule.verification !== 'native_create_waiting_for_map_sync') {
            // Compatibility fallback for models without current direct geometry.
            rules[id] = { ...rule, verification:'native_create_waiting_for_map_sync', verificationAt:Date.now() };
            this.log('[pylon-native] pending create still awaiting native geometry; keeping Pending',
              `id=${String(id).slice(0,64)}`, `age=${Math.round(age)}ms`, `writeVersion=${version}`);
            changed = true;
          }
        }
      }
    }
    if (changed) {
      await this.setStoreValue('obstacle_rules_v1', rules);
      this._pylonUiRevision = Number(this._pylonUiRevision || 0) + 1;
      this._scheduleMapCameraImageUpdate();
    }
  }

  async _restoreLastCompleteMap() {
    if (this._lastCompleteMapCheckedIndex === this._activeMapIndex) return;
    this._lastCompleteMapCheckedIndex = this._activeMapIndex;
    if (this._cachedMapData?.boundary && this._cachedMapData?.mowingAreas?.length) return;
    const stored = await safeGetStoreValue(this, 'last_complete_mower_map_v1');
    if (!stored || Number(stored.mapIndex) !== Number(this._activeMapIndex)) return;
    const map = stored.map;
    if (!map?.boundary || !Array.isArray(map.mowingAreas) || !map.mowingAreas.length) return;
    // 1.2.39 migration guard: 1.2.38 could persist a hash-verified MAPD frame
    // whose forbidden-zone parser had produced an unsafe empty set. Those old
    // records carry directMapdVerified but not the new geometry-verification
    // marker. Never resurrect such a frame after upgrading; wait for the live
    // cloud/MAPD refresh to rebuild a complete map instead.
    if (map.directMapdVerified === true && map.directMapdGeometryVerified !== true) {
      this.log('[map] ignored legacy 1.2.38 direct MAPD cache without geometry verification');
      return;
    }
    this._cachedMapData = map;
    this._lastCompleteMapHash = String(map.md5sum || '');
    this._lastCompleteMapIndex = this._activeMapIndex;
    this.log('[map] complete geometry restored from device store');
  }

  async _saveLastCompleteMap() {
    const map = this._cachedMapData;
    if (!map?.boundary || !Array.isArray(map.mowingAreas) || !map.mowingAreas.length) return;
    const hash = String(map.md5sum || '');
    if (this._lastCompleteMapHash === hash && this._lastCompleteMapIndex === this._activeMapIndex) return;
    const { livePath, ...geometry } = map;
    const record = { mapIndex: this._activeMapIndex, map: geometry };
    if (Buffer.byteLength(JSON.stringify(record)) > 512 * 1024) {
      this.log('[map] complete geometry exceeds bounded store; retained in current session');
      return;
    }
    await this.setStoreValue('last_complete_mower_map_v1', record);
    this._lastCompleteMapHash = hash;
    this._lastCompleteMapIndex = this._activeMapIndex;
  }

  _logNativeForbiddenReadOnly(map, source) {
    const nativeForbidden = map?.forbiddenAreas;
    if (nativeForbidden == null) return;
    const list = Array.isArray(nativeForbidden) ? nativeForbidden : [];
    const rows = list.slice(0, 100).map((entry) => {
      const area = Array.isArray(entry) && entry.length === 2 && typeof entry[1] === 'object' ? entry[1] : entry;
      const id = area?.id ?? (Array.isArray(entry) ? entry[0] : null);
      const numeric = (value) => Number.isFinite(Number(value)) && value != null ? Number(value) : null;
      return {
        id: numeric(id), type: numeric(area?.type), shape: numeric(area?.shape ?? area?.shapeType),
        radius: numeric(area?.radius), pointCount: Array.isArray(area?.points) ? area.points.length : null,
      };
    });
    const signature = JSON.stringify([source, this._activeMapIndex, list.length, rows]);
    if (!this._nativeForbiddenDiagSignatures) this._nativeForbiddenDiagSignatures = {};
    if (signature !== this._nativeForbiddenDiagSignatures[source]) {
      this._nativeForbiddenDiagSignatures[source] = signature;
      this.log('[native-forbidden-readonly]', signature);
    }
  }

  async _readTargetedNativeMapBatch() {
    if (!this._api) return null;
    const did = this.getData().id;
    this._nativeMapReadbackBusy = true;
    try {
      let raw = null;
      let parsed = null;
      let complete = false;

      // 1.2.41: preserve the exact captured Dreame-map-screen tail. The vendor
      // sequence ends with a full getDeviceData(keys:[]) request. 1.2.40 returned
      // early from a successful MAPD parse and could therefore skip that request
      // completely — unlike the original app behavior that was observed to make
      // stale MAP.* catch up after native edits. If the just-finished map-screen
      // wake already returned that snapshot, consume it once; otherwise issue the
      // same full read here before trying direct MAPD.
      let full = null;
      const captured = this._lastVendorMapScreenSnapshot;
      if (captured
          && Number(captured.mapIndex) === Number(this._activeMapIndex)
          && Date.now() - Number(captured.at || 0) <= 15000) {
        full = captured.response;
        this._lastVendorMapScreenSnapshot = null;
        this.log('[map] using keys:[] snapshot from captured vendor map-screen sequence');
      } else if (typeof this._api.getRawDeviceDataSnapshot === 'function') {
        try {
          let snapshotTimer;
          full = await Promise.race([
            this._api.getRawDeviceDataSnapshot(did),
            new Promise((_, reject) => { snapshotTimer = setTimeout(() => reject(new Error('Full device-data map timeout')), 12000); }),
          ]).finally(() => clearTimeout(snapshotTimer));
        } catch (err) {
          // Exact vendor parity is attempted first, but a transient cloud failure
          // must not prevent the independent mower-side MAPD verification path.
          this.log('[map] vendor keys:[] snapshot unavailable; continuing with direct MAPD:', err.message);
        }
      }

      const fullRaw = full?.data;
      if (fullRaw && typeof fullRaw === 'object' && !Array.isArray(fullRaw)) {
        const fullParsed = this._parseMapDataChunks(fullRaw);
        const fullComplete = !!(fullParsed?.boundary
          && Array.isArray(fullParsed.mowingAreas) && fullParsed.mowingAreas.length
          && Array.isArray(fullParsed.forbiddenAreas));
        if (fullComplete) {
          raw = fullRaw;
          parsed = fullParsed;
          complete = true;
          this.log('[map] MAP.* readback loaded via vendor keys:[] snapshot');
        }
      }

      // Direct mower read is an independent verification source, not a replacement
      // for the captured vendor keys:[] sequence. MAPI -> all MAPD chunks -> MAPI
      // is globally serialized in MovaApi and only accepted after transport +
      // geometry-preservation checks. A verified direct snapshot may outrank a
      // stale cloud snapshot, but it never prevents the cloud refresh request.
      if (typeof this._api.getDirectMapSnapshot === 'function') {
        try {
          let directTimer;
          const snapshot = await Promise.race([
            this._api.getDirectMapSnapshot(did, this._activeMapIndex, { chunkSize:400, attempts:2 }),
            new Promise((_, reject) => { directTimer = setTimeout(() => reject(new Error('Direct MAPD map timeout')), 15000); }),
          ]).finally(() => clearTimeout(directTimer));
          const directParsed = this._parseAppActionMapPayload(snapshot, this._cachedMapData);
          const directComplete = !!(directParsed?.boundary
            && Array.isArray(directParsed.mowingAreas) && directParsed.mowingAreas.length
            && Array.isArray(directParsed.forbiddenAreas)
            && directParsed.directMapdGeometryVerified === true);
          if (directComplete) {
            this._lastVendorMapMeta = {
              idx: Number(snapshot.idx), hash: snapshot.hash, size: Number(snapshot.size),
            };
            await this._noteNativeMapRevisionProgress(snapshot).catch((e) =>
              this.log('[pylon-native] direct MAPD revision progress check failed:', e.message));
            this.log('[map] direct MAPD readback complete',
              `hash=${String(snapshot.hash || '').slice(0,16)}`,
              `size=${Number(snapshot.size) || 0}`,
              `chunks=${Number(snapshot.chunkCount) || 0}`,
              `scale=${Number(directParsed.directMapdScale) || 0}`,
              `forbidden=${directParsed.forbiddenAreas.length}`,
              `candidates=${Array.isArray(directParsed.directMapdCandidateIds) ? directParsed.directMapdCandidateIds.join(',') : '-'}`,
              `authority=${directParsed.directMapdAuthority || 'verified'}`);
            this._logNativeForbiddenReadOnly(directParsed, 'MAPD-direct');
            return { raw:null, parsed:directParsed, source:'MAPD', snapshot, cloudRaw:raw, cloudParsed:parsed };
          }
          const ids = Array.isArray(directParsed?.directMapdCandidateIds) ? directParsed.directMapdCandidateIds : [];
          const missing = Array.isArray(directParsed?.directMapdMissingBaseIds) ? directParsed.directMapdMissingBaseIds : [];
          const mismatched = Array.isArray(directParsed?.directMapdMismatchedBaseIds) ? directParsed.directMapdMismatchedBaseIds : [];
          const pendingUpdated = Array.isArray(directParsed?.directMapdPendingUpdatedIds) ? directParsed.directMapdPendingUpdatedIds : [];
          const ambiguous = Array.isArray(directParsed?.directMapdAmbiguousIds) ? directParsed.directMapdAmbiguousIds : [];
          const paths = Array.isArray(directParsed?.directMapdCandidatePaths) ? directParsed.directMapdCandidatePaths.slice(0, 12) : [];
          this.log('[map] direct MAPD transport verified but forbidden geometry NOT authoritative; falling back to MAP.*',
            `candidates=${ids.join(',') || '-'}`,
            `missingBase=${missing.join(',') || '-'}`,
            `mismatchedBase=${mismatched.join(',') || '-'}`,
            `pendingUpdated=${pendingUpdated.join(',') || '-'}`,
            `ambiguous=${ambiguous.join(',') || '-'}`,
            `paths=${paths.join('|') || '-'}`,
            `keys=${Array.isArray(directParsed?.mapRawKeys) ? directParsed.mapRawKeys.join(',') : '-'}`);
        } catch (err) {
          this.log('[map] direct MAPD readback unavailable; falling back to cloud MAP.*:', err.message);
        }
      }

      if (complete) {
        this._logNativeForbiddenReadOnly(parsed, 'MAP-targeted');
        return { raw, parsed, source:'MAP.*' };
      }

      // Compatibility fallback only. Some older regions may reject keys:[] but
      // still honour named MAP.N reads. MAP.info in _parseMapDataChunks bounds the
      // current chunk set so stale residual MAP.N keys cannot confirm geometry.
      if (typeof this._api.getRawMapBatch === 'function') {
        let timeoutId;
        const res = await Promise.race([
          this._api.getRawMapBatch(did),
          new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('Targeted MAP.* timeout')), 12000); }),
        ]).finally(() => clearTimeout(timeoutId));
        const namedRaw = res?.data;
        const namedParsed = namedRaw && typeof namedRaw === 'object' && !Array.isArray(namedRaw)
          ? this._parseMapDataChunks(namedRaw) : null;
        const namedComplete = !!(namedParsed?.boundary
          && Array.isArray(namedParsed.mowingAreas) && namedParsed.mowingAreas.length
          && Array.isArray(namedParsed.forbiddenAreas));
        if (namedComplete) {
          raw = namedRaw;
          parsed = namedParsed;
          this.log('[map] MAP.* readback fell back to named MAP keys');
          this._logNativeForbiddenReadOnly(parsed, 'MAP-targeted');
          return { raw, parsed, source:'MAP.*-named' };
        }
      }

      return null;
    } catch (err) {
      this.log('[map] targeted MAP.* refresh failed:', err.message);
      return null;
    } finally {
      this._nativeMapReadbackBusy = false;
    }
  }

  _pylonUiState(rule, now = Date.now()) {
    if (!rule?.pending) return { pending:false, uiPending:false, optimistic:false, expired:false, ageMs:0 };
    const startedAt = Number(rule.updatedAt || 0);
    const ageMs = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
    // 1.2.40: Pending is shown for the entire unconfirmed lifetime. There is no
    // five-second optimistic success and no visual expiry. Only native geometry
    // confirmation clears it.
    return { pending:true, uiPending:true, optimistic:false, expired:false, ageMs };
  }

  _optimisticPylonCreateEntry() {
    // Compatibility stub for older tests/callers. 1.2.40 deliberately does not
    // manufacture a red no-go polygon before the mower confirms one.
    return null;
  }

  _mapDataForDisplay(map) {
    if (!map || !Array.isArray(map.forbiddenAreas)) return map;
    const suppress = new Set();
    const rules = this._obstacleRulesCache && typeof this._obstacleRulesCache === 'object'
      ? this._obstacleRulesCache : {};
    for (const rule of Object.values(rules)) {
      if (!rule || Number(rule.mapIndex) !== Number(this._activeMapIndex)) continue;
      // Never hide/create a real native zone because an edit is merely Pending.
      // Duplicate Homey-owned ids may still be collapsed for display once they
      // are already known; this does not change raw/native verification data.
      const matches = Array.isArray(rule.nativeMatchIds) ? rule.nativeMatchIds.map(Number).filter(Number.isInteger) : [];
      const keep = Number(rule.nativeId);
      if (Number.isInteger(keep) && matches.length > 1) {
        for (const id of matches) if (id !== keep) suppress.add(id);
      }
    }
    if (!suppress.size) return map;
    const filtered = map.forbiddenAreas.filter((entry) => {
      const id = Number(Array.isArray(entry) ? entry[0] : entry?.id);
      return !suppress.has(id);
    });
    return filtered.length !== map.forbiddenAreas.length ? { ...map, forbiddenAreas:filtered } : map;
  }

  async _requestMowerMapPublish(reason = 'refresh') {
    if (!this._api) return false;

    // 1.2.38 field logs showed the accepted-edit map-screen sync interleaving
    // with the first MAPI→MAPD download (MAPI/MPOS/MAPD/DOCK/... mixed on the
    // same 2:50 channel). MAPI selects the MAPD cursor, so that concurrency can
    // produce a coherent transport hash for the wrong logical read. Serialize
    // our own map-screen wake sequences before starting direct map download.
    while (this._mapPublishPromise) {
      try { await this._mapPublishPromise; } catch (_) {}
    }

    const run = (async () => {
      const now = Date.now();
      if (this._lastMowerMapPublishRequestAt && now - this._lastMowerMapPublishRequestAt < 2500) {
        this.log('[map] vendor map refresh request throttled', reason);
        return false;
      }
      this._lastMowerMapPublishRequestAt = now;
      try {
        const did = this.getData().id;
        const acceptedEdit = /(?:create|delete)-accepted/.test(String(reason));
        const manualHard = reason === 'manual-hard-refresh';
        const staleFullSync = !this._lastVendorMapScreenSyncAt || now - this._lastVendorMapScreenSyncAt >= 12000;
        const useMapScreenSync = typeof this._api.refreshMapScreenContext === 'function'
          && (acceptedEdit || manualHard || (reason === 'pylon-readback' && staleFullSync));

        if (useMapScreenSync) {
          // The 2026-10-01 Android capture shows the vendor map screen waking the
          // live device channel (1:1/1:2) and reading MPOS/DOCK/AIOBS/DEV/MAPL/MAPI
          // immediately before getDeviceData(keys:[]). MovaApi now performs
          // that final full snapshot inside the same serialized map-screen
          // sequence; the caller then performs independent MAPD verification.
          const sync = await this._api.refreshMapScreenContext(did, this._activeMapIndex);
          this._lastVendorMapScreenSyncAt = Date.now();
          if (sync?.snapshot) {
            this._lastVendorMapScreenSnapshot = {
              at: this._lastVendorMapScreenSyncAt,
              mapIndex: Number(this._activeMapIndex),
              response: sync.snapshot,
            };
          }
          const d = sync?.mapi?.d ?? sync?.mapi;
          this._lastVendorMapMeta = d && typeof d === 'object' ? d : null;
          await this._noteNativeMapRevisionProgress(d).catch((e) =>
            this.log('[pylon-native] map revision progress check failed:', e.message));
          this.log('[map] vendor map-screen sync requested', reason,
            d?.hash ? `hash=${String(d.hash).slice(0,16)}` : '',
            Number.isFinite(Number(d?.size)) ? `size=${Number(d.size)}` : '',
            `steps=${Array.isArray(sync?.steps) ? sync.steps.filter((x) => x.ok).length : 0}`);
          return true;
        }

        // Lightweight metadata probe between full map-screen sync attempts.
        if (typeof this._api.getMAPI === 'function') {
          const meta = await this._api.getMAPI(did, this._activeMapIndex);
          const d = meta?.d ?? meta;
          this._lastVendorMapMeta = d && typeof d === 'object' ? d : null;
          await this._noteNativeMapRevisionProgress(d).catch((e) =>
            this.log('[pylon-native] map revision progress check failed:', e.message));
          this.log('[map] vendor MAPI metadata refresh requested', reason,
            d?.hash ? `hash=${String(d.hash).slice(0,16)}` : '',
            Number.isFinite(Number(d?.size)) ? `size=${Number(d.size)}` : '');
          return true;
        }
        if (typeof this._api.requestMapFrame === 'function') {
          await this._api.requestMapFrame(did);
          this.log('[map] legacy mower-side fresh map frame requested', reason);
          return true;
        }
        return false;
      } catch (err) {
        // A failed read/request must never turn a successful map edit into a failed
        // write. Keep the operation Pending and let later read-only verification
        // retry rather than projecting success or automatically retrying a write.
        this.log('[map] vendor map refresh request unavailable:', err.message);
        return false;
      }
    })();

    this._mapPublishPromise = run;
    try {
      return await run;
    } finally {
      if (this._mapPublishPromise === run) this._mapPublishPromise = null;
    }
  }

  async refreshMapData(options = {}) {
    const hard = options === true || options?.hard === true;
    if (!this._api) return this.getMapData();
    if (this._mapForceRefreshPromise) {
      if (!hard) return this._mapForceRefreshPromise;
      // A manual hard refresh must not be swallowed by an older background
      // refresh. Let the current fetch finish, then execute a second clean pass.
      try { await this._mapForceRefreshPromise; } catch (_) {}
    }

    if (hard) {
      // Invalidate only local/read caches. Do not alter native map data or send
      // any map-edit command. The next fetch reparses MAP.* from scratch and
      // rebuilds the widget exactly like a clean reopen.
      this._cachedMAPI = null;
      this._lastMapStr = '';
      this._lastRawData = null;
      this._lastCompleteMapCheckedIndex = null;
      // Keep the registered Homey Image object alive. Dropping this reference on
      // hard refresh left the native "Mähkarte" media source black and prevented
      // all subsequent update() notifications until the device was reinitialised.
      this._mapCameraLastUpdateAt = 0;
      this._pylonUiRevision = Number(this._pylonUiRevision || 0) + 1;
      this.log('[map] hard refresh cache invalidation requested', `revision=${this._pylonUiRevision}`);
    }

    this._mapForceRefreshPromise = (async () => {
      const did = this.getData().id;
      this.log('[map] forced native refresh requested');
      const pendingPylon = Object.values(this._obstacleRulesCache || {}).some((r) =>
        r?.pending && Number(r.mapIndex) === Number(this._activeMapIndex));
      const pendingDirectDelete = this._directNativeDeleteUi instanceof Map
        && [...this._directNativeDeleteUi.values()].some((op) => Number(op?.mapIndex) === Number(this._activeMapIndex));
      const lateDeleteRecheck = Object.values(this._obstacleRulesCache || {}).some((r) =>
        !r?.pending && ['native_delete_partial_timeout','native_delete_unconfirmed_timeout',
          'native_delete_unconfirmed_retryable','native_direct_delete_unconfirmed_retryable'].includes(r?.verification)
        && Number(r.mapIndex) === Number(this._activeMapIndex));
      const pendingNativePolicy = Object.values(this._nativeZonePoliciesCache || {}).some((policy) =>
        policy?.lifecycleTransitionPending && Number(policy.mapIndex) === Number(this._activeMapIndex));
      const nativeVerificationPending = pendingPylon || pendingDirectDelete || lateDeleteRecheck || pendingNativePolicy;

      // During a native map edit (or after an older build timed out while the
      // Dreame app already reflected the delete), ask explicitly for
      // MAP.0..127 + MAP.info before falling back to the general poll snapshot.
      // before falling back to the general poll snapshot. The latter has been
      // observed to stay stale for several minutes after a successful o=218
      // delete even while the Dreame app already shows the zone gone.
      if (hard || nativeVerificationPending) {
        const requested = await this._requestMowerMapPublish(hard ? 'manual-hard-refresh' : 'pylon-readback');
        if (requested) await new Promise((resolve) => setTimeout(resolve, 450));
      }
      let targeted = (hard || nativeVerificationPending) ? await this._readTargetedNativeMapBatch() : null;
      let rawData = targeted?.raw || null;
      let parsed = targeted?.parsed || null;
      let rawComplete = !!(parsed?.boundary && Array.isArray(parsed.mowingAreas) && parsed.mowingAreas.length
        && Array.isArray(parsed.forbiddenAreas));
      if (rawComplete) this.log(`[map] targeted native refresh complete: source=${targeted?.source || 'MAP.*'} ${parsed.mowingAreas.length} zones, ${parsed.forbiddenAreas?.length || 0} forbidden`);

      if (!rawComplete) {
        const raw = await this._api.getRawProperties(did);
        rawData = raw?.data;
        if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
          throw new Error('Native Karte konnte nicht neu geladen werden.');
        }
        parsed = this._parseMapDataChunks(rawData);
        rawComplete = !!(parsed?.boundary && Array.isArray(parsed.mowingAreas) && parsed.mowingAreas.length
          && Array.isArray(parsed.forbiddenAreas));
        if (rawComplete) this._logNativeForbiddenReadOnly(parsed, 'MAP-refresh');
      }
      if (rawData) this._lastRawData = rawData;
      // MAPI is diagnostic/fallback only. Field logs on this A2 showed MAPI
      // reporting 0/1 forbidden objects while the complete MAP.* cloud blob
      // already held the real map, so replacing MAP.* with MAPI made a valid
      // write look permanently unconfirmed.
      if (nativeVerificationPending && !rawComplete && typeof this._api.getMAPI === 'function') {
        try {
          let timeoutId;
          const mapi = await Promise.race([
            this._api.getMAPI(did, this._activeMapIndex),
            new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('MAPI timeout')), 8000); }),
          ]).finally(() => clearTimeout(timeoutId));
          const direct = this._parseDirectMapData(mapi);
          if (direct?.boundary && direct.mowingAreas?.length && Array.isArray(direct.forbiddenAreas)) {
            parsed = direct;
            this._logNativeForbiddenReadOnly(direct, 'MAPI-refresh-fallback');
          }
        } catch (err) { this.log('[map] pending pylon MAPI fallback failed:', err.message); }
      }
      if (!parsed?.boundary || !Array.isArray(parsed.mowingAreas) || !parsed.mowingAreas.length) {
        throw new Error('Vollständige native Karte wurde noch nicht geliefert.');
      }
      this._cachedMapData = parsed;
      await this._reconcilePylonNativeRules(parsed, { fresh: true });
      if (hard) {
        await this._refreshObstacleTelemetry(did, 'manual-hard-refresh')
          .catch((e) => this.log('[map] hard refresh obstacle reload failed:', e.message));
        await this._purgeStaleOrphanPylonRules('manual-hard-refresh')
          .catch((e) => this.log('[pylon-native] hard refresh stale cleanup failed:', e.message));
      }
      await this._saveLastCompleteMap().catch((e) => this.log('[map] forced refresh store failed:', e.message));
      this._scheduleMapCameraImageUpdate();
      this.log(`[map] forced native refresh complete: ${parsed.mowingAreas.length} zones, ${parsed.forbiddenAreas?.length || 0} forbidden`);
      return this.getMapData();
    })();

    try {
      return await this._mapForceRefreshPromise;
    } finally {
      this._mapForceRefreshPromise = null;
    }
  }

  async getMapData() {
    await this._restoreLastCompleteMap();
    // Make persistent original-app OBS warnings visible immediately when the map
    // is opened. The regular poll remains the primary source; this only fills a
    // missing/stale obstacle cache and is throttled to 30 seconds.
    if ((!this._cachedObstacles || Date.now() - Number(this._obstacleDiagUpdatedAt || 0) > 30000)
        && !this._obstacleMapOpenRefreshPromise && !this._pylonNativeWriteBusy) {
      const did = this.getData().id;
      // OBS/AIOBS may be slow or unavailable. Do not hold the whole map widget
      // on those optional pylon diagnostics; the next map poll shows the result.
      this._obstacleDiagUpdatedAt = Date.now();
      this._obstacleMapOpenRefreshPromise = this._refreshObstacleTelemetry(did, 'map-open')
        .catch((e) => this.log('[pylon-diag] map-open refresh failed:', e.message))
        .finally(() => { this._obstacleMapOpenRefreshPromise = null; });
    }

    // RC32: keep the original cached map path, but actively refresh the cache when
    // the widget is opened before the next poll. This prevents Homey from showing
    // "No map data yet" while MAP.N/MAPI data exists in the cloud.
    if (!this._cachedMapData && this._cachedMAPI) this._cachedMapData = this._parseDirectMapData(this._cachedMAPI);
    // Mutex: if a background refresh is already in flight, skip — avoids flooding
    // the cloud API with concurrent MAPI requests from the widget's 5 s poll loop.
    if (!this._cachedMapData && this._api && !this._mapFetchInProgress) {
      this._mapFetchInProgress = true;
      try {
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
            const direct = this._parseDirectMapData(mapi);
            if (direct) {
              // Prefer a zone-complete map over a zone-less one when multiple
              // MAPI indices respond. If the current candidate has no zones but
              // we already found a zone-complete map, keep looking.
              const directHasZones = direct.mowingAreas && direct.mowingAreas.length > 0;
              const cacheHasZones  = this._cachedMapData?.mowingAreas?.length > 0;
              if (directHasZones || !cacheHasZones) {
                this._activeMapIndex = idx;
                this._cachedMapData = direct;
                this._cachedMAPI = null;
                this.log(`[map] widget refreshed from MAPI idx=${idx}: ${direct.name}, ${direct.mowingAreas.length} zones`);
                if (directHasZones) break; // stop as soon as we have a complete map
              }
            }
          }
        }
      } finally {
        this._mapFetchInProgress = false;
      }
    }
    await this._saveLastCompleteMap().catch((e) => this.log('[map] complete geometry store failed:', e.message));
    // Native map readback only: no coordinates, personal names or geometry in logs.
    this._logNativeForbiddenReadOnly(this._cachedMapData, 'cached-MAP');
    await this._reconcilePylonNativeRules(this._cachedMapData);
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
      // The maintenance point is a native mower target and remains independent from Garage Mode
      // and from the garage overlay master switch.
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
    const garageSensorMode = garageMode && !!this.getSetting('garage_sensor_enabled');
    const rawGarageDoorState = garageSensorMode
      ? (this.getCapabilityValue('garage_door_status') || 'unknown')
      : 'unknown';
    const garageDoorState = rawGarageDoorState === 'open' || rawGarageDoorState === 'closed'
      ? rawGarageDoorState
      : 'unknown';
    const overlayVisibility = {
      showRobot: this.getSetting('map_show_robot_position') !== false,
      showDirection: this.getSetting('map_show_direction') !== false,
      showRoute: this.getSetting('map_show_route') !== false,
      showMaintenancePoint,
      showGarageOverlay,
      garageMode,
      garageSensorMode,
      garageDoorState,
    };
    const nativeRuntimeMowerStatus = String(this._nativeMowerStatus || this.getCapabilityValue('mower_status') || 'unknown');
    const displayRuntimeMowerStatus = this._garageSafety?.getTileStatus
      ? String(this._garageSafety.getTileStatus(nativeRuntimeMowerStatus) || nativeRuntimeMowerStatus)
      : nativeRuntimeMowerStatus;
    const runtimeMapMeta = {
      mowerStatus: displayRuntimeMowerStatus,
      nativeMowerStatus: nativeRuntimeMowerStatus,
      positionUpdatedAt: Number(this._lastLivePosAt || this._livePos?.ts || 0),
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
        return { ...fallback, ...runtimeMapMeta };
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
    const nativeStatusForRoute = String(this._nativeMowerStatus || this.getCapabilityValue('mower_status') || '').toLowerCase();
    const routeSessionActive = isRouteSessionActive(nativeStatusForRoute);
    const completedRoute = this._completedMapRoute;
    const completedRouteForMap = completedRoute
      && Number(completedRoute.mapIndex) === Number(this._activeMapIndex)
      && Array.isArray(completedRoute.path) && completedRoute.path.length > 1;
    // A finished mowing pattern may already be final while the mower is physically
    // returning. Only actual mowing/departure/positioning makes the measured live
    // route authoritative again.
    const liveMowingGeometryActive = new Set(['mowing','edge_mowing','leaving','adjusting','positioning','remote_control'])
      .has(nativeStatusForRoute);
    const visualFinalRoute = !!(completedRouteForMap
      && completedRoute.visualFinal === true
      && !liveMowingGeometryActive
      && !isChargeBreakContinuation(this._chargeBreakResumeUntil));
    if ((!routeSessionActive || visualFinalRoute)
        && completedRouteForMap
        && (visualFinalRoute || completedRoute.path.length > effectiveLivePath.length)) {
      // Keep the frozen mowing geometry during RETURNING as well. The return-to-
      // dock track must not make the completed lawn pattern wavy again.
      effectiveLivePath = completedRoute.path;
    }
    if (telemetryTrail.length && routeSessionActive && !visualFinalRoute) {
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
      // cachedLivePath is already downsampled to a bounded full-session route and
      // telemetryTrail is bounded separately. Keep both complete; taking only the
      // tail drops valid earlier/middle lanes during longer mowing sessions.
      effectiveLivePath = merged;
    }
    this._collectDurableRoute();
    const durable = this._durableRoute?.path(this._activeMapIndex);
    if (visualFinalRoute) effectiveLivePath = completedRoute.path;
    else if (this._durableRoute?.entry(this._activeMapIndex)) effectiveLivePath = durable;
    else if (completedRoute?.path?.length && Number(completedRoute.mapIndex) === Number(this._activeMapIndex) && !this._wasMowingSession) effectiveLivePath = completedRoute.path;
    const legacyCompletedRoute = !routeSessionActive
      && !this._wasMowingSession
      && !isChargeBreakContinuation(this._chargeBreakResumeUntil)
      && completedRouteForMap;
    const finalCompletedRoute = visualFinalRoute || legacyCompletedRoute;
    const displayMapData = this._mapDataForDisplay(this._cachedMapData);
    const base = {
      ...displayMapData,
      livePath: effectiveLivePath,
      // Live mowing keeps the measured path. Once the normal mission has really
      // ended (not a charge-break continuation), the widget consolidates that
      // frozen route into clean alternating lanes for the final presentation.
      routeRenderMode: finalCompletedRoute ? 'final' : 'live',
      routeCompletedAt: finalCompletedRoute ? Number(completedRoute.completedAt || 0) : 0,
      mapRotation: this._dockYaw ?? 0,
      robotAngle: this._cachedArMapPos?.robot?.angle ?? null,
      obstacles: this._cachedObstacles,
      obstaclePylons: this._buildObstaclePylons(),
      mapSafeMowing: this.getSetting('map_safe_mowing') === true,
      pylonUiRevision: Number(this._pylonUiRevision || 0),
      nativeZonePendingDeletes: this._directNativeDeleteUi instanceof Map
        ? [...this._directNativeDeleteUi.entries()].map(([nativeId, op]) => ({ nativeId:Number(nativeId), updatedAt:Number(op?.updatedAt || 0) }))
        : [],
      nativeZoneLabels: this._nativeZoneLabelsForMap(displayMapData),
      nativeZonePolicies: this._nativeZonePoliciesForMap(displayMapData),
      obstacleDiagnostics: {
        updatedAt: this._obstacleDiagUpdatedAt || 0,
        aiobsPresent: this._cachedObstacles?.aiobs != null,
        obsPresent: this._cachedObstacles?.obs != null,
        enforcement: 'diagnostic_only',
      },
      garageOverlay,
      overlayVisibility,
      // Explicit aliases keep older Homey widget caches compatible and make the
      // two required overlays available even when a client cached an older schema.
      safetyLineA: garageOverlay?.lineA || null,
      safetyLineB: garageOverlay?.lineB || null,
      maintenancePoint: garageOverlay?.maintenancePoint || null,
      dangerCenter: garageOverlay?.dangerCenter || null,
      ...runtimeMapMeta,
    };
    const status = nativeRuntimeMowerStatus;
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
