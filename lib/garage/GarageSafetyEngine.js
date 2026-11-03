'use strict';
function userText(homey, key, tokens = {}, fallback = key){try{if(homey&&typeof homey.__==='function')return homey.__(key,tokens);}catch(_){}return String(fallback).replace(/__([A-Za-z0-9_]+)__/g,(_m,n)=>tokens?.[n]??`__${n}__`);}

const GarageMarkerEngine = require('./GarageMarkerEngine');
const MaintenanceDockDepartureWatch = require('./MaintenanceDockDepartureWatch');

async function safeGetStoreValue(device, key) {
  try {
    return await Promise.resolve(device.getStoreValue(key));
  } catch (_) {
    return null;
  }
}

const DOOR_OPEN_DELAY_DEFAULT = 10;
const DOCK_HOME_CONFIRM_MS = 15000;
const MAINTENANCE_TIMEOUT_MS = 300000;
const OUTBOUND_MOWING_STABLE_MS = 3000; // RC59: require stable native mowing after the physical line crossing
const OUTBOUND_EXITING_DISPLAY_MS = 5000;
const OUTBOUND_START_DISPLAY_GRACE_MS = 5000;
const MIN_ADJUSTING_MS = 45000;
const POSITIONING_FALLBACK_MS = 30000;
const OUTBOUND_FREE_DRIVE_MS = 50000;
const DEGRADED_DOOR_WAIT_MS = 25000;
const DEGRADED_DOCK_TIMEOUT_MS = 180000;
const EMERGENCY_HOLD_MS = 120000;
const DOOR_SENSOR_TIMEOUT_MS = 30000;
// The real A2 test needed 54 s before the door contact finally reported OPEN.
// Keep the stopped mower on the lawn while waiting for an enabled real sensor;
// never reinterpret an unconfirmed door as physically open after a timer.
const DOOR_SENSOR_PHYSICAL_OPEN_WAIT_MS = 90000;
const SENSOR_CONTACT_STORE_KEY = 'garage_sensor_last_real_contact';
const SENSOR_MOVEMENT_TIMEOUT_STORE_KEY = 'garage_sensor_last_movement_timeout';
const DEFAULT_MOWER_SPEED_KMH = 1.8;
const RETURN_NEAR_HALF_RATIO = 0.5;
const RETURN_DOOR_ETA_RESERVE_SECONDS = 5;
// Conservative pilot: two observed native STOP -> DOCK cycles had ~30 s between
// accepted DOCK and first reported displacement. This is NOT a proven minimum
// physical reorientation duration. Start with 18 seconds of scheduling
// credit; adapt conservatively only after three qualified native trips (0–24 s)
// and ONLY after a verified native zone STOP, with healthy gate contact,
// fresh lawn-side geometry and the independent A-B emergency brake active.
const RETURN_ZONE_STOP_STARTUP_CREDIT_SECONDS = 18;
// 1.2.85: learn only from three independently confirmed high-cadence STOP->DOCK
// motion starts; sparse MQTT/Cloud positions are not a movement clock.
// v3 starts fresh at 18s; older learned values must not silently override
// the new operator-selected baseline on installation. Old data remain untouched.
const RETURN_STARTUP_STORE_KEY = 'garage_return_startup_learning_v3';
const RETURN_STARTUP_LEARNING_MIN_SAMPLES = 3;
const RETURN_STARTUP_LEARNING_MAX_GAP_MS = 4000;
const RETURN_STARTUP_MAX_CREDIT_SECONDS = 24;
// Native docking/return travel is faster than the speed often measured during
// low-speed mowing. Use a conservative lower bound so a stale mowing average
// cannot make the gate ETA look safer than the mower's actual approach.
const RETURN_ETA_MIN_SPEED_MPS = 0.5;
const RETURN_ETA_LEARNING_STORE_KEY = 'garage_return_eta_learning_v1';
const RETURN_ETA_LEARNING_MIN_SAMPLES = 3;
const RETURN_ETA_LEARNING_MAX_MPS = 1.5;
const MAINTENANCE_CONFIRM_RADIUS_MM = 700;
// Operator-supervised emergency return: watchdog observes, never drives or moves the gate.
const MANUAL_RETURN_WATCH_INTERVAL_MS = 5000;
const MANUAL_RETURN_DEPARTURE_TIMEOUT_MS = 105000;
const MANUAL_RETURN_NO_TELEMETRY_MS = 90000;
const MANUAL_RETURN_PROGRESS_TIMEOUT_MS = 180000;
const MANUAL_RETURN_TOTAL_TIMEOUT_MS = 20 * 60 * 1000;
const MANUAL_RETURN_MOVEMENT_MM = 300;
const MANUAL_RETURN_MAX_EXPLICIT_ATTEMPTS = 2;
const MANUAL_RETURN_UNCONFIRMED_DISPATCH_WAIT_MS = 105000;
const MANUAL_ARRIVAL_PROOF_MAX_MS = 12 * 60 * 60 * 1000;
// Garage return: a maintenance arrival is NOT proved by being somewhere within
// the old 1.2 m shortcut radius. Require recent position, verified arrival and
// additional clearance from the physically moving gate.
const RETURN_OPEN_POSITION_MAX_AGE_MS = 10000;
const RETURN_GATE_CLEARANCE_MM = 350;
// An early OPEN during navigation to a maintenance point needs much larger,
// fresh clearance than the eventual stationary-arrival handoff.
const RETURN_MAINTENANCE_EARLY_GATE_CLEARANCE_MM = 1200;
// Explicit manual gate motion must stay well clear of both physical markers.
// The mower can run just outside the small circular danger zone while passing
// within one wheel-width of the A-B line; that is NOT permission to move a gate.
const MANUAL_GATE_MIN_DANGER_CLEARANCE_MM = 1200;
const MANUAL_GATE_MIN_SAFETY_LINE_DISTANCE_MM = 1200;
// Field 2026-11-02: native zone #103 was stale; actual #102 deletion ACK
// arrived only 3s before the original 20s timeout. Allow another five seconds (30s total)
// for a fresh, authoritative MAPD readback; never count TASK ACK as success.
const RETURN_ZONE_CHECKPOINT_TIMEOUT_MS = 30000;
// A freshly verified stationary maintenance arrival may outlive the live-position
// cache while the physical gate completes its opening cycle. This is a bounded,
// single-use proof for THAT return only, not permission to open the gate again.
const RETURN_MAINTENANCE_RELEASE_PROOF_MAX_MS = 60000;
const RETURN_MAINTENANCE_ARRIVAL_REUSE_MAX_MS = 60000;
const RETURN_STOP_POSITION_MAX_AGE_MS = 3000;
const RETURN_STOP_POSITION_DRIFT_MM = 220;
const RETURN_STOP_POSITION_REQUIRED_MS = 1500;
const RETURN_DIRECT_MIN_DOCK_DISTANCE_MM = 3500;
const RETURN_NATIVE_PAUSE_ACK_TIMEOUT_MS = 4500;
// Real A2 position samples can arrive about every 20 seconds. Give a stopped
// return time to receive INDEPENDENT physical evidence; a timeout is not proof.
const RETURN_LINE_STATIONARY_WAIT_MS = 45000;
const RETURN_POST_LIFECYCLE_POSITION_WAIT_MS = 30000;
const RETURN_STOP_PROOF_REUSE_MS = 60000;
// Manual P1 arrival uses the same 700 mm *verification* radius as native
// status-75 arrival. This is NOT permission to move the stored P1 marker: the
// mower may stop 500–700 mm beside its original-app waypoint.
const MAINTENANCE_AUTO_REALIGN_RADIUS_MM = MAINTENANCE_CONFIRM_RADIUS_MM;
const MAINTENANCE_ADJUSTING_MIN_MS = MIN_ADJUSTING_MS;
const MAINTENANCE_POSITIONING_MAX_MS = POSITIONING_FALLBACK_MS;
const MAINTENANCE_MOVEMENT_START_MM = 180;
const MAINTENANCE_STATIONARY_DRIFT_MM = 180;
const EXTERNAL_START_STATIONARY_ENVELOPE_DRIFT_MM = 250;
const MAINTENANCE_STATIONARY_REQUIRED_MS = 4000;
// A2 field logs show that a valid native maintenance command can need ~32 s
// before the mower physically starts moving. Do not retry based on a transient
// status alone; prove departure from fresh positions, then retry at most once.
const MAINTENANCE_DEPARTURE_GRACE_MS = 45000;
const MAINTENANCE_DEPARTURE_RETRY_GRACE_MS = 45000;
const MAINTENANCE_DEPARTURE_NO_TELEMETRY_MAX_MS = 90000;
const MAINTENANCE_DEPARTURE_CONFIRM_HITS = 2;
const MAINTENANCE_DEPARTURE_CONFIRM_MIN_GAP_MS = 1000;
const RETURN_LINE_WAIT_TIMEOUT_MS = 180000;
const START_MIN_DOOR_OPEN_WAIT_MS = 30000;
const START_AFTER_OPEN_EXTRA_WAIT_MS = 3000;
const OUTBOUND_IGNORE_HOME_MS = 6 * 60 * 1000;
const POSITION_CACHE_MS = 15000;
const START_CONFIRM_NOTICE_MS = 15000;
const START_NATIVE_MOWING_STABLE_MS = 8000;
const OUTBOUND_NATIVE_MOWING_CONFIRM_HITS = 4;
const OUTBOUND_NATIVE_MOWING_CONFIRM_MIN_GAP_MS = 750;
const OUTBOUND_NATIVE_MOWING_CONFIRM_WINDOW_MS = 15000;
const START_CONFIRM_TIMEOUT_MS = 45000;
const START_ONLINE_PREFLIGHT_TIMEOUT_MS = 30000;
const START_ONLINE_PREFLIGHT_POLL_MS = 5000;
const START_CONFIRM_MOVEMENT_MM = 250;
const EXTERNAL_START_PAUSE_SETTLE_MS = 1500;
const SAFETY_LINE_ARM_SAMPLES = 3;
const SAFETY_LINE_CLEARANCE_MM = 800;
const SAFETY_LINE_CROSS_CONFIRM_MM = 500; // field: a shallow/touching side flip is not yet a physical exit
const SAFETY_LINE_DWELL_MIN_CLEARANCE_MM = SAFETY_LINE_CLEARANCE_MM; // dwell/third-crossing fallback may never weaken the normal 800 mm physical clearance
const RETURN_PRELINE_STOP_MM = 1000;
const MAINTENANCE_POINT_CLOSE_GUARD_MM = 1000; // v1.2.1: Priority 2 must not strand the mower at the maintenance point
const DANGER_EXIT_STABLE_MS = 2000;
const DANGER_EXIT_FALLBACK_CLOSE_MS = 5000;
const EXIT_PAUSE_SETTLE_MS = 1200;
const EXIT_RESUME_AFTER_CLOSE_POLL_MS = 500;
const SAFETY_LINE_DWELL_FALLBACK_MS = 10000;
const SAFETY_LINE_DWELL_MIN_ATTEMPTS = 1;
const SAFETY_LINE_PAUSE_FALLBACK_ATTEMPT = 3;
const EXIT_ETA_SAFETY_RESERVE_SECONDS = 5;
const EXIT_POSITION_MAX_AGE_MS = 30000;
const SPATIAL_RETURN_WINDOW_MS = 30000;
const SPATIAL_RETURN_MIN_DURATION_MS = 8000;
const SPATIAL_RETURN_MIN_PROGRESS_MM = 1200;
const SPATIAL_RETURN_STRONG_PROGRESS_MM = 1800;
const SPATIAL_RETURN_TRIGGER_MARGIN_MM = 3000;
const LINE_STATES = Object.freeze({
  IDLE: 'IDLE',
  PENDING: 'LINE_PENDING',
  CROSSED: 'LINE_CROSSED',
  EXIT_CONFIRMED: 'EXIT_CONFIRMED',
  DOOR_CLOSE_ALLOWED: 'DOOR_CLOSE_ALLOWED',
});
const RETURN_STATES = Object.freeze({
  IDLE: 'IDLE',
  STARTED: 'RETURN_STARTED',
  MAINTENANCE: 'MAINTENANCE',
  GARAGE_OPEN: 'GARAGE_OPEN',
  DOCK: 'DOCK',
  HOME_CONFIRMED: 'HOME_CONFIRMED',
});

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

class GarageSafetyEngine {
  constructor(device) {
    this.device = device;
    this.homey = device.homey;

    this.paused = false;
    this.lastRequestedAction = null;
    // Explicit user Pause/Resume guard. A native paused state is never a return
    // request by itself; only an explicit dock/return signal may start return.
    this._userPauseGuardUntil = 0;
    this._userPauseActive = false;

    this._stableOpenTimer = null;
    this._doorFinalTimer = null;
    this._closeTimer = null;
    this._maintenanceWatch = null;
    this._normalMaintenanceDockWatch = null;
    this._normalMaintenanceDockTerminalToken = null;
    this._maintenanceRequestedAt = 0;
    this._manualMaintenanceCalibration = false;
    this._manualMaintenanceTransit = false;
    this._manualMaintenanceRecalibration = false;
    this._manualMaintenanceReached = false;
    this._manualMaintenanceLastPos = null;
    this._manualMaintenanceStableSince = 0;
    this._manualMaintenancePhase = 'idle';
    this._manualMaintenancePhaseStartedAt = 0;
    this._manualMaintenancePhasePos = null;
    this._manualMaintenanceMovementSeen = false;
    this._manualMaintenanceStatusTimers = [];
    // 1.2.12: timestamp of physically confirmed movement toward the locked
    // maintenance point for the active return command. Used to prevent return
    // recovery from stealing an already proven maintenance transit.
    this._maintenanceDepartureConfirmedAt = 0;
    this._maintenanceStartPos = null;
    this._maintenanceStableHits = 0;
    this._maintenanceLastConfirmPositionTs = 0;
    this._maintenanceRealtimeCheckBusy = false;
    this._lastMaintenanceReachedAt = 0;
    this._returnLineStopProof = null;
    this._returnLineWaitTerminalToken = null;
    this._returnMaintenanceStopProof = null;
    // Native dock/charging acknowledgement from the CURRENT cycle. A later stale
    // `returning` frame must not defeat an already verified home-close, but a
    // previous cycle or a restored charging capability must never arm closing.
    this._nativeDockVerifiedAt = 0;
    this._confirmedNativeStationLock = false;
    this._confirmedNativeStationAt = 0;
    this._offSegmentReturnRecoveryAt = 0;
    this._lockedReturnMaintenancePoint = null;

    this._lastDangerInside = false;
    this._lastLineSide = null;
    this._lastLineRawSide = null;
    this._lastLineSideAt = 0;
    this._clearOutboundStatusTimers();
    this._outboundFallbackMowingAllowed = false;
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._closeAfterExitRequested = false;

    this._outbound = null;
    this._exitLifecycleHold = null;
    this._exitLifecycleCheckpoint = null;
    this._outboundStatusTimers = [];
    this._lastHomeAt = 0;
    this._returnGuardActive = false;
    this._externalReturnHandling = false;
    this._homeState = 'unknown';
    this._missionOutside = false;
    this._lastOutdoorActivityAt = 0;
    this._safeReturnInProgress = false;
    this._lastTimelineKey = '';
    this._lastTimelineAt = 0;
    this._lastMissionNotificationKind = '';
    this._lastMissionNotificationAt = 0;
    this._emergencyReverseAt = 0;
    this._emergencyHoldUntil = 0;
    this._dangerReleasedAfterExit = false;
    this._closeScheduled = false;
    this._closeCompleted = false;
    this._lineCloseTimer = null;
    this._lastSafetyLineCrossing = null;
    this._initialBaselineDone = false;
    this._sensorWatchdogTimer = null;
    this._lastSensorContactAt = 0;
    this._lastSensorContactState = null;
    this._operatorDockVisual = null; // Operator display-only sight report, never a native dock proof.
    this._sensorMovementTimeoutAt = 0;
    this._sensorMovementTimeoutReason = null;
    this._lastGateOpenHandshakeAt = 0;
    this._lastDoorOpenReleaseAt = 0;
    this._lastDoorOpenRequestAt = 0;
    this._lastSensorSignalAt = 0;
    this._sensorAvailabilityUpdatedAt = 0;
    this._lastMarkerSetupWarningAt = 0;
    this._lastSafetyBlockNoticeAt = 0;
    this._lastCommandUiStateKey = '';
    this._commandToken = 0;
    this._homeCycleLocked = false;
    this._homeCycleLockedAt = 0;
    this._homeCycleLockPhysicalDepartureAt = 0;
    this._homeCycleLockDepartureSamples = 0;
    this._homeCycleLockDepartureLastAt = 0;
    this._lineState = LINE_STATES.IDLE;
    this._returnContext = RETURN_STATES.IDLE;
    this._resumeGuardUntil = 0;
    // Display-only short acknowledgement for an accepted MOW command made
    // OUTSIDE the garage (including a verified maintenance-point restart).
    // It is not mower telemetry or permission to move/close the gate.
    this._outsideMowingTileUntil = 0;
    this._outsideMowingTileAcceptedAt = 0;
    this._outsideMowingTileTimer = null;
    this._lastPauseAt = 0;
    this._lastResumeMowingAt = 0;
    this._resumeStableSince = 0;
    this._resumeNativeReturnTimer = null;
    // The A2 can emit a very short native RETURNING frame while an external
    // app is merely resuming a paused mowing task. PAUSE_DOCKING is the tell:
    // a real dock return observed in our field logs uses FINISH_DOCKING. Keep a
    // separate debounce so this vendor-app transient cannot seize the garage
    // return state machine.
    this._ambiguousNativeReturnTimer = null;
    this._homeCloseInProgress = false;
    this._outboundHardLockUntil = 0;
    this._startDoorReleasedAt = 0;
    this._startCycleIgnoreReturnUntil = 0;
    // RC36: after an app restart / reinstall the mower may already report
    // docked/charging while the door is open. This must never create an
    // automatic close request. Only a real garage session started in this
    // runtime may schedule Home -> close.
    this._homeCloseArmed = false;
    this._runtimeStartedAt = Date.now();
    this._bootHomeCloseSuppressUntil = this._runtimeStartedAt + 5 * 60 * 1000;

    this.markers = new GarageMarkerEngine(device, { log: (...args) => this.log('[Marker]', ...args) });
    this._garageLineSide = null;
    this._lawnLineSide = null;
    this._returnDecision = null;
    this._awaitingLineDoorOpen = false;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._suspectedPausedReturnTimer = null;
    this._lastSpeedPos = null;
    this._derivedSpeedSamples = [];
    this._returnEtaLearningLoaded = false;
    this._returnEtaLearnedMps = 0;
    this._returnEtaLearningSamples = [];
    this._returnEtaPrediction = null;
    this._returnStartupLearnedCreditSeconds = null;
    this._returnStartupSamples = [];
    this._returnStartupObservation = null;
    this._startConfirmTimer = null;
    this._startConfirmNoticeTimer = null;
    this._startConfirmationPending = false;
    this._startConfirmationFailed = false;
    this._startRetryFn = null;
    this._startRetrySent = false;
    this._startConfirmInitialPos = null;
    this._startConfirmSource = null;
    this._outboundExitLocked = false;
    this._movingGateStartWarningShown = false;
    this._dangerOutsideSince = 0;
    // RC82: closing after an outbound safety-line crossing requires two
    // independent fresh raw positions outside the danger circle. The debounced
    // danger state alone can lag behind the physical mower near the doorway.
    this._rawDangerOutsideSince = 0;
    this._rawDangerOutsideHits = 0;
    this._rawDangerOutsideLastPositionTs = 0;
    this._dangerExitFallbackStarted = false;
    this._exitPauseForCloseActive = false;
    // RC60: hard gate-motion interlock. While the gate is moving, a moving mower
    // may not enter/continue through the danger area. Closing + mower in danger
    // always reverses to open (except confirmed safe-home closing). Unexpected
    // entry while opening reverses to closed; intentional stationary occupancy is
    // filtered first so normal start/return opening cannot oscillate.
    this._gateMotionDangerHits = 0;
    this._gateMotionDangerState = null;
    this._gateMotionDangerFirstAt = 0;
    this._gateMotionDangerLastPositionTs = 0;
    this._gateMotionStartedAt = 0;
    this._gateMotionPauseActive = false;
    this._gateMotionPauseMode = null;
    this._gateMotionPauseAt = 0;
    this._pendingEmergencyMaintenanceReason = null;
    this._emergencyTransitionPromise = null;
    this._emergencyGateWait = null;
    // Emergency gate context remembers the interrupted door direction and mower
    // mission. After the mower has evacuated to the maintenance point, the
    // originally requested gate action is completed before the interrupted
    // mower mission is resumed.
    this._emergencyGateContext = null;
    // RC62: status-independent inbound watchdog. It uses fresh position trends
    // toward the garage/safety line to catch external returns even when the cloud
    // keeps reporting a stale or unknown mower status.
    this._spatialReturnSamples = [];
    this._spatialReturnTriggeredAt = 0;
    this._spatialReturnHandling = false;
    // RC108: closed-gate front-zone watchdog for external-app returns whose
    // native status changes to returning only after the mower is already blocked
    // immediately in front of the garage.
    this._frontGateReturnSamples = [];
    this._frontGateReturnTriggeredAt = 0;
    this._frontGateReturnHandling = false;
    // External Dreame/MOVA app mission intents can arrive over MQTT before the
    // normal device-list status changes to mowing. Keep a short single-flight
    // latch so duplicate 2:50 / 2:56 pushes cannot start parallel garage flows.
    this._externalStartIntentHandling = false;
    this._externalStartIntentAt = 0;
    // External vendor-app start recovery. The A2 cannot reliably resume a
    // station departure once it has been paused a few centimetres outside the
    // dock. Keep this as an explicit, narrow state machine so normal return and
    // home-close logic cannot interfere while we cancel, re-establish native
    // station context and launch a brand-new mowing task.
    this._externalStartRecoveryActive = false;
    this._externalStartRecoveryPhase = null;
    this._externalStartRecoveryStartedAt = 0;
    // A failed PAUSE -> STOP station start can leave a native task queued until
    // the operator manually re-docks. Keep a bounded, restart-safe observation
    // window; it never itself authorizes movement or substitutes dock evidence.
    this._externalStartAbortUntil = 0;
    this._externalStartRedockHoldUntil = 0;
    this._externalMaintenanceSelectionRequiredAt = 0; // User-chosen P1-P5 after incomplete vendor opcode 109.
    this._manualOperatorPosition = 'unknown'; // Operator observation, NEVER GPS evidence.
    // External-start interception deliberately does not use Dreame DND.
    // Field testing showed DND does not prevent a manual/original-app start on A2.
    this._timelineSeen = new Map();
    this._degradedDockTimer = null;
  }

  cancelPendingCommand(reason = 'superseded') {
    this._normalMaintenanceDockWatch?.stop(reason);
    this._normalMaintenanceDockTerminalToken = null;
    this._maintenanceArrivalClose = null;
    if (this._pausedMaintenanceHandoff) {
      // A new command invalidates the tracked paused waypoint, including the
      // display-only transit record that would otherwise accept a late P2.
      this._manualMaintenanceTransit = false;
      this._manualMaintenanceReached = false;
      this._manualMaintenancePhase = 'idle';
      this._maintenanceRequestedAt = 0;
    }
    this._pausedMaintenanceHandoff = null; // superseded trips must never close the gate later
    this._invalidateHomeClose(reason);
    clearTimeout(this._returnRecoveryHold?.timer);
    this._returnRecoveryHold = null;
    this._returnRecoveryRequest = null;
    clearTimeout(this._emergencyRecoveryWatchdog);
    this._emergencyRecoveryWatchdog = null;
    this._commandToken += 1;
    this._returnStartupObservation=null;
    this.log('cancel pending garage command', reason, 'token=', this._commandToken);
    clearInterval(this._degradedDockTimer);
    this._degradedDockTimer = null;
    clearInterval(this._maintenanceWatch);
    this._maintenanceWatch = null;
    this._maintenanceStartPos = null;
    this._maintenanceStableHits = 0;
    this._maintenanceLastConfirmPositionTs = 0;
    this._maintenanceRequestedAt = 0;
    this._lastMaintenanceReachedAt = 0;
    this._returnLineStopProof = null;
    this._returnLineWaitTerminalToken = null;
    this._returnMaintenanceStopProof = null;
    this._lockedReturnMaintenancePoint = null;
    clearTimeout(this._closeTimer);
    this._closeTimer = null;
    clearTimeout(this._lineCloseTimer);
    this._lineCloseTimer = null;
    this._closeScheduled = false;
    this._returnGuardActive = false;
    this._externalReturnHandling = false;
    this._safeReturnInProgress = false;
    this._closeAfterExitRequested = false;
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._dangerReleasedAfterExit = false;
    this._lastLineSide = null;
    this._lastLineRawSide = null;
    this._lastLineSideAt = 0;
    this._lineState = LINE_STATES.IDLE;
    this._returnContext = RETURN_STATES.IDLE;
    this._resumeGuardUntil = 0;
    this._clearOutsideMowingTileAck();
    this._lastPauseAt = 0;
    this._lastResumeMowingAt = 0;
    this._resumeStableSince = 0;
    if (this._resumeNativeReturnTimer) clearTimeout(this._resumeNativeReturnTimer);
    this._resumeNativeReturnTimer = null;
    if (this._ambiguousNativeReturnTimer) clearTimeout(this._ambiguousNativeReturnTimer);
    this._ambiguousNativeReturnTimer = null;
    this._homeCloseInProgress = false;
    this._outboundHardLockUntil = 0;
    this._startDoorReleasedAt = 0;
    this._startCycleIgnoreReturnUntil = 0;
    this._emergencyHoldUntil = 0;
    this._dangerReleasedAfterExit = false;
    this._clearOutboundStatusTimers();
    this._outbound = null;
    this._outboundFallbackMowingAllowed = false;
    this._returnDecision = null;
    this._lockedReturnMaintenancePoint = null;
    this._awaitingLineDoorOpen = false;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._suspectedPausedReturnTimer = null;
    clearTimeout(this._startConfirmTimer);
    clearTimeout(this._startConfirmNoticeTimer);
    this._startConfirmTimer = null;
    this._startConfirmNoticeTimer = null;
    this._startConfirmationPending = false;
    this._startConfirmationFailed = false;
    this._startConfirmInitialPos = null;
    this._startConfirmSource = null;
    this._outboundExitLocked = false;
    this._movingGateStartWarningShown = false;
    this._dangerOutsideSince = 0;
    this._rawDangerOutsideSince = 0;
    this._rawDangerOutsideHits = 0;
    this._rawDangerOutsideLastPositionTs = 0;
    this._dangerExitFallbackStarted = false;
    this._exitPauseForCloseActive = false;
    this._gateMotionDangerHits = 0;
    this._gateMotionDangerState = null;
    this._gateMotionDangerFirstAt = 0;
    this._gateMotionPauseActive = false;
    this._gateMotionPauseMode = null;
    this._gateMotionPauseAt = 0;
    this._pendingEmergencyMaintenanceReason = null;
    this._emergencyGateContext = null;
    this._spatialReturnSamples = [];
    this._spatialReturnTriggeredAt = 0;
    this._spatialReturnHandling = false;
    this._frontGateReturnSamples = [];
    this._frontGateReturnTriggeredAt = 0;
    this._frontGateReturnHandling = false;
    this._externalStartIntentHandling = false;
    this._externalStartIntentAt = 0;
    this._externalStartRecoveryActive = false;
    this._externalStartRecoveryPhase = null;
    this._externalStartRecoveryStartedAt = 0;
    this.lastRequestedAction = null;
  }

  _clearOutsideMowingTileAck() {
    this._outsideMowingTileUntil = 0;
    this._outsideMowingTileAcceptedAt = 0;
    if (this._outsideMowingTileTimer) clearTimeout(this._outsideMowingTileTimer);
    this._outsideMowingTileTimer = null;
  }

  _ackOutsideMowingTile(source = 'outside_start') {
    // Only an accepted outdoor command can make the tile show Mäht without
    // waiting for the next slow MQTT mower-status frame. Never create a garage
    // departure phase, fake native mowing, or modify a gate-close interlock.
    if (!this.enabled() || this._outbound || this._manualMaintenanceTransit
        || this.isReturnCycleActive() || this._manualGateStopped
        || this.isDockedHomeStatus() || ['opening', 'closing'].includes(this.doorState())
        || !(this._missionOutside || this._manualMaintenanceReached || this._homeState === 'away')) return false;
    this._clearOutsideMowingTileAck();
    this._manualMaintenanceReached = false;
    this._manualMaintenanceTargetReachedIndex = 0;
    this._manualMaintenancePhase = 'idle';
    this._manualMaintenanceCalibration = false;
    this._manualMaintenanceRecalibration = false;
    if (this._returnContext === RETURN_STATES.MAINTENANCE) this._returnContext = RETURN_STATES.IDLE;
    this._homeState = 'away';
    this._missionOutside = true;
    this._outsideMowingTileAcceptedAt = Date.now();
    this._outsideMowingTileUntil = this._outsideMowingTileAcceptedAt + 30000;
    this._outsideMowingTileTimer = setTimeout(() => {
      this._outsideMowingTileTimer = null;
      this._outsideMowingTileUntil = 0;
      this._outsideMowingTileAcceptedAt = 0;
      this.refreshTileStatus('outside mowing acknowledgement expired').catch(() => {});
    }, 30000);
    this._outsideMowingTileTimer.unref?.();
    this.log('outdoor mowing accepted: UI Mäht, no new garage departure', source);
    return true;
  }

  async markOutsideResumeAccepted(source = 'outside_resume') {
    if (!this._ackOutsideMowingTile(source)) return false;
    await this.refreshTileStatus(`outside mowing accepted: ${source}`).catch(() => {});
    return true;
  }

  markResumeInProgress(ms = 120000, reason = 'resume') {
    this._clearOutsideMowingTileAck();
    this._resumeGuardUntil = Date.now() + Math.max(60000, Number(ms) || 120000);
    this._resumeStableSince = 0;
    if (this._resumeNativeReturnTimer) clearTimeout(this._resumeNativeReturnTimer);
    this._resumeNativeReturnTimer = null;
    // A deliberate resume must start with a clean inbound detector window. Old
    // samples from the pause phase can otherwise look like movement back toward
    // the garage and immediately trigger the external return interceptor.
    this._spatialReturnSamples = [];
    this._spatialReturnTriggeredAt = 0;
    this._cancelSuspectedPausedReturn?.();
    // Do not optimistically show "Mäht" while the robot/cloud is still paused.
    // Resume is only displayed as mowing once native status confirms mowing.
    this._resumeDisplayStatus = null;
    this.lastRequestedAction = reason || 'resume';
    this.log('resume guard active', reason || 'resume');
  }

  _clearResumeGuard(reason = 'stable_mowing') {
    if (!this._resumeGuardUntil) return false;
    this._resumeGuardUntil = 0;
    this._resumeStableSince = 0;
    this._resumeDisplayStatus = null;
    this._userPauseActive = false;
    this._userPauseGuardUntil = 0;
    if (this._resumeNativeReturnTimer) clearTimeout(this._resumeNativeReturnTimer);
    this._resumeNativeReturnTimer = null;
    if (/resume|fortsetzen|start_as_resume/i.test(String(this.lastRequestedAction || ''))) {
      this.lastRequestedAction = 'mowing';
    }
    this.log('resume guard released', reason);
    return true;
  }

  async _maybeReleaseResumeGuard(status = this.status(), dangerState = null) {
    const now = Date.now();
    if (!(this._resumeGuardUntil && now < this._resumeGuardUntil)) {
      this._resumeStableSince = 0;
      return false;
    }
    const nativeStatus = String(status || this.status() || '').toLowerCase();
    const doorIdleClosed = this.doorState() === 'closed';
    const returnInactive = !['returning', 'error'].includes(nativeStatus)
      && !this._safeReturnInProgress && !this._returnGuardActive
      && !this._externalReturnHandling && !this._spatialReturnHandling;
    let danger = dangerState;
    if (!danger) danger = await this.markers.dangerState().catch(() => null);
    const safelyOutside = !!danger && danger.known !== false && danger.inside === false;
    const stableCandidate = nativeStatus === 'mowing' && this._missionOutside
      && safelyOutside && returnInactive && doorIdleClosed;
    if (!stableCandidate) {
      this._resumeStableSince = 0;
      return false;
    }
    if (!this._resumeStableSince) this._resumeStableSince = now;
    if (now - this._resumeStableSince < 5000) return false;
    const released = this._clearResumeGuard('stable mowing outside danger area; no return or gate action');
    if (released) await this.refreshTileStatus('resume guard released').catch(() => {});
    return released;
  }

  _scheduleNativeReturnDuringResumeGuard(status = 'returning') {
    if (this._resumeNativeReturnTimer) return;
    this.log('native return observed during resume guard; verifying stable return', status);
    this._resumeNativeReturnTimer = setTimeout(async () => {
      this._resumeNativeReturnTimer = null;
      if (!this.enabled() || this.isDockedHomeStatus()) return;
      const current = String(this.status() || '').toLowerCase();
      if (current !== 'returning') return;
      if (this._safeReturnInProgress || this._returnGuardActive || this._externalReturnHandling) return;
      this._clearResumeGuard('stable native return confirmed');
      await this._interceptExternalReturn('status_returning_confirmed_after_resume', current).catch((e) => this.error('confirmed native return after resume', e.message));
    }, 6000);
  }

  _cancelAmbiguousNativeReturn() {
    if (this._ambiguousNativeReturnTimer) clearTimeout(this._ambiguousNativeReturnTimer);
    this._ambiguousNativeReturnTimer = null;
  }

  _nativeReturnLooksLikePauseResumeTransient(prevStatus = '') {
    if (!this._missionOutside || this._outbound || this._safeReturnInProgress || this._returnGuardActive) return false;
    const diag = this.device?._mowerBinaryDiag;
    const diagAt = Number(this.device?._mowerBinaryDiagAt || 0);
    const age = Date.now() - diagAt;
    if (!diag || !diagAt || age < 0 || age > 3000) return false;
    if (String(diag.dockingState || '') !== 'PAUSE_DOCKING' || Number(diag.undocking || 0) !== 0) return false;
    const prev = String(prevStatus || '').toLowerCase();
    return ['mowing', 'paused', 'idle', 'standby'].includes(prev);
  }

  _scheduleAmbiguousNativeReturnConfirmation(prevStatus = '') {
    if (this._ambiguousNativeReturnTimer || !this.enabled()) return;
    this.log('native returning with PAUSE_DOCKING after mowing/pause; verifying real return', `prev=${prevStatus || '-'}`);
    this._ambiguousNativeReturnTimer = setTimeout(async () => {
      this._ambiguousNativeReturnTimer = null;
      if (!this.enabled() || this.isDockedHomeStatus()) return;
      if (this._safeReturnInProgress || this._returnGuardActive || this._externalReturnHandling) return;
      const current = String(this.status() || '').toLowerCase();
      if (current !== 'returning') {
        this.log('ambiguous native return cleared: mower no longer returning', current || 'unknown');
        return;
      }
      const diag = this.device?._mowerBinaryDiag;
      const diagAge = Date.now() - Number(this.device?._mowerBinaryDiagAt || 0);
      this.log('ambiguous native return persisted; accepting as real return',
        `dock=${diag?.dockingState || 'unknown'}`, `age=${Number.isFinite(diagAge) ? diagAge : '?'}ms`);
      await this._interceptExternalReturn('status_returning_confirmed_after_pause_docking', current)
        .catch((e) => this.error('confirmed native return after PAUSE_DOCKING debounce', e.message));
    }, 3000);
  }

  beginUserCommand(command) {
    // A later button must not cancel a still-running emergency and invalidate
    // its token. Explicit STOP aborts automatic recovery and LATCHES manual
    // gate-stop protection; it does NOT silently return to normal operation.
    if (this._emergencyHoldActive()) {
      if (this._manualRecoveryActive && ['maintenance', 'dock'].includes(command)) return true;
      if (this._manualRecoveryActive && /^maintenance_point_[1-5]$/.test(String(command))) return true;
      if (command !== 'stop') return !this._emergencyCommandBlocked(`button:${command}`);
      this.cancelPendingCommand('emergency_manual_stop');
      this._manualGateStopped = true;
      this._emergencyGateWait = null;
      this.lastRequestedAction = 'emergency_manual_stop';
      this.log('EMERGENCY user STOP: automation cancelled; manual gate-stop latch retained');
      Promise.resolve(this.device?.setStoreValue?.('garage_manual_gate_stopped', true)).catch(() => {});
      this._trigger('garage_stop_requested', 'emergency_manual_stop');
      this._setSafetyStatus('blocked', 'emergency_manual_stop_requires_clearance').catch(() => {});
      return true;
    }
    // Only one long garage command may be pending. New explicit user actions
    // replace older maintenance/return/start waits instead of being queued.
    const switchingCommands = ['start_mowing', 'start_spot', 'dock', 'maintenance', 'stop'];
    const maintenanceSelection = /^maintenance_point_[2-5]$/.test(String(command || ''));
    const isSwitchingCommand = switchingCommands.includes(command) || maintenanceSelection;
    if (isSwitchingCommand) {
      this.cancelPendingCommand(`new_${command}`);
    } else {
      this._commandToken += 1;
    }
    if (isSwitchingCommand) {
      // A deliberate new user command starts a new logical cycle and may leave
      // the docked-idle lock. The command guards still decide whether it is
      // allowed (for example Wartungspunkt from home stays blocked).
      this._homeCycleLocked = false;
      this._homeCycleLockedAt = 0;
      if (['start_mowing', 'start_spot', 'dock'].includes(command)) {
        this._homeCloseArmed = true;
      }
    }
    this.lastRequestedAction = command;
    this.log('active garage command', command, 'token=', this._commandToken);
    return true;
  }

  _language() {
    try {
      return String(this.homey?.i18n?.getLanguage?.() || 'en').toLowerCase();
    } catch (e) { return 'en'; }
  }

  _text(de, en) {
    return this._language().startsWith('de') ? de : en;
  }

  _maintenancePointLabel(pointIndex = null) {
    const fromReason = String(pointIndex || '').match(/(?:^|[^0-9])point[_ ]?(\d+)/i);
    const index = Math.max(1, Math.min(5, Math.trunc(Number(fromReason?.[1] || pointIndex)
      || Number(this.device?._manualMaintenanceTargetReachedIndex)
      || Number(this.device?._nativeMaintenanceTargetIndex)
      || 1)));
    const name = typeof this.device?._maintenancePointName === 'function'
      ? this.device._maintenancePointName(index)
      : `Wartungspunkt ${index}`;
    return `${this._text('Wartungspunkt', 'Maintenance point')} (${name}, P${index})`;
  }

  _formatLogArgs(args) {
    return args.map((arg) => {
      if (arg instanceof Error) return arg.message;
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch (e) { return String(arg); }
    }).join(' ');
  }

  _compactGarageNotice(kind, reason = '', originalMessage = '') {
    // Push cards must be readable at a glance. Full diagnostics remain in
    // the logger and in the unchanged Flow `reason` token. Verbose mode keeps
    // the previous detailed human message for troubleshooting.
    if (this._garageOption('garage_debug_verbose')) return String(originalMessage || kind);
    const T = (de, en) => this._text(de, en);
    const type = String(kind || '');
    const why = String(reason || '');
    if (type === 'maintenance_selection_required') return T(
      'Wartungspunkt wählen – Homey öffnen.', 'Choose a maintenance point – open Homey.');
    if (type === 'emergency') return T(
      '🚨 Mäher-Notfall! Mäher und Tor prüfen.', '🚨 Mower emergency! Check mower and gate.');
    if (type === 'gate_open_unconfirmed') return T(
      '⛔ Toröffnung nicht bestätigt. Tor prüfen.',
      '⛔ Gate opening not confirmed. Check the gate.');
    if (type === 'safety_block') {
      if (/door_open|gate_not_open|sensor_offen/.test(why)) return T(
        '⛔ Toröffnung nicht bestätigt. Tor prüfen.', '⛔ Gate opening not confirmed. Check the gate.');
      if (/station_window|dock|maintenance/.test(why)) return T(
        '⛔ Mäher gestoppt. Andocken oder Position prüfen.',
        '⛔ Mower stopped. Check docking or position.');
      return T('⛔ Sicherheitssperre. Mäher und Tor prüfen.',
        '⛔ Safety block. Check mower and gate.');
    }
    if (type === 'safety_warning') {
      if (/sensor_open|sensor_offen|door_open|gate_open/.test(why)) return T(
        '⚠️ Toröffnung nicht bestätigt.', '⚠️ Gate opening not confirmed.');
      if (/sensor_close|sensor_geschlossen|door_close/.test(why)) return T(
        '⚠️ Torschließung nicht bestätigt.', '⚠️ Gate closing not confirmed.');
      return T('⚠️ Garagenstatus prüfen.', '⚠️ Check garage status.');
    }
    const messages = {
      door_opening: T('Toröffnung angefordert.', 'Gate opening requested.'),
      door_closing: T('Torschließung angefordert.', 'Gate closing requested.'),
      departure: T('Ausfahrt wird vorbereitet.', 'Preparing garage departure.'),
      return: T('Mäher kommt zurück.', 'Mower returning.'),
      sensor_unavailable: T('Torsensor nicht erreichbar.', 'Gate sensor unavailable.'),
      position_uncertain: T('Mäherposition unklar.', 'Mower position unknown.'),
      external_start_blocked: T('Start aus Original-App angehalten.', 'Original-app start paused.'),
      external_start: T('Start aus Original-App angehalten.', 'Original-app start paused.'),
    };
    return messages[type] || String(originalMessage || T('Garagenhinweis', 'Garage notice'));
  }

  _garageNotice(kind, message, reason = '', dedupeMs = 120000) {
    // One central, device-scoped, bilingual Flow trigger. True safety events
    // and unknown original-app point requests are mandatory in Garage Mode;
    // routine movement and nonblocking warnings are controlled by the repair
    // settings checkbox. Existing legacy Flow cards continue to fire in parallel.
    if (!this.device?.getSetting?.('garage_mode_enabled')) return;
    const mandatory = ['emergency', 'safety_block', 'maintenance_selection_required', 'gate_open_unconfirmed'];
    if (!mandatory.includes(String(kind)) && !this._garageOption('garage_mission_push_notifications')) return;
    const normalized = String(kind || 'notice');
    const now = Date.now();
    if (!this._garageNoticeSeen) this._garageNoticeSeen = new Map();
    const last = Number(this._garageNoticeSeen.get(normalized) || 0);
    if (last && now - last < Math.max(1000, Number(dedupeMs) || 0)) return;
    this._garageNoticeSeen.set(normalized, now);
    if (this._garageNoticeSeen.size > 12) {
      for (const [key, ts] of this._garageNoticeSeen) {
        if (now - ts > 10 * 60 * 1000) this._garageNoticeSeen.delete(key);
      }
    }
    this._trigger('garage_mower_notice', reason || normalized, {
      kind: normalized,
      message: this._compactGarageNotice(normalized, reason, message),
    });
    this.log('garage notice flow trigger', normalized, reason || '');
  }

  _garageNoticeReason(reason) {
    // Localize familiar diagnostic reasons, but never fabricate an explanation
    // when the vendor/app returns an unknown code. Expose it as a labelled
    // technical reason so German messages do not silently become English prose.
    const raw = String(reason || '').trim();
    if (!raw) return this._text('Grund nicht übermittelt', 'Reason not provided');
    const known = {
      automatic_dock_exhausted_return_maintenance_dock_departure_unclear: this._text(
        'Rückkehr am Wartungspunkt: Bewegung zum Dock nicht sicher bestätigt',
        'Return at maintenance point: movement toward dock not safely confirmed'),
      return_original_direct_physical_proof_missing: this._text(
        'Rückkehr angehalten: frischer Stillstands- oder Positionsnachweis fehlt; Tor bleibt gesichert',
        'Return held: fresh stationary or position proof missing; gate remains secured'),
      return_zone_stop_unconfirmed: this._text(
        'Rückkehr angehalten: nativer STOP nicht bestätigt',
        'Return held: native STOP not confirmed'),
      maintenance_current_unconfirmed: this._text(
        'Wartungspunkt erreicht gemeldet, aber aktuelle physische Freigabe noch nicht bestätigt',
        'Maintenance arrival reported, but current physical clearance not verified'),
      external_start_waiting_for_explicit_point: this._text(
        'Wartungspunkt muss ausgewählt werden', 'Maintenance point must be selected'),
    };
    if (known[raw]) return known[raw];
    const battery = raw.match(/^sensor_battery_low_(\d+)_fallback_to_timer$/);
    if (battery) return this._text(
      `Garagentor-Sensor bei ${battery[1]} %: Zeitsteuerung statt Kontaktsignal`,
      `Garage door sensor at ${battery[1]}%: using timed fallback instead of contact confirmation`);
    const readable = this._humanReason(raw);
    if (readable && readable !== raw.replace(/_/g, ' ')) return readable;
    return `${this._text('Technischer Grund', 'Technical reason')}: ${raw}`;
  }

  _missionNotification(kind) {
    const normalized = kind === 'return' ? 'return' : 'departure';
    const message = normalized === 'return'
      ? this._text('⚠️ Achtung, Mäher Rückkehr', '⚠️ Mower returning')
      : this._text('⚠️ Achtung, Mäher Ausfahrt', '⚠️ Mower departing');
    this._garageNotice(normalized, message, normalized, 120000);
  }

  _timeline(message, key = '') {
    if (!this._garageOption('garage_logging_enabled')) return;
    if (!this.device.getSetting('garage_mode_enabled')) return;
    const clean = String(message || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    // RC28: tiny log buffer to make asynchronous Homey events appear ordered.
    if (!this._timelineFlushing && !String(key || '').startsWith('flush:')) {
      if (!this._timelineQueue) this._timelineQueue = [];
      this._timelineQueue.push({ message: clean, key, at: Date.now() });
      clearTimeout(this._timelineFlushTimer);
      this._timelineFlushTimer = setTimeout(() => this._flushTimelineQueue(), 350);
      return;
    }
    const debug = !!this._garageOption('garage_debug_verbose');
    // Normal mode is an explicit user-facing allowlist. Technical state-machine
    // values, measurements, reasons and flow diagnostics are visible only when
    // verbose debug logging is enabled.
    if (!debug) {
      const normalizedKey = String(key || '').replace(/^flush:/, '');
      const allowedPrefixes = [
        'state:tile:', 'state:door:', 'button:', 'button-block:', 'button-dup:',
        'cmd:', 'request:open:', 'request:close:', 'block:', 'error:', 'emergency:',
        'safety:blocked:', 'safety:emergency:',
        'state:maintenance_', 'state:return_continue_from_maintenance',
        'state:danger:', 'state:line:exit_confirmed', 'state:line:door_close_allowed',
        'state:line:lawn', 'state:line:garage', 'state:line:wrong',
        'state:adjusting:', 'state:home_close_scheduled', 'return:linewait:',
        'return:external_parallel_open', 'return:closed_gate_front_zone',
        'maintenance:return_takeover:', 'markers:validated', 'setup:', 'close:', 'realtime:'
      ];
      const allowedExact = new Set([
        'return:linewait:released',
        'state:maintenance_transit', 'state:maintenance_map_read',
        'state:maintenance_reached', 'block:maintenance_timeout',
        'block:garage_open_timeout'
      ]);
      const allowed = allowedExact.has(normalizedKey)
        || allowedPrefixes.some((prefix) => normalizedKey.startsWith(prefix));
      if (!allowed) return;
    }
    const text = `[Garage] ${clean.slice(0, 220)}`;
    const now = Date.now();
    const dedupeKey = String(key || text).replace(/^flush:/, '');
    const last = this._timelineSeen.get(dedupeKey) || 0;
    // Homey timeline must be readable. Suppress repeated poll/guard events for a
    // short window, while still keeping state changes and real blocks visible.
    const quietKey = String(key || '').replace(/^flush:/, '');
    const quietMs = quietKey && quietKey.startsWith('state:') ? 60000 : 10000;
    if (now - last < quietMs) return;
    this._timelineSeen.set(dedupeKey, now);
    if (this._timelineSeen.size > 50) {
      const cutoff = now - 60000;
      for (const [k, ts] of this._timelineSeen) if (ts < cutoff) this._timelineSeen.delete(k);
    }
    this._lastTimelineKey = dedupeKey;
    this._lastTimelineAt = now;
    try {
      if (this.homey.notifications && typeof this.homey.notifications.createNotification === 'function') {
        this.homey.notifications.createNotification({ excerpt: text }).catch(() => {});
      }
    } catch (e) {}
  }

  _flushTimelineQueue() {
    const q = this._timelineQueue || [];
    this._timelineQueue = [];
    if (!q.length) return;
    const priority = (e) => {
      const k = String(e.key || '');
      if (k.includes('door')) return 10;
      if (k.includes('adjusting') || k.includes('tile:garage_exiting') || k.includes('tile:garage_positioning')) return 20;
      if (k.includes('line')) return 30;
      if (k.includes('close')) return 40;
      if (k.includes('return')) return 50;
      if (k.includes('home')) return 60;
      return 70;
    };
    q.sort((a, b) => (a.at - b.at) || (priority(a) - priority(b)));
    this._timelineFlushing = true;
    try {
      for (const e of q) this._timeline(e.message, `flush:${e.key || e.message}`);
    } finally {
      this._timelineFlushing = false;
    }
  }

  _timelineFromLog(args, raw) {
    const first = String(args[0] || '');
    const second = String(args[1] || '');
    const third = String(args[2] || '');
    const T = (de, en) => this._text(de, en);
    const mapStatus = {
      ok: T('Sicherheit wieder frei', 'Safety clear again'),
      warning: T('Sicherheit: Warnung', 'Safety: warning'),
      blocked: T('Sicherheit: blockiert', 'Safety: blocked'),
      emergency: T('NOTFALL', 'EMERGENCY'),
    };
    const statusNames = {
      garage_zone_removing: T('Sperrzonen ausblenden', 'Hiding no-go zones'),
      garage_zone_restoring: T('Sperrzonen einblenden', 'Restoring no-go zones'),
      garage_home: T('Zuhause', 'Home'), garage_adjusting: T('Justieren', 'Adjusting'),
      garage_opening: T('Garage öffnet', 'Garage opening'), garage_closing: T('Garage schließt', 'Garage closing'),
      garage_start_pending: T('Startbefehl wird ausgeführt', 'Starting mower'), garage_exiting: T('Ausfahrt', 'Exiting'), garage_maintenance_transit: T('Fährt zum Wartungspunkt', 'Going to maintenance point'), garage_maintenance_reached: T('Wartungspunkt erreicht', 'Maintenance point reached'), garage_free_drive: T('Positionieren', 'Positioning'), garage_positioning: T('Positionieren', 'Positioning'),
      mowing: T('Mäht', 'Mowing'), paused: T('Pausiert', 'Paused'), idle: T('Bereit', 'Ready'),
      returning: T('Rückkehr', 'Returning'), docked: T('Gedockt', 'Docked'), charging: T('Lädt', 'Charging'),
    };
    if (first === 'tile status') return { key: `state:tile:${second}`, msg: `${T('Status', 'Status')}: ${statusNames[second] || second}` };
    if (first === 'door state') {
      const names = { opening: T('Tor öffnet', 'Door opening'), open: T('Tor offen', 'Door open'), closing: T('Tor schließt', 'Door closing'), closed: T('Tor geschlossen', 'Door closed'), unknown: T('Tor unbekannt', 'Door state unknown') };
      return { key: `state:door:${second}`, msg: names[second] || `${T('Torstatus', 'Door status')}: ${second}` };
    }
    if (first === 'safety status') return { key: `safety:${second}:${third}`, msg: `${mapStatus[second] || T('Sicherheit', 'Safety')}${third ? ` – ${this._humanReason(third)}` : ''}` };
    if (first === 'request open') return { key: `request:open:${second}`, msg: `${T('Garagentor wird geöffnet', 'Garage door is opening')}${second ? ` – ${this._humanReason(second)}` : ''}` };
    if (first === 'request close' || first === 'close requested') return { key: `request:close:${second}`, msg: `${T('Garagentor wird geschlossen', 'Garage door is closing')}${second ? ` – ${this._humanReason(second)}` : ''}` };
    if (first === 'door open timeout') return { key: 'block:garage_open_timeout', msg: T('Toröffnung Timeout – blockiert', 'Door opening timed out – blocked') };
    if (first === 'manual maintenance transit started') return { key: 'state:maintenance_requested', msg: `${T('Wartungspunktfahrt angefordert', 'Maintenance-point trip requested')} – ${this._maintenancePointLabel()}` };
    if (first === 'maintenance departure requested') return { key: 'state:maintenance_requested', msg: `${T('Wartungspunktfahrt angefordert – Start wird geprüft', 'Maintenance-point trip requested – waiting for departure proof')} – ${this._maintenancePointLabel(second)}` };
    if (first === 'maintenance departure confirmed') return { key: 'state:maintenance_departed', msg: `${T('Fährt zum Wartungspunkt – Bewegung bestätigt', 'Going to maintenance point – movement confirmed')} – ${this._maintenancePointLabel(second)}` };
    if (first === 'maintenance departure retry') return { key: 'state:maintenance_retry', msg: `${T('Wartungspunktfahrt startet nicht – Befehl wird einmal wiederholt', 'Maintenance-point trip did not start – retrying command once')} – ${this._maintenancePointLabel(second)}` };
    if (first === 'maintenance departure failed') return { key: 'block:maintenance_departure_failed', msg: `${T('Wartungspunktfahrt nicht gestartet – blockiert', 'Maintenance-point trip did not start – blocked')} – ${this._maintenancePointLabel(second)}` };
    if (first === 'manual maintenance position read from native map') return { key: 'state:maintenance_map_read', msg: `${T('Wartungspunkt aus Originalkarte gelesen', 'Maintenance point read from original map')} – ${this._maintenancePointLabel(second)}` };
    if (first === 'maintenance point reached') return { key: 'state:maintenance_reached', msg: `${this._maintenancePointLabel(second)} ${T('erreicht', 'reached')}` };
    if (first === 'return continues from maintenance point') return { key: 'state:return_continue_from_maintenance', msg: `${T('Rückkehr vom Wartungspunkt zur Garage fortgesetzt', 'Return from maintenance point to garage continued')} – ${this._maintenancePointLabel(second)}` };
    if (first === 'maintenance point timeout') return { key: 'block:maintenance_timeout', msg: `${T('Wartungspunkt Timeout – blockiert', 'Maintenance point timed out – blocked')} – ${this._maintenancePointLabel(second)}` };
    if (first === 'danger area') return { key: `state:danger:${second}`, msg: second === 'inside' ? T('Mäher im Gefahrenbereich', 'Mower in danger area') : T('Mäher außerhalb Gefahrenbereich', 'Mower outside danger area') };
    if (first === 'line state') {
      if (!this._garageOption('garage_debug_verbose')) return null;
      const lineNames = {
        IDLE: T('inaktiv', 'idle'),
        LINE_PENDING: T('Linie erkannt – Freigabe wird geprüft', 'line detected – release is being checked'),
        LINE_CROSSED: T('Linie überfahren', 'line crossed'),
        EXIT_CONFIRMED: T('Ausfahrt bestätigt', 'exit confirmed'),
        DOOR_CLOSE_ALLOWED: T('Schließen freigegeben', 'closing allowed'),
      };
      const label = lineNames[second] || this._humanReason(second);
      return { key: `state:line:${second}`, msg: `${T('Sicherheitslinie', 'Safety line')}: ${label}${third ? ` – ${this._humanReason(third)}` : ''}` };
    }
    if (first === 'exit confirmed') return { key: 'state:line:exit_confirmed', msg: T('Ausfahrt bestätigt', 'Exit confirmed') };
    if (first === 'door close allowed') return { key: 'state:line:door_close_allowed', msg: T('Tor darf geschlossen werden', 'Door may be closed') };
    if (first === 'return context') {
      if (!this._garageOption('garage_debug_verbose')) return null;
      const names = {
        IDLE: T('Rückkehr beendet', 'Return finished'),
        RETURN_STARTED: T('Rückkehr erkannt', 'Return detected'),
        MAINTENANCE: T('Wartungspunkt-Route aktiv', 'Maintenance-point route active'),
        GARAGE_OPEN: T('Tor offen – Rückkehr freigegeben', 'Door open – return released'),
        DOCK: T('Fährt zur Garage', 'Going to garage'),
        HOME_CONFIRMED: T('Zuhause bestätigt', 'Home confirmed'),
      };
      return { key: `state:return:${second}`, msg: names[second] || `${T('Rückkehrstatus', 'Return status')}: ${this._humanReason(second)}` };
    }
    if (first === 'return decision') return this._garageOption('garage_debug_verbose') ? { key: `return:decision:${second}:${third}`, msg: `${T('Rückkehr-Entscheidung', 'Return decision')}: ${this._humanReason(second)}${third ? ` – ${third}` : ''}` } : null;
    if (first === 'speed basis') return this._garageOption('garage_debug_verbose') ? { key: `return:speed:${second}:${third}`, msg: `${T('Rückkehr-Berechnung', 'Return calculation')}: ${second}${third ? ` – ${third}` : ''}` } : null;
    if (first === 'return wait at safety line') return { key: `return:linewait:${second}`, msg: `${T('Rückkehr wartet an Sicherheitslinie', 'Return waiting at safety line')} – ${this._humanReason(second)}` };
    if (first === 'return line wait released') return { key: 'return:linewait:released', msg: T('Rückkehr freigegeben – Tor offen, Fahrt zur Garage wird fortgesetzt', 'Return released – door open, continuing to garage') };
    if (first === 'safety line crossed garage->lawn during outbound') return { key: 'state:line:lawn', msg: T('Sicherheitslinie Richtung Garten überfahren', 'Safety line crossed toward lawn') };
    if (first === 'safety line crossed lawn->garage ignored') return { key: 'state:line:garage', msg: T('Sicherheitslinie Richtung Garage überfahren – Tor bleibt unverändert', 'Safety line crossed toward garage – door unchanged') };
    if (first === 'safety line crossed wrong direction') return { key: 'state:line:wrong', msg: T('Sicherheitslinie in falscher Richtung überfahren – Tor bleibt unverändert', 'Safety line crossed in wrong direction – door unchanged') };
    if (first === 'safety line watch') {
      if (!this._garageOption('garage_debug_verbose')) return null;
      return { key: 'state:line:watch', msg: `${T('Sicherheitslinie aktiv', 'Safety line active')} – ${second || ''}` };
    }
    if (first === 'outbound released: original mower command sent, adjusting started') return { key: 'state:adjusting:start', msg: T('Justieren gestartet', 'Adjusting started') };
    if (first === 'home detected; close scheduled in 15s') return { key: 'state:home_close_scheduled', msg: T('Zuhause erkannt – Schließen nach Sicherheitszeit geplant', 'Home detected – closing after safety delay') };
    if (first === 'button pressed') return { key: `button:${second}`, msg: `${T('Taste gedrückt', 'Button pressed')}: ${this._humanCommand(second)}` };
    if (first === 'button blocked') return { key: `button-block:${second}:${third}`, msg: `${T('Taste blockiert', 'Button blocked')}: ${this._humanCommand(second)} – ${this._humanReason(third)}` };
    if (first === 'button ignored duplicate') return { key: `button-dup:${second}`, msg: `${T('Doppelklick ignoriert', 'Duplicate press ignored')}: ${this._humanCommand(second)}` };
    if (first === 'START_REQUESTED') return { key: `cmd:start:${second}`, msg: T('Mähvorgang angefordert', 'Mowing requested') };
    if (first === 'RETURN_REQUESTED') return { key: `cmd:return:${second}`, msg: T('Sichere Rückkehr gestartet', 'Safe return started') };
    if (first === 'MAINTENANCE_REQUESTED') return { key: `cmd:maintenance:${second}`, msg: T('Wartungspunkt angefordert', 'Maintenance point requested') };
    if (first.startsWith('EMERGENCY')) return { key: `emergency:${raw.slice(0, 60)}`, msg: `${T('NOTFALL', 'EMERGENCY')}: ${this._humanReason(raw)}` };
    const noisy = ['status', 'close guard', 'outbound guard begin', 'safety line calibrated', 'safety line calibration pending: current side unknown', 'garage markers complete: close guard may evaluate normally', 'home-cycle-lock: ignore post-home status'];
    if (noisy.includes(first) || first.startsWith('[Marker]')) return null;
    return null;
  }

  _humanCommand(cmd) {
    const T = (de, en) => this._text(de, en);
    return ({
      cmd_refresh: T('Aktualisieren', 'Refresh'), cmd_start_mowing: T('Mähen starten', 'Start mowing'), cmd_start_spot_mowing: T('Spot mähen', 'Start spot mowing'),
      cmd_pause: T('Pause/Fortsetzen', 'Pause/Resume'), cmd_stop: T('Stop', 'Stop'), cmd_dock: T('Zur Station', 'Return to dock'), cmd_maintenance_point: T('Wartungspunkt', 'Maintenance point'),
      cmd_garage_pause_mode: T('Garagenmodus pausieren/fortsetzen', 'Pause/resume garage mode'),
    })[cmd] || String(cmd || '');
  }

  _humanReason(reason) {
    const T = (de, en) => this._text(de, en);
    const labels = {
      maintenance_current_wait: T('Warte auf frische Stillstandsbestätigung am Wartungspunkt', 'Waiting for fresh standstill confirmation at maintenance point'),
      maintenance_current_unconfirmed: T('Wartungspunkt: Stillstand oder Position nicht bestätigt', 'Maintenance point: standstill or position not confirmed'),
      manual_gate_stop_hold: T('Tor manuell gestoppt – sichere neue Torfreigabe erforderlich', 'Gate stopped manually – new safe gate clearance required'),
      return_release_wait: T('Warte auf Tor- und Wartungspunktfreigabe', 'Waiting for gate and maintenance-point clearance'),
      return_safety_line_pause_confirmation_pending: T('Rückkehr wartet sicher an der Sicherheitslinie – Stillstand wird bestätigt', 'Return safely waiting at safety line – confirming standstill'),
      return_safety_line_pause_failed_recovery: T('Rückkehr wartet sicher an der Sicherheitslinie – STOP-Recovery läuft', 'Return safely waiting at safety line – STOP recovery in progress'),
      return_safety_line_stop_recovered: T('Stillstand an Sicherheitslinie bestätigt – Toröffnung läuft', 'Standstill at safety line confirmed – opening gate'),
      return_safety_line_stop_unconfirmed: T('Stillstand an Sicherheitslinie nicht verifizierbar – Rückkehr blockiert', 'Standstill at safety line unverified – return blocked'),
    };
    if (labels[reason]) return labels[reason];
    const r = String(reason || '').replace(/^ERROR\s+/, '');
    const known = {
      garage_open_timeout: T('Tor hat nicht rechtzeitig offen gemeldet', 'Door did not report open in time'),
      close_blocked_door_moving: T('Tor bewegt sich gerade', 'Door is moving'),
      close_blocked_markers_incomplete: T('Marker unvollständig', 'Markers incomplete'),
      markers_incomplete_close_disabled: T('Marker unvollständig, automatisches Schließen gesperrt', 'Markers incomplete, automatic closing disabled'),
      close_blocked_position_unknown: T('Position unklar', 'Position uncertain'),
      close_blocked_mower_in_danger_area: T('Mäher im Gefahrenbereich', 'Mower in danger area'),
      close_blocked_raw_danger_clear_unconfirmed: T('Gefahrenbereich noch nicht durch zwei frische Positionen freigegeben', 'Danger area not yet cleared by two fresh positions'),
      close_blocked_adjusting_active: T('Justieren aktiv', 'Adjusting active'),
      start_station_verification_pending: T('Mähstart wartet: Stationsstatus wird aktiv geprüft', 'Mowing start waiting: checking physical dock state'),
      start_station_verified: T('Stationsstatus bestätigt, Mähstart wird fortgesetzt', 'Dock state verified; mowing start continuing'),
      start_blocked_position_unconfirmed: T('Start nicht freigegeben: aktueller Stations- bzw. Außenpositionsnachweis fehlt', 'Start blocked: fresh physical station or outside proof unavailable'),
      maintenance_point_timeout: T('Wartungspunkt nicht erreicht', 'Maintenance point not reached'),
      maintenance_point_timeout_mower_in_danger_area: T('Wartungspunkt-Timeout, Mäher noch im Gefahrenbereich', 'Maintenance-point timeout, mower still in danger area'),
      maintenance_departure_not_started: T('Wartungspunktfahrt wurde nicht gestartet', 'Maintenance-point trip did not start'),
      maintenance_departure_position_unconfirmed: T('Wartungspunktfahrt nicht prüfbar – keine frische Position', 'Maintenance-point departure cannot be verified – no fresh position'),
      maintenance_departure_retry_rejected: T('Wartungspunkt-Befehl beim Wiederholen abgelehnt', 'Maintenance-point retry command rejected'),
      return_maintenance_zone_map_edit_failed: T('Sperrzonenänderung am Wartungspunkt fehlgeschlagen – Rückkehr sicher angehalten', 'No-go zone edit at maintenance point failed – return held safely'),
      return_maintenance_zone_mapd_unverified: T('Sperrzone nach Kartenänderung weiterhin vorhanden – Rückkehr angehalten', 'No-go zone remains after map edit – return held'),
      maintenance_zone_task_not_ended: T('Mähauftrag am Wartungspunkt nicht beendet – Sperrzone unverändert', 'Mower task not ended at maintenance point – zone unchanged'),
      return_maintenance_dock_retry_no_departure: T('Auch nach der zweiten DOCK-Anforderung keine Bewegung nachgewiesen', 'No movement confirmed after the second DOCK request'),
      return_maintenance_dock_retry_needs_proof: T('Keine ausreichend frische, mehrfach bestätigte Stillstandsposition – keine automatische Wiederholung', 'Insufficient fresh repeated stationary position proof – automatic retry withheld'),
      return_maintenance_dock_retry_gate_unconfirmed: T('Toröffnung vor zweiter DOCK-Anforderung nicht erneut bestätigt', 'Gate opening not reconfirmed for the second DOCK request'),
      return_maintenance_dock_retry_clearance_unconfirmed: T('Gefahrenabstand oder Position vor zweiter DOCK-Anforderung unklar', 'Danger clearance or position unverified before the second DOCK request'),
      return_maintenance_dock_retry_rejected: T('Zweite DOCK-Anforderung vom Hersteller nicht bestätigt', 'Second DOCK request not confirmed by vendor'),
      return_maintenance_dock_departure_unclear: T('Mäherbewegung unklar – automatische Wiederholung unterdrückt', 'Mower movement uncertain – automatic retry suppressed'),
      return_maintenance_dock_operational_hold: T('Rückkehrüberwachung durch Sicherheitsfreigabe angehalten', 'Return watch stopped by safety interlock'),
      return_maintenance_dock_watch_failed: T('Fehler bei der Rückkehrüberwachung – manuelle Prüfung nötig', 'Return watchdog error – manual inspection required'),
      maintenance_reached_close: `${this._maintenancePointLabel()} ${T('erreicht', 'reached')}`,
      maintenance_start_close: `${this._maintenancePointLabel()} – ${T('Schließen vor neuem Mähvorgang', 'close before new mowing task')}`,
      external_start: T('Externer Start', 'External start'),
      return_from_maintenance: T('Rückkehr vom Wartungspunkt', 'Return from maintenance point'),
      no_sensor_delay_elapsed: T('Sicherheitszeit ohne Sensor abgelaufen', 'Safety delay without sensor elapsed'),
      stable_open: T('Tor stabil offen', 'Door stably open'),
      home_15s: T('Zuhause 15 Sekunden stabil', 'Home stable for 15 seconds'),
      already_home: T('Bereits Zuhause', 'Already home'),
      sensor_watchdog_timeout: T('Torsensor meldet sich nicht', 'Door sensor is not responding'),
      sensor_watchdog_timeout_fallback_to_timer: T('Torstatus nicht rechtzeitig bestätigt – Zeitsteuerung wird verwendet', 'Door state was not confirmed in time – configured gate runtime is used'),
      sensor_offline_fallback_to_timer: T('Torsensor offline – Zeitsteuerung wird verwendet', 'Door sensor offline – configured gate runtime is used'),
      sensor_open_confirmation_timeout_fallback_to_timer: T('Toröffnung nicht rechtzeitig bestätigt – Zeitsteuerung wird verwendet', 'Door opening was not confirmed in time – configured gate runtime is used'),
      sensor_close_confirmation_timeout_fallback_to_timer: T('Torschließung nicht rechtzeitig bestätigt – Zeitsteuerung wird verwendet', 'Door closing was not confirmed in time – configured gate runtime is used'),
      close_blocked_maintenance_transit_active: T('Wartungspunkt-Fahrt aktiv – Schließen blockiert', 'Maintenance-point journey active – closing blocked'),
      markers_reset_close_disabled: T('Marker zurückgesetzt, Schließen deaktiviert', 'Markers reset, closing disabled'),
      close_blocked_outbound_exit_not_confirmed: T('Ausfahrt aktiv, Sicherheitslinie noch nicht freigegeben', 'Outbound active, safety line not yet released'),
      outbound_door_opening_mower_in_danger_area_close_suppressed: T('Ausfahrt aktiv, Tor öffnet – Schließen unterdrückt', 'Outbound active, door opening – closing suppressed'),
      door_opening_mower_in_danger_area_close_suppressed: T('Tor öffnet, Mäher im Gefahrenbereich – Schließen unterdrückt', 'Door opening, mower in danger area – closing suppressed'),
      half_map_near_garage: T('Zu nah an Garage – über Wartungspunkt', 'Too close to garage – use maintenance point'),
      half_map_far_from_garage: T('Weit genug weg – direkte Rückkehr erlaubt', 'Far enough away – direct return allowed'),
      position_unclear_use_maintenance: T('Position unklar – über Wartungspunkt', 'Position uncertain – use maintenance point'),
      safety_line_wait_door_not_open: T('Tor noch nicht offen', 'Door not open yet'),
      direct_return_with_line_wait: T('Direkte Rückkehr mit Sicherheitslinien-Wartepunkt', 'Direct return with safety-line wait'),
    };
    return known[r] || r.replace(/_/g, ' ');
  }

  _localizeDebugText(message) {
    let text = String(message || '');
    const de = this._language().startsWith('de');
    // These return-path diagnostics were added after the original broad
    // token-based logger localization. Keep their full phrases bilingual so
    // we do not end up with mixed output such as "offen gate now" or
    // "Rückkehrentscheidung ... etaToLine" in a field log.
    const returnPhrases = [
      ['speed basis', 'Geschwindigkeitsgrundlage'],
      ['return ETA conservative', 'konservative Rückkehr-ETA'],
      ['return decision', 'Rückkehrentscheidung'],
      ['short safety-line ETA: open gate now; A-B checkpoint will hold if gate is still closed', 'Kurze ETA bis zur Sicherheitslinie: Tor jetzt öffnen; der A-B-Punkt hält den Mäher an, falls das Tor noch geschlossen ist'],
      ['short safety-line ETA: pause at current position before opening gate', 'Kurze ETA bis zur Sicherheitslinie: Mäher am aktuellen Standort pausieren, bevor das Tor öffnet'],
      ['return wait at current position', 'Rückkehr wartet pausiert am aktuellen Standort'],
      ['return current-position stop confirmed', 'Stillstand am aktuellen Standort für die Rückkehr bestätigt'],
      ['return current-position stop confirmation missing; entering controlled recovery', 'Stillstand am aktuellen Standort nicht bestätigt; kontrollierte Wiederherstellung läuft'],
      ['return current-position recovery', 'Rückkehr-Wiederherstellung am aktuellen Standort'],
      ['return_current_position_pause_confirmation_pending', 'Pausebestätigung am aktuellen Standort für die Rückkehr steht noch aus'],
      ['return_current_position_pause_failed_recovery', 'Pause am aktuellen Standort für die Rückkehr fehlgeschlagen; Wiederherstellung läuft'],
      ['return_current_position_stop_recovered', 'Stillstand am aktuellen Standort für die Rückkehr wiederhergestellt'],
      ['return current-position stop unconfirmed', 'Stillstand am aktuellen Standort für die Rückkehr nicht bestätigt'],
      ['return current-position stop recovered', 'Stillstand am aktuellen Standort für die Rückkehr wiederhergestellt'],
      ['return current-position wait released', 'Rückkehr nach Torfreigabe am aktuellen Standort fortgesetzt'],
      ['return_current_position_hard_pause', 'Rückkehrpause am aktuellen Standort'],
      ['return_current_position_gate_wait', 'Toröffnung nach bestätigter Pause am aktuellen Standort'],
      ['return pre-entry hold', 'Rückkehrhalt vor der Sicherheitslinie'],
      ['return safety-line stop confirmed', 'Stillstand an der Sicherheitslinie bestätigt'],
      ['return safety-line stop proof reused with new stationary position', 'Stillstandsnachweis an der Sicherheitslinie mit neuer Stillstandsposition wiederverwendet'],
      ['return stationary clearance pending', 'Freigabe des Stillstands bei der Rückkehr noch ausstehend'],
      ['return handoff to maintenance after three failed stationary checks', 'Rückkehr nach drei erfolglosen Stillstandsprüfungen an den Wartungspunkt übergeben'],
      ['return checkpoint clearance denied: native paused state no longer fresh', 'Freigabe am Rückkehrpunkt verweigert: nativer Pausiert-Status nicht mehr aktuell'],
      ['return checkpoint: native pause and fresh safe position confirmed', 'Rückkehrpunkt: native Pause und aktuelle sichere Position bestätigt'],
      ['return checkpoint: fresh stationary position reanchored after settling', 'Rückkehrpunkt: aktuelle Stillstandsposition nach dem Setzen neu verankert'],
      ['return checkpoint position refresh timeout: no fresh independent stationary clearance', 'Zeitüberschreitung am Rückkehrpunkt: keine aktuelle unabhängige Stillstandsfreigabe'],
      ['return ETA learning sample', 'Messwert zum Lernen der Rückkehrgeschwindigkeit'],
      ['return route side inferred from matching fresh geometry and recent confirmed crossing', 'Rückkehrseite aus aktueller passender Geometrie und kürzlich bestätigter Linienüberquerung abgeleitet'],
      ['lineSide=', 'Linienseite='],
      ['lawnSide', 'Rasenseite'],
      ['garageSide', 'Garagenseite'],
      ['etaToLine=', 'ETA bis Linie='],
      ['required=', 'erforderlich='],
      ['exact=', 'exakt='],
      ['history=', 'Historie='],
      ['lineDist=', 'Linienabstand='],
      ['lineEta=', 'Linien-ETA='],
      ['dockDist=', 'Stationsabstand='],
      ['dockEta=', 'Stations-ETA='],
      ['dangerDistance=', 'Abstand Gefahrenbereich='],
      ['lineDistance=', 'Linienabstand='],
      ['pre_safety_line', 'vor_sicherheitslinie'],
      ['door_open_stable', 'tor_stabil_offen'],
      ['gate_already_opening', 'Toröffnung läuft bereits'],
      ['gate_stationary', 'Tor steht'],
    ];
    if (de) {
      for (const [en, ger] of returnPhrases) text = text.replaceAll(en, ger);
    } else {
      for (const [en, ger] of returnPhrases) text = text.replaceAll(ger, en);
      // These labels are already German in a few older hard-coded diagnostics.
      text = text.replaceAll('Rückkehr ETA', 'return ETA');
    }
    const pairs = [
      ['active garage command', 'Aktiver Garagenbefehl'], ['resume guard active', 'Fortsetzen-Schutz aktiv'],
      ['tile status', 'Kachelstatus'], ['door state', 'Torstatus'], ['safety status', 'Sicherheitsstatus'],
      ['request open', 'Toröffnung angefordert'], ['request close', 'Torschließung angefordert'],
      ['close requested', 'Torschließung angefordert'], ['maintenance point reached', 'Wartungspunkt erreicht'],
      ['maintenance point timeout', 'Wartungspunkt-Timeout'], ['danger area', 'Gefahrenbereich'],
      ['line state', 'Sicherheitslinienstatus'], ['exit confirmed', 'Ausfahrt bestätigt'],
      ['door close allowed', 'Torschließen freigegeben'], ['return context', 'Rückkehrstatus'],
      ['return wait at safety line', 'Rückkehr wartet an Sicherheitslinie'],
      ['return line wait released', 'Rückkehr an Sicherheitslinie freigegeben'],
      ['safety line watch', 'Sicherheitslinienüberwachung'], ['button blocked', 'Taste blockiert'],
      ['source=', 'Quelle='], ['confidence=', 'Vertrauen='], ['measured average', 'Gemittelter Messwert'],
      ['garage->lawn', 'Garage→Rasen'], ['lawn->garage', 'Rasen→Garage'],
      ['inside', 'innen'], ['outside', 'außen'], ['unknown', 'unbekannt'],
      ['opening', 'öffnet'], ['closing', 'schließt'], ['closed', 'geschlossen'], ['open', 'offen'],
      ['paused', 'pausiert'], ['mowing', 'mäht'], ['returning', 'Rückkehr'], ['docked', 'angedockt'],
    ];
    if (de) {
      for (const [en, ger] of pairs) text = text.replaceAll(en, ger);
    } else {
      const reverse = [
        ['Fehler', 'Error'], ['Wartungspunkt erreicht', 'Maintenance point reached'], ['Wartungspunktfahrt', 'Maintenance-point trip'], ['Gefahrenbereich', 'Danger area'],
        ['Sicherheitslinie', 'Safety line'], ['Tor öffnet', 'Door opening'], ['Tor schließt', 'Door closing'],
        ['Tor offen', 'Door open'], ['Tor geschlossen', 'Door closed'], ['Rückkehr', 'Return'],
        ['Zuhause', 'Home'], ['Mäht', 'Mowing'], ['Pausiert', 'Paused'], ['Justieren', 'Adjusting'],
        ['Positionieren', 'Positioning'], ['Ausfahrt', 'Outbound'], ['Quelle=', 'source='], ['Vertrauen=', 'confidence='],
      ];
      for (const [ger, en] of reverse) text = text.replaceAll(ger, en);
    }
    return text;
  }

  log(...args) {
    if (!this._garageOption('garage_logging_enabled')) return;
    const raw = this._formatLogArgs(args);
    const msg = this._localizeDebugText(raw);
    this.device.log('[Garage]', msg);
    const evt = this._timelineFromLog(args, raw);
    if (evt) this._timeline(evt.msg, evt.key);
  }

  debugLog(...args) {
    if (!this._garageOption('garage_logging_enabled') || !this._garageOption('garage_debug_verbose')) return;
    const raw = this._formatLogArgs(args);
    const msg = this._localizeDebugText(raw);
    this.device.log('[Garage][Debug]', msg);
  }

  realtimeTimelineEvent(kind, reason = '') {
    // The same native MQTT mowing edge is emitted during a parked maintenance
    // outing. Do not tell the user that a lawn-mowing mission was resumed.
    if (kind === 'resume_outside' && this._manualMaintenanceReached
        && String(this.lastRequestedAction || '').toLowerCase().includes('maintenance')) {
      kind = 'resume_maintenance_outside';
    }
    const events = {
      external_start: this._text('Externer Mähstart erkannt – Garagensicherung übernimmt', 'External mowing start detected – garage safety taking over'),
      return: this._text('Rückkehr erkannt – Live-Signal empfangen', 'Return detected – live signal received'),
      resume_outside: this._text('Mähvorgang fortgesetzt – außerhalb der Garage, kein Torvorgang nötig', 'Mowing resumed – outside garage, no gate action needed'),
      resume_maintenance_outside: this._text('Mähvorgang fortgesetzt – Wartungspunktfahrt außerhalb der Garage, kein zusätzlicher Torvorgang nötig', 'Mowing resumed – maintenance outing outside garage, no additional gate action needed'),
    };
    const msg = events[kind];
    if (!msg) return;
    this._timeline(reason ? `${msg} – ${this._humanReason(reason)}` : msg, `realtime:${kind}`);
  }

  error(...args) {
    const raw = this._formatLogArgs(args);
    const msg = this._localizeDebugText(raw);
    this.device.error('[Garage]', msg);
    this._timeline(`${this._text('Fehler', 'Error')}: ${this._humanReason(raw)}`, `error:${raw.slice(0, 80)}`);
  }

  enabled() { return !!this.device.getSetting('garage_mode_enabled') && !this.paused; }

  // This control is deliberately available even with a sticky emergency,
  // disconnected mower, unknown position or after a restart. It only changes
  // Homey's automatic intervention; it NEVER sends a drive or gate pulse.
  async setOperatorGaragePause(pause = true, source = 'user') {
    const next = pause === true;
    // The operator may select ON/OFF at any time, including a latched
    // emergency. This is an operator preference, NOT an emergency release:
    // _manualRecoveryActive/_manualGateStopped keep all automatic motor and
    // gate commands fail-closed until separate physical verification.
    const previous = !!this.paused;
    if (next === previous) return true;
    // Store first so a failed persistence write cannot silently enable or
    // disable interception differently from the next application start.
    if (!this.device || typeof this.device.setStoreValue !== 'function') {
      throw new Error('Persistent garage pause storage unavailable');
    }
    await this.device.setStoreValue('garage_operator_paused', next);
    this.paused = next;
    if (next) {
      // Invalidate pending, long-running automatic actions. The sticky manual
      // recovery and real gate-contact history remain untouched.
      this.cancelPendingCommand('operator_garage_automation_paused');
    }
    this.log('GARAGE PAUSE: operator preference', next ? 'PAUSED; manual original-app control'
      : this._manualRecoveryActive ? 'ON requested; emergency latch still blocks automatic motion' : 'AUTOMATION ON', source);
    await this.refreshTileStatus?.('garage operator pause changed')?.catch?.(() => {});
    return true;
  }

  _safeSpeed(mps, basis, source, confidence = 'medium') {
    const v = Number(mps);
    if (!Number.isFinite(v) || v <= 0) return null;
    return {
      mps: Math.max(0.05, Math.min(2.5, v)),
      basis: `${basis}; source=${source}; confidence=${confidence}`,
      source,
      confidence,
    };
  }

  _readLiveMowerSpeed() {
    // Prefer an explicit live speed if a future firmware/API exposes it. Do not
    // use the existing "mowing_speed" setting capability blindly: on many
    // models it is only a low/normal/fast mode selector, not a live velocity.
    const candidates = [
      this.device._liveSpeedMps,
      this.device._mowerSpeedMps,
      this.device._lastTelemetry?.speedMps,
      this.device._lastTelemetry?.speed_mps,
      this.device._lastStatus?.speedMps,
      this.device._lastStatus?.speed_mps,
    ];
    for (const c of candidates) {
      const v = Number(c);
      if (Number.isFinite(v) && v > 0.03 && v < 2.5) return this._safeSpeed(v, `${v.toFixed(2)} m/s live`, 'live_mower_speed', 'high');
    }
    const kmhCandidates = [
      this.device._liveSpeedKmh,
      this.device._lastTelemetry?.speedKmh,
      this.device._lastTelemetry?.speed_kmh,
      this.device._lastStatus?.speedKmh,
      this.device._lastStatus?.speed_kmh,
    ];
    for (const c of kmhCandidates) {
      const v = Number(c);
      if (Number.isFinite(v) && v > 0.1 && v < 9) return this._safeSpeed(v / 3.6, `${v.toFixed(2)} km/h live`, 'live_mower_speed', 'high');
    }
    return null;
  }

  _modelDefaultSpeed() {
    const rawModel = String(this.device.getSetting('device_model') || this.device.getSetting('device_model_id') || this.device._devModel || '').toLowerCase();
    if (!rawModel) return null;
    // Conservative, user-overridable estimates used only for ETA/decision logging
    // when no live or measured speed is available. Unknown models intentionally
    // fall through to the user setting instead of pretending certainty.
    const table = [
      { match: ['a2 pro', 'a2_pro', 'a2pro'], kmh: 2.2 },
      { match: ['a2'], kmh: 2.0 },
      { match: ['a1'], kmh: 1.8 },
      { match: ['mova'], kmh: 1.8 },
      { match: ['dreame'], kmh: 1.8 },
    ];
    const hit = table.find((row) => row.match.some((m) => rawModel.includes(m)));
    if (!hit) return null;
    return this._safeSpeed(hit.kmh / 3.6, `${hit.kmh} km/h model default (${rawModel})`, 'model_default', 'medium');
  }

  _userConfiguredSpeed() {
    const unit = String(this._garageOption('garage_speed_unit') || 'kmh');
    const raw = Number(this._garageOption('garage_mower_speed_value'));
    if (!Number.isFinite(raw) || raw <= 0) {
      return this._safeSpeed(DEFAULT_MOWER_SPEED_KMH / 3.6, `${DEFAULT_MOWER_SPEED_KMH} km/h fallback`, 'factory_fallback', 'low');
    }
    if (unit === 'mph') return this._safeSpeed(raw * 0.44704, `${raw} mph user`, 'user_setting', 'medium');
    if (unit === 'mmps') return this._safeSpeed(raw / 1000, `${raw} mm/s user`, 'user_setting', 'medium');
    if (unit === 'mps') return this._safeSpeed(raw, `${raw} m/s user`, 'user_setting', 'medium');
    return this._safeSpeed(raw / 3.6, `${raw} km/h user`, 'user_setting', 'medium');
  }

  _derivedAverageSpeed() {
    const now = Date.now();
    this._derivedSpeedSamples = (this._derivedSpeedSamples || []).filter((s) => now - s.ts < 20 * 60 * 1000);
    if (this._derivedSpeedSamples.length < 3) return null;
    const vals = this._derivedSpeedSamples.map((s) => s.mps).sort((a, b) => a - b);
    const trimmed = vals.length > 4 ? vals.slice(1, -1) : vals;
    const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    return this._safeSpeed(avg, `${avg.toFixed(2)} m/s measured average`, 'measured_position_average', trimmed.length >= 6 ? 'high' : 'medium');
  }

  _recordPositionForDerivedSpeed() {
    const p = this.pos();
    if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return;
    const ts = Number(p.ts) || Date.now();
    if (this._lastSpeedPos) {
      const dt = Math.max(0, (ts - this._lastSpeedPos.ts) / 1000);
      const distMm = this._distance(p, this._lastSpeedPos);
      if (dt >= 2 && dt <= 120 && distMm != null && distMm >= 50) {
        const mps = (distMm / 1000) / dt;
        // Filter out GPS/cloud jumps and near-zero jitter. Typical mower travel is
        // well below this, but keep the upper bound generous for unit variance.
        if (mps >= 0.03 && mps <= 2.5) {
          this._derivedSpeedSamples = this._derivedSpeedSamples || [];
          this._derivedSpeedSamples.push({ mps, ts });
          if (this._derivedSpeedSamples.length > 24) this._derivedSpeedSamples.splice(0, this._derivedSpeedSamples.length - 24);
        }
      }
    }
    this._lastSpeedPos = { x: Number(p.x), y: Number(p.y), ts };
  }

  _speedMetersPerSecond() {
    const mode = String(this._garageOption('garage_speed_source') || 'auto');
    const live = this._readLiveMowerSpeed();
    const measured = this._derivedAverageSpeed();
    const model = this._modelDefaultSpeed();
    const user = this._userConfiguredSpeed();

    if (mode === 'live') return live || measured || model || user;
    if (mode === 'model') return model || live || measured || user;
    if (mode === 'measured') return measured || live || model || user;
    if (mode === 'user') return user;
    // Auto priority: real telemetry > measured positions > known model default > user setting.
    return live || measured || model || user;
  }

  _returnEtaSpeedMetersPerSecond() {
    const observed = this._speedMetersPerSecond();
    let model = null;
    try { model = this._modelDefaultSpeed?.() || null; } catch (_) {}
    const observedMps = Number(observed?.mps) || 0;
    const modelMps = Number(model?.mps) || 0;
    const learnedMps = Number(this._returnEtaLearnedMps) || 0;
    const mps = Math.max(RETURN_ETA_MIN_SPEED_MPS, observedMps, modelMps, learnedMps);
    const basis = mps === observedMps
      ? `return ETA ${mps.toFixed(2)} m/s (${observed?.basis || 'observed'})`
      : `return ETA conservative ${mps.toFixed(2)} m/s (observed=${observedMps.toFixed(2)}; model=${modelMps.toFixed(2)}; learned=${learnedMps.toFixed(2)}; floor=${RETURN_ETA_MIN_SPEED_MPS.toFixed(2)})`;
    return { mps, basis, source: 'return_conservative', confidence: 'conservative' };
  }

  async _loadReturnEtaLearning() {
    if (this._returnEtaLearningLoaded) return;
    this._returnEtaLearningLoaded = true;
    const stored = await safeGetStoreValue(this.device, RETURN_ETA_LEARNING_STORE_KEY);
    const samples = Array.isArray(stored?.samples) ? stored.samples : [];
    this._returnEtaLearningSamples = samples
      .map(Number).filter((v) => Number.isFinite(v) && v >= RETURN_ETA_MIN_SPEED_MPS && v <= RETURN_ETA_LEARNING_MAX_MPS)
      .slice(-12);
    const learned = Number(stored?.learnedMps);
    this._returnEtaLearnedMps = Number.isFinite(learned)
      ? Math.max(0, Math.min(RETURN_ETA_LEARNING_MAX_MPS, learned)) : 0;
  }

  async _learnReturnEtaFromPreEntry(line, token) {
    const prediction = this._returnEtaPrediction;
    this._returnEtaPrediction = null;
    if (!prediction || prediction.token !== token || !line?.known || !line?.onSegment
        || !Number.isFinite(Number(line.distance))) return false;
    const now = Date.now();
    const pos = this.pos();
    const positionTs = Number(pos?.ts || 0);
    const physicalSource = ['mqtt', 'siid:1:4', 'garage-marker-direct'].includes(String(pos?.source || ''));
    if (!pos || !physicalSource || !positionTs || positionTs <= prediction.ts
        || now < positionTs || now - positionTs > RETURN_OPEN_POSITION_MAX_AGE_MS) return false;
    const current = Math.abs(Number(line.distance));
    const elapsedSec = (positionTs - prediction.ts) / 1000;
    const traveledMm = prediction.distanceToPrelineMm - Math.max(0, current - RETURN_PRELINE_STOP_MM);
    if (elapsedSec < 1 || elapsedSec > 180 || traveledMm < 500) return false;
    const actualMps = (traveledMm / 1000) / elapsedSec;
    const ratio = actualMps / prediction.speedMps;
    // Train only on repeated, materially faster approaches. Slow/noisy samples
    // never reduce a configured, model, or conservative return speed.
    if (!Number.isFinite(actualMps) || actualMps < RETURN_ETA_MIN_SPEED_MPS
        || actualMps > RETURN_ETA_LEARNING_MAX_MPS || ratio < 1.2) return false;
    await this._loadReturnEtaLearning();
    this._returnEtaLearningSamples.push(actualMps);
    this._returnEtaLearningSamples = this._returnEtaLearningSamples.slice(-12);
    if (this._returnEtaLearningSamples.length >= RETURN_ETA_LEARNING_MIN_SAMPLES) {
      const lastThree = this._returnEtaLearningSamples.slice(-3).sort((a, b) => a - b);
      // Median rejects one GPS/cloud jump; a 10% margin keeps future ETA
      // conservative. Learning is monotonic so it cannot make a route riskier.
      this._returnEtaLearnedMps = Math.max(this._returnEtaLearnedMps,
        Math.min(RETURN_ETA_LEARNING_MAX_MPS, lastThree[1] * 1.1));
    }
    try {
      await Promise.resolve(this.device.setStoreValue(RETURN_ETA_LEARNING_STORE_KEY, {
        samples: this._returnEtaLearningSamples,
        learnedMps: this._returnEtaLearnedMps,
        updatedAt: now,
      }));
    } catch (_) {}
    this.log('return ETA learning sample', `predicted=${prediction.speedMps.toFixed(2)}m/s`,
      `actual=${actualMps.toFixed(2)}m/s`, `faster=${ratio.toFixed(2)}x`,
      `samples=${this._returnEtaLearningSamples.length}`, `learned=${this._returnEtaLearnedMps.toFixed(2)}m/s`);
    return true;
  }

  _mapBoundaryNormalized() {
    const b = this.device._cachedMapData?.boundary || null;
    if (!b) return null;
    const x1 = Number.isFinite(Number(b.x1)) ? Number(b.x1) : Number(b.minX);
    const y1 = Number.isFinite(Number(b.y1)) ? Number(b.y1) : Number(b.minY);
    const x2 = Number.isFinite(Number(b.x2)) ? Number(b.x2) : Number(b.maxX);
    const y2 = Number.isFinite(Number(b.y2)) ? Number(b.y2) : Number(b.maxY);
    if (![x1,y1,x2,y2].every(Number.isFinite)) return null;
    return { minX: Math.min(x1,x2), maxX: Math.max(x1,x2), minY: Math.min(y1,y2), maxY: Math.max(y1,y2) };
  }

  _distance(a, b) {
    if (!a || !b) return null;
    const dx = Number(a.x) - Number(b.x);
    const dy = Number(a.y) - Number(b.y);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    return Math.sqrt(dx*dx + dy*dy);
  }

  _positionInsideMowingArea(position) {
    if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) return null;
    const areas = this.device?._cachedMapData?.mowingAreas;
    if (!Array.isArray(areas)) return null;
    let validPolygonFound = false;
    const normalize = point => {
      if (Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))) return { x: Number(point[0]), y: Number(point[1]) };
      if (point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))) return { x: Number(point.x), y: Number(point.y) };
      return null;
    };
    for (const entry of areas) {
      const area = Array.isArray(entry) && entry.length === 2 && entry[1] && typeof entry[1] === 'object' ? entry[1] : entry;
      const source = area?.path || area?.points || area?.polygon || area;
      if (!Array.isArray(source)) continue;
      const polygon = source.map(normalize).filter(Boolean);
      if (polygon.length < 3) continue;
      validPolygonFound = true;
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        const cross = (Number(position.x) - a.x) * (b.y - a.y) - (Number(position.y) - a.y) * (b.x - a.x);
        const within = Number(position.x) >= Math.min(a.x, b.x) - 1 && Number(position.x) <= Math.max(a.x, b.x) + 1
          && Number(position.y) >= Math.min(a.y, b.y) - 1 && Number(position.y) <= Math.max(a.y, b.y) + 1;
        if (Math.abs(cross) <= 1 && within) return true;
        if ((a.y > Number(position.y)) !== (b.y > Number(position.y))
            && Number(position.x) < (b.x - a.x) * (Number(position.y) - a.y) / (b.y - a.y) + a.x) inside = !inside;
      }
      if (inside) return true;
    }
    return validPolygonFound ? false : null;
  }

  async _lockReturnMaintenancePoint(source = 'return') {
    if (this._lockedReturnMaintenancePoint
      && Number.isFinite(Number(this._lockedReturnMaintenancePoint.x))
      && Number.isFinite(Number(this._lockedReturnMaintenancePoint.y))) {
      return this._lockedReturnMaintenancePoint;
    }
    const index = typeof this.device._pinGarageMaintenancePoint === 'function'
      ? await this.device._pinGarageMaintenancePoint(source) : 1;
    const resolved = !index ? null
      : typeof this.device._resolveNativeMaintenancePoint === 'function'
        ? await Promise.resolve(this.device._resolveNativeMaintenancePoint(index)).catch(() => null)
        : index === 1 && typeof this.device._resolveStableMaintenancePoint === 'function'
          ? await this.device._resolveStableMaintenancePoint().catch(() => null)
          : await safeGetStoreValue(this.device, 'garage_maintenance_point');
    if (!index || !resolved || !Number.isFinite(Number(resolved.x)) || !Number.isFinite(Number(resolved.y))) {
      this.log(`return selected maintenance point P${index || '?'} unavailable; automatic navigation BLOCKED`, source || 'return');
      return null;
    }
    this._lockedReturnMaintenancePoint = Object.freeze({
      index, x: Number(resolved.x), y: Number(resolved.y),
      source: resolved.source || 'return_locked',
    });
    this.log('return maintenance point locked',
      `P${index}`,
      `${Math.round(this._lockedReturnMaintenancePoint.x)},${Math.round(this._lockedReturnMaintenancePoint.y)}`,
      this._lockedReturnMaintenancePoint.source, source || 'return');
    return this._lockedReturnMaintenancePoint;
  }

  async _readReturnOriginNativePair(token) {
    const api = this.device?._api;
    const did = this.device?.getData?.()?.id;
    if (!did || typeof api?.getMowerPosition !== 'function') return null;
    const mapAtStart = this.device?._activeMapIndex;
    const read = async () => {
      let timeout;
      try {
        const position = await Promise.race([
          Promise.resolve().then(() => api.getMowerPosition(did)).catch(() => null),
          new Promise(resolve => { timeout = setTimeout(() => resolve(null), 2000); }),
        ]);
        if (!Number.isFinite(Number(position?.x)) || !Number.isFinite(Number(position?.y))) return null;
        return {x:Number(position.x), y:Number(position.y), ts:Date.now(), source:'siid:1:4'};
      } finally { clearTimeout(timeout); }
    };
    const a = await read();
    if (!a || token !== this._commandToken || this._manualGateStopped) return null;
    await sleep(300);
    const b = await read();
    if (!b || token !== this._commandToken || this._manualGateStopped
        || (mapAtStart != null && this.device?._activeMapIndex != null
          && Number(mapAtStart) !== Number(this.device._activeMapIndex))) return null;
    // The return planner may read a MOVING mower. Reject telemetry jumps;
    // a short legitimate movement between the two readings is allowed.
    const drift = this._distance(a,b);
    if (!Number.isFinite(drift) || drift > 650) {
      this.log('[return-position] native pair contradictory', `driftMm=${drift}`);
      return null;
    }
    return b;
  }

  async _decideReturnPath(source = 'return', positionAtRequest = null) {
    await this._loadReturnEtaLearning();
    const pos = positionAtRequest || this.pos();
    const positionFresh = !!pos && Number.isFinite(Number(pos.ts))
      && Number(pos.ts) > 0 && Date.now() - Number(pos.ts) >= 0
      && Date.now() - Number(pos.ts) <= POSITION_CACHE_MS;
    const dock = this.device._dockPos || this.device._cachedMapData?.chargerPos || null;
    const boundary = this._mapBoundaryNormalized();
    const speed = this._returnEtaSpeedMetersPerSecond();
    const distanceToDockMm = this._distance(pos, dock);
    const diagMm = boundary ? Math.sqrt(Math.pow(boundary.maxX-boundary.minX,2)+Math.pow(boundary.maxY-boundary.minY,2)) : null;
    const halfMm = diagMm ? diagMm * RETURN_NEAR_HALF_RATIO : null;
    const etaSec = distanceToDockMm != null ? Math.round((distanceToDockMm/1000) / speed.mps) : null;
    const line = await this.markers.lineState(pos).catch(() => ({ known: false }));
    const danger = await this.markers.dangerState().catch(() => ({ known: false, inside: false }));
    // Debounced dangerState can lag a newly crossed physical gate radius.
    // A fresh raw INSIDE reading is enough to forbid a direct route even when
    // the debounced marker has not yet changed state.
    const rawDanger = typeof this.markers.rawDangerState === 'function'
      ? await this.markers.rawDangerState(pos).catch(() => null) : null;
    const garageSide = line?.direction?.garageSide ?? this._garageLineSide;
    const lawnSide = line?.direction?.lawnSide ?? this._lawnLineSide;
    // A signed distance to the INFINITE extension of A--B is not a side proof.
    // In the incident t=-1.23/onSegment=false, but the old fallback still
    // classified it as a real crossing and could select a direct return.
    const inferredSide = line?.onSegment && Number.isFinite(Number(line.distance)) && Math.abs(Number(line.distance)) >= Number(line.rawThreshold || 60)
      ? (Number(line.distance) > 0 ? 1 : -1)
      : null;
    const currentSide = line?.onSegment ? (line?.side ?? line?.rawSide ?? inferredSide) : null;
    const exactLineSideKnown = positionFresh && !!line?.known && !!line?.onSegment
      && currentSide !== null && garageSide !== null && lawnSide !== null;
    const extendedSide = Number.isFinite(Number(line?.distance))
      && Math.abs(Number(line.distance)) >= Math.max(240, Number(line?.rawThreshold || 60) * 2)
      ? (Number(line.distance) > 0 ? 1 : -1) : null;
    const lineHistoryAge = Date.now() - Number(this._lastLineSideAt || 0);
    const historySideKnown = positionFresh && !line?.onSegment && extendedSide !== null
      && Number(this._lastLineSideAt || 0) > 0 && lineHistoryAge >= 0 && lineHistoryAge <= 6 * 60 * 60 * 1000
      && this._lastLineSide === extendedSide && garageSide !== null && lawnSide !== null;
    const routeSide = exactLineSideKnown ? currentSide : (historySideKnown ? extendedSide : null);
    const routeSideKnown = exactLineSideKnown || historySideKnown;
    const lineSegmentDistance = async () => {
      const a = await Promise.resolve(this.markers.lineA?.()).catch(() => null);
      const b = await Promise.resolve(this.markers.lineB?.()).catch(() => null);
      if (!a || !b || !pos) return line?.onSegment && Number.isFinite(Number(line.distance)) ? Math.abs(Number(line.distance)) : null;
      const vx = Number(b.x) - Number(a.x), vy = Number(b.y) - Number(a.y);
      const length2 = vx * vx + vy * vy;
      if (!Number.isFinite(length2) || length2 <= 0) return null;
      const t = Math.max(0, Math.min(1, ((Number(pos.x) - Number(a.x)) * vx + (Number(pos.y) - Number(a.y)) * vy) / length2));
      return Math.hypot(Number(pos.x) - (Number(a.x) + t * vx), Number(pos.y) - (Number(a.y) + t * vy));
    };
    const distanceToLineMm = await lineSegmentDistance();
    const etaToLineSec = distanceToLineMm != null ? Math.round((distanceToLineMm / 1000) / speed.mps) : null;
    const requiredOpenLeadSec = Math.max(this._doorOpenDurationSeconds(), this._doorDelaySeconds()) + RETURN_DOOR_ETA_RESERVE_SECONDS;

    this.log('speed basis', speed.basis,
      `dockDist=${distanceToDockMm == null ? '?' : Math.round(distanceToDockMm)}mm dockEta=${etaSec == null ? '?' : etaSec+'s'}`,
      `lineDist=${distanceToLineMm == null ? '?' : Math.round(distanceToLineMm)}mm lineEta=${etaToLineSec == null ? '?' : etaToLineSec+'s'}`,
      `requiredOpenLead=${requiredOpenLeadSec}s source=${source}`);
    if (historySideKnown) this.log('return route side inferred from matching fresh geometry and recent confirmed crossing',
      `side=${routeSide}`, `historyAge=${lineHistoryAge}ms`, `lineT=${line?.t ?? '?'}`);

    // Hard safety rules always win over ETA and map-half fallbacks. Once the mower
    // is on the garage side of the A-B line or already in the danger area, the
    // gate must remain closed until the immutable maintenance point is reached.
    if (!positionFresh) {
      const detail = `position_stale_or_missing; source=${source}`;
      this.log('return decision', 'position_stale_use_maintenance', detail);
      return { mode: 'maintenance', reason: 'position_stale_use_maintenance', detail, etaSec, etaToLineSec, distanceToDockMm };
    }
    if (danger?.inside || rawDanger?.inside) {
      const detail = `danger=true; raw=${rawDanger?.inside === true}; lineSide=${currentSide}; garageSide=${garageSide}; ${speed.basis}`;
      this.log('return decision', 'danger_area_use_maintenance', detail);
      return { mode: 'maintenance', reason: 'danger_area_use_maintenance', detail, etaSec, etaToLineSec, distanceToDockMm };
    }

    // The map-half number is ONLY a diagnostic / fallback hint.  On the
    // physically verified LAWN side, it must never override the A-B side
    // and short-ETA stop/gate schedule.  A mower on the GARAGE side of A-B
    // still uses the maintenance point below.  Uncertain side stays guarded.
    const garageHalfKnown = Number.isFinite(halfMm) && halfMm > 0
      && Number.isFinite(distanceToDockMm) && distanceToDockMm >= 0;
    if (garageHalfKnown && distanceToDockMm <= halfMm && routeSideKnown) {
      this.log('[return-route] garage half is advisory only',
        `side=${routeSide}`, `lawn=${lawnSide}`, `garage=${garageSide}`,
        `dockDistanceMm=${Math.round(distanceToDockMm)}`);
    }

    // Away from the finite A-B segment, a waypoint number is not evidence of
    // which side of the gate the mower occupies. Use the actual mowing polygon,
    // signed lawn-side geometry, finite-segment distance and independent raw
    // danger clearance instead. This applies identically at every map position.
    const insideMowingArea = this._positionInsideMowingArea(pos);
    const genericLawnSidePosition = !routeSideKnown && !line?.onSegment
      && insideMowingArea === true && rawDanger?.known === true
      && Number.isFinite(Number(rawDanger.distance)) && Number.isFinite(Number(rawDanger.radius))
      && Number(rawDanger.distance) > Number(rawDanger.radius) + RETURN_GATE_CLEARANCE_MM
      && line?.known === true && line?.direction?.known === true
      && Number.isFinite(Number(line.distance)) && Number(line.direction.lawnSide) !== 0
      && Math.sign(Number(line.distance)) === Number(line.direction.lawnSide)
      && Math.abs(Number(line.distance)) >= RETURN_PRELINE_STOP_MM
      && distanceToLineMm !== null && distanceToLineMm >= RETURN_PRELINE_STOP_MM;
    if (genericLawnSidePosition) {
      const etaFits = etaToLineSec !== null && etaToLineSec >= requiredOpenLeadSec;
      const reason = etaFits ? 'mapped_lawn_side_eta_sufficient_direct' : 'mapped_lawn_side_eta_short_line_wait';
      const detail = `mowingArea=true; lineSide=lawn; segmentDistance=${Math.round(distanceToLineMm)}mm; etaToSegment=${etaToLineSec ?? '?'}s; required=${requiredOpenLeadSec}s; dangerClearance=${Math.round(Number(rawDanger.distance) - Number(rawDanger.radius))}mm; ${speed.basis}`;
      this.log('return decision', reason, detail);
      this._returnEtaPrediction = null;
      return { mode: 'direct', reason, detail, etaFits, etaSec, etaToLineSec, requiredOpenLeadSec, distanceToDockMm };
    }
    if (routeSideKnown && routeSide === garageSide) {
      const detail = `lineSide=${routeSide}=garageSide; lineDistance=${Math.round(distanceToLineMm || 0)}mm; exact=${exactLineSideKnown}; history=${historySideKnown}; ${speed.basis}`;
      this.log('return decision', 'garage_side_of_safety_line_use_maintenance', detail);
      return { mode: 'maintenance', reason: 'garage_side_of_safety_line_use_maintenance', detail, etaSec, etaToLineSec, distanceToDockMm };
    }

    // A reliable mower on the LAWN side remains on the native/direct return.
    // ETA only decides whether the gate is likely to be open before the mower
    // reaches A-B. If lead time is short, the return executor first pauses
    // at the current lawn-side position, opens the gate and continues after
    // readiness. The safety-line interlock remains the independent brake. Routing to the
    // maintenance point merely because ETA is short created competing return
    // owners (maintenance + line wait) and unnecessary Safety Blocks.
    if (routeSideKnown && routeSide === lawnSide) {
      const etaFits = etaToLineSec != null && etaToLineSec >= requiredOpenLeadSec;
      const reason = etaFits ? 'lawn_side_eta_sufficient_direct' : 'lawn_side_eta_short_line_wait';
      const detail = `lineSide=${routeSide}=lawnSide; etaToLine=${etaToLineSec == null ? '?' : etaToLineSec}s; required=${requiredOpenLeadSec}s; exact=${exactLineSideKnown}; history=${historySideKnown}; ${speed.basis}`;
      this.log('return decision', reason, detail);
      this._returnEtaPrediction = exactLineSideKnown && distanceToLineMm !== null
        ? { token: this._commandToken, ts: Date.now(), speedMps: speed.mps,
          distanceToPrelineMm: Math.max(0, distanceToLineMm - RETURN_PRELINE_STOP_MM) }
        : null;
      return { mode: 'direct', reason, detail, etaFits, etaSec, etaToLineSec, requiredOpenLeadSec, distanceToDockMm };
    }

    // A distance to the dock is NOT a proof of which side of the FINITE A--B
    // segment the mower is on (incident t=-1.23, onSegment=false). In
    // particular, being far from the dock must never authorize a direct
    // DOCK command when garage/lawn-side geometry is unknown. Preserve the
    // immutable maintenance-point recovery instead; its own departure,
    // arrival and safe gate-clearance proofs remain mandatory.
    const detail = `pos=${!!pos} dock=${!!dock} map=${!!boundary} distance=${distanceToDockMm == null ? '?' : Math.round(distanceToDockMm)}mm half=${halfMm == null ? '?' : Math.round(halfMm)}mm lineSideKnown=${routeSideKnown}; exact=${exactLineSideKnown}; history=${historySideKnown}; ${speed.basis}`;
    this.log('return decision', 'line_side_unclear_use_maintenance', detail);
    return { mode: 'maintenance', reason: 'line_side_unclear_use_maintenance', detail, etaSec, etaToLineSec, distanceToDockMm };
  }

  // A verified stop belongs to a return TOKEN, not to each polling tick or
  // every subsequent PAUSE command. Reuse it only with a newer, genuinely fresh
  // position at essentially the same coordinates, plus current native idle/
  // paused telemetry. A repeated old position is NOT a second sample.
  _reuseVerifiedReturnLineStop(token) {
    const proof = this._returnLineStopProof;
    const now = Date.now();
    if (!proof || proof.token !== token || this._manualGateStopped
        || token !== this._commandToken || now < Number(proof.at || 0)
        || now - Number(proof.at || 0) > RETURN_STOP_PROOF_REUSE_MS) return false;
    const status = String(this.device?._observedMowerStatus || '').toLowerCase();
    const statusAt = Number(this.device?._observedMowerStatusAt || 0);
    if (!['paused', 'idle', 'standby'].includes(status)
        || statusAt < Number(proof.requestedAt || proof.at || 0) - 1000
        || now - statusAt > RETURN_STOP_PROOF_REUSE_MS) return false;
    const pos = this.pos();
    const old = proof.position;
    const ts = Number(pos?.ts || 0);
    if (!pos || !old || !Number(old.ts) || !ts
        || ts <= Number(old.ts) || ts < Number(proof.at || 0)
        || now < ts || now - ts > RETURN_OPEN_POSITION_MAX_AGE_MS) return false;
    const drift = this._distance(pos, old);
    if (drift === null || drift > RETURN_STOP_POSITION_DRIFT_MM) return false;
    return true;
  }

  // After a verified PAUSE, a mower may still settle by a few centimetres.
  // The first paused position is not a permanent spatial anchor: field evidence
  // showed a 230mm settling shift, followed by repeated stable MQTT positions.
  // Do NOT simply raise the old 220mm drift tolerance. Instead require two NEW,
  // time-separated, physically sourced positions from the settled location,
  // a fresh post-PAUSE native stationary status and independent danger clearance.
  // This proof is only for this return token; it does not weaken the actual
  // requestOpen()/door-sensor/A-B moving-gate interlocks.
  async _tryNativePauseReturnClearance(token) {
    // One-shot fast path for a PAUSED direct return: MQTT positions may take
    // ~20 s to arrive although the A2 has already stopped. A current native
    // 2:1 state + TWO independent 1:4 reads can prove the same safe position.
    // Never use this for map editing (PAUSED is not task-free IDLE), and never
    // reuse stale MAPD/LOCN cache or a merely accepted pause command.
    const proof = this._returnLineStopProof;
    if (!proof || proof.kind !== 'native_pause' || proof.token !== token
        || token !== this._commandToken || this._manualGateStopped
        || this.doorState() === 'closing' || !proof.position
        || !['mqtt','siid:1:4'].includes(String(proof.position.source || ''))
        || Date.now() - Number(proof.requestedAt || proof.at || 0) > 20000
        || Date.now() - Number(proof.position.ts || 0) > 20000) return false;
    const originMap = this._returnRecoveryRequest?.returnOrigin?.mapIndex;
    if (originMap != null && this.device?._activeMapIndex != null
        && Number(originMap) !== Number(this.device._activeMapIndex)) return false;
    const api = this.device?._api;
    const did = this.device?.getData?.()?.id;
    if (!did || typeof api?.getProperties !== 'function'
        || typeof api?.getMowerPosition !== 'function') return false;
    const response = await api.getProperties(did, [[2,1]], {timeout:1400}).catch(()=>null);
    const status = response?.code === 0 ? response.data?.result?.find(item =>
      Number(item.siid) === 2 && Number(item.piid) === 1 && Number(item.code || 0) === 0) : null;
    if (![2,3].includes(Number(status?.value)) || token !== this._commandToken) return false;
    const p = await this._readNativeStationaryPositionForGarage(token, proof.position, 900);
    if (!p || token !== this._commandToken || this._manualGateStopped
        || this.doorState() === 'closing') return false;
    // A concurrent newer MQTT position can veto a native readback; do not
    // overwrite it with an older stationary sample.
    const live = this.pos();
    if (live && ['mqtt','siid:1:4'].includes(String(live.source || ''))
        && Number(live.ts) > Number(p.ts)
        && this._distance(live,p) > RETURN_STOP_POSITION_DRIFT_MM) return false;
    const raw = await this.markers.rawDangerState(p).catch(()=>null);
    if (!raw?.known || raw.inside === true
        || !Number.isFinite(Number(raw.distance)) || !Number.isFinite(Number(raw.radius))
        || Number(raw.distance) <= Number(raw.radius) + RETURN_GATE_CLEARANCE_MM) return false;
    if (token !== this._commandToken || this._manualGateStopped) return false;
    this._returnLineStopProof = { ...proof, at:Date.now(),
      position:{...p}, physicalClearanceAt:Date.now() };
    this.log('return checkpoint: one-shot native PAUSE/position pair verified',
      `siid2:1=${Number(status.value)}`, 'source=siid:1:4');
    return true;
  }

  async _awaitFreshStoppedReturnClearance(token, timeoutMs = RETURN_POST_LIFECYCLE_POSITION_WAIT_MS) {
    const proof = this._returnLineStopProof;
    if (!proof || proof.token !== token) return false;
    if (proof.kind==='native_checkpoint_stop') {
      return this._confirmNativeZoneStopDirectGateClearance(token);
    }
    // Prefer an event-triggered native pair over waiting for sparse MQTT frames.
    // Failure simply falls back to the existing bounded physical watcher.
    if (proof.kind === 'native_pause'
        && await this._tryNativePauseReturnClearance(token)) return true;
    const deadline = Date.now() + timeoutMs;
    let settled = null;
    let lastSampleTs = Math.max(Number(proof.position?.ts || 0), Number(proof.requestedAt || 0));
    const nativeStationary = () => {
      const st = String(this.device?._observedMowerStatus || '').toLowerCase();
      const at = Number(this.device?._observedMowerStatusAt || 0);
      return ['paused', 'idle', 'standby'].includes(st)
        && at >= Number(proof.requestedAt || proof.at || 0) - 1000
        && Date.now() - at >= 0 && Date.now() - at <= RETURN_STOP_PROOF_REUSE_MS;
    };
    const dangerCleared = async (p, gateAlreadyOpening = false) => {
      const raw = await this.markers.rawDangerState(p).catch(() => null);
      return raw?.known && raw.inside !== true
        && Number.isFinite(Number(raw.distance)) && Number.isFinite(Number(raw.radius))
        // A short-ETA return may have requested OPEN before reaching this
        // stationary checkpoint. Once the gate is already moving, do not
        // require the extra pre-movement buffer a second time; still require a
        // fresh, known position strictly outside the danger radius. The mower
        // remains stopped until the gate is stably open.
        && Number(raw.distance) > Number(raw.radius)
          + (gateAlreadyOpening ? 0 : RETURN_GATE_CLEARANCE_MM);
    };
    while (Date.now() < deadline) {
      const gateState = this.doorState();
      if (token !== this._commandToken || this._manualGateStopped || gateState === 'closing') return false;
      // The acknowledged PAUSED packet is tied to this return token. After the
      // acknowledgement, Homey may publish its own transient `returning` UI
      // state while the mower is physically held at the safety line. Do not
      // invalidate that proof with a state value produced by this same return;
      // fresh independent positions and raw danger clearance below still have
      // to prove the mower is stationary and outside the gate danger radius.
      if (proof.kind !== 'native_pause' && !nativeStationary()) {
        this.log('return checkpoint clearance denied: native paused state no longer fresh');
        return false;
      }
      const p = this.pos();
      const ts = Number(p?.ts || 0);
      const age = Date.now() - ts;
      if (p && ts > 0 && age >= 0 && age < RETURN_OPEN_POSITION_MAX_AGE_MS - 1500) {
        // A native PAUSED acknowledgement plus one genuinely new physical
        // position is sufficient to establish a safe line stop. Requiring a
        // second time-separated position here caused a valid mower to be sent
        // to maintenance while it was already paused, simply because A2 MQTT
        // location updates can be sparse. The raw danger clearance remains a
        // separate mandatory gate-opening condition.
        const physicalSource = ['mqtt', 'siid:1:4', 'garage-marker-direct'].includes(String(p.source || ''));
        if (proof.kind === 'native_pause' && physicalSource
            && ts >= Number(proof.requestedAt || proof.at || 0)
            && !['mowing', 'error'].includes(String(this.device?._observedMowerStatus || '').toLowerCase())
            && this._distance(p, proof.position) !== null
            && this._distance(p, proof.position) <= RETURN_STOP_POSITION_DRIFT_MM
            && await dangerCleared(p, gateState === 'opening')) {
          this._returnLineStopProof = { ...proof, at: Date.now(), kind: 'native_pause',
            position: { x: Number(p.x), y: Number(p.y), ts, source: p.source },
            physicalClearanceAt: Date.now() };
          this.log('return checkpoint: native pause and fresh safe position confirmed',
            `source=${p.source}`, `dangerDistance=${Math.round(Number((await this.markers.rawDangerState(p).catch(() => null))?.distance || 0))}mm`,
            gateState === 'opening' ? 'gate_already_opening' : 'gate_stationary');
          return true;
        }
        if (this._reuseVerifiedReturnLineStop(token) && await dangerCleared(p, gateState === 'opening')) {
          this._returnLineStopProof = { ...this._returnLineStopProof, at: Date.now(),
            position: { x: Number(p.x), y: Number(p.y), ts } };
          return true;
        }
        // A fresh MQTT/SIID position is a physical observation. LOCN/MITRC
        // history reads or a buffered coordinate with no provenance must not
        // manufacture the SECOND independent stopped-position witness.
        if (physicalSource && ts > lastSampleTs) {
          lastSampleTs = ts;
          if (await dangerCleared(p, gateState === 'opening')) {
            const drift = settled ? this._distance(p, settled) : null;
            if (settled && drift !== null && drift <= RETURN_STOP_POSITION_DRIFT_MM
                && ts > settled.ts && Date.now() - settled.observedAt >= RETURN_STOP_POSITION_REQUIRED_MS) {
              this._returnLineStopProof = { ...proof, at: Date.now(), kind: 'stationary_position_reanchored',
                position: { x: Number(p.x), y: Number(p.y), ts }, hits: 2 };
              this.log('return checkpoint: fresh stationary position reanchored after settling',
                `drift=${Math.round(drift)}mm`, `source=${p.source}`);
              return true;
            }
            // A genuine position change is not proof of standstill, but it is
            // a new baseline from which subsequent independent samples can
            // demonstrate standstill without guessing motion has stopped.
            settled = { x: Number(p.x), y: Number(p.y), ts, observedAt: Date.now() };
          } else {
            settled = null; // never accumulate proof inside danger clearance
          }
        }
      }
      await sleep(250);
    }
    this.log('return checkpoint position refresh timeout: no fresh independent stationary clearance');
    return false;
  }

  async _confirmNativeZoneStopDirectGateClearance(token) {
    const proof=this._returnZoneDirectStopProof;
    const now=Date.now();
    if (!proof || proof.token!==token || token!==this._commandToken
        || this._manualGateStopped || !proof.nativeIdleVerified
        || now<proof.at || now-proof.at>15000
        || this.doorState()==='closing') return false;
    const requestMap=this._returnRecoveryRequest?.returnOrigin?.mapIndex;
    const currentMap=this.device?._activeMapIndex;
    if (Number.isFinite(Number(requestMap)) && Number.isFinite(Number(currentMap))
        && requestMap != null && currentMap != null && Number(requestMap)!==Number(currentMap))
      return false; // the stored physical coordinates belong to another native map
    const current=this.pos();
    if (current && ['mqtt','siid:1:4'].includes(String(current.source||''))
        && Number(current.ts)>Number(proof.position.ts)
        && this._distance(current,proof.position)>120) return false;
    // Revalidate physical coordinates and native IDLE at the *gate* as well
    // as after MAPD. A task restart or a real mower movement cancels the
    // authorization; no stale map coordinate or accepted STOP ACK suffices.
    const p=await this._readNativeStationaryPositionForGarage(token,proof.position,120);
    if (!p || token!==this._commandToken) return false;
    const did=this.device?.getData?.()?.id;
    const r=did && typeof this.device?._api?.getProperties==='function'
      ? await this.device._api.getProperties(did,[[2,1]],{timeout:1400}).catch(()=>null) : null;
    const item=r?.code===0 ? r.data?.result?.find(x=>Number(x.siid)===2
      && Number(x.piid)===1 && (!x.code || Number(x.code)===0)) : null;
    // The A2 returns SIID 2:1 = 3 (PAUSED) after a native zone STOP.
    // The earlier post-edit checkpoint already accepts this exact value,
    // but the final gate guard used to accept only 2 (IDLE). That conflict
    // rejected three independent 0-mm twin-position reads and incorrectly
    // escalated a perfectly locatable mower to manual emergency recovery.
    // Accept 3 ONLY when the SAME return checkpoint has a native PAUSED
    // witness close to its STOP, and fresh independent coordinates confirm
    // the mower has not moved. Neither a cached pause nor a command ACK works.
    const nativeCode=Number(item?.value);
    const pausedAt=Number(proof.stationaryPausedProofAt||0);
    const validPausedCheckpoint=nativeCode===3 && (
      (pausedAt>0 && pausedAt<=Number(proof.stopConfirmedAt||0)
        && Number(proof.stopConfirmedAt||0)-pausedAt<=2000
        && Date.now()>=pausedAt && Date.now()-pausedAt<=30000)
      || Number(proof.stopStatusCode)===2
    );
    // In either PAUSED case, a new post-gate native twin-position read has
    // just succeeded. A native MOWING / RETURNING code must still refuse OPEN.
    if (nativeCode!==2 && !validPausedCheckpoint) {
      this.log('[return-zone-checkpoint] gate clearance: native stationary state not proved',
        `siid_2_1=${item?.value??'missing'}`,`pairedPaused=${!!validPausedCheckpoint}`);
      return false;
    }
    const latest=this.pos();
    if (latest && ['mqtt','siid:1:4'].includes(String(latest.source||''))
        && Number(latest.ts)>Number(proof.position.ts)
        && this._distance(latest,p)>120) return false;
    const d=await this.markers.rawDangerState(p).catch(()=>null);
    if (token!==this._commandToken || this._manualGateStopped
        || !d?.known || d.inside===true
        || !Number.isFinite(Number(d.distance)) || !Number.isFinite(Number(d.radius))
        || Number(d.distance)<=Number(d.radius)+RETURN_GATE_CLEARANCE_MM) return false;
    proof.at=Date.now();proof.position={...p};
    this.log('[return-zone-checkpoint] direct gate-wait clearance reverified',
      `nativeState=${nativeCode}`,`position=${p.x},${p.y}`);
    return true;
  }

  async _waitForNativePause(token, requestedAt, timeoutMs = RETURN_NATIVE_PAUSE_ACK_TIMEOUT_MS, stopLocation = 'safety line') {
    const until = Date.now() + Math.max(1000, Number(timeoutMs) || RETURN_NATIVE_PAUSE_ACK_TIMEOUT_MS);
    const nativeStopped = () => {
      const observed = String(this.device._observedMowerStatus || '').toLowerCase();
      const observedAt = Number(this.device._observedMowerStatusAt || 0);
      return ['paused', 'idle', 'standby'].includes(observed)
        && observedAt >= requestedAt
        && Date.now() - observedAt <= Math.max(RETURN_NATIVE_PAUSE_ACK_TIMEOUT_MS, Number(timeoutMs) || 0);
    };

    const baseline = this.pos();
    const baselineTs = Number(baseline?.ts || 0);
    const baselineAge = Date.now() - baselineTs;
    let firstStationary = baseline && baselineTs > 0 && baselineAge >= 0 && baselineAge <= RETURN_STOP_POSITION_MAX_AGE_MS
      ? { x: Number(baseline.x), y: Number(baseline.y), ts: baselineTs, observedAt: Date.now() }
      : null;
    let lastPositionTs = firstStationary ? baselineTs : 0;
    let stationaryHits = firstStationary ? 1 : 0;
    while (Date.now() < until) {
      if (this._manualGateStopped || token !== this._commandToken) return false;
      if (this._reuseVerifiedReturnLineStop(token)) {
        this.log('return safety-line stop proof reused with new stationary position');
        return true;
      }
      if (nativeStopped()) {
        // This is a *status acknowledgement only*. The stored position is a
        // candidate; gate and map-edit guards independently validate native
        // readback and do not treat this as a stationary physical release.
        this._returnLineStopProof = { at: Date.now(), kind: 'native_pause', requestedAt,
          token, position: this.pos() };
        this.log(stopLocation === 'current position' ? 'return current-position pause observed' : 'return safety-line pause observed',
          'status_only_native_stationarity_unverified');
        return true;
      }

      // Some A2 firmware paths physically stop at the line but do not emit a
      // fresh PAUSED telegram before the task watchdog complains. Accept a
      // bounded physical stop proof from independent fresh position samples.
      const p = this.pos();
      const ts = Number(p?.ts || 0);
      const age = Date.now() - ts;
      if (p && ts > lastPositionTs && ts >= requestedAt && age >= 0 && age <= RETURN_STOP_POSITION_MAX_AGE_MS) {
        if (!firstStationary) {
          firstStationary = { x: Number(p.x), y: Number(p.y), ts, observedAt: Date.now() };
          stationaryHits = 1;
        } else {
          const drift = this._distance(p, firstStationary);
          if (drift !== null && drift <= RETURN_STOP_POSITION_DRIFT_MM) {
            stationaryHits += 1;
          } else {
            firstStationary = { x: Number(p.x), y: Number(p.y), ts, observedAt: Date.now() };
            stationaryHits = 1;
          }
        }
        lastPositionTs = ts;
        if (firstStationary && stationaryHits >= 2
            && Date.now() - firstStationary.observedAt >= RETURN_STOP_POSITION_REQUIRED_MS) {
          this._returnLineStopProof = {
            at: Date.now(),
            kind: 'stationary_position',
            requestedAt,
            token,
            position: { x: Number(p.x), y: Number(p.y), ts },
            hits: stationaryHits,
          };
          this.log(stopLocation === 'current position' ? 'return current-position stop confirmed' : 'return safety-line stop confirmed', 'stationary_position', `hits=${stationaryHits}`);
          return true;
        }
      }
      await sleep(250);
    }
    return false;
  }

  isVerifiedReturnLifecycleCheckpoint(maxAgeMs = 15000) {
    if (!this.enabled() || !this._safeReturnInProgress || !this._returnGuardActive
        || this._outbound || this._manualMaintenanceTransit || this._manualGateStopped
        || ['opening', 'closing'].includes(this.doorState())) return false;
    const now = Date.now();
    const status = String(this.device?._observedMowerStatus || this.status() || '').toLowerCase();
    const nativeStationary = ['paused', 'idle', 'standby'].includes(status);
    const pos = this.pos();
    const posAt = Number(pos?.ts || 0);
    const posFresh = !!posAt && now - posAt >= 0 && now - posAt <= RETURN_OPEN_POSITION_MAX_AGE_MS;

    const maintenanceAge = now - Number(this._lastMaintenanceReachedAt || 0);
    const maintenanceStop = this._returnMaintenanceStopProof;
    const maintenanceStopFresh = !!maintenanceStop
      && now - Number(maintenanceStop.at || 0) >= 0
      && now - Number(maintenanceStop.at || 0) <= Math.max(10000, Number(maxAgeMs) || 0);
    const maintenanceCheckpoint = this._returnContext === RETURN_STATES.MAINTENANCE
      && Number(this._manualMaintenanceTargetReachedIndex || 1) === Number(this._lockedReturnMaintenancePoint?.index || 1)
      && this._manualMaintenanceReached === true
      && this._manualMaintenancePhase === 'reached'
      && !this._manualMaintenanceTransit
      && maintenanceAge >= 0 && maintenanceAge <= RETURN_MAINTENANCE_ARRIVAL_REUSE_MAX_MS
      && posFresh && (nativeStationary || maintenanceStopFresh);
    if (maintenanceCheckpoint) return true;

    const stop = this._returnLineStopProof;
    const stopAge = now - Number(stop?.at || 0);
    const directCheckpoint = this._returnContext === RETURN_STATES.STARTED
      || this._returnContext === RETURN_STATES.DOCK;
    return directCheckpoint && posFresh && nativeStationary && !!stop
      && stopAge >= 0 && stopAge <= Math.max(5000, Number(maxAgeMs) || 0);
  }

  isVerifiedMaintenanceOpeningMapCheckpoint(maxAgeMs = 20000, editorPhysicalWitnessAt = 0) {
    // Physical gate opening is allowed to overlap map readback, but the old
    // generic lifecycle check refuses ALL map writes while a gate is opening.
    // Only this token-owned, previously verified P1..P5 stationary witness may
    // authorize a manufacturer map edit in the OPENING phase. This does NOT
    // authorize driving or OPEN itself, and never permits CLOSING map writes.
    const proof = this._returnMaintenanceOpeningMapCheckpoint;
    const now = Date.now();
    if (!proof || proof.token !== this._commandToken
        || this._returnContext !== RETURN_STATES.MAINTENANCE
        || !this._safeReturnInProgress || !this._returnGuardActive
        || this._manualGateStopped || this._manualMaintenanceTransit
        || !this._manualMaintenanceReached || this._manualMaintenancePhase !== 'reached'
        || this._outbound || this._emergencyHoldActive()
        || !['opening', 'open'].includes(this.doorState())
        || Number(this._lastMaintenanceReachedAt) !== Number(proof.arrivedAt)
        || Number(this.device?._activeMapIndex) !== Number(proof.mapIndex)
        || now < proof.at || now - proof.at > Math.min(20000, Number(maxAgeMs) || 0)) return false;
    const pos = this.pos();
    if (!pos || this._distance(pos, proof.position) === null
        || this._distance(pos, proof.position) > MAINTENANCE_STATIONARY_DRIFT_MM) return false;
    const status = String(this.device?._observedMowerStatus || '').toLowerCase();
    // Native map editor 200/204 can transiently publish MOWING while the
    // manufacturer task was independently proved IDLE *before* entering edit.
    // Only a fresh two-sample native 1:4 witness obtained AFTER 204 may
    // waive this label. It never waives gate, map, token, movement or IDLE proof.
    const idleProof = this._returnMaintenanceTaskIdleProof;
    const editorMowingWithPhysicalProof = status === 'mowing'
      && Number(editorPhysicalWitnessAt) > 0
      && now - Number(editorPhysicalWitnessAt) >= 0
      && now - Number(editorPhysicalWitnessAt) < 2500
      && idleProof?.token === proof.token
      && Number(idleProof.mapIndex) === Number(proof.mapIndex)
      && Number(idleProof.arrivedAt) === Number(proof.arrivedAt)
      && Number(idleProof.at) >= Number(proof.at)
      && now - Number(idleProof.at) <= 30000;
    if (['mowing','edge_mowing','leaving','returning','remote_control'].includes(status)
        && Number(this.device?._observedMowerStatusAt || 0) > proof.at
        && !editorMowingWithPhysicalProof) return false;
    const nativeStationary = ['paused', 'idle', 'standby'].includes(status);
    const stop = this._returnMaintenanceStopProof;
    const independent = stop?.token === proof.token
        && Number(stop.at) >= Number(proof.arrivedAt)
        && Number(stop.at) <= Number(proof.at)
        && [2,3].includes(Number(stop.statusCode))
        && this._distance(stop.position, proof.position) !== null
        && this._distance(stop.position, proof.position) <= MAINTENANCE_STATIONARY_DRIFT_MM;
    // After 200/204, the paired native position witness plus pre-edit IDLE
    // proof is sufficient even when the original arrival had no reusable
    // _returnMaintenanceStopProof object. No movement or gate release is implied.
    return nativeStationary || independent || editorMowingWithPhysicalProof;
  }

  async _syncReturnLifecycleAtStationaryCheckpoint(token, source = 'return') {
    // Phase-based native no-go zones are a BEST-EFFORT route convenience, not a
    // fourth return interlock. Do not send a new PAUSE or create a safety HOLD
    // merely to edit the manufacturer map. The independent A-B/door/danger
    // interlocks remain the sole authority for releasing the moving mower.
    if (this.device?._pylonLifecycleNeedsTransition?.('return') !== true) return true;
    if (token !== this._commandToken || this._manualGateStopped
        || this._maintenanceJourneyOwnsNavigation()) return false;
    if (!this.isVerifiedReturnLifecycleCheckpoint()) {
      this.log('optional return-zone edit skipped: no verified stationary checkpoint', source);
      return true;
    }
    const p = this.pos();
    const danger = await this.markers.rawDangerState(p).catch(() => null);
    if (token !== this._commandToken || this._maintenanceJourneyOwnsNavigation()) return false;
    if (!p || !danger?.known || danger.inside === true) {
      this.log('optional return-zone edit skipped: lawn-side clearance unconfirmed', source);
      return true;
    }
    try {
      const result = await this.device._syncPylonLifecyclePhase('return', {
        reason:'return_optional_stationary_checkpoint',
        allowVerifiedReturnCheckpoint:true,
        requireRequestedPhase:true,
      });
      if (token !== this._commandToken || this._maintenanceJourneyOwnsNavigation()) return false;
      if (result?.ok === false || result?.unverified === true) {
        this.log('optional return-zone edit not verified; vendor boundary retained',
          result?.reason || 'MAPD_readback_pending', source);
      } else {
        this.log('optional return-zone transition accepted at stationary checkpoint', source);
      }
    } catch (error) {
      this.log('optional return-zone edit failed; returning under original gate safety',
        error?.message || String(error), source);
    }
    return true;
  }

  async _prepareDepartureZoneCheckpoint(token, source = 'garage_start') {
    const device=this.device;
    const candidates=device?._departureZoneRemovalCandidates?.()||[];
    if (!candidates.length) return {needed:false, verified:true};
    const deadlineAt=Date.now()+15000;
    const current=()=>token===this._commandToken && !this._manualGateStopped
      && this.isDockedHomeStatus() && !this._outbound;
    const audit=(stage,extra='')=>this.log('[departure-zone-checkpoint]',
      `token=${token}`,`stage=${stage}`,`zones=${candidates.map(x=>x.id).join(',')}`,
      `budgetLeftMs=${Math.max(0,deadlineAt-Date.now())}`,extra);
    this._zoneSyncUiPhase='removing';
    await this.refreshTileStatus('Sperrzonen ausblenden: Ausfahrt').catch(()=>{});
    this._timeline?.(this._text('Sperrzonen ausblenden – Mäher wartet in der Station',
      'Hiding no-go zones – mower waiting in station'),'departure:zone:removing');
    audit('start');
    try {
      if (!current()) return {needed:true,cancelled:true};
      // The manufacturer-native task must be idle while a map is changed.
      // There is no departure/mowing/door command before this finishes.
      const sync=device._syncPylonLifecyclePhase('departure',{
        reason:'garage_station_departure_zone_checkpoint',requireRequestedPhase:true,
        returnDeadlineAt:deadlineAt,
      });
      let timeout;
      let result;
      try {
        result=await Promise.race([sync,new Promise(resolve=>{
          timeout=setTimeout(()=>resolve({unverified:true,reason:'departure_zone_timeout'}),
            Math.max(0,deadlineAt-Date.now()));
        })]);
      } finally { clearTimeout(timeout); }
      if (!current()) return {needed:true,cancelled:true};
      let verified=false;
      if (Date.now()<deadlineAt-250) {
        const readback=device._verifyReturnZoneRemoval(candidates,deadlineAt);
        let verifyTimer;
        try {
          verified=await Promise.race([readback,new Promise(resolve=>{
            verifyTimer=setTimeout(()=>resolve(false),Math.max(0,deadlineAt-Date.now()));
          })]);
        } finally { clearTimeout(verifyTimer); }
      }
      audit(verified?'mapd_verified':'unverified_fallback',`result=${result?.reason||'returned'}`);
      if (!verified) this._timeline?.(this._text(
        'Sperrzonen nicht entfernt – Ausfahrt unter bestehenden Mäher-Sperren',
        'No-go zones not removed – departure under existing mower restrictions'),
        'departure:zone:mapd_unverified_fallback');
      return {needed:true,verified,reason:verified?'mapd_verified':'unverified_fallback'};
    } catch(error) {
      audit('error_fallback',String(error?.message||error));
      return {needed:true,verified:false,reason:'checkpoint_error'};
    } finally {
      this._zoneSyncUiPhase=null;
      await this.refreshTileStatus('Ausfahrt-Sperrzonenprüfung beendet').catch(()=>{});
      audit('complete');
    }
  }

  /**
   * Recovery priority for a vendor-app return: retain the original return
   * coordinate; try the direct post-STOP rebase; if the native STOP was ACKed
   * but never became IDLE, the map is NOT editable. A separately verified
   * PAUSED mower can still be routed to an existing, map-bound maintenance
   * point (native 109), where the original stationary MAPD edit resumes.
   * NEVER use a cached coordinate, bare PAUSE ACK, unknown point or a moving
   * mower as a waypoint release. A failure returns false to the existing
   * bounded recovery owner; it never issues DOCK or opens the gate.
   */
  async _tryReturnWaypointFallbackAfterUnconfirmedStop(token, source, dockFn, maintenanceFn, checkpoint) {
    if (checkpoint?.reason !== 'stop_unconfirmed' || checkpoint?.stopConfirmedAt
        || token !== this._commandToken || this._manualGateStopped
        || this._emergencyHoldActive() || this._confirmedStationLockActive()
        || !this._safeReturnInProgress || !this._returnGuardActive
        || typeof maintenanceFn !== 'function'
        || ['opening','closing'].includes(this.doorState())) return false;
    const point=this._lockedReturnMaintenancePoint;
    const request=this._returnRecoveryRequest;
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))
        || request?.token !== token || !request.returnOrigin
        || Number(request.returnOrigin.mapIndex) !== Number(this.device?._activeMapIndex)) return false;
    const api=this.device?._api, did=this.device?.getData?.()?.id;
    if (!did || typeof api?.getProperties!=='function') return false;
    const paused=async()=>{
      const result=await api.getProperties(did,[[2,1]],{timeout:1400}).catch(()=>null);
      const value=result?.code===0 ? result.data?.result?.find(p=>Number(p.siid)===2
        && Number(p.piid)===1 && (!p.code || Number(p.code)===0))?.value : null;
      return Number(value)===3;
    };
    if (!(await paused())) return false;
    // Native, physically independent position pair; may differ substantially
    // from the original return-click position after the machine coasted.
    const actual=await this._readNativeStationaryPositionForGarage(token,request.returnOrigin,0,
      {rebaseAfterConfirmedStop:true});
    if (!actual || !(await paused()) || token!==this._commandToken) return false;
    const map=Number(this.device?._activeMapIndex);
    if (map!==Number(request.returnOrigin.mapIndex)) return false;
    const [currentDanger, pointDanger, actualRoute] = await Promise.all([
      this.markers.rawDangerState(actual).catch(()=>null),
      this.markers.rawDangerState(point).catch(()=>null),
      this._decideReturnPath('verified_paused_waypoint_fallback',actual).catch(()=>null),
    ]);
    const safe=d=>d?.known===true && d.inside!==true
      && Number.isFinite(Number(d.distance)) && Number.isFinite(Number(d.radius))
      && Number(d.distance)>Number(d.radius)+RETURN_GATE_CLEARANCE_MM;
    if (!safe(currentDanger)||!safe(pointDanger)||actualRoute?.mode!=='direct'
        || token!==this._commandToken || this._manualGateStopped
        || ['opening','closing'].includes(this.doorState())) return false;
    this._returnWaypointFallbackProof={token,mapIndex:map,at:Date.now(),
      position:{...actual},pointIndex:Number(point.index),nativeStatus:3};
    this.log('[return-fallback] original position retained, actual native PAUSED waypoint detour verified',
      `token=${token}`,`P${point.index}`,
      `origin=${request.returnOrigin.x},${request.returnOrigin.y}`,
      `physical=${actual.x},${actual.y}`);
    this._timeline?.(this._text('Direkte Rückfahrt nicht bestätigbar – sicherer Wartungspunkt wird geprüft',
      'Direct return unconfirmed – checking verified maintenance waypoint'),
      'return:waypoint_verified_fallback');
    // Keep zone untouched until a proven stationary arrival at the point.
    return this._startReturnMaintenanceRoute('return_verified_paused_waypoint_fallback',
      dockFn,maintenanceFn,token,false);
  }

  async _verifyReturnWaypointFallbackPause(token, source) {
    const proof=this._returnWaypointFallbackProof;
    if (!proof || proof.token!==token || source!=='return_verified_paused_waypoint_fallback'
        || !this._safeReturnInProgress || !this._returnGuardActive
        || token!==this._commandToken || this._manualGateStopped
        || Date.now()-proof.at>12000
        || Number(this.device?._activeMapIndex)!==proof.mapIndex
        || Number(this._lockedReturnMaintenancePoint?.index)!==proof.pointIndex
        || this._emergencyHoldActive() || ['opening','closing'].includes(this.doorState())) return false;
    const actual=await this._readNativeStationaryPositionForGarage(token,proof.position,150);
    if (!actual) return false;
    const did=this.device?.getData?.()?.id;
    const r=await this.device._api.getProperties(did,[[2,1]],{timeout:1400}).catch(()=>null);
    const code=r?.code===0?r.data?.result?.find(x=>Number(x.siid)===2 && Number(x.piid)===1
      && (!x.code || Number(x.code)===0))?.value:null;
    if (Number(code)!==3 || token!==this._commandToken) return false;
    const raw=await this.markers.rawDangerState(actual).catch(()=>null);
    if (!raw?.known || raw.inside || Number(raw.distance)<=Number(raw.radius)+RETURN_GATE_CLEARANCE_MM)
      return false;
    proof.position={...actual};proof.at=Date.now();
    return true; // ONLY native 109, never MAPD editing or direct DOCK
  }

  async _prepareReturnZoneCheckpoint(token, source, originalDecision = null) {
    const device = this.device;
    let candidates = device?._returnZoneRemovalCandidates?.() || [];
    if (!candidates.length) return {needed:false, stopped:false, verified:true};
    this._returnZoneCheckpointAttemptedToken = token;
    this._zoneSyncUiPhase = 'removing';
    this.refreshTileStatus('Sperrzonen ausblenden: Rückkehr').catch(()=>{});
    this._timeline?.(this._text('Sperrzonen ausblenden – Rückkehr wartet auf Kartenbestätigung',
      'Hiding no-go zones – return awaiting map verification'),'return:zone:removing');
    const startedAt = Date.now();
    const deadlineAt = startedAt + RETURN_ZONE_CHECKPOINT_TIMEOUT_MS;
    const did = device.getData().id;
    const current = () => token === this._commandToken && !this._manualGateStopped
      && !this._confirmedStationLockActive();
    const audit = (stage, extra = '') => this.log('[return-zone-checkpoint]',
      `token=${token}`, `stage=${stage}`, `zones=${candidates.map(x=>x.id).join(',')}`,
      `budgetLeftMs=${Math.max(0,deadlineAt-Date.now())}`, extra);
    audit('start', `decision=${originalDecision?.mode || 'unknown'} etaFits=${originalDecision?.etaFits}`);
    let stopIssued = false;
    let stopConfirmedAt = 0;
    let verified = false;
    try {
      if (!current()) return {needed:true,cancelled:true};
      const observed = String(device._observedMowerStatus || this.status() || '').toLowerCase();
      if (['mowing','leaving','returning','edge_mowing','remote_control'].includes(observed)) {
        const pauseAt = Date.now();
        audit('pause_requested');
        if (typeof device._safeWrite === 'function')
          await device._safeWrite('return_zone_pause', () => current()?device._api.pause(did,{timeout:1800}):false);
        else await device._api.pause(did,{timeout:1800});
        if (!current()) return {needed:true,cancelled:true};
        // Native acknowledgment is useful but STOP will terminate the task
        // even if a delayed MQTT PAUSED report did not arrive.
        const pauseWindow = Math.max(0,Math.min(1700,deadlineAt-Date.now()-3500));
        if (pauseWindow) await this._waitForNativePause(token,pauseAt,pauseWindow,'current position');
      }
      if (!current() || Date.now() >= deadlineAt-2500) return {needed:true,stopped:false,verified:false,reason:'pause_or_network_timeout'};
      // Preserve the Homey-only mowing trace before ending the vendor task.  A
      // STOP destroys the manufacturer's active pattern but must not erase the
      // route we have already measured and displayed.
      if (typeof device._freezeCompletedMapRouteForDisplay === 'function') {
        await device._freezeCompletedMapRouteForDisplay('return_zone_checkpoint_before_stop',
          {definitive:true}).catch(error => this.log('[return-zone-checkpoint] route snapshot failed',
            String(error?.message || error)));
      }
      if (!current()) return {needed:true,cancelled:true};
      audit('stop_task_requested');
      const accepted = typeof device._safeWrite === 'function'
        ? await device._safeWrite('return_zone_stop_task',()=>current()?device._api.stopMowing(did,{timeout:1800}):false)
        : await device._api.stopMowing(did,{timeout:1800});
      if (accepted === false) return {needed:true,stopped:false,verified:false,reason:'stop_rejected'};
      stopIssued = true;
      this._returnZoneTaskStoppedToken = token;
      const stopAcceptedAt = Date.now();
      // A2 may acknowledge STOP with native 3/PAUSED rather than 2/IDLE.
      // Paused alone is NOT sufficient: require two independent read-only
      // physical-position samples, matching the pre-STOP live GPS position.
      let stopProofCode=2;
      let pauseProofAt=0;
      const baseline=this._returnRecoveryRequest?.token===token
        ? this._returnRecoveryRequest?.returnOrigin : null;
      const readNativeIdle = async () => {
        // Native map editing requires an ENDED task, not a PAUSED mower.
        // SIID 2:1=3 plus two stationary coordinates proves only stillness.
        if (typeof device._api.getProperties !== 'function') return false;
        const response=await device._api.getProperties(did,[[2,1]],{timeout:1400}).catch(()=>null);
        const status=response?.code===0 ? response.data?.result?.find(x=>Number(x.siid)===2
          && Number(x.piid)===1 && Number(x.code||0)===0):null;
        if (Number(status?.value)!==2) {
          // Distinguish task ownership from location: native 3=PAUSED may
          // coexist with perfectly stable 1:4 coordinates, but is NOT an
          // ended task and must not authorize a forbidden-zone write.
          const code = status?.value ?? 'unavailable';
          if (this._returnZoneLastNativeCode !== code) {
            this._returnZoneLastNativeCode = code;
            audit('native_stop_wait', `siid2:1=${code}; location_not_declared_lost`);
          }
          return false;
        }
        this._returnZoneLastNativeCode = 2;
        stopProofCode=2;
        return true;
      };
      let taskEnded=false;
      let stopReasserted=false;
      while (current() && Date.now() < deadlineAt-2000 && !taskEnded) {
        taskEnded=await readNativeIdle();
        // Field log 2026-11-01 17:54:07: the original-app return task
        // raced our acknowledged STOP, leaving native SIID 2:1 at PAUSED (3)
        // and later MOWING instead of the required task-free IDLE (2).
        // Reassert STOP at most once, only for the same active return token,
        // after a settling interval and with enough time for native readback.
        // Never treat STOP acceptance or PAUSED alone as map-edit proof.
        if (!taskEnded && !stopReasserted && current()
            && Date.now() - stopAcceptedAt >= 3500
            && Date.now() < deadlineAt - 6500) {
          stopReasserted=true;
          audit('native_stop_reassert_once', 'reason=acknowledged_stop_not_idle');
          try {
            const retry = typeof device._safeWrite === 'function'
              ? await device._safeWrite('return_zone_stop_task_retry',
                () => current()?device._api.stopMowing(did,{timeout:1800}):false)
              : await device._api.stopMowing(did,{timeout:1800});
            if (retry === false) audit('native_stop_reassert_rejected');
          } catch (err) {
            audit('native_stop_reassert_error', String(err?.message || err));
          }
        }
        if (!taskEnded && current()) await new Promise(r=>setTimeout(r,250));
      }
      if (!current()) return {needed:true,cancelled:true,stopped:stopIssued};
      if (!taskEnded) { audit('stop_not_confirmed_fallback'); return {needed:true,stopped:true,verified:false,reason:'stop_unconfirmed'}; }
      audit('task_ended_confirmed');
      stopConfirmedAt = Date.now();
      this._returnZoneStopProof={token,at:stopConfirmedAt,mapIndex:Number(device._activeMapIndex),statusCode:stopProofCode,pausedStationaryProofAt:pauseProofAt};
      // 02-Nov field: cloud geometry still carried native #103 although
      // authoritative MAPD had already renumbered the same polygon to #102.
      // Refresh read-only AFTER native IDLE and BEFORE choosing any native ID
      // for a write. A failed read does not authorize blind deletion.
      if (typeof device.refreshMapData === 'function' && current()
          && Date.now() < deadlineAt - 8500) {
        try {
          let timer;
          await Promise.race([
            device.refreshMapData({hard:true}),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('return MAPD preflight timeout')), 4500);}),
          ]).finally(()=>clearTimeout(timer));
          if (!current()) return {needed:true,cancelled:true,stopped:stopIssued};
          const fresh=device._returnZoneRemovalCandidates?.() || [];
          if (device._cachedMapData?.directMapdGeometryVerified===true
              && device._automaticNativeZoneMapWriteSafe?.()===true) {
            audit('fresh_mapd_zone_candidates',
              `old=${candidates.map(e=>e.id).join(',')}; current=${fresh.map(e=>e.id).join(',')}`);
            candidates=fresh;
          }
        } catch (e) { audit('fresh_mapd_preflight_unavailable',String(e?.message||e)); }
      }
      if (!candidates.length) {
        audit('no_zones_after_fresh_mapd');
        verified=true;
        return {needed:true,stopped:true,stopConfirmedAt,startedAt,stopStatusCode:stopProofCode,
          stationaryPausedProofAt:pauseProofAt,verified:true,reason:'mapd_already_absent'};
      }
      // Independently verified stillness permits a parallel OPEN attempt. This
      // does not release DOCK and does not declare the native zone deleted.
      // Gate interlocks remain authoritative; a failed early request is handled
      // by the existing post-checkpoint gate wait, never by bypassing safety.
      if (originalDecision?.mode === 'direct') {
        const openingSafe = await this._awaitFreshStoppedReturnClearance(token, 1800).catch(()=>false);
        if (openingSafe && current() && !this._emergencyHoldActive()
            && !this._doorOpenReleaseVerified()
            && !['opening','closing'].includes(this.doorState())) {
          let resolveStart;
          const openingStarted = new Promise(resolve=>{resolveStart=resolve;});
          const gateOpening = this.ensureDoorOpen('return_zone_verified_stop_parallel_open', {
            allowOpenFromDanger:false,allowDegraded:false,
            reassertDisplayedOpen:!this._doorOpenReleaseVerified(),
            onOpenRequestAccepted:()=>resolveStart({ok:true,at:Date.now()}),
          }).then(ok=>{resolveStart({ok:false,at:Date.now()});return ok;},error=>{
            resolveStart({ok:false,at:Date.now()});this.log('return-zone early OPEN failed',String(error?.message||error));return false;
          });
          this._returnZoneEarlyGateOpening={token,gateOpening,openingStarted};
          audit('gate_open_parallel_requested');
        }
      }
      if (Date.now()>=deadlineAt-1800) return {needed:true,stopped:true,stopConfirmedAt,startedAt,stopStatusCode:stopProofCode,stationaryPausedProofAt:pauseProofAt,verified:false,reason:'budget_exhausted'};
      audit('native_edit_begin');
      // A deadline is forwarded into the writer. Even if a vendor read stalls,
      // no new native map mutation may be started after the budget expires.
      const edit = device._syncPylonLifecyclePhase('return',{
        reason:'return_zone_task_ended_checkpoint', allowVerifiedReturnCheckpoint:true,
        requireRequestedPhase:true,returnDeadlineAt:deadlineAt,
      });
      let editTimeout;
      const bounded = new Promise(resolve=>{editTimeout=setTimeout(()=>resolve({unverified:true,reason:'checkpoint_timeout'}),
        Math.max(0,deadlineAt-Date.now()));});
      let result;
      try { result = await Promise.race([edit,bounded]); }
      finally { clearTimeout(editTimeout); }
      if (!current()) return {needed:true,cancelled:true,stopped:stopIssued};
      if (result?.reason==='checkpoint_timeout') {
        audit('timeout_native_edit_still_pending_fallback');
        return {needed:true,stopped:true,stopConfirmedAt,startedAt,stopStatusCode:stopProofCode,stationaryPausedProofAt:pauseProofAt,verified:false,reason:'checkpoint_timeout'};
      }
      if (Date.now() < deadlineAt-1000) {
        const verifyOnce = async () => {
          const check = device._verifyReturnZoneRemoval(candidates,deadlineAt);
          let verificationTimeout;
          try {
            return await Promise.race([check,new Promise(resolve=>{
              verificationTimeout=setTimeout(()=>resolve(false),Math.max(0,deadlineAt-Date.now()));
            })]);
          } finally { clearTimeout(verificationTimeout); }
        };
        verified=await verifyOnce();
        // A successful TASK/HTTP ACK is not proof that the native mutation
        // changed MAPD. Recheck first. If still present, the lifecycle writer
        // permits exactly ONE token-owned retry at this confirmed stationary
        // checkpoint, subject to its deadline and geometry checks.
        if (!verified && current() && Date.now()<deadlineAt-8500) {
          audit('mapd_first_readback_still_present');
          await sleep(900);
          verified=await verifyOnce();
        }
        if (!verified && current() && Date.now()<deadlineAt-6500
            && this._returnZoneStopProof?.token === token
            && this._returnZoneStopProof.statusCode != null) {
          audit('mapd_verified_absence_missing_retry_once');
          const retry=await Promise.race([
            device._syncPylonLifecyclePhase('return', {
              reason:'return_zone_once_only_mapd_confirmed_retry',
              allowVerifiedReturnCheckpoint:true,requireRequestedPhase:true,
              returnDeadlineAt:deadlineAt,
            }),
            sleep(Math.max(0,deadlineAt-Date.now()-1500)).then(()=>({unverified:true,reason:'retry_budget_elapsed'})),
          ]);
          audit('retry_completed',`reason=${retry?.reason||'returned'}`);
        }
        if (!verified && current() && Date.now()<deadlineAt-1000) {
          verified=await verifyOnce();
          audit(verified?'mapd_readback_verified':'mapd_readback_still_present');
        }
      }
      audit(verified?'zone_absence_verified':'zone_unverified_fallback',`result=${result?.reason||'returned'}`);
      if (!verified) this._timeline?.(this._text(
        'Sperrzone nicht entfernt – Rückkehr unter bestehenden Mäher-Sperren fortgesetzt',
        'No-go zone not removed – returning under existing mower restrictions'),
        'return:zone:mapd_unverified_fallback');
      return {needed:true,stopped:true,stopConfirmedAt,startedAt,stopStatusCode:stopProofCode,verified,stationaryPausedProofAt:pauseProofAt,reason:verified?'mapd_verified':'zone_unverified'};
    } catch (err) {
      audit('error_fallback',String(err?.message||err));
      return {needed:true,stopped:stopIssued,stopConfirmedAt,startedAt,stopStatusCode:stopConfirmedAt?stopProofCode:null,stationaryPausedProofAt:pauseProofAt,verified:false,reason:'checkpoint_error'};
    } finally {
      // A verified direct checkpoint and the maintenance continuation share
      // the same immutable return token. Without this, a just-proved MAPD
      // deletion is incorrectly classified as unverified at P1/P2 and HOLDed.
      if (verified && current()) this._returnZoneCheckpointVerifiedToken = token;
      this._zoneSyncUiPhase = null;
      this.refreshTileStatus('Rückkehr-Sperrzonenprüfung beendet').catch(()=>{});
      this._returnZoneStopProof = null;
      // A late native edit is allowed to finish its readback, but a new write
      // will fail the device-side returnDeadlineAt check.
      audit('complete',`stopIssued=${stopIssued} verified=${verified}`);
    }
  }

  async _recoverReturnSafetyLineStop(token, source, stopLocation = 'safety line') {
    if (token !== this._commandToken || this._manualGateStopped) return false;
    const atCurrentPosition = stopLocation === 'current position';
    this._timeline(
      this._text(
        atCurrentPosition ? 'Rückkehr am aktuellen Standort gestoppt – Pausebestätigung fehlt, Wiederherstellung läuft' : 'Rückkehr an Sicherheitslinie gestoppt – Pausebestätigung fehlt, Recovery läuft',
        atCurrentPosition ? 'Return stopped at current position – pause confirmation missing, recovery running' : 'Return stopped at safety line – pause confirmation missing, recovery running',
      ),
      atCurrentPosition ? 'return:current_position_wait:pause_recovery' : 'return:linewait:pause_recovery',
    );

    const did = this.device.getData().id;

    // The first PAUSE has already had a bounded confirmation window. Do not keep
    // the mower trapped at the line with repeated PAUSE commands: terminate the
    // stale native return once, prove the physical stop, then recreate the
    // original dock/return command after the gate is verified open.
    try {
      const stopAt = Date.now();
      const stop = () => token === this._commandToken && !this._maintenanceJourneyOwnsNavigation()
        ? this.device._api.stopMowing(did) : false;
      const accepted = typeof this.device._safeWrite === 'function'
        ? await this.device._safeWrite('garage_return_line_recovery_stop', stop)
        : await stop();
      if (accepted === false) return false;
      this.log(atCurrentPosition ? 'return current-position recovery' : 'return safety-line recovery', 'STOP sent after missing pause acknowledgement');
      this._timeline(
        this._text(
          atCurrentPosition ? 'Rückkehrtask am aktuellen Standort sicher beendet – Stillstand wird geprüft' : 'Rückkehrtask an Sicherheitslinie sicher beendet – Stillstand wird geprüft',
          atCurrentPosition ? 'Return task safely stopped at current position – verifying standstill' : 'Return task safely stopped at safety line – verifying standstill',
        ),
        atCurrentPosition ? 'return:current_position_wait:recovery_stop' : 'return:linewait:recovery_stop',
      );
      if (await this._waitForNativePause(token, stopAt, 4500, stopLocation)) {
        this.log(atCurrentPosition ? 'return current-position recovery' : 'return safety-line recovery', 'stop proof confirmed; original return can be recreated');
        return true;
      }
    } catch (e) {
      this.error(atCurrentPosition ? 'return current-position recovery STOP failed' : 'return safety-line recovery STOP failed', e.message);
    }
    return false;
  }

  _maintenanceJourneyOwnsNavigation() {
    // Manual maintenance begins to own the route BEFORE native opcode 109 is
    // sent (the initial PAUSE/transport may take seconds). An automatic return
    // maintenance journey owns it from its token-scoped pre-dispatch lock, not
    // merely after its physical watcher is armed. This is
    // NOT permission to open the gate or to bypass moving-door danger checks.
    return !this._manualMaintenanceReached && (
      this._manualMaintenanceTransit === true
      || (this._returnContext === RETURN_STATES.MAINTENANCE
        && this._safeReturnInProgress === true && this._returnGuardActive === true
        && ((this._returnMaintenanceNavigationOwnerToken === this._commandToken
          && Number(this._returnMaintenanceNavigationOwnerToken) > 0)
          || (!!this._maintenanceWatch && Number(this._maintenanceRequestedAt || 0) > 0)))
    );
  }

  async _waitAtSafetyLineUntilDoorOpenThenDock(dockFn, token, source) {
    return this._waitAtVerifiedReturnStopUntilDoorOpenThenDock(dockFn, token, source, 'safety line');
  }

  async _waitAtCurrentPositionUntilDoorOpenThenDock(dockFn, token, source) {
    return this._waitAtVerifiedReturnStopUntilDoorOpenThenDock(dockFn, token, source, 'current position');
  }

  async _mayParallelResumeShortReturn(token, source) {
    if (token !== this._commandToken || this._manualGateStopped
        || this._emergencyGateContext || this._emergencyHoldActive?.()
        || !this._safeReturnInProgress || !this._returnGuardActive
        || this._returnContext !== RETURN_STATES.DOCK
        || this._maintenanceJourneyOwnsNavigation?.()
        || this._returnDecision?.mode !== 'direct'
        || !this.sensorEnabled?.() || !this.sensorHealthy?.()) return false;
    // A zone STOP suppresses MQTT packets on stationary A2 mowers. Use the
    // current paired native 1:4 witness from this return token instead of
    // treating the silent MQTT cache as a lost location. The helper itself
    // rereads native IDLE/PAUSED, two physical positions and danger clearance.
    const cp=this._returnZoneDirectStopProof;
    const checkpointWitness=this._returnZoneTaskStoppedToken===token
      && cp?.token===token && cp.nativeIdleVerified===true
      && await this._confirmNativeZoneStopDirectGateClearance(token);
    const p=checkpointWitness ? this._returnZoneDirectStopProof.position : this.pos();
    const age = Date.now() - Number(p?.ts || 0);
    if (!p || !['mqtt','siid:1:4'].includes(String(p.source || ''))
        || age < 0 || age > RETURN_OPEN_POSITION_MAX_AGE_MS) return false;
    const [danger,line] = await Promise.all([
      this.markers.rawDangerState(p).catch(()=>null),
      this.markers.lineState(p).catch(()=>null),
    ]);
    const lineSide = line?.side ?? line?.rawSide;
    const lawnSide = line?.direction?.lawnSide ?? this._lawnLineSide;
    const clearance = Number(danger?.distance) - Number(danger?.radius);
    // Need a genuine lawn-side pose outside BOTH safety boundaries; direct
    // calculations from dock distance are not sufficient here.
    // A far-away mower can be beyond the *ends* of A-B (onSegment=false).
    // Do not lose the safe-parallel path for that common mapped-lawn case.
    // Require its actual mowing polygon and freshly signed lawn-side line
    // geometry instead of guessing a side from the infinite line alone.
    const distToLine = Math.abs(Number(line?.distance));
    const finiteLawnSide = line?.onSegment === true && lineSide === lawnSide;
    const mappedLawnSide = line?.onSegment === false
      && this._positionInsideMowingArea?.(p) === true
      && Number.isFinite(Number(line?.distance))
      && Math.sign(Number(line.distance)) === Number(lawnSide);
    if (!danger?.known || danger.inside || !Number.isFinite(clearance)
        || clearance <= RETURN_GATE_CLEARANCE_MM + 500
        || !line?.known || lawnSide == null
        || !(finiteLawnSide || mappedLawnSide)
        || !Number.isFinite(distToLine)
        || distToLine <= RETURN_PRELINE_STOP_MM + 500) return false;
    const native = String(this.device?._observedMowerStatus||'').toLowerCase();
    const observedAt = Number(this.device?._observedMowerStatusAt||0);
    const nativeStopped=['idle','paused','standby'].includes(native)
      && observedAt && Date.now()-observedAt<=15000;
    const stopProof=this._returnZoneDirectStopProof;
    const checkpointStopped=this._returnZoneTaskStoppedToken===token
      && stopProof?.token===token && stopProof.nativeIdleVerified===true
      && await this._confirmNativeZoneStopDirectGateClearance(token);
    if (!nativeStopped && !checkpointStopped) return false;
    const tokenStillValid = token === this._commandToken
      && !this._manualGateStopped && !this._emergencyHoldActive?.();
    if (tokenStillValid) this.log('direct return overlap safety check passed',source || 'return');
    return tokenStillValid;
  }

  async _loadReturnStartupLearning() {
    const stored = await safeGetStoreValue(this.device, RETURN_STARTUP_STORE_KEY);
    const samples = Array.isArray(stored?.samples) ? stored.samples : [];
    this._returnStartupSamples = samples.filter(v => Number.isInteger(v) && v >= 0
      && v <= RETURN_STARTUP_MAX_CREDIT_SECONDS).slice(-12);
    const learned = stored?.learnedCreditSeconds;
    this._returnStartupLearnedCreditSeconds = Number.isInteger(learned)
      && learned >= 0 && learned <= RETURN_STARTUP_MAX_CREDIT_SECONDS
      ? learned : null;
  }

  _returnStartupCreditSeconds() {
    return Number.isInteger(this._returnStartupLearnedCreditSeconds)
      ? this._returnStartupLearnedCreditSeconds : RETURN_ZONE_STOP_STARTUP_CREDIT_SECONDS;
  }

  _armReturnStartupObservation(token, dispatchAt) {
    // Measuring starts only for a freshly confirmed native zone STOP, never
    // for normal continuous navigation, waypoint, emergency or manual control.
    this._returnStartupObservation = null;
    const proof = this._returnZoneDirectStopProof;
    const pos = this.pos?.();
    const now = Number(dispatchAt);
    if (this._returnZoneTaskStoppedToken !== token || proof?.token !== token
        || proof.nativeIdleVerified !== true || token !== this._commandToken
        || this._manualRecoveryActive || this._manualGateStopped
        || this._emergencyHoldActive?.() || this._maintenanceJourneyOwnsNavigation?.()
        || typeof this.device?.getSetting !== 'function'
        || !this.sensorEnabled?.() || !this.sensorHealthy?.()
        || !pos || !['mqtt', 'siid:1:4'].includes(String(pos.source || ''))
        || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))
        || !(Number(pos.ts) > 0) || now - Number(pos.ts) < 0
        || now - Number(pos.ts) > 3000) return false;
    this._returnStartupObservation = {
      token, dispatchAt:now, baseline:{x:Number(pos.x),y:Number(pos.y)},
      lastTs:Number(pos.ts), stationaryHits:0, lastStationaryAt:0,
      firstMovement:null,
    };
    return true;
  }

  // Called on fresh device telemetry only. A stale or 20-second cloud poll
  // is discarded, not construed as 20 seconds spent physically adjusting.
  _observeReturnStartupPosition(pos = this.pos?.(), now = Date.now()) {
    const o = this._returnStartupObservation;
    if (!o) return false;
    const ts = Number(pos?.ts);
    const age = Number(now) - ts;
    const gap = ts - o.lastTs;
    if (o.token !== this._commandToken || this._manualGateStopped
        || this._manualRecoveryActive || this._emergencyHoldActive?.()
        || this._maintenanceJourneyOwnsNavigation?.()
        || !this.sensorEnabled?.() || !this.sensorHealthy?.()
        || ['closed','closing','unknown'].includes(String(this.doorState?.()))
        || this.isDockedHomeStatus?.()
        || Number(now) - o.dispatchAt > 45000) {
      this._returnStartupObservation = null;
      return false;
    }
    if (pos && ts <= o.lastTs) return false; // same cached coordinate is not a new observation
    if (!pos || !['mqtt','siid:1:4'].includes(String(pos.source || ''))
        || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))
        || !Number.isFinite(ts) || age < 0 || age > 3000
        || gap <= 0 || gap > RETURN_STARTUP_LEARNING_MAX_GAP_MS) {
      this._returnStartupObservation = null;
      return false;
    }
    o.lastTs = ts;
    const dist = Math.hypot(Number(pos.x)-o.baseline.x,Number(pos.y)-o.baseline.y);
    if (!o.firstMovement) {
      if (dist <= 120) {
        o.stationaryHits += 1;
        o.lastStationaryAt = ts;
        return false;
      }
      if (dist < 280) return false; // borderline jitter: no measured movement onset
      if (o.stationaryHits < 2 || !o.lastStationaryAt || dist > 2200) {
        this._returnStartupObservation = null;
        return false;
      }
      o.firstMovement = {at:ts,distance:dist};
      return false;
    }
    // Independent second movement sample excludes a one-frame GPS/cloud jump.
    const secondMovement = dist >= o.firstMovement.distance + 100
      && dist <= o.firstMovement.distance + 2000;
    this._returnStartupObservation = null;
    if (!secondMovement || o.firstMovement.at - o.lastStationaryAt > RETURN_STARTUP_LEARNING_MAX_GAP_MS)
      return false;
    // Last VERIFIED stationary reading is a lower bound on physical startup,
    // unlike first movement detection (which is only an upper bound).
    const latestStationarySec=(o.lastStationaryAt-o.dispatchAt)/1000;
    const firstMovementSec=(o.firstMovement.at-o.dispatchAt)/1000;
    if (latestStationarySec < 1 || firstMovementSec > 35
        || firstMovementSec - latestStationarySec > 4) return false;
    const conservativeCredit = Math.max(0,Math.min(RETURN_STARTUP_MAX_CREDIT_SECONDS,
      Math.floor(latestStationarySec-1)));
    void this._recordReturnStartupSample(conservativeCredit);
    return true;
  }

  async _recordReturnStartupSample(seconds) {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > RETURN_STARTUP_MAX_CREDIT_SECONDS) return false;
    this._returnStartupSamples = [...(this._returnStartupSamples || []),seconds].slice(-12);
    this.log('return native startup qualified telemetry sample',
      `observedConservativeCredit=${seconds}s`,
      `qualifiedTrips=${this._returnStartupSamples.length}`);
    const lastThree=this._returnStartupSamples.slice(-RETURN_STARTUP_LEARNING_MIN_SAMPLES);
    if (lastThree.length === RETURN_STARTUP_LEARNING_MIN_SAMPLES) {
      const sorted=[...lastThree].sort((a,b)=>a-b);
      if (sorted[2]-sorted[0] <= 3) {
        const previous=this._returnStartupCreditSeconds();
        this._returnStartupLearnedCreditSeconds=sorted[1];
        if (previous !== sorted[1]) this.log('return native startup learned (3 trusted trips)',
          `previous=${previous}s`,`new=${sorted[1]}s`, `samples=${lastThree.join(',')}`);
      }
    }
    try {
      await Promise.resolve(this.device?.setStoreValue?.(RETURN_STARTUP_STORE_KEY,{
        samples:this._returnStartupSamples,
        learnedCreditSeconds:this._returnStartupLearnedCreditSeconds,
        updatedAt:Date.now(),
      }));
    } catch (error) { this.log('return startup learning persistence failed',error?.message||String(error)); }
    return true;
  }

  _shortReturnGateOverlapMs(etaToLineSec, verifiedNativeZoneStop = false) {
    // Standard: 20+5-9 = 16 s. After a PROVEN native zone STOP, the vendor
    // still has to begin a new DOCK task; allow an experimental, bounded 18 s
    // startup credit: 20+5-9-18 = 0 s. This is a scheduling assumption, not
    // evidence of physical movement; the A-B brake and real door-contact
    // proof MUST remain independent. No credit for uninterrupted DOCK,
    // maintenance navigation, manual recovery or emergency.
    const openSeconds=Math.max(this._doorOpenDurationSeconds(),this._doorDelaySeconds());
    const startupCredit=verifiedNativeZoneStop===true
      ? this._returnStartupCreditSeconds() : 0;
    return Number.isFinite(Number(etaToLineSec))
      ? Math.max(0,Math.ceil((openSeconds+RETURN_DOOR_ETA_RESERVE_SECONDS-Number(etaToLineSec)-startupCredit)*1000))
      : null;
  }

  async _waitAtVerifiedReturnStopUntilDoorOpenThenDock(dockFn, token, source, stopLocation = 'safety line') {
    // A-B is exclusively a DIRECT-RETURN owner. Never PAUSE a live opcode-109
    // maintenance journey, including the initial interval without movement.
    if (this._maintenanceJourneyOwnsNavigation()) {
      this.log('safety-line wait delegated to maintenance navigation owner', source || 'return');
      return false;
    }
    if (token !== this._commandToken || this._returnLineWaitTerminalToken === token) return false;
    if (this._awaitingLineDoorOpen) return false; // one physical line-wait owner
    this._awaitingLineDoorOpen = true;
    this.log(stopLocation === 'current position' ? 'return wait at current position' : 'return wait at safety line', 'safety_line_wait_door_not_open', source || 'return');
    // SAFETY: cmdPause() is a UI toggle and resumes when the mower is already
    // paused. A safety-line interlock must be one-way only: always issue the
    // native PAUSE action and never turn an existing pause into a resume.
    const did = this.device.getData().id;
    let reuseStop = this._reuseVerifiedReturnLineStop(token);
    const pauseRequestedAt = Date.now();
    // The return-zone checkpoint has ALREADY ended the mower task and proved
    // native IDLE. A second PAUSE on that finished task is unnecessary and may
    // leave the A2 in an inconsistent navigation mode. Reuse the proof only
    // with a recent physical position and a new native-stationary readback.
    if (!reuseStop && this._returnZoneTaskStoppedToken === token) {
      const p = this.pos();
      const observed = String(this.device?._observedMowerStatus || '').toLowerCase();
      const observedAt = Number(this.device?._observedMowerStatusAt || 0);
      const age = Date.now()-Number(p?.ts || 0);
      if (['idle','paused','standby'].includes(observed) && observedAt > 0
          && Date.now()-observedAt < 12000 && p
          && ['mqtt','siid:1:4'].includes(String(p.source || ''))
          && age >= 0 && age < 12000) {
        reuseStop = true;
        this._returnLineStopProof = {at:Date.now(),requestedAt:observedAt,
          token,kind:'native_pause',position:{...p}};
        this.log('[return-zone-checkpoint] reused confirmed stationary STOP for gate wait',
          `source=${p.source}`);
      }
    }
    // Native zone STOP is already over. Retain its validated physical proof
    // as the one owner for the ensuing door wait; a second PAUSE could
    // contradict a completed vendor task. Independently recheck at gate.
    if (!reuseStop && this._returnZoneTaskStoppedToken===token) {
      const checkpoint=this._returnZoneDirectStopProof;
      const now=Date.now();
      if (checkpoint?.token===token && checkpoint.nativeIdleVerified
          && now>=checkpoint.at && now-checkpoint.at<15000) {
        reuseStop=true;
        this._returnLineStopProof={token,at:now,
          requestedAt:checkpoint.stopConfirmedAt,kind:'native_checkpoint_stop',
          position:{...checkpoint.position}};
        this.log('[return-zone-checkpoint] native STOP owner retained for gate wait');
      }
    }
    let pauseCommandAccepted = true;
    if (!reuseStop) {
      try {
        if (typeof this.device._safeWrite === 'function') {
          const accepted = await this.device._safeWrite(stopLocation === 'current position' ? 'return_current_position_hard_pause' : 'garage_return_line_hard_pause', () => token === this._commandToken && !this._maintenanceJourneyOwnsNavigation()
            ? this.device._api.pause(did) : false);
          if (accepted === false) pauseCommandAccepted = false;
        } else {
          const accepted = await this.device._api.pause(did);
          if (accepted === false) pauseCommandAccepted = false;
        }
      } catch (e) {
        pauseCommandAccepted = false;
        this.error('return safety-line hard pause failed', e.message);
      }
    } else {
      this.log('return line wait: prior verified stop still valid; avoiding redundant PAUSE');
    }

    // Reaching the configured A-B line on the lawn side is an expected return
    // waiting point, not a danger event. A missing PAUSED telegram therefore
    // stays a WARNING while we prove physical standstill (fresh position samples)
    // or perform one bounded STOP recovery. Only an unprovable stop becomes a
    // real Safety Block.
    let stopped = reuseStop;
    if (!stopped && pauseCommandAccepted) {
      stopped = await this._waitForNativePause(token, pauseRequestedAt, RETURN_LINE_STATIONARY_WAIT_MS, stopLocation);
    }
    if (token !== this._commandToken || this._maintenanceJourneyOwnsNavigation()) return false;
    if (!stopped) {
      this.log(stopLocation === 'current position' ? 'return current-position stop confirmation missing; entering controlled recovery' : 'return line stop confirmation missing; entering controlled recovery', source || 'return',
        pauseCommandAccepted ? 'pause_ack_missing' : 'pause_rejected_or_failed');
      await this.safetyWarning(pauseCommandAccepted
        ? (stopLocation === 'current position' ? 'return_current_position_pause_confirmation_pending' : 'return_safety_line_pause_confirmation_pending')
        : (stopLocation === 'current position' ? 'return_current_position_pause_failed_recovery' : 'return_safety_line_pause_failed_recovery'));
      const recovered = await this._recoverReturnSafetyLineStop(token, source || 'return', stopLocation);
      if (token !== this._commandToken || this._maintenanceJourneyOwnsNavigation()) return false;
      if (!recovered) {
        this._awaitingLineDoorOpen = false;
        this._returnLineWaitTerminalToken = token;
        this.log(stopLocation === 'current position' ? 'return current-position stop unconfirmed' : 'return line recovery failed: stop proof still unavailable', source || 'return');
        await this.returnOperationalHold(stopLocation === 'current position' ? 'return_current_position_stop_unconfirmed' : 'return_safety_line_stop_unconfirmed');
        this._timeline(
          this._text(
            stopLocation === 'current position' ? 'Rückkehr bleibt aus Sicherheitsgründen am aktuellen Standort gestoppt – Stillstand nicht verifizierbar' : 'Rückkehr bleibt aus Sicherheitsgründen an der Linie gestoppt – Stillstand nicht verifizierbar',
            stopLocation === 'current position' ? 'Return remains stopped at current position for safety – standstill could not be verified' : 'Return remains stopped at the line for safety – standstill could not be verified',
          ),
          stopLocation === 'current position' ? 'return:current_position_wait:recovery_failed' : 'return:linewait:recovery_failed',
        );
        return false;
      }
      await this.safetyWarning(stopLocation === 'current position' ? 'return_current_position_stop_recovered' : 'return_safety_line_stop_recovered');
      this._timeline(
        this._text(
          stopLocation === 'current position' ? 'Stillstand am aktuellen Standort bestätigt – Toröffnung wird fortgesetzt' : 'Stillstand an Sicherheitslinie bestätigt – Toröffnung wird fortgesetzt',
          stopLocation === 'current position' ? 'Standstill at current position confirmed – continuing gate opening' : 'Standstill at safety line confirmed – continuing gate opening',
        ),
        stopLocation === 'current position' ? 'return:current_position_wait:recovered' : 'return:linewait:recovered',
      );
    }
    // The physical line stop is also a convenient OPTIONAL zone checkpoint.
    // An unconfirmed native no-go edit cannot become a return HOLD; the mower's
    // own remaining restriction and the physical A-B interlock stay effective.
    if (this._returnZoneCheckpointAttemptedToken !== token
        && this.device?._pylonLifecycleNeedsTransition?.('return') === true) {
      const previousContext = this._returnContext;
      const previousSafeReturn = this._safeReturnInProgress;
      const previousGuard = this._returnGuardActive;
      this._safeReturnInProgress = true;
      this._returnGuardActive = true;
      this._returnContext = RETURN_STATES.DOCK;
      try {
        const ready = await this._syncReturnLifecycleAtStationaryCheckpoint(token, 'return_safety_line_checkpoint');
        if (token !== this._commandToken || this._maintenanceJourneyOwnsNavigation()) return false;
        if (!ready) {
          this._awaitingLineDoorOpen = false;
          this.log('safety-line return cancelled during optional lifecycle checkpoint');
          return false;
        }
      } finally {
        // Retain the pre-existing owner state; the line wait itself remains
        // responsible for the physical gate and the final dock command.
        this._returnContext = previousContext;
        this._safeReturnInProgress = previousSafeReturn;
        this._returnGuardActive = previousGuard;
      }
    }
    // Do not explicitly allow opening from inside the danger area here. If a
    // late sample says the mower is already underneath the gate, opening it can
    // lift the mower; the emergency/maintenance path must clear the area first.
    // The map readback may outlive the last live position. Do not send OPEN on
    // an expired sample and do not create a new PAUSE owner while waiting.
    if (this.markers?.rawDangerState && !this._doorOpenReleaseVerified()) {
      let cleared = false;
      for (let check = 1; check <= 3; check += 1) {
        if (token !== this._commandToken || this._maintenanceJourneyOwnsNavigation()) return false;
        cleared = await this._awaitFreshStoppedReturnClearance(token, 8000);
        if (token !== this._commandToken || this._maintenanceJourneyOwnsNavigation()) return false;
        if (cleared) break;
        this.log('return stationary clearance pending', `check=${check}/3`);
        if (check < 3) await sleep(1200);
      }
      if (!cleared) {
        this._awaitingLineDoorOpen = false;
        this._returnLineWaitTerminalToken = token;
        const request = this._returnRecoveryRequest;
        if (!request || request.token !== token || typeof request.maintenanceFn !== 'function') {
          await this.returnOperationalHold('return_gate_open_clearance_unconfirmed');
          return false;
        }
        this._pendingDirectDockFn = null;
        this._pendingDirectReturnToken = 0;
        this._pendingDirectReturnSource = null;
        this._returnLineStopProof = null;
        clearTimeout(this._returnRecoveryHold?.timer);
        this._returnRecoveryHold = null;
        this._setReturnContext(RETURN_STATES.MAINTENANCE, 'return_stationary_clearance_fallback');
        this._returnMaintenanceNavigationOwnerToken = token;
        this.log('return handoff to maintenance after three failed stationary checks', source || 'return');
        return this._startReturnMaintenanceRoute('return_stationary_clearance_fallback',
          request.dockFn, request.maintenanceFn, token);
      }
    }
    if (token !== this._commandToken || this._maintenanceJourneyOwnsNavigation()) return false;
    // Direct returns requiring a STOP, including any native zone deletion,
    // reuse their stationarity witness and overlap ONLY
    // the remaining gate-opening time with the mower's safe approach.
    // Start from this existing native-stationary PAUSE / zone checkpoint. The
    // physical A-B brake becomes the owner once DOCK is issued; it must not be
    // disabled by the current-position wait flag. If proof is weak, simply
    // retain the proven old behaviour: wait until the gate is fully OPEN.
    const earlyOpeningCandidate = stopLocation === 'current position'
      && this._returnZoneEarlyGateOpening?.token === token
      ? this._returnZoneEarlyGateOpening : null;
    // An attempted early gate command is not a gate motor proof. A failed
    // early request (no flow dispatch) was previously cached and reused as if
    // OPEN had started. This caused the final line wait to fail immediately,
    // then the safe return became a sticky manual emergency. Recheck that the
    // flow was actually submitted; otherwise perform one final guarded OPEN.
    const earlyStarted = earlyOpeningCandidate
      ? await earlyOpeningCandidate.openingStarted.catch(() => ({ok:false})) : null;
    const previousOpening = earlyStarted?.ok === true
      ? earlyOpeningCandidate : null;
    if (earlyOpeningCandidate && !previousOpening) {
      this.log('return: discarded unstarted early gate OPEN; final verified wait will retry');
      if (this._returnZoneEarlyGateOpening === earlyOpeningCandidate) this._returnZoneEarlyGateOpening = null;
    }
    let openingStarted;
    let gateOpening;
    if (previousOpening) {
      openingStarted=previousOpening.openingStarted;
      gateOpening=previousOpening.gateOpening;
      this.log('return: reusing gate opening started during native zone checkpoint');
    } else {
      let openingAcknowledged;
      openingStarted = new Promise(resolve => { openingAcknowledged = resolve; });
      gateOpening = this.ensureDoorOpen(stopLocation === 'current position' ? 'return_current_position_gate_wait' : 'return_safety_line_wait', {
        allowOpenFromDanger:false, allowDegraded:true,
        reassertDisplayedOpen: !this._doorOpenReleaseVerified(),
        onOpenRequestAccepted: () => openingAcknowledged({ok:true,at:Date.now()}),
      }).then(ok=>{openingAcknowledged({ok:false,at:Date.now()});return ok;},error=>{
        openingAcknowledged({ok:false,at:Date.now()});throw error;
      });
    }
    if (stopLocation === 'current position'
        && await this._mayParallelResumeShortReturn(token, source)) {
      const eta = Number(this._returnDecision?.etaToLineSec);
      const openSeconds = Math.max(this._doorOpenDurationSeconds(), this._doorDelaySeconds());
      // The five-second reserve is included ONCE in requiredOpenLeadSec,
      // not added again. Example: 20 s gate + 5 s reserve - 9 s to A-B
      // = 16 s of gate travel before sending the mower towards A-B.
      // This timer starts ONLY after the external OPEN flow was accepted.
      const requiredOpenLeadSec=openSeconds+RETURN_DOOR_ETA_RESERVE_SECONDS;
      // The credit is restricted to a SAME-TOKEN, natively verified STOP for
      // a zone checkpoint. _mayParallelResumeShortReturn() has already
      // rechecked the sensor, independent stationarity and safe geometry.
      const nativeZoneStopProved=this._returnZoneTaskStoppedToken===token
        && this._returnZoneDirectStopProof?.token===token
        && this._returnZoneDirectStopProof.nativeIdleVerified===true;
      const overlapMs=this._shortReturnGateOverlapMs(eta,nativeZoneStopProved);
      if (nativeZoneStopProved) this.log('return ETA native-zone STOP startup credit (pilot)',
        `credit=${this._returnStartupCreditSeconds()}s`, `eta=${eta}s`,
        `overlap=${overlapMs}ms`, 'A-B brake still mandatory');
      if (Number.isFinite(overlapMs) && eta > RETURN_DOOR_ETA_RESERVE_SECONDS + 2
          && overlapMs < openSeconds*1000) {
        // The contact can prove the gate is FULLY OPEN much sooner than
        // the configured conservative runtime (6 s observed versus 20 s).
        // In that case DOCK can start after a brief stable contact witness;
        // do not keep the stopped mower waiting for the full modelled ETA.
        // Without such a witness retain the calculated overlap deadline.
        const waitForContactOrEta=openingStarted.then(async start=>{
          if (!start?.ok) return {kind:'gate',ok:false};
          const overlapDeadline=start.at+overlapMs;
          while (token===this._commandToken && !this._manualGateStopped) {
            const contactAt=Number(this._lastSensorContactAt||0);
            const fullOpenContact=this.sensorEnabled?.() && this.sensorHealthy?.()
              && this._realDoorOpenSensorProof?.()===true
              && contactAt>=start.at && Date.now()-contactAt>=1200
              && !['closing','closed','unknown'].includes(this.doorState());
            if (fullOpenContact) return {kind:'sensor_open',startAt:start.at};
            if (Date.now()>=overlapDeadline) return {kind:'overlap',startAt:start.at};
            await sleep(Math.min(350,Math.max(50,overlapDeadline-Date.now())));
          }
          return {kind:'cancelled'};
        });
        const outcome=await Promise.race([
          gateOpening.then(ok=>({kind:'gate',ok})).catch(()=>({kind:'gate',ok:false})),
          waitForContactOrEta,
        ]);
        if ((outcome.kind === 'sensor_open'
              || (outcome.kind === 'overlap' && !this._doorOpenReleaseVerified()
                && this.doorState() === 'opening'))
            && await this._mayParallelResumeShortReturn(token, source)) {
          // The line watcher needs to be allowed to issue a one-way PAUSE if
          // A-B is reached before the gate contact confirms OPEN.
          this._awaitingLineDoorOpen = false;
          this._retireMaintenanceArrivalObservation('short_eta_parallel_release');
          let accepted = false;
          try { accepted = await dockFn() !== false; }
          catch (e) { this.log('short-ETA parallel DOCK write failed',e.message); }
          if (accepted && token === this._commandToken && !this._manualGateStopped) {
            if (nativeZoneStopProved) this._armReturnStartupObservation(token,Date.now());
            this.log('short-ETA direct DOCK started during confirmed gate-opening request',
              `eta=${eta}s`, `openingWait=${Date.now()-outcome.startAt}ms`,
              `startupCredit=${nativeZoneStopProved?this._returnStartupCreditSeconds():0}s`,
              `release=${outcome.kind}`, 'A-B brake armed');
            gateOpening.then(async gateOk => {
              if (token !== this._commandToken || !this._safeReturnInProgress
                  || this.isDockedHomeStatus?.()) return;
              if (gateOk !== true || !this._doorOpenReleaseVerified()) {
                // DOCK may already be in flight: brake first; do not send
                // another native DOCK and do not assume OPEN from elapsed time.
                try { await this._pauseMowerForGateInterlock('returning','short_eta_gate_not_confirmed'); }
                catch (err) { this.error('short-ETA gate failure PAUSE',err.message); }
                await this.returnOperationalHold('short_eta_gate_open_unconfirmed');
              }
            }).catch(e=>this.error('short-ETA asynchronous gate check',e.message));
            return true;
          }
          // A rejected command must remain a HOLD, not a second DOCK retry.
          if (token !== this._commandToken || this._manualGateStopped) return false;
          await this.returnOperationalHold('return_dock_command_rejected');
          return false;
        }
      }
    }
    const ok = await gateOpening;
    if (!ok) {
      this._awaitingLineDoorOpen = false;
      this._returnLineWaitTerminalToken = token;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._suspectedPausedReturnTimer = null;
      await this.returnOperationalHold('garage_cannot_open_at_safety_line');
      return false;
    }
    if (token !== this._commandToken || this._maintenanceJourneyOwnsNavigation()) return false;
    if (this._manualGateStopped || !this._doorOpenReleaseVerified()) { this._awaitingLineDoorOpen = false; return false; }
    this.log(stopLocation === 'current position' ? 'return current-position wait released' : 'return line wait released', 'door_open_stable', source || 'return');
    await this.clearSafety(stopLocation === 'current position' ? 'return_current_position_released' : 'return_safety_line_released').catch(() => {});
    this._timeline(
      this._text('Rückkehr wird nach Torfreigabe fortgesetzt', 'Return continues after gate release'),
      stopLocation === 'current position' ? 'return:current_position_wait:released' : 'return:linewait:released',
    );
    // A successful door release is not proof that the A2 accepted the fresh
    // return command. Never mark a line-wait return as completed after a
    // rejected/failed DOCK; keep the mower held for guarded recovery instead.
    let dockAccepted = false;
    if (token !== this._commandToken || this._maintenanceJourneyOwnsNavigation()) return false;
    this._retireMaintenanceArrivalObservation('return_line_release');
    try { dockAccepted = await dockFn(); }
    catch (error) {
      this.log('return line wait: dock command failed', error?.message || String(error));
    }
    if (dockAccepted === false) {
      this._awaitingLineDoorOpen = false;
      this.log('return line wait: dock command unconfirmed; retaining safe return hold');
      await this.returnOperationalHold('return_dock_command_rejected');
      return false;
    }
    if (this._returnZoneTaskStoppedToken===token && this._returnZoneDirectStopProof?.token===token)
      this._armReturnStartupObservation(token,Date.now());
    this._awaitingLineDoorOpen = false;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._suspectedPausedReturnTimer = null;
    return true;
  }



  async _confirmNativeIdleForMaintenanceDispatch(token, source = 'return') {
    // Read-only PRE-FLIGHT. This is a permission to submit the single native
    // waypoint command, NOT proof of arrival and NEVER permission to open/close
    // the gate or bypass the existing danger/line interlocks.
    if (token !== this._commandToken || this._manualGateStopped
        || this._emergencyGateContext || this._lastSafetyStatus === 'emergency'
        || (typeof this.device?.getCapabilityValue === 'function'
          && ['opening', 'closing'].includes(this.doorState?.()))) return false;
    const device = this.device;
    const did = device?.getData?.()?.id;
    const api = device?._api;
    if (!did || typeof api?.getProperties !== 'function'
        || typeof api?.getMowerPosition !== 'function') return false;
    const dock = this._freshNativeDockState?.(12000);
    if (dock?.dockingState === 'IN_STATION' || Number(dock?.undocking) === 1) return false;
    const request = this._returnRecoveryRequest;
    const previous = request?.token === token ? request.returnOrigin : null;
    const live = this.pos?.();
    const baseline = previous && Number.isFinite(Number(previous.x))
      && Number.isFinite(Number(previous.y)) && Date.now() - Number(previous.ts || 0) < 45000
      ? previous : live;
    if (!baseline || !['mqtt', 'siid:1:4'].includes(String(baseline.source || ''))
        || !Number.isFinite(Number(baseline.x)) || !Number.isFinite(Number(baseline.y))
        || Date.now() - Number(baseline.ts || 0) > 45000) return false;
    const readIdle = async () => {
      const response = await api.getProperties(did, [[2, 1]], {timeout: 1400}).catch(() => null);
      const item = response?.code === 0
        ? response.data?.result?.find(p => Number(p.siid) === 2 && Number(p.piid) === 1
          && (!p.code || Number(p.code) === 0)) : null;
      return Number(item?.value) === 2;
    };
    // A2 field case: after native STOP, SIID 2:1 can report PAUSED rather
    // than IDLE. Reuse a recent, same-token STOP proof only when MQTT also
    // reports PAUSED and two independent stationary native positions agree.
    const stoppedByCheckpoint = this._returnZoneTaskStoppedToken === token
      && Number(this._returnLineStopProof?.at || 0) > 0
      && Date.now() - Number(this._returnLineStopProof.at) < 20000;
    const freshPaused = String(device._observedMowerStatus || '').toLowerCase() === 'paused'
      && Date.now() - Number(device._observedMowerStatusAt || 0) < 12000;
    const initialIdle = await readIdle();
    if ((!initialIdle && !(stoppedByCheckpoint && freshPaused)) || token !== this._commandToken) return false;
    const pair = await this._readNativeStationaryPositionForGarage(token, baseline, 900);
    if (!pair || token !== this._commandToken) return false;
    const finalIdle = await readIdle();
    if (!finalIdle && !(stoppedByCheckpoint && freshPaused
      && String(device._observedMowerStatus || '').toLowerCase() === 'paused'
      && Date.now() - Number(device._observedMowerStatusAt || 0) < 12000)) return false;
    const latestDock = this._freshNativeDockState?.(12000);
    if (latestDock?.dockingState === 'IN_STATION' || Number(latestDock?.undocking) === 1
        || this._manualGateStopped || this._emergencyGateContext
        || this._lastSafetyStatus === 'emergency') return false;
    // Only true outside-of-danger coordinates are eligible for a closed-gate
    // waypoint detour. A valid IDLE report by itself cannot prove free space.
    const raw = await this.markers?.rawDangerState?.(pair).catch(() => null);
    if (raw?.known !== true || raw.inside === true
        || !Number.isFinite(Number(raw.distance)) || !Number.isFinite(Number(raw.radius))
        || Number(raw.distance) <= Number(raw.radius) + 150) return false;
    if (previous?.mapIndex != null && device._activeMapIndex != null
        && Number(previous.mapIndex) !== Number(device._activeMapIndex)) return false;
    this.log('maintenance navigation: native idle + twin physical position verified; no duplicate PAUSE',
      source, `token=${token}`, `drift=${Math.round(this._distance(pair, baseline))}mm`);
    return token === this._commandToken;
  }

  async _prepareMowerForReturnPath(source = 'return') {
    // A return command must take control immediately.  Field tests showed that
    // issuing the maintenance command while the A2 is still actively mowing can
    // be ignored by the cloud/device, which leaves the mower mowing although the
    // garage state machine has already made a return decision.  Therefore we
    // first get the mower into a stopped/paused commandable state, then release
    // the chosen return path.  This is deliberately not used for Pause/Resume.
    const s = String(this.status() || '').toLowerCase();
    const native = String(this.device?._observedMowerStatus || '').toLowerCase();
    const taskActive = ['mowing', 'mapping', 'remote_control', 'returning', 'positioning', 'adjusting', 'spot_mowing'].includes(s)
      || ['mowing', 'mapping', 'remote_control', 'returning', 'positioning', 'adjusting', 'spot_mowing'].includes(native)
      || (this.device?._activeCommandMode === 'spot' && !['paused', 'idle', 'standby'].includes(native));
    const nativePausedFresh = ['paused', 'idle', 'standby'].includes(native)
      && Number(this.device?._observedMowerStatusAt || 0) > 0
      && Date.now() - Number(this.device._observedMowerStatusAt) < 8000;
    const token = this._commandToken;
    // Field 20 Oct, 12:30:07: the native task was already STOPPED and SIID
    // 2:1=IDLE, while cloud/capability still briefly said "mowing". A second
    // PAUSE prevented opcode 109 from EVER being sent. Read live native status
    // and two physical positions instead of converting stale telemetry into a
    // new PAUSE owner. A checkpoint without that proof fails closed.
    const checkpointStopped = this._returnZoneTaskStoppedToken === token;
    if (checkpointStopped) {
      const confirmed = await this._confirmNativeIdleForMaintenanceDispatch(token, source);
      if (confirmed) return true;
      // Only the strictly isolated native 109 fallback may use PAUSED(3) with
      // new independent stationary readback, not as a map-edit permission.
      if (await this._verifyReturnWaypointFallbackPause(token,source)) {
        this.log('[return-fallback] native PAUSED stationary proof permits native 109 waypoint only');
        return true;
      }
      this.log('maintenance navigation: post-STOP idle/position not confirmed; no redundant PAUSE', source);
      return false;
    }
    if (!taskActive || nativePausedFresh) return true;
    // A recently installed app may see a stale MOWING label even though the
    // previously stopped mower is physically IDLE beside the closed garage.
    // The same independent proof avoids a second, unacknowledgeable PAUSE.
    if (await this._confirmNativeIdleForMaintenanceDispatch(token, source)) return true;
    const requestedAt = Date.now();
    this.log('maintenance navigation: pause existing task', source || 'maintenance', s);
    try {
      const did = this.device.getData().id;
      const pause = () => token === this._commandToken && !this._manualGateStopped
        ? this.device._api.pause(did) : false;
      const accepted = typeof this.device._safeWrite === 'function'
        ? await this.device._safeWrite('garage_maintenance_prepare_pause', pause) : await pause();
      if (accepted === false || token !== this._commandToken || this._manualGateStopped) return false;
      return await this._waitForNativePause(token, requestedAt, 8000);
    } catch (error) {
      this.log('maintenance navigation: pause not confirmed', error?.message || String(error));
      return false;
    }
  }

  async _sendMaintenanceWithRetry(maintenanceFn, token, source = 'return') {
    // Legacy method name kept for compatibility. The old implementation retried
    // after 3.5 s solely because the cloud still reported mowing/returning. Real
    // A2 field logs prove that a correctly accepted opcode 109 can remain PAUSED
    // for ~32 s before physical movement starts, so status is not a safe retry
    // signal. The position-based watcher below now owns the single retry.
    if (token !== this._commandToken) return false;
    if (String(source || '').toLowerCase().includes('return') && this._confirmedStationLockActive()) {
      this.log('automatic maintenance command suppressed: confirmed physical station lock is active', source || 'return');
      return false;
    }
    this._manualMaintenanceTargetIndex = Number(this._lockedReturnMaintenancePoint?.index || this.device?._maintenancePointIndex?.() || 1);
    const paused = await this._prepareMowerForReturnPath(source);
    if (paused === false || token !== this._commandToken || this._manualGateStopped) return false;
    const accepted = await maintenanceFn();
    if (accepted === false) return false;
    return true;
  }

  _touchSensorSignal(reason = '') {
    this._lastSensorSignalAt = Date.now();
    const undockAt = Number(this.device?._externalStartTraceUndockAt || 0);
    if (undockAt && this._lastSensorSignalAt-undockAt >= 0
        && this._lastSensorSignalAt-undockAt < 120000
        && /door_offen|door_geschlossen/i.test(String(reason || ''))) {
      this.log('[start-latency] door-sensor-edge',
        `reason=${reason}`, `sinceMqttMs=${this._lastSensorSignalAt-undockAt}`);
    }
    if (this.sensorEnabled()) this.log('sensor signal', reason || 'update');
  }
  async _persistRealSensorContact(state, at = Date.now()) {
    const payload = { state, at: Number(at) || Date.now() };
    try { await Promise.resolve(this.device.setStoreValue(SENSOR_CONTACT_STORE_KEY, payload)); } catch (_) {}
  }

  async _restorePersistentSensorState() {
    const contact = await safeGetStoreValue(this.device, SENSOR_CONTACT_STORE_KEY);
    if (contact && ['open', 'closed'].includes(contact.state) && Number.isFinite(Number(contact.at))) {
      this._lastSensorContactState = contact.state;
      this._lastSensorContactAt = Number(contact.at);
      if (contact.state === 'open') this._lastGateOpenHandshakeAt = this._lastSensorContactAt;
    }
    const movement = await safeGetStoreValue(this.device, SENSOR_MOVEMENT_TIMEOUT_STORE_KEY);
    if (movement && Number.isFinite(Number(movement.at))) {
      this._sensorMovementTimeoutAt = Number(movement.at);
      this._sensorMovementTimeoutReason = movement.reason || null;
    }
    // Upgrade healing: old releases stored a movement timeout as general sensor
    // availability. A recent real contact proves that the sensor itself works.
    const avail = this.device.getCapabilityValue('garage_sensor_available_status') || 'unknown';
    const recent = this._lastSensorContactAt && Date.now() - this._lastSensorContactAt < 24 * 60 * 60 * 1000;
    // In builds up to RC127, `timeout` was written for a missed movement edge.
    // It was never reliable evidence that the sensor itself was unavailable.
    // Migrate that stale state back to online; an explicit `offline` remains intact.
    if (avail === 'timeout' || (recent && avail !== 'offline')) {
      await this._setCap('garage_sensor_available_status', 'online');
    }
  }

  async _recordSensorMovementTimeout(direction) {
    this._sensorMovementTimeoutAt = Date.now();
    this._sensorMovementTimeoutReason = direction;
    try {
      await Promise.resolve(this.device.setStoreValue(SENSOR_MOVEMENT_TIMEOUT_STORE_KEY, {
        at: this._sensorMovementTimeoutAt,
        reason: direction,
      }));
    } catch (_) {}
    // A missed confirmation belongs to this door movement only. It does not
    // classify the contact sensor itself as offline or unhealthy.
    await this.safetyWarning(`sensor_${direction}_confirmation_timeout_fallback_to_timer`);
  }

  async _clearSensorMovementTimeout(reason = 'real_contact') {
    this._sensorMovementTimeoutAt = 0;
    this._sensorMovementTimeoutReason = null;
    try { await Promise.resolve(this.device.unsetStoreValue(SENSOR_MOVEMENT_TIMEOUT_STORE_KEY)); } catch (_) {}
    this.log('sensor movement timeout cleared', reason);
  }
  _startSensorWatchdog() {
    // RC2.1: The door contact sensor is only judged during an expected
    // open/close movement. In idle/home/mowing phases we must not mark it
    // offline just because it has not emitted a signal recently.
    if (this._sensorWatchdogTimer) clearInterval(this._sensorWatchdogTimer);
    this._sensorWatchdogTimer = null;
  }
  _stopSensorWatchdog() {

    if (this._sensorWatchdogTimer) clearInterval(this._sensorWatchdogTimer);
    this._sensorWatchdogTimer = null;

  }
  _garageOption(key) {
    return typeof this.device._getGarageManagedSetting === 'function'
      ? this.device._getGarageManagedSetting(key) : this.device.getSetting(key);
  }

  sensorEnabled() { return !!this._garageOption('garage_sensor_enabled'); }
  sensorDoorReliable() { return this.sensorEnabled() && this.sensorHealthy(); }
  // Availability is advisory. If the user enabled a real door contact, always
  // give that contact a chance to confirm the CURRENT movement. A stale
  // offline/timeout capability must not skip directly to the timer fallback.
  // Only a critically low sensor battery disables the movement waiter.
  sensorDoorMonitoringEnabled() {
    if (!this.sensorEnabled()) return false;
    const batt = Number(this.device.getCapabilityValue('garage_sensor_battery') ?? 100);
    const min = Number(this._garageOption('garage_sensor_min_battery') ?? 15);
    return batt > min;
  }
  doorState() { return this.device.getCapabilityValue('garage_door_status') || 'unknown'; }
  isDoorOpenStable() { return this.doorState() === 'open' && !this._stableOpenTimer; }

  // A restored Homey capability can still say "open" after an app restart even
  // when the physical gate has since been closed without a fresh sensor event.
  // For the safety-critical vendor-app start interception, only an OPEN proof
  // produced in this runtime may bypass the pause/open handshake.
  _realDoorOpenSensorProof(maxAgeMs = 5 * 60 * 1000) {
    const now = Date.now();
    const contactAt = Number(this._lastSensorContactAt || 0);
    const requestAt = Number(this._lastDoorOpenRequestAt || 0);
    return this._lastSensorContactState === 'open'
      && contactAt > 0 && contactAt <= now
      && contactAt >= Number(this._runtimeStartedAt || 0)
      && contactAt >= requestAt
      && Number(this._lastGateOpenHandshakeAt || 0) === contactAt
      && now - contactAt <= maxAgeMs;
  }

  _timedDoorOpenReleaseVerified(maxAgeMs = 5 * 60 * 1000) {
    // Explicit degraded-mode proof: time elapsed after a REAL OPEN request,
    // never a fictitious sensor edge. A fresh contradictory CLOSED sensor
    // message or a later motor command invalidates this release immediately.
    const at = Number(this._doorOpenTimedFallbackAt || 0);
    const issuedAt = Number(this._doorOpenTimedFallbackRequestAt || 0);
    const lastRequest = Number(this._lastDoorOpenRequestAt || 0);
    const age = Date.now() - at;
    return !!at && age >= 0 && age <= maxAgeMs
      && issuedAt >= Number(this._runtimeStartedAt || 0)
      && issuedAt > 0 && issuedAt === lastRequest
      && this._doorOpenTimedFallbackToken === this._commandToken
      && (this._lastSensorContactState !== 'closed'
        || Number(this._lastSensorContactAt || 0) < issuedAt);
  }

  _doorOpenVerifiedThisRuntime() {
    if (!this.isDoorOpenStable()) return false;
    if (this.sensorEnabled()) return this._realDoorOpenSensorProof()
      || this._timedDoorOpenReleaseVerified();
    return Number(this._lastDoorOpenReleaseAt || 0) >= Number(this._runtimeStartedAt || 0);
  }

  _doorOpenReleaseVerified(maxAgeMs = 5 * 60 * 1000) {
    if (!this.isDoorOpenStable()) return false;
    if (this.sensorEnabled()) return this._realDoorOpenSensorProof(maxAgeMs)
      || this._timedDoorOpenReleaseVerified(maxAgeMs);
    return !!this._lastDoorOpenReleaseAt
      && Date.now() - this._lastDoorOpenReleaseAt >= 0
      && Date.now() - this._lastDoorOpenReleaseAt <= maxAgeMs;
  }

  _outboundDeparturePhase(now = Date.now()) {
    const out = this._outbound;
    if (!out || !out.originalCommandSentAt) return null;
    // Accepted native command time is the source of truth. A lagging `released`
    // bookkeeping flag cannot trap the tile on Ausfahrt until crossing A-B.
    const startedAt = Number(out.originalCommandSentAt);
    const elapsed = Math.max(0, Number(now) - startedAt);
    if (elapsed < OUTBOUND_EXITING_DISPLAY_MS) return 'exiting';

    // Departure evidence contract:
    // - Ausfahrt itself is never shortened.
    // - During Justieren (and later Positionieren), a physically confirmed
    //   Garage→Lawn A-B crossing OR four consecutive filtered native MOWING
    //   observations proves that the localisation/departure phase has finished.
    // - If neither proof arrives, Justieren lasts the configured 45 s and then
    //   Positionieren remains active without a timeout escape.
    if (out.departureLineConfirmed || out.stableMowingConfirmed) return 'mowing';
    if (elapsed < OUTBOUND_EXITING_DISPLAY_MS + MIN_ADJUSTING_MS) return 'adjusting';
    return 'positioning';
  }

  _outboundPhaseProtected() {
    if (!this._outbound) return false;
    // A separately verified P1/P2 arrival ENDS the departure phase. An old
    // _outbound record must not keep the garage stuck in Positionieren after
    // the native waypoint has been reached and the mower is stationary.
    if (this._manualMaintenanceReached && !this._manualMaintenanceTransit
        && this._manualMaintenancePhase === 'reached'
        && Number(this._lastMaintenanceReachedAt || this._lastAdditionalMaintenanceReached?.at || 0) > 0) return false;
    const phase = this._outboundDeparturePhase();
    // Absolute door rule: an active outbound is protected even before the native
    // command is released; Ausfahrt, Justieren and Positionieren never share the
    // doorway with a closing gate. Positionieren has no timeout escape.
    if (!phase) return true;
    return phase === 'exiting' || phase === 'adjusting' || phase === 'positioning';
  }

  _outboundCloseProtected() {
    return !!this._outbound && (
      this._outboundPhaseProtected()
      || !(this._lineToLawnConfirmed && this._lineState === LINE_STATES.DOOR_CLOSE_ALLOWED)
    );
  }

  async _waitForDoorClosedOrTimeout(token = this._commandToken) {
    const fallbackMs = Math.max(0, this._doorCloseDurationSeconds() * 1000);
    const maxWait = this.sensorDoorMonitoringEnabled() ? DOOR_SENSOR_TIMEOUT_MS + fallbackMs + 3000 : fallbackMs + 3000;
    const deadline = Date.now() + Math.max(3000, maxWait);
    while (Date.now() < deadline) {
      if (token !== this._commandToken || this._manualGateStopped) return false;
      if (this.doorState() === 'closed') return true;
      await sleep(EXIT_RESUME_AFTER_CLOSE_POLL_MS);
    }
    return token === this._commandToken && !this._manualGateStopped && this.doorState() === 'closed';
  }

  isVerifiedExitLifecycleCheckpoint(maxAgeMs = 15000) {
    const proof = this._exitLifecycleCheckpoint;
    const now = Date.now();
    if (!this.enabled() || !this._exitPauseForCloseActive || !this._outbound
        || !proof || proof.outbound !== this._outbound || proof.token !== this._commandToken
        || this._manualGateStopped || this.isReturnCycleActive()
        || (this._outboundPhaseProtected() && proof.departureClearedAtPause !== true)
        || ['opening', 'closing'].includes(this.doorState())) return false;
    const age = now - Number(proof.at || 0);
    const p = this.pos(), pAt = Number(p?.ts || 0);
    if (age < 0 || age > Math.max(3000, Number(maxAgeMs) || 0)
        || !p || !pAt || now - pAt < 0 || now - pAt > 10000
        || pAt < Number(proof.position?.ts || 0)) return false;
    const drift = this._distance(p, proof.position);
    if (drift === null || drift > RETURN_STOP_POSITION_DRIFT_MM) return false;
    // A newer definite mowing/returning observation revokes the stop proof.
    const observed = String(this.device?._observedMowerStatus || '').toLowerCase();
    const observedAt = Number(this.device?._observedMowerStatusAt || 0);
    if (observedAt > proof.at && ['mowing', 'edge_mowing', 'returning', 'remote_control'].includes(observed)) return false;
    return true;
  }

  async _awaitFreshExitLifecycleClearance(token, timeoutMs = 30000) {
    // Native map editing may consume the 5-second position TTL while the mower
    // is stationary. Wait only for NEW physically sourced coordinates, not for
    // a timer to declare the old coordinate fresh. A new motion/error/command
    // cancels the close rather than bypassing any existing gate guard.
    const outbound = this._outbound;
    const proof = this._exitLifecycleCheckpoint;
    if (!outbound || !proof || proof.outbound !== outbound || proof.token !== token) return false;
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0);
    let lastRefresh = 0;
    while (Date.now() < deadline) {
      if (this._outbound !== outbound || token !== this._commandToken || this._manualGateStopped
          || this.isReturnCycleActive() || ['opening','closing'].includes(this.doorState())) return false;
      const p = this.pos();
      const drift = this._distance(p, proof.position);
      if (drift === null || drift > RETURN_STOP_POSITION_DRIFT_MM) return false;
      if (this.isVerifiedExitLifecycleCheckpoint(90000)
          && this._rawDangerExitConfirmed() && this._hasFreshSafetyPosition(5000, false)) return true;
      if (Date.now() - lastRefresh >= 5000) {
        lastRefresh = Date.now();
        await this._refreshPositionForStart('exit_post_lifecycle_clearance');
      }
      await sleep(700);
    }
    this.log('exit close held: no fresh stationary position after native map edit');
    return false;
  }

  isVerifiedMaintenanceLifecycleCheckpoint(maxAgeMs = 120000) {
    const now = Date.now(), p = this.pos();
    const ts = Number(p?.ts || 0), arrivedAt = Number(this._lastMaintenanceReachedAt || 0);
    const target = this._maintenanceLifecycleStartPoint;
    if (!this.isVerifiedMaintenanceStart() || this._outbound || this._manualGateStopped
        || !target || target.token !== this._commandToken || !arrivedAt
        || now - arrivedAt < 0 || now - arrivedAt > maxAgeMs
        || !p || !ts || now - ts < 0 || now - ts > 10000
        || ['opening','closing'].includes(this.doorState())) return false;
    const observed = String(this.device?._observedMowerStatus || '').toLowerCase();
    const observedAt = Number(this.device?._observedMowerStatusAt || 0);
    if (!['paused', 'idle', 'standby'].includes(observed)
        || !observedAt || now - observedAt < 0 || now - observedAt > 60000) return false;
    const drift = this._distance(p, target.position);
    return drift !== null && drift <= MAINTENANCE_CONFIRM_RADIUS_MM;
  }

  async _pauseCloseResumeAfterExit(reason) {
    const token = this._commandToken;
    if (this._manualGateStopped) return false;
    if (this._exitPauseForCloseActive) return false;
    // A failed lifecycle/stop gate is a single HOLD for this same departure.
    // Repeated MQTT positions must not launch another PAUSE every 10 seconds.
    if (this._exitLifecycleHold?.outbound === this._outbound) return false;
    this._exitPauseForCloseActive = true;
    this._exitLifecycleCheckpoint = null;
    const did = this.device.getData().id;
    const departureClearedAtPause = !this._outboundPhaseProtected() && this._rawDangerExitConfirmed();
    let pausedByGarage = false;
    try {
      // Never pause during the protected physical exit/adjust/position phase.
      if (this._outboundPhaseProtected()) {
        this.log('exit close queued: outbound phase still protected', reason || 'exit');
        return false;
      }
      if (this.status() === 'mowing') {
        const pauseAt = Date.now();
        const accepted = await this.device._safeWrite('garage_exit_pause_before_close', () => this.device._api.pause(did));
        if (accepted === false || token !== this._commandToken) return false;
        pausedByGarage = true;
        if (!(await this._waitForNativePause(token, pauseAt))) {
          this._exitLifecycleHold = { outbound:this._outbound, at:Date.now(), reason:'exit_pause_unconfirmed' };
          await this.safetyWarning('exit_pause_unconfirmed');
          return false;
        }
        this._exitLifecycleCheckpoint = { outbound:this._outbound, token, at:Date.now(), position:this.pos(), departureClearedAtPause };
        this.log('mower paused for safe garage close', reason || 'exit');
        if (EXIT_PAUSE_SETTLE_MS > 0) await sleep(EXIT_PAUSE_SETTLE_MS);
      }
      if (typeof this.device?._syncPylonLifecyclePhase === 'function') {
        const lifecycle = await this.device._syncPylonLifecyclePhase('mowing', { reason:'garage_exit_complete', allowVerifiedExitCheckpoint:true, requireRequestedPhase:true });
        if (lifecycle?.ok === false) {
          this._exitLifecycleHold = { outbound:this._outbound, at:Date.now(), reason:lifecycle?.reason || 'unknown' };
          this.log('mower remains paused: pylon lifecycle mowing transition failed', lifecycle?.reason || 'unknown');
          await this.safetyWarning('pylon_lifecycle_mowing_sync_failed').catch(() => {});
          return false;
        }
      }
      // Priority 3 deliberately creates a short pause transition before the
      // close request. Current A2 firmware can emit a transient native `error`
      // (status=3) for a few hundred milliseconds as a side effect of 5:4 even
      // though the command is accepted and the mower immediately settles to
      // PAUSED. Pass this very narrow context into the close guard so that this
      // one known transition cannot be mistaken for an autonomous inbound trip.
      // All geometry, line, position and danger guards remain mandatory.
      if (token !== this._commandToken || this._manualGateStopped) return false;
      // Priority 1 can pause with the mower still on the garage side of the
      // A/B line. Closing is allowed only after renewed OUTSIDE danger proof,
      // not from the timer or stale pre-edit ETA. Do not relax gate safety.
      if (!(await this._awaitFreshExitLifecycleClearance(token))) {
        this._exitLifecycleHold = { outbound:this._outbound, at:Date.now(), reason:'exit_post_edit_position_unconfirmed' };
        await this.safetyWarning('exit_post_edit_position_unconfirmed').catch(() => {});
        return false;
      }
      // The same physical clearance authorizes the outbound close, irrespective
      // of whether ETA priority 1 happened before crossing A/B. The independent
      // danger/position checks in requestClose remain mandatory.
      this._setLineState(LINE_STATES.DOOR_CLOSE_ALLOWED, reason || 'exit_stationary_checkpoint');
      this._lineToLawnConfirmed = true;
      this._outboundExitLocked = true;
      this._dangerReleasedAfterExit = true;
      const closeOk = await this.requestClose(reason || 'exit_confirmed', {
        requireExitConfirmed: true,
        controlledOutboundPauseClose: pausedByGarage,
      });
      if (!closeOk) {
        this._exitLifecycleHold = { outbound:this._outbound, at:Date.now(), reason:'exit_close_rejected' };
        return false;
      }
      const closed = await this._waitForDoorClosedOrTimeout(token);
      if (!closed) {
        this.log('door close completion not confirmed; mower remains paused', reason || 'exit');
        return false;
      }
      if (token !== this._commandToken || this._manualGateStopped) return false;
      if (pausedByGarage && !this.isReturning() && !this._safeReturnInProgress) {
        // Never auto-resume through a real/persistent mower fault. A transient
        // 5:4 error must have cleared after the door-close handshake; otherwise
        // leave the mower stopped for manual inspection. By the time the gate is
        // closed this normally has had many seconds to settle.
        const nativeNow = String(this.status() || '').toLowerCase();
        const uiNow = String(this.device.getCapabilityValue('mower_status') || '').toLowerCase();
        const mowerError = this.device.hasCapability('mower_error')
          ? this.device.getCapabilityValue('mower_error')
          : null;
        const alarm = this.device.hasCapability('alarm_generic')
          ? this.device.getCapabilityValue('alarm_generic')
          : false;
        const persistentFault = nativeNow === 'error'
          || uiNow === 'error'
          || !!mowerError
          || alarm === true;
        if (persistentFault) {
          this.log('resume suppressed after garage close: persistent mower fault',
            `native=${nativeNow || '-'} ui=${uiNow || '-'} error=${mowerError || '-'} alarm=${alarm ? '1' : '0'}`);
          await this.safetyWarning('resume_blocked_persistent_mower_fault');
          this._clearOutboundStatusTimers();
          this._outbound = null;
          this._missionOutside = true;
          this._homeState = 'away';
          return false;
        }
        if (token !== this._commandToken || this._manualGateStopped) return false;
        if (typeof this.device._resumeMowingRobust === 'function') await this.device._resumeMowingRobust('garage_exit_resume_after_close');
        else await this.device._safeWrite('garage_exit_resume_after_close', () => this.device._api.resume(did));
        this.log('mower resumed after garage closed', reason || 'exit');
      }
      // Priority 3 is owned by _evaluateOutboundClosePriorities(), which checks
      // its original outbound token AFTER this await and retires the cycle itself.
      // Priority 1/2 reach us through _closeAfterExitWithoutPause() and require
      // the retirement here. Clearing priority-3 ownership early would make
      // its existing current() guard falsely reject a completed close.
      if (!String(reason || '').startsWith('priority_3_')) {
        this._clearOutboundStatusTimers();
        this._outbound = null;
        this._recentStartExitCloseUntil = Date.now() + 180000;
        this._startCycleIgnoreReturnUntil = Date.now() + 180000;
      }
      this._exitLifecycleHold = null;
      return true;
    } finally {
      this._exitPauseForCloseActive = false;
      this._exitLifecycleCheckpoint = null;
    }
  }


  async _closeAfterExitWithoutPause(reason) {
    if (this._exitLifecycleHold?.outbound === this._outbound) return false;
    if (this.device?._pylonLifecycleNeedsTransition?.('mowing')) {
      this.log('exit close requires stationary pylon lifecycle transition; using pause-close-resume path', reason || 'exit');
      return this._pauseCloseResumeAfterExit(`${reason || 'safe_exit'}_pylon_lifecycle`);
    }
    const token = this._commandToken;
    if (this._manualGateStopped) return false;
    if (this._exitDirectCloseActive || this._closeAfterExitRequested) return false;
    this._exitDirectCloseActive = true;
    try {
      if (this._outboundPhaseProtected()) {
        this.log('direct exit close queued: outbound phase still protected', reason || 'exit');
        return false;
      }
      this._setLineState(LINE_STATES.DOOR_CLOSE_ALLOWED, reason || 'safe_exit');
      this._lineToLawnConfirmed = true;
      this._outboundExitLocked = true;
      this._dangerReleasedAfterExit = true;
      this._closeAfterExitRequested = true;
      await this._setHomeState('away').catch(() => {});
      await this.refreshTileStatus('away').catch(() => {});
      if (token !== this._commandToken || this._manualGateStopped) return false;
      const closeOk = await this.requestClose(reason || 'safe_exit', { requireExitConfirmed: true });
      if (!closeOk) {
        this._closeAfterExitRequested = false;
        return false;
      }
      const closed = await this._waitForDoorClosedOrTimeout(token);
      if (!closed) {
        this.log('door close completion not confirmed', reason || 'safe_exit');
        return false;
      }
      this._clearOutboundStatusTimers();
      this._outbound = null;
      this._recentStartExitCloseUntil = Date.now() + 180000;
      this._startCycleIgnoreReturnUntil = Date.now() + 180000;
      this.log('garage closed while mower continued normally', reason || 'safe_exit');
      return true;
    } finally {
      this._exitDirectCloseActive = false;
    }
  }

  _freshPositionForExitDecision() {
    const p = this.pos();
    if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return null;
    const ts = Number(p.ts || p.timestamp || p.updatedAt || 0);
    if (!ts || Date.now() - ts < 0 || Date.now() - ts > EXIT_POSITION_MAX_AGE_MS) return null;
    return p;
  }

  async _outboundCloseNearMaintenancePoint() {
    const pos = this._freshPositionForExitDecision();
    if (!pos || typeof this.device._resolveStableMaintenancePoint !== 'function') return { near: false, distance: null };
    const maintenance = await this.device._resolveStableMaintenancePoint().catch(() => null);
    if (!maintenance || !Number.isFinite(Number(maintenance.x)) || !Number.isFinite(Number(maintenance.y))) return { near: false, distance: null };
    const distance = this._distance(pos, maintenance);
    return {
      near: Number.isFinite(Number(distance)) && Number(distance) <= MAINTENANCE_POINT_CLOSE_GUARD_MM,
      distance: Number.isFinite(Number(distance)) ? Math.round(Number(distance)) : null,
    };
  }

  _outboundCloseBlockedByMode() {
    const nativeStatus = String(this.status() || '').toLowerCase();
    const homeState = String(this._homeState || '').toLowerCase();
    const blocked = new Set([
      'exiting', 'leaving', 'garage_exiting',
      'adjusting', 'positioning', 'garage_adjusting', 'garage_positioning', 'garage_free_drive',
    ]);
    if (blocked.has(nativeStatus)) return { blocked: true, mode: nativeStatus };
    if (blocked.has(homeState)) return { blocked: true, mode: homeState };
    return { blocked: false, mode: nativeStatus || homeState || 'unknown' };
  }

  _trackRawDangerExit(rawDanger) {
    if (!this._outbound || !rawDanger || !rawDanger.known || rawDanger.inside || !this._hasFreshSafetyPosition(5000, false)) {
      this._rawDangerOutsideSince = 0;
      this._rawDangerOutsideHits = 0;
      this._rawDangerOutsideLastPositionTs = 0;
      return false;
    }
    const positionTs = Number(this.device._lastLivePosAt || this.device._livePos?.ts || 0);
    if (!positionTs) return false;
    if (positionTs !== this._rawDangerOutsideLastPositionTs) {
      if (!this._rawDangerOutsideSince) this._rawDangerOutsideSince = Date.now();
      this._rawDangerOutsideHits += 1;
      this._rawDangerOutsideLastPositionTs = positionTs;
    }
    return this._rawDangerOutsideHits >= 2;
  }

  _rawDangerExitConfirmed() {
    return !!this._outbound
      && this._rawDangerOutsideHits >= 2
      && !!this._rawDangerOutsideSince
      && this._hasFreshSafetyPosition(5000, false);
  }

  _emergencyOpeningRecoveryLockActive() {
    const context = this._emergencyGateContext;
    return !!context
      && context.interruptedDoorMotion === 'closing'
      && this._returnContext === RETURN_STATES.MAINTENANCE;
  }

  async _evaluateOutboundClosePriorities(danger, line) {
    const priorityToken = this._commandToken, outbound = this._outbound;
    const current = () => priorityToken === this._commandToken && this._outbound === outbound && !this._manualGateStopped;
    if (!current()) return false;
    if (!this.enabled() || !this._outbound || this._closeAfterExitRequested || this.isReturning()) return false;
    // A standalone native maintenance-point trip is NOT a mowing departure.
    // The three automatic mowing-close priorities must never steal its route,
    // change its status to MOWING or issue a resume/start command at P2.
    // Maintenance arrival has its own independently verified close owner.
    if (this._manualMaintenanceTransit || this._maintenanceCloseProtected()) return false;
    if (this._outboundPhaseProtected()) return false;
    if (this.status() !== 'mowing') return false;
    if (!danger || danger.inside) return false;
    if (!this._dangerOutsideSince || Date.now() - this._dangerOutsideSince < DANGER_EXIT_STABLE_MS) return false;
    if (!this._rawDangerExitConfirmed()) return false;
    if (!this._freshPositionForExitDecision()) return false;

    // Do not evaluate a close while the mower is still in the native/internal
    // adjusting or positioning phase. Those phases are part of the physical
    // departure and must never share the doorway with a moving gate.
    const modeGuard = this._outboundCloseBlockedByMode();
    if (modeGuard.blocked) {
      this.log('outbound close held: adjusting/positioning active', `mode=${modeGuard.mode}`);
      return false;
    }

    // Priority 1: worst-case ETA to the danger-area boundary exceeds the full
    // configured gate-closing duration plus a fixed safety reserve. Direction is
    // intentionally ignored: this is a conservative direct-return calculation.
    const distance = Number(danger.distance);
    const radius = Number(danger.radius);
    const clearanceMm = Number.isFinite(distance) && Number.isFinite(radius)
      ? Math.max(0, distance - radius)
      : null;
    const speed = this._speedMetersPerSecond();
    const closeSeconds = Math.max(0, this._doorCloseDurationSeconds());
    const requiredSeconds = closeSeconds + EXIT_ETA_SAFETY_RESERVE_SECONDS;
    const etaSeconds = clearanceMm != null && speed && Number.isFinite(speed.mps) && speed.mps > 0.03
      ? (clearanceMm / 1000) / speed.mps
      : null;
    if (etaSeconds != null && etaSeconds >= requiredSeconds) {
      this.log('exit close priority 1: ETA sufficient', `eta=${etaSeconds.toFixed(1)}s required=${requiredSeconds}s clearance=${Math.round(clearanceMm)}mm ${speed.basis}`);
      return this._closeAfterExitWithoutPause('priority_1_eta_safe');
    }

    const expectedLawnSide = this._outbound.lineLawnSide ?? this._lawnLineSide;
    const observedSide = line && line.stable ? line.side : null;
    const onLawnSide = expectedLawnSide !== null && observedSide === expectedLawnSide;
    const lawnDwellMs = this._outbound.lawnSideSince ? Date.now() - this._outbound.lawnSideSince : 0;
    const lawnClearanceMm = line && Number.isFinite(Number(line.distance)) ? Math.abs(Number(line.distance)) : 0;
    const dwellClearanceConfirmed = lawnClearanceMm >= SAFETY_LINE_DWELL_MIN_CLEARANCE_MM;

    // Priority 2 runs in parallel with ETA. One confirmed Garage→Lawn crossing
    // plus ten uninterrupted seconds on the lawn side is sufficient. However,
    // it must not close while the mower has only driven to / stopped at the
    // maintenance point; that situation previously stranded the mower there.
    const maintenanceGuard = await this._outboundCloseNearMaintenancePoint();
    if (!current()) return false;
    if (onLawnSide && Number(this._outbound.lineCrossAttempts || 0) >= 1
        && lawnDwellMs >= SAFETY_LINE_DWELL_FALLBACK_MS
        && dwellClearanceConfirmed
        && !maintenanceGuard.near) {
      this.log('lawn side stable for close', `dwell=${lawnDwellMs}ms attempts=${this._outbound.lineCrossAttempts} clearance=${Math.round(lawnClearanceMm)}mm`);
      return this._closeAfterExitWithoutPause('priority_2_line_dwell');
    }
    if (onLawnSide && Number(this._outbound.lineCrossAttempts || 0) >= 1
        && lawnDwellMs >= SAFETY_LINE_DWELL_FALLBACK_MS && !dwellClearanceConfirmed) {
      this.log('priority 2 held: lawn-side clearance too small', `clearance=${Math.round(lawnClearanceMm)}mm required=${SAFETY_LINE_DWELL_MIN_CLEARANCE_MM}mm`);
    }
    if (maintenanceGuard.near && Number(this._outbound.lineCrossAttempts || 0) < SAFETY_LINE_PAUSE_FALLBACK_ATTEMPT) {
      this.log('priority 2 held: mower near maintenance point', `distance=${maintenanceGuard.distance}mm attempts=${this._outbound.lineCrossAttempts}`);
    }

    // Priority 3 is the final fallback: after two short/failed line-clearance
    // attempts, the third confirmed Garage→Lawn crossing pauses once, closes the
    // gate and resumes. This deliberately remains available even near the
    // maintenance point so the mower is never left standing there permanently.
    if (onLawnSide && dwellClearanceConfirmed && Number(this._outbound.lineCrossAttempts || 0) >= SAFETY_LINE_PAUSE_FALLBACK_ATTEMPT) {
      this.log('exit close priority 3: third crossing pause fallback', `attempts=${this._outbound.lineCrossAttempts} clearance=${Math.round(lawnClearanceMm)}mm`);
      this._setLineState(LINE_STATES.DOOR_CLOSE_ALLOWED, 'priority_3_pause_fallback');
      this._lineToLawnConfirmed = true;
      this._outboundExitLocked = true;
      this._dangerReleasedAfterExit = true;
      this._closeAfterExitRequested = true;
      const closeOk = await this._pauseCloseResumeAfterExit('priority_3_third_crossing');
      if (!current()) return false;
      if (closeOk) {
        this._clearOutboundStatusTimers();
        this._outbound = null;
        this._recentStartExitCloseUntil = Date.now() + 180000;
        this._startCycleIgnoreReturnUntil = Date.now() + 180000;
      } else {
        this._closeAfterExitRequested = false;
      }
      return closeOk;
    }
    return false;
  }

  _startOrOutboundPhaseActive() {
    const now = Date.now();
    return !!this._outbound
      || this._homeState === 'adjusting'
      || (this._outboundHardLockUntil && now < this._outboundHardLockUntil)
      || (this._startDoorReleasedAt && now - this._startDoorReleasedAt < (MIN_ADJUSTING_MS + POSITIONING_FALLBACK_MS + 60000));
  }

  _isSafeHomeClosingContext() {
    if (this._homeDockReadyForClose()) return true;
    // A home-close was independently authorized AFTER 15 s of safe docking.
    // Its door is still physically closing, but a delayed RETURNING packet
    // can reset cloud stability before the next position poll. Keep the
    // verified physical station as owner of that same close operation.
    // A fresh OUT_OF_STATION/u1 immediately removes this exception.
    const issuedAt=Number(this._homeCloseIssuedAt||0);
    return this.doorState()==='closing'
      && issuedAt>0 && Date.now()-issuedAt>=0 && Date.now()-issuedAt<120000
      && this._homeState==='home' && this._confirmedStationLockActive()
      // An independently armed home-close must survive a delayed cloud RETURNING
      // packet. The last real binary station frame remains authoritative for
      // this bounded movement window, even if it is 15-60 s old. A genuine
      // OUT_OF_STATION/undock frame invalidates the lock immediately.
      && this._freshStationHoldProof(60000)
      && this.device?._mowerBinaryDiag?.chargingLive === true
      && !this._outbound && !this._manualGateStopped;
  }

  _invalidateHomeClose(reason) {
    if (!this._homeDockStableSince && !this._homeCloseInProgress) return;
    this._homeDockStableSince = 0;
    this._homeDockLastProofAt = 0;
    this._homeDockEpoch = Number(this._homeDockEpoch || 0) + 1;
    clearTimeout(this._closeTimer);
    this._closeTimer = null;
    this._closeScheduled = false;
    this._homeCloseInProgress = false;
    this._homeCycleLocked = false;
    this._lastHomeAt = 0;
    this._homeState = 'away';
    if (this._returnContext === RETURN_STATES.HOME_CONFIRMED) {
      this._returnContext = RETURN_STATES.IDLE;
      this._safeReturnInProgress = false;
      this._returnGuardActive = false;
    }
    this.log('home close stability reset', reason);
  }

  _freshChargingDockProof(maxAgeMs = 15000) {
    const now = Date.now();
    const charging = String(this.device?.getCapabilityValue?.('charging_status') || '').toLowerCase();
    const native = String(this.status() || '').toLowerCase();
    const observed = String(this.device?._observedMowerStatus || '').toLowerCase();
    const chargeAge = now - Number(this.device?._chargingStatusAt || 0);
    const nativeAge = now - Number(this.device?._observedMowerStatusAt || 0);
    return (chargeAge >= 0 && chargeAge <= maxAgeMs && ['charging', 'charging_completed', 'docked'].includes(charging))
      || (nativeAge >= 0 && nativeAge <= maxAgeMs && ['charging', 'charging_completed', 'docked'].includes(observed || native));
  }

  _freshStationHoldProof(maxAgeMs = 15000) {
    const now = Date.now();
    const binary = this.device?._mowerBinaryDiag;
    const binaryAt = Number(this.device?._mowerBinaryDiagAt || 0);
    const fresh = !!binary && binaryAt > 0 && now - binaryAt >= 0 && now - binaryAt <= maxAgeMs;
    if (!fresh) return false;
    return binary.dockingState === 'IN_STATION' && Number(binary.undocking) === 0;
  }

  _dockHoldCloseProof() {
    // The fresh physical station bit outranks a DELAYED cloud RETURNING frame.
    // The 18-Oct field log had IN_STATION/u0/charging, then the cloud switched
    // briefly to RETURNING while the correctly docked gate was closing. The
    // old status-first guard manufactured a door-motion Emergency. A genuine
    // undock invalidates _freshStationHoldProof() immediately as before.
    if (this._freshStationHoldProof()) return true;
    if (['returning', 'mowing', 'leaving', 'error'].includes(String(this.status()))) return false;
    return this._strongDockCloseProof();
  }

  _homeDockReadyForClose() {
    return Number(this._homeDockStableSince || 0) > 0
      && Date.now() - this._homeDockStableSince >= DOCK_HOME_CONFIRM_MS
      && Number(this._homeDockLastProofAt || 0) > this._homeDockStableSince
      && this._dockHoldCloseProof();
  }

  _resumeDeferredHomeClose(reason = 'fresh_dock_proof') {
    if (!this._homeCloseArmed || this._manualGateStopped || this.doorState() === 'closed') return;
    if (this._closeScheduled || this._homeCloseInProgress) return;
    if (this._homeState !== 'home' && this._returnContext !== RETURN_STATES.HOME_CONFIRMED) return;
    if (!this._strongDockCloseProof() && !this._homeDockReadyForClose()) return;
    this._scheduleHomeClose(reason);
  }

  noteHomeDockTelemetry(diag) {
    if (!diag) return;
    const inStation = diag.dockingState === 'IN_STATION' && Number(diag.undocking) === 0;
    const confirmedStation = inStation && diag.chargingLive === true;
    // Opcode 109 is dispatched while the mower is still physically docked.
    // A station heartbeat just after dispatch belongs to that departure
    // handshake, not to a completed return. Keep its arrival watcher/callback
    // until real undock telemetry arrives; do not arm a home-close meanwhile.
    // This bounded exception is exclusive to an explicit independent trip.
    const maintenanceDispatchAt = Number(this.device?._nativeMaintenanceCommandAt || 0);
    const dispatchAge = Date.now() - maintenanceDispatchAt;
    const explicitMaintenanceDeparturePending = this._manualMaintenanceTransit === true
      && !this._manualMaintenanceReached && Number(this._maintenanceRequestedAt || 0) > 0
      && String(this._outbound?.action || '').includes('maintenance')
      && !this._safeReturnInProgress && !this._returnGuardActive
      && (!this._returnContext || this._returnContext === RETURN_STATES.IDLE)
      && maintenanceDispatchAt > 0 && dispatchAge >= 0 && dispatchAge <= 10000;
    if (inStation && explicitMaintenanceDeparturePending) {
      if (this._maintenanceStationHandshakeLoggedAt !== maintenanceDispatchAt) {
        this._maintenanceStationHandshakeLoggedAt = maintenanceDispatchAt;
        this.log(this._text(
          'Stationsmeldung nach Wartungsbefehl: Ausfahrtsbestätigung abwarten, Ankunftsüberwachung bleibt aktiv',
          'Station heartbeat after maintenance command: awaiting undock, arrival watcher remains active',
        ));
      }
      return;
    }
    if (inStation) {
      this._homeCycleLockPhysicalDepartureAt = 0;
      this._homeCycleLockDepartureSamples = 0;
      this._homeCycleLockDepartureLastAt = 0;
    }
    if (confirmedStation) {
      if (this.device?._pylonLifecycleNeedsTransition?.('departure_ready') === true) {
        // Coalesce repeated identical dock heartbeats without delaying safety commands.
        const now = Date.now();
        if (now - Number(this._lastVerifiedDockRestoreRequestAt || 0) >= 3000) {
          this._lastVerifiedDockRestoreRequestAt = now;
          this.log('[native-zone-lifecycle] verified dock: schedule geometry-first restore (coalesced)');
          this.device._schedulePylonLifecycleSync?.('departure_ready', 'verified_dock_restore');
        }
      }
      this._confirmedNativeStationLock = true;
      this._confirmedNativeStationAt = Date.now();
      // A held native waypoint choice must survive station heartbeats.
      // Real superseding missions are handled by the start state machine.
      const navigationActive = this._safeReturnInProgress || this._returnGuardActive
        || this._returnContext === RETURN_STATES.MAINTENANCE || this._returnContext === RETURN_STATES.DOCK
        || !!this._maintenanceWatch || Number(this._returnMaintenanceNavigationOwnerToken || 0) > 0;
      if (navigationActive) {
        this.log('confirmed native station invalidates pending return/maintenance navigation',
          `token=${this._commandToken}`, 'dock=IN_STATION', 'undock=0', 'charge=1');
        this.cancelPendingCommand('confirmed_native_station');
        this._returnMaintenanceNavigationOwnerToken = null;
        this._maintenanceDepartureConfirmedAt = 0;
        this._manualMaintenanceTransit = false;
        this._manualMaintenanceReached = false;
        this._manualMaintenancePhase = 'idle';
        this._returnContext = RETURN_STATES.HOME_CONFIRMED;
        this._safeReturnInProgress = false;
        this._returnGuardActive = false;
        this._missionOutside = false;
        this._homeState = 'home';
        this._nativeDockVerifiedAt = Date.now();
        // Station is stationary; reconcile suspended zones before any later mow.
        // Device-side restore compares verified native geometry first and does
        // not repeat a create while a previous attempt is unconfirmed.
        this.device?._schedulePylonLifecycleSync?.('departure_ready','confirmed_station_restore');
      }
    } else if (diag.dockingState === 'OUT_OF_STATION'
        || Number(diag.undocking) === 1
        || (diag.dockingState !== 'IN_STATION' && Number(diag.undocking) !== 0)) {
      // A real undock edge invalidates both native and operator dock evidence.
      this._manualDockOperatorAt = 0;
      // Re-docking needs a NEW double read; an old 2/2 success is not reusable.
      if (['confirmed', 'confirmed_not_charging'].includes(this._manualRecoveryDockRearmLast?.result)) {
        this._manualRecoveryDockRearmLast = {
          at: Date.now(), result: 'dock_changed_during_check', reads: 0,
          dock: diag.dockingState || 'unknown', undock: diag.undocking ?? null,
          charging: diag.chargingLive === true,
        };
      }
      if (this._confirmedNativeStationLock && this._homeCycleLocked && !this._homeCycleLockPhysicalDepartureAt) {
        this._homeCycleLockPhysicalDepartureAt = Date.now();
        this._homeCycleLockDepartureSamples = 1;
        this._homeCycleLockDepartureLastAt = Date.now();
        this.log('home-cycle-lock: physical station departure observed; awaiting independent confirmation');
      }
      if (this._homeCycleLockPhysicalDepartureAt
          && Date.now() - Number(this._homeCycleLockDepartureLastAt || 0) >= 250) {
        this._homeCycleLockDepartureSamples = Math.min(3, Number(this._homeCycleLockDepartureSamples || 0) + 1);
        this._homeCycleLockDepartureLastAt = Date.now();
      }
      if (this._confirmedNativeStationLock) {
        this.log('confirmed native station lock released by actual undock telemetry',
          `dock=${diag.dockingState}`, `undock=${Number(diag.undocking)}`);
      }
      this._confirmedNativeStationLock = false;
      this._confirmedNativeStationAt = 0;
    }
    if (inStation) {
      if (this._homeDockStableSince && Date.now() > Number(this._homeDockStableSince || 0)) {
        this._homeDockLastProofAt = Date.now();
      }
      // The charging bit may lag the station bit. Do not tear down a confirmed
      // Home cycle for IN_STATION/u0/charge0; only a real station contradiction
      // invalidates it. A charging/cloud proof can arm the close independently.
      this._resumeDeferredHomeClose('binary_station_hold');
      return;
    }
    const closingAfterHome = this.doorState() === 'closing' && this._homeCloseIssuedAt
      && Date.now() - this._homeCloseIssuedAt < 120000;
    this._invalidateHomeClose(`binary_${diag.dockingState}_u${diag.undocking}_charge${diag.chargingLive ? 1 : 0}`);
    // A departure edge during our dock-close is no longer a safe-home exception.
    // Use the existing moving-gate emergency reversal immediately.
    if (closingAfterHome && !this._manualGateStopped
        && (diag.dockingState !== 'IN_STATION' || Number(diag.undocking) === 1)) {
      this._handleMovingDoorDangerEmergency('closing', 'dock_correction_during_home_close')
        .catch(e => this.error('dock correction gate reversal', e.message));
    }
  }

  _homeCycleNativeDepartureConfirmed() {
    const started=Number(this._homeCycleLockPhysicalDepartureAt || 0);
    const now=Date.now();
    const diag=this.device?._mowerBinaryDiag;
    const at=Number(this.device?._mowerBinaryDiagAt || 0);
    return this._homeCycleLocked === true && started>0
      && Number(this._homeCycleLockDepartureSamples || 0) >= 2
      && now-started>=2000 && now-started<=120000
      && at>=started && now-at>=0 && now-at<=10000
      && !!diag && (diag.dockingState==='OUT_OF_STATION'
        || diag.dockingState==='FINISH_DOCKING'
        || diag.dockingState==='DOCKING_IN_BASE'
        || Number(diag.undocking)===1);
  }

  _confirmedStationLockActive() {
    return this._confirmedNativeStationLock === true
      && Number(this._confirmedNativeStationAt || 0) > 0
      && Date.now() >= Number(this._confirmedNativeStationAt || 0);
  }

  _hasFreshSafetyPosition(maxAgeMs = 5000, requireAfterGateMotion = false) {
    const at = Number(this.device._lastLivePosAt || this.device._livePos?.ts || 0);
    if (!at || Date.now() - at > maxAgeMs) return false;
    // A hard moving-gate emergency is only valid for a movement that THIS app
    // instance has actually observed/requested. After an app restart Homey may
    // restore a stale visible `opening`/`closing` capability; without a fresh
    // motion start timestamp that stale state must never reverse the real gate.
    if (requireAfterGateMotion && !this._gateMotionStartedAt) return false;
    // Never reverse a correctly moving gate from a doorway coordinate that was
    // already old before this opening/closing operation started.
    if (requireAfterGateMotion && at < this._gateMotionStartedAt) return false;
    return true;
  }

  _confirmMovingGateDanger(moving, inside) {
    const positionTs = Number(this.device._lastLivePosAt || this.device._livePos?.ts || 0);
    if (!inside || !this._hasFreshSafetyPosition(5000, true) || !positionTs) {
      this._gateMotionDangerHits = 0;
      this._gateMotionDangerState = null;
      this._gateMotionDangerFirstAt = 0;
      this._gateMotionDangerLastPositionTs = 0;
      return false;
    }
    const now = Date.now();
    if (this._gateMotionDangerState !== moving || now - this._gateMotionDangerFirstAt > 6000) {
      this._gateMotionDangerState = moving;
      this._gateMotionDangerHits = 0;
      this._gateMotionDangerFirstAt = now;
      this._gateMotionDangerLastPositionTs = 0;
    }
    // Count only independent live-position updates. Re-evaluating the same cache
    // entry must never manufacture an emergency confirmation.
    if (positionTs !== this._gateMotionDangerLastPositionTs) {
      this._gateMotionDangerHits += 1;
      this._gateMotionDangerLastPositionTs = positionTs;
    }
    // A moving gate makes the configured danger area a hard interlock in both
    // directions. One fresh post-motion position inside is enough to stop the
    // mower and reverse the gate; waiting for additional samples can leave the
    // mower under a gate that has already travelled too far. Freshness and the
    // post-motion timestamp check above still reject stale cached coordinates.
    return this._gateMotionDangerHits >= 1;
  }

  async _pauseMowerForGateInterlock(mode, reason) {
    if (this._gateMotionPauseActive) return true;
    this._gateMotionPauseActive = true;
    this._gateMotionPauseMode = mode || (this.isReturning() ? 'return' : 'mowing');
    this._gateMotionPauseAt = Date.now();
    const did = this.device.getData().id;
    this.log('gate-motion interlock: pausing mower', this._gateMotionPauseMode, reason || '');
    try {
      if (typeof this.device._safeWrite === 'function') {
        const accepted = await this.device._safeWrite('garage_gate_motion_pause', () => this.device._api.pause(did));
        if (accepted === false) throw new Error('native gate-motion pause rejected');
      } else if (this.device._api && typeof this.device._api.pause === 'function') {
        const accepted = await this.device._api.pause(did);
        if (accepted === false) throw new Error('native gate-motion pause rejected');
      } else {
        // Missing control transport is NOT an accepted stop command. An
        // unpaused mower must never be evacuated toward a moving doorway.
        throw new Error('native mower pause API unavailable');
      }
      return true;
    } catch (e) {
      this.error('gate-motion interlock pause failed', e.message);
      this._gateMotionPauseActive = false;
      return false;
    }
  }

  async _releaseGateMotionInterlockAfterOpen() {
    if (this._manualGateStopped) return false;
    if (this._emergencyGateContext || this._emergencyTransitionPromise) {
      this.log('EMERGENCY gate OPEN event held; recovery sequence owns maintenance release');
      return false;
    }
    if (!this._gateMotionPauseActive || !this.isDoorOpenStable()) return false;
    const mode = this._gateMotionPauseMode;
    this._gateMotionPauseActive = false;
    this._gateMotionPauseMode = null;
    this._gateMotionPauseAt = 0;
    this._gateMotionDangerHits = 0;
    this._gateMotionDangerState = null;
    this._gateMotionDangerFirstAt = 0;
    this.log('gate-motion interlock released: door stable open', mode || '');
    try {
      if (mode === 'emergency' || this._pendingEmergencyMaintenanceReason) {
        const reason = this._pendingEmergencyMaintenanceReason || 'gate_motion_emergency';
        this._pendingEmergencyMaintenanceReason = null;
        await this._dispatchEmergencyMaintenance(reason);
      } else if (mode === 'return') {
        this._retireMaintenanceArrivalObservation('gate_open_return_release');
        const dockFn = this._pendingDirectDockFn;
        this._pendingDirectDockFn = null;
        this._pendingDirectReturnToken = 0;
        this._pendingDirectReturnSource = null;
        if (typeof dockFn === 'function') await dockFn();
        else {
          const did = this.device.getData().id;
          if (typeof this.device._safeWrite === 'function') await this.device._safeWrite('garage_gate_open_return_release', () => this.device._api.dock(did));
          else await this.device._api.dock(did);
        }
      } else if (mode === 'mowing' || mode === 'outbound') {
        if (typeof this.device._resumeMowingRobust === 'function') await this.device._resumeMowingRobust('garage_gate_open_release');
      }
      return true;
    } catch (e) {
      this.error('gate-motion interlock release failed', e.message);
      return false;
    }
  }

  _movingGateEmergencyAllowed(moving) {
    if (moving === 'closing') {
      // Closing is only allowed to continue while the mower is confirmed home.
      // Every other confirmed danger-area presence must reverse to open.
      return !this._isSafeHomeClosingContext();
    }
    // Opening is handled by the expected-occupancy filter plus the hard emergency
    // path; unexpected fresh entry reverses the gate to closed.
    return false;
  }
  pos() {
    if (typeof this.device._getBufferedLivePosition === 'function') return this.device._getBufferedLivePosition(POSITION_CACHE_MS);
    return this.device._livePos || null;
  }

  status() { return this.device._nativeMowerStatus || this.device.getCapabilityValue('mower_status') || 'unknown'; }
  isMowing() { return this.status() === 'mowing'; }
  isReturning() { return this.status() === 'returning'; }
  isReturnCycleActive() {
    // The native IN_STATION + charging proof is stronger than a delayed
    // cloud RETURNING edge. Never re-arm a finished return at a closed gate.
    if (this._confirmedStationLockActive()) return false;
    return this.isReturning()
      || !!this._safeReturnInProgress
      || !!this._returnGuardActive
      || (this._returnContext && this._returnContext !== RETURN_STATES.IDLE && this._returnContext !== RETURN_STATES.HOME_CONFIRMED);
  }
  isMissionOutside() { return !!this._missionOutside || !!this._outbound || this._homeState === 'away' || this._homeState === 'adjusting'; }
  isHomeStatus() { return this.isDockedHomeStatus(); }
  _chargingIndicatesDocked() {
    const c = this.device.getCapabilityValue('charging_status');
    // Important: "not_charging" is not proof that the mower is docked. During
    // outdoor movement the cloud may keep or emit not_charging, which previously
    // caused the garage state to jump falsely to Zuhause.
    return ['charging', 'charging_completed', 'docked'].includes(c);
  }

  _chargingHomeFallbackAllowed() {
    // Charging capability may stay stale for minutes after the mower leaves the dock.
    // Never let it create HOME_CONFIRMED/close while a start/outbound/outdoor cycle
    // is active or shortly after the mower was released from the garage.
    if (this._outbound) return false;
    if (this._missionOutside) return false;
    if (this._homeState === 'adjusting' || this._homeState === 'away') return false;
    if (this._outboundHardLockUntil && Date.now() < this._outboundHardLockUntil) return false;
    return true;
  }

  isDockedHomeStatus() {
    const s = this.status();
    if (['docked', 'charging', 'charging_completed'].includes(s)) return true;
    return this._chargingHomeFallbackAllowed() && this._chargingIndicatesDocked();
  }

  _nativeHomeStatus(status = this.status()) {
    if (['docked', 'charging', 'charging_completed'].includes(status)) return true;
    // Never use a charging-capability fallback during an active outbound/outdoor
    // mission. The displayed "Zuhause" state must only come from real dock/charge
    // status once the mower has actually returned.
    if (this._outbound || this._missionOutside || this._homeState === 'adjusting' || this._homeState === 'away') return false;
    return this._chargingHomeFallbackAllowed() && this._chargingIndicatesDocked();
  }


  getTileStatus(nativeStatus) {
    if (this._zoneSyncUiPhase === 'removing') return 'garage_zone_removing';
    if (this._zoneSyncUiPhase === 'restoring') return 'garage_zone_restoring';
    // Fresh native IN_STATION/undock=0/charging is stronger than delayed cloud
    // mower-status frames. Keep the tile at Home until telemetry confirms a real
    // undock; otherwise a late idle/returning sample can undo the docked display.
    if (this.enabled() && this._confirmedStationLockActive()) return 'garage_home';

    // A safe return is one continuous user-facing operation, even when its
    // selected route temporarily passes through the maintenance point. Return
    // must therefore win over the internal maintenance sub-state on the tile.
    // Detailed phases remain available in the timeline/logs.
    if (this.enabled() && (this._safeReturnInProgress || this._returnGuardActive
        || (this._returnContext && this._returnContext !== RETURN_STATES.IDLE))) {
      if (this.isDockedHomeStatus() && this._returnContext === RETURN_STATES.HOME_CONFIRMED) return 'garage_home';
      return 'returning';
    }

    // While we are still waiting to release the mower, the moving gate is the
    // useful user-facing state. Once the real mower/maintenance command has been
    // accepted, however, the deterministic departure clock wins so the tile can
    // progress Ausfahrt -> Justieren -> Positionieren without waiting for a late
    // door/MQTT refresh. A closing gate remains visible at all times.
    const departureCommandSent = !!this._outbound?.originalCommandSentAt || !!this._manualMaintenanceCommandAcceptedAt;
    if (this.doorState() === 'opening' && !departureCommandSent) return 'garage_opening';
    if (this.doorState() === 'closing') return 'garage_closing';

    // A manually requested trip to the native maintenance point (not a return)
    // remains its own logical state. The mower firmware may report `mowing`
    // while opcode 109/index 1 is active; never expose that misleading status.
    if (this._manualMaintenanceReached) return 'garage_maintenance_reached';
    const maintenanceCommandAt = Number(this._manualMaintenanceCommandAcceptedAt || this.device?._nativeMaintenanceCommandAt || 0);
    if (this._manualMaintenanceTransit && !maintenanceCommandAt) return 'garage_start_pending';
    // UI only: a maintenance trip dispatched while the mower was already on the
    // lawn never constitutes a garage departure. It needs neither a gate-open
    // display nor Ausfahrt/Justieren/Positionieren. The native point's verified
    // arrival is displayed separately above; the actual gate safety is unchanged.
    if (this._manualMaintenanceTransit && this._manualMaintenanceRecalibration) return 'garage_maintenance_transit';
    if (this._manualMaintenanceTransit && Date.now() - maintenanceCommandAt < OUTBOUND_EXITING_DISPLAY_MS) return 'garage_exiting';
    if (this._manualMaintenanceTransit) {
      if (!this.isDoorOpenStable()) return 'garage_opening';
      if (this._manualMaintenancePhase === 'exiting') return 'garage_exiting';
      if (this._manualMaintenancePhase === 'adjusting') return 'garage_adjusting';
      if (this._manualMaintenancePhase === 'positioning') return 'garage_positioning';
      return 'garage_maintenance_transit';
    }
    if (!this.enabled()) return nativeStatus;

    // A verified outdoor/maintenance MOWING start or resume is NOT a garage
    // departure. Show Mäht immediately once the native command was accepted,
    // even if the mower still publishes the old idle/paused status. The latch
    // is bounded and is always superseded by a new pause, native error, real
    // return or docked state. Physical status/interlocks continue using native
    // evidence, not this display-only acknowledgement.
    if (this._outsideMowingTileUntil && Date.now() < this._outsideMowingTileUntil
        && !this._outbound && !this._manualMaintenanceTransit && !this._manualMaintenanceReached
        && this._homeState === 'away' && this._missionOutside && !this._userPauseActive
        && !this.isDockedHomeStatus()
        && !['error', 'returning', 'docked', 'charging', 'charging_completed'].includes(nativeStatus)) {
      const observedAt = Number(this.device?._observedMowerStatusAt || 0);
      if (!(['paused', 'standby', 'idle'].includes(nativeStatus)
          && observedAt >= this._outsideMowingTileAcceptedAt + 2500)) return 'mowing';
    }

    // The physical departure state machine applies ONLY to a genuine start
    // FROM THE GARAGE (mowing/spot/vendor-app): Ausfahrt -> Justieren, then either a
    // physically confirmed Safety-Line crossing or four clean native MOWING
    // observations may release Mäht; otherwise the timer advances to Positionieren.
    const outboundPhase = this._outbound?.requiresMowingStable ? this._outboundDeparturePhase() : null;
    if (outboundPhase === 'exiting') return 'garage_exiting';
    // A single vendor MOWING frame cannot skip Justieren in a real GARAGE
    // departure: the 2026-10-12 field log showed the tile leaving Justieren
    // after only four seconds, ahead of the physical departure proof. Continue
    // the same phase clock until the existing four native samples OR the
    // independently confirmed A-B crossing validates the mowing milestone.
    // This changes display only. The physical door-close guards are untouched.
    if (outboundPhase === 'adjusting') return 'garage_adjusting';
    if (outboundPhase === 'positioning') return 'garage_positioning';
    if (outboundPhase === 'mowing') return 'mowing';

    if (this._outbound?.requiresMowingStable && !this._outbound?.originalCommandSentAt) return 'garage_start_pending';
    if (this._startConfirmationFailed) return nativeStatus || (this.isDockedHomeStatus() ? 'garage_home' : 'idle');
    if (this._startConfirmationPending && !['mowing', 'leaving', 'remote_control', 'mapping'].includes(nativeStatus)) {
      // A start command can remain reported as charging/docked for a while after
      // the physical gate has opened. Keep the user-facing phase progression
      // deterministic instead of showing only "Ausfahrt" until timeout.
      const elapsed = this._startDoorReleasedAt ? Date.now() - this._startDoorReleasedAt : 0;
      if (elapsed < OUTBOUND_EXITING_DISPLAY_MS) return 'garage_exiting';
      if (elapsed < OUTBOUND_EXITING_DISPLAY_MS + MIN_ADJUSTING_MS) return 'garage_adjusting';
      return 'garage_positioning';
    }
    if (!this._outbound && this._homeState !== 'adjusting'
        && this._resumeGuardUntil && Date.now() < this._resumeGuardUntil
        && ['paused', 'mowing'].includes(nativeStatus)) {
      // Pause/Resume must not look like a new garage start and must not jump to
      // "Mäht" until native resume really confirms mowing.
      if (nativeStatus === 'paused') return 'paused';
      return 'mowing';
    }
    const door = this.doorState();
    if (door === 'opening') return 'garage_opening';
    if (door === 'closing') return 'garage_closing';
    // Original-App/MQTT starts are paused before the gate is released. Once the
    // gate is open but before startRequested() resumes the accepted task, keep
    // the mower visibly paused and, crucially, do not advance the outbound
    // phase clock. Ausfahrt starts only with the actual task release.
    if (this._externalStartIntentHandling && this._outbound && !this._outbound.released && door === 'open') return 'paused';
    // A new garage start is already active before the native mower command is
    // released. During this handshake the cloud can still report charging from
    // the previous docked state. Never expose that stale value after the gate is
    // open: the deterministic garage phase is Ausfahrt until adjusting starts.
    if (this._outbound && !this._outbound.released && !this._outbound.adjustingSince && door === 'open') return 'garage_start_pending';

    // Do not let a stale Home flag override a real outdoor/mission status. Home
    // is a derived garage display state and may only win when the mower is truly
    // docked/charging and no outdoor cycle is active.
    if (this.isDockedHomeStatus() && !this._outbound && !this._missionOutside && !this._safeReturnInProgress) return 'garage_home';
    if (nativeStatus === 'remote_control') return 'garage_app_control';
    if (nativeStatus === 'mowing' && !this._outbound && this._missionOutside) return 'mowing';
    if (nativeStatus === 'paused' && this._missionOutside) return 'paused';
    if (nativeStatus === 'returning') return 'returning';

    const home = this._homeState || 'unknown';
    if (home === 'home' && this.isDockedHomeStatus() && !this._outbound && !this._missionOutside) return 'garage_home';
    if (home === 'adjusting') {
      const out = this._outbound;
      const now = Date.now();
      if (nativeStatus === 'remote_control') return 'garage_app_control';
      const releasedAt = Number(out?.originalCommandSentAt || this._startDoorReleasedAt || 0);
      const elapsed = releasedAt ? Math.max(0, now - releasedAt) : 0;
      // Deterministic field contract, anchored to the instant the real command
      // was accepted/sent -- never to a position packet or a later poll:
      //   0..5 s       Ausfahrt
      //   5..50 s      Justieren
      //   >=50 s       Positionieren until physical/independent confirmation.
      // This makes the UI fluid even when map/MQTT positions arrive unevenly.
      if (out && elapsed < OUTBOUND_EXITING_DISPLAY_MS) return 'garage_exiting';

      // Compatibility fallback for restored/incomplete runtime state follows
      // the same evidence contract as the live outbound state machine: the first
      // 5 s remain fixed as Ausfahrt; afterwards either a physically confirmed
      // garage->lawn safety-line crossing or four consecutive clean native
      // MOWING observations may end Justieren/Positionieren. A status transition
      // to Mowing is not, by itself, permission to close the garage door.
      if (out && (out.departureLineConfirmed || out.stableMowingConfirmed)) return 'mowing';
      if (out && elapsed < OUTBOUND_EXITING_DISPLAY_MS + MIN_ADJUSTING_MS) return 'garage_adjusting';
      // Positionieren intentionally has no timeout. It remains until one of the
      // two independent departure proofs above arrives.
      return 'garage_positioning';
    }
    return nativeStatus;
  }

  async refreshTileStatus(reason = '') {
    if (!this.device.hasCapability('mower_status')) return;
    const currentStatus = this.device.getCapabilityValue('mower_status');
    const nativeStatus = this.device._nativeMowerStatus || currentStatus || 'idle';
    const requestedDisplayStatus = this.getTileStatus(nativeStatus);
    // mower_status is a strict Homey enum. Internal/temporary states such as
    // "unknown" must never reach setCapabilityValue because that creates an
    // error storm and can also corrupt the status-based return interpretation.
    const validDisplayStatuses = new Set([
      'idle', 'mowing', 'standby', 'paused', 'error', 'returning', 'charging',
      'mapping', 'docked', 'updating', 'remote_control', 'garage_home',
      'garage_start_pending', 'garage_exiting', 'garage_adjusting', 'garage_opening', 'garage_closing',
      'garage_maintenance_transit', 'garage_maintenance_reached',
      'garage_zone_removing', 'garage_zone_restoring',
      'garage_free_drive', 'garage_positioning', 'garage_app_control',
    ]);
    const displayStatus = validDisplayStatuses.has(requestedDisplayStatus)
      ? requestedDisplayStatus
      : (validDisplayStatuses.has(currentStatus)
        ? currentStatus
        : (validDisplayStatuses.has(nativeStatus) ? nativeStatus : 'idle'));
    if (displayStatus !== requestedDisplayStatus) {
      this.log('invalid tile status suppressed', requestedDisplayStatus, 'retained=', displayStatus, reason || '');
    }
    await this._setCap('mower_status', displayStatus);
    if (reason) this.log('tile status', displayStatus, reason);
  }

  async _bootstrapInitialGarageState() {
    if (!this.device.getSetting('garage_mode_enabled')) return;

    // Fresh installs have null/unknown garage capabilities before the first
    // Flow writes a value. If the mower is already docked/charging, use that as
    // a safe baseline: home + door closed. With sensor mode enabled, show the
    // sensor tile immediately as online/100% until a Flow reports otherwise.
    if (this.isDockedHomeStatus()) {
      this._homeState = 'home';
      // Charging alone cannot reconstruct the physical gate end position in a
      // restored manual rescue. Keep it UNKNOWN until a real sensor/operator check.
      if (!this._manualRecoveryActive && !this._manualGateStopped) {
        await this._ensureCapValue('garage_door_status', 'closed');
        if (this.doorState() === 'unknown') await this._setCap('garage_door_status', 'closed');
      }
      await this.refreshTileStatus('initial dock/home');
    }
    if (this.sensorEnabled()) {
      await this._ensureCapValue('garage_sensor_available_status', 'online');
      if ((this.device.getCapabilityValue('garage_sensor_available_status') || 'unknown') === 'unknown') {
        await this._setCap('garage_sensor_available_status', 'online');
      }
      await this._ensureCapValue('garage_sensor_battery', 100);
    }
    this._initialBaselineDone = true;
  }

  async init() {
    await this._loadReturnStartupLearning();
    const savedStartAbortUntil = Number(await safeGetStoreValue(this.device, 'garage_external_start_abort_until')) || 0;
    this._externalStartAbortUntil = savedStartAbortUntil > Date.now() ? savedStartAbortUntil : 0;
    this._externalStartRedockHoldUntil = 0;
    if (this._externalStartAbortUntil) this.log('EXTERNAL START: recent aborted attempt restored after app restart',
      `remainingMs=${this._externalStartAbortUntil-Date.now()}`);
    // A deliberate manual takeover must survive a Homey/app restart. This is
    // independent of the sticky emergency, which is never silently cleared.
    this.paused = !!(await safeGetStoreValue(this.device, 'garage_operator_paused'));
    this._manualRecoveryActive = !!(await safeGetStoreValue(this.device, 'garage_manual_recovery_active'));
    this._manualRecoveryOperatorFree = this._manualRecoveryActive && !!(await safeGetStoreValue(this.device, 'garage_manual_operator_free'));
    // Older installations may have a persisted emergency but AUTO=ON.
    // Always restore MANUAL/OFF on startup; rearming remains explicit.
    if (this._manualRecoveryActive && !this.paused) {
      this.paused = true;
      await Promise.resolve(this.device?.setStoreValue?.('garage_operator_paused', true))
        .catch((error) => this.error('emergency auto-pause persistence', error?.message || String(error)));
    }
    this._manualRecoveryPhase = this._manualRecoveryActive ? 'manual_hold' : null;
    this._manualReturnWatch = null;
    this._manualRecoveryOutsideRearmLast = null;
    this._manualOperatorPosition = 'unknown';
    this._manualReturnWatchBusy = false;
    this._manualReturnAttempt = Number(await safeGetStoreValue(this.device, 'garage_manual_return_attempts')) || 0;
    this._manualReturnDispatchUncertainUntil = Math.max(0, Number(await safeGetStoreValue(this.device, 'garage_manual_return_dispatch_after')) || 0);
    this._manualReturnFailureReason = String(await safeGetStoreValue(this.device, 'garage_manual_return_failure') || '');
    // This is only a historical breadcrumb. It NEVER authorizes a gate or mower
    // command without fresh position, stillness and a new visual OPEN attestation.
    const storedArrival = await safeGetStoreValue(this.device, 'garage_manual_verified_arrival');
    this._manualRecoveryStoredArrival = this._manualRecoveryActive && this._validManualArrivalRecord(storedArrival)
      ? storedArrival : null;
    if (this._manualRecoveryStoredArrival) this._manualRecoveryPhase = 'revalidate_point';
    this._manualRecoveryMowerCommandBusy = false;
    this._manualRecoveryGateCommandBusy = false;
    const previousReturnPending = !!(await safeGetStoreValue(this.device, 'garage_manual_return_pending'));
    if (previousReturnPending && this._manualRecoveryActive) {
      this._manualRecoveryPhase = 'revalidate_point';
      this.log('MANUAL RECOVERY reboot during DOCK: no automatic replay; fresh verification required');
    }
    if (previousReturnPending) await Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_pending', false)).catch(() => {});
    this._manualRecoveryOpenConfirmedAt = 0; // NEVER persisted; explicit visual reconfirmation after restart
    this._manualRecoveryGatePulseAt = 0;
    this._manualRecoveryGateClosedAt = 0; // physical sight checks are never persisted across reboot
    this._manualDockOperatorAt = 0;
    this._manualGateStopped = this._manualRecoveryActive
      || !!(await safeGetStoreValue(this.device, 'garage_manual_gate_stopped'));
    await this.syncGarageIndicatorCapabilities();
    // Old persisted time-estimates are NOT a safe physical gate state after
    // restart. The rescue always needs a new explicit visual OPEN confirmation.
    if (this._manualRecoveryActive) await this._setCap('garage_door_status', 'unknown');
    await this._ensureCapValue('garage_door_status', 'unknown');
    if (this.sensorEnabled()) {
      await this._ensureCapValue('garage_sensor_available_status', 'online');
    } else {
      await this._ensureCapValue('garage_sensor_available_status', 'unknown');
    }
    await this._ensureCapValue('garage_sensor_battery', 100);
    await this._ensureCapValue('garage_safety_status', 'ok');
    await this._restorePersistentSensorState();
    await this._bootstrapInitialGarageState();

    await this.refreshOverlay();
    await this.syncMarkerButtons();
    await this.updateMarkerDiagnosis();
    this._startSensorWatchdog();
    if (this._manualRecoveryActive) {
      // A previous manual emergency remains an emergency after a reboot,
      // regardless of marker completeness or a restored charging capability.
      await this._setSafetyStatus('emergency', 'manual_recovery_boot_hold');
    } else if (await this.garageSafetyReady()) {
      await this.clearSafety('markers_complete');
      this.log('garage markers complete: close guard may evaluate normally');
    } else {
      // Do not spam warnings on app start before Homey has finished restoring
      // dynamic marker buttons/settings. The close guard will warn if an actual
      // automatic close is attempted without complete markers.
      this.log('garage markers incomplete at init: automatic close remains disabled');
    }
  }

  async syncGarageIndicatorCapabilities() {
    // Keep the optional garage UI invisible when garage mode is disabled.
    // Sensor health is only useful when the optional door sensor mode is active.
    const garageOn = !!this.device.getSetting('garage_mode_enabled');
    const sensorOn = garageOn && this.sensorEnabled();
    const garageCaps = ['garage_door_status', 'garage_safety_status'];
    const sensorCaps = ['garage_sensor_available_status', 'garage_sensor_battery'];
    const hiddenCaps = ['garage_home_status', 'garage_sensor_contact_status', 'garage_sensor_mode_status'];

    const ensure = async (cap, shouldExist) => {
      try {
        if (shouldExist && !this.device.hasCapability(cap)) await this.device.addCapability(cap);
        if (!shouldExist && this.device.hasCapability(cap)) await this.device.removeCapability(cap);
      } catch (e) {
        this.error('sync capability', cap, e.message);
      }
    };

    for (const cap of garageCaps) await ensure(cap, garageOn);
    for (const cap of sensorCaps) await ensure(cap, sensorOn);
    for (const cap of hiddenCaps) await ensure(cap, false);

    if (garageOn) {
      const canAssumeClosed = !this._manualRecoveryActive && !this._manualGateStopped && this.isDockedHomeStatus();
      await this._ensureCapValue('garage_door_status', canAssumeClosed ? 'closed' : 'unknown');
      if (canAssumeClosed && this.doorState() === 'unknown') await this._setCap('garage_door_status', 'closed');
      await this._ensureCapValue('garage_safety_status', 'ok');
    }
    if (sensorOn) {
      await this._ensureCapValue('garage_sensor_available_status', 'online');
      if ((this.device.getCapabilityValue('garage_sensor_available_status') || 'unknown') === 'unknown') await this._setCap('garage_sensor_available_status', 'online');
      await this._ensureCapValue('garage_sensor_battery', 100);
    }
    await this.refreshTileStatus('garage ui sync');
  }

  async syncGarageStatusCapability() {
    await this.syncGarageIndicatorCapabilities();
  }

  async syncSensorModeCapability() {
    await this.syncGarageIndicatorCapabilities();
  }


  async markerDiagnosisText() {
    const danger = await this.markers.dangerCenter().catch(() => null);
    const a = await this.markers.lineA().catch(() => null);
    const b = await this.markers.lineB().catch(() => null);
    const linePlausible = !!(a && b && !(a.x === b.x && a.y === b.y));
    const ready = !!(danger && a && b && linePlausible && this.markers.dangerRadius() > 0);
    const t = (de, en) => this._text(de, en);
    const yesNo = (ok, yesDe = 'ja', yesEn = 'yes', noDe = 'nein', noEn = 'no') =>
      ok ? t(yesDe, yesEn) : t(noDe, noEn);
    const parts = [
      `${t('Gefahrenbereich', 'Danger area')}: ${yesNo(!!danger, 'gesetzt', 'set', 'fehlt', 'missing')}`,
      `${t('Sicherheitslinie A', 'Safety line A')}: ${yesNo(!!a, 'gesetzt', 'set', 'fehlt', 'missing')}`,
      `${t('Sicherheitslinie B', 'Safety line B')}: ${yesNo(!!b, 'gesetzt', 'set', 'fehlt', 'missing')}`,
      `${t('Linie plausibel', 'Line plausible')}: ${yesNo(linePlausible)}`,
      `${t('Radius', 'Radius')}: ${this.markers.dangerRadius()} mm`,
      `${t('Gefahren-Hysterese', 'Danger hysteresis')}: ${this.markers.dangerHysteresis()} mm`,
      `${t('Linien-Hysterese', 'Line hysteresis')}: ${this.markers.lineHysteresis()} mm`,
      `${t('A/B-Karenz', 'A/B margin')}: ${this.markers.lineSegmentMargin()} mm`,
      `${t('Schließfreigabe', 'Close permission')}: ${yesNo(ready, 'möglich', 'available', 'gesperrt', 'blocked')}`,
    ];
    return parts.join(' | ');
  }

  async updateMarkerDiagnosis() {
    try {
      const text = await this.markerDiagnosisText();
      // This diagnostic lives in Repair since 1.2.4; do not write a removed
      // Advanced Settings key (which can fail or retrigger onSettings).
      if (typeof this.device.setStoreValue === 'function') {
        await this.device.setStoreValue('garage_marker_diagnosis_v2',text).catch(()=>{});
      }
      this.log('marker diagnosis', text);
    } catch (e) {
      this.error('marker diagnosis', e.message);
    }
  }

  async onSettings(newSettings = {}, changedKeys = []) {
    // Keep the original app settings unchanged. Garage mode only guards motion;
    // it must not overwrite Dreame/Mova battery auto-resume settings.
    if (changedKeys.includes('garage_mode_enabled') || changedKeys.includes('garage_sensor_enabled')) {
      if (!newSettings.garage_mode_enabled) {
        this.paused = false;
        await Promise.resolve(this.device?.setStoreValue?.('garage_operator_paused', false)).catch(() => {});
        clearTimeout(this._closeTimer);
        clearTimeout(this._stableOpenTimer);
        clearTimeout(this._doorFinalTimer);
        if (this._maintenanceWatch) clearInterval(this._maintenanceWatch);
        this._maintenanceWatch = null;
        this._stopSensorWatchdog();
        this._outbound = null;
        this._returnGuardActive = false;
        this._safeReturnInProgress = false;
        this._externalReturnHandling = false;
        this._cancelSuspectedPausedReturn();
        this._pendingDirectDockFn = null;
        this._pendingDirectReturnToken = 0;
        this._pendingDirectReturnSource = null;
        this._homeState = 'unknown';
        this._closeScheduled = false;
        this._closeCompleted = false;
        // status() evaluates the manual-maintenance journey flags BEFORE the
        // enabled() check so an active journey survives a pause. When garage
        // mode itself is switched off mid-journey these flags must be cleared,
        // otherwise the tile sticks at garage_maintenance_transit/_reached
        // until the next confirmed dock.
        this._maintenanceRequestedAt = 0;
        this._maintenanceStartPos = null;
        this._maintenanceStableHits = 0;
        this._maintenanceReachedCallback = null;
        this._maintenanceTimeoutCallback = null;
        this._manualMaintenanceCalibration = false;
        this._manualMaintenanceRecalibration = false;
        this._manualMaintenanceTransit = false;
        this._manualMaintenanceReached = false;
        this._manualMaintenanceLastPos = null;
        this._manualMaintenanceStableSince = 0;
        this._manualMaintenancePhase = 'idle';
        this._manualMaintenancePhaseStartedAt = 0;
        this._manualMaintenancePhasePos = null;
        this._manualMaintenanceMovementSeen = false;
      }
      await this.syncGarageIndicatorCapabilities();
      if (newSettings.garage_sensor_enabled) {
        this._touchSensorSignal('sensor mode enabled baseline');
        this._startSensorWatchdog();
      } else {
        this._stopSensorWatchdog();
      }
      await this._bootstrapInitialGarageState();
      await this.refreshTileStatus('garage settings changed');
      await this.updateMarkerDiagnosis();
    }
    if (changedKeys.includes('garage_reset_markers') && newSettings.garage_reset_markers) {
      await this.resetMarkers();

      // Homey persists the just-saved checkbox value after onSettings().
      // Reset it asynchronously so the settings UI sees the final value again.
      // Reset twice: Homey may persist the just-saved checkbox after onSettings() returns.
      // This keeps the UI from sticking at "Ja" after Speichern.
      const resetToggle = () => this.device.setSettings({ garage_reset_markers: false })
        .catch((e) => this.error('reset marker toggle', e.message));
      this.homey.setTimeout(resetToggle, 250);
      this.homey.setTimeout(resetToggle, 1500);
      this.homey.setTimeout(resetToggle, 4000);
    }
  }

  async _ensureCapValue(cap, val) {
    if (this.device.hasCapability(cap) && this.device.getCapabilityValue(cap) === null) {
      await this.device.setCapabilityValue(cap, val).catch(() => {});
    }
  }

  async _setCap(cap, val) {
    if (!this.device.hasCapability(cap)) return;
    if (this.device.getCapabilityValue(cap) === val) return;
    await this.device.setCapabilityValue(cap, val).catch((e) => this.error(`set ${cap}`, e.message));
  }


  async _setHomeState(val) {
    this._homeState = val || 'unknown';
    // Do not dynamically remove capabilities here. Homey mobile can keep stale
    // command tiles alive and then reports "Invalid Capability". The visible
    // status is derived through mower_status only.
    await this.refreshTileStatus(`home=${this._homeState}`);
  }

  async _enterDockedIdle(reason = 'docked_idle') {
    this._normalMaintenanceDockWatch?.stop(reason);
    if (this._emergencyHoldActive()) {
      this.log('EMERGENCY docked-idle reset held until recovery finishes', reason);
      return;
    }
    clearTimeout(this._returnRecoveryHold?.timer);
    this._returnRecoveryHold = null;
    this._returnRecoveryRequest = null;
    // Docked/home is the safe-space baseline. Only confirmed native home/docked
    // status may activate this override. Until that moment all normal danger-area
    // and moving-gate emergency rules remain active.
    this._homeState = 'home';
    this._outbound = null;
    this._missionOutside = false;
    this._safeReturnInProgress = false;
    this._returnGuardActive = false;
    this._externalReturnHandling = false;
    clearInterval(this._maintenanceWatch);
    this._maintenanceWatch = null;
    this._maintenanceRequestedAt = 0;
    this._maintenanceStartPos = null;
    this._maintenanceStableHits = 0;
    this._manualMaintenanceCalibration = false;
    this._manualMaintenanceRecalibration = false;
    this._manualMaintenanceTransit = false;
    this._manualMaintenanceReached = false;
    // Clearing the flags without the phase left "transit" behind. requestClose()
    // then rejected a genuinely docked mower as maintenance still in progress.
    this._manualMaintenancePhase = 'idle';
    this._manualMaintenancePhaseStartedAt = 0;
    this._manualMaintenancePhasePos = null;
    this._manualMaintenanceMovementSeen = false;
    this._manualMaintenanceLastPos = null;
    this._manualMaintenanceStableSince = 0;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._lockedReturnMaintenancePoint = null;
    if (this._suspectedPausedReturnTimer) clearTimeout(this._suspectedPausedReturnTimer);
    this._suspectedPausedReturnTimer = null;
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._closeAfterExitRequested = false;
    this._emergencyHoldUntil = 0;
    this._emergencyReverseAt = 0;
    clearTimeout(this._emergencyRecoveryWatchdog);
    this._emergencyRecoveryWatchdog = null;
    this._emergencyGateContext = null;
    this._dangerReleasedAfterExit = false;
    this._setLineState(LINE_STATES.IDLE, reason);
    this._setReturnContext(RETURN_STATES.IDLE, reason);
    this._lastDangerInside = false;
    this._lastLineSide = null;
    this._lastLineRawSide = null;
    this._lastHomeAt = Date.now();
    this._homeCycleLocked = true;
    this._homeCycleLockedAt = this._lastHomeAt;
    this.lastRequestedAction = null;
    if (this.markers) this.markers.resetRuntime();
    await this.clearSafety(reason).catch(() => {});
    this.log('Safe Space: Zuhause/Gedockt – Gefahrenbereich ignoriert');
    await this.refreshTileStatus(reason).catch(() => {});
  }

  async syncMarkerButtons() {
    if (!this.device.getSetting('garage_mode_enabled')) return;
    // Only expose setup buttons for markers that are still missing. The capability
    // listeners are registered unconditionally in device.js, so capabilities can
    // safely be re-added after a marker reset without losing their handler.
    const markerCaps = [
      ['cmd_garage_save_danger_center', 'danger'],
      ['cmd_garage_save_safety_line_a', 'line_a'],
      ['cmd_garage_save_safety_line_b', 'line_b'],
    ];
    for (const [cap, kind] of markerCaps) {
      const shouldExist = !(await this.markerAlreadySaved(kind));
      await this._syncMarkerButton(cap, shouldExist);
    }
  }

  async _syncMarkerButton(cap, shouldExist) {
    if (!this.device.getSetting('garage_mode_enabled')) return;
    try {
      if (shouldExist) {
        if (!this.device.hasCapability(cap)) await this.device.addCapability(cap);
        if (this.device.hasCapability(cap)) await this.device.setCapabilityValue(cap, false).catch(() => {});
      } else if (this.device.hasCapability(cap)) {
        // Reset the momentary value first, then remove the setup-only capability.
        // This keeps the Homey UI from retaining a pressed state while preserving
        // the unconditional listener for a later reset/re-add cycle.
        await this.device.setCapabilityValue(cap, false).catch(() => {});
        await this.device.removeCapability(cap);
      }
    } catch (e) {
      this.error('marker button sync', cap, e.message);
    }
  }

  async _hideSavedMarkerButton(kind) {
    const cap = { danger: 'cmd_garage_save_danger_center', line_a: 'cmd_garage_save_safety_line_a', line_b: 'cmd_garage_save_safety_line_b' }[kind];
    if (cap) await this._syncMarkerButton(cap, false);
  }

  async markerAlreadySaved(kind) {
    if (kind === 'danger') return !!(await this.markers.dangerCenter());
    if (kind === 'line_a') return !!(await this.markers.lineA());
    if (kind === 'line_b') return !!(await this.markers.lineB());
    return false;
  }

  async resetMarkers() {
    await this.device.setStoreValue('garage_danger_center', null);
    await this.device.setStoreValue('garage_line_a', null);
    await this.device.setStoreValue('garage_line_b', null);
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._lastLineSide = null;
    this._lastLineRawSide = null;
    this._closeAfterExitRequested = false;
    this._dangerExitFallbackStarted = false;
    this._exitPauseForCloseActive = false;
    this._setLineState(LINE_STATES.IDLE, 'markers_reset');
    this._garageLineSide = null;
    this._lawnLineSide = null;
    this._returnDecision = null;
    this._lockedReturnMaintenancePoint = null;
    this._awaitingLineDoorOpen = false;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._suspectedPausedReturnTimer = null;
    if (this.markers) this.markers.resetRuntime();
    await this.refreshOverlay();
    await this.syncMarkerButtons();
    await this.updateMarkerDiagnosis();
    await this.markerSetupWarning('markers_reset_close_disabled');
    this.log('markers reset; automatic close disabled until all markers are set again');
  }

  async saveMarker(kind) {
    // Always capture marker coordinates from a fresh native position request.
    // The normal map position is deliberately buffered and is therefore not
    // suitable for saving two distinct setup points.
    const fresh = typeof this.device._getFreshGarageMarkerPosition === 'function'
      ? await this.device._getFreshGarageMarkerPosition()
      : null;
    const p = fresh || this.pos();
    if (!p) throw new Error(this._text('Keine aktuelle Live-Position verfügbar. Mäher kurz bewegen oder Karte aktualisieren.', 'No current live position available. Move the mower briefly or refresh the map.'));
    const value = { x: Math.round(p.x), y: Math.round(p.y), ts: Date.now(), source: 'marker_capture' };

    // RC133: Never capture the charger position as a danger marker merely
    // because the mower is docked. The danger marker is an independent point.
    // Users can always place it deliberately in the map editor, which stores
    // source=map_editor and is therefore treated as authoritative.
    if (kind === 'danger') {
      const dockRaw = this.device?._cachedMapData?.chargerPos || this.device?._dockPos || null;
      const dock = dockRaw && Number.isFinite(Number(dockRaw.x ?? dockRaw[0])) && Number.isFinite(Number(dockRaw.y ?? dockRaw[1]))
        ? { x: Number(dockRaw.x ?? dockRaw[0]), y: Number(dockRaw.y ?? dockRaw[1]) }
        : null;
      if (dock) {
        const dockDistance = Math.hypot(value.x - dock.x, value.y - dock.y);
        if (Number.isFinite(dockDistance) && dockDistance < 350) {
          throw new Error(this._text(
            'Der Mäher steht noch an der Ladestation. Bitte zum gewünschten Gefahrenpunkt fahren oder den Punkt im Karteneditor setzen.',
            'The mower is still at the charging station. Move it to the intended danger point or set the point in the map editor.'
          ));
        }
      }
    }

    if (kind === 'line_b') {
      const a = await this.markers.lineA();
      if (!a) throw new Error(this._text('Bitte zuerst Punkt A speichern.', 'Please save point A first.'));
      const distance = this._distance(a, value);
      if (distance != null && distance < 250) {
        throw new Error(this._text('Punkt B liegt noch zu nah an Punkt A. Den Mäher weiter versetzen und B erneut speichern.', 'Point B is still too close to point A. Move the mower farther away and save B again.'));
      }
    }

    const storeKey = {
      danger: 'garage_danger_center',
      line_a: 'garage_line_a',
      line_b: 'garage_line_b',
    }[kind];
    if (!storeKey) throw new Error(`Unknown garage marker kind: ${kind}`);

    await this.device.setStoreValue(storeKey, value);

    // Read-after-write verification: UI, diagnosis, safety engine and map all
    // consume these store values. Do not report success until the exact point is
    // available from that shared source of truth.
    const persisted = await this.device.getStoreValue(storeKey);
    const px = Number(persisted?.x);
    const py = Number(persisted?.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)
      || Math.round(px) !== value.x || Math.round(py) !== value.y) {
      throw new Error(this._text('Marker konnte nicht dauerhaft gespeichert werden. Bitte erneut versuchen.', 'Marker could not be saved permanently. Please try again.'));
    }

    this.log('marker saved and verified', kind, value);
    if (this.markers) this.markers.resetRuntime();
    await this._hideSavedMarkerButton(kind);
    await this.refreshOverlay();
    await this.syncMarkerButtons();
    await this.updateMarkerDiagnosis();
    if (await this.garageSafetyReady()) {
      await this.clearSafety('markers_complete');
      this._timeline(this._text('Marker vollständig gespeichert und geprüft', 'Markers saved and validated'), 'markers:validated');
      await this.updatePositionGuards().catch(() => {});
    } else {
      await this.markerSetupWarning('markers_incomplete_close_disabled');
    }
  }

  async refreshOverlay() {
    // Keep a fresh, passive overlay snapshot for the map widget. This does not
    // change any mower or garage state; it only exposes stored marker geometry.
    this.device._garageOverlayData = await this.getGarageOverlayData().catch(() => null);
  }

  _doorDelaySeconds() {
    const raw = Number(this._garageOption('garage_open_stabilize_seconds') ?? DOOR_OPEN_DELAY_DEFAULT);
    if (!Number.isFinite(raw) || raw < 0) return DOOR_OPEN_DELAY_DEFAULT;
    return raw;
  }

  _doorOpenDurationSeconds() {
    const raw = Number(this._garageOption('garage_open_duration_seconds') ?? this._garageOption('garage_open_stabilize_seconds') ?? DOOR_OPEN_DELAY_DEFAULT);
    if (!Number.isFinite(raw) || raw < 0) return DOOR_OPEN_DELAY_DEFAULT;
    return raw;
  }

  _doorCloseDurationSeconds() {
    const raw = Number(this._garageOption('garage_close_duration_seconds') ?? this._garageOption('garage_open_stabilize_seconds') ?? DOOR_OPEN_DELAY_DEFAULT);
    if (!Number.isFinite(raw) || raw < 0) return DOOR_OPEN_DELAY_DEFAULT;
    return raw;
  }

  async setDoorState(state, opts = {}) {
    const revision = this._doorStateRevision = (this._doorStateRevision || 0) + 1;
    const stateCurrent = () => revision === this._doorStateRevision;
    if (this._manualGateStopped && opts.derived && state !== 'unknown') return;
    if (!['open', 'closed', 'opening', 'closing', 'unknown'].includes(state)) state = 'unknown';
    this._doorStateDerived = !!opts.derived;
    const previousDoorState = this.doorState();
    if ((state === 'opening' || state === 'closing') && state !== previousDoorState) this._gateMotionStartedAt = Date.now();
    if (state === 'open' || state === 'closed') this._gateMotionStartedAt = 0;
    // All genuinely observed contacts and every new CLOSED/moving command
    // supersede a previous time-only gate-open assumption.
    if ((this.sensorEnabled() && ['open', 'closed'].includes(state) && !opts.derived)
        || state === 'closing' || state === 'closed') {
      this._doorOpenTimedFallbackAt = 0;
    }
    if (this.sensorEnabled() && ['open', 'closed'].includes(state) && !opts.derived) {
      // RC110: every real contact edge is authoritative proof that the sensor is
      // alive. Reset all movement timeout/fallback state immediately, restore the
      // availability capability and clear stale safety warnings. This also closes
      // the race where Smart Life reports open/closed while a previously armed
      // timeout still emits an "unhealthy sensor" warning seconds later.
      this._touchSensorSignal(`door_${state}`);
      this._lastSensorContactAt = Date.now();
      this._lastSensorContactState = state;
      await this._persistRealSensorContact(state, this._lastSensorContactAt);
      await this._clearSensorMovementTimeout(`door_${state}`);
      if (state === 'open') {
        // Record the physical open edge immediately, before the configured
        // stabilisation delay changes the visible state from opening to open.
        this._lastGateOpenHandshakeAt = this._lastSensorContactAt;
      }
      clearTimeout(this._doorFinalTimer);
      this._doorFinalTimer = null;
      if ((this.device.getCapabilityValue('garage_sensor_available_status') || 'unknown') !== 'online') {
        await this._setCap('garage_sensor_available_status', 'online');
      }
      await this.clearSafety(`sensor_contact_${state}`).catch(() => {});
    }

    // This is the real external contact-sensor signal. It is intentionally only
    // open/closed/unknown. The visible garage door state may temporarily become
    // opening/closing, but that is derived by this module and never selected by
    // the sensor flow.
    // The real contact-sensor input is open/closed/unknown. It updates the
    // internal door model only; no separate contact dashboard tile is shown.

    if (!stateCurrent()) return;
    clearTimeout(this._stableOpenTimer);
    clearTimeout(this._doorFinalTimer);
    this._stableOpenTimer = null;
    this._doorFinalTimer = null;

    const delay = this._doorDelaySeconds();
    const applyFinal = async (finalState, reason) => {
      if (!stateCurrent()) return;
      if (finalState === 'closed') { this._closeScheduled = false; this._closeCompleted = true; clearTimeout(this._closeTimer); }
      if (finalState === 'open') { this._closeCompleted = false; }
      await this._setCap('garage_door_status', finalState);
        await this.refreshTileStatus('door final');
      if (!stateCurrent() || this._manualGateStopped) return;
      this.log('door state', finalState, reason || '');
      if (finalState === 'open') {
        // A stable real-contact open completes the same release proof consumed by
        // startRequested(). This timestamp is deliberately set for both real and
        // timer-backed finalisation so a late contact can resume the waiting start.
        this._lastDoorOpenReleaseAt = Date.now();
        this._trigger('garage_door_stable_open', 'stable_open');
        await this._releaseGateMotionInterlockAfterOpen().catch((e) => this.error('gate-motion release after open', e.message));
        if (this._outbound && this._outbound.requiresMowingStable && !this._outbound.released) {
          // During an intercepted Original-App start the mower is deliberately
          // PAUSED while the gate opens. Do not start Ausfahrt/Justieren clocks
          // merely because the door became open. startRequested() marks the
          // outbound release immediately before the original task is resumed.
          this.log('gate open: outbound phase clock waits for a sent mower command or verified departure');
        }
      }
    };

    // Flow input from a real contact sensor should report only the final contact
    // state (open/closed). The app keeps the transitional state visible until the
    // configured safety delay has elapsed. This prevents flows from instantly
    // marking the garage as safe while the door is still physically moving.
    if ((state === 'open' || state === 'closed') && !opts.immediate) {
      const movingState = state === 'open' ? 'opening' : 'closing';
      const current = this.doorState();
      if (current !== movingState && current !== state) {
        await this._setCap('garage_door_status', movingState);
        await this.refreshTileStatus('door moving');
        this.log('door derived moving state', movingState, 'target=', state);
      }
      if (delay > 0) {
        this._doorFinalTimer = setTimeout(() => {
          this._doorFinalTimer = null;
          applyFinal(state, `after_${delay}s`).catch((e) => this.error('door final state', e.message));
        }, delay * 1000);
      } else {
        await applyFinal(state, 'no_delay');
      }
      return;
    }

    if (state === 'closed') { this._closeScheduled = false; this._closeCompleted = true; clearTimeout(this._closeTimer); }
    if (state === 'open' || state === 'opening') { this._closeCompleted = false; }
    await this._setCap('garage_door_status', state);
    await this.refreshTileStatus('door action state');
    this.log('door state', state);
    if (state === 'open' || state === 'closed') {
    }
  }

  async setSensorAvailable(status) {
    if (!['online', 'offline', 'timeout', 'unknown'].includes(status)) status = 'unknown';
    const previous = this.device.getCapabilityValue('garage_sensor_available_status') || 'unknown';
    this._sensorAvailabilityUpdatedAt = Date.now();
    this._touchSensorSignal(`available_${status}`);
    await this._setCap('garage_sensor_available_status', status);
    this.log('sensor available', status);
    // This existing Flow used to be orphaned. Fire it only on a REAL reported
    // transition to offline, never on a movement-confirmation timeout.
    if (this.sensorEnabled() && status === 'offline' && previous !== 'offline') {
      this._trigger('garage_sensor_unavailable', 'sensor_reported_offline');
    }
    // RC2.1: offline/timeout does not permanently block the garage. It means
    // the next/active door movement uses the configured time fallback. Only an
    // actual timeout during a movement is logged as warning.
    if (this.sensorEnabled() && status === 'online') {
      await this.clearSafety('sensor_online');
    }
  }

  async setSensorBattery(pct) {
    pct = Math.max(0, Math.min(100, Number(pct) || 0));
    this._touchSensorSignal('battery');
    await this._setCap('garage_sensor_battery', pct);
    this.log('sensor battery', pct);

    const min = Number(this._garageOption('garage_sensor_min_battery') ?? 15);
    if (this.sensorEnabled() && pct <= min) {
      this._trigger('garage_sensor_battery_low', String(pct));
      await this.safetyWarning(`sensor_battery_low_${pct}_fallback_to_timer`);
    } else if (this.sensorEnabled()) {
      await this.clearSafety('sensor_battery_ok');
    }
  }

  sensorHealthy() {
    if (!this.sensorEnabled()) return true;
    const avail = this.device.getCapabilityValue('garage_sensor_available_status') || 'unknown';
    const batt = Number(this.device.getCapabilityValue('garage_sensor_battery') ?? 100);
    const min = Number(this._garageOption('garage_sensor_min_battery') ?? 15);
    if (batt <= min) return false;

    // A real open/closed contact report proves that the sensor works, even if a
    // previous door movement had fallen back to a timeout and left the availability
    // capability at "timeout". Treat recent real contacts as healthy and restore
    // the availability state to online. This prevents false "sensor unhealthy"
    // warnings although the contact is visibly reporting open/closed.
    // Do not classify a sensor as unhealthy merely because its availability
    // capability still contains an old offline/timeout value. A real contact
    // edge from the last 24 hours is enough to treat the sensor as available for
    // the next movement. If it is actually unreachable now, the movement-specific
    // 30 s confirmation watchdog will detect that and safely fall back to the
    // configured gate runtime. This avoids false "sensor unhealthy/offline"
    // warnings at the beginning of an otherwise correctly reported open/close.
    const currentSessionUnavailable = this._sensorAvailabilityUpdatedAt > 0
      && ['offline', 'timeout'].includes(avail);
    if (currentSessionUnavailable) return false;
    const recentContact = this._lastSensorContactAt && Date.now() - this._lastSensorContactAt < 24 * 60 * 60 * 1000;
    if (avail === 'online' || recentContact) return true;
    return false;
  }

  async _restoreSensorOnlineIfRecent(reason = 'recent_contact') {
    if (!this.sensorEnabled()) return;
    if (this.sensorHealthy() && (this.device.getCapabilityValue('garage_sensor_available_status') || 'unknown') !== 'online') {
      await this._setCap('garage_sensor_available_status', 'online');
      this.log('sensor available', 'online', reason);
    }
  }

  sensorUnhealthyReason() {
    if (!this.sensorEnabled()) return null;
    const batt = Number(this.device.getCapabilityValue('garage_sensor_battery') ?? 100);
    const min = Number(this._garageOption('garage_sensor_min_battery') ?? 15);
    if (batt <= min) return `sensor_battery_${batt}_lte_${min}`;
    if (this.sensorHealthy()) return null;
    const avail = this.device.getCapabilityValue('garage_sensor_available_status') || 'unknown';
    return `sensor_${avail}`;
  }

  positionKnown() {
    const p = this.pos();
    return !!p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
  }

  _setLineState(state, reason = '') {
    if (!Object.values(LINE_STATES).includes(state)) state = LINE_STATES.IDLE;
    if (this._lineState === state) return;
    this._lineState = state;
    this.log('line state', state, reason || '');
  }

  _setReturnContext(state, reason = '') {
    if (!Object.values(RETURN_STATES).includes(state)) state = RETURN_STATES.IDLE;
    if (state !== RETURN_STATES.MAINTENANCE) this._normalMaintenanceDockWatch?.stop(reason || 'return_context_changed');
    if (this._returnContext === state) return;
    this._returnContext = state;
    this.log('return context', state, reason || '');
  }

  _resetGarageCycle(reason = '') {
    this._normalMaintenanceDockWatch?.stop(reason || 'garage_cycle_reset');
    this._normalMaintenanceDockTerminalToken = null;
    clearInterval(this._maintenanceWatch);
    this._maintenanceWatch = null;
    this._maintenanceRequestedAt = 0;
    clearTimeout(this._lineCloseTimer);
    this._lineCloseTimer = null;
    this._returnGuardActive = false;
    this._externalReturnHandling = false;
    this._safeReturnInProgress = false;
    this._outbound = null;
    this._outboundHardLockUntil = 0;
    this._startDoorReleasedAt = 0;
    this._startCycleIgnoreReturnUntil = 0;
    this._emergencyHoldUntil = 0;
    clearTimeout(this._emergencyRecoveryWatchdog);
    this._emergencyRecoveryWatchdog = null;
    this._emergencyGateContext = null;
    this._pendingEmergencyMaintenanceReason = null;
    this._dangerReleasedAfterExit = false;
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._lastLineSide = null;
    this._lastLineRawSide = null;
    this._closeAfterExitRequested = false;
    this._garageLineSide = null;
    this._lawnLineSide = null;
    this._returnDecision = null;
    this._lockedReturnMaintenancePoint = null;
    this._awaitingLineDoorOpen = false;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._suspectedPausedReturnTimer = null;
    this._returnLineStopProof = null;
    this._returnMaintenanceStopProof = null;
    this._closeScheduled = false;
    this._setLineState(LINE_STATES.IDLE, reason || 'cycle_reset');
    this._setReturnContext(RETURN_STATES.IDLE, reason || 'cycle_reset');
  }

  _trigger(id, reason = '', extra = {}) {
    if (this._manualRecoveryActive && ['garage_open_requested','garage_close_requested'].includes(id)
        && !String(reason || '').startsWith('manual_recovery_supervised_')) {
      this.log('MANUAL RECOVERY suppressed automatic gate trigger', id, reason);
      return;
    }
    const payload = { reason: String(reason), ...extra };
    const important = [
      'garage_open_requested', 'garage_close_requested', 'garage_stop_requested', 'garage_safety_block', 'garage_emergency',
      'garage_maintenance_point_reached', 'garage_home_confirmed', 'garage_door_stable_open',
      'garage_danger_area_entered', 'garage_danger_area_left', 'garage_safety_line_lawn',
      'garage_safe_return_started', 'garage_safe_return_completed', 'garage_external_start_blocked',
      'garage_position_uncertain',
    ];
    if (important.includes(id) && (this._garageOption('garage_debug_verbose') || ['garage_emergency','garage_safety_block'].includes(id))) {
      const T = (de, en) => this._text(de, en);
      const names = {
        garage_open_requested: T('Flow: Garagentor öffnen angefordert', 'Flow: Request to open garage gate'),
        garage_stop_requested: T('Flow: Garagentor stoppen angefordert', 'Flow: Request to stop garage gate'),
        garage_close_requested: T('Flow: Garagentor schließen angefordert', 'Flow: Request to close garage gate'),
        garage_safety_block: T('Flow: Safety Block', 'Flow: Safety block'),
        garage_emergency: T('Flow: Emergency/Notfall', 'Flow: Emergency'),
        garage_maintenance_point_reached: T('Flow: Wartungspunkt erreicht', 'Flow: Maintenance point reached'),
        garage_home_confirmed: T('Flow: Zuhause bestätigt', 'Flow: Mower home confirmed'),
        garage_door_stable_open: T('Flow: Tor stabil offen', 'Flow: Gate stably open'),
        garage_danger_area_entered: T('Flow: Gefahrenbereich betreten', 'Flow: Entered danger area'),
        garage_danger_area_left: T('Flow: Gefahrenbereich verlassen', 'Flow: Left danger area'),
        garage_safety_line_lawn: T('Flow: Sicherheitslinie Richtung Garten', 'Flow: Safety line toward lawn'),
        garage_safe_return_started: T('Flow: sichere Rückkehr gestartet', 'Flow: Safe return started'),
        garage_safe_return_completed: T('Flow: sichere Rückkehr beendet', 'Flow: Safe return completed'),
        garage_external_start_blocked: T('Flow: externer Start blockiert', 'Flow: External start blocked'),
        garage_position_uncertain: T('Flow: Position unklar', 'Flow: Position uncertain'),
      };
      this._timeline(`${names[id] || `Flow: ${id}`} – ${this._humanReason(payload.reason)}`, `trigger:${id}:${payload.reason}`);
    }
    try {
      const dispatch = this.homey.flow.getDeviceTriggerCard(id).trigger(this.device, payload, {});
      // A successful Homey trigger is NOT confirmation of a physical gate
      // pulse or sensor movement. Record dispatch failures for field diagnosis.
      if (id === 'garage_open_requested' || id === 'garage_close_requested') {
        this.log('[garage-flow] trigger submitted (not motor proof)', id, payload.reason);
      }
      Promise.resolve(dispatch).catch((e) => {
        if (id === 'garage_open_requested' || id === 'garage_close_requested') {
          this.log('[garage-flow] trigger rejected', id, e?.message || String(e));
        }
      });
    } catch (e) {
      if (id === 'garage_open_requested' || id === 'garage_close_requested') {
        this.log('[garage-flow] trigger failed', id, e?.message || String(e));
      }
    }
    // Keep older, specialized Flow cards running unmodified. Also surface the
    // missing *noncritical* garage warnings via the central notice card when
    // its optional setting is on. Safety Block/Emergency already own their
    // mandatory notices, so do not mirror those here or recurse.
    if (['garage_sensor_unavailable', 'garage_position_uncertain', 'garage_external_start_blocked'].includes(id)) {
      const optionalMessages = {
        garage_sensor_unavailable: this._text(
          '⚠️ Garagentor-Sensor offline. Torlaufzeit-Ersatzbetrieb prüfen.',
          '⚠️ Garage door sensor offline. Check timed gate fallback.'),
        garage_position_uncertain: this._text(
          '⚠️ Mäherposition unklar: ', '⚠️ Mower position uncertain: ') + this._garageNoticeReason(reason),
        garage_external_start_blocked: this._text(
          '⚠️ Original-App-Auftrag von Garagensicherheit angehalten: ',
          '⚠️ Original-app command held by garage safety: ') + this._garageNoticeReason(reason),
      };
      this._garageNotice(id.replace(/^garage_/, ''), optionalMessages[id], reason || id, 120000);
    }
  }

  async _setSafetyStatus(status, reason) {
    const allowed = ['ok', 'warning', 'blocked', 'emergency'];
    const safeStatus = allowed.includes(status) ? status : 'blocked';
    // An incidental sensor/tile warning must not downgrade an active emergency.
    if ((this._emergencyGateContext || this._emergencyTransitionPromise)
        && (safeStatus === 'ok' || safeStatus === 'warning')) return;
    if (this._lastSafetyStatus === safeStatus && this._lastSafetyReason === reason) return;
    this._lastSafetyStatus = safeStatus;
    this._lastSafetyReason = reason;
    await this._setCap('garage_safety_status', safeStatus);
    this.log('safety status', safeStatus, reason || '');
  }

  async safetyWarning(reason) {
    // Warnings must never fire the user-facing Safety Block flow/banner.
    // Only a real block/emergency is allowed to trigger garage_safety_block.
    await this._setSafetyStatus('warning', reason);
    this._garageNotice('safety_warning', this._text(
      'ℹ️ Garagenwarnung: ', 'ℹ️ Garage warning: ') + this._garageNoticeReason(reason),
      reason || 'safety_warning', 120000);
  }

  async markerSetupWarning(reason) {
    // Missing markers during setup are not a hard safety fault: the mower may be
    // operated and the door may open, but automatic closing is disabled. Keep the
    // dashboard warning visible without spamming Safety-Block flows/timeline.
    await this._setSafetyStatus('warning', reason);
    const now = Date.now();
    if (!this._lastMarkerSetupWarningAt || now - this._lastMarkerSetupWarningAt > 60000) {
      this._lastMarkerSetupWarningAt = now;
      this._timeline(`${this._text('Einrichtungsmodus', 'Setup mode')}: ${this._humanReason(reason)}. ${this._text('Tor schließt nicht automatisch.', 'Gate will not close automatically.')}`, `setup:${reason}`);
    }
  }

  _confirmedMaintenanceTransitActive() {
    return this._returnContext === RETURN_STATES.MAINTENANCE
      && !!this._maintenanceWatch
      && Number(this._maintenanceRequestedAt || 0) > 0
      && Number(this._maintenanceDepartureConfirmedAt || 0) >= Number(this._maintenanceRequestedAt || 0)
      && !this._manualMaintenanceReached;
  }

  async returnOperationalHold(reason, message = '') {
    // A stationary closed gate, a mower waiting at A-B, a maintenance detour or
    // temporarily missing return proof is an expected fail-safe HOLD, not an
    // emergency. Keep it visible in diagnostics/timeline without firing the
    // user-facing Safety-Block flow. Emergency notification is reserved for a
    // moving gate while the mower is in the danger area.
    const r = String(reason || 'return_hold');
    this.log('return operational hold', r);
    await this.safetyWarning(`return_hold_${r}`);
    if (message) this._timeline(message, `return:hold:${r}`);
    // Once DOCK was accepted from a verified maintenance point, only its
    // observer may decide whether another DOCK is safe. A NEW safety hold must
    // still attempt one controlled stop: suppress only the generic RESTART loop,
    // not the safety stop itself.
    if (this._normalMaintenanceDockWatch) {
      const watch = this._normalMaintenanceDockWatch;
      await watch._fail('return_maintenance_dock_operational_hold');
      const terminal = { token: watch.token, reason: r, attempts: 3, terminal: true,
        request: this._returnRecoveryRequest, busy: false, stopped: false };
      this._returnRecoveryHold = terminal;
      if (!this._emergencyHoldActive() && !this._emergencyGateContext) {
        terminal.stopped = await this._stopReturnForRecovery(terminal);
      }
      return;
    }
    // A completed two-attempt maintenance return must never be restarted by
    // duplicated status/MQTT edges or the unrelated 3-attempt recovery owner.
    if (this._normalMaintenanceDockTerminalToken === this._commandToken) return;
    // An accepted 109 and its watcher are the sole navigation owner, even
    // BEFORE movement telemetry first arrives. Generic return recovery must
    // never send PAUSE/STOP or restart the return during that journey. True
    // danger-circle and moving-door interlocks remain independent above.
    if (this._maintenanceJourneyOwnsNavigation()) {
      this.log('return recovery deferred: native maintenance navigation owns route', r);
      return;
    }
    // 1.2.12: do not STOP/reset an already proven maintenance transit merely
    // because a duplicate return/current-position check cannot yet re-confirm
    // the stationary endpoint. The active watcher owns this route and will
    // either confirm arrival or invoke its own bounded failure path.
    if (r === 'maintenance_current_unconfirmed' && this._confirmedMaintenanceTransitActive()) {
      this.log('return hold deferred: confirmed maintenance transit still owns route');
      return;
    }
    const request = this._returnRecoveryRequest;
    if (!request || (!this._safeReturnInProgress && !this._returnGuardActive)
        || request.token !== this._commandToken || this._manualGateStopped
        || this._emergencyGateContext || this._emergencyHoldActive()) return;
    let hold = this._returnRecoveryHold;
    if (!hold || hold.token !== request.token) {
      hold = { token: request.token, request, attempts: 0, busy: false, timer: null, stopped: false };
      this._returnRecoveryHold = hold;
    }
    hold.reason = r;
    // Once the bounded recovery budget is exhausted, later MQTT/status edges
    // must NOT generate another PAUSE/STOP storm. A new explicit user return
    // creates a new token/hold; no automatic re-arming is permitted here.
    if (hold.attempts >= 3 || hold.terminal) {
      this._notifyReturnRecoveryExhausted(hold);
      return;
    }
    if (r === 'return_safety_line_stop_unconfirmed'

        || r === 'return_closed_gate_stop_unconfirmed'
        || r === 'return_closed_gate_pause_failed'
        || (this._returnLineWaitTerminalToken === request.token
          && ['return_gate_open_clearance_unconfirmed', 'pylon_lifecycle_return_fresh_clearance_unconfirmed'].includes(r))) {
      // The dedicated A-B owner has already performed bounded PAUSE and STOP.
      // A new timer or position packet MUST NOT start an identical command
      // storm. Keep the closed gate and the mower held pending manual review.
      clearTimeout(hold.timer);
      hold.timer = null;
      this.log('return terminal stationary hold latched: no automatic PAUSE/STOP retry', r);
      if (hold.terminalNoticeReason !== r) {
        hold.terminalNoticeReason = r;
        this._trigger('garage_position_uncertain', r);
      }
      // No safe retry remains for an unconfirmed safety-line stop. Hand over
      // automatically, but NEVER issue a drive/gate command in manual mode.
      this._notifyReturnRecoveryExhausted(hold);
      return;
    }
    // Native map changes are never guessed: if their MAPD confirmation failed,
    // hold the mower where it has already stopped and require a new verified
    // phase synchronization before any DOCK release. An automatic route retry
    // cannot fix a missing manufacturer-map commit and must not turn a direct
    // route into a surprising maintenance journey.
    const nativeLifecycleUnconfirmed = r.startsWith('pylon_lifecycle_return_');
    // A warning is not a physical hold. Stop the native return even when a
    // clearance check failed before the ordinary return branch sent PAUSE.
    if (!hold.busy) {
      hold.busy = true;
      try { hold.stopped = await this._stopReturnForRecovery(hold); }
      finally { hold.busy = false; }
      if (nativeLifecycleUnconfirmed) {
        this.log('native lifecycle unconfirmed: stationary fail-safe hold, no automatic route switch', r);
        // A map readback failure cannot be repaired by repeated navigation.
        // Freeze automation and expose the operator-supervised controls.
        this._notifyReturnRecoveryExhausted(hold);
        return;
      }
      this._scheduleReturnRecovery(hold);
    }
  }

  _returnRecoveryCurrent(hold) {
    return this._returnRecoveryHold === hold && hold.token === this._commandToken
      && this.enabled() && !this._manualGateStopped
      && !this._emergencyGateContext && !this._emergencyHoldActive();
  }

  async _stopReturnForRecovery(hold) {
    if (!this._returnRecoveryCurrent(hold)) return false;
    const at = Date.now();
    const pause = () => this.device._api.pause(this.device.getData().id);
    try {
      const accepted = typeof this.device._safeWrite === 'function'
        ? await this.device._safeWrite('garage_return_hold_pause', pause) : await pause();
      if (!this._returnRecoveryCurrent(hold) || accepted === false) return false;
      const stopped = await this._waitForNativePause(hold.token, at, 8000);
      if (stopped && this._returnRecoveryCurrent(hold)) {
        this.log('return hold stop confirmed', hold.reason);
        return true;
      }
    } catch (e) { this.error('return hold pause failed', e.message); }
    return false;
  }

  _notifyReturnRecoveryExhausted(hold) {
    if (!hold || hold.exhaustionNotified) return;
    hold.exhaustionNotified = true;
    hold.terminal = true;
    this.log('return recovery exhausted; gate release remains blocked', hold.reason);
    this._timeline(this._text('Rückkehr automatisch nicht möglich – Garagenautomatik wird pausiert. Manuelle Übernahme unter Aufsicht erforderlich.',
      'Automatic return could not be safely completed – garage automation is being paused. Supervised manual recovery required.'), 'return:recovery_exhausted');
    this._trigger('garage_position_uncertain', 'return_recovery_exhausted');
    // A terminal AUTO return previously left only a HOLD banner. The manual
    // recovery controls were never activated, trapping the user after failure.
    // _enterManualRecovery immediately latches _manualGateStopped and paused;
    // it does not issue any movement/gate command (only one PAUSE, if needed).
    Promise.resolve(this._enterManualRecovery('automatic_return_exhausted'))
      .catch(error => this.error('automatic return -> manual takeover failed', error?.message || String(error)));
  }

  _scheduleReturnRecovery(hold) {
    if (!this._returnRecoveryCurrent(hold) || hold.timer || hold.busy) return;
    if (hold.attempts >= 3 || hold.terminal) {
      this._notifyReturnRecoveryExhausted(hold);
      return;
    }
    hold.timer = setTimeout(() => {
      hold.timer = null;
      this._retryReturnRecovery(hold).catch(e => this.error('return recovery failed', e.message));
    }, 3000);
    hold.timer.unref?.();
  }

  async _retryReturnRecovery(hold) {
    if (!this._returnRecoveryCurrent(hold) || hold.busy) return false;
    hold.busy = true;
    hold.attempts += 1;
    try {
      // If the maintenance watcher has meanwhile obtained real movement proof,
      // that route remains the single owner. Do not pause it, clear it, or start
      // a competing return cycle.
      if (this._confirmedMaintenanceTransitActive()) {
        this.log('return recovery cancelled: confirmed maintenance transit owns route', hold.reason || '');
        this._returnRecoveryHold = null;
        return true;
      }
      // Reconfirm stopping each attempt. An original-app command may have
      // restarted movement while Homey was waiting for fresh telemetry.
      hold.stopped = await this._stopReturnForRecovery(hold);
      if (!hold.stopped || !this._returnRecoveryCurrent(hold)) return false;
      if (['opening', 'closing'].includes(this.doorState())) return false;
      const request = hold.request;
      clearInterval(this._maintenanceWatch);
      this._maintenanceWatch = null;
      this._pendingDirectDockFn = null;
      this._pendingDirectReturnToken = 0;
      this._pendingDirectReturnSource = null;
      this._awaitingLineDoorOpen = false;
      this._returnGuardActive = false;
      this._safeReturnInProgress = false;
      this._returnContext = RETURN_STATES.IDLE;
      this.log('return recovery retry', hold.attempts, hold.reason);
      // A successful native-zone STOP with frozen DIRECT decision is not a new
      // routing event. The former retry destroyed the line-side proof and sent
      // a stationary mower to P1 merely because opening was blocked by stale
      // cache. Keep the physical hold rather than silently changing owners.
      if (request.routeDecision?.mode === 'direct'
          && this._returnZoneTaskStoppedToken === hold.token) {
        this.log('[return-origin] retry kept in safe HOLD; no stale post-STOP reroute',
          `token=${hold.token}`,`reason=${hold.reason}`);
        this._notifyReturnRecoveryExhausted(hold);
        return false;
      }
      // Non-checkpoint recovery can still reconsider fresh geometry, with all
      // normal danger / A-B / moving-door interlocks in place.
      const accepted = await this.returnRequested('return_hold_spatial_recheck', request.dockFn, request.maintenanceFn);
      if (accepted && this._returnRecoveryCurrent(hold)) {
        this._returnRecoveryHold = null;
        return true;
      }
      return false;
    } finally {
      hold.busy = false;
      if (this._returnRecoveryCurrent(hold)) this._scheduleReturnRecovery(hold);
    }
  }

  async safetyBlock(reason) {
    // RC13 PR cleanup: During outbound/start/adjusting the mower may be under or
    // directly in front of the garage door. A hard Safety Block must never turn
    // this phase into RETURN/MAINTENANCE or indirectly request door close. Treat
    // all blocks during the outbound close lock as warnings only; the dedicated
    // close guard keeps the door open until the safety line confirmed
    // garage->lawn and the mower is stably mowing outside the danger area.
    if (this._outboundCloseProtected() || this._homeState === 'adjusting' || (this._outboundHardLockUntil && Date.now() < this._outboundHardLockUntil)) {
      this.log('safety block downgraded during outbound/adjusting', reason || 'blocked');
      await this.safetyWarning(`outbound_guard_suppressed_${reason || 'blocked'}`);
      return;
    }
    if (this._resumeGuardUntil && Date.now() < this._resumeGuardUntil) {
      this.log('safety block suppressed during pause/resume guard', reason || 'blocked');
      await this.safetyWarning(`resume_guard_suppressed_${reason || 'blocked'}`);
      return;
    }
    if (this._lastSafetyStatus === 'emergency' || this._emergencyGateContext || this._emergencyHoldActive()) {
      this.log('secondary Safety Block suppressed: emergency already owns notification', reason || 'blocked');
      return;
    }
    const now = Date.now();
    if (this._lastBlockReason === reason && now - (this._lastBlockAt || 0) < 10000) return;
    this._lastBlockReason = reason; this._lastBlockAt = now;
    await this._setSafetyStatus('blocked', reason);
    // Even genuine non-emergency blocks are notification-throttled globally.
    // Different downstream reasons from one fault must not create a burst of
    // seven Safety-Block flow events.
    if (now - Number(this._lastSafetyBlockNoticeAt || 0) >= 60000) {
      this._lastSafetyBlockNoticeAt = now;
      this._trigger('garage_safety_block', reason || 'blocked', { severity: 'block' });
      // Mandatory central notice alongside the unchanged legacy trigger.
      this._garageNotice('safety_block', this._text(
        '⛔ Garagen-Sicherheitssperre aktiv. Bitte Mäher und Tor prüfen. Grund: ',
        '⛔ Garage safety block active. Check mower and gate. Reason: ')
        + this._garageNoticeReason(reason || 'blocked'), reason || 'blocked', 60000);
    } else {
      this.log('Safety Block flow notification throttled', reason || 'blocked');
    }
  }

  async emergency(reason, action = '') {
    await this._setSafetyStatus('emergency', reason);
    this._trigger('garage_emergency', reason || 'emergency', { action: String(action || '') });
    this._garageNotice('emergency', this._text(
      '🚨 Mäher-Notfall: Garagenautomatik gesperrt. Mäher und Tor prüfen. Grund: ',
      '🚨 Mower emergency: garage automation locked. Check mower and gate. Reason: ')
      + this._garageNoticeReason(reason || 'emergency'), reason || 'emergency', 60000);
  }

  async clearSafety(reason) {
    if (this._manualGateStopped || this._emergencyGateContext || this._emergencyTransitionPromise) return;
    if (Number(this._externalStartAbortUntil || 0) > Date.now()
        && this._lastSafetyStatus === 'blocked'
        && /^external_start_/.test(String(this._lastSafetyReason || ''))
        && !this._strongDockCloseProof()) return;
    if (/^(sensor_|door_)/.test(String(reason)) && (this._returnGuardActive || this._emergencyGateContext)
        && ['blocked', 'emergency'].includes(this._lastSafetyStatus)) return;
    await this._setSafetyStatus('ok', reason || 'clear');
  }

  _emergencyHoldActive() {
    return !!this._emergencyGateContext || !!this._emergencyTransitionPromise
      || (!!this._emergencyHoldUntil && Date.now() < this._emergencyHoldUntil);
  }

  _emergencyCommandBlocked(reason = '') {
    if (!this._emergencyHoldActive()) return false;
    this.log('EMERGENCY interlock: normal command withheld', reason || 'command');
    return true;
  }

  async _forceDoorDirectionForEmergency(target, reason) {
    const gateToken = this._commandToken;
    if (this._manualGateStopped) return false;
    const recoveryAction = String(reason || '').startsWith('emergency_restore_');
    const context = this._emergencyGateContext;
    if (context?.reverseIssued && !recoveryAction) {
      this.log('EMERGENCY duplicate reverse command suppressed', `prior=${context.reverseTarget}`, `requested=${target}`);
      return context.reverseTarget === target;
    }
    // A restore command is a NEW intentional action only after the mower is
    // verified at the waypoint and the preceding gate motion has finished.
    if (context && recoveryAction && ['opening','closing'].includes(this.doorState())) return false;
    this._emergencyGateWait = { target: target === 'close' ? 'closed' : 'open',
      issuedAt: Date.now(), token: gateToken, reason: reason || 'emergency' };
    // A motor reversal makes every older open/close completion timer obsolete.
    clearTimeout(this._doorFinalTimer);
    clearTimeout(this._stableOpenTimer);
    this._doorFinalTimer = null;
    this._stableOpenTimer = null;
    const finalTarget = target === 'close' ? 'closing' : 'opening';
    // Reserve the ONLY reversal for this incident before the first await.
    // Concurrent sensors cannot send two identical motor pulses while Homey
    // persists the derived state. On an asynchronous error we keep the latch
    // and require manual clearance rather than guessing whether a pulse sent.
    if (context && !recoveryAction) {
      context.reverseIssued = true;
      context.reverseTarget = target;
    }
    try {
      await this.setDoorState(finalTarget, { immediate: true, derived: true });
    } catch (error) {
      this.error('EMERGENCY gate state change failed before dispatch', error?.message || String(error));
      if (context) await this._reportEmergencyRecoveryBlocked(context, 'gate_state_write_failed');
      return false;
    }
    if (gateToken !== this._commandToken || this._manualGateStopped) return false;
    this._trigger(target === 'close' ? 'garage_close_requested' : 'garage_open_requested', reason || `emergency_reverse_to_${target}`);
    this._garageNotice(
      target === 'close' ? 'door_closing' : 'door_opening',
      target === 'close' ? this._text('Garagentor schließt', 'Garage door closing') : this._text('Garagentor öffnet', 'Garage door opening'),
      reason || `emergency_reverse_to_${target}`,
      15000,
    );
    this.log('EMERGENCY: gate movement reversed', `target=${target}`, reason || '');
    // The flow event has been dispatched; the caller must not interpret an
    // undefined return value as a rejected reversal command. Physical
    // completion is verified separately by _waitForEmergencyGateTarget().
    return true;
  }

  _captureEmergencyGateContext(moving = null, reason = '') {
    if (this._emergencyGateContext) return this._emergencyGateContext;
    // Explicit return owns the mission; a generic PAUSED or outbound flag
    // cannot turn maintenance (including exit/adjustment) into mowing.
    const manualMaintenance = this._manualMaintenanceTransit
      || this._maintenanceCloseProtected()
      || (this._manualMaintenanceReached && this._manualMaintenancePhase === 'reached');
    const explicitReturn = this._safeReturnInProgress || this._returnGuardActive
      || (this._returnContext && ![RETURN_STATES.IDLE, RETURN_STATES.HOME_CONFIRMED].includes(this._returnContext));
    const knownMowing = this.isMowing() || this._outbound?.requiresMowingStable === true
      || (this.status() === 'paused' && this.lastRequestedAction === 'mowing');
    const mowerMode = explicitReturn ? 'return'
      : manualMaintenance ? 'maintenance'
        : this.isReturning() ? 'return' : knownMowing ? 'mowing' : 'other';
    const currentDoorState = String(this.doorState() || '').toLowerCase();
    const originalDoorTarget = moving === 'opening'
      ? 'open'
      : moving === 'closing'
        ? 'closed'
        : (['open', 'opening'].includes(currentDoorState) ? 'open' : 'closed');
    this._emergencyGateContext = {
      interruptedDoorMotion: moving,
      originalDoorTarget,
      mowerMode,
      originalAction: this.lastRequestedAction || null,
      reverseIssued: false,
      reverseTarget: null,
      createdAt: Date.now(),
      commandToken: this._commandToken,
      reason: reason || 'garage_emergency',
    };
    const recoveryContext = this._emergencyGateContext;
    clearTimeout(this._emergencyRecoveryWatchdog);
    // If no confirmed arrival/restoration happens, this timer provides a
    // visible terminal state. It NEVER sends a second gate or mower command.
    this._emergencyRecoveryWatchdog = setTimeout(() => {
      if (this._emergencyGateContext === recoveryContext
          && recoveryContext.commandToken === this._commandToken) {
        this._reportEmergencyRecoveryBlocked(recoveryContext, 'watchdog_timeout')
          .catch((e) => this.error('emergency watchdog', e.message));
      }
    }, MAINTENANCE_TIMEOUT_MS + 60000);
    this._emergencyRecoveryWatchdog.unref?.();
    this.log('EMERGENCY context captured',
      `door=${moving}->${this._emergencyGateContext.originalDoorTarget}`,
      `mode=${mowerMode}`,
      `action=${this._emergencyGateContext.originalAction || '-'}`);
    return this._emergencyGateContext;
  }

  async _waitForEmergencyGateTarget(target, reason = '', opts = {}) {
    if (this._manualGateStopped) return false;
    const token = this._commandToken;
    const finalState = target === 'closed' ? 'closed' : 'open';
    const action = finalState === 'closed' ? 'close' : 'open';
    const alreadyRequested = opts.alreadyRequested === true;
    if (!alreadyRequested) {
      if (!(await this._forceDoorDirectionForEmergency(action, reason || `emergency_restore_${action}`))) return false;
    }
    const wait = this._emergencyGateWait;
    if (!wait || wait.target !== finalState || wait.token !== token) return false;
    const durationMs = Math.max(1000, (finalState === 'closed'
      ? this._doorCloseDurationSeconds() : this._doorOpenDurationSeconds()) * 1000);
    const monitor = this.sensorDoorMonitoringEnabled();
    const deadline = Number(wait.issuedAt) + (monitor ? Math.max(DOOR_SENSOR_TIMEOUT_MS, durationMs) : durationMs);
    this.log('EMERGENCY gate wait', `target=${finalState}`, `sensor=${monitor ? 'preferred' : 'timer'}`,
      `durationMs=${durationMs}`, `issuedAt=${wait.issuedAt}`);
    while (Date.now() < deadline) {
      if (token !== this._commandToken || this._manualGateStopped || this._emergencyGateWait !== wait) return false;
      const freshContact = this._lastSensorContactState === finalState
        && Number(this._lastSensorContactAt || 0) >= wait.issuedAt;
      if (monitor && freshContact && this.doorState() === finalState && !this._stableOpenTimer) {
        this.log('EMERGENCY gate position verified by current contact', finalState);
        return true;
      }
      await sleep(250);
    }
    if (token !== this._commandToken || this._manualGateStopped || this._emergencyGateWait !== wait) return false;
    if (monitor) {
      // A final contact may have arrived just before the watchdog expires;
      // preserve its configured settle interval before considering fallback.
      const freshTargetContact = this._lastSensorContactState === finalState
        && Number(this._lastSensorContactAt || 0) >= wait.issuedAt;
      if (freshTargetContact) {
        const settleUntil = Date.now() + Math.max(1000, this._doorDelaySeconds() * 1000 + 1000);
        while (Date.now() < settleUntil) {
          if (token !== this._commandToken || this._manualGateStopped || this._emergencyGateWait !== wait) return false;
          if (this.doorState() === finalState && !this._stableOpenTimer) return true;
          await sleep(250);
        }
        await this.safetyBlock('emergency_contact_stabilization_failed');
        return false;
      }
      const freshOpposite = this._lastSensorContactAt >= wait.issuedAt
        && this._lastSensorContactState && this._lastSensorContactState !== finalState;
      if (freshOpposite) {
        this.log('EMERGENCY gate fallback BLOCKED: fresh contradictory door contact',
          `expected=${finalState}`, `contact=${this._lastSensorContactState}`);
        await this.safetyBlock('emergency_gate_contact_contradiction');
        return false;
      }
      this.log('EMERGENCY gate sensor timeout: position UNVERIFIED; maintenance evacuation WITHHELD', finalState);
      await this._recordSensorMovementTimeout(action).catch(() => {});
    } else {
      this.log('EMERGENCY gate without physical contact: travel time elapsed, position UNVERIFIED; maintenance evacuation WITHHELD', finalState);
    }
    // An elapsed travel-time counter is NOT a physical gate-open/closed proof.
    // The mower must remain stopped; a supervised operator can recover it.
    // Never dispatch a maintenance or DOCK command into a gate whose physical
    // position has not been independently confirmed.
    await this.safetyBlock('emergency_gate_end_state_unverified');
    return false;
  }

  async _confirmEmergencyMowingResumed(context, commandAt, startPosition) {
    // The manufacturer can acknowledge RESUME while still physically PAUSED.
    // This read-only, bounded confirmation NEVER retries the start or gate.
    const deadline = Date.now() + 45000;
    let firstNativeMowingAt = 0;
    while (Date.now() < deadline) {
      if (this._manualGateStopped || context.commandToken !== this._commandToken
          || this._emergencyGateContext !== context) return false;
      if (['opening', 'closing'].includes(this.doorState())) return false;
      const now = Date.now();
      const status = String(this.device?._observedMowerStatus || '').toLowerCase();
      const observedAt = Number(this.device?._observedMowerStatusAt || 0);
      if (status === 'error' && observedAt >= commandAt) return false;
      if (status === 'mowing' && observedAt >= commandAt && observedAt <= now + 1000
          && now - observedAt <= 10000) {
        if (!firstNativeMowingAt) firstNativeMowingAt = observedAt;
        if (observedAt > firstNativeMowingAt + 1500) return true;
        const current = this.pos?.();
        const positionAt = Number(current?.ts || current?.timestamp || 0);
        const dx = Number(current?.x) - Number(startPosition?.x);
        const dy = Number(current?.y) - Number(startPosition?.y);
        const moved = Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) >= 250;
        if (moved && positionAt >= commandAt && positionAt <= now + 1000
            && now - positionAt <= 10000) return true;
      }
      await sleep(1000);
    }
    this.log('EMERGENCY: resume acknowledged but native mowing/movement unconfirmed after 45s');
    return false;
  }

  async _resumeInterruptedMissionAfterEmergency(context, reason = '') {
    if (this._manualGateStopped) return false;
    if (!context || (context.commandToken !== undefined && context.commandToken !== this._commandToken)) return false;
    const did = this.device.getData().id;
    this.log('EMERGENCY: restoring interrupted mower mission',
      `mode=${context.mowerMode}`,
      `action=${context.originalAction || '-'}`,
      reason || '');

    if (context.mowerMode === 'return') {
      // Return recovery must only enter through the shared guarded path below.
      await this.safetyBlock('emergency_return_requires_guarded_release');
      return false;
    }

    if (context.mowerMode === 'maintenance') {
      // The interrupted mission was deliberately parked at the maintenance
      // point. Restoring it means staying there; never invent a mowing or dock
      // command from a generic PAUSED status.
      this._safeReturnInProgress = false;
      this._returnGuardActive = false;
      this._setReturnContext(RETURN_STATES.IDLE, `emergency_resume_${reason || 'maintenance_hold'}`);
      this.lastRequestedAction = context.originalAction || 'button_maintenance';
      this.log('EMERGENCY: maintenance-point hold restored; no mower movement command sent');
      return true;
    }

    if (context.mowerMode === 'mowing') {
      // The emergency maintenance detour temporarily uses RETURN_STATES.MAINTENANCE.
      // Clear that detour before resume; otherwise the device's robust resume
      // guard correctly (but undesirably here) suppresses mowing while a return
      // context is active.
      this._safeReturnInProgress = false;
      this._returnGuardActive = false;
      this._setReturnContext(RETURN_STATES.IDLE, `emergency_resume_${reason || 'mowing'}`);
      const resumeCommandAt = Date.now();
      const preResumePosition = this.pos?.() || null;
      let accepted = false;
      if (typeof this.device._resumeMowingRobust === 'function') {
        // Narrow internal authorization. Ordinary Resume remains blocked while
        // the emergency context is retained for crash-safe command ownership.
        this._emergencyRestoreAuthorized = true;
        try { accepted = await this.device._resumeMowingRobust('garage_emergency_restore_original_mission'); }
        finally { this._emergencyRestoreAuthorized = false; }
      } else if (typeof this.device._safeWrite === 'function' && this.device?._api?.resume) {
        accepted = await this.device._safeWrite('garage_emergency_resume_mowing', () => this.device._api.resume(did));
      } else if (this.device?._api?.resume) {
        accepted = await this.device._api.resume(did);
      }
      if (accepted === false || accepted == null
          || (context.commandToken !== undefined && context.commandToken !== this._commandToken)) return false;
      // Do not clear the emergency latch after an API ACK alone. Await fresh
      // physical/native mowing evidence; never send an unbounded resume loop.
      return this._confirmEmergencyMowingResumed(context, resumeCommandAt, preResumePosition);
    }

    // A manual maintenance trip is already complete when this callback runs.
    // Unknown/idle contexts are deliberately left stopped rather than guessing
    // a movement command.
    return true;
  }

  async _restoreEmergencyPlanAfterMaintenance(reason) {
    if (this._emergencyRestorePromise) return this._emergencyRestorePromise;
    const context = this._emergencyGateContext;
    if (context?.restoreAttempted) {
      this.log('EMERGENCY duplicate arrival/restoration ignored; no repeat gate or resume command', reason || '');
      return false;
    }
    if (context) context.restoreAttempted = true;
    this._emergencyRestorePromise = this._restoreEmergencyPlanAfterMaintenanceOnce(reason);
    try {
      const restored = await this._emergencyRestorePromise;
      if (restored && context && this._emergencyGateContext !== context) {
        clearTimeout(this._emergencyRecoveryWatchdog);
        this._emergencyRecoveryWatchdog = null;
      }
      if (!restored && context && this._emergencyGateContext === context) {
        await this._reportEmergencyRecoveryBlocked(context, 'original_mission_restore_unconfirmed');
      }
      return restored;
    } finally { this._emergencyRestorePromise = null; }
  }

  async _restoreEmergencyPlanAfterMaintenanceOnce(reason) {
    if (this._manualGateStopped) return false;
    const context = this._emergencyGateContext;
    if (!context || ['opening', 'closing'].includes(this.doorState())) return false;
    const token = this._commandToken;
    if (context.commandToken !== undefined && context.commandToken !== token) return false;
    if (context.mowerMode === 'return') {
      // Use exactly the normal return's bounded arrival proof, open confirmation,
      // contradiction detection and cancellation checks. No direct dock shortcut.
      if (!(await this._verifiedMaintenanceReturnClearance()) || token !== this._commandToken) {
        await this.safetyBlock('emergency_return_gate_clearance_unconfirmed');
        return false;
      }
      // The old CLOSE intention is obsolete once return-to-dock has priority.
      // Completing it first would produce OPEN -> CLOSE -> OPEN after an
      // emergency reversal, potentially toggling a one-button gate twice.
      // The ordinary guarded _continueReturnFromMaintenance path owns the
      // ONE necessary OPEN release and the subsequent real DOCK command.
      if (context.originalDoorTarget === 'closed') {
        this.log('EMERGENCY: interrupted CLOSE discarded; guarded return owns gate opening');
      }
      this._safeReturnInProgress = true;
      this._returnGuardActive = true;
      this._setReturnContext(RETURN_STATES.MAINTENANCE, 'emergency_return_release');
      this._gateMotionPauseActive = false;
      this._gateMotionPauseMode = null;
      this._pendingEmergencyMaintenanceReason = null;
      this._emergencyHoldUntil = 0;
      this._emergencyGateContext = null;
      const resumed = await this._continueReturnFromMaintenance('emergency_return', async () => {
        if (!this.device?._api?.dock) return false;
        const dock = () => this.device._api.dock(this.device.getData().id);
        return typeof this.device._safeWrite === 'function'
          ? this.device._safeWrite('garage_emergency_resume_return', dock) : dock();
      }, token);
      if (token !== this._commandToken) return false;
      if (!resumed) {
        if (!this._emergencyGateContext) this._emergencyGateContext = context;
        return false;
      }
      this.lastRequestedAction = context.originalAction || 'return';
      await this.clearSafety('emergency_original_plan_restored');
      return true;
    }
    this.log('EMERGENCY maintenance point reached; restoring original gate plan',
      `target=${context.originalDoorTarget}`,
      `mode=${context.mowerMode}`);

    // The corrective emergency gate pulse is ONE-SHOT. After a verified
    // maintenance arrival, never re-play the original OPEN/CLOSE intention:
    // the interrupted direction may be stale and could cause gate oscillation.
    // An intentional future gate command must use the normal interlocks.
    if (!(await this._verifiedMaintenanceReturnClearance()) || token !== this._commandToken) {
      await this.safetyBlock('emergency_mission_release_clearance_unconfirmed');
      return false;
    }
    if (['opening', 'closing'].includes(this.doorState())) {
      await this.safetyBlock('emergency_gate_not_stationary_for_resume');
      return false;
    }
    // Once the gate is fully stationary (open OR closed), the configured danger
    // area is released again. A closed stationary gate therefore does not block
    // ordinary mowing in that area; only gate motion creates the hard interlock.
    this._gateMotionPauseActive = false;
    this._gateMotionPauseMode = null;
    this._gateMotionPauseAt = 0;
    this._gateMotionDangerHits = 0;
    this._gateMotionDangerState = null;
    this._gateMotionDangerFirstAt = 0;
    this._gateMotionDangerLastPositionTs = 0;
    this._pendingEmergencyMaintenanceReason = null;
    this._emergencyHoldUntil = 0;

    if (context.mowerMode === 'other') {
      // The gate can be restored because the mower is now verified at the
      // maintenance point, but an unknown mower mission must never be invented.
      // Hold position and keep a visible warning until a fresh explicit command
      // establishes what the mower should do next.
      this.log('EMERGENCY: original mower mission unknown; holding at verified maintenance point',
        `action=${context.originalAction || '-'}`);
      this.lastRequestedAction = context.originalAction || this.lastRequestedAction;
      this._emergencyGateContext = null;
      await this.safetyWarning('emergency_original_mission_unknown_hold').catch(() => {});
      this._trigger('garage_position_uncertain', 'emergency_original_mission_unknown_hold');
      return true;
    }

    const resumed = await this._resumeInterruptedMissionAfterEmergency(context, reason);
    if (resumed) {
      this.lastRequestedAction = context.originalAction || this.lastRequestedAction;
      this._emergencyGateContext = null;
      await this.clearSafety('emergency_original_plan_restored').catch(() => {});
    }
    return resumed;
  }

  // MANUAL EMERGENCY RECOVERY: explicit operator control, never an automatic
  // fallback gate action. The latched _manualGateStopped blocks every normal
  // automatic OPEN/CLOSE path, including station-arrival close. A user must
  // confirm the *physical* open passage; timed door states do not count.
  async _enterManualRecovery(reason = 'emergency_unconfirmed', { operatorFree = false, skipNativePause = false } = {}) {
    if (this._manualRecoveryActive) return true;
    this._manualRecoveryActive = true;
    this._manualRecoveryOperatorFree = operatorFree === true;
    this._manualRecoveryPhase = 'manual_hold';
    this._stopManualReturnWatch();
    this._manualRecoveryStoredArrival = null;
    this._manualReturnAttempt = 0;
    this._manualReturnDispatchUncertainUntil = 0;
    this._manualReturnFailureReason = '';
    this._manualRecoveryOpenConfirmedAt = 0;
    this._manualRecoveryGatePulseAt = 0;
    this._manualRecoveryGateClosedAt = 0;
    this._manualGateStopped = true;
    // Terminal emergency -> MANUAL/OFF automatically, without waiting for a
    // user click. The emergency latch continues to guard actual movement.
    // Do not call setOperatorGaragePause() here: that generic toggle cancels
    // the active command token and could interrupt emergency cleanup.
    this.paused = true;
    this._closeScheduled = false;
    clearTimeout(this._closeTimer); this._closeTimer = null;
    clearTimeout(this._homeCloseTimer); this._homeCloseTimer = null;
    for (const timer of ['_doorFinalTimer', '_stableOpenTimer']) {
      clearTimeout(this[timer]); this[timer] = null;
    }
    try {
      await Promise.all([
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_recovery_active', true)),
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_operator_free', this._manualRecoveryOperatorFree)),
        Promise.resolve(this.device?.setStoreValue?.('garage_operator_paused', true)),
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_gate_stopped', true)),
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_verified_arrival', null)),
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_pending', false)),
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_attempts', 0)),
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_dispatch_after', 0)),
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_failure', '')),
      ]);
    } catch (error) {
      // Runtime stays latched even if the persistent store is temporarily down.
      this.error('manual recovery latch persistence unavailable', error?.message || String(error));
    }
    this.log('MANUAL RECOVERY latched: garage automation PAUSED; manual controls available', reason);
    // One best-effort native PAUSE if the last FRESH telemetry still says the
    // mower is driving. Never assume the API ACK proves actual standstill and
    // NEVER issue a PAUSE/STOP loop. The operator must still see safe clearance.
    const native = String(this.device?._observedMowerStatus || '').toLowerCase();
    const at = Number(this.device?._observedMowerStatusAt || 0);
    const age = Date.now() - at;
    if (!skipNativePause && at > 0 && age >= 0 && age <= 15000
        && ['mowing','returning','leaving','mapping'].includes(native)
        && this.device?._api?.pause) {
      try {
        const fn = () => this.device._api.pause(this.device.getData().id);
        const accepted = typeof this.device._safeWrite === 'function'
          ? await this.device._safeWrite('manual_recovery_one_pause', fn) : await fn();
        this.log('MANUAL RECOVERY one native pause requested',accepted === false ? 'rejected' : 'acknowledged, standstill unconfirmed');
      } catch (error) { this.error('manual recovery native pause unavailable', error.message); }
    }
    return true;
  }

  // Explicit operator selection from AUTO-OFF. This makes the full set
  // of ONE-SHOT rescue controls available without issuing a PAUSE/STOP/motor
  // pulse merely because the user entered manual mode.
  manualRecoveryDeclarePosition(location, supervised = false) {
    // The emergency latch itself is the authority. The operator may already
    // have selected AUTO=ON while that latch still prevents all automatic
    // motion. A VISUAL statement must not be rejected because of that toggle.
    if (!this._manualRecoveryActive || supervised !== true
        || !['outside','inside','unknown'].includes(location)) return false;
    // Purely advisory, resets at startup; NEVER becomes the live GPS, dock
    // state, or any automatic safety permission.
    this._manualOperatorPosition=location;
    this.log('MANUAL RECOVERY operator-only location statement',location,
      'native geometry and gate interlocks unchanged');
    return true;
  }

  async beginOperatorManualControl(supervised = false) {
    if (supervised !== true || !this.device) return false;
    // Entering MANUAL is a non-motion operator choice. It must remain possible
    // after a terminal return hold even when the AUTO toggle was previously ON.
    // The safety/emergency latch remains active, independently of that toggle.
    if (!this.paused) {
      const paused = await this.setOperatorGaragePause(true, 'explicit_supervised_manual');
      if (paused !== true || !this.paused) return false;
    }
    if (!this._manualRecoveryActive) {
      await this._enterManualRecovery('operator_explicit_manual_takeover',
        { operatorFree: true, skipNativePause: true });
    } else {
      this._manualRecoveryOperatorFree = true;
      await this.device.setStoreValue?.('garage_manual_operator_free', true);
    }
    this._manualRecoveryPhase = 'operator_control';
    this.log('MANUAL operator control enabled: single commands only; geometry bypassed by explicit operator responsibility');
    return true;
  }

  // Under manual control the firmware's own protections remain in force.
  // Homey does not infer a route, bypass a manufacturer error, or claim success
  // from a cloud ACK. The operator must independently watch the open passage.
  async manualRecoveryDirectDock(supervised = false) {
    if (supervised !== true || !this._manualRecoveryActive || !this._manualRecoveryOperatorFree
        || !this.paused || !this._manualRecoveryGateOpenProof()
        || this._manualRecoveryMowerCommandBusy || this._manualRecoveryGateCommandBusy
        || Date.now() < Number(this._manualReturnDispatchUncertainUntil || 0)
        || this._manualReturnAttempt >= MANUAL_RETURN_MAX_EXPLICIT_ATTEMPTS
        || !this.device?._api?.dock) return false;
    this._manualRecoveryMowerCommandBusy = true;
    const token = this._commandToken;
    try {
      this._manualReturnAttempt = Number(this._manualReturnAttempt || 0) + 1;
      this._manualReturnDispatchUncertainUntil = Date.now() + MANUAL_RETURN_UNCONFIRMED_DISPATCH_WAIT_MS;
      await Promise.all([
        this.device.setStoreValue('garage_manual_return_attempts', this._manualReturnAttempt),
        this.device.setStoreValue('garage_manual_return_dispatch_after', this._manualReturnDispatchUncertainUntil),
      ]);
      if (token !== this._commandToken || !this.paused || !this._manualRecoveryGateOpenProof()) return false;
      const fn = () => this.device._api.dock(this.device.getData().id);
      let ack;
      try { ack = this.device._safeWrite
        ? await this.device._safeWrite('operator_direct_dock_supervised', fn) : await fn(); }
      catch (error) {
        this._manualReturnFailureReason = 'dock_ack_uncertain';
        await this.device.setStoreValue('garage_manual_return_failure','dock_ack_uncertain');
        throw error;
      }
      if (ack === false || token !== this._commandToken) return false;
      this._manualRecoveryPhase = 'returning';
      this._manualReturnFailureReason = '';
      await this.device.setStoreValue('garage_manual_return_pending',true);
      this._startManualReturnWatch(this.pos?.() || null);
      this.log('MANUAL DIRECT DOCK requested; no waypoint/position/gate automation asserted; native arrival still pending');
      return true;
    } finally { this._manualRecoveryMowerCommandBusy = false; }
  }

  async manualRecoveryDirectMaintenance(index, supervised = false) {
    const point = Number(index);
    if (supervised !== true || !this._manualRecoveryActive || !this._manualRecoveryOperatorFree
        || !this.paused || this._manualRecoveryMowerCommandBusy || this._manualRecoveryGateCommandBusy
        || !Number.isInteger(point) || point < 1 || point > 5
        || !this.device?._api?.goToMaintenancePoint) return false;
    // When already safely on the lawn, travelling to another lawn-side P
    // does not require opening the garage. The firmware retains its own guards.
    // With unknown/inside position, actual OPEN passage remains mandatory.
    if (!this._manualRecoveryGateOpenProof()) {
      if (!(await this._manualRecoveryOutdoorRearmProof())) return false;
      // A closed gate is acceptable only for a known lawn-side destination.
      // An unknown point must never become an unguarded drive through the door.
      const target = await Promise.resolve(this.device._resolveNativeMaintenancePoint?.(point)).catch(()=>null);
      if (!target || !Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.y))) return false;
      const area = await this.markers?.rawDangerState?.(target).catch(()=>null);
      const [lineDistance, line, dir] = await Promise.all([
        this.markers?.distanceToSafetyLineSegment?.(target),
        this.markers?.signedDistanceToLine?.(target), this.markers?.directionState?.(),
      ]).catch(()=>[null,null,null]);
      if (!area?.known || area.inside || !Number.isFinite(Number(area.distance))
          || !Number.isFinite(Number(area.radius))
          || Number(area.distance)-Number(area.radius) <= MANUAL_GATE_MIN_DANGER_CLEARANCE_MM
          || !Number.isFinite(Number(lineDistance))
          || Number(lineDistance) <= MANUAL_GATE_MIN_SAFETY_LINE_DISTANCE_MM
          || !dir?.known || ![-1,1].includes(Number(dir.lawnSide))
          || !Number.isFinite(Number(line?.distance))
          || Number(line.distance)*Number(dir.lawnSide) <= 0) return false;
    }
    const device = this.device;
    const token = this._commandToken;
    this._manualRecoveryMowerCommandBusy = true;
    try {
      // Send precisely the selected native P-ID, even if Homey's coordinate
      // record is missing. The firmware may reject an undefined native target.
      // No local fallback converts P2 into P1 or a mowing command.
      const map = Number(device._activeMapIndex ?? 0);
      const did = device.getData().id;
      device._nativeMaintenanceCommandAt = Date.now();
      device._nativeMaintenanceCommandSource = 'operator_direct';
      device._nativeMaintenanceTargetIndex = point;
      device._nativeMaintenanceIndexInferred = false;
      device._nativeMaintenanceCommandStartPosition = device._getBufferedLivePosition?.(20000) || device._livePos || null;
      device._nativeMaintenanceArrivalClosed = false;
      device._nativeMaintenanceArrivalCommitted = false;
      device._nativeMaintenanceCompletionHint = null;
      device._nativeMaintenanceStableArrival = null;
      device._pendingNativeMaintenanceArrival = null;
      const fn = () => device._api.goToMaintenancePoint(did, map, point);
      const ack = device._safeWrite
        ? await device._safeWrite(`operator_direct_native_P${point}`, fn) : await fn();
      if (ack === false || token !== this._commandToken) return false;
      this._manualRecoveryPhase = 'maintenance_enroute';
      this.log(`MANUAL DIRECT native maintenance P${point} requested; physical arrival NOT yet confirmed`);
      return true;
    } catch (error) {
      this._manualRecoveryPhase = 'manual_hold';
      this.log('MANUAL DIRECT maintenance request uncertain; inspect mower before retry',error?.message||String(error));
      throw error;
    } finally { this._manualRecoveryMowerCommandBusy = false; }
  }

  _manualRecoveryStationary() {
    const status = String(this.device?._observedMowerStatus || this.status() || '').toLowerCase();
    const at = Number(this.device?._observedMowerStatusAt || 0);
    return ['paused', 'idle', 'standby', 'error'].includes(status)
      && at > 0 && Date.now() >= at && Date.now() - at <= 15000;
  }

  _manualRecoveryGateOpenProof(maxAgeMs = 15 * 60 * 1000) {
    if (!this._manualRecoveryActive || !this._manualRecoveryOpenConfirmedAt) return false;
    const now = Date.now();
    if (now < this._manualRecoveryOpenConfirmedAt
        || now - this._manualRecoveryOpenConfirmedAt > maxAgeMs) return false;
    // A newer physical CLOSED contact defeats even the operator's earlier attestation.
    if (this._lastSensorContactState === 'closed'
        && Number(this._lastSensorContactAt || 0) >= this._manualRecoveryOpenConfirmedAt) return false;
    // A stale derived 'closing'/'opening' UI value is NOT a moving-gate
    // sensor. Only an actual later CLOSE edge or a new manual gate pulse can
    // revoke the operator's freshly given physical OPEN declaration.
    return true;
  }

  async manualRecoveryGateCommand(action, supervised = false) {
    if (!this._manualRecoveryActive || supervised !== true || !['open', 'close'].includes(action)
        || this._manualRecoveryMowerCommandBusy) return false;
    // Even after explicit takeover, a gate pulse must never compete with a
    // FRESH ongoing navigation or moving-gate emergency. An operator location
    // statement is intentionally not evidence that the swept area is clear.
    if (this._emergencyGateContext || this._emergencyTransitionPromise
        || ['opening','closing'].includes(this.doorState())) return false;
    const observed=String(this.device?._observedMowerStatus || '').toLowerCase();
    const observedAt=Number(this.device?._observedMowerStatusAt||0);
    const fresh=observedAt>0 && Date.now()>=observedAt && Date.now()-observedAt<=15000;
    if (fresh && ['mowing','returning','leaving','mapping','remote_control'].includes(observed)) {
      this.log('MANUAL RECOVERY gate command withheld during fresh motor activity',action,observed);
      return false;
    }
    if (action==='close') {
      // Operator takeover disables automatic routing, NOT physical gate interlocks.
      // A pending native return/waypoint task may cross the gate even if the
      // current state is PAUSED: require strong dock or stationary lawn-side
      // position plus fresh proof before any manual CLOSE pulse.
      if (['maintenance_enroute','returning'].includes(this._manualRecoveryPhase)) return false;
      const safeDock = this._strongDockCloseProof() && this.isDockedHomeStatus();
      const safelyOutside = await this._manualGateOutsidePositionProof().catch(() => false);
      if (!safeDock && !(safelyOutside && this._manualRecoveryStationary())) return false;
    }
    if (!this._manualRecoveryOperatorFree && action === 'open') {
      // Freeing a trapped mower may be necessary precisely when telemetry has
      // stalled. A FRESH native driving status still vetoes motor movement, but
      // an unavailable/stale status may be overridden only by the explicit
      // supervised button press (never by a flow/automatic path). This does NOT
      // release the mower: driving requires separate physical OPEN attestation.
      const native = String(this.device?._observedMowerStatus || '').toLowerCase();
      const statusAt = Number(this.device?._observedMowerStatusAt || 0);
      const age = Date.now() - statusAt;
      if (statusAt > 0 && age >= 0 && age <= 15000
          && ['mowing','returning','leaving','mapping','remote_control'].includes(native)) return false;
      if (!this._manualRecoveryStationary()) {
        this.log('MANUAL RECOVERY OPEN: stationary telemetry unavailable; supervised operator action only');
      }
    } else if (!this._manualRecoveryOperatorFree) {
      // A supervised CLOSE is never a way to interrupt an active waypoint or
      // return traversal. The mower could enter the passage after this pulse.
      if (['maintenance_enroute', 'returning'].includes(this._manualRecoveryPhase)) return false;
      const safeDock = this._strongDockCloseProof() && this.isDockedHomeStatus();
      const safelyOutside = await this._manualGateOutsidePositionProof().catch(() => false);
      // A geometric snapshot alone does not establish that a moving mower will
      // remain outside the doorway. Dock proof is independently checked.
      if (!safeDock && !(safelyOutside && this._manualRecoveryStationary())) return false;
    }
    // A real physical end contact is an idempotent result, not a reason to
    // issue another potentially reversing toggle pulse on a 1Control relay.
    // Visual operator reports do not qualify as a physical contact here.
    const settled = action === 'open' ? 'open' : 'closed';
    if (this.device?.getCapabilityValue?.('garage_sensor_available_status') === 'online'
        && this.device?.getCapabilityValue?.('garage_sensor_contact_status') === settled
        && this._lastSensorContactState === settled && this.doorState() === settled
        && this._doorStateDerived !== true && !this._emergencyGateContext
        && !this._emergencyTransitionPromise) {
      this.log('MANUAL RECOVERY gate already at real end contact: no toggle pulse', action);
      return true;
    }
    if (Date.now() - Number(this._manualRecoveryGatePulseAt || 0) < 3000) return false;
    if (this._manualRecoveryGateCommandBusy || this._manualRecoveryMowerCommandBusy
        || (!this._manualRecoveryOperatorFree && action === 'close'
          && ['maintenance_enroute', 'returning'].includes(this._manualRecoveryPhase))) return false;
    this._manualRecoveryGateCommandBusy = true;
    try {
      this._manualRecoveryGatePulseAt = Date.now();
      this._manualRecoveryGateClosedAt = 0;
      this._manualRecoveryOpenConfirmedAt = 0;
      const reason = `manual_recovery_supervised_${action}`;
      // No call to requestOpen/requestClose: their automatic follow-up releases
      // must not re-arm under a trapped-mower emergency.
      this._trigger(action === 'open' ? 'garage_open_requested' : 'garage_close_requested', reason);
      this.log('MANUAL RECOVERY explicit single gate action', action);
      return true;
    } finally { this._manualRecoveryGateCommandBusy = false; }
  }

  async manualRecoveryConfirmGateOpen(supervised = false) {
    if (!this._manualRecoveryActive || supervised !== true) return false;
    // An OLD retained CLOSED contact or derived 'closing' tile must not
    // deadlock an explicitly supervised rescue after a physical manual gate
    // opening. But a genuinely fresh contradictory CLOSED edge still vetoes.
    const contactAge = Date.now() - Number(this._lastSensorContactAt || 0);
    if (this._lastSensorContactState === 'closed'
        && Number(this._lastSensorContactAt || 0) > 0
        && contactAge >= 0 && contactAge <= 12000) {
      this.log('MANUAL RECOVERY visual OPEN disputed by recent physical CLOSED contact', contactAge);
      return false;
    }
    const pulseAge = Date.now() - Number(this._manualRecoveryGatePulseAt || 0);
    const { currentPhysicalEndContact } = require('./NormalbetriebRestore');
    if (['opening', 'closing'].includes(this.doorState())
        && Number(this._manualRecoveryGatePulseAt || 0) > 0
        && pulseAge >= 0 && pulseAge <= 12000
        && !currentPhysicalEndContact(this, 'open')) {
      this.log('MANUAL RECOVERY visual OPEN awaiting current manual gate pulse', pulseAge);
      return false;
    }
    // Operator attestation is intentionally separate from a REAL sensor edge.
    // Calling setDoorState('open', derived:false) here would forge a physical
    // contact, persist it and unintentionally satisfy unrelated gate guards.
    // Never synthesize sensor evidence from the rescue button.
    this._manualRecoveryOpenConfirmedAt = Date.now();
    this._manualRecoveryGateClosedAt = 0; // mutually exclusive visual reports
    this.log('MANUAL RECOVERY physical gate passage confirmed explicitly by operator');
    return true;
  }

  _validManualArrivalRecord(record) {
    const age = Date.now() - Number(record?.at || 0);
    return record && Number.isInteger(record.index) && record.index >= 1 && record.index <= 5
      && Number.isFinite(record.x) && Number.isFinite(record.y)
      && age >= 0 && age <= MANUAL_ARRIVAL_PROOF_MAX_MS;
  }

  async _rememberManualArrival(index) {
    if (!this._manualRecoveryActive || !this._manualMaintenanceReached
        || this._manualMaintenancePhase !== 'reached'
        || Number(this._lockedReturnMaintenancePoint?.index) !== Number(index)) return false;
    const point = this._lockedReturnMaintenancePoint;
    const record = {index: Number(index), x: Number(point.x), y: Number(point.y), at: Date.now()};
    this._manualRecoveryStoredArrival = record;
    await Promise.resolve(this.device?.setStoreValue?.('garage_manual_verified_arrival', record)).catch(e => {
      this.error('manual arrival persistence failed', e?.message || String(e));
    });
    return true;
  }

  // Only called following an explicit user DOCK request. A historical arrival
  // record alone is never proof. Position, safety geometry and stopped status
  // must all be fresh and independently checked.
  async _revalidateManualArrivalAfterRestart() {
    const record = this._manualRecoveryStoredArrival;
    if (!this._manualRecoveryActive || !this._validManualArrivalRecord(record)
        || !this._manualRecoveryGateOpenProof() || !this._manualRecoveryStationary()) return false;
    const pos = this.pos();
    const currentDistance = this._distance(pos, record);
    if (!pos?.ts || Date.now() - Number(pos.ts) > RETURN_OPEN_POSITION_MAX_AGE_MS
        || Date.now() < Number(pos.ts) || !Number.isFinite(currentDistance)
        || currentDistance > MAINTENANCE_CONFIRM_RADIUS_MM) return false;
    const point = await Promise.resolve(this.device?._resolveNativeMaintenancePoint?.(record.index)).catch(() => null);
    const nativeTargetDrift = this._distance(point,record);
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))
        || !Number.isFinite(nativeTargetDrift)
        || nativeTargetDrift > MAINTENANCE_CONFIRM_RADIUS_MM) return false;
    const danger = await this.markers.rawDangerState(pos).catch(() => null);
    if (!danger?.known || danger.inside || danger.distance == null || danger.radius == null
        || !Number.isFinite(Number(danger.distance)) || !Number.isFinite(Number(danger.radius))
        || Number(danger.radius) <= 0
        || Number(danger.distance) <= Number(danger.radius) + RETURN_GATE_CLEARANCE_MM) return false;
    this._lockedReturnMaintenancePoint = {x:record.x,y:record.y,index:record.index};
    this._manualMaintenanceTargetReachedIndex = record.index;
    this._manualMaintenanceReached = true;
    this._manualMaintenancePhase = 'reached';
    this._manualRecoveryPhase = 'maintenance_reached';
    this.log('MANUAL RECOVERY fresh operator-requested waypoint revalidation',`P${record.index}`);
    return true;
  }

  _stopManualReturnWatch() {
    if (this._manualReturnWatch) clearInterval(this._manualReturnWatch);
    this._manualReturnWatch = null;
  }

  async _failManualReturnWatch(reason) {
    if (!this._manualRecoveryActive || this._manualRecoveryPhase !== 'returning') return;
    this._stopManualReturnWatch();
    this._manualRecoveryPhase = 'manual_hold';
    this._manualReturnFailureReason = reason;
    this._manualMaintenanceReached = false; // Requires fresh explicit revalidation.
    this._manualGateStopped = true;
    await Promise.all([
      Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_pending', false)),
      Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_failure', reason)),
    ]).catch(() => {});
    this.log('MANUAL RECOVERY return stopped being verifiable',reason);
    await this.safetyWarning?.(`manual_recovery_return_${reason}`).catch(() => {});
    this._trigger('garage_position_uncertain',`manual_recovery_return_${reason}`);
    // Never issue DOCK, OPEN or CLOSE as a watchdog side effect.
  }

  _startManualReturnWatch(startPosition) {
    this._stopManualReturnWatch();
    const began = Date.now();
    let lastProgressAt = began;
    let lastTelemetryAt = Number(startPosition?.ts || began);
    let previous = {x:Number(startPosition?.x), y:Number(startPosition?.y)};
    let departureSeen = false;
    const timer = setInterval(async () => {
      if (this._manualReturnWatch !== timer || this._manualReturnWatchBusy) return;
      this._manualReturnWatchBusy = true;
      try {
      if (!this._manualRecoveryActive || this._manualRecoveryPhase !== 'returning') {
        this._stopManualReturnWatch(); return;
      }
      if (this.isDockedHomeStatus() && this._strongDockCloseProof()) {
        this._stopManualReturnWatch();
        await Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_pending',false)).catch(() => {});
        this._manualRecoveryPhase = 'docked_wait_rearm'; // Explicit rearm remains mandatory.
        this.log('MANUAL RECOVERY verified dock; waiting for operator rearm');
        return;
      }
      const now = Date.now(), pos = this.pos();
      const sampleAt = Number(pos?.ts || 0);
      if (sampleAt > lastTelemetryAt && sampleAt <= now
          && now - sampleAt <= RETURN_OPEN_POSITION_MAX_AGE_MS
          && Number.isFinite(Number(pos?.x)) && Number.isFinite(Number(pos?.y))) {
        lastTelemetryAt = sampleAt;
        const moved = this._distance(pos,previous);
        if (Number.isFinite(moved) && moved >= MANUAL_RETURN_MOVEMENT_MM) {
          departureSeen = true; lastProgressAt = now;
          previous = {x:Number(pos.x),y:Number(pos.y)};
        }
      }
      const reason = now - began >= MANUAL_RETURN_TOTAL_TIMEOUT_MS ? 'overall_timeout'
        : now - lastTelemetryAt >= MANUAL_RETURN_NO_TELEMETRY_MS ? 'telemetry_timeout'
        : !departureSeen && now - began >= MANUAL_RETURN_DEPARTURE_TIMEOUT_MS ? 'no_departure'
        : departureSeen && now - lastProgressAt >= MANUAL_RETURN_PROGRESS_TIMEOUT_MS ? 'progress_stalled'
        : null;
      if (reason) await this._failManualReturnWatch(reason);
      } catch (error) {
        // Do not keep a failing interval alive forever after malformed telemetry
        // or a runtime exception. Warn once, keep the manual gate latch, and
        // never start another dock/gate command from this observer.
        this.error('MANUAL RECOVERY passive return watcher failed', error?.message || String(error));
        await this._failManualReturnWatch('watch_error').catch(() => {});
      } finally { this._manualReturnWatchBusy = false; }
    }, MANUAL_RETURN_WATCH_INTERVAL_MS);
    this._manualReturnWatch = timer;
    timer.unref?.();
  }

  async manualRecoveryToMaintenance(pointIndex = null) {
    if (!this._manualRecoveryActive || ['returning','docked_wait_rearm'].includes(this._manualRecoveryPhase)
        || !this._manualRecoveryGateOpenProof() || !this._manualRecoveryStationary()) return false;
    if (this._manualRecoveryMowerCommandBusy || this._manualRecoveryPhase === 'maintenance_enroute') return false;
    const index = pointIndex == null ? Number(this.device._maintenancePointIndex?.() || 1) : Number(pointIndex);
    if (!Number.isInteger(index) || index < 1 || index > 5) return false;
    const target = await Promise.resolve(this.device._resolveNativeMaintenancePoint?.(index)).catch(() => null);
    if (!target || !Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.y))) return false;
    if (typeof this.device._goToMaintenancePointGuarded !== 'function') return false;
    this._manualRecoveryMowerCommandBusy = true;
    try {
      const token = this._commandToken;
      this._lockedReturnMaintenancePoint = {...target, index};
      this._manualRecoveryStoredArrival = null;
      await Promise.resolve(this.device?.setStoreValue?.('garage_manual_verified_arrival',null)).catch(() => {});
      this._manualMaintenanceTargetIndex = index;
      this._manualMaintenanceReached = false;
      this._manualMaintenanceTransit = true;
      this._manualMaintenancePhase = 'transit';
      this._manualMaintenancePhaseStartedAt = Date.now();
      this._manualRecoveryPhase = 'maintenance_enroute';
      const accepted = await this.device._goToMaintenancePointGuarded('manual_recovery_maintenance', index);
      if (accepted === false || token !== this._commandToken) {
        this._manualRecoveryPhase = 'manual_hold';
        this._manualMaintenanceTransit = false;
        return false;
      }
      // Native status-75 may already have arrived while the cloud call was
      // pending; keep that proof instead of constructing a second trip.
      if (this._manualMaintenanceReached && this._manualMaintenancePhase === 'reached') {
        this._manualRecoveryPhase = 'maintenance_reached';
        await this._rememberManualArrival(index);
        return true;
      }
      this._watchMaintenanceReached(async () => {
        if (!this._manualRecoveryActive || token !== this._commandToken) return;
        this._manualRecoveryPhase = 'maintenance_reached';
        await this._rememberManualArrival(index);
        this.log('MANUAL RECOVERY confirmed native waypoint arrival', `P${index}`);
      }, async () => {
        if (!this._manualRecoveryActive) return;
        this._manualRecoveryPhase = 'manual_hold';
        this._trigger('garage_position_uncertain', 'manual_recovery_maintenance_timeout');
      });
      return true;
    } catch (error) {
      // A rejected/failed cloud write must not strand the rescue in ENROUTE
      // with no watcher installed. We do not automatically resend: an ACK may
      // have been lost after the device received the first command.
      this._manualRecoveryPhase = 'manual_hold';
      this._manualMaintenanceTransit = false;
      this._manualMaintenancePhase = 'idle';
      this._lockedReturnMaintenancePoint = null;
      this.error('MANUAL RECOVERY waypoint dispatch uncertain', error?.message || String(error));
      await this.safetyWarning?.('manual_recovery_maintenance_command_unconfirmed').catch(() => {});
      throw error;
    } finally { this._manualRecoveryMowerCommandBusy = false; }
  }

  async manualRecoveryReturnToDock() {
    if (!this._manualRecoveryActive || this._manualRecoveryPhase === 'returning'
        || this._manualRecoveryMowerCommandBusy || !this._manualRecoveryGateOpenProof()
        || (this._manualRecoveryPhase !== 'revalidate_point' && this._manualRecoveryPhase !== 'manual_hold'
          && (!this._manualMaintenanceReached || this._manualMaintenancePhase !== 'reached'))) return false;
    if (this._manualReturnAttempt >= MANUAL_RETURN_MAX_EXPLICIT_ATTEMPTS) {
      await this.safetyWarning?.('manual_recovery_return_attempts_exhausted').catch(() => {});
      return false;
    }
    if (Date.now() < Number(this._manualReturnDispatchUncertainUntil || 0)) return false;
    if (this._manualRecoveryPhase === 'revalidate_point' || this._manualRecoveryPhase === 'manual_hold') {
      if (!(await this._revalidateManualArrivalAfterRestart())) return false;
    }
    const target = this._lockedReturnMaintenancePoint;
    const index = Number(this._manualMaintenanceTargetReachedIndex || 0);
    if (!target || index !== Number(target.index || 1)) return false;
    const pos = this.pos();
    const age = Date.now() - Number(pos?.ts || 0);
    const distance = this._distance(pos, target);
    if (!pos || !Number.isFinite(distance) || distance > MAINTENANCE_CONFIRM_RADIUS_MM
        || age < 0 || age > RETURN_OPEN_POSITION_MAX_AGE_MS || !this._manualRecoveryStationary()) return false;
    const danger = await this.markers.rawDangerState(pos).catch(() => null);
    if (!danger?.known || danger.inside || danger.distance == null || danger.radius == null
        || !Number.isFinite(Number(danger.distance)) || !Number.isFinite(Number(danger.radius))
        || Number(danger.radius) <= 0
        || Number(danger.distance) <= Number(danger.radius) + RETURN_GATE_CLEARANCE_MM) return false;
    if (!this.device?._api?.dock) return false;
    const token = this._commandToken;
    this._manualRecoveryMowerCommandBusy = true;
    try {
      // Same best-effort native return-zone transition, but NO automatic gate
      // action. Explicit physical OPEN attestation remains the sole release.
      if (typeof this.device._syncPylonLifecyclePhase === 'function') {
        try {
          const result = await this.device._syncPylonLifecyclePhase('return', {
            reason:'manual_recovery_return', allowVerifiedReturnCheckpoint:true, requireRequestedPhase:true,
          });
          if (result?.ok === false || result?.unverified) this.log('MANUAL RECOVERY native zone change unconfirmed; best-effort return');
        } catch (e) { this.log('MANUAL RECOVERY native zone readback unavailable',e.message); }
      }
      // Zone synchronization may have taken seconds. Reconfirm unchanged
      // stationary geometry and the operator's OPEN attestation immediately
      // before the one permitted DOCK command.
      const finalPosition = this.pos();
      const finalDanger = await this.markers.rawDangerState(finalPosition).catch(() => null);
      const finalTargetDistance = this._distance(finalPosition, target);
      if (token !== this._commandToken || !this._manualRecoveryGateOpenProof()
          || !this._manualRecoveryStationary() || !finalPosition?.ts
          || Date.now() - Number(finalPosition.ts) > RETURN_OPEN_POSITION_MAX_AGE_MS
          || !Number.isFinite(finalTargetDistance) || finalTargetDistance > MAINTENANCE_CONFIRM_RADIUS_MM
          || !finalDanger?.known || finalDanger.inside
          || finalDanger.distance == null || finalDanger.radius == null
          || !Number.isFinite(Number(finalDanger.distance))
          || !Number.isFinite(Number(finalDanger.radius)) || Number(finalDanger.radius) <= 0
          || Number(finalDanger.distance) <= Number(finalDanger.radius) + RETURN_GATE_CLEARANCE_MM) return false;
      const fn = () => this.device._api.dock(this.device.getData().id);
      // Count dispatch attempts before the cloud call. A lost acknowledgement
      // may still mean the mower received DOCK; immediately resending risks an
      // unintended second command. The cooldown also survives an app restart.
      this._manualReturnAttempt = Number(this._manualReturnAttempt || 0) + 1;
      this._manualReturnDispatchUncertainUntil = Date.now() + MANUAL_RETURN_UNCONFIRMED_DISPATCH_WAIT_MS;
      await Promise.all([
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_attempts', this._manualReturnAttempt)),
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_dispatch_after', this._manualReturnDispatchUncertainUntil)),
      ]);
      // Store I/O may be delayed. Do not send DOCK after an intervening gate
      // change, command cancellation, stale position or moving mower.
      const dispatchPos = this.pos();
      const dispatchDanger = await this.markers.rawDangerState(dispatchPos).catch(() => null);
      const dispatchDistance = this._distance(dispatchPos, target);
      if (token !== this._commandToken || !this._manualRecoveryGateOpenProof()
          || !this._manualRecoveryStationary() || !dispatchPos?.ts
          || Date.now() < Number(dispatchPos.ts)
          || Date.now() - Number(dispatchPos.ts) > RETURN_OPEN_POSITION_MAX_AGE_MS
          || !Number.isFinite(dispatchDistance) || dispatchDistance > MAINTENANCE_CONFIRM_RADIUS_MM
          || !dispatchDanger?.known || dispatchDanger.inside
          || dispatchDanger.distance == null || dispatchDanger.radius == null
          || !Number.isFinite(Number(dispatchDanger.distance))
          || !Number.isFinite(Number(dispatchDanger.radius)) || Number(dispatchDanger.radius) <= 0
          || Number(dispatchDanger.distance) <= Number(dispatchDanger.radius) + RETURN_GATE_CLEARANCE_MM) return false;
      let accepted;
      try {
        accepted = typeof this.device._safeWrite === 'function'
          ? await this.device._safeWrite('manual_recovery_dock_no_gate', fn) : await fn();
      } catch (error) {
        this._manualReturnFailureReason = 'dock_ack_uncertain';
        await Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_failure','dock_ack_uncertain')).catch(() => {});
        await this.safetyWarning?.('manual_recovery_return_dock_ack_uncertain').catch(() => {});
        throw error;
      }
      if (accepted === false || token !== this._commandToken) {
        this._manualReturnFailureReason = 'dock_ack_uncertain';
        await Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_failure','dock_ack_uncertain')).catch(() => {});
        return false;
      }
      this._manualRecoveryPhase = 'returning';
      this._manualReturnFailureReason = '';
      await Promise.all([
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_pending',true)),
        Promise.resolve(this.device?.setStoreValue?.('garage_manual_return_failure','')),
      ]).catch(e => this.error('manual return watch persistence unavailable',e?.message || String(e)));
      this._startManualReturnWatch(finalPosition);
      this._safeReturnInProgress = true;
      this._returnGuardActive = true;
      this._setReturnContext(RETURN_STATES.DOCK, 'manual_recovery_no_gate_pulse');
      this.log('MANUAL RECOVERY dock requested without automatic gate commands');
      return true;
    } finally { this._manualRecoveryMowerCommandBusy = false; }
  }

  // Manual recovery is sticky across reboot. A dock contact may no longer
  // generate MQTT while the mower is quietly charging, so the 15-s HOME-CLOSE
  // timers are not appropriate as a permanent precondition for USER rearm.
  // Explicit rearm actively rereads the manufacturer's native binary station
  // state WITHOUT issuing any motor/door command. It must prove IN_STATION
  // and undock=0 from fresh native frames. The charging bit may legitimately
  // be zero at full battery; it is NOT a station-contact requirement.
  async _manualRecoveryFreshDockRearmProof() {
    const device = this.device;
    const setResult = (result, latest = device?._mowerBinaryDiag, age = null, reads = 0) => {
      this._manualRecoveryDockRearmLast = {
        at: Date.now(), result, reads,
        dock: latest?.dockingState || 'unknown',
        undock: latest?.undocking ?? null,
        charging: latest?.chargingLive === true,
        ageMs: age != null && age >= 0 ? age : null,
      };
      this.log('MANUAL RECOVERY read-only physical dock verification',
        `result=${result} reads=${reads} dock=${latest?.dockingState || 'missing'}`,
        `undock=${latest?.undocking ?? '-'} charge=${latest?.chargingLive === true ? 1 : 0}`,
        `ageMs=${age == null ? '-' : age}`);
      return result === 'confirmed' || result === 'confirmed_not_charging';
    };
    if (!device || typeof device._refreshNativeDockForStart !== 'function')
      return setResult('native_api_unavailable');
    const validState = d => d?.dockingState === 'IN_STATION'
      && Number(d?.undocking) === 0;
    const observed = [];
    // Two serial, independent getProperties(1:1) calls; NOT two readings of
    // the same cached capability. Native MQTT arriving in between may override
    // a slower cloud response. No PAUSE/START/DOCK or gate pulse is sent.
    for (let i = 0; i < 2; i += 1) {
      const startedAt = Date.now();
      const state = await device._refreshNativeDockForStart({ diagnosticOnly: true }).catch(error => {
        this.log('MANUAL RECOVERY native dock read failed', `sample=${i+1}`,
          error?.message || 'unknown');
        return null;
      });
      const latest = device._mowerBinaryDiag;
      const at = Number(device._mowerBinaryDiagAt || 0);
      const age = Date.now() - at;
      if (!state) return setResult('read_unavailable', latest, age, observed.length);
      if (!latest || at < startedAt - 2000 || age < 0 || age > 10000)
        return setResult('no_native_frame', latest, age, observed.length);
      const sample = { state, latest, at };
      observed.push(sample);
      if (state.dockingState !== 'IN_STATION' || Number(state.undocking) !== 0
          || latest.dockingState !== 'IN_STATION' || Number(latest.undocking) !== 0)
        return setResult('dock_not_locked', latest, age, observed.length);
      if (!validState(state) || !validState(latest))
        return setResult('dock_changed_during_check', latest, age, observed.length);
    }
    // Both requested native reads independently returned the fully latched
    // station state. Any intervening newer undock/charge loss invalidates it.
    const newest = device._mowerBinaryDiag;
    const age = Date.now() - Number(device._mowerBinaryDiagAt || 0);
    if (!validState(newest) || age < 0 || age > 10000)
      return setResult('dock_changed_during_check', newest, age, observed.length);
    // Native docking is independent of live charging (a full mower may stop
    // charging). Explicitly report the distinction for operator feedback.
    // Station proof does not mean a held native task was abandoned.
    return setResult(newest.chargingLive === true ? 'confirmed' : 'confirmed_not_charging', newest, age, observed.length);
  }

  // A mower which has rolled millimetres off its charge contacts can never
  // pass dock-only rearm. Give the operator a separate, explicit EXIT from
  // automatic command interception after visually confirming an open passage.
  // The emergency latch remains active; this is NOT automatic rearm.
  async manualRecoveryOperatorTakeover(supervised = false) {
    // The control-mode switch itself does not move either motor. Requiring a
    // gate OPEN proof here caused the rescue controls to be unreachable
    // precisely when the gate sensor had failed. Keep OPEN as a prerequisite
    // of the separate native DOCK/departure command, not of entering MANUAL.
    const accepted = await this.beginOperatorManualControl(supervised);
    if (accepted) this.log('MANUAL RECOVERY takeover active: gate automation OFF; individual motor commands still interlocked');
    return accepted;
  }

  // The operator can correct the DISPLAYED gate observation independently of
  // the sensor. This never writes garage_door_status, sensor telemetry or
  // allows an automatic motor release. A contradictory fresh sensor edge or
  // newer gate motion invalidates it. Visual observations expire after 10 min.
  manualGateVisualObservation() {
    const observation = this._operatorGateVisual;
    if (!observation || !['open', 'closed'].includes(observation.state)) return null;
    const age = Date.now() - Number(observation.at || 0);
    if (age < 0 || age > 10 * 60 * 1000) return null;
    if (['opening', 'closing'].includes(this.doorState?.())) return null;
    if (Number(this._manualRecoveryGatePulseAt || 0) > observation.at) return null;
    if (Number(this._gateMotionStartedAt || 0) > observation.at) return null;
    if (['open', 'closed'].includes(this._lastSensorContactState)
        && this._lastSensorContactState !== observation.state
        && Number(this._lastSensorContactAt || 0) >= observation.at) return null;
    return { state: observation.state, at: observation.at, source: 'operator_visual' };
  }

  manualGateReportVisual(state, supervised = false) {
    if (supervised !== true || !['open', 'closed'].includes(state)) return false;
    // Preserve the existing emergency restriction: reporting a rescue end
    // position is not allowed while the emergency remains in AUTO.
    if (this._manualRecoveryActive && !this.paused
        && this.device?.getSetting?.('garage_mode_enabled') === true) return false;
    // A report is not a gate command. It can correct an uncertain dashboard
    // during normal operation without ever changing native/sensor telemetry.
    // During emergency it additionally feeds
    // the existing guarded manual recovery sight-check for the same end state.
    const { currentPhysicalEndContact } = require('./NormalbetriebRestore');
    if (['opening', 'closing'].includes(this.doorState?.())
        && !currentPhysicalEndContact(this, state)) return false;
    const now = Date.now();
    const contactAge = now - Number(this._lastSensorContactAt || 0);
    if (this._manualRecoveryActive
        && this._lastSensorContactState === (state === 'open' ? 'closed' : 'open')
        && Number(this._lastSensorContactAt || 0) > 0
        && contactAge >= 0 && contactAge <= (state === 'open' ? 12000 : 120000)) return false;
    if (this._manualRecoveryActive) {
      const allowed = state === 'closed'
        ? this.manualRecoveryDeclareGateClosed(true)
        : this.manualRecoveryConfirmGateOpen(true);
      if (!allowed) return false;
      if (state === 'open') this._manualRecoveryGateClosedAt = 0;
      else this._manualRecoveryOpenConfirmedAt = 0;
    }
    this._operatorGateVisual = {state, at: now};
    this.log('Operator gate visual observation saved', `state=${state}`, 'sensor untouched');
    return true;
  }

  manualGateRevokeVisual() {
    const old = this._operatorGateVisual;
    this._operatorGateVisual = null;
    if (this._manualRecoveryActive && old?.state === 'closed') this._manualRecoveryGateClosedAt = 0;
    if (this._manualRecoveryActive && old?.state === 'open') this._manualRecoveryOpenConfirmedAt = 0;
    this.log('Operator gate visual observation withdrawn');
    return true;
  }

  // Independent human observation for an ambiguous normal dashboard state.
  // Never written to capabilities, hardware, the emergency rearm proof or disk.
  // A later real undocking/movement observation expires it immediately.
  manualDockVisualObservation() {
    const obs = this._operatorDockVisual;
    if (!obs || !Number.isFinite(Number(obs.at))) return null;
    const age = Date.now() - Number(obs.at);
    if (age < 0 || age > 10 * 60 * 1000) return null;
    const d = this.device || {};
    const diagAt = Number(d._mowerBinaryDiagAt || 0);
    if (diagAt > obs.at && d._mowerBinaryDiag &&
        (d._mowerBinaryDiag.dockingState !== 'IN_STATION' || Number(d._mowerBinaryDiag.undocking) !== 0)) return null;
    const statusAt = Number(d._observedMowerStatusAt || 0);
    const status = String(d._observedMowerStatus || '').toLowerCase();
    if (statusAt > obs.at && ['mowing', 'returning', 'leaving', 'mapping', 'remote_control'].includes(status)) return null;
    return { state: 'docked', at: obs.at, source: 'operator_visual' };
  }

  manualDockReportVisual(supervised = false) {
    if (supervised !== true) return false;
    this._operatorDockVisual = {at: Date.now()};
    this.log('Operator reports mower at home; display-only observation; native dock untouched');
    return true;
  }

  manualDockRevokeVisual() {
    this._operatorDockVisual = null;
    this.log('Operator revoked visual mower-home statement');
    return true;
  }

  // User-supplied visual dock status is intentionally distinct from native
  // hardware telemetry. It can be corrected manually without modifying the
  // mower/sensor state or bypassing the independent emergency interlock.
  // Visual statements are editable operator observations, NOT native telemetry.
  // They never call a hardware API or unlock movement on their own.
  manualRecoveryDeclareDocked(supervised = false) {
    if (!this._manualRecoveryActive || supervised !== true) return false;
    this._manualDockOperatorAt = Date.now();
    this.log('MANUAL RECOVERY operator reports docked (visual only; native proof unchanged)');
    return true;
  }

  manualRecoveryRevokeDocked() {
    if (!this._manualRecoveryActive) return false;
    this._manualDockOperatorAt = 0;
    this.log('MANUAL RECOVERY operator revoked visual dock statement');
    return true;
  }

  manualRecoveryDeclareGateClosed(supervised = false) {
    if (!this._manualRecoveryActive || supervised !== true) return false;
    const { inspectClosedPassage } = require('./NormalbetriebRestore');
    const observed = inspectClosedPassage(this, true);
    if (!observed.ok) {
      this._manualRecoveryNormalRestoreLast = { at: Date.now(), result: observed.reason };
      this.log('MANUAL RECOVERY operator CLOSED observation rejected', observed.reason);
      return false;
    }
    this._manualRecoveryGateClosedAt = Date.now();
    this._manualRecoveryOpenConfirmedAt = 0;
    this.log('MANUAL RECOVERY operator visually confirms gate CLOSED; native door contact unchanged');
    return true;
  }

  manualRecoveryRevokeGateClosed() {
    if (!this._manualRecoveryActive) return false;
    this._manualRecoveryGateClosedAt = 0;
    this.log('MANUAL RECOVERY operator revoked visual CLOSED statement');
    return true;
  }

  _manualRecoveryGateClosedProof(maxAgeMs = 10 * 60 * 1000) {
    const at = Number(this._manualRecoveryGateClosedAt || 0);
    const age = Date.now() - at;
    const { inspectClosedPassage } = require('./NormalbetriebRestore');
    return this._manualRecoveryActive && at > 0 && age >= 0 && age <= maxAgeMs
      && Number(this._manualRecoveryGatePulseAt || 0) <= at
      && inspectClosedPassage(this, true).ok === true;
  }

  // Emergency release may also occur with a mower VERIFIED safely OUTSIDE,
  // including a freshly reached native maintenance point. Operator location
  // is only a claim; TWO independent native positions + geometry are required.
  async _manualRecoveryOutdoorRearmProof() {
    const device = this.device;
    const epoch = this._commandToken;
    const gatePulseAt = Number(this._manualRecoveryGatePulseAt || 0);
    const reject = (reason) => {
      this._manualRecoveryOutsideRearmLast = {at: Date.now(), result: reason};
      this.log('MANUAL RECOVERY outdoor rearm denied', reason);
      return false;
    };
    // Keep the sticky emergency latch as the gate, not the operator's AUTO
    // preference (which can be ON while emergency remains active).
    if (!this._manualRecoveryActive || !this._manualRecoveryStationary()
        || this._manualRecoveryMowerCommandBusy || this._manualRecoveryGateCommandBusy
        || ['opening','closing'].includes(this.doorState())
        || !device?._api?.getMowerPosition || !device?.getData?.()?.id)
      return reject('outdoor_stationary_or_api_missing');
    const nativeDock = device._mowerBinaryDiag;
    const dockAge = Date.now() - Number(device._mowerBinaryDiagAt || 0);
    if (!nativeDock || dockAge < 0 || dockAge > 15000
        || nativeDock.dockingState !== 'OUT_OF_STATION' || Number(nativeDock.undocking) !== 0)
      return reject('outdoor_native_dock_not_verified');
    const targetIndex=Number(this._manualMaintenanceTargetReachedIndex || 0);
    const arrivalAt=targetIndex===1 ? Number(this._lastMaintenanceReachedAt||0)
      : Number(this._lastAdditionalMaintenanceReached?.index)===targetIndex
        ? Number(this._lastAdditionalMaintenanceReached?.at||0) : 0;
    const nativeArrival=Number.isInteger(targetIndex) && targetIndex>=1 && targetIndex<=5
      && this._manualMaintenanceReached === true && this._manualMaintenancePhase === 'reached'
      && arrivalAt>0 && Date.now()-arrivalAt>=0 && Date.now()-arrivalAt<=10*60*1000;
    if (!nativeArrival && this._manualOperatorPosition !== 'outside')
      return reject('outside_observation_or_waypoint_required');
    const point=nativeArrival
      ? await Promise.resolve(device._resolveNativeMaintenancePoint?.(targetIndex)).catch(()=>null)
      : null;
    if (nativeArrival && (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))))
      return reject('waypoint_coordinates_missing');
    const fetch = async () => {
      const started=Date.now();
      const p=await device._api.getMowerPosition(device.getData().id).catch(()=>null);
      if (!Number.isFinite(Number(p?.x)) || !Number.isFinite(Number(p?.y))) return null;
      return {x:Number(p.x),y:Number(p.y),source:'siid:1:4',ts:Date.now(),requestedAt:started};
    };
    const first=await fetch();
    if (first) await new Promise(resolve => setTimeout(resolve, 900));
    const second=first ? await fetch() : null;
    if (!first || !second || this._distance(first,second)>250
        || !this._manualRecoveryStationary() || epoch !== this._commandToken
        || !this._manualRecoveryActive || gatePulseAt !== Number(this._manualRecoveryGatePulseAt || 0)
        || ['opening','closing'].includes(this.doorState())) return reject('outdoor_native_position_pair_missing_or_moving');
    if (nativeArrival && this._distance(second,point)>MAINTENANCE_CONFIRM_RADIUS_MM)
      return reject('outdoor_waypoint_geometry_mismatch');
    const danger=await this.markers?.rawDangerState?.(second).catch(()=>null);
    if (!danger?.known || danger.inside === true
        || !Number.isFinite(Number(danger.distance)) || !Number.isFinite(Number(danger.radius))
        || Number(danger.distance)-Number(danger.radius) <= MANUAL_GATE_MIN_DANGER_CLEARANCE_MM)
      return reject('outdoor_danger_area_not_clear');
    const [distance,line,direction]=await Promise.all([
      this.markers?.distanceToSafetyLineSegment?.(second),
      this.markers?.signedDistanceToLine?.(second),
      this.markers?.directionState?.(),
    ]).catch(()=>[null,null,null]);
    if (!Number.isFinite(Number(distance)) || Number(distance)<=MANUAL_GATE_MIN_SAFETY_LINE_DISTANCE_MM
        || !direction?.known || ![-1,1].includes(Number(direction.lawnSide))
        || !Number.isFinite(Number(line?.distance))
        || Number(line.distance)*Number(direction.lawnSide)<=0)
      return reject('outdoor_safety_line_not_clear');
    const dock=device._dockPos;
    if (!dock || !Number.isFinite(this._distance(second,dock))
        || this._distance(second,dock)<1500) return reject('outdoor_dock_distance_not_clear');
    const currentDock=device._mowerBinaryDiag;
    const age=Date.now()-Number(device._mowerBinaryDiagAt||0);
    if (age<0 || age>15000 || currentDock?.dockingState!=='OUT_OF_STATION'
        || Number(currentDock?.undocking)!==0 || epoch!==this._commandToken
        || gatePulseAt!==Number(this._manualRecoveryGatePulseAt||0)
        || !this._manualRecoveryActive) return reject('outdoor_dock_changed');
    this._manualRecoveryOutsideRearmLast={at:Date.now(),result:'verified',
      index:nativeArrival?targetIndex:null,source:nativeArrival?'native_waypoint_and_position':'operator_outside_and_native_position',
      position:{x:second.x,y:second.y}};
    this.log('MANUAL RECOVERY outdoor rearm VERIFIED with paired native positions',
      this._manualRecoveryOutsideRearmLast.source,`P${nativeArrival?targetIndex:'-'}`);
    return true;
  }

  // One-click recovery from an already physically docked mower with a CLOSED
  // gate. The user supplies an explicit visual statement; it is not a sensor.
  // Every normal automatic movement must still satisfy the native door guards.
  async manualRecoveryRestoreNormal(supervisedClosed = false) {
    const { inspectGatePassage } = require('./NormalbetriebRestore');
    const openConfirmed = this._manualRecoveryGateOpenProof();
    const state = openConfirmed ? 'open' : 'closed';
    const visualProof = state === 'open' ? openConfirmed
      : (supervisedClosed === true || this._manualRecoveryGateClosedProof());
    const before = inspectGatePassage(this, state, visualProof);
    if (!before.ok) {
      this._manualRecoveryNormalRestoreLast = {at: Date.now(), result: before.reason};
      this.log('MANUAL RECOVERY normal restore refused', before.reason);
      return false;
    }
    const result = await this.manualRecoveryRearmAutomation({
      closedPassageCheck: () => inspectGatePassage(this, state,
        state === 'open' ? this._manualRecoveryGateOpenProof()
          : (supervisedClosed === true || this._manualRecoveryGateClosedProof())),
    });
    this._manualRecoveryNormalRestoreLast = {at: Date.now(), result: result ? 'confirmed' : this._manualRecoveryDockRearmLast?.result || 'unconfirmed', gateEvidence: before.evidence};
    return result;
  }

  async manualRecoveryRearmAutomation({ closedPassageCheck } = {}) {
    if (!this._manualRecoveryActive) return false;
    if (this._manualRecoveryMowerCommandBusy || this._manualRecoveryGateCommandBusy) {
      this._manualRecoveryDockRearmLast = {at:Date.now(),result:'active_navigation'};
      return false;
    }
    // A stuck old Homey transit flag is not a physical movement. Native 2/2
    // station proof below has final authority; it does not send a motor pulse.
    const { currentPhysicalEndContact } = require('./NormalbetriebRestore');
    const stableGateContact = currentPhysicalEndContact(this, 'closed')
      || currentPhysicalEndContact(this, 'open');
    if (this._emergencyTransitionPromise
        || (['opening', 'closing'].includes(this.doorState()) && !stableGateContact)) {
      this._manualRecoveryDockRearmLast = {at:Date.now(),result:'gate_moving'};
      return false;
    }
    // Stale cloud RETURNING/IDLE frames and an expired home-close settling
    // window must not prevent safe supervised recovery at the station. However
    // charging capability alone can NEVER satisfy this proof.
    // Choose a verified station OR a geometrically safe outdoor rearm. Never
    // interpret a visual location click as GPS or a native station contact.
    const mode = await this._manualRecoveryFreshDockRearmProof() ? 'dock'
      : await this._manualRecoveryOutdoorRearmProof() ? 'outside' : null;
    if (!mode) {
      this._manualRecoveryNormalRestoreLast={at:Date.now(),result:this._manualRecoveryOutsideRearmLast?.result||'location_unverified'};
      return false;
    }
    // The subsequent persistent writes may take time: reject a contradictory
    // late native undock edge before lifting the last sticky safety bit.
    const stillNativeDocked = () => {
      const d = this.device?._mowerBinaryDiag;
      const age = Date.now() - Number(this.device?._mowerBinaryDiagAt || 0);
      if (age < 0 || age > 10000) return false;
      if (mode === 'dock') return d?.dockingState === 'IN_STATION' && Number(d?.undocking) === 0;
      return d?.dockingState === 'OUT_OF_STATION' && Number(d?.undocking) === 0
        && this._manualRecoveryStationary()
        && Date.now()-Number(this._manualRecoveryOutsideRearmLast?.at||0)<10000;
    };
    if (!stillNativeDocked()) {
      this._manualRecoveryDockRearmLast = {at:Date.now(),result:'dock_changed_during_check',reads:2};
      return false;
    }
    if (closedPassageCheck) {
      const passage = closedPassageCheck();
      if (!passage.ok) {
        this._manualRecoveryNormalRestoreLast = {at:Date.now(),result:passage.reason};
        return false;
      }
    }
    if (!this._manualRecoveryActive || this._manualRecoveryMowerCommandBusy
        || this._manualRecoveryGateCommandBusy || this._emergencyTransitionPromise
        || (['opening', 'closing'].includes(this.doorState()) && !stableGateContact)) return false;
    // This is solely an explicit user rearm after fresh physical dock/charge
    // proof. It does not open/close the gate or start the mower.
    // Keep both in-memory interlocks held until durable Store updates have
    // succeeded. Commit the persistent release bits LAST, in the safe order.
    if (typeof this.device?.setStoreValue !== 'function') return false;
    await Promise.all([
      this.device.setStoreValue('garage_manual_verified_arrival', null),
      this.device.setStoreValue('garage_manual_return_pending', false),
      this.device.setStoreValue('garage_manual_return_attempts', 0),
      this.device.setStoreValue('garage_manual_return_dispatch_after', 0),
      this.device.setStoreValue('garage_manual_return_failure', ''),
    ]);
    // Write the operator ON preference before releasing either sticky safety
    // bit; recovery_active is LAST. On write failure, persist both safety bits
    // back to true best-effort, rather than leaving a half-rearmed restart.
    try {
      await this.device.setStoreValue('garage_operator_paused', false);
      await this.device.setStoreValue('garage_manual_gate_stopped', false);
      if (!stillNativeDocked()) {
        this._manualRecoveryDockRearmLast = {at:Date.now(),result:'dock_changed_during_check',reads:2};
        throw new Error('Native station changed during emergency release');
      }
      if (closedPassageCheck) {
        const passage = closedPassageCheck();
        if (!passage.ok) {
          this._manualRecoveryNormalRestoreLast = {at:Date.now(),result:passage.reason};
          throw new Error(`Gate changed during normal restore: ${passage.reason}`);
        }
      }
      await this.device.setStoreValue('garage_manual_recovery_active', false);
      await this.device.setStoreValue('garage_manual_operator_free', false);
    } catch (error) {
      await Promise.allSettled([
        this.device.setStoreValue('garage_manual_recovery_active', true),
        this.device.setStoreValue('garage_manual_gate_stopped', true),
      ]);
      if (this._manualRecoveryDockRearmLast?.result !== 'dock_changed_during_check')
        this._manualRecoveryDockRearmLast = {at:Date.now(),result:'persist_failed',reads:2};
      throw error;
    }
    this._stopManualReturnWatch();
    this._manualRecoveryActive = false;
    this._manualRecoveryOperatorFree = false;
    this._commandToken += 1; // invalidate stale callbacks from the previous manual/return cycle
    this._outbound = null;
    this._manualMaintenanceTransit = false;
    this.paused = false;
    this._manualRecoveryPhase = null;
    this._manualOperatorPosition = 'unknown';
    this._manualRecoveryStoredArrival = null;
    this._manualReturnAttempt = 0;
    this._manualReturnDispatchUncertainUntil = 0;
    this._manualReturnFailureReason = '';
    // Two independent native reads also reconcile local HOME state for the
    // next normal automatic cycle, without manufacturing a charging signal.
    this._confirmedNativeStationLock = mode === 'dock';
    this._confirmedNativeStationAt = mode === 'dock' ? Date.now() : 0;
    this._homeState = mode === 'dock' ? 'home' : 'away';
    this._missionOutside = mode === 'outside';
    this._safeReturnInProgress = false;
    this._returnGuardActive = false;
    this._returnContext = RETURN_STATES.HOME_CONFIRMED;
    this._manualRecoveryOpenConfirmedAt = 0;
    this._manualRecoveryGateClosedAt = 0;
    this._manualDockOperatorAt = 0;
    this._manualGateStopped = false;
    this._emergencyGateContext = null;
    this._emergencyHoldUntil = 0;
    clearTimeout(this._emergencyRecoveryWatchdog); this._emergencyRecoveryWatchdog = null;
    await this.clearSafety('manual_recovery_dock_verified_rearmed').catch(() => {});
    this.log('MANUAL RECOVERY rearmed after independent native proof',mode);
    return true;
  }

  async _reportEmergencyRecoveryBlocked(context, reason = 'unconfirmed') {
    if (!context || context.recoveryReported || this._emergencyGateContext !== context) return;
    context.recoveryReported = true;
    await this._enterManualRecovery(reason);
    const code = `emergency_manual_recovery_required_${reason}`;
    this.log('EMERGENCY recovery needs explicit safe clearance', reason);
    // safetyBlock() deliberately suppresses secondary notifications during
    // emergencies. Publish ONE actionable state change instead, no motor pulse.
    await this._setSafetyStatus('emergency', code).catch(() => {});
    try {
      this._timeline(this._text(
        'NOTFALL: Automatische Wiederaufnahme nicht sicher bestätigt. Tor und Mäher prüfen; sichere manuelle Freigabe erforderlich.',
        'EMERGENCY: Automatic recovery could not be verified safely. Check gate and mower; manual clearance required.'),
        `emergency:manual_recovery:${context.createdAt || 0}`);
    } catch (error) { this.log('EMERGENCY timeline unavailable', error?.message || String(error)); }
    try { this._trigger('garage_position_uncertain', code); }
    catch (error) { this.log('EMERGENCY notification unavailable', error?.message || String(error)); }
  }

  async _dispatchEmergencyMaintenance(reason) {
    // A native arrival / gate callback may be repeated or race the 2-second
    // watcher. Exactly ONE native maintenance dispatch owns each emergency.
    const context = this._emergencyGateContext;
    if (context) {
      if (context.maintenanceDispatchStarted) {
        this.log('EMERGENCY duplicate maintenance dispatch suppressed', reason || '');
        return context.maintenanceDispatchPromise || false;
      }
      context.maintenanceDispatchStarted = true;
      const operation = this._dispatchEmergencyMaintenanceOnce(reason);
      context.maintenanceDispatchPromise = operation;
      try {
        const accepted = await operation;
        if (!accepted && this._emergencyGateContext === context) {
          await this._reportEmergencyRecoveryBlocked(context, 'maintenance_dispatch_failed');
        }
        return accepted;
      } finally { context.maintenanceDispatchPromise = null; }
    }
    return this._dispatchEmergencyMaintenanceOnce(reason);
  }

  async _dispatchEmergencyMaintenanceOnce(reason) {
    if (this._manualGateStopped) return false;
    const token = this._commandToken;
    await this._lockReturnMaintenancePoint(`emergency_${reason || 'danger'}`);
    this._manualMaintenanceTargetIndex = Number(this._lockedReturnMaintenancePoint?.index || 1);
    if (!this._lockedReturnMaintenancePoint) {
      await this.safetyBlock('emergency_maintenance_point_unavailable');
      return false;
    }

    // Important parity with normal return: if the mower is ALREADY at the
    // verified, stationary maintenance point, never send opcode 109 again just
    // to manufacture another arrival event. Some firmware emits no new arrival
    // acknowledgement for a no-op trip; the old emergency path then timed out
    // and escalated although the mower was already in the safe waiting place.
    // Re-use exactly the same physical clearance proof as the normal return path.
    if (await this._isCurrentlyAtKnownMaintenancePoint().catch(() => false)) {
      this.log('EMERGENCY maintenance dispatch skipped: already at verified maintenance point', reason || 'danger');
      if (this._emergencyGateContext) {
        return this._restoreEmergencyPlanAfterMaintenance(reason || 'danger');
      }
      this._pendingEmergencyMaintenanceReason = null;
      this._emergencyHoldUntil = 0;
      await this.safetyWarning('emergency_already_at_maintenance_hold').catch(() => {});
      return true;
    }

    if (typeof this.device._goToMaintenancePointGuarded === 'function') {
      const accepted = await this.device._goToMaintenancePointGuarded(`emergency_${reason || 'danger'}`).catch((e) => { this.error('emergency maintenance command', e.message); return false; });
      if (accepted === false || token !== this._commandToken) { await this.safetyBlock('emergency_maintenance_command_failed'); return false; }
    } else if (typeof this.device.cmdGoToMaintenancePoint === 'function') {
      const accepted = await this.device.cmdGoToMaintenancePoint().catch((e) => { this.error('emergency maintenance command', e.message); return false; });
      if (accepted === false || token !== this._commandToken) { await this.safetyBlock('emergency_maintenance_command_failed'); return false; }
    } else { await this.safetyBlock('emergency_maintenance_api_missing'); return false; }
    this._watchMaintenanceReached(async () => {
      if (token !== this._commandToken) return;
      if (this._emergencyGateContext) {
        await this._restoreEmergencyPlanAfterMaintenance(reason).catch((e) => this.error('emergency restore original plan', e.message));
        return;
      }

      // No recovery context should normally be possible because
      // _sendMowerToMaintenanceForEmergency captures one before changing state.
      // If it is nevertheless missing, fail safe: keep the mower at the verified
      // maintenance point instead of manufacturing a return/dock mission.
      this.log('EMERGENCY: maintenance point reached without recovery context; holding position');
      this._pendingEmergencyMaintenanceReason = null;
      this._emergencyHoldUntil = 0;
      await this.safetyWarning('emergency_recovery_context_missing_hold').catch(() => {});
    }, async () => {
      this.log('emergency maintenance point timeout');
      if (this._emergencyGateContext) await this._reportEmergencyRecoveryBlocked(this._emergencyGateContext, 'maintenance_timeout');
      else await this.safetyBlock('emergency_maintenance_timeout');
    });
    return true;
  }

  async _sendMowerToMaintenanceForEmergency(reason, opts = {}) {
    if (this._manualGateStopped) return false;
    // Capture the interrupted gate target + mower mission BEFORE mutating the
    // return/outbound state below. This also covers non-moving-gate emergencies
    // (for example a genuine return reaching a closed gate), so recovery never
    // has to guess what should happen after the maintenance point is verified.
    if (!this._emergencyGateContext) this._captureEmergencyGateContext(null, reason || 'garage_emergency');
    this._emergencyHoldUntil = Date.now() + EMERGENCY_HOLD_MS;
    this._safeReturnInProgress = false;
    this._returnGuardActive = false;
    this._outbound = null;
    this._outboundHardLockUntil = 0;
    this._closeAfterExitRequested = false;
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._setReturnContext(RETURN_STATES.MAINTENANCE, `emergency_${reason || 'danger'}`);
    this.lastRequestedAction = `EMERGENCY_MAINTENANCE_${reason || 'danger'}`;
    this._gateMotionPauseMode = 'emergency';
    await this._pauseMowerForGateInterlock('emergency', `emergency_${reason || 'danger'}`).catch(() => {});
    // Motion emergencies may dispatch P1 only after the sequencer has completed
    // the reversal wait and verified PAUSE. Never let a generic OPEN event jump in.
    if (opts.gateSettled) {
      this._pendingEmergencyMaintenanceReason = null;
      return this._dispatchEmergencyMaintenance(reason || 'danger');
    }
    if (!this.isDoorOpenStable()) {
      this._pendingEmergencyMaintenanceReason = reason || 'danger';
      this.log('emergency maintenance queued until gate stable open', reason || 'danger');
      return;
    }
    await this._dispatchEmergencyMaintenance(reason || 'danger');
  }

  async _executeMovingGateEmergency(moving, reason = '') {
    if (this._manualGateStopped) return false;
    if (this._emergencyTransitionPromise || this._emergencyGateContext) {
      this.log('EMERGENCY duplicate moving-gate edge ignored', moving);
      return false;
    }
    const token = this._commandToken;
    this._emergencyReverseAt = Date.now();
    const context = this._captureEmergencyGateContext(moving, reason);
    this._emergencyHoldUntil = Date.now() + EMERGENCY_HOLD_MS;
    const reverseTo = moving === 'opening' ? 'close' : 'open';
    const pauseRequestedAt = Date.now();
    await this.emergency(`mower_in_danger_area_while_gate_${moving}`,
      `pause_reverse_${reverseTo}_wait_then_maintenance`);
    // The interlock stays latched throughout both native and physical gate waits.
    this._gateMotionPauseMode = 'emergency';
    // Dispatch PAUSE and the single gate reversal without waiting for a cloud
    // PAUSE acknowledgement first: the gate motor may already be moving toward
    // the mower. Both operations are independently checked before navigation.
    const pauseDispatch = this._pauseMowerForGateInterlock('emergency', `gate_${moving}_danger`);
    if (token !== this._commandToken || this._manualGateStopped) return false;
    const reversed = await this._forceDoorDirectionForEmergency(reverseTo,
      `emergency_gate_${moving}_danger_reverse_${reverseTo}`);
    const paused = await pauseDispatch;
    if (!reversed || token !== this._commandToken || this._manualGateStopped) {
      await this.safetyBlock('emergency_gate_reverse_not_sent');
      await this._reportEmergencyRecoveryBlocked(context, 'emergency_gate_reverse_not_sent');
      return false;
    }
    // Gate reversal can take 10-30+ seconds. Collect mower standstill evidence
    // CONCURRENTLY with gate completion, not only afterwards: an authentic
    // PAUSED MQTT edge could otherwise become "too old" during the motor wait.
    // Both independent conditions must still finish before P1 is dispatched.
    // A pre-emergency return-line proof is never transferable to this incident.
    this._returnLineStopProof = null;
    const gateSettlement = this._waitForEmergencyGateTarget(
      reverseTo === 'close' ? 'closed' : 'open', 'emergency_reverse_wait', { alreadyRequested: true });
    const nativePauseEvidence = paused
      ? this._waitForNativePause(token, pauseRequestedAt,
        RETURN_NATIVE_PAUSE_ACK_TIMEOUT_MS, 'emergency').catch((error) => {
        this.error('EMERGENCY pause verification failed', error?.message || String(error));
        return false;
      })
      : Promise.resolve(false);
    const settled = await gateSettlement;
    if (!settled || token !== this._commandToken || this._manualGateStopped) {
      await this.safetyBlock('emergency_gate_end_state_unconfirmed');
      await this._reportEmergencyRecoveryBlocked(context, 'emergency_gate_end_state_unconfirmed');
      this.log('EMERGENCY evacuation withheld: reversal not completed', moving);
      return false;
    }
    const nativeStopped = await nativePauseEvidence;
    // A later real MOWING/RETURNING report supersedes the earlier PAUSED proof.
    // Do not use an old pause acknowledgement if the original app resumed the
    // mower while the garage was completing its travel.
    const lastNative = String(this.device?._observedMowerStatus || '').toLowerCase();
    const lastNativeAt = Number(this.device?._observedMowerStatusAt || 0);
    const resumedDuringGateWait = lastNativeAt >= pauseRequestedAt
      && ['mowing', 'returning', 'leaving', 'mapping', 'remote_control'].includes(lastNative);
    if (!nativeStopped || resumedDuringGateWait || token !== this._commandToken || this._manualGateStopped) {
      await this.safetyBlock('emergency_mower_pause_unconfirmed');
      await this._reportEmergencyRecoveryBlocked(context, 'emergency_mower_pause_unconfirmed');
      this.log('EMERGENCY evacuation withheld: mower standstill not confirmed',
        resumedDuringGateWait ? `later_motion=${lastNative}` : 'no_native_pause_proof');
      return false;
    }
    // A reversal of an OPENING gate leaves it CLOSED. Do not command opcode
    // 109 blindly: the physical route to the maintenance point may cross that
    // closed gate. Stay stopped in the latched emergency for supervised rescue.
    if (reverseTo === 'close') {
      this.log('EMERGENCY: reversal ended CLOSED; maintenance navigation withheld until a safe open passage is proven');
      await this.safetyBlock('emergency_closed_gate_maintenance_requires_supervision');
      await this._reportEmergencyRecoveryBlocked(context, 'emergency_closed_gate_maintenance_requires_supervision');
      return false;
    }
    this.log('EMERGENCY gate reverse finished; starting guarded maintenance evacuation',
      `from=${moving}`, `target=${reverseTo}`);
    return this._sendMowerToMaintenanceForEmergency(`gate_${moving}_danger`, { gateSettled: true });
  }

  async _handleOpeningGateDangerEvacuation(reason = '') {
    if (this._emergencyTransitionPromise || this._emergencyGateContext) return true;
    const run = this._executeMovingGateEmergency('opening', reason);
    this._emergencyTransitionPromise = run;
    try { return await run; }
    finally { if (this._emergencyTransitionPromise === run) this._emergencyTransitionPromise = null; }
  }

  async _handleMovingDoorDangerEmergency(moving, reason = '') {
    if (this._emergencyTransitionPromise || this._emergencyGateContext) return true;
    const run = this._executeMovingGateEmergency(moving, reason);
    this._emergencyTransitionPromise = run;
    try { return await run; }
    finally { if (this._emergencyTransitionPromise === run) this._emergencyTransitionPromise = null; }
  }

  async _expectedOpeningDangerOccupancy() {
    // Opening the garage while the mower is intentionally stationary inside is
    // normal for a start. Likewise, a verified maintenance point is a deliberate
    // safe waiting position for a return. These are OCCUPANCY cases, not a new
    // ENTRY into the moving-gate danger area. Keep the exemption narrow: a stale
    // persisted home flag alone must never suppress an opening emergency after an
    // app restart while the mower is actually moving.
    const st = String(this.status() || '').toLowerCase();
    const liveBinary = this.device?._mowerBinaryDiag;
    const binaryAge = Date.now() - Number(this.device?._mowerBinaryDiagAt || 0);
    const freshDeparture = !!liveBinary && binaryAge >= 0 && binaryAge <= 15000
      && (liveBinary.dockingState === 'OUT_OF_STATION' || Number(liveBinary.undocking) === 1);
    // Some A2 installations report CHARGING before their first binary dock
    // packet. Accept recent positive charging telemetry, not persisted HOME.
    const stationaryHome = !this._missionOutside && !freshDeparture
      && !['mowing', 'leaving', 'returning'].includes(st)
      && (this._freshStationHoldProof(15000) || this._freshChargingDockProof(15000));
    if (stationaryHome) return true;

    if (this._outbound && !this._outbound.released && stationaryHome
        && ['paused', 'idle', 'standby', 'docked', 'charging', 'charging_completed'].includes(st)) return true;

    if (this.isReturnCycleActive()) {
      const atMaintenance = await this._verifiedMaintenanceReturnClearance().catch(() => false);
      if (atMaintenance && ['paused', 'idle', 'standby'].includes(st)) return true;
    }
    return false;
  }

  async requestOpen(reason, opts = {}) {
    if (this._emergencyCommandBlocked(`open:${reason}`) && !opts.emergencyReverse && !opts.allowEmergencyResume) return false;
    const gateToken = this._commandToken;
    if (this._manualGateStopped) { await this.safetyWarning('manual_gate_stop_hold'); return false; }
    if (this._emergencyHoldActive() && !opts.emergencyReverse && !opts.allowEmergencyResume) {
      const atMaintenance = (this._lastMaintenanceReachedAt && Date.now() - this._lastMaintenanceReachedAt < RETURN_MAINTENANCE_ARRIVAL_REUSE_MAX_MS) || await this.isAtMaintenancePointHeuristic().catch(() => false);
      const danger = await this.markers.dangerState().catch(() => ({ inside: true }));
      const returnOrMaintenanceOpen = this._safeReturnInProgress || this._returnGuardActive || this._returnContext === RETURN_STATES.MAINTENANCE;
      if (!(returnOrMaintenanceOpen && atMaintenance && danger && !danger.inside)) {
        this.log('open blocked: emergency hold active', reason || 'open');
        await this.safetyWarning('open_blocked_emergency_hold');
        return false;
      }
    }
    this.log('request open', reason, 'door=', this.doorState(), 'home=', this._homeState);
    const isInboundOpen = (this._safeReturnInProgress || this._returnGuardActive
      || (this._returnContext && this._returnContext !== RETURN_STATES.IDLE
        && this._returnContext !== RETURN_STATES.HOME_CONFIRMED)) && !this._outbound;
    if (isInboundOpen && !opts.emergencyReverse && this.doorState() !== 'open') {
      // Do not open a physical lifting gate merely because RETURNING was seen.
      // In the reported incident it arrived while the mower was already at the
      // closed gate. Old code exempted *all* returns from the danger-area check,
      // including allowOpenFromDanger=true from the maintenance shortcut.
      // Only the dedicated direct-return line/current-position waiter uses
      // these exact internal reasons. UI/manual OPEN cannot borrow STOP proof.
      const verifiedZoneStop = ['return_current_position_gate_wait','return_safety_line_wait'].includes(String(reason || ''))
        && this._returnZoneTaskStoppedToken === gateToken
        && this._returnRecoveryRequest?.token === gateToken
        && this._returnRecoveryRequest?.routeDecision?.mode === 'direct'
        && this._returnLineStopProof?.kind === 'native_checkpoint_stop';
      // The pre-gate native twin-read and IDLE are a fresh physical witness.
      // Re-run the proof at the FINAL opening guard, not only in the caller.
      // Only this strictly token-scoped STOP pathway may bypass the old MQTT
      // timestamp; any contradictory movement/position denies OPEN as usual.
      // 2026-10-31 field replay: the early gate OPEN is attempted AFTER native
      // STOP/IDLE and paired stationary SIID reads, but BEFORE MAPD finishes.
      // _returnZoneDirectStopProof is deliberately written only AFTER MAPD;
      // using the later witness here gave routeProof=0 and latched emergency
      // even though the early checkpoint already had independent evidence.
      // This narrow, internal-only pathway rechecks the actual native status
      // and position. It never authorizes a motor restart or zone write.
      const earlyZoneOpening = String(reason || '') === 'return_zone_verified_stop_parallel_open';
      const earlyStopCheckpoint = earlyZoneOpening
        && this._returnZoneStopProof?.token === gateToken
        && this._returnZoneStopProof?.statusCode === 2
        && this._returnRecoveryRequest?.token === gateToken
        && this._returnRecoveryRequest?.routeDecision?.mode === 'direct'
        && this._returnLineStopProof?.token === gateToken
        && this._returnLineStopProof?.kind === 'native_pause'
        && this._returnGuardActive === true && this._safeReturnInProgress === true;
      const earlyWitness = earlyStopCheckpoint
        && await this._tryNativePauseReturnClearance(gateToken)
        ? this._returnLineStopProof?.position : null;
      const nativeWitness = verifiedZoneStop &&
        await this._confirmNativeZoneStopDirectGateClearance(gateToken)
        ? this._returnZoneDirectStopProof?.position : earlyWitness;
      if (verifiedZoneStop && !nativeWitness) {
        this.log('[return-origin] gate opening BLOCKED: native stationary witness expired');
        await this.returnOperationalHold('return_gate_open_clearance_unconfirmed');
        return false;
      }
      const pos = nativeWitness || this.pos();
      const age = Date.now() - Number(pos?.ts || 0);
      const raw = await this.markers.rawDangerState(pos).catch(() => null);
      const clearanceKnown = !!pos?.ts && age >= 0 && age <= RETURN_OPEN_POSITION_MAX_AGE_MS
        && !!raw?.known && Number.isFinite(Number(raw.radius)) && Number.isFinite(Number(raw.distance))
        && Number(raw.distance) > Number(raw.radius) + RETURN_GATE_CLEARANCE_MM;
      let routeProof = false;
      const openingReason = String(reason || '').toLowerCase();
      if (nativeWitness) {
        routeProof = true; // already independently certified native STOP + safe raw distance
      } else if (openingReason === 'return_maintenance_transit_early_open') {
        routeProof = await this._maintenanceTransitEarlyOpenSafe(gateToken);
      } else if (openingReason.includes('maintenance')) {
        routeProof = await this._verifiedMaintenanceReturnClearance();
      } else if (openingReason.includes('line_wait')) {
        const stopProofFresh = !!this._returnLineStopProof
          && Date.now() - Number(this._returnLineStopProof.at || 0) >= 0
          && Date.now() - Number(this._returnLineStopProof.at || 0) <= 20000;
        // Once the dedicated line-wait handler has physically proved standstill,
        // do not require a second, potentially stale/debounced side classification.
        // `clearanceKnown` below still requires a fresh raw position safely outside
        // the moving-gate danger radius before motor movement is allowed.
        routeProof = stopProofFresh;
      } else {
        // Direct return may open the gate in parallel only while the mower is
        // demonstrably FAR from the gate. Near/unclear positions must detour
        // through a verified stationary maintenance arrival instead.
        const dock = this.device._dockPos || this.device._cachedMapData?.chargerPos;
        const dockDistance = this._distance(pos, dock);
        const speed = this._speedMetersPerSecond();
        const openingLeadMm = Number(speed?.mps) * 1000
          * (Math.max(this._doorOpenDurationSeconds(), this._doorDelaySeconds()) + RETURN_DOOR_ETA_RESERVE_SECONDS);
        routeProof = dockDistance !== null && dockDistance >= Math.max(
          RETURN_DIRECT_MIN_DOCK_DISTANCE_MM, Number.isFinite(openingLeadMm) ? openingLeadMm : Number.POSITIVE_INFINITY,
        );
      }
      if (!clearanceKnown || !routeProof) {
        this.log('return gate opening BLOCKED: fresh outside clearance/route proof absent',
          `reason=${reason || '-'}; age=${age}; distance=${raw?.distance ?? '?'}; radius=${raw?.radius ?? '?'}; routeProof=${routeProof ? 1 : 0}`);
        // A speculative EARLY-open optimisation may simply fail this strict
        // recheck. Do not cancel the waypoint navigation on a missing sample;
        // the normal confirmed-arrival handoff remains the fallback.
        // This early OPEN is optional while a zone edit still owns the return
        // token. Its failure MUST NOT terminate a valid native STOP/MAPD
        // transaction or poison the subsequent final gate waiter. The final
        // waiter repeats all physical checks before any new OPEN command.
        if (openingReason !== 'return_maintenance_transit_early_open'
            && openingReason !== 'return_zone_verified_stop_parallel_open')
          await this.returnOperationalHold('return_gate_open_clearance_unconfirmed');
        return false;
      }
    }
    const danger = await this.markers.dangerState();
    const mowerInDanger = !!danger.inside;
    const returnOrMaintenanceOpen = this._safeReturnInProgress || this._returnGuardActive || this._returnContext === RETURN_STATES.MAINTENANCE;
    const securelyHomeForOpening = this.isDockedHomeStatus()
      || (!this._missionOutside && this._homeState === 'home'
        && ['idle', 'standby', 'docked', 'charging', 'charging_completed', 'paused'].includes(String(this.status() || '').toLowerCase()));
    if (mowerInDanger && !opts.emergencyReverse && (!opts.allowOpenFromDanger || !securelyHomeForOpening)) {
      // Absolute rule: a mower immediately in front of / underneath the gate may
      // not cause a stationary gate to start moving. The only normal exception is
      // a securely proven mower parked HOME behind the gate for an outbound start.
      // Emergency reversal remains allowed because it stops an already moving gate.
      this.log('open blocked: mower in danger area and not securely home');
      await this.safetyWarning(this.status() === 'mowing' ? 'open_blocked_mower_mowing_in_danger_area' : 'open_blocked_mower_in_danger_area');
      return false;
    }
    if (this.sensorEnabled() && !this.sensorHealthy() && !opts.emergencyReverse) {
      const reasonText = this.sensorUnhealthyReason() || 'sensor_unhealthy';
      this.log('open uses configured duration because sensor is unavailable', reasonText);
      await this.safetyWarning(`sensor_unhealthy_open_fallback_${reasonText}`);
    }
    if (opts.emergencyReverse && this.sensorEnabled() && !this.sensorHealthy()) {
      const reasonText = this.sensorUnhealthyReason() || 'sensor_unhealthy';
      this.log('EMERGENCY reverse open requested despite unhealthy sensor', reasonText);
      await this.emergency(`emergency_reverse_open_sensor_unhealthy_${reasonText}`, 'reverse_to_open');
    }
    if (gateToken !== this._commandToken || this._manualGateStopped) return false;
    if (String(reason || '') === 'widget_manual_open' && !opts.allowOpenFromDanger
        && !await this._manualGateOutsidePositionProof().catch(() => false)) {
      this.log('manual OPEN blocked on final physical clearance recheck');
      return false;
    }
    // Even if the dashboard still displays OPEN, a new OPEN trigger without
    // a currently verified contact must invalidate old sensor evidence.
    if (this.doorState() !== 'open'
        || (this.sensorEnabled() && !this._doorOpenReleaseVerified())) {
      this._doorOpenTimedFallbackAt = 0;
      this._lastDoorOpenRequestAt = Date.now();
    }
    if (this.doorState() !== 'open') {
      await this.setDoorState('opening', { immediate: true });
    }
    if (gateToken !== this._commandToken || this._manualGateStopped) return false;
    if (String(reason || '') === 'external_start') {
      this.log('[start-latency] gate-flow-requested',
        `fromMqttMs=${this.device?._externalStartTraceUndockAt ? Date.now()-this.device._externalStartTraceUndockAt : 'unknown'}`,
        `fromStopMs=${this._externalStartStopSentAt ? Date.now()-this._externalStartStopSentAt : 'unknown'}`);
    }
    this._trigger('garage_open_requested', reason || 'open');
    this._garageNotice(
      'door_opening',
      this._text('Garagentor öffnet', 'Garage door opening'),
      reason || 'open',
      15000,
    );
    return true;
  }

  async garageSafetyReady() {
    return this.markers.ready();
  }

  async closeGuardReport(reason, opts = {}) {
    const ready = await this.garageSafetyReady();
    const danger = await this.markers.dangerState();
    await this._maybeReleaseResumeGuard(this.status(), danger).catch(() => {});
    const inside = danger.inside;
    if (inside) this._dangerOutsideSince = 0;
    else if (!this._dangerOutsideSince) this._dangerOutsideSince = Date.now();
    const report = {
      reason: reason || 'close',
      ready: ready || (this._lineToLawnConfirmed && this._lineState === LINE_STATES.DOOR_CLOSE_ALLOWED),
      insideDanger: inside,
      dangerDistance: danger.distance === null ? null : Math.round(danger.distance),
      dangerRadius: danger.radius,
      door: this.doorState(),
      sensorHealthy: this.sensorHealthy(),
      lineToLawnConfirmed: !!this._lineToLawnConfirmed,
      lineState: this._lineState,
      requireExitConfirmed: !!opts.requireExitConfirmed,
      outbound: this._outbound ? this._outbound.action : '-',
      home: this._homeState || 'unknown',
      positionKnown: this.positionKnown() && !!this._freshPositionForExitDecision(),
      nativeStatus: this.status(),
    };
    return report;
  }

  _logCloseReport(report, verdict) {
    // Keep the raw report in the developer log, but never dump the JSON object
    // into the Homey timeline. The timeline gets one concise localised line.
    this.device.log('[Garage]', 'close guard', verdict, JSON.stringify(report));
    if (!this._garageOption('garage_logging_enabled') || !this.device.getSetting('garage_mode_enabled')) return;
    if (verdict === 'evaluate') return;
    const reason = this._humanReason(verdict.replace(/^blocked_/, 'close_blocked_'));
    const detail = [
      report.insideDanger ? this._text('Mäher im Gefahrenbereich', 'Mower in danger area') : null,
      !report.positionKnown ? this._text('Position unklar', 'Position unknown') : null,
      report.door && report.door !== 'open' ? `${this._text('Tor', 'Gate')}: ${report.door}` : null,
      report.requireExitConfirmed && !report.lineToLawnConfirmed ? this._text('Sicherheitslinie fehlt', 'Safety-line confirmation missing') : null,
    ].filter(Boolean).join(', ');
    const blocked = verdict.startsWith('blocked') || verdict === 'markers_incomplete_close_disabled';
    const msg = blocked
      ? `${this._text('Schließen blockiert', 'Closing blocked')} – ${reason}${detail ? ` (${detail})` : ''}`
      : verdict === 'close_requested'
        ? `${this._text('Schließen freigegeben', 'Closing permitted')} – ${this._humanReason(report.reason)}`
        : `${this._text('Schließprüfung: Sensor-Fallback', 'Closing check: sensor fallback')} – ${reason}`;
    this._timeline(msg, `close:${verdict}:${report.reason}:${detail}`);
  }

  _maintenanceCloseProtected() {
    const phase = String(this._manualMaintenancePhase || 'idle');
    const activePhase = ['exiting', 'adjusting', 'positioning', 'transit'].includes(phase);
    return !!this._manualMaintenanceTransit || (activePhase && !this._manualMaintenanceReached);
  }

  _maintenanceArrivalCloseAuthorized(opts = {}) {
    return !!opts.maintenanceArrivalVerified
      && this._manualMaintenanceReached === true
      && String(this._manualMaintenancePhase || '') === 'reached'
      && !this._manualMaintenanceTransit;
  }

  async requestClose(reason, opts = {}) {
    if (this._emergencyCommandBlocked(`close:${reason}`) && !opts.emergencyReverse) return false;
    const gateToken = this._commandToken;
    if (this._manualGateStopped) { await this.safetyWarning('manual_gate_stop_hold'); return false; }
    // Absolute maintenance safety: Ausfahrt, Justieren and Fahrt zum
    // Wartungspunkt must never share the doorway with a closing gate. Do not
    // trust a caller-provided option on its own; only the internally latched,
    // verified arrival state may release this guard. Emergency reversal remains
    // the sole exception because it is itself a collision-avoidance action.
    const maintenanceArrivalAuthorized = this._maintenanceArrivalCloseAuthorized(opts);
    // Only the actual outbound PAUSE owner may reuse the pre-pause physical
    // departure proof after an A2 PAUSED/error packet resets the four-hit
    // mowing display. This is NOT a manual-close override: fresh position,
    // independent raw-danger clearance, stopped checkpoint and exit permission
    // remain mandatory both here and at the final motor command.
    const verifiedPausedOutboundClose = opts.controlledOutboundPauseClose === true
      && this._exitPauseForCloseActive && this._exitLifecycleCheckpoint?.departureClearedAtPause === true
      && this.isVerifiedExitLifecycleCheckpoint(90000)
      && this._rawDangerExitConfirmed()
      && opts.requireExitConfirmed === true
      && this._lineToLawnConfirmed && this._lineState === LINE_STATES.DOOR_CLOSE_ALLOWED;
    if (this._maintenanceCloseProtected() && !maintenanceArrivalAuthorized && !opts.emergencyReverse) {
      this.log('close suppressed during protected maintenance phase',
        `${reason || 'close'}; phase=${this._manualMaintenancePhase || 'idle'}`);
      await this.safetyWarning('close_blocked_maintenance_transit_active');
      return false;
    }
    if (this._emergencyHoldActive() && !opts.emergencyReverse) {
      this.log('close blocked: emergency hold active', reason || 'close');
      await this.safetyWarning('close_blocked_emergency_hold');
      return false;
    }
    const doorNow = this.doorState();
    if (doorNow === 'closed') {
      this._closeScheduled = false;
      this._closeCompleted = true;
      this.log('close skipped: door already closed', reason || '');
      return true;
    }
    if (doorNow === 'closing' && !opts.emergencyReverse) {
      // Feinschliff: a close request that is already in progress is successful.
      // Do not produce misleading "Schließen blockiert – Tor bewegt sich" timeline entries.
      this._closeScheduled = false;
      this.log('close skipped: door already closing', reason || '');
      return true;
    }
    const report = await this.closeGuardReport(reason, opts);
    this._logCloseReport(report, 'evaluate');

    // ABSOLUTE INBOUND SAFETY: a native return/error state or any active return
    // context always wins over an old outbound/line confirmation. A mower moving
    // toward the garage must never share the doorway with a closing gate. This
    // also covers autonomous low-battery/standby returns started outside Homey.
    const binary = this.device?._mowerBinaryDiag;
    const binaryAt = Number(this.device?._mowerBinaryDiagAt || 0);
    const freshContradictoryStation = !!binary && binaryAt > 0
      && Date.now() - binaryAt >= 0 && Date.now() - binaryAt <= 15000
      && (binary.dockingState !== 'IN_STATION' || Number(binary.undocking) === 1);
    const strongDockProof = this._strongDockCloseProof();
    const safelyDockedHomeForClose = report.home === 'home'
      && !freshContradictoryStation
      && strongDockProof;

    // A confirmed, stationary native maintenance arrival is a fresh physical
    // checkpoint. Some cloud packets can still lag behind with `returning` for
    // a short time; that stale label must not keep a safe standalone trip's
    // gate open. A live return context, return guard or error state still blocks.
    const staleReturnStatusAtVerifiedMaintenance = maintenanceArrivalAuthorized
      && report.nativeStatus === 'returning';
    const inboundMotionActive = (['returning', 'error'].includes(report.nativeStatus)
      && !staleReturnStatusAtVerifiedMaintenance)
      || this._safeReturnInProgress
      || this._returnGuardActive
      || (this._returnContext && this._returnContext !== RETURN_STATES.IDLE && this._returnContext !== RETURN_STATES.HOME_CONFIRMED);

    // Narrow Priority-3 exception: immediately after OUR explicit outbound pause
    // (5:4), the A2 may publish a transient native `error` before PAUSED. That
    // must not deadlock the intended Pause -> Close -> Resume sequence. This is
    // accepted only for the controlled outbound pause path and only after the
    // lawn-side exit has already been confirmed with a fresh, known position and
    // the mower is outside the danger area. A real `returning` state, any active
    // return context, missing position or danger-area occupancy still blocks.
    const controlledOutboundPauseError = opts.controlledOutboundPauseClose === true
      && this._exitPauseForCloseActive
      && this._closeAfterExitRequested
      && report.requireExitConfirmed
      && report.lineToLawnConfirmed
      && report.lineState === LINE_STATES.DOOR_CLOSE_ALLOWED
      && report.positionKnown
      && !report.insideDanger
      && report.nativeStatus === 'error'
      && !this._safeReturnInProgress
      && !this._returnGuardActive
      && (!this._returnContext || this._returnContext === RETURN_STATES.IDLE || this._returnContext === RETURN_STATES.HOME_CONFIRMED);

    if (controlledOutboundPauseError) {
      this.log('close guard: transient pause error accepted for controlled priority 3 close');
    } else if (inboundMotionActive && !safelyDockedHomeForClose) {
      this._logCloseReport(report, 'blocked_inbound_motion_active');
      await this.safetyWarning('close_blocked_inbound_motion_active');
      return false;
    }

    const homeClose = report.home === 'home' || strongDockProof || reason === 'home_15s';
    const closeDockEpoch = this._homeDockEpoch;
    if (homeClose && !opts.emergencyReverse && !this._homeDockReadyForClose()) {
      await this.safetyWarning('close_waits_for_15s_stable_dock');
      return false;
    }

    // HARD SAFETY: during outbound/start/adjusting the door may only close after
    // the exit line has been confirmed and canCloseAfterExit() has promoted the
    // line state to DOOR_CLOSE_ALLOWED. No fallback, home glitch, maintenance
    // timeout or emergency reverse may bypass this.
    if (this._outboundPhaseProtected() && !opts.emergencyReverse) {
      this._logCloseReport(report, 'blocked_outbound_exiting_adjusting_positioning');
      await this.safetyWarning('close_blocked_departure_or_positioning');
      return false;
    }
    if (this._outboundCloseProtected() && !verifiedPausedOutboundClose && !maintenanceArrivalAuthorized && !opts.manualOutsidePositionVerified) {
      this._logCloseReport(report, 'blocked_outbound_exit_not_confirmed');
      await this.safetyWarning('close_blocked_outbound_exit_not_confirmed');
      return false;
    }

    // Absolute field safety: while the mower is considered outside / in an active
    // mowing mission, the door may not close from stale HOME_CONFIRMED, timeout,
    // maintenance or sensor messages. The only allowed outdoor close path is the
    // explicit exit-line path (requireExitConfirmed + DOOR_CLOSE_ALLOWED). Final
    // docked/charging home close is still allowed below.
    if (this._missionOutside && !safelyDockedHomeForClose && !opts.requireExitConfirmed && !maintenanceArrivalAuthorized && !opts.manualOutsidePositionVerified) {
      this._logCloseReport(report, 'blocked_outdoor_mission_active');
      await this.safetyWarning('close_blocked_outdoor_mission_active');
      return false;
    }

    // Fail-safe: without complete, plausible markers no automatic close is allowed
    // during outbound mowing. Home/docked close is different: once the mower is
    // charging/docked, closing the already-open garage must not depend on marker
    // geometry. This fixes the real test where the mower was charging but the
    // return context/marker state prevented the final close request.
    if (!report.ready && !safelyDockedHomeForClose && !opts.manualOutsidePositionVerified) {
      this._logCloseReport(report, 'markers_incomplete_close_disabled');
      await this.markerSetupWarning('markers_incomplete_close_disabled');
      return false;
    }

    if (report.door === 'opening' || report.door === 'closing') {
      this._logCloseReport(report, 'blocked_door_moving');
      await this.safetyWarning('close_blocked_door_moving');
      return false;
    }
    const closeModeGuard = this._outboundCloseBlockedByMode();
    if (!safelyDockedHomeForClose && closeModeGuard.blocked && !verifiedPausedOutboundClose && !maintenanceArrivalAuthorized && !opts.manualOutsidePositionVerified) {
      this._logCloseReport(report, `blocked_outbound_mode_${closeModeGuard.mode}`);
      await this.safetyWarning('close_blocked_adjusting_active');
      return false;
    }
    if (this.sensorDoorReliable() && report.door === 'unknown') {
      this._logCloseReport(report, 'blocked_door_unknown');
      await this.safetyBlock('close_blocked_door_unknown');
      return false;
    }
    if (!report.positionKnown && !safelyDockedHomeForClose && !opts.manualOutsidePositionVerified) {
      this._logCloseReport(report, 'blocked_position_unknown');
      await this.safetyBlock('close_blocked_position_unknown');
      return false;
    }

    await this._restoreSensorOnlineIfRecent('close_guard').catch(() => {});
    report.sensorHealthy = this.sensorHealthy();
    if (this.sensorEnabled() && !report.sensorHealthy) {
      const reasonText = this.sensorUnhealthyReason() || 'sensor_unhealthy';
      this._logCloseReport(report, `sensor_unhealthy_fallback_${reasonText}`);
      await this.safetyWarning(`sensor_unhealthy_close_fallback_${reasonText}`);
    }
    if (this.doorState() === 'open' && this._stableOpenTimer) {
      this._logCloseReport(report, 'blocked_door_not_stable_open');
      return false;
    }
    const safelyDockedHome = safelyDockedHomeForClose;
    if (report.requireExitConfirmed && !safelyDockedHome && !this._rawDangerExitConfirmed()) {
      this._logCloseReport(report, 'blocked_raw_danger_clear_unconfirmed');
      await this.safetyWarning('close_blocked_raw_danger_clear_unconfirmed');
      return false;
    }
    if (report.insideDanger && !safelyDockedHome) {
      this._logCloseReport(report, 'blocked_mower_in_danger_area');
      await this.safetyWarning('close_blocked_mower_in_danger_area');
      return false;
    }
    if (opts.requireExitConfirmed && !(this._lineToLawnConfirmed && this._lineState === LINE_STATES.DOOR_CLOSE_ALLOWED)) {
      this._logCloseReport(report, 'blocked_line_not_confirmed');
      return false;
    }

    if (gateToken !== this._commandToken || this._manualGateStopped) return false;
    if (String(reason || '') === 'widget_manual_close' && opts.manualOutsidePositionVerified
        && !await this._manualGateOutsidePositionProof().catch(() => false)) {
      this._logCloseReport(report, 'blocked_manual_final_physical_clearance');
      return false;
    }
    if (gateToken !== this._commandToken || this._manualGateStopped) return false;
    if (homeClose && !opts.emergencyReverse
        && (closeDockEpoch !== this._homeDockEpoch || !this._homeDockReadyForClose())) return false;
    this._logCloseReport(report, 'close_requested');
    const delay = this._doorCloseDurationSeconds();
    if (this.doorState() !== 'closed') {
      await this.setDoorState('closing', { immediate: true });
    }
    if (gateToken !== this._commandToken || this._manualGateStopped) return false;
    if (homeClose && !opts.emergencyReverse
        && (closeDockEpoch !== this._homeDockEpoch || !this._homeDockReadyForClose())) {
      await this.setDoorState(doorNow, { immediate: true });
      return false;
    }
    if (homeClose) this._homeCloseIssuedAt = Date.now();
    this._trigger('garage_close_requested', reason || 'close');
    this._garageNotice(
      'door_closing',
      this._text('Garagentor schließt', 'Garage door closing'),
      reason || 'close',
      15000,
    );
    const applyTimedClosed = (why) => {
      this.log('door close by configured time:', why, 'waiting', delay, 's');
      clearTimeout(this._doorFinalTimer);
      const finish = () => {
        if (gateToken !== this._commandToken || this._manualGateStopped) return;
        this._doorFinalTimer = null;
        this.setDoorState('closed', { immediate: true, derived: true })
          .then(() => this.clearSafety('sensor_close_time_fallback_completed'))
          .catch((e) => this.error('door timed closed', e.message));
      };
      if (delay > 0) this._doorFinalTimer = setTimeout(finish, delay * 1000);
      else finish();
    };

    if (!this.sensorDoorMonitoringEnabled()) {
      applyTimedClosed(this.sensorEnabled() ? 'sensor battery low' : 'sensor disabled');
    } else {
      // Availability is not used as a precondition here. A configured contact
      // gets the full movement watchdog to deliver a fresh CLOSED edge. Only a
      // real miss then falls back to the configured closing duration.
      clearTimeout(this._doorFinalTimer);
      this._doorFinalTimer = setTimeout(async () => {
        if (gateToken !== this._commandToken || this._manualGateStopped) return;
        this._doorFinalTimer = null;
        if (this.doorState() !== 'closed') {
          const freshClosedContact = this._lastSensorContactState === 'closed'
            && this._lastSensorContactAt
            && Date.now() - Number(this._lastSensorContactAt) <= DOOR_SENSOR_TIMEOUT_MS + 10000;
          if (freshClosedContact) {
            // The real sensor contact arrived, but Homey's capability/stability
            // update was slower than the movement watchdog. Treat this as a late
            // valid confirmation, not as a sensor failure or warning.
            this.log('door close confirmed by late fresh sensor contact');
            await this.setDoorState('closed', { immediate: true, derived: false });
            await this.clearSafety('late_sensor_close_confirmed').catch(() => {});
            return;
          }
          this.log('door close sensor timeout; falling back to configured close time');
          await this._recordSensorMovementTimeout('close');
          applyTimedClosed('sensor confirmation timeout');
        }
      }, DOOR_SENSOR_TIMEOUT_MS);
    }
    return true;
  }

  async ensureDoorOpen(reason, opts = {}) {
    const token = this._commandToken;
    const current = () => token === this._commandToken && !this._manualGateStopped;
    if (!current()) return false;
    const openedRequestedAt = Date.now();
    const minWaitMs = Math.max(0, Number(opts.minWaitMs || 0));
    // Optional one-shot notification for a FAR-SIDE Homey return. It permits
    // native DOCK only AFTER the OPEN request was accepted (not after a raw
    // status/display hint), while this method independently awaits the full
    // contact/travel-time safety release. Normal starts do not use this hook.
    let openRequestSignaled = false;
    const signalAcceptedOpenRequest = () => {
      if (!openRequestSignaled && current() && typeof opts.onOpenRequestAccepted === 'function') {
        openRequestSignaled = true;
        opts.onOpenRequestAccepted();
      }
    };
    if (opts.reassertDisplayedOpen && this.doorState() === 'open') {
      // A displayed OPEN may be stale. Re-send the actual motor OPEN flow, even
      // when the contact is already OPEN (it need not publish a second edge).
      // Do not use an old release timestamp to skip this handshake.
      const sensorWasOpen = this._lastSensorContactState === 'open'
        && Number(this._lastSensorContactAt || 0) > 0;
      const issuedAt = Date.now();
      const requested = await this.requestOpen(reason, { allowOpenFromDanger: !!opts.allowOpenFromDanger });
      if (!requested || !current()) return false;
      signalAcceptedOpenRequest();
      const travelMs = Math.max(1000, this._doorOpenDurationSeconds() * 1000, minWaitMs);
      this.log('return gate OPEN reasserted despite displayed OPEN', `waiting ${Math.ceil(travelMs / 1000)}s`);
      await sleep(travelMs);
      if (!current() || ['closed', 'closing'].includes(this.doorState())
          || (this.sensorEnabled() && this._lastSensorContactState === 'closed'
              && Number(this._lastSensorContactAt || 0) >= issuedAt)) return false;
      const freshOpen = this._lastSensorContactState === 'open'
        && Number(this._lastSensorContactAt || 0) >= issuedAt;
      if (this.sensorEnabled() && !freshOpen && !sensorWasOpen) return false;
      if (this.sensorEnabled() && this._lastSensorContactState !== 'open') return false;
      if (this.sensorEnabled() && !this._realDoorOpenSensorProof()) {
        this.log('return gate OPEN reassertion blocked: no current-cycle real contact');
        return false;
      }
      await this.setDoorState('open', { immediate: true, derived: true });
      if (!current()) return false;
      this._lastDoorOpenReleaseAt = Date.now();
      if (this.sensorEnabled() && !this._doorOpenReleaseVerified()) return false;
      this.log('return gate OPEN reasserted: full travel time elapsed', freshOpen ? 'fresh_sensor_open' : 'sensor_remained_open');
      return true;
    }
    if (this._doorOpenReleaseVerified()) {
      signalAcceptedOpenRequest();
      const remaining = minWaitMs - (Date.now() - openedRequestedAt);
      if (remaining > 0) await sleep(remaining);
      return current() && this._doorOpenReleaseVerified();
    }
    const waitRemainingMinimum = async (why) => {
      const remaining = minWaitMs - (Date.now() - openedRequestedAt);
      if (remaining > 0) {
        this.log('door open minimum wait', why || reason || 'open', 'waiting', Math.ceil(remaining / 1000), 's');
        await sleep(remaining);
      }
    };
    const useTimerFallback = async (fallbackReason, elapsedMs = 0) => {
      const configuredMs = Math.max(0, this._doorOpenDurationSeconds() * 1000);
      const waitMs = Math.max(0, Math.max(configuredMs, minWaitMs) - Math.max(0, Number(elapsedMs || 0)));
      const issuedAt = Number(this._lastDoorOpenRequestAt || openedRequestedAt);
      this.log('door open by configured time (DEGRADED, not sensor proof)', fallbackReason,
        'waiting', Math.ceil(waitMs / 1000), 's');
      if (waitMs > 0) await sleep(waitMs);
      if (!current() || issuedAt !== Number(this._lastDoorOpenRequestAt || 0)) return false;
      // A new real CLOSED edge during this movement is contradictory. Do not
      // extrapolate a travel time into an OPEN acknowledgement in that case.
      if (this.sensorEnabled() && this._lastSensorContactState === 'closed'
          && Number(this._lastSensorContactAt || 0) >= issuedAt) {
        this.log('door timer fallback blocked: fresh CLOSED sensor contact after OPEN request');
        await this.safetyWarning('sensor_closed_contradicts_open_fallback');
        return false;
      }
      if (this.sensorEnabled() && this._realDoorOpenSensorProof()) {
        // A late authentic OPEN contact wins over any derived fallback.
        await this.setDoorState('open', { immediate: true, derived: false });
        return current() && this._doorOpenReleaseVerified();
      }
      await this.setDoorState('open', { immediate: true, derived: true });
      if (!current()) return false;
      this._lastDoorOpenReleaseAt = Date.now();
      if (this.sensorEnabled()) {
        this._doorOpenTimedFallbackAt = this._lastDoorOpenReleaseAt;
        this._doorOpenTimedFallbackToken = token;
        this._doorOpenTimedFallbackRequestAt = issuedAt;
        await this.safetyWarning('door_open_time_fallback_sensor_unverified');
      }
      this._trigger('garage_door_stable_open', fallbackReason || 'door_open_time_elapsed');
      return current() && this._doorOpenReleaseVerified();
    };

    await this._restoreSensorOnlineIfRecent('open_guard').catch(() => {});
    if (!this.sensorEnabled()) {
      // Installations without a door contact retain the explicitly configured
      // travel-time fallback. They cannot claim a sensor-confirmed opening.
      const requested = await this.requestOpen(reason, { allowOpenFromDanger: !!opts.allowOpenFromDanger });
      if (!requested || !current()) return false;
      signalAcceptedOpenRequest();
      return useTimerFallback('sensor_disabled_open_time_elapsed');
    }
    // An explicitly offline/low-battery contact uses the configured travel
    // time. This is a documented degraded fallback, NOT a fabricated sensor
    // event. A fresh real contact can still override the timed assumption.
    if (!this.sensorDoorMonitoringEnabled() || !this.sensorHealthy()) {
      const requested = await this.requestOpen(reason, { allowOpenFromDanger: !!opts.allowOpenFromDanger });
      if (!requested || !current()) return false;
      signalAcceptedOpenRequest();
      return useTimerFallback('sensor_unavailable_configured_open_duration');
    }
    // Even if the availability capability currently says offline/timeout, a
    // configured contact sensor is authoritative for this movement. Wait for a
    // fresh OPEN edge first; only after the movement watchdog expires use the
    // configured physical travel-time fallback.
    if (this._doorOpenReleaseVerified()) {
      signalAcceptedOpenRequest();
      await waitRemainingMinimum('already_open_verified');
      return current();
    }
    if (this.isDoorOpenStable()) {
      this.log('cached open state not trusted for start; requesting fresh gate-open handshake');
    }

    const requested = await this.requestOpen(reason, { allowOpenFromDanger: !!opts.allowOpenFromDanger });
    if (!requested || !current()) return false;
    signalAcceptedOpenRequest();

    const max = Date.now() + DOOR_SENSOR_PHYSICAL_OPEN_WAIT_MS;
    while (Date.now() < max) {
      if (!current()) return false;
      if (this._doorOpenReleaseVerified()) {
        await waitRemainingMinimum('sensor_open_stable');
        this._lastDoorOpenReleaseAt = Date.now();
        await this.clearSafety('door_open_stable');
        return current();
      }
      await sleep(500);
    }

    // A contact may arrive at the edge of the timeout while the configured
    // stabilisation delay is still running. Give that real handshake the remaining
    // minimum/stabilisation window instead of declaring the sensor unhealthy and
    // permanently suppressing the outbound command.
    const freshOpenHandshake = this._lastSensorContactState === 'open'
      && this._lastGateOpenHandshakeAt
      && Date.now() - this._lastGateOpenHandshakeAt <= DOOR_SENSOR_TIMEOUT_MS + 5000;
    if (freshOpenHandshake) {
      const settleDeadline = Date.now() + Math.max(minWaitMs, this._doorDelaySeconds() * 1000, 5000);
      while (Date.now() < settleDeadline) {
        if (!current()) return false;
        if (this._doorOpenReleaseVerified()) {
          await waitRemainingMinimum('late_sensor_open_stable');
          await this.clearSafety('late_door_open_stable');
          return current();
        }
        await sleep(500);
      }
      // A genuine OPEN contact was received in time. If only the derived Homey
      // door state/stability timer is late, finish the physical settle window
      // without declaring the sensor unhealthy or writing a fallback warning.
      if (!current() || !this._realDoorOpenSensorProof() || ['closing','closed'].includes(this.doorState())) return false;
      this.log('door open confirmed by late fresh sensor contact; completing settle time');
      await this.setDoorState('open', { immediate: true, derived: false });
      await waitRemainingMinimum('late_sensor_open_contact');
      await this.clearSafety('late_sensor_open_confirmed').catch(() => {});
      this._lastDoorOpenReleaseAt = Date.now();
      this._trigger('garage_door_stable_open', 'late_sensor_open_confirmed');
      return current();
    }

    // The contact was HEALTHY at the beginning of this command, yet no OPEN
    // edge was observed throughout the full physical movement watchdog.
    // A timed assumption cannot override this missing physical proof: it could
    // leave the garage CLOSED while the widget claims OPEN (field 2026-10-28).
    // Keep the historical configured-timer fallback ONLY for a sensor which
    // was unavailable/disabled before requesting movement (branches above).
    if (!current()) return false;
    this.log('door OPEN contact timed out; gate UNVERIFIED – no timed release',
      `waitedMs=${Date.now() - openedRequestedAt}`, `reason=${reason || 'open'}`,
      `sensor=${this._lastSensorContactState || 'none'}`);
    await this._recordSensorMovementTimeout('open');
    if (!current()) return false;
    this._doorOpenTimedFallbackAt = 0;
    // Do not invent CLOSED either: a moving/unknown gate must be checked on site.
    await this.setDoorState('unknown', { immediate: true, derived: true });
    this._garageNotice('gate_open_unconfirmed', this._text(
      '⛔ Toröffnung nicht bestätigt. Tor prüfen.',
      '⛔ Gate opening not confirmed. Check the gate.'),
      'door_open_sensor_not_confirmed', 60000);
    return false;
  }

  async _beginOutbound(action, requiresMowingStable) {
    // A deliberate start/external-start begins a new mowing cycle. Any previous
    // Home/Safe-Space close timer from the completed cycle is stale from this
    // point on and must never close the gate while the mower is leaving.
    clearTimeout(this._closeTimer);
    this._closeTimer = null;
    this._closeScheduled = false;
    this._homeCloseInProgress = false;
    this._homeCycleLocked = false;
    this._nativeDockVerifiedAt = 0;
    this._homeCycleLockedAt = 0;
    this.lastRequestedAction = action;
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._lastLineSide = null;
    this._lastLineRawSide = null;
    this._closeAfterExitRequested = false;
    this._rawDangerOutsideSince = 0;
    this._rawDangerOutsideHits = 0;
    this._rawDangerOutsideLastPositionTs = 0;
    this._setLineState(LINE_STATES.IDLE, 'markers_reset');
    this._garageLineSide = null;
    this._lawnLineSide = null;
    this._returnDecision = null;
    this._lockedReturnMaintenancePoint = null;
    this._awaitingLineDoorOpen = false;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._suspectedPausedReturnTimer = null;
    this._outboundHardLockUntil = Date.now() + 6 * 60 * 1000;
    this._missionOutside = true;
    this._lastOutdoorActivityAt = Date.now();
    this._outbound = {
      action,
      requiresMowingStable: !!requiresMowingStable,
      requestedAt: Date.now(),
      dockLeftAt: null,
      mowingSince: null,
      mowingStatusHits: 0,
      mowingStatusLastAt: 0,
      stableMowingConfirmed: false,
      stableMowingConfirmedAt: 0,
      adjustingSince: null,
      lineInitialSide: null,
      lineLawnSide: null,
      lineCrossedAt: null,
      departureLineConfirmed: false,
      departureLineConfirmedAt: 0,
      lineCrossAttempts: 0,
      failedLineDwells: 0,
      lastLawnCrossAt: 0,
      lawnSideSince: 0,
      lawnSideStableHits: 0,
      released: false,
      originalCommandSentAt: null,
    };
    this._spatialReturnSamples = [];
    try {
      const direction = await this.markers.directionState();
      if (this._outbound && direction && direction.known) {
        this._outbound.lineInitialSide = direction.garageSide;
        this._garageLineSide = direction.garageSide;
        this._lawnLineSide = direction.lawnSide;
        this._outbound.lineLawnSide = direction.lawnSide;
        this._outbound.lineArmedAt = Date.now();
        this.log('safety line calibrated from garage geometry', 'garageSide=', direction.garageSide, 'lawnSide=', direction.lawnSide);
      } else {
        this.log('safety line calibration pending: garage geometry unavailable');
      }
    } catch (e) {
      this.error('line calibration', e.message);
    }
    this.log('outbound guard begin', JSON.stringify(this._outbound));
    if (String(action || '').toUpperCase() !== 'TEST_EXIT') this._missionNotification('departure');
  }

  _clearOutboundStatusTimers() {
    if (Array.isArray(this._outboundStatusTimers)) {
      for (const t of this._outboundStatusTimers) {
        try { clearTimeout(t); } catch (e) {}
      }
    }
    this._outboundStatusTimers = [];
  }

  _scheduleOutboundStatusTimers() {
    this._clearOutboundStatusTimers();
    if (!this._outbound) return;
    // All display phases are anchored to the real physical release time. Native
    // start confirmation may arrive much later; rescheduling must therefore use
    // the remaining phase time instead of restarting the clocks from zero.
    const anchor = Number(this._outbound.originalCommandSentAt || Date.now());
    const elapsed = Math.max(0, Date.now() - anchor);
    const scheduleAt = (targetElapsed, fn) => {
      const delay = Math.max(0, targetElapsed - elapsed);
      const t = setTimeout(async () => {
        try { await fn(); } catch (e) { this.error('outbound status timer', e.message); }
      }, delay);
      this._outboundStatusTimers.push(t);
    };
    scheduleAt(OUTBOUND_EXITING_DISPLAY_MS + 150, async () => {
      if (!this._outbound) return;
      await this.refreshTileStatus('outbound display: adjusting timer').catch(() => {});
      this.log('status timer', 'Justieren aktiv – endet bei bestätigter Safety-Line-Überfahrt oder vier sauberen Mähstatus, sonst nach 45 s');
    });
    // A second local-only checkpoint makes the UI transition resilient to a
    // delayed Homey capability update or event-loop stall. This does not poll the
    // mower/cloud; it only republishes the derived phase from the same anchor.
    scheduleAt(OUTBOUND_EXITING_DISPLAY_MS + 1500, async () => {
      if (!this._outbound || this._outboundDeparturePhase() !== 'adjusting') return;
      await this.refreshTileStatus('outbound display: adjusting consistency check').catch(() => {});
    });
    // Display-only reconciliation during adjusting: native status frames may
    // overwrite mower_status with the preceding departure phase, even when the
    // deterministic outbound clock has advanced. Re-publish locally without
    // issuing any mower, map or gate command. These timers are owned by the
    // existing outbound timer list and cancelled with the outbound cycle.
    for (let elapsedMs = 10000; elapsedMs < OUTBOUND_EXITING_DISPLAY_MS + MIN_ADJUSTING_MS; elapsedMs += 10000) {
      scheduleAt(elapsedMs, async () => {
        if (!this._outbound || this._outboundDeparturePhase() !== 'adjusting') return;
        await this.refreshTileStatus('outbound adjusting display reconciliation').catch(() => {});
      });
    }
    scheduleAt(OUTBOUND_EXITING_DISPLAY_MS + MIN_ADJUSTING_MS + 250, async () => {
      if (!this._outbound) return;
      await this.refreshTileStatus('outbound display: positioning timer').catch(() => {});
      this.log('status timer', 'Positionieren aktiv – wartet auf bestätigte Safety-Line-Überfahrt oder vier saubere Mähstatus');
    });
    scheduleAt(OUTBOUND_EXITING_DISPLAY_MS + MIN_ADJUSTING_MS + 1500, async () => {
      if (!this._outbound || this._outboundDeparturePhase() !== 'positioning') return;
      await this.refreshTileStatus('outbound display: positioning consistency check').catch(() => {});
    });
    scheduleAt(OUTBOUND_EXITING_DISPLAY_MS + MIN_ADJUSTING_MS + POSITIONING_FALLBACK_MS + 500, async () => {
      if (!this._outbound || this._outbound.stableMowingConfirmed) return;
      // The nominal positioning window is diagnostic only. Without either
      // physical line-crossing proof or four clean native MOWING observations,
      // keep displaying Positionieren instead of falsely claiming mowing.
      await this.refreshTileStatus('outbound display: positioning awaiting confirmation').catch(() => {});
      this.log('positioning continues after nominal window', 'waiting for Safety-Line crossing or four consecutive native mowing statuses');
    });
  }

  _clearStartConfirmation() {
    clearTimeout(this._startConfirmTimer);
    clearTimeout(this._startConfirmNoticeTimer);
    this._startConfirmTimer = null;
    this._startConfirmNoticeTimer = null;
    this._startConfirmationPending = false;
    this._startConfirmInitialPos = null;
    this._startConfirmSource = null;
    this._startRetryFn = null;
    this._startRetrySent = false;
    this._startFinalRetrySent = false;
    this._outboundExitLocked = false;
    this._movingGateStartWarningShown = false;
    this._dangerOutsideSince = 0;
  }

  _startConfirmedByNativeOrMovement() {
    const status = this.status();
    const out = this._outbound;
    if (out?.stableMowingConfirmed) return true;
    // A single native mowing packet during departure/positioning is not proof
    // that the original task has actually continued. It may fall back to idle
    // at the maintenance point a moment later. Wait for an uninterrupted native
    // mowing interval; the status observer clears mowingSince on other states.
    if (status === 'mowing' && out?.mowingSince
        && Date.now() - out.mowingSince >= START_NATIVE_MOWING_STABLE_MS) return true;
    if (['remote_control', 'mapping'].includes(status)) return true;
    // Fresh movement proves departure, but not that a mowing mission persisted.
    // Keep the start handshake pending through adjustment and short transit.
    return false;
  }

  _physicalOutsideRecoveryEvidence() {
    const pos = this.pos();
    if (!pos) return false;
    const age = Date.now() - Number(pos.ts || 0);
    if (Number.isFinite(age) && age > POSITION_CACHE_MS) return false;
    return !!this._outbound || this._missionOutside || this._homeState === 'away' || this._homeState === 'adjusting';
  }

  _recentConfirmedHomePosition(pos = this.pos()) {
    const nativeStatus = String(this.device?._nativeMowerStatus
      || this.device?.getCapabilityValue?.('mower_status') || '').toLowerCase();
    if (!pos || !['docked', 'charging', 'charging_completed'].includes(nativeStatus)) return false;
    if (this._outbound || this._missionOutside || this._safeReturnInProgress || this._returnGuardActive) return false;
    const confirmedAt = Number(this._nativeDockVerifiedAt || 0);
    const proofAge = Date.now() - confirmedAt;
    if (!confirmedAt || proofAge < 0 || proofAge > 90000) return false;
    const nativeDock = this._freshNativeDockState();
    if (nativeDock?.dockingState === 'OUT_OF_STATION' || Number(nativeDock?.undocking) === 1) return false;
    const dock = this.device?._dockPos;
    if (!dock) return false;
    const distance = this._distance(pos, dock);
    // A2's reported parked position can sit about 1.1 m from the DOCK anchor.
    // Treat this as station-consistent when recent native home confirmation
    // agrees; the 900 mm danger circle alone must not reverse that conclusion.
    return Number.isFinite(distance) && distance < 1500;
  }

  async _freshPositionProvesOutsideHome() {
    // A native charging/station lock must never be overridden by a map position.
    // Field incident 2026-10-18: the A2 reports its parked pose ~1.2 m away
    // from the DOCK anchor, outside a user-configured 900 mm danger circle.
    if (this._confirmedStationLockActive()) return false;
    const pos = this.pos();
    if (!pos) return false;
    const age = Date.now() - Number(pos.ts || 0);
    if (Number.isFinite(age) && age > POSITION_CACHE_MS) return false;
    const nativeDock = this._freshNativeDockState();
    if (nativeDock?.dockingState === 'IN_STATION' && Number(nativeDock.undocking) === 0) return false;
    if (this._recentConfirmedHomePosition(pos)) {
      this.log('fresh position remains consistent with recently confirmed dock',
        `distance=${Math.round(this._distance(pos, this.device?._dockPos))}mm`);
      return false;
    }
    const dock = this.device._dockPos;
    const dockDistance = dock ? this._distance(pos, dock) : null;
    // Require both a position beyond the native station envelope AND lawn-side
    // geometry. Merely leaving the smaller editable danger circle is not proof
    // of leaving the charging station; unknown geometry is never affirmative.
    if (!Number.isFinite(dockDistance) || dockDistance < 1500) return false;
    const danger = await this.markers.dangerState().catch(() => null);
    return danger?.known === true && danger.inside === false;
  }

  async reconcilePhysicalHomeStateForCommand(source = 'command') {
    if (!(await this._freshPositionProvesOutsideHome())) return false;
    if (this._homeState === 'home' || this.isDockedHomeStatus()) {
      this._homeState = 'away';
      this._missionOutside = true;
      this.log('physical position overrides stale home status', source || 'command');
      this._timeline(
        this._text('Aktuelle Position erkannt – Mäher ist außerhalb der Garage', 'Current position detected – mower is outside the garage'),
        'state:physical_position_outside_home',
      );
      await this.refreshTileStatus('physical position overrides stale home').catch(() => {});
    }
    return true;
  }

  async _confirmReleasedStart(source, token, retryFn = null, initialAccepted = true) {
    this._clearStartConfirmation();
    this._startConfirmationPending = true;
    this._startConfirmationFailed = false;
    this._startConfirmSource = source || 'start';
    this._startRetryFn = typeof retryFn === 'function' ? retryFn : null;
    this._startRetrySent = false;
    this._startFinalRetrySent = false;
    const p = this.pos();
    this._startConfirmInitialPos = p ? { x: Number(p.x), y: Number(p.y), ts: p.ts || Date.now() } : null;
    await this.refreshTileStatus(initialAccepted ? 'start command sent; waiting for mower confirmation'
      : 'start command rejected; waiting for guarded recovery').catch(() => {});

    this._startConfirmNoticeTimer = setTimeout(async () => {
      if (!this._startConfirmationPending || token !== this._commandToken) return;
      this.log('start confirmation pending', 'native status or real movement still missing');
      await this.refreshTileStatus('start still waiting for confirmation').catch(() => {});

      // Some A2 firmware revisions acknowledge the first command while still
      // exposing charging/docked and then silently discard it after a preceding
      // maintenance-point job. If the mower has not moved at all, the gate is
      // safely open and the native state is still home-like, resend the original
      // start command exactly once. Never retry after any movement/outdoor proof.
      const stillHomeLike = ['docked', 'charging', 'charging_completed', 'idle', 'standby'].includes(this.status());
      // Do not use _physicalOutsideRecoveryEvidence() here: an active _outbound
      // object is bookkeeping, not proof that the mower accepted the native start.
      // That old check suppressed the only retry precisely when the A2 left the
      // dock, adjusted, then reported idle/task-complete without starting mowing.
      const noNativeOrMovementProof = !this._startConfirmedByNativeOrMovement();
      const atMaintenance = this._manualGateStopped ? false : await this._isCurrentlyAtKnownMaintenancePoint().catch(() => false);
      const safeStartRetry = atMaintenance || (stillHomeLike && !this._outbound?.dockLeftAt);
      if (!this._startRetrySent && this._startRetryFn && this.isDoorOpenStable() && safeStartRetry && noNativeOrMovementProof
          && token === this._commandToken && !this._manualGateStopped) {
        this._startRetrySent = true;
        this.log('start confirmation retry', atMaintenance ? 'verified idle at maintenance point' : 'mower still at home');
        try {
          const accepted = await this._startRetryFn();
          if (accepted === false) this.log('start confirmation retry rejected');
          else if (token === this._commandToken && this._startConfirmationPending && !this._manualGateStopped) {
            await this._markOutboundReleased();
            this.log('start retry accepted; now waiting for native mower confirmation');
          }
        } catch (e) {
          this.error('start confirmation retry failed', e.message);
        }
      }
    }, START_CONFIRM_NOTICE_MS);

    this._startConfirmTimer = setTimeout(async () => {
      if (!this._startConfirmationPending || token !== this._commandToken) return;
      if (this._startConfirmedByNativeOrMovement()) {
        this._startConfirmationPending = false;
        this._startConfirmationFailed = false;
        this.log('start confirmed', this.status());
        this._scheduleOutboundStatusTimers();
        await this.refreshTileStatus('start confirmed').catch(() => {});
        return;
      }

      // RC109 recovery: never stop or strand a mower that has already produced
      // fresh outdoor position evidence after the gate released it. Normalize the
      // interrupted handshake to an outside-idle state so Start and Return remain
      // available without opening the gate again.
      if (this._physicalOutsideRecoveryEvidence() && this.positionKnown()
          && !this._confirmedStationLockActive()) {
        this._startConfirmationPending = false;
        this._startConfirmationFailed = false;
        this._missionOutside = true;
        this._homeState = 'away';
        if (this._outbound) this._outbound.released = true;
        this.log('start confirmation timeout recovered', 'fresh outside position; mower remains controllable');
        await this.refreshTileStatus('outside idle after interrupted start confirmation').catch(() => {});
        return;
      }

      // The gate has already released the mower. Never send STOP merely because
      // cloud status/position confirmation is late: on A2 firmware that command
      // turns the normal post-undock adjustment into "task completed" and
      // strands the mower in front of the garage. Retry START/RESUME once more and
      // keep the outbound safety lock active instead.
      const gateReleased = this.isDoorOpenStable() && !!this._doorOpenReleaseVerified()
        && !!this._outbound && !this._manualGateStopped;
      const homeLike = ['docked', 'charging', 'charging_completed', 'idle', 'standby'].includes(this.status());
      if (gateReleased && homeLike && !this._outbound?.dockLeftAt && this._startRetryFn && !this._startFinalRetrySent) {
        this._startFinalRetrySent = true;
        this.log('start confirmation final recovery retry', 'gate released; native state still home/idle-like');
        try {
          const accepted = await this._startRetryFn();
          if (accepted === false) this.log('start final recovery retry rejected');
          else if (token === this._commandToken && this._startConfirmationPending && !this._manualGateStopped) {
            await this._markOutboundReleased();
            this.log('start final retry accepted; waiting for native mower confirmation');
          }
        } catch (e) {
          this.error('start final recovery retry failed', e.message);
        }
        // Give the firmware another confirmation window without restarting the
        // whole garage sequence or touching the door.
        this._startConfirmTimer = setTimeout(async () => {
          if (!this._startConfirmationPending || token !== this._commandToken) return;
          if (this._startConfirmedByNativeOrMovement()) {
            this._startConfirmationPending = false;
            this._startConfirmationFailed = false;
            this.log('start confirmed after final recovery retry', this.status());
            this._scheduleOutboundStatusTimers();
            await this.refreshTileStatus('start confirmed after recovery retry').catch(() => {});
            return;
          }
          this._startConfirmationPending = false;
          this._startConfirmationFailed = true;
          // Keep physical/outbound evidence and the door safety state intact. The
          // user can press Start again or Return; automatic close stays blocked.
          // Do not turn an API rejection into a fictional departure state.
          // Keep the opened gate and fail-safe exit guard until a fresh native
          // position/dock proof or an explicit user action resolves the state.
          this._missionOutside = this._physicalOutsideRecoveryEvidence() && !!this.positionKnown();
          this._homeState = this._missionOutside ? 'away' : 'unknown';
          this.log('start not confirmed after bounded recovery; gate held open, no STOP sent');
          await this.refreshTileStatus('start not confirmed; retry or return available').catch(() => {});
          await this.safetyWarning('start_not_confirmed').catch(() => {});
        }, START_CONFIRM_NOTICE_MS);
        return;
      }

      this._startConfirmationPending = false;
      this._startConfirmationFailed = true;
      // No STOP here. Preserve the outbound context so the garage cannot close on
      // a mower whose exact state is uncertain.
      this._missionOutside = this._physicalOutsideRecoveryEvidence() && !!this.positionKnown();
      this._homeState = this._missionOutside ? 'away' : 'unknown';
      this._setLineState(LINE_STATES.PENDING, 'start_not_confirmed_no_stop');
      this.log('start failed: mower did not confirm; no STOP sent for safety', `${Math.round(START_CONFIRM_TIMEOUT_MS / 1000)}s`);
      await this.refreshTileStatus('start not confirmed; retry or return available').catch(() => {});
      await this.safetyWarning('start_not_confirmed').catch(() => {});
    }, START_CONFIRM_TIMEOUT_MS);
  }

  async _markOutboundReleased() {
    if (this.enabled() && this._outbound && this._outbound.requiresMowingStable) {
      if (this._outbound.released) return;
      const commandAt = Date.now();
      this._outbound.released = true;
      this._outbound.originalCommandSentAt = commandAt;
      this._outbound.adjustingSince = commandAt + OUTBOUND_EXITING_DISPLAY_MS;
      this._startDoorReleasedAt = commandAt;
      this._startCycleIgnoreReturnUntil = Date.now() + 4 * 60 * 1000;
      await this._setHomeState('adjusting').catch(() => {});
      await this.refreshTileStatus('adjusting').catch(() => {});
      // Start the visible phase timers immediately at physical release. Waiting for
      // cloud/native start confirmation here caused the tile to remain on Exiting
      // and then replay Adjusting/Positioning only after mowing was already active.
      this._scheduleOutboundStatusTimers();
      this.log('outbound released: original mower command sent; waiting for native confirmation');
    }
  }

  async _waitForMowerOnlineBeforeStart(source) {
    const deadline = Date.now() + START_ONLINE_PREFLIGHT_TIMEOUT_MS;
    const did = this.device.getData().id;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const raw = await this.device._api.getRawProperties(did);
        if (raw) {
          this.device._lastPollSuccessAt = Date.now();
          if (!this.device.getAvailable()) await this.device.setAvailable().catch(() => {});
          this.log('start online preflight confirmed', source || 'start');
          return true;
        }
      } catch (e) {
        lastError = e;
      }
      await sleep(START_ONLINE_PREFLIGHT_POLL_MS);
    }
    this.log('start aborted: mower not reachable within online preflight timeout', `${START_ONLINE_PREFLIGHT_TIMEOUT_MS / 1000}s`, lastError?.message || 'no response');
    // Read-only cloud preflight can fail while a native/external-app start is
    // already in flight. Never send a speculative STOP or close the open door
    // solely because the command transport is unreachable. Keep the outbound
    // door-close protection until actual native motion/station evidence or
    // deliberate supervised recovery resolves the uncertain state.
    this._startConfirmationPending = false;
    this._startConfirmationFailed = true;
    this._missionOutside = false;
    this._homeState = 'unknown';
    await this.refreshTileStatus('start failed: mower transport unavailable; gate protected').catch(() => {});
    await this.safetyWarning('start_online_timeout').catch(() => {});
    this.log('start preflight timeout: keeping open gate and outbound safety guard; no speculative STOP/CLOSE');
    return false;
  }

  async _refreshPositionForStart(reason = 'start') {
    const did = this.device?.getData?.().id;
    if (!did || !this.device?._api?.getMowerPosition) return this.pos();
    try {
      const fresh = await this.device._api.getMowerPosition(did);
      if (fresh && Number.isFinite(Number(fresh.x)) && Number.isFinite(Number(fresh.y))) {
        this.device._setLivePosition?.({ x: Number(fresh.x), y: Number(fresh.y), ts: Date.now() }, 'start-recheck');
        this.log('start position refreshed', reason, `${Math.round(Number(fresh.x))},${Math.round(Number(fresh.y))}`);
      }
    } catch (e) {
      this.log('start position refresh unavailable', reason, e?.message || String(e));
    }
    return this.pos();
  }

  async _freshOutsideStartProof() {
    // Never bypass the garage handshake while station telemetry has explicitly
    // established that the mower is docked. In particular, a reported parked
    // pose just outside a small danger circle is NOT an outdoor start.
    if (this._confirmedStationLockActive()) return false;
    const p = this.pos();
    const ts = Number(p?.ts || 0);
    const age = Date.now() - ts;
    if (!p || !ts || age < 0 || age > POSITION_CACHE_MS) return false;
    if (this._freshNativeDockState()?.dockingState === 'IN_STATION') return false;
    const dockDistance = this._distance(p, this.device?._dockPos);
    if (!Number.isFinite(dockDistance) || dockDistance < 1500) return false;
    const danger = await this.markers.rawDangerState(p).catch(() => null);
    if (!danger?.known) return false;
    // A fresh point clearly outside the gate danger area is enough to start any
    // mowing mode without opening/closing the garage.  If the mower is physically
    // in the doorway/danger area, only an already-open stable gate is accepted.
    if (!danger.inside) return true;
    return this.isDoorOpenStable();
  }

  async _reconfirmMaintenanceForStart(source, token) {
    if (!this._manualMaintenanceReached || this.isDockedHomeStatus() || this.isReturning()
        || this._safeReturnInProgress || this._returnGuardActive || this._manualGateStopped) return false;

    await this._refreshPositionForStart(`${source || 'start'}:maintenance_precheck`);
    if (Number(this._manualMaintenanceTargetReachedIndex || 1) > 1) {
      if (await this._freshOutsideStartProof().catch(() => false)) return true;
      const age = Date.now() - Number(this._lastAdditionalMaintenanceReached?.at || 0);
      const gateMoving = ['opening', 'closing'].includes(this.doorState());
      return age >= 0 && age <= RETURN_MAINTENANCE_ARRIVAL_REUSE_MAX_MS
        && !gateMoving && !this._manualGateStopped && !this.isDockedHomeStatus() && !this.isReturning();
    }
    if (await this._isCurrentlyAtKnownMaintenancePoint().catch(() => false)) return true;
    if (await this._freshOutsideStartProof().catch(() => false)) return true;

    // The maintenance arrival proof can become stale simply because a stationary
    // mower stops publishing positions.  Re-send the native maintenance command
    // once: if it is already there the A2 re-justifies/reconfirms; otherwise it
    // moves to the safe lawn-side point.  This must never open/close the gate.
    if (typeof this.device?._goToMaintenancePointGuarded !== 'function') return false;
    this.log('start from stale maintenance proof: requesting maintenance re-confirmation', source || 'start');
    const accepted = await this.device._goToMaintenancePointGuarded('start_reconfirm_maintenance').catch((e) => {
      this.log('maintenance re-confirmation command failed', e?.message || String(e));
      return false;
    });
    if (accepted === false || token !== this._commandToken) return false;

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && token === this._commandToken && !this._manualGateStopped) {
      await sleep(750);
      await this._refreshPositionForStart(`${source || 'start'}:maintenance_recheck`);
      if (await this._isCurrentlyAtKnownMaintenancePoint().catch(() => false)) return true;
      if (await this._freshOutsideStartProof().catch(() => false)) return true;
    }

    // Last bounded fallback: a previously confirmed maintenance arrival plus an
    // accepted native 109 is enough to permit a start as long as the mower is not
    // docked/returning and the gate is not moving. This avoids a permanent block
    // solely because the stationary A2 stopped emitting fresh coordinates.
    const gateMoving = ['opening', 'closing'].includes(this.doorState());
    const safeSession = this._manualMaintenanceReached && !this._manualMaintenanceTransit
      && !this.isDockedHomeStatus() && !this.isReturning() && !gateMoving
      && !this._safeReturnInProgress && !this._returnGuardActive;
    if (safeSession) this.log('start maintenance re-confirmation accepted without fresh coordinate; using prior verified arrival');
    return !!safeSession;
  }

  async _startDirectlyOutside(source, fn, token, reason = 'outside') {
    if (token !== this._commandToken || (this.enabled() && this._manualGateStopped)) return false;
    if (!await this._waitForMowerOnlineBeforeStart(source || 'outside_start')) return false;
    const accepted = await fn();
    if (accepted === false || token !== this._commandToken) return false;
    this._retireMaintenanceTaskIdentity(source || 'outside_start');
    clearInterval(this._maintenanceWatch);
    this._maintenanceWatch = null;
    this._manualMaintenanceReached = false;
    this._manualMaintenanceTargetReachedIndex = 0;
    this._maintenanceLifecycleStartPoint = null;
    this._manualMaintenanceTransit = false;
    this._manualMaintenancePhase = 'idle';
    this._manualMaintenanceCalibration = false;
    this._manualMaintenanceRecalibration = false;
    this._outbound = null;
    this._outboundHardLockUntil = 0;
    this._startConfirmationPending = false;
    if (this._returnContext === RETURN_STATES.MAINTENANCE) this._returnContext = RETURN_STATES.IDLE;
    this._missionOutside = true;
    this._homeState = 'away';
    this.lastRequestedAction = source || 'START_OUTSIDE';
    this._ackOutsideMowingTile(`${source || 'start'}:${reason}`);
    await this.refreshTileStatus(`mowing start released outside: ${reason}`).catch(() => {});
    this.log('start accepted outside; garage bypass', reason, source || 'start');
    return true;
  }

  _retireMaintenanceTaskIdentity(source = 'start') {
    this._retireMaintenanceArrivalObservation(source);
    this._acceptedMowingTaskAt = Date.now();
    this._acceptedMowingTaskSource = source || 'start';
    this._acceptedMowingTaskConfirmedAt = 0;
    this._acceptedMowingTaskMismatchAt = 0;
    this.log('new mowing task accepted; previous native maintenance task identity retired', source || 'start');
  }

  _retireMaintenanceArrivalObservation(source = 'dock') {
    this.device._nativeMaintenanceCommandAt = 0;
    this.device._nativeMaintenanceArrivalClosed = true;
    this.device._nativeMaintenanceCompletionHint = null;
    this.device._pendingNativeMaintenanceArrival = null;
    this.device._nativeMaintenanceStableArrival = null;
    this.device._nativeMaintenanceArrivalLatched = false;
    this._maintenanceArrivalClose = null;
    this.log('maintenance arrival observation retired', source);
  }

  // Field 27-Oct: after an app reinstall a completed mission can leave an
  // in-memory "outside/return" latch, even though the native robot is docked.
  // Only a CURRENT user Start may reconcile it, and never from a cached tile.
  async _reconcileStaleMissionForDockedStart(token, source, stationReady) {
    const flags = () => ({
      outbound: !!this._outbound, outside: !!this._missionOutside,
      safeReturn: !!this._safeReturnInProgress, returnGuard: !!this._returnGuardActive,
    });
    const before = flags();
    this.log('start station mission preflight', JSON.stringify(before), source || 'start');
    // A live outbound or an emergency/manual hold is not stale evidence.
    if (this._initialBaselineDone !== true || before.outbound
        || this._manualGateStopped || this._manualRecoveryActive
        || this._emergencyCommandBlocked(`start_station_reconcile:${source}`)) return false;
    const nativeStatus = String(this.device?._nativeMowerStatus || '').toLowerCase();
    if (!['docked', 'charging', 'charging_completed'].includes(nativeStatus)) {
      this.log('start station mission reconciliation withheld: native status', nativeStatus || 'unknown');
      return false;
    }
    if (typeof this.device?._refreshNativeDockForStart !== 'function') return false;
    // Separate native read-only requests, not two observations of one cache.
    for (let i = 0; i < 2; i++) {
      const started = Date.now();
      const sample = await this.device._refreshNativeDockForStart({ diagnosticOnly:true }).catch(() => null);
      const fresh = this._freshNativeDockState();
      const sampleAt = Number(this.device?._mowerBinaryDiagAt || 0);
      if (!sample || !stationReady(sample) || !stationReady(fresh)
          || sampleAt < started - 2000 || token !== this._commandToken
          || this._outbound || this._manualGateStopped || this._manualRecoveryActive
          || this._emergencyCommandBlocked(`start_station_reconcile:${source}`)) {
        this.log('start station mission reconciliation withheld', `read=${i+1}`);
        return false;
      }
    }
    if (!stationReady(this._freshNativeDockState())) return false;
    this._missionOutside = false;
    this._safeReturnInProgress = false;
    this._returnGuardActive = false;
    this._homeState = 'home';
    this.log('start stale mission reconciled from two native dock reads', JSON.stringify(before));
    return true;
  }

  async startRequested(source, fn) {
    if (this._emergencyCommandBlocked(`start:${source}`)) return false;
    if (this.enabled() && this._manualGateStopped) { await this.safetyWarning('manual_gate_stop_hold'); return false; }
    const token = this._commandToken;
    const completedMaintenanceBeforeStart = !!this._manualMaintenanceReached;
    // A confirmed native station lock is stronger than the transient charging
    // capability. It is released ONLY by a real native undock bit, not by a
    // nearby coordinate or by an idle/charging status correction.
    const stationLockedBeforeStart = this._confirmedStationLockActive();
    let secureHomeBeforeStart = this.isDockedHomeStatus() || stationLockedBeforeStart;
    // A standalone mower or a physically verified independent maintenance
    // start does not need a station-origin garage departure. Preserve those
    // established paths before attempting a new native dock read.
    const garageStationPreflight = this.enabled()
      && !(completedMaintenanceBeforeStart
        && await this._isCurrentlyAtKnownMaintenancePoint().catch(() => false));
    const stationReady = (proof) => proof?.dockingState === 'IN_STATION'
      && Number(proof.undocking) === 0;
    let physical = this._freshNativeDockState();
    // A dock/charging tile can be stale after a restart. Keep the existing
    // physical-outside veto before treating a UI home label as reliable.
    if (secureHomeBeforeStart && !stationLockedBeforeStart && !stationReady(physical)) {
      await this._refreshPositionForStart(`${source || 'start'}:home_override_check`);
      if (await this._freshExternalStartOutdoorVeto()) secureHomeBeforeStart = false;
      physical = this._freshNativeDockState();
    }
    // Conversely, a fresh native OUT/undock packet is an absolute veto on
    // leaving via the GARAGE route even if the cloud still displays 'docked'.
    if (garageStationPreflight && physical && !stationReady(physical)
        && !stationLockedBeforeStart) {
      secureHomeBeforeStart = false;
    }
    // Proven lawn-side starts must retain the existing direct/resume path;
    // do not delay them with three station reads. In all OTHER uncertain cases,
    // including the very first Homey start after app restart (no station lock),
    // actively request a NEW read-only 1:1 dock frame before touching the gate.
    const outsideBeforeStationRead = !stationLockedBeforeStart && !stationReady(physical)
      && await this._freshOutsideStartProof().catch(() => false);
    if (outsideBeforeStationRead) secureHomeBeforeStart = false;
    const verifyStation = garageStationPreflight && !outsideBeforeStationRead
      && (stationLockedBeforeStart || secureHomeBeforeStart || !physical || stationReady(physical));
    if (verifyStation) {
      if (!stationReady(physical)) {
        this.log('start awaiting active native station verification',
          `locked=${stationLockedBeforeStart ? 1 : 0}`, source || 'start');
        await this.safetyWarning('start_station_verification_pending').catch(() => {});
        // This is a bounded continuation of the ORIGINAL user command, never a
        // queued autonomous start. Only real MQTT/1:1 frames refresh proof age.
        // Duplicate Homey taps remain blocked by _homeyStartIntentBusy.
        const canRefresh = typeof this.device?._refreshNativeDockForStart === 'function';
        for (let attempt = 1; canRefresh && attempt <= 3; attempt++) {
          if (token !== this._commandToken || this._manualGateStopped
              || this._emergencyCommandBlocked(`start_preflight:${source}`)) return false;
          // A known contradictory native packet is a hard stop, not a reason to
          // poll until a more favorable result eventually appears.
          if (physical && !stationReady(physical)) {
            this.log('start station verification contradicted', physical.dockingState,
              `u=${physical.undocking}`);
            break;
          }
          await this.device._refreshNativeDockForStart();
          physical = this._freshNativeDockState();
          if (stationReady(physical)) {
            this.log('start station verification complete', `attempt=${attempt}`, source || 'start');
            break;
          }
          if (physical && !stationReady(physical)) {
            this.log('start station verification contradicted', physical.dockingState,
              `u=${physical.undocking}`);
            break;
          }
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 900));
        }
      }
      // STOP, Emergency or a newer user command ALWAYS cancels the waiting
      // start, including a late but otherwise valid station response.
      if (token !== this._commandToken || this._manualGateStopped
          || this._emergencyCommandBlocked(`start_verified:${source}`)) return false;
      // IN_STATION/u0 with charge=0 is valid physical station evidence at 100%
      // battery. Charging is NOT necessary for the start proof. However, a
      // concurrently active return/outbound mission remains a contradiction.
      let conflictingMission = !!this._outbound || !!this._missionOutside
        || !!this._safeReturnInProgress || !!this._returnGuardActive;
      if (stationReady(physical) && conflictingMission) {
        await this._reconcileStaleMissionForDockedStart(token, source, stationReady);
        physical = this._freshNativeDockState();
        conflictingMission = !!this._outbound || !!this._missionOutside
          || !!this._safeReturnInProgress || !!this._returnGuardActive;
      }
      if (token !== this._commandToken || !stationReady(physical) || conflictingMission) {
        this.log('start blocked: fresh native IN_STATION/u0 proof missing or mission conflicts',
          `mission=${conflictingMission ? 1 : 0}`,
          `outbound=${!!this._outbound} outside=${!!this._missionOutside} return=${!!this._safeReturnInProgress} guard=${!!this._returnGuardActive}`,
          source || 'start');
        await this.safetyWarning('start_blocked_position_unconfirmed').catch(() => {});
        return false;
      }
      secureHomeBeforeStart = true;
      this._homeState = 'home';
      this.log('start station proof accepted',
        `charge=${physical.chargingLive ? 1 : 0}`,
        `lock=${this._confirmedStationLockActive() ? 1 : 0}`, source || 'start');
      if (this._lastSafetyReason === 'start_station_verification_pending') {
        await this._setSafetyStatus('ok', 'start_station_verified').catch(() => {});
      }
    }

    // Refresh the live position once before classifying an idle/maintenance start.
    // This fixes the common A2 case where the mower is stationary at the
    // maintenance point and the last MQTT coordinate has simply aged out.
    if (!secureHomeBeforeStart) await this._refreshPositionForStart(source || 'start');
    let verifiedMaintenanceOutsideBeforeStart = completedMaintenanceBeforeStart
      && await this._isCurrentlyAtKnownMaintenancePoint().catch(() => false);
    let freshOutsideBeforeStart = !secureHomeBeforeStart
      && await this._freshOutsideStartProof().catch(() => false);

    if (completedMaintenanceBeforeStart && !verifiedMaintenanceOutsideBeforeStart && !freshOutsideBeforeStart) {
      const reconfirmed = await this._reconfirmMaintenanceForStart(source, token);
      if (token !== this._commandToken) return false;
      if (reconfirmed) {
        verifiedMaintenanceOutsideBeforeStart = await this._isCurrentlyAtKnownMaintenancePoint().catch(() => false);
        freshOutsideBeforeStart = !verifiedMaintenanceOutsideBeforeStart
          && await this._freshOutsideStartProof().catch(() => false);
        if (!verifiedMaintenanceOutsideBeforeStart && !freshOutsideBeforeStart) {
          // _reconfirmMaintenanceForStart may intentionally return the bounded
          // prior-arrival fallback when the stationary mower emits no coordinate.
          freshOutsideBeforeStart = true;
        }
      }
    }

    const directOutsideStart = !secureHomeBeforeStart
      && (verifiedMaintenanceOutsideBeforeStart || freshOutsideBeforeStart);
    if (directOutsideStart) {
      // Only a freshly verified maintenance point may trigger an optional gate
      // close before mowing. Arbitrary outside positions (including the doorway
      // with an already-open gate) never move the gate as a side-effect of Start.
      if (this.enabled() && verifiedMaintenanceOutsideBeforeStart && this.doorState() !== 'closed') {
        if (!await this.requestClose('maintenance_start_close', { maintenanceArrivalVerified: true })) return false;
        if (!await this._waitForDoorClosedOrTimeout(token)) return false;
      }
      if (typeof this.device?._syncPylonLifecyclePhase === 'function') {
        // Permit phase edits at a physically verified stationary maintenance
        // point even if a stale cloud nativeStatus still says "mowing".
        this._maintenanceLifecycleStartPoint = verifiedMaintenanceOutsideBeforeStart
          ? { token, position:{ ...this.pos() }, at:Date.now() } : null;
        let lifecycle;
        try {
          lifecycle = await this.device._syncPylonLifecyclePhase(this.enabled() ? 'mowing' : 'prestart', {
            reason:'start_outside', allowVerifiedMaintenanceCheckpoint:verifiedMaintenanceOutsideBeforeStart,
            requireRequestedPhase:true,
          });
        } finally {
          this._maintenanceLifecycleStartPoint = null;
        }
        if (lifecycle?.ok === false) {
          await this.safetyWarning('pylon_lifecycle_mowing_sync_failed').catch(() => {});
          return false;
        }
      }
      if (!this.enabled()) this.device._standalonePrestartActiveUntil = Date.now() + 120000;
      return this._startDirectlyOutside(source, fn, token,
        verifiedMaintenanceOutsideBeforeStart ? 'verified_maintenance' : 'fresh_or_reconfirmed_outside');
    }

    if (!secureHomeBeforeStart) {
      this.log('start blocked: no secure home or fresh outside proof', source || 'start');
      await this.safetyWarning('start_blocked_position_unconfirmed').catch(() => {});
      return false;
    }
    // A completed manual maintenance journey must not leak into the next mowing
    // cycle. Clear only the maintenance-session state; map marker and verified
    // coordinate remain untouched and continue to be used for return/emergency.
    clearInterval(this._maintenanceWatch);
    this._maintenanceWatch = null;
    this._maintenanceRequestedAt = 0;
    this._maintenanceStartPos = null;
    this._maintenanceStableHits = 0;
    this._manualMaintenanceCalibration = false;
    this._manualMaintenanceRecalibration = false;
    this._manualMaintenanceTransit = false;
    this._manualMaintenanceReached = false;
    this._manualMaintenanceLastPos = null;
    this._manualMaintenanceStableSince = 0;
    this._maintenanceReachedCallback = null;
    this._maintenanceTimeoutCallback = null;
    if (completedMaintenanceBeforeStart) this.log('completed maintenance session cleared before mowing start');
    this._closeCompleted = false;
    if (!this.enabled()) {
      // No garage gate is needed, but manufacturer-native mission zones must be
      // prepared *before* releasing a Homey-initiated start. All phase-specific
      // protective zones are conservatively armed for the trip; phase-only
      // deactivation may be deferred until the mower is stationary.
      if (typeof this.device?._syncPylonLifecyclePhase === 'function') {
        const lifecycle = await this.device._syncPylonLifecyclePhase('prestart', {
          reason:'standalone_mower_start', requireRequestedPhase:true,
        });
        if (lifecycle?.ok === false) {
          this.log('standalone start blocked: native phase zone preflight failed', lifecycle.reason || 'unknown');
          return false;
        }
      }
      this.device._standalonePrestartActiveUntil = Date.now() + 120000;
      try { return await fn(); } catch (error) { this.device._standalonePrestartActiveUntil = 0; throw error; }
    }
    // Before moving or opening the garage, perform only required *removals*
    // inside the station. No deletion: the established start route is unchanged.
    // A failed removal retains the vendor restriction and may take a detour;
    // a missing mowing protection must NEVER be waived by this timeout.
    const departureEdit = await this._prepareDepartureZoneCheckpoint(token, source);
    if (departureEdit?.cancelled || token !== this._commandToken) return false;
    if (departureEdit?.needed === true && departureEdit.verified !== true) {
      this.log('[departure-zone-checkpoint] no-go zone remains: start held', departureEdit.reason || 'mapd_unverified');
      await this.safetyWarning('departure_zone_not_removed').catch(()=>{});
      return false;
    }
    // The operator may have saved an OBS zone during mowing. Native A2 map
    // writes need a task-free checkpoint; do them once here while station
    // proof is still valid, before the protection check and BEFORE undocking.
    // No new polling/transaction is scheduled without an explicit deferred rule.
    const deferredUserZones = Object.values(this.device?._obstacleRulesCache || {}).some(r =>
      r && r.hidden !== true && r.lifecycleTransitionPending === 'activate'
      && Number(r.mapIndex) === Number(this.device?._activeMapIndex));
    if (deferredUserZones && typeof this.device?._syncPylonLifecyclePhase === 'function') {
      this.log('[departure-zone-checkpoint] resolving operator-saved deferred zones at verified station');
      const savedSync = await this.device._syncPylonLifecyclePhase('departure_ready', {
        reason:'deferred_operator_zone_before_departure', requireRequestedPhase:true,
      }).catch(e=>({ok:false,reason:String(e?.message||e)}));
      if (savedSync?.ok === false)
        this.log('[departure-zone-checkpoint] deferred native zone not yet confirmed',
          savedSync.reason || 'pending');
    }
    const missingProtection = this.device?._departureProtectionUnresolved?.('departure') || [];
    if (missingProtection.length) {
      this.log('[departure-zone-checkpoint] start blocked: protective mowing zones unverified',missingProtection.join(','));
      this._timeline?.(this._text('Ausfahrt blockiert – erforderliche Mäh-Sperrzone fehlt oder ist unbestätigt',
        'Departure blocked – required mowing no-go zone is missing or unverified'),
        'departure:zone:required_protection_missing');
      await this.safetyWarning('pylon_lifecycle_departure_sync_failed').catch(()=>{});
      return false;
    }
    this._homeCloseArmed = true;
    clearTimeout(this._closeTimer);
    this._closeTimer = null;
    this._closeScheduled = false;
    this._homeCloseInProgress = false;
    this._homeState = 'leaving';
    await this.refreshTileStatus('start cycle begins').catch(() => {});
    if (typeof this.device?._syncPylonLifecyclePhase === 'function') {
      // An unresolved *deletion* must not trigger another native write on this
      // departure. The 15-second attempt above owns it; fall back to vendor
      // boundaries rather than stall indefinitely or repeat a map mutation.
      const lifecycle = departureEdit?.needed
        ? {ok:true, skipped:true, reason:'departure_zone_checkpoint_already_attempted'}
        : await this.device._syncPylonLifecyclePhase('departure', { reason:'garage_start' });
      if (lifecycle?.ok === false) {
        this.log('start blocked: pylon lifecycle could not be prepared', lifecycle?.reason || 'unknown');
        await this.safetyWarning('pylon_lifecycle_departure_sync_failed').catch(() => {});
        this._outbound = null;
        this._missionOutside = false;
        this._homeState = this.isDockedHomeStatus() ? 'home' : 'unknown';
        return false;
      }
    }
    await this._beginOutbound(source || 'START', true);
    this.log('START_REQUESTED', source);

    const markersReady = await this.markers.ready().catch(() => false);
    const markerA = await this.markers.rawLineA().catch(() => null);
    const markerB = await this.markers.rawLineB().catch(() => null);
    const dangerCenter = await this.markers.dangerCenter().catch(() => null);
    this.log('start marker preflight', `ready=${markersReady}`, `A=${markerA ? `${markerA.x},${markerA.y}` : 'missing'}`, `B=${markerB ? `${markerB.x},${markerB.y}` : 'missing'}`, `danger=${dangerCenter ? `${dangerCenter.x},${dangerCenter.y}` : 'missing'}`);
    if (!markersReady) {
      this.log('start blocked: garage marker geometry incomplete');
      await this.markerSetupWarning('start_blocked_markers_incomplete').catch(() => {});
      this._outbound = null;
      this._missionOutside = false;
      this._homeState = this.isDockedHomeStatus() ? 'home' : 'unknown';
      return false;
    }

    if (this.sensorEnabled() && !this.sensorHealthy()) {
      const reasonText = this.sensorUnhealthyReason() || 'sensor_unhealthy';
      this.log('start uses configured door times because sensor is unavailable', reasonText);
      await this.safetyWarning(`sensor_unhealthy_start_fallback_${reasonText}`);
    }

    // If the robot is already outside (for example parked at the Wartungspunkt),
    // do not request the garage door again. Release the original requested action
    // directly. This prevents the start action from getting stuck at the
    // maintenance point during tests or after marker setup.
    // Never infer "already outside" while the garage door is not safely open.
    // A cached/GPS position outside the danger circle can be stale while the mower
    // is still inside the closed garage. Therefore every start from a closed/
    // moving/unknown gate must wait for sensor-open or the full configured timer.
    const verifiedMaintenanceOutside = verifiedMaintenanceOutsideBeforeStart;
    const alreadyOutside = verifiedMaintenanceOutside || (this.isDoorOpenStable()
      && this._homeState === 'away'
      && this.positionKnown()
      && !(await this.markers.isInDangerArea())
      && !this.isDockedHomeStatus());
    if (!alreadyOutside) {
      const ok = await this.ensureDoorOpen(source || 'start', { allowOpenFromDanger: true, minWaitMs: START_MIN_DOOR_OPEN_WAIT_MS });
      if (!ok) return false;
      if (!this._doorOpenReleaseVerified(Math.max(5 * 60 * 1000, this._doorOpenDurationSeconds() * 1000 + 60000))) {
        // ensureDoorOpen only returns true after sensor or configured-time proof.
        // Keep one short late-event grace window so an open contact delivered just
        // after the await boundary can release the already waiting start.
        const graceUntil = Date.now() + 5000;
        while (Date.now() < graceUntil && !this._doorOpenReleaseVerified(Math.max(5 * 60 * 1000, this._doorOpenDurationSeconds() * 1000 + 60000))) {
          await sleep(250);
        }
      }
      if (!this._doorOpenReleaseVerified(Math.max(5 * 60 * 1000, this._doorOpenDurationSeconds() * 1000 + 60000))) {
        this.log('start blocked: gate-open handshake not verified after full sensor/timer window');
        await this.safetyBlock('start_blocked_gate_open_not_verified').catch(() => {});
        this._outbound = null;
        this._missionOutside = false;
        this._homeState = this.isDockedHomeStatus() ? 'home' : 'unknown';
        return false;
      }
      this.log('start gate release verified', this.sensorDoorReliable() ? 'sensor_open' : 'configured_open_time');
      // Hard outbound release guard: after Homey/Flow says the door is open,
      // wait a small extra settle time before the original mower command is sent.
      // This prevents the A2 from starting while the physical gate is still moving.
      if (START_AFTER_OPEN_EXTRA_WAIT_MS > 0) {
        this.log('start release settle wait after door open', `${Math.ceil(START_AFTER_OPEN_EXTRA_WAIT_MS / 1000)}s`);
        await sleep(START_AFTER_OPEN_EXTRA_WAIT_MS);
      }
    } else {
      this.log('start released: mower already outside and door already stable open, no door open request');
    }
    if (token !== this._commandToken) { this.log('start cancelled before release', source); return false; }
    if (!verifiedMaintenanceOutside && !this.isDoorOpenStable()) {
      await this.safetyBlock('start_blocked_gate_not_stably_open').catch(() => {});
      return false;
    }
    const onlineReady = await this._waitForMowerOnlineBeforeStart(source || 'start');
    if (!onlineReady || token !== this._commandToken) return false;
    // The command must be accepted before any departure phase can appear.
    // Keep the pending state during the cloud call and the five-second reaction window.
    const accepted = await fn();
    if (token !== this._commandToken || this._manualGateStopped) {
      this.log('start superseded while command was in flight', source);
      return false;
    }
    if (accepted === false) {
      this.log('start API rejected: garage remains open and stationary retry is guarded', source);
      await this.safetyWarning('start_command_rejected').catch(() => {});
      // An API timeout is not an ACK. Do not retire task identity or show
      // Ausfahrt/Justieren/Positionieren. We may retry only with an OPEN gate,
      // the same command token, and no fresh movement/native start evidence.
      await this._confirmReleasedStart(source, token, fn, false);
      return false;
    }
    this._retireMaintenanceTaskIdentity(source || 'start');
    await this._markOutboundReleased();
    await this._confirmReleasedStart(source, token, fn, true);
    return true;
  }

  async armNamedMissingMaintenancePoint(index, source = 'device_card') {
    // User explicitly pressed a configured P2–P5 on the device card. Homey
    // cannot manufacture that point's native position or safely send opcode
    // 109: the real mower/original app owns the movement and arrival.
    const point = Number(index);
    if (!Number.isInteger(point) || point < 2 || point > 5
        || !String(this.device?._getGarageManagedSetting?.(`maintenance_point_${point}_name`) || '').trim())
      return false;
    if (this.device?._resolveNativeMaintenancePoint?.(point)) return false;
    const garageConfigured = this.device?.getSetting?.('garage_mode_enabled') === true;
    if ((garageConfigured && !this.enabled()) || this.paused || this._manualGateStopped
        || this._manualRecoveryActive || this._emergencyGateContext
        || this._returnGuardActive || this._safeReturnInProgress
        || this._emergencyHoldActive?.() || this.isReturnCycleActive?.()
        || this._externalStartRecoveryActive || this._externalStartIntentHandling
        || this._maintenanceJourneyOwnsNavigation?.()) return false;
    const token = this._commandToken;
    const dock = await this.device?._refreshNativeDockForStart?.({ diagnosticOnly:true })
      || this._freshNativeDockState?.(12000);
    if (!dock || dock.dockingState !== 'IN_STATION'
        || Number(dock.undocking) !== 0 || this._manualGateStopped
        || token !== this._commandToken) {
      this.log('[maintenance-learn] P'+point+' blocked: fresh native dock/u0 absent');
      return false;
    }
    const st = String(this.device?._observedMowerStatus || '').toLowerCase();
    const stAt = Number(this.device?._observedMowerStatusAt || 0);
    if (['mowing','returning','leaving','mapping','remote_control'].includes(st)
        && Date.now()-stAt >= 0 && Date.now()-stAt < 15000) return false;
    // With Garage Mode OFF the same named-point learning association works
    // without any gate action, danger-line assumption or native 109 dispatch.
    // The operator must still use the genuine manufacturer's point request,
    // and actual arrival/coordinates are confirmed by the native observer.
    if (!garageConfigured) {
      this.device._pendingExternalMaintenancePointAssociation = {
        index:point, map:Number(this.device._activeMapIndex ?? 0),
        at:Date.now(), source:'named_homey_button',
      };
      this.device._nativeMaintenanceCommandAt = 0;
      this._externalStartRecoveryPhase = 'AWAIT_NATIVE_MAINTENANCE_REISSUE';
      this.log('[maintenance-learn] P'+point+' no garage: waiting for original-app 109; no motor or gate command',source);
      await this.refreshTileStatus('maintenance original-app learning (garage off) P'+point).catch(()=>{});
      return true;
    }
    // This is the same garage-opening interlock used by a normal stationary
    // outbound maintenance request. No mower motor command is generated here.
    const open = await this.ensureDoorOpen('maintenance_from_home', {allowOpenFromDanger:true});
    if (!open || !this.isDoorOpenStable() || !this._doorOpenReleaseVerified()
        || token !== this._commandToken || this._manualGateStopped) return false;
    // Existing vendor task monitoring consumes this pairing only once and
    // retains its real-map, start-position, movement and code-75 checks.
    this.device._pendingExternalMaintenancePointAssociation = {
      index:point, map:Number(this.device._activeMapIndex ?? 0), at:Date.now(),
      source:'named_homey_button',
    };
    this.device._nativeMaintenanceCommandAt = 0;
    this._externalStartRecoveryPhase = 'AWAIT_NATIVE_MAINTENANCE_REISSUE';
    this._externalMaintenanceSelectionRequiredAt = 0;
    this._homeCloseArmed = false;
    this.log('[maintenance-learn] P'+point+' gate verified OPEN; waiting for new manufacturer 109; no Homey 109 dispatched',source);
    this._garageNotice('maintenance_selection_required', this._text(
      `P${point}: Bitte jetzt in der MOVA-Original-App den Wartungspunkt P${point} anfahren. Homey lernt den Standort erst nach bestätigter Ankunft.`,
      `P${point}: Now select maintenance point P${point} in the original MOVA app. Homey learns the coordinates only after verified arrival.`),
      'maintenance_learn_vendor_reissue', 15 * 60 * 1000);
    await this.refreshTileStatus('maintenance original-app learning P'+point).catch(()=>{});
    return true;
  }

  cancelUnknownExternalMaintenanceSelection(source = 'operator') {
    const pending = (Number(this._externalMaintenanceSelectionRequiredAt || 0) > 0
      && this._externalStartRecoveryPhase === 'MANUAL_REISSUE_REQUIRED')
      || this._externalStartRecoveryPhase === 'AWAIT_NATIVE_MAINTENANCE_REISSUE';
    if (!pending) return false;
    // Cancel the local choice only. No gate, motor or native task command.
    this._externalMaintenanceSelectionRequiredAt = 0;
    this._externalStartRecoveryPhase = null;
    this._externalMaintenanceSelectionLastFailure = null;
    this.device._pendingExternalMaintenancePointAssociation = null;
    this.log('EXTERNAL MAINTENANCE point selection cancelled by operator', source);
    return true;
  }

  async resumeUnknownExternalMaintenance(index, supervised = false) {
    const point = Number(index);
    const at = Number(this._externalMaintenanceSelectionRequiredAt || 0);
    const reject = (reason) => {
      this._externalMaintenanceSelectionLastFailure = reason;
      this.log('EXTERNAL MAINTENANCE point selection rejected', `P${point}`, reason, `phase=${this._externalStartRecoveryPhase}`, `gate=${this._doorState || this.device?.getCapabilityValue?.("garage_door_status") || "unknown"}`);
      return false;
    };
    // Every click must be visible in the diagnostic log, including rejected
    // requests. The vendor task carries opcode 109 but frequently no index.
    this.log('EXTERNAL MAINTENANCE point selection requested', `P${point}`, `pending=${!!at}`, `phase=${this._externalStartRecoveryPhase}`, `gate=${this._doorState || this.device?.getCapabilityValue?.("garage_door_status") || "unknown"}`);
    if (supervised !== true) return reject('operator_confirmation_required');
    if (!Number.isInteger(point) || point < 1 || point > 5) return reject('invalid_point');
    if (!at || Date.now() - at > 15 * 60 * 1000) return reject('no_pending_original_app_task');
    if (!this.enabled()) return reject('garage_automation_disabled');
    if (this._manualRecoveryActive || this._emergencyGateContext) return reject('active_emergency');
    if (this._manualGateStopped) return reject('gate_manually_stopped');
    if (this._returnGuardActive) return reject('return_cycle_active');
    // Re-read native station telemetry. An idle mower emits no periodic dock
    // heartbeat, so demanding a frame less than 12 seconds old made *every*
    // P1-P5 button silently fail after waiting for gate settling and user input.
    const live = await this.device?._refreshNativeDockForStart?.({diagnosticOnly:true});
    const dock = live || this._freshNativeDockState(12000);
    if (!dock || dock.dockingState !== 'IN_STATION' || Number(dock.undocking) !== 0)
      return reject('native_station_not_confirmed');
    // New station telemetry is expected while the command is held.
    // Do not trust visual observations for the passage: require the same
    // physical sensor/timed opening evidence as any ordinary outbound trip.
    if (!this.isDoorOpenStable() || !this._doorOpenReleaseVerified())
      return reject('gate_not_confirmed_fully_open');
    // A configured P2-P5 may still exist in the original MOVA app while its
    // Homey coordinate has disappeared. Keep the selection visible, but do not
    // pretend to know the geometry or secretly dispatch P1. Arm ONE explicit
    // operator association for the NEXT genuine manufacturer 109 task. User
    // reissues the vendor command with the verified OPEN gate; only an actual
    // code-75 arrival and independent stationary positions may learn P2.
    const knownPoints = require('./MaintenancePointResolver').availableGarageMaintenancePointIndexes(this.device);
    if (point > 1 && !knownPoints.includes(point)) {
      const named = String(this.device?._getGarageManagedSetting?.(`maintenance_point_${point}_name`) || '').trim();
      if (!named || Number(this._externalStartTask?.o) !== 109)
        return reject('unverified_point_requires_vendor_109');
      this.device._pendingExternalMaintenancePointAssociation = {
        index:point, map:Number(this.device?._activeMapIndex ?? 0), at:Date.now(),
      };
      // The earlier intercepted vendor mission was stopped at the station.
      // Do not let that retired task mask the NEW observed 109 generation.
      if (this.device._nativeMaintenanceCommandSource === 'original_app')
        this.device._nativeMaintenanceCommandAt = 0;
      this._externalMaintenanceSelectionRequiredAt = 0;
      this._externalStartRecoveryPhase = 'AWAIT_NATIVE_MAINTENANCE_REISSUE';
      this._externalMaintenanceSelectionLastFailure = null;
      this.log('EXTERNAL MAINTENANCE native target unconfirmed; vendor reissue armed',
        `P${point}`, 'operator must command this exact P in original app',
        'no Homey movement command issued');
      return true;
    }
    // Use existing indexed native 109 dispatcher + existing movement watcher
    // and its bounded, independently checked departure retry. Never substitute
    // the default point or the mowing task for the chosen index.
    this._externalMaintenanceSelectionRequiredAt = 0;
    this._externalMaintenanceSelectionLastFailure = null;
    let ok = false;
    try {
      ok = await this.maintenanceRequested('button_maintenance_external_operator_selection',
        () => this.device._goToMaintenancePointGuarded('external_operator_maintenance', point), point);
    } catch (error) {
      this.log('EXTERNAL MAINTENANCE point dispatch exception', `P${point}`, error?.message || String(error));
      this._externalMaintenanceSelectionLastFailure = 'dispatch_exception';
    }
    if (ok !== true) {
      // The operator can retry a clear, failed selection. This restores ONLY
      // the menu; it never repeats an uncertain motor command on its own.
      this._externalMaintenanceSelectionRequiredAt = at;
      await this.safetyWarning('external_maintenance_point_command_rejected').catch(() => {});
      return reject(this._externalMaintenanceSelectionLastFailure || 'native_command_not_accepted');
    }
    this._externalStartRecoveryPhase = null;
    this.log(this._maintenanceCommandAckUncertain?.token === this._commandToken
      ? 'EXTERNAL MAINTENANCE 109 cloud ACK uncertain; awaiting physical proof'
      : 'EXTERNAL MAINTENANCE indexed native 109 accepted; awaiting physical departure', `P${point}`);
    return true;
  }

  async maintenanceRequested(source, fn) {
    if (this._emergencyCommandBlocked(`maintenance:${source}`)) return false;
    this._maintenanceArrivalClose = null;
    this._clearOutsideMowingTileAck();
    if (this._manualGateStopped) { await this.safetyWarning('manual_gate_stop_hold'); return false; }
    const token = this._commandToken;
    const targetIndex = Math.max(1, Math.min(5, Math.trunc(Number(arguments[2]) || 1)));
    if (targetIndex > 1) {
      this._lastMaintenanceReachedAt = 0;
      this._returnMaintenanceStopProof = null;
    }
    if (!this.enabled()) {
      // With garage automation deliberately PAUSED the native P1..P5 command is
      // still allowed. Keep ONLY its target identity; do not operate the gate.
      // If automation is re-enabled BEFORE the native arrival, the eventual
      // verified arrival may enter the ordinary guarded close path. The token
      // ensures STOP/return/new mowing/another point supersedes this handoff.
      const accepted = await Promise.resolve().then(fn);
      const nativeIndex = Number(this.device?._nativeMaintenanceTargetIndex);
      const nativeAt = Number(this.device?._nativeMaintenanceCommandAt || 0);
      const now = Date.now();
      if (accepted !== false && this.device?.getSetting?.('garage_mode_enabled') === true
          && this.paused === true && !this._manualGateStopped
          && this._commandToken === token && nativeIndex === targetIndex
          && Number.isInteger(targetIndex) && targetIndex >= 1 && targetIndex <= 5
          && nativeAt > 0 && nativeAt <= now && now - nativeAt < 120000
          && ['button_maintenance','flow_maintenance','cmd_maintenance_point'].some(x=>String(source).includes(x))) {
        // Retire an old P1 callback: an earlier point must not claim the
        // confirmation for a newly dispatched P2..P5 task.
        clearInterval(this._maintenanceWatch);
        this._maintenanceWatch = null;
        this._maintenanceReachedCallback = null;
        this._maintenanceTimeoutCallback = null;
        this._manualMaintenanceTargetIndex = targetIndex;
        this._manualMaintenanceTransit = true;
        this._manualMaintenanceReached = false;
        this._manualMaintenancePhase = 'transit';
        this._manualMaintenancePhaseStartedAt = now;
        this._pausedMaintenanceHandoff = { token, index:targetIndex, nativeAt, at:now, source:String(source) };
        this.log('paused waypoint command recorded without gate action', `P${targetIndex}`, `token=${token}`);
      } else {
        this._pausedMaintenanceHandoff = null;
      }
      return accepted;
    }
    this._pausedMaintenanceHandoff = null;
    // A second button press at the confirmed stationary point is an idempotent
    // acknowledgement. Do not clear the proof and issue another opcode 109.
    if (targetIndex === 1 && this._manualMaintenanceReached && !this._manualMaintenanceTransit
        && await this._isCurrentlyAtKnownMaintenancePoint().catch(() => false)) {
      this.log('maintenance point reached', 'already_at_verified_point');
      this._trigger('garage_maintenance_point_reached', 'already_verified');
      await this.refreshTileStatus('maintenance point reconfirmed').catch(() => {});
      this._maintenanceArrivalClose = { token, index: targetIndex, position: { ...this.pos() }, createdAt: Date.now() };
      await this._tryMaintenanceArrivalClose();
      this._scheduleMaintenanceArrivalCloseFollowup();
      return true;
    }
    const src = String(source || 'MAINTENANCE');
    // Native IN_STATION readback wins over the transient `leaving` display
    // set during external-start recovery. Otherwise restored P2 is incorrectly
    // treated as an outdoor recalibration and receives an unrelated PAUSE.
    const nativeDockAtStart = this._freshNativeDockState?.(30000);
    const startedFromHome = this.isHomeStatus()
      || (nativeDockAtStart?.dockingState === 'IN_STATION'
        && Number(nativeDockAtStart.undocking) === 0);
    const explicitManualMaintenance = ['button_maintenance', 'flow_maintenance', 'cmd_maintenance_point']
      .some((name) => src.includes(name));
    if (explicitManualMaintenance) {
      // A deliberate maintenance-point command is a new, independent trip. It
      // supersedes stale return bookkeeping from an earlier dock/return cycle;
      // otherwise the arrival callback can incorrectly keep the garage open
      // even though this trip has ended at a verified stationary point.
      this._setReturnContext(RETURN_STATES.IDLE, 'explicit_manual_maintenance_trip');
      this._returnGuardActive = false;
      this._safeReturnInProgress = false;
      this._externalReturnHandling = false;
      this._spatialReturnHandling = false;
      this._pendingDirectDockFn = null;
      this._pendingDirectReturnToken = 0;
      this._pendingDirectReturnSource = null;
      this.log(this._text(
        'Eigenständige Wartungspunktfahrt löst einen veralteten Rückkehrstatus ab',
        'Independent maintenance-point trip cleared stale return state',
      ), src);
    }
    this._manualMaintenanceCalibration = explicitManualMaintenance && startedFromHome;
    // An explicit maintenance request made while already outside is also a valid
    // calibration run. This lets the user press the maintenance button while the
    // mower is physically standing at the native point and correct a stale marker
    // without first docking again.
    // Never recalibrate/overwrite the immutable maintenance point from an
    // arbitrary outside position. A manual button press while the mower is
    // already outside is a travel command only.
    this._manualMaintenanceRecalibration = explicitManualMaintenance && !startedFromHome;
    this._manualMaintenanceTransit = explicitManualMaintenance;
    this._manualMaintenanceTargetIndex = targetIndex;
    this._manualMaintenanceReached = false;
    this._manualMaintenanceLastPos = null;
    this._manualMaintenanceStableSince = 0;
    this._manualMaintenancePhase = explicitManualMaintenance ? 'start_pending' : 'idle';
    this._manualMaintenanceCommandAcceptedAt = 0;
    this._manualMaintenanceExitUntil = 0;
    this._manualMaintenancePhaseStartedAt = Date.now();
    this._manualMaintenancePhasePos = this.pos() ? { ...this.pos() } : null;
    this._manualMaintenanceMovementSeen = false;
    if (explicitManualMaintenance) this.lastRequestedAction = src;
    // In garage mode the maintenance point is only part of an explicit return
    // path or a deliberate manual maintenance button. It must never be requested
    // from normal mowing/status/position heuristics.
    if (this.isMowing() && !src.includes('return') && !explicitManualMaintenance) {
      this.log('maintenance request blocked during mowing', src);
      await this.safetyWarning('maintenance_blocked_while_mowing');
      return false;
    }

    const directOutsideMaintenance = explicitManualMaintenance && !startedFromHome;
    if (directOutsideMaintenance) {
      // The native maintenance point is on the lawn side. When the mower is
      // already outside, do NOT create a fake garage departure and do NOT touch
      // the gate. Take ownership of the current mowing task, pause it into a
      // commandable state, then issue opcode 109. Field logs showed that sending
      // 109 directly into active mowing can return transport code 0 while the
      // mower simply continues mowing.
      this._clearOutboundStatusTimers();
      this._outbound = null;
      this._missionOutside = true;
      this._homeState = 'away';
      this._lastOutdoorActivityAt = Date.now();
      this.log('MAINTENANCE_REQUESTED outside: garage bypass, current task will be handed over', source);
      const prepared = await this._prepareMowerForReturnPath('manual_maintenance_outside');
      if (prepared === false || token !== this._commandToken || this._manualGateStopped) {
        this._manualMaintenanceTransit = false;
        this._manualMaintenanceCalibration = false;
        this._manualMaintenanceRecalibration = false;
        this._manualMaintenancePhase = 'idle';
        await this.safetyWarning('maintenance_pause_unconfirmed');
        return false;
      }
    } else {
      await this._beginOutbound(source || 'MAINTENANCE', false);
      this.log('MAINTENANCE_REQUESTED', source);

      // From dock/home, open first so the mower can leave the garage to the original maintenance point.
      if (startedFromHome) {
        const ok = await this.ensureDoorOpen('maintenance_from_home', { allowOpenFromDanger: true });
        if (!ok) return false;
        if (!this.isDoorOpenStable()) return false;
      }
    }

    if (token !== this._commandToken) { this.log('maintenance cancelled before command', source); return false; }

    // Start physical arrival monitoring BEFORE awaiting the cloud write. A2 field
    // logs prove that opcode 109 can already be executing (TASK o=109, robot moving)
    // while the HTTP action promise is still outstanding. Waiting for that promise
    // used to leave Homey stuck at garage_start_pending and could miss the actual
    // arrival completely. The watcher remains geometry-based and cannot fabricate
    // arrival merely because the request was dispatched.
    // Closing belongs to the confirmed arrival, not the optional navigation
    // callback. Keep ownership across a temporarily blocked close attempt.
    if (explicitManualMaintenance) this._maintenanceArrivalClose = { token, index: targetIndex, createdAt: Date.now() };
    this._watchMaintenanceReached(async () => {
      if (token !== this._commandToken) { this.log('maintenance callback ignored: superseded', source); return; }
      this._manualMaintenanceTransit = false;
      this._manualMaintenanceReached = true;
      this._manualMaintenanceTargetReachedIndex = targetIndex;
      this._clearManualMaintenanceStatusTimers();
      // UI paint must not delay the native-arrival DOCK handoff.
    this.refreshTileStatus('maintenance point reached').catch(() => {});
    });

    const accepted = await fn();
    if (token !== this._commandToken) {
      this.log('maintenance cloud reply ignored: newer command owns the journey', source);
      return false;
    }
    // Native MQTT may have committed a real arrival while an HTTP request was
    // still waiting. An eventual cloud "offline" is not permission to erase it.
    if (accepted === false && this._manualMaintenanceReached
        && !this._manualMaintenanceTransit && token === this._commandToken) {
      this.log('maintenance late cloud rejection ignored: verified native arrival already committed',
        `P${targetIndex}`);
      this._maintenanceCommandAckUncertain = null;
      return true;
    }
    if (accepted === false && token === this._commandToken && this._maintenanceWatch
        && this._maintenanceRequestedAt > 0
        && Date.now() - this._maintenanceRequestedAt < MAINTENANCE_TIMEOUT_MS) {
      // Field 30 Oct: the API replied "Device offline" even though MQTT opcode
      // 109 and a subsequent native P1 arrival proved the action ran.  An HTTP
      // rejection is not a physical command cancellation. Keep the existing
      // *bounded* geometry/native-arrival watcher: it will close the gate only
      // after its ordinary independent arrival proof (or expire safely).
      // Never retry opcode 109 automatically while transport outcome is unknown.
      this._maintenanceCommandAckUncertain = {
        token, index: targetIndex, commandAt: Number(this.device?._nativeMaintenanceCommandAt || 0),
        markedAt: Date.now(), source
      };
      this.log('maintenance command cloud ACK uncertain: awaiting bounded native P1-P5 arrival',
        `P${targetIndex}`, source);
    }
    if (accepted === false && !(token === this._commandToken && this._maintenanceWatch
        && this._maintenanceRequestedAt > 0
        && Date.now() - this._maintenanceRequestedAt < MAINTENANCE_TIMEOUT_MS)) {
      // A genuinely superseded/closed watch cannot be revived by a late HTTP
      // reply. No new movement or gate authorization is inferred here.
      clearInterval(this._maintenanceWatch);
      this._maintenanceWatch = null;
      this._maintenanceRequestedAt = 0;
      this._maintenanceReachedCallback = null;
      this._maintenanceTimeoutCallback = null;
      this.log('maintenance command rejected; no heuristic reached state', source);
      this._manualMaintenanceCalibration = false;
      this._manualMaintenanceRecalibration = false;
      this._manualMaintenanceTransit = false;
      this._manualMaintenanceReached = false;
      this._manualMaintenanceLastPos = null;
      this._manualMaintenanceStableSince = 0;
      this._manualMaintenancePhase = 'idle';
      this._manualMaintenancePhaseStartedAt = 0;
      this._manualMaintenancePhasePos = null;
      this._manualMaintenanceMovementSeen = false;
      await this.returnOperationalHold('maintenance_command_rejected');
      return false;
    }

    // The physical watcher may have confirmed arrival while sendAction was still
    // pending. Never resurrect transit after that authoritative geometry proof.
    if (this._manualMaintenanceReached && !this._manualMaintenanceTransit) {
      this._maintenanceCommandAckUncertain = null;
      return true;
    }

    if (explicitManualMaintenance) {
      // Phase timing belongs to command DISPATCH, not to the delayed HTTP response.
      this._manualMaintenanceCommandAcceptedAt = Number(this.device._nativeMaintenanceCommandAt || 0) || Date.now();
      this._manualMaintenancePhasePos = this.pos() ? { ...this.pos() } : this._manualMaintenancePhasePos;
      if (directOutsideMaintenance) {
        this._manualMaintenanceExitUntil = 0;
        this._manualMaintenancePhase = 'transit';
        this._manualMaintenancePhaseStartedAt = this._manualMaintenanceCommandAcceptedAt;
        this._clearManualMaintenanceStatusTimers();
        this.log('manual maintenance transit started outside; garage phases bypassed', this._maintenancePointLabel(targetIndex));
        await this.refreshTileStatus('manual maintenance transit outside').catch(() => {});
      } else {
        this._manualMaintenanceExitUntil = this._manualMaintenanceCommandAcceptedAt + OUTBOUND_EXITING_DISPLAY_MS;
        await this._updateManualMaintenanceJourneyPhase().catch(() => {});
        this.log(accepted === false ? 'manual maintenance cloud ACK uncertain; native arrival monitored' : 'manual maintenance command acknowledged', this._maintenancePointLabel(targetIndex), `dispatchAge=${Math.max(0, Date.now() - this._manualMaintenanceCommandAcceptedAt)}ms`);
        await this.refreshTileStatus(accepted === false ? 'manual maintenance native arrival pending' : 'manual maintenance command acknowledged').catch(() => {});
        this._scheduleManualMaintenanceStatusTimers();
      }
    }
    return true;
  }

  async stopGateManually() {
    // Latch synchronously before any asynchronous motor/telemetry operation.
    this._manualGateStopped = true;
    this._trigger('garage_stop_requested', 'manual_widget_stop');
    this.cancelPendingCommand('manual_gate_stop');
    for (const key of ['_doorFinalTimer', '_stableOpenTimer', '_sensorMovementTimer']) {
      clearTimeout(this[key]); this[key] = null;
    }
    await this.device.setStoreValue('garage_manual_gate_stopped', true);
    await this.setDoorState('unknown', { immediate: true, derived: true });
    await this.safetyWarning('manual_gate_stop_hold');
    // Pause through the existing confirmed-native path; do not invent PAUSED.
    await this._pauseMowerForGateInterlock('manual_stop', 'manual_gate_stop').catch(() => {});
    return true;
  }

  async _manualGateOutsidePositionProof() {
    const p = this.pos();
    if (!p || !['mqtt','siid:1:4'].includes(String(p.source || ''))
        || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return false;
    const age = Date.now() - Number(p.ts || 0);
    if (age < 0 || age > RETURN_OPEN_POSITION_MAX_AGE_MS) return false;
    const native = String(this.status() || '').toLowerCase();
    if (['returning', 'docked', 'charging', 'charging_completed', 'leaving',
      'mapping', 'remote_control', 'error'].includes(native)
        || this._safeReturnInProgress || this._returnGuardActive) return false;
    const danger = await this.markers.rawDangerState(p).catch(() => null);
    if (!danger?.known || danger.inside) return false;
    const clearance = Number(danger.distance) - Number(danger.radius);
    if (!Number.isFinite(clearance) || clearance <= MANUAL_GATE_MIN_DANGER_CLEARANCE_MM) {
      this.log('manual gate blocked: insufficient danger-circle clearance',
        `clearance=${Math.round(clearance)}mm required>${MANUAL_GATE_MIN_DANGER_CLEARANCE_MM}mm`);
      return false;
    }
    // Apply exactly the same finite A-B exclusion corridor to manual OPEN and
    // manual CLOSE. Near-line lawn passes are not safe merely because the
    // circle around the garage door was drawn elsewhere.
    const [lineDistance, signedLine, direction] = await Promise.all([
      this.markers.distanceToSafetyLineSegment?.(p),
      this.markers.signedDistanceToLine?.(p),
      this.markers.directionState?.(),
    ]).catch(() => [null,null,null]);
    const lawnSide = Number(direction?.lawnSide);
    const signed = Number(signedLine?.distance);
    if (!Number.isFinite(lineDistance)
        || lineDistance <= MANUAL_GATE_MIN_SAFETY_LINE_DISTANCE_MM
        || !direction?.known
        || !Number.isFinite(signed) || ![-1,1].includes(lawnSide)
        || signed * lawnSide <= 0) {
      this.log('manual gate blocked: safety-line corridor / lawn-side proof missing',
        `lineDistance=${Number.isFinite(lineDistance) ? Math.round(lineDistance) : '?'}mm`,
        `required>${MANUAL_GATE_MIN_SAFETY_LINE_DISTANCE_MM}mm`,
        `lawnSide=${direction?.lawnSide ?? '?'}`);
      return false;
    }
    const dock = this.device?._dockPos;
    const dockDistance = dock ? this._distance(p, dock) : null;
    if (dockDistance === null || !Number.isFinite(Number(dockDistance))
        || Number(dockDistance) < 1500) return false;
    this.log('manual gate motion: fresh internal outside position accepted',
      `clearance=${Math.round(clearance)}mm; lineDistance=${Math.round(lineDistance)}mm; dockDistance=${Math.round(Number(dockDistance))}mm`);
    return true;
  }

  _manualGateOpenDockProof() {
    const now = Date.now();
    const native = String(this.status?.() || '').toLowerCase();
    if (['mowing','edge_mowing','returning','leaving','mapping','remote_control','error'].includes(native)
        || this._missionOutside || this._safeReturnInProgress || this._returnGuardActive) return false;
    const binary = this.device?._mowerBinaryDiag;
    const binaryAt = Number(this.device?._mowerBinaryDiagAt || 0);
    const binaryFresh = !!binary && binaryAt > 0 && now - binaryAt >= 0 && now - binaryAt <= 15000;
    // Opening is allowed from a freshly proven stationary IN_STATION state even
    // if the separate chargingLive bit has not caught up yet. Any undocking edge
    // blocks the proof immediately. Closing remains on _strongDockCloseProof().
    if (binaryFresh) return binary.dockingState === 'IN_STATION' && Number(binary.undocking) === 0;
    const charging = String(this.device?.getCapabilityValue?.('charging_status') || '').toLowerCase();
    const chargeAge = now - Number(this.device?._chargingStatusAt || 0);
    return this.isDockedHomeStatus() && !this._outbound && !this._manualMaintenanceTransit
      && chargeAge >= 0 && chargeAge <= 15000
      && ['charging', 'charging_completed', 'docked'].includes(charging);
  }

  async manualGateRequest(action, opts = {}) {
    if (this._manualRecoveryActive) {
      if (action === 'stop') return this.stopGateManually();
      return this.manualRecoveryGateCommand(action, opts.supervised === true);
    }
    // Physical motor STOP is an explicit emergency action even when AUTO is
    // paused. Unlike OPEN/CLOSE it does not authorize any new gate movement.
    if (action === 'stop' && this.device?.getSetting?.('garage_mode_enabled') === true)
      return this.stopGateManually();
    if (!this.enabled()) throw new Error(this._text('Garagenautomatik pausiert: erst beaufsichtigte manuelle Übernahme aktivieren', 'Garage automation paused: activate supervised manual takeover first'));
    this._maintenanceArrivalClose = null;
    if (this._emergencyCommandBlocked(`manual_gate:${action}`)) return false;
    if (!['open', 'close'].includes(action)) throw new Error(userText(this.device.homey,'user_error.invalid_gate_command',{},"Ungültiger Torbefehl"));
    // A request for an end-position already corroborated by the real OPEN/CLOSED
    // sensor contact is an idempotent NO-OP, not a new gate motor pulse. This
    // avoids misleading "closing blocked" feedback when the gate is already
    // physically closed, and never overrides STOP/emergency or unknown data.
    const settled = action === 'open' ? 'open' : 'closed';
    const sensorContact = this.device?.getCapabilityValue?.('garage_sensor_contact_status');
    const sensorOnline = this.device?.getCapabilityValue?.('garage_sensor_available_status') === 'online';
    if (!this._manualGateStopped && sensorOnline && sensorContact === settled
        && this._lastSensorContactState === settled && this.doorState() === settled
        && this._doorStateDerived !== true) {
      this.log('manual gate command already fulfilled by actual sensor contact; no motor pulse', action);
      return true;
    }
    // A new explicit request may leave STOP only with fresh physical clearance.
    const manualToken = this._commandToken;
    const p = this.pos(), age = Date.now() - Number(p?.ts || 0);
    const d = await this.markers.rawDangerState(p).catch(() => null);
    if (manualToken !== this._commandToken) return false;
    const safeDockClose = (this._homeDockReadyForClose() || this._strongDockCloseProof())
      && this.isDockedHomeStatus() && !this._outbound && !this._manualMaintenanceTransit;
    const safeDockOpen = action === 'open' && this._manualGateOpenDockProof();
    const safeDock = action === 'open' ? safeDockOpen : safeDockClose;
    // Keep manual directions symmetric during a still-protected outbound or
    // waypoint transit. A distant coordinate alone must not let MANUAL OPEN
    // bypass the same active-gate phase that correctly prohibits MANUAL CLOSE.
    if (!safeDock && (this._outboundPhaseProtected() || this._maintenanceCloseProtected())) {
      throw new Error(this._text(
        'Manueller Torbefehl gesperrt: Ausfahrt oder Wartungspunktfahrt noch nicht sicher abgeschlossen',
        'Manual gate command blocked: departure or waypoint transit has not safely finished'));
    }
    const clearOutside = !!p?.ts && age >= 0 && age <= RETURN_OPEN_POSITION_MAX_AGE_MS && !!d?.known
      && Number.isFinite(Number(d.distance)) && Number.isFinite(Number(d.radius))
      && Number(d.distance) > Number(d.radius) + RETURN_GATE_CLEARANCE_MM;
    // Both manual directions need the SAME outdoor physical clearance.
    // Previously OPEN accepted merely 'outside the radius', whereas CLOSE
    // also checked the dock distance/native return state. This let an OPEN
    // pulse through at a location where CLOSE was correctly refused.
    const outsideMotionProof = !safeDock && clearOutside
      && await this._manualGateOutsidePositionProof().catch(() => false);
    if (manualToken !== this._commandToken) return false;
    if (!safeDock && !outsideMotionProof) {
      throw new Error(action === 'open'
        ? this._text('Tor öffnen gesperrt: Mäher weder sicher in Station noch mit frischer Position außerhalb des Gefahrenbereichs bestätigt', 'Opening blocked: mower is not confirmed safely docked or outside the danger area with a fresh position')
        : this._text('Tor schließen gesperrt: frische sichere Dock- oder Außenposition erforderlich', 'Closing blocked: a fresh safe dock or outside position is required'));
    }
    if (manualToken !== this._commandToken) return false;
    const wasStopped = this._manualGateStopped;
    this._manualGateStopped = false;
    let accepted = false;
    try {
      const maintenanceClear = action === 'close' && await this._isCurrentlyAtKnownMaintenancePoint().catch(() => false);
      const internalOutsideClear = action === 'close' && outsideMotionProof;
      accepted = action === 'open'
        ? await this.requestOpen('widget_manual_open', { allowOpenFromDanger: safeDock })
        : await this.requestClose('widget_manual_close', {
          requireExitConfirmed: !safeDock && !maintenanceClear && !internalOutsideClear,
          maintenanceArrivalVerified: maintenanceClear,
          manualOutsidePositionVerified: internalOutsideClear,
        });
    }
    finally {
      if (manualToken === this._commandToken && !accepted && wasStopped) this._manualGateStopped = true;
      await this.device.setStoreValue('garage_manual_gate_stopped', !!this._manualGateStopped);
    }
    return accepted;
  }

  async _reuseVerifiedMaintenanceArrivalForReturn(token) {
    // A just-completed manual maintenance journey already contains the strongest
    // arrival proof we have: authoritative waypoint, bounded stationary dwell and
    // a verified reached state. A Return button pressed immediately afterwards
    // must not throw that proof away and wait for two NEW position timestamps that
    // may not arrive while the mower is stationary. Reuse it only for a short,
    // bounded window and re-check the current physical position/clearance.
    if (Number(this._manualMaintenanceTargetReachedIndex || 1) !== Number(this._lockedReturnMaintenancePoint?.index || 1)
        || !this._manualMaintenanceReached || this._manualMaintenancePhase !== 'reached'
        || this._manualMaintenanceTransit || !Number(this._lastMaintenanceReachedAt || 0)) return null;
    const proofAge = Date.now() - Number(this._lastMaintenanceReachedAt || 0);
    if (proofAge < 0 || proofAge > RETURN_MAINTENANCE_ARRIVAL_REUSE_MAX_MS) return null;
    if (token !== this._commandToken || this._manualGateStopped || this._emergencyGateContext
        || this._emergencyHoldActive() || ['opening', 'closing'].includes(this.doorState())) return false;

    const target = this._lockedReturnMaintenancePoint
      || (typeof this.device._resolveNativeMaintenancePoint === 'function'
        ? await Promise.resolve(this.device._resolveNativeMaintenancePoint(this.device._maintenancePointIndex())).catch(() => null)
        : await safeGetStoreValue(this.device, 'garage_maintenance_point'));
    const current = this.pos();
    const ts = Number(current?.ts || 0);
    const positionAge = Date.now() - ts;
    const distance = this._distance(current, target);
    if (distance !== null && distance > MAINTENANCE_CONFIRM_RADIUS_MM) return null;
    if (!target || !current || !ts || positionAge < 0 || positionAge > 30000
        || distance === null) return false;
    const b = this.device._mowerBinaryDiag, bAge = Date.now() - Number(this.device._mowerBinaryDiagAt || 0);
    if (b && bAge >= 0 && bAge <= 15000 && b.dockingState === 'IN_STATION') return false;
    const danger = await this.markers.rawDangerState(current).catch(() => null);
    if (!danger?.known || !Number.isFinite(Number(danger.radius)) || !Number.isFinite(Number(danger.distance))
        || Number(danger.distance) <= Number(danger.radius) + RETURN_GATE_CLEARANCE_MM) return false;

    const native = () => String(this.device._observedMowerStatus || this.status() || '').toLowerCase();
    if (!['paused', 'idle', 'standby'].includes(native())) {
      if (!this.device?._api?.pause) return false;
      const pauseAt = Date.now();
      const pause = () => this.device._api.pause(this.device.getData().id);
      const accepted = typeof this.device._safeWrite === 'function'
        ? await this.device._safeWrite('garage_verified_maintenance_return_pause', pause) : await pause();
      if (accepted === false) return false;
      if (!(await this._waitForNativePause(token, pauseAt, 4500))) {
        this.log('verified maintenance return: physical/native stop proof missing', `age=${Date.now()-pauseAt}ms`);
        return false;
      }
    }

    const confirmedPosition = this.pos();
    const confirmedTs = Number(confirmedPosition?.ts || 0);
    const confirmedAge = Date.now() - confirmedTs;
    const confirmedDistance = this._distance(confirmedPosition, target);
    if (!confirmedPosition || !confirmedTs || confirmedAge < 0 || confirmedAge > RETURN_OPEN_POSITION_MAX_AGE_MS
        || confirmedDistance === null || confirmedDistance > MAINTENANCE_CONFIRM_RADIUS_MM) return false;
    this._returnMaintenanceStopProof = {
      at: Date.now(),
      position: { x: Number(confirmedPosition.x), y: Number(confirmedPosition.y), ts: confirmedTs },
    };

    this._manualMaintenanceTransit = false;
    this._manualMaintenancePhase = 'reached';
    this._lockedReturnMaintenancePoint = target;
    this.log('verified maintenance arrival reused for return', `proofAge=${proofAge}ms`, `positionAge=${positionAge}ms`);
    return this._verifiedMaintenanceReturnClearance();
  }

  async _establishMaintenanceReturnReleaseFromCurrentPosition(token) {
    const target = this._lockedReturnMaintenancePoint;
    const initial = this.pos();
    const distance = this._distance(initial, target);
    const initialAge = Date.now() - Number(initial?.ts || 0);
    if (!target || !initial?.ts || initialAge < 0 || initialAge > RETURN_OPEN_POSITION_MAX_AGE_MS
        || distance === null || distance > MAINTENANCE_CONFIRM_RADIUS_MM) return null;
    if (this._manualGateStopped || this._emergencyGateContext || this._emergencyHoldActive()
        || ['opening', 'closing'].includes(this.doorState())) return false;

    const hadPriorVerifiedArrival = Number(this._manualMaintenanceTargetReachedIndex || 1) === Number(this._lockedReturnMaintenancePoint?.index || 1)
      && this._manualMaintenanceReached === true
      && this._manualMaintenancePhase === 'reached'
      && Number(this._lastMaintenanceReachedAt || 0) > 0;
    const native = () => String(this.device._observedMowerStatus || this.status() || '').toLowerCase();
    if (!['paused', 'idle', 'standby'].includes(native())) {
      if (!this.device?._api?.pause) return false;
      const pauseAt = Date.now();
      const pause = () => this.device._api.pause(this.device.getData().id);
      const accepted = typeof this.device._safeWrite === 'function'
        ? await this.device._safeWrite('garage_current_maintenance_pause', pause) : await pause();
      if (accepted === false) return false;
      if (!(await this._waitForNativePause(token, pauseAt, 4500))) return false;
      // A purely positional stop proof may renew an already verified maintenance
      // hold, but it must never invent a first-time maintenance arrival while the
      // native mower still says RETURNING.
      if (!['paused', 'idle', 'standby'].includes(native()) && !hadPriorVerifiedArrival) return false;
    }

    await this.safetyWarning('maintenance_current_wait');
    let first = null;
    let lastTs = 0;
    let hits = 0;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (token !== this._commandToken || this._manualGateStopped || this._emergencyGateContext
          || this._emergencyHoldActive() || ['opening', 'closing'].includes(this.doorState())) return false;
      const p = this.pos();
      const ts = Number(p?.ts || 0);
      const age = Date.now() - ts;
      const b = this.device._mowerBinaryDiag;
      const bAge = Date.now() - Number(this.device._mowerBinaryDiagAt || 0);
      const danger = await this.markers.rawDangerState(p).catch(() => null);
      const dist = this._distance(p, target);
      if (!p || !ts || age < 0 || age > RETURN_OPEN_POSITION_MAX_AGE_MS
          || dist === null || dist > MAINTENANCE_CONFIRM_RADIUS_MM
          || (b && bAge >= 0 && bAge <= 15000 && b.dockingState === 'IN_STATION')
          || !danger?.known || !Number.isFinite(Number(danger.radius)) || !Number.isFinite(Number(danger.distance))
          || Number(danger.distance) <= Number(danger.radius) + RETURN_GATE_CLEARANCE_MM) return false;
      if (ts > lastTs) {
        if (first && this._distance(p, first) > MAINTENANCE_STATIONARY_DRIFT_MM) return false;
        if (!first) first = { ...p, observedAt: Date.now() };
        hits += 1;
        lastTs = ts;
        if (hits >= 2 && Date.now() - first.observedAt >= 2000) {
          this._manualMaintenanceReached = true;
          this._manualMaintenanceTransit = false;
          this._manualMaintenancePhase = 'reached';
          this._lastMaintenanceReachedAt = Date.now();
          this._returnMaintenanceStopProof = {
            at: Date.now(),
            position: { x: Number(p.x), y: Number(p.y), ts },
          };
          return this._verifiedMaintenanceReturnClearance();
        }
      }
      await sleep(500);
    }
    return false;
  }

  async _isCurrentlyAtKnownMaintenancePoint(radiusMm = 1200) {
    return this._verifiedMaintenanceReturnClearance(Math.min(Number(radiusMm) || MAINTENANCE_CONFIRM_RADIUS_MM, MAINTENANCE_CONFIRM_RADIUS_MM));
  }

  isVerifiedMaintenanceStart() {
    return this.enabled() && this._manualMaintenanceReached === true
      && this._manualMaintenancePhase === 'reached' && !this._manualMaintenanceTransit
      && !this.isDockedHomeStatus() && !this.isReturning()
      && !this._safeReturnInProgress && !this._returnGuardActive
      && (!this._returnContext || [RETURN_STATES.IDLE, RETURN_STATES.MAINTENANCE, RETURN_STATES.HOME_CONFIRMED].includes(this._returnContext))
      && !this._manualGateStopped;
  }

  async _verifiedMaintenanceReturnClearance(radiusMm = MAINTENANCE_CONFIRM_RADIUS_MM) {
    // The old distance-only shortcut accepted a MOVING mower up to 1.2 m from
    // the waypoint and opened the physical gate under it. A nearby coordinate
    // is NOT proof of arrival or of a cleared gate movement area.
    const current = this.pos();
    const ts = Number(current?.ts || 0);
    const age = Date.now() - ts;
    const arrived = this._manualMaintenanceReached === true
      && this._manualMaintenancePhase === 'reached'
      && Number(this._lastMaintenanceReachedAt || 0) > 0;
    const nativeStationary = ['paused', 'idle', 'standby'].includes(String(this.device._observedMowerStatus || this.status() || '').toLowerCase());
    const maintenanceStopProof = this._returnMaintenanceStopProof;
    const maintenanceStopProofFresh = !!maintenanceStopProof
      && Date.now() - Number(maintenanceStopProof.at || 0) >= 0
      && Date.now() - Number(maintenanceStopProof.at || 0) <= 10000
      && this._distance(current, maintenanceStopProof.position) !== null
      && this._distance(current, maintenanceStopProof.position) <= MAINTENANCE_STATIONARY_DRIFT_MM;
    const stationary = nativeStationary || maintenanceStopProofFresh;
    if (!arrived || !stationary || !current || !ts || age < 0 || age > RETURN_OPEN_POSITION_MAX_AGE_MS) return false;
    const target = this._lockedReturnMaintenancePoint
      || (typeof this.device._resolveNativeMaintenancePoint === 'function'
        ? await Promise.resolve(this.device._resolveNativeMaintenancePoint(this.device._maintenancePointIndex())).catch(() => null)
        : await safeGetStoreValue(this.device, 'garage_maintenance_point'));
    const distance = this._distance(current, target);
    if (distance === null || distance > radiusMm) return false;
    const danger = await this.markers.rawDangerState(current).catch(() => null);
    return !!danger?.known && Number.isFinite(Number(danger.radius)) && Number.isFinite(Number(danger.distance))
      && Number(danger.distance) > Number(danger.radius) + RETURN_GATE_CLEARANCE_MM;
  }

  async _independentStationaryMaintenanceRelease(proof, token) {
    // g2408 can continue reporting native "mowing" after a confirmed 109
    // arrival (error 75) even though it is physically stationary. Do not
    // trust that label OR a single map position to authorize docking. Only
    // fresh independent native position reads, unchanged current MQTT/map
    // geometry, a valid arrival context and a verified OPEN gate can release.
    if (!proof || token !== this._commandToken || !this._manualMaintenanceReached
        || this._manualMaintenancePhase !== 'reached'
        || Number(this._lastMaintenanceReachedAt || 0) !== proof.arrivalAt
        || this._returnContext !== RETURN_STATES.MAINTENANCE
        || !this._safeReturnInProgress || !this._returnGuardActive
        || this._manualGateStopped || this._emergencyHoldActive()
        || this._emergencyGateContext || this._gateMotionPauseActive
        || !this.isDoorOpenStable() || !this._doorOpenReleaseVerified()) return false;
    const initial = this.pos();
    const at = Number(initial?.ts || 0);
    if (!at || Date.now() - at < 0 || Date.now() - at > RETURN_OPEN_POSITION_MAX_AGE_MS
        || this._distance(initial, proof.position) > MAINTENANCE_STATIONARY_DRIFT_MM
        || this._distance(initial, proof.target) > MAINTENANCE_CONFIRM_RADIUS_MM) return false;
    const nativeDock = this._freshNativeDockState();
    if (nativeDock?.dockingState === 'IN_STATION' || Number(nativeDock?.undocking) === 1) return false;
    const independent = await this._readNativeStationaryPositionForGarage(token, initial, 100);
    const latest = this.pos();
    if (!independent || token !== this._commandToken || !this._manualMaintenanceReached
        || this._manualMaintenancePhase !== 'reached'
        || !this.isDoorOpenStable() || !this._doorOpenReleaseVerified()
        || !latest || Date.now() - Number(latest.ts || 0) > RETURN_OPEN_POSITION_MAX_AGE_MS
        || this._distance(latest, initial) > 100
        || this._distance(independent, proof.position) > MAINTENANCE_STATIONARY_DRIFT_MM
        || this._distance(independent, proof.target) > MAINTENANCE_CONFIRM_RADIUS_MM) return false;
    const danger = await this.markers.rawDangerState(latest).catch(() => null);
    if (!danger?.known || !Number.isFinite(Number(danger.distance))
        || !Number.isFinite(Number(danger.radius))
        || Number(danger.distance) <= Number(danger.radius) + RETURN_GATE_CLEARANCE_MM) return false;
    this.log('maintenance release: native mowing label contradicted by independent stationary P1 proof',
      `pair-confirmed token=${token}`);
    return token === this._commandToken && !this._manualGateStopped
      && this.isDoorOpenStable() && this._doorOpenReleaseVerified();
  }

  async _maintenanceReleaseAfterOpening(proof, token) {
    // Do not call _verifiedMaintenanceReturnClearance() a second time here:
    // position freshness is required BEFORE gate motion, but the same valid
    // stationary sample can naturally age past 10s during physical opening.
    // Keep the proof private to one return; reject every newer contradiction.
    if (this._manualGateStopped || !proof || token !== this._commandToken || proof.token !== token
        || this._returnContext !== RETURN_STATES.MAINTENANCE
        || !this._safeReturnInProgress || !this._returnGuardActive) return 'return_context_changed';
    const age = Date.now() - proof.verifiedAt;
    // Reasserting an already displayed OPEN deliberately consumes the whole
    // configured travel interval, which can be up to 120 seconds. Preserve the
    // bounded stationary proof during that one gate operation.
    const proofMaxMs = Math.max(RETURN_MAINTENANCE_RELEASE_PROOF_MAX_MS,
      (this.device?.getSetting ? this._doorOpenDurationSeconds() : 0) * 1000 + 15000);
    if (age < 0 || age > proofMaxMs) return 'arrival_proof_expired';
    if (!this._manualMaintenanceReached || this._manualMaintenancePhase !== 'reached'
        || Number(this._lastMaintenanceReachedAt || 0) !== proof.arrivalAt) return 'maintenance_arrival_revoked';
    if (!this._doorOpenReleaseVerified()) return 'gate_open_not_verified';
    if (this._emergencyHoldActive() || this._emergencyGateContext
        || this._gateMotionPauseActive || this._pendingEmergencyMaintenanceReason) return 'emergency_or_gate_interlock';

    const status = String(this.status() || '').toLowerCase();
    if (!['paused', 'idle', 'standby', 'returning'].includes(status)) {
      // No generic mowing bypass. This exception requires a just-confirmed
      // manufacturer waypoint arrival AND a separate pair of native position
      // reads proving that the mower remained stationary outside the gate.
      if (status !== 'mowing' || !(await this._independentStationaryMaintenanceRelease(proof, token))) {
        return `contradictory_native_status_${status}`;
      }
    }
    const current = this.pos();
    const currentTs = Number(current?.ts || 0);
    if (current && (!Number.isFinite(Number(current.x)) || !Number.isFinite(Number(current.y)))) {
      return 'invalid_new_position';
    }
    if (currentTs > 0 && currentTs < proof.position.ts) return 'position_timestamp_regressed';
    const newPosition = currentTs > proof.position.ts
      || (current && (Number(current.x) !== proof.position.x || Number(current.y) !== proof.position.y));
    if (newPosition) {
      const positionAge = Date.now() - currentTs;
      if (!currentTs || positionAge < 0 || positionAge > RETURN_OPEN_POSITION_MAX_AGE_MS) {
        return 'new_position_stale_or_unverifiable';
      }
      const distanceFromArrival = this._distance(current, proof.position);
      const distanceFromTarget = this._distance(current, proof.target);
      if (distanceFromArrival === null || distanceFromArrival > MAINTENANCE_STATIONARY_DRIFT_MM
          || distanceFromTarget === null || distanceFromTarget > MAINTENANCE_CONFIRM_RADIUS_MM) {
        return 'mower_moved_since_verified_arrival';
      }
      const danger = await this.markers.rawDangerState(current).catch(() => null);
      if (!danger?.known || !Number.isFinite(Number(danger.distance))
          || !Number.isFinite(Number(danger.radius))
          || Number(danger.distance) <= Number(danger.radius) + RETURN_GATE_CLEARANCE_MM) {
        return 'new_position_gate_clearance_unconfirmed';
      }
    } else if (status === 'returning') {
      // A new motion state without any fresh stationary-position evidence must
      // never inherit an old clearance proof merely because the gate is open.
      return 'returning_without_fresh_stationary_position';
    }
    // rawDangerState() above can yield to other status/position callbacks. A
    // superseded return must not dispatch a dock command after that await.
    const finalPosition = this.pos();
    if (token !== this._commandToken || this._returnContext !== RETURN_STATES.MAINTENANCE
        || !this._safeReturnInProgress || !this._returnGuardActive
        || !this._manualMaintenanceReached || this._manualMaintenancePhase !== 'reached'
        || Number(this._lastMaintenanceReachedAt || 0) !== proof.arrivalAt
        || !this._doorOpenReleaseVerified() || this._emergencyHoldActive()
        || this._emergencyGateContext || this._gateMotionPauseActive
        || this._pendingEmergencyMaintenanceReason) return 'release_context_changed_during_check';
    if (Number(finalPosition?.ts || 0) !== currentTs
        || (finalPosition && current && (Number(finalPosition.x) !== Number(current.x)
          || Number(finalPosition.y) !== Number(current.y)))) return 'position_changed_during_release_check';
    return null;
  }

  async _prepareMaintenanceReturnZoneCheckpoint(token) {
    if (token !== this._commandToken || this._manualGateStopped || this._emergencyHoldActive()) return false;
    // A previous *attempt* does not prove that MAPD removed the zone.
    // Returning true here allowed a later native arrival/status callback to
    // release DOCK after a timed-out or rejected edit on this same token.
    if (this._returnZoneCheckpointAttemptedToken === token)
      return this._returnZoneCheckpointVerifiedToken === token;
    const device = this.device;
    if (typeof device?._syncPylonLifecyclePhase !== 'function') return true;
    const candidates = device._returnZoneRemovalCandidates?.() || [];
    // No native phase change needed: do not introduce another state gate,
    // PAUSE, map write or readback delay into a normal waypoint arrival.
    if (!candidates.length) return true; // no native deletion; do not wait for an edit
    if (this._returnContext !== RETURN_STATES.MAINTENANCE
        || !this._manualMaintenanceReached || this._manualMaintenancePhase !== 'reached'
        || this._maintenanceJourneyOwnsNavigation()) return false;
    const checkpoint = this._returnMaintenanceStopProof;
    const native = String(device._observedMowerStatus || this.status() || '').toLowerCase();
    if (!['paused','idle','standby'].includes(native)
        && !(checkpoint && Date.now()-Number(checkpoint.at||0) < 15000)) {
      this.log('[maintenance-zone] no current stationary evidence; return remains held');
      await this.returnOperationalHold('return_maintenance_zone_stationary_unconfirmed');
      return false;
    }
    // A waypoint arrival may leave the native 109 assignment PAUSED. That is
    // not task-free map edit state. STOP only when an actual zone deletion is
    // necessary; no-zone waypoint returns never enter this block.
    const currentSafe=()=>token===this._commandToken && !this._manualGateStopped
      && this._returnContext===RETURN_STATES.MAINTENANCE
      && this._manualMaintenanceReached && this._manualMaintenancePhase === 'reached'
      && !this._maintenanceJourneyOwnsNavigation() && !this._emergencyHoldActive();
    const did=device.getData?.().id;
    const taskIdle=()=>device._nativeMapEditTaskIdleBeforeWrite?.() || Promise.resolve(false);
    // Do not carry a task-free IDLE proof from an earlier return/waypoint.
    this._returnMaintenanceTaskIdleProof = null;
    if (!(await taskIdle())) {
      if (!did || !device._api?.stopMowing) return false;
      if (typeof device._freezeCompletedMapRouteForDisplay === 'function')
        await device._freezeCompletedMapRouteForDisplay('maintenance_zone_before_stop', {definitive:true}).catch(()=>{});
      const stopped=await (device._safeWrite
        ? device._safeWrite('maintenance_zone_stop_task',()=>device._api.stopMowing(did,{timeout:1800}))
        : device._api.stopMowing(did,{timeout:1800})).catch(()=>false);
      if (stopped===false || !currentSafe()) return false;
      let verifiedIdle=false;
      for (let tries=0;tries<12 && currentSafe();tries++) {
        if (await taskIdle()) {verifiedIdle=true;break;}
        await sleep(300);
      }
      if (!verifiedIdle) {
        await this.returnOperationalHold('maintenance_zone_task_not_ended');
        return false;
      }
    }
    // A real native IDLE was read after the waypoint STOP, before opcode 200.
    // This narrowly owns the following editor frame and is not a drive release.
    if (!currentSafe()) return false;
    this._returnMaintenanceTaskIdleProof = {
      token, mapIndex:Number(device._activeMapIndex), arrivedAt:Number(this._lastMaintenanceReachedAt),
      at:Date.now(), position:this.pos() ? {...this.pos()} : null,
    };
    // This token owns at most ONE mutation attempt.  Even if MAPD catches up
    // after the timeout, do not send a duplicate deletion command.
    this._returnZoneCheckpointAttemptedToken = token;
    this._returnZoneCheckpointVerifiedToken = null;
    const deadline = Date.now() + RETURN_ZONE_CHECKPOINT_TIMEOUT_MS;
    const current = () => token === this._commandToken && !this._manualGateStopped
      && this._returnContext === RETURN_STATES.MAINTENANCE
      && this._manualMaintenanceReached && this._manualMaintenancePhase === 'reached'
      && !this._maintenanceJourneyOwnsNavigation() && !this._emergencyHoldActive();
    const bounded = async promise => {
      let timer;
      try {return await Promise.race([promise,new Promise(resolve=>{
        timer=setTimeout(()=>resolve({unverified:true,reason:'checkpoint_timeout'}),
          Math.max(0,deadline-Date.now()));
      })]);}
      finally {clearTimeout(timer);}
    };
    this.log('[maintenance-zone] verified arrival; bounded map checkpoint',
      `point=P${Number(this._lockedReturnMaintenancePoint?.index||1)}`,
      `zones=${candidates.map(x=>x.id).join(',')||'none'}`);
    try {
      const result=await bounded(device._syncPylonLifecyclePhase('return',{
        reason:'return_verified_maintenance_arrival',
        allowVerifiedReturnCheckpoint:true, requireRequestedPhase:true,
        returnDeadlineAt:deadline,
      }));
      if (!current()) return false;
      let verified=!candidates.length;
      if (!verified && typeof device._verifyReturnZoneRemoval === 'function') {
        // Vendor MAPD can lag an accepted edit. Recheck read-only a few times
        // during the 20 s window; never duplicate a zone deletion. A missing
        // reply uses the FULL bounded fallback rather than pretending the
        // manufacturer restriction disappeared after one negative read.
        for (let attempt=0;attempt<4 && current() && Date.now()<deadline-1000;attempt++) {
          verified=await bounded(device._verifyReturnZoneRemoval(candidates,deadline)) === true;
          if (verified) break;
          await sleep(Math.min(1400,Math.max(0,deadline-Date.now()-350)));
        }
      }
      // Four independent bounded MAPD attempts above are the complete
      // verification budget.  Waiting out the remaining deadline WITHOUT
      // another read cannot improve the evidence and only strands Mia at P2.
      // An unverified zone remains explicitly unverified, not deleted.
      this.log('[maintenance-zone]', verified?'native zone deletion confirmed':'native MAPD unverified: bounded time fallback',
        `point=P${Number(this._lockedReturnMaintenancePoint?.index||1)}`,
        `reason=${result?.reason||'result'}`,`elapsedBudgetMs=${RETURN_ZONE_CHECKPOINT_TIMEOUT_MS}`);
      if (!verified) {
        this._timeline?.(this._text(
          'Sperrzone nicht entfernt – Rückkehr wartet auf native Bestätigung',
          'No-go zone not removed – return held pending native confirmation'),
          'return:maintenance_zone:mapd_unverified_hold');
        await this.returnOperationalHold('return_maintenance_zone_mapd_unverified');
        return false;
      }
      // Only confirmed MAPD absence permits the guarded return release.
      if (!current()) return false;
      this._returnZoneCheckpointVerifiedToken = token;
      return true;
    } catch(error) {
      this.log('[maintenance-zone] native map checkpoint failed: return withheld',
        String(error?.message||error));
      if (current()) await this.returnOperationalHold('return_maintenance_zone_map_edit_failed');
      return false;
    }
  }

  async _continueReturnFromMaintenance(source, dockFn, token, degradedReturn = false) {
    // Verified-arrival callbacks and delayed vendor packets may overlap. The
    // accepted DOCK observer is the sole owner of this return until movement,
    // final hold or a new explicit command. Never send a duplicate first DOCK.
    if (this._normalMaintenanceDockWatch?.token === token) return true;
    if (this._normalMaintenanceDockTerminalToken === token) return false;
    // Arrival callbacks and status polls can overlap during gate opening.
    // Reserve this return token before asynchronous safety checks so there is
    // exactly one first DOCK dispatch, even if the native proof takes seconds.
    if (this._maintenanceDockReleaseInFlightToken === token) {
      this.log('maintenance DOCK release already being verified', `token=${token}`);
      return true;
    }
    this._maintenanceDockReleaseInFlightToken = token;
    try {
    if (token !== this._commandToken || !(await this._ensureVerifiedMaintenanceReturnClearance(token))) {
      this.log('return gate opening withheld: verified stationary maintenance clearance missing', source || 'return');
      await this.returnOperationalHold('return_maintenance_gate_clearance_unconfirmed');
      return false;
    }
    const initialPosition = this.pos();
    const target = this._lockedReturnMaintenancePoint;
    if (!initialPosition || !target || !Number.isFinite(Number(initialPosition.ts))
        || !Number.isFinite(Number(initialPosition.x)) || !Number.isFinite(Number(initialPosition.y))
        || !Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.y))) {
      await this.returnOperationalHold('return_maintenance_gate_clearance_unconfirmed');
      return false;
    }
    const proof = {
      token,
      verifiedAt: Date.now(),
      arrivalAt: Number(this._lastMaintenanceReachedAt),
      position: { x: Number(initialPosition.x), y: Number(initialPosition.y), ts: Number(initialPosition.ts) },
      target: { x: Number(target.x), y: Number(target.y) },
    };
    // Reserve the independently checked stationary point *before* the motor
    // changes gate state. Allow only the native map mutation (not DOCK) to
    // reuse this bounded evidence while OPENING overlaps map readback.
    this._returnMaintenanceOpeningMapCheckpoint = {
      token, arrivedAt: Number(this._lastMaintenanceReachedAt),
      at: Date.now(), mapIndex: Number(this.device?._activeMapIndex),
      position: {x:Number(initialPosition.x), y:Number(initialPosition.y)},
    };
    // Verified P1..P5 arrival is already a valid, stationary precondition
    // for requesting OPEN.  Let real gate travel overlap the bounded native
    // map transaction instead of performing two long waits in series.
    // NEVER start opening on a bare navigation/arrival ACK: we have just
    // checked physical arrival, safety clearance and the current return token.
    const earlyOpening = this._returnMaintenanceEarlyOpenAttemptedToken === token
      ? this._returnMaintenanceEarlyOpenPromise : null;
    const arrivalOpening = !earlyOpening && !this._doorOpenReleaseVerified()
      && !['opening', 'closing'].includes(this.doorState())
      ? this.ensureDoorOpen('return_maintenance_verified_arrival_parallel_open', {
          allowDegraded: degradedReturn, allowOpenFromDanger:false,
          reassertDisplayedOpen:!this._doorOpenReleaseVerified(),
        }).catch(error => { this.log('maintenance arrival parallel OPEN failed',
          error?.message || String(error)); return false; })
      : null;
    // Mutation still requires its OWN fresh stationary/map safety proof.
    // Neither an OPEN command nor the waypoint-arrival event proves MAPD.
    if (!(await this._prepareMaintenanceReturnZoneCheckpoint(token))) {
      if (arrivalOpening) await arrivalOpening;
      return false;
    }
    if (earlyOpening) await earlyOpening;
    if (arrivalOpening && !(await arrivalOpening)) {
      await this.returnOperationalHold('garage_cannot_open_verified_maintenance_return');
      return false;
    }
    if (token !== this._commandToken) return false;
    // A gate reported as still OPENING after the previous attempt must not get
    // a second toggle pulse. Hold until external contact/diagnosis resolves it.
    if (earlyOpening && this.doorState() === 'opening' && !this._doorOpenReleaseVerified()) {
      await this.returnOperationalHold('return_maintenance_early_gate_open_unconfirmed');
      return false;
    }
    const ok = this.isDoorOpenStable() && this._doorOpenReleaseVerified()
      ? true
      : await this.ensureDoorOpen('return_from_maintenance', { allowDegraded: degradedReturn, allowOpenFromDanger: false, reassertDisplayedOpen: !(this.isDoorOpenStable() && this._doorOpenReleaseVerified()) });
    if (!ok) {
      await this.returnOperationalHold('garage_cannot_open_verified_maintenance_return');
      return false;
    }
    if (token !== this._commandToken) { this.log('return cancelled before dock', source); return false; }
    let releaseBlock = await this._maintenanceReleaseAfterOpening(proof, token);
    const handshakeDeadline = Date.now() + 8000;
    while (releaseBlock === 'gate_open_not_verified' && ['opening', 'open'].includes(this.doorState()) && Date.now() < handshakeDeadline && token === this._commandToken && !this._manualGateStopped) {
      await this.safetyWarning('return_release_wait');
      await sleep(250);
      releaseBlock = await this._maintenanceReleaseAfterOpening(proof, token);
    }
    if (releaseBlock) {
      this.log('return dock command withheld after gate opening', releaseBlock, source || 'return');
      await this.returnOperationalHold('return_maintenance_release_unconfirmed');
      return false;
    }
    this.log('return continues from maintenance point', 'dock command released', 'bounded verified arrival proof');
    const dockDispatchedAt = Date.now();
    this._retireMaintenanceArrivalObservation('return_from_maintenance');
    let accepted;
    try {
      accepted = await dockFn();
    } catch (error) {
      this.log('return dock command failed', source || 'return', error?.message || String(error));
      await this.returnOperationalHold('return_dock_command_rejected');
      return false;
    }
    if (accepted === false) {
      this.log('return dock command rejected by API', source || 'return');
      await this.returnOperationalHold('return_dock_command_rejected');
      return false;
    }
    // No second DOCK on ACK alone. The watcher checks fresh physical departure
    // and can consume exactly one guarded retry; it never commands the gate.
    this._normalMaintenanceDockWatch?.stop('new_maintenance_return');
    this._normalMaintenanceDockTerminalToken = null;
    if (token === this._commandToken && !this._manualRecoveryActive
        && this._returnContext === RETURN_STATES.MAINTENANCE) {
      this._normalMaintenanceDockWatch = new MaintenanceDockDepartureWatch(this, {
        token, dockFn, position: proof.position, target: proof.target,
        dispatchedAt: dockDispatchedAt,
      }).start();
    }
    await this.clearSafety('return_release_verified');
    if (this.device && typeof this.device._poll === 'function') {
      this.homey.setTimeout(() => this.device._poll().catch(() => {}), 5000);
      this.homey.setTimeout(() => this.device._poll().catch(() => {}), 12000);
      this.homey.setTimeout(() => this.device._poll().catch(() => {}), 25000);
    }
    if (degradedReturn) this._watchDegradedDockResult('return_degraded_sensor');
    return true;
    } finally {
      if (this._maintenanceDockReleaseInFlightToken === token) this._maintenanceDockReleaseInFlightToken = null;
      if (this._returnMaintenanceOpeningMapCheckpoint?.token === token)
        this._returnMaintenanceOpeningMapCheckpoint = null;
    }
  }

  async _awaitMaintenanceStationaryProof(token, timeoutMs = 16000, pollMs = 500) {
    // A2 occasionally keeps reporting MOWING for ~19 seconds after a verified
    // P2 arrival (field log 2026-10-28 11:38:45–11:39:04). A PAUSE was already
    // sent by the normal verifier. Wait briefly for *native* stillness instead
    // of immediately raising a recoverable operational hold and sending further
    // PAUSE commands. Never open the gate based on the arrival event alone.
    const arrivalAt = Number(this._lastMaintenanceReachedAt || 0);
    const point = this._lockedReturnMaintenancePoint;
    if (!arrivalAt || !point || !this._manualMaintenanceReached
        || this._manualMaintenancePhase !== 'reached') return false;
    const deadline = Date.now() + Math.max(0, Math.min(16000, Number(timeoutMs)||0));
    while (Date.now() < deadline) {
      if (token !== this._commandToken || this._lastMaintenanceReachedAt !== arrivalAt
          || this._lockedReturnMaintenancePoint !== point
          || !this._manualMaintenanceReached || this._manualMaintenancePhase !== 'reached'
          || !this._safeReturnInProgress || !this._returnGuardActive
          || this._manualGateStopped || this._emergencyGateContext || this._emergencyHoldActive()
          || ['opening','closing'].includes(this.doorState())) return false;
      const binary=this.device?._mowerBinaryDiag;
      const binaryAge=Date.now()-Number(this.device?._mowerBinaryDiagAt||0);
      if(binary && binaryAge>=0 && binaryAge<=15000 && binary.dockingState==='IN_STATION')return false;
      // Existing verifier requires fresh position, native idle/paused or fresh
      // independent stop evidence, waypoint radius and physical gate clearance.
      if (await this._verifiedMaintenanceReturnClearance()) {
        this.log('maintenance return: native stillness confirmed after bounded wait',
          `point=${point.index}`, `waitedSinceArrivalMs=${Date.now()-arrivalAt}`);
        return token === this._commandToken;
      }
      await sleep(Math.max(100,Math.min(1000,Number(pollMs)||500)));
    }
    this.log('maintenance return: bounded native stillness wait expired', `point=${point.index}`);
    return false;
  }

  async _proveStationaryMaintenanceAfterArrival(token) {
    // Event-driven handoff: the A2 may stop publishing fresh MQTT coordinates
    // when native 75 confirms P2.  Do not wait for the next 15s/20s cloud
    // interval.  Request TWO independent, read-only native 1:4 positions and
    // the current 2:1 status just once, without creating a periodic poll.
    // This is NOT an arrival inference: the authoritative P1-P5 arrival must
    // already have been committed for THIS ongoing return.
    const api = this.device?._api, did = this.device?.getData?.()?.id;
    if (!did || typeof api?.getMowerPosition !== 'function'
        || typeof api?.getProperties !== 'function') return false;
    const initial = this.pos(), target = this._lockedReturnMaintenancePoint;
    const ts = Number(initial?.ts || 0), now = Date.now();
    const initialMap = Number(this.device?._activeMapIndex);
    const arrivalAt = Number(this._lastMaintenanceReachedAt || 0);
    if (token !== this._commandToken || !this._safeReturnInProgress
        || !this._returnGuardActive || this._returnContext !== RETURN_STATES.MAINTENANCE
        || !this._manualMaintenanceReached || this._manualMaintenancePhase !== 'reached'
        || this._manualMaintenanceTransit || !arrivalAt || now - arrivalAt > 60000
        || this._manualGateStopped || this._emergencyHoldActive()
        || !initial || !target || !ts || now - ts < 0 || now - ts > RETURN_OPEN_POSITION_MAX_AGE_MS
        || !['mqtt','siid:1:4'].includes(String(initial.source || ''))
        || !Number.isFinite(Number(initialMap))
        || this._distance(initial, target) > MAINTENANCE_CONFIRM_RADIUS_MM) return false;
    const danger = await this.markers.rawDangerState(initial).catch(() => null);
    if (!danger?.known || !Number.isFinite(Number(danger.radius))
        || !Number.isFinite(Number(danger.distance))
        || Number(danger.distance) <= Number(danger.radius) + RETURN_GATE_CLEARANCE_MM) return false;
    const physical = await this._readNativeStationaryPositionForGarage(token, initial, 100);
    if (!physical || this._distance(physical, target) > MAINTENANCE_CONFIRM_RADIUS_MM
        || token !== this._commandToken || this._manualGateStopped
        || Number(this.device._activeMapIndex) !== initialMap
        || Number(this._lastMaintenanceReachedAt) !== arrivalAt
        || !this._manualMaintenanceReached || this._manualMaintenanceTransit
        || this._emergencyHoldActive()) return false;
    const raw = await api.getProperties(did, [[2,1]], {timeout:1400}).catch(() => null);
    const property = raw?.code === 0 ? raw.data?.result?.find(p=>Number(p.siid)===2
      && Number(p.piid)===1 && (!p.code || Number(p.code)===0)) : null;
    if (![2,3].includes(Number(property?.value))) return false;
    const final = this.pos();
    if (!final || Number(final.ts) !== ts
        || this._distance(final, initial) > MAINTENANCE_STATIONARY_DRIFT_MM
        || token !== this._commandToken || Number(this.device._activeMapIndex) !== initialMap
        || Number(this._lastMaintenanceReachedAt) !== arrivalAt
        || !this._manualMaintenanceReached || this._manualMaintenanceTransit
        || this._manualGateStopped || this._emergencyHoldActive()) return false;
    const dock = this._freshNativeDockState?.(12000);
    if (dock?.dockingState === 'IN_STATION' || Number(dock?.undocking) === 1) return false;
    this._returnMaintenanceStopProof = {token, mapIndex:initialMap, at:Date.now(),
      statusCode:Number(property.value), source:'native_1_4_pair_and_2_1',
      position:{x:Number(final.x),y:Number(final.y),ts}};
    this.log('[maintenance-return] native waypoint stationary witness acquired without MQTT wait',
      `point=P${Number(target.index || 1)}`, `status=${Number(property.value)}`);
    return this._verifiedMaintenanceReturnClearance();
  }

  async _ensureVerifiedMaintenanceReturnClearance(token) {
    if (token !== this._commandToken) return false;
    if (await this._verifiedMaintenanceReturnClearance()) return token === this._commandToken;

    // The native arrival can precede the independent stationary witness. Keep
    // the physical gate CLOSED while awaiting that witness; only a verified
    // clearance allows the normal gate-opening flow to continue.
    if (!this._manualMaintenanceReached || this._manualMaintenancePhase !== 'reached'
        || !Number(this._lastMaintenanceReachedAt || 0)) return false;
    this.log('maintenance return: verifying stationary clearance after native arrival');
    if (await this._proveStationaryMaintenanceAfterArrival(token)) return true;
    // If native readback is absent or contradicts the waypoint, retain the
    // previous bounded stop/clearance path.  Never assume a successful read.
    const established = await this._establishMaintenanceReturnReleaseFromCurrentPosition(token);
    if (token !== this._commandToken) return false;
    if (established === true && await this._verifiedMaintenanceReturnClearance()) return true;
    return this._awaitMaintenanceStationaryProof(token);
  }

  async _readNativeStationaryPositionForGarage(token, baseline, maximumDriftMm = 900, options = {}) {
    // A2 1:4 can be read independently while MQTT goes quiet after native
    // STOP/map-edit. Do not transform a cached LOCN/history point into a
    // current physical witness. Two separate reads and a real native IDLE
    // confirmation are required by the caller before any gate release.
    const api=this.device?._api;
    const did=this.device?.getData?.()?.id;
    const rebaseAfterConfirmedStop = options?.rebaseAfterConfirmedStop === true;
    if (!did || typeof api?.getMowerPosition !== 'function' || (!baseline && !rebaseAfterConfirmedStop)) return null;
    const mapAtStart = Number(this.device?._activeMapIndex ?? 0);
    const read=async()=>{
      let timer;
      try {
        const data=await Promise.race([
          api.getMowerPosition(did).catch(()=>null),
          new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1800);}),
        ]);
        if (!Number.isFinite(Number(data?.x)) || !Number.isFinite(Number(data?.y))) return null;
        return {x:Number(data.x),y:Number(data.y),source:'siid:1:4',ts:Date.now()};
      } finally {clearTimeout(timer);}
    };
    const first=await read();
    if (!first || token!==this._commandToken || this._manualGateStopped
        || Number(this.device?._activeMapIndex ?? 0) !== mapAtStart
        || (!rebaseAfterConfirmedStop && this._distance(first,baseline)>maximumDriftMm)) return null;
    await new Promise(resolve=>setTimeout(resolve,650));
    const second=await read();
    if (!second || token!==this._commandToken || this._manualGateStopped
        || Number(this.device?._activeMapIndex ?? 0) !== mapAtStart
        || this._distance(second,first)>70
        || (!rebaseAfterConfirmedStop && this._distance(second,baseline)>maximumDriftMm)) return null;
    this.log('[garage] native stationary position readback',
      `drift=${baseline ? Math.round(this._distance(second,baseline)) : 'n/a'}mm`,
      `pair=${Math.round(this._distance(first,second))}mm`,
      `rebasedAfterStop=${rebaseAfterConfirmedStop}`);
    return second;
  }

  async _validatedDirectReturnAfterZoneStop(token, decision, beforePosition, checkpoint = null) {
    // Preserve a verified lawn-side return across the native zone edit only
    // if the physical mower truly stayed outside the danger radius and stopped.
    // Native STOP often suppresses MQTT position packets on stationary A2s.
    if (token!==this._commandToken || this._manualGateStopped
        || decision?.mode!=='direct' || !beforePosition
        || checkpoint?.stopped === false || !Number(checkpoint.stopConfirmedAt)) return false;
    if (beforePosition.mapIndex != null && this.device?._activeMapIndex != null
        && Number(beforePosition.mapIndex)!==Number(this.device._activeMapIndex)) return false;
    const trusted=(p,maxAgeMs=20000)=>p && ['mqtt','siid:1:4'].includes(String(p.source||''))
      && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))
      && Number(p.ts)>0 && Date.now()>=Number(p.ts) && Date.now()-Number(p.ts)<=maxAgeMs;
    // A 20 s manufacturer edit can outlive the short live-position cache.
    // Anchor the ORIGINAL position freshness to the actual return click,
    // then independently read the stationary physical position after STOP.
    const capturedAt = Number(checkpoint.startedAt || Date.now());
    if (!trusted(beforePosition, RETURN_ZONE_CHECKPOINT_TIMEOUT_MS + 30000)
        || Number(beforePosition.ts) > capturedAt + 1000
        || capturedAt - Number(beforePosition.ts) > RETURN_OPEN_POSITION_MAX_AGE_MS) return false;
    const stopAt=Number(checkpoint.stopConfirmedAt);
    // During a native return interception the mower continues rolling between
    // the original route snapshot and the confirmed STOP. A fixed 900 mm
    // comparison mislabels that legitimate motion as a lost position (field
    // log 2026-10-28 15:38:37: -5570,-7750 -> -5110,-6640, 1202 mm).
    // Allow only a bounded displacement consistent with the actual STOP
    // interval, then reclassify the FRESH stationary pose independently.
    const confirmedNativeTaskEnded = Number(checkpoint.stopStatusCode) === 2;
    // A vendor-app Return can keep rolling for several seconds before a real
    // STOP. A fixed 4.5 m cap wrongly reports a lost position. With native
    // IDLE(2) already proven, take a NEW independent twin-position readback,
    // re-anchor the return checkpoint, and recompute actual safety geometry.
    // In all other cases retain the existing conservative path unchanged.
    const driftBudgetMm=confirmedNativeTaskEnded
      ? Math.min(12000, Math.max(1600, Math.ceil(1200+Math.max(0,stopAt-capturedAt)*0.85)))
      : Math.max(1600, Math.min(4500,
        Math.ceil(1000+Math.max(0, stopAt-capturedAt)*0.95)));
    let after=this.pos();
    const postStopLive=trusted(after) && Number(after.ts)>stopAt;
    if (confirmedNativeTaskEnded) {
      // Even a fresh MQTT point is not enough: the native pair must remain
      // stable AND the map index and return token must remain unchanged.
      after=await this._readNativeStationaryPositionForGarage(token,beforePosition,driftBudgetMm,
        {rebaseAfterConfirmedStop:true});
      if (!after) {
        this.log('[return-zone-checkpoint] native post-STOP rebase failed: independent stationary pair missing');
        return false;
      }
      const live=this.pos();
      if (trusted(live) && Number(live.ts)>stopAt && this._distance(live,after)>150) {
        this.log('[return-zone-checkpoint] native/MQTT post-STOP position conflict');
        return false;
      }
    } else if (!postStopLive) {
      after=await this._readNativeStationaryPositionForGarage(token,beforePosition,driftBudgetMm);
      if (!after) {
        this.log('[return-zone-checkpoint] direct rejected: independent post-STOP witness missing or beyond motion budget',
          `maxMotion=${driftBudgetMm}mm`);
        return false;
      }
      // Concurrent MQTT traffic can supersede the read-only witness. If a
      // newer live report disagrees, do not use the earlier saved coordinates.
      const newLive=this.pos();
      if (trusted(newLive) && Number(newLive.ts)>stopAt
          && this._distance(newLive,after)>150) return false;
    }
    const drift=this._distance(beforePosition,after);
    if (drift===null || drift>driftBudgetMm || token!==this._commandToken) return false;
    // The old ETA and lawn/garage side are not automatically transferable to
    // the position where the mower ACTUALLY stopped. Confirm the same safe
    // direct route against fresh native geometry, including the finite A-B
    // line, mowing polygon, danger radius and current map. Never reclassify
    // a changed/unknown side as safe merely because the motor stopped.
    const postStopDecision=drift>150
      ? await this._decideReturnPath('post_stop_reverified',after) : null;
    if (postStopDecision && postStopDecision.mode!=='direct') {
      this.log('[return-zone-checkpoint] post-STOP route no longer direct',
        `drift=${Math.round(drift)}mm`,postStopDecision.reason||'unsafe');
      return false;
    }
    if (confirmedNativeTaskEnded) this.log('[return-zone-checkpoint] native stationary return position rebased',
      `requested=${beforePosition.x},${beforePosition.y}`,
      `stopped=${after.x},${after.y}`,`drift=${Math.round(drift)}mm`,
      `motionBudget=${driftBudgetMm}mm`, `etaToLine=${postStopDecision?.etaToLineSec ?? '?'}s`);
    const raw=await this.markers.rawDangerState(after).catch(()=>null);
    if (!raw?.known || raw.inside===true
        || !Number.isFinite(Number(raw.distance)) || !Number.isFinite(Number(raw.radius))
        || Number(raw.distance)<=Number(raw.radius)+RETURN_GATE_CLEARANCE_MM) return false;
    const native=String(this.device?._observedMowerStatus||'').toLowerCase();
    const statusAt=Number(this.device?._observedMowerStatusAt||0);
    let provenIdle=['paused','idle','standby'].includes(native)
      && statusAt>=stopAt && statusAt<=Date.now() && Date.now()-statusAt<=12000;
    if (!provenIdle && typeof this.device?._api?.getProperties==='function') {
      // Map edit TASK packets may show MOWING in the capability even though
      // native 2:1 has returned to IDLE. Only a new read can settle it.
      const did=this.device.getData?.()?.id;
      const read=did ? await this.device._api.getProperties(did,[[2,1]],{timeout:1400}).catch(()=>null) : null;
      const item=read?.code===0 ? read.data?.result?.find(x=>Number(x.siid)===2
        && Number(x.piid)===1 && (!x.code || Number(x.code)===0)) : null;
      // If STOP produced PAUSED (3) instead of IDLE (2), only a previously
      // established independent twin-position checkpoint may authorize it.
      // 1.2.78 field fix: the PAUSED + twin-position witness is recorded
      // INSIDE the STOP read before stopConfirmedAt is assigned. Comparing
      // witness >= stopConfirmedAt rejects a valid PAUSED(3) checkpoint.
      // Accept only a bounded, earlier witness from THIS checkpoint, plus a
      // fresh native PAUSED read AND the independent post-edit position pair
      // already verified above. No timed-out or stale PAUSED proof is valid.
      const pausedWitnessAt=Number(checkpoint.stationaryPausedProofAt||0);
      const pairedPauseProof=Number(checkpoint.stationaryPausedProofAt||0)>0 && pausedWitnessAt<=stopAt
        && stopAt-pausedWitnessAt<=2000
        && Date.now()>=pausedWitnessAt && Date.now()-pausedWitnessAt<30000;
      // Field 29-Oct 13:07:24: native 2:1 was IDLE (2) immediately
      // after STOP, then PAUSED (3) after MAPD. The old code discarded the
      // real STOP witness because it expected PAUSED to be proved *before*
      // stopConfirmedAt. Both independent post-edit SIID 1:4 samples above
      // are already stationary. Accept this specific 2 -> 3 transition,
      // NOT a bare PAUSE acknowledgment or old coordinate.
      const stoppedIdleBeforeEdit=Number(checkpoint.stopStatusCode)===2
        && stopAt>0 && capturedAt>0 && stopAt>=capturedAt;
      provenIdle=Number(item?.value)===2
        || (Number(item?.value)===3 && (pairedPauseProof || stoppedIdleBeforeEdit));
      if (Number(item?.value)===3 && stoppedIdleBeforeEdit && !pairedPauseProof && provenIdle)
        this.log('[return-zone-checkpoint] native 2->3 accepted with post-edit twin-position witness',
          `token=${token}`,`stopAt=${stopAt}`,`pair=${after.x},${after.y}`);
      this.log('[return-zone-checkpoint] post-edit native stationary readback',
        `siid_2_1=${item?.value ?? 'unknown'}`,`stationary=${provenIdle}`);
    }
    if (!provenIdle || token!==this._commandToken || this._manualGateStopped) return false;
    const final=this.pos();
    if (trusted(final) && Number(final.ts)>stopAt && this._distance(after,final)>150) return false;
    const finalDanger=await this.markers.rawDangerState(after).catch(()=>null);
    if (token!==this._commandToken || this._manualGateStopped
        || !finalDanger?.known || finalDanger.inside===true
        || !Number.isFinite(Number(finalDanger.distance))
        || !Number.isFinite(Number(finalDanger.radius))
        || Number(finalDanger.distance)<=Number(finalDanger.radius)+RETURN_GATE_CLEARANCE_MM) return false;
    // A single-use physical checkpoint accompanies the DIRECT return through
    // its later gate-wait owner. Otherwise that owner repeats the old demand
    // for a new MQTT packet that a stopped mower may never publish.
    this._returnZoneDirectStopProof={token,at:Date.now(),stopConfirmedAt:stopAt,
      position:{...after},nativeIdleVerified:true,
      postStopDecision:postStopDecision ? {...postStopDecision} : null,
      stationaryPausedProofAt:Number(checkpoint.stationaryPausedProofAt||0),
      stopStatusCode:Number(checkpoint.stopStatusCode||0)};
    this.log('[return-zone-checkpoint] safe direct route retained after native STOP',
      `drift=${Math.round(drift)}mm`,`source=${after.source}`,`postStopLive=${!!postStopLive}`,
      `zoneVerified=${checkpoint.verified === true}`,
      `nativeRestrictions=${checkpoint.verified === true ? 'removed' : 'still_enforced'}`);
    return true;
  }

  async _explicitClosedGateOutsideProofForReturn(token) {
    // After reinstall the *physical* OUT_OF_STATION mower can be just 1.3 m
    // from the dock, within the broad parked-position envelope. Only the
    // deliberate Homey Return action may override a stale Home tile. Never
    // infer this from distance, IDLE, or gate CLOSED alone.
    if (token !== this._commandToken || this._manualGateStopped
        || this.doorState() !== 'closed' || !this.sensorEnabled?.()
        || !this.sensorHealthy?.() || this._lastSensorContactState !== 'closed'
        || Date.now() - Number(this._lastSensorContactAt || 0) > 30 * 60 * 1000) return false;
    const device = this.device;
    // The dock 1:1 frame is event-driven. Refresh ONLY when old, read-only;
    // do not assume a cached frame is new merely because app just restarted.
    let dock = this._freshNativeDockState?.(12000);
    if (!dock && typeof device?._refreshNativeDockForStart === 'function') {
      await device._refreshNativeDockForStart();
      dock = this._freshNativeDockState?.(12000);
    }
    if (dock?.dockingState !== 'OUT_OF_STATION' || Number(dock.undocking) !== 0) return false;
    const p = this.pos?.();
    if (!p || !['mqtt', 'siid:1:4'].includes(String(p.source || ''))
        || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))
        || Date.now() - Number(p.ts || 0) > 10000) return false;
    const distance = this._distance(p, device?._dockPos);
    if (distance === null || distance < 1250 || distance > 2500) return false;
    const line = await this.markers?.lineState?.(p).catch(() => null);
    const garageSide = line?.direction?.garageSide ?? this._garageLineSide;
    const observedSide = line?.rawSide ?? line?.side;
    if (!line?.onSegment || garageSide == null || observedSide !== garageSide) return false;
    // Use the same current, independently reread physical position/IDLE proof
    // as the maintenance dispatcher. A second proof is required BEFORE 109.
    const verified = await this._confirmNativeIdleForMaintenanceDispatch(token, 'explicit_closed_gate_after_restart');
    if (!verified) return false;
    const latest = this._freshNativeDockState?.(12000);
    if (latest?.dockingState !== 'OUT_OF_STATION' || Number(latest.undocking) !== 0) return false;
    this.log('explicit Homey return: physically outside confirmed near closed garage after restart',
      `dockDistance=${Math.round(distance)}mm`, `token=${token}`);
    return true;
  }

  async returnRequested(source, dockFn, maintenanceFn) {
    if (this._emergencyCommandBlocked(`return:${source}`)) return false;
    if (this._manualGateStopped) { await this.safetyWarning('manual_gate_stop_hold'); return false; }
    const token = this._commandToken;
    if (!this.enabled()) return dockFn();
    if (this._confirmedStationLockActive()) {
      this.log('return suppressed: confirmed physical station lock; no stale dock or maintenance command sent', source || 'return');
      this._setReturnContext(RETURN_STATES.HOME_CONFIRMED, 'confirmed_native_station');
      this._safeReturnInProgress = false;
      this._returnGuardActive = false;
      this._missionOutside = false;
      this._homeState = 'home';
      await this.refreshTileStatus('confirmed native station').catch(() => {});
      this._scheduleHomeClose('confirmed_native_station');
      return true;
    }

    // Normal duplicate vendor/MQTT return notifications are always ignored.
    // But an EXPLICIT Homey button retry after a terminal A-B HOLD must not
    // silently claim success. Permit exactly one new bounded stop/door handshake
    // only after fresh physical geometry proves the mower safely on the lawn
    // side; otherwise keep the motor blocked and explain the hold.
    if (this._returnLineWaitTerminalToken === token
        && this._returnContext === RETURN_STATES.DOCK
        && String(source || '').toLowerCase().includes('button_dock')) {
      const pos = this.pos();
      const ts = Number(pos?.ts || 0);
      const fresh = !!pos && ts > 0 && Date.now() >= ts
        && Date.now() - ts < RETURN_OPEN_POSITION_MAX_AGE_MS;
      const raw = fresh ? await this.markers.rawDangerState(pos).catch(() => null) : null;
      const line = fresh ? await this.markers.lineState().catch(() => null) : null;
      const side = line?.side ?? line?.rawSide ?? null;
      const lawn = line?.direction?.lawnSide ?? this._lawnLineSide ?? null;
      const clear = raw?.known === true && raw.inside !== true
        && Number.isFinite(Number(raw.distance)) && Number.isFinite(Number(raw.radius))
        && Number(raw.distance) > Number(raw.radius) + RETURN_GATE_CLEARANCE_MM;
      if (!fresh || !clear || lawn === null || side !== lawn || this._awaitingLineDoorOpen) {
        this.log('explicit return retry denied: fresh stationary lawn-side clearance unavailable');
        await this.safetyWarning('return_explicit_retry_needs_fresh_clearance');
        return false;
      }
      clearTimeout(this._returnRecoveryHold?.timer);
      this._returnRecoveryHold = null;
      this._returnLineWaitTerminalToken = null;
      this._pendingDirectDockFn = dockFn;
      this._pendingDirectReturnToken = token;
      this._pendingDirectReturnSource = 'button_dock_retry_after_hold';
      this.log('explicit Homey return retry rearmed from fresh safe lawn-side geometry');
      return this._waitAtSafetyLineUntilDoorOpenThenDock(dockFn, token, 'button_dock_retry_after_hold');
    }

    // Once a return/recovery owns the maintenance watcher, later duplicate
    // returning/error signals must not tear that watcher down. It is responsible
    // for opening the gate and continuing docking after maintenance-point arrival.
    if (this._returnContext !== RETURN_STATES.IDLE || this._safeReturnInProgress || this._returnGuardActive) {
      this.log('return ignored: context already active', this._returnContext, source || 'return');
      return this._returnLineWaitTerminalToken !== token;
    }

    // Freeze the physical START position at the actual Homey/observed return
    // request, before STOP/MAPD can replace MQTT with a stale map fallback.
    // This is route INPUT only, never permission to move or open a gate.
    // 1.2.78: A missing/expired MQTT position is not proof of a wrong route.
    // Before falling back to maintenance, retry TWO independent native 1:4
    // reads. These are route INPUT only: gate and motor guards independently
    // require fresh physical evidence at command time.
    let requestPosition = this.pos();
    const trustedReturnOrigin = p => !!p && ['mqtt','siid:1:4'].includes(String(p.source || ''))
      && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))
      && Number(p.ts) > 0 && Date.now() >= Number(p.ts)
      && Date.now() - Number(p.ts) <= POSITION_CACHE_MS;
    if (!trustedReturnOrigin(requestPosition) && !this._manualGateStopped
        && !this._confirmedStationLockActive?.()) {
      const native = await this._readReturnOriginNativePair(token);
      if (native && token === this._commandToken && !this._manualGateStopped) {
        this.device?._setLivePosition?.({x:native.x,y:native.y,ts:native.ts}, 'siid:1:4');
        requestPosition = this.pos();
        // Some older device mocks do not immediately expose _livePos.
        if (!trustedReturnOrigin(requestPosition)) requestPosition = native;
        this.log('[return-position] native recheck recovered route origin',
          `x=${Math.round(native.x)}`, `y=${Math.round(native.y)}`);
      } else {
        this.log('[return-position] native pair unavailable; preserving guarded maintenance fallback');
      }
    }
    const returnOrigin = requestPosition && ['mqtt','siid:1:4'].includes(String(requestPosition.source || ''))
      && Number.isFinite(Number(requestPosition.x)) && Number.isFinite(Number(requestPosition.y))
      && Number(requestPosition.ts) > 0 && Date.now() >= Number(requestPosition.ts)
      && Date.now()-Number(requestPosition.ts) <= POSITION_CACHE_MS
      ? Object.freeze({x:Number(requestPosition.x), y:Number(requestPosition.y),
          ts:Number(requestPosition.ts),source:String(requestPosition.source),
          mapIndex:Number(this.device?._activeMapIndex || 0)}) : null;
    this._returnMaintenanceEarlyOpenAttemptedToken = null;
    this._returnMaintenanceEarlyOpenPromise = null;
    this._returnRecoveryRequest = { token, source, dockFn, maintenanceFn,
      returnOrigin, routeDecision:null };
    this.log('[return-origin] captured before PAUSE/STOP',
      `token=${token}`,returnOrigin ? `position=${returnOrigin.x},${returnOrigin.y} source=${returnOrigin.source}` : 'unavailable');
    this._returnZoneDirectStopProof=null;
    this._returnLineWaitTerminalToken = null;

    // A new real return request may supersede an ACTIVE maintenance transit, but
    // must never erase a just-verified maintenance arrival before the return path
    // can consume it. This was the field regression where the mower was already
    // parked at the maintenance point, Return was pressed, and Homey discarded
    // the proof then let the mower drive toward the closed gate.
    const preserveVerifiedMaintenanceArrival = Number(this._manualMaintenanceTargetReachedIndex || 1) === Number(this._lockedReturnMaintenancePoint?.index || 1)
      && this._manualMaintenanceReached === true
      && this._manualMaintenancePhase === 'reached'
      && Number(this._lastMaintenanceReachedAt || 0) > 0;
    if (this._manualMaintenanceTransit || this._maintenanceWatch) {
      clearInterval(this._maintenanceWatch);
      this._maintenanceWatch = null;
      this._maintenanceRequestedAt = 0;
      this._maintenanceStartPos = null;
      this._maintenanceStableHits = 0;
      this._manualMaintenanceCalibration = false;
      this._manualMaintenanceRecalibration = false;
      this._manualMaintenanceTransit = false;
      if (!preserveVerifiedMaintenanceArrival) {
        this._manualMaintenanceReached = false;
        this._manualMaintenancePhase = 'idle';
        this._manualMaintenanceLastPos = null;
        this._manualMaintenanceStableSince = 0;
        this.log('maintenance journey superseded by return', source || 'return');
      } else {
        this.log('verified maintenance arrival preserved for return takeover', source || 'return',
          `age=${Date.now() - Number(this._lastMaintenanceReachedAt || 0)}ms`);
      }
      this._timeline(`${this._text('Wartungsfahrt durch Rückkehr übernommen', 'Maintenance journey superseded by return')} – ${source || 'return'}`, `maintenance:return_takeover:${source || 'return'}`);
    }
    this.lastRequestedAction = source || 'RETURN';
    this._nativeDockVerifiedAt = 0;
    this._homeCloseArmed = true;
    this._returnGuardActive = true;
    this._safeReturnInProgress = true;
    this._outbound = null;
    this._outboundHardLockUntil = 0;
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._dangerReleasedAfterExit = false;
    this._closeAfterExitRequested = false;
    this._setLineState(LINE_STATES.IDLE, 'return_started');
    this._setReturnContext(RETURN_STATES.STARTED, source || 'return');
    this._trigger('garage_safe_return_started', source || 'return');
    this.log('RETURN_REQUESTED', source);

    const degradedReturn = false;
    if (this.sensorEnabled() && !this.sensorHealthy()) {
      const reasonText = this.sensorUnhealthyReason() || 'sensor_unhealthy';
      this.log('return: sensor unavailable; using configured door times', reasonText);
      await this.safetyWarning(`sensor_unhealthy_return_fallback_${reasonText}`);
    }

    // Important: if the mower is already safely at home/in the dock, do not send a
    // new dock/return command. This prevents unwanted movement inside a closed garage
    // after station power loss, low-battery confusion or charging-state glitches.
    let physicalOutside = this._physicalOutsideRecoveryEvidence()
      || await this._freshPositionProvesOutsideHome();
    if (!physicalOutside && String(source || '').toLowerCase().includes('button_dock')
        && !this._confirmedStationLockActive()) {
      physicalOutside = await this._explicitClosedGateOutsideProofForReturn(token);
    }
    if (physicalOutside && (this._homeState === 'home' || this.isDockedHomeStatus())) {
      this._homeState = 'away';
      this._missionOutside = true;
      this.log('return: fresh physical position overrides stale home/docked telemetry');
    }
    if (this.isHomeStatus() && !physicalOutside) {
      this.log('return suppressed: mower already home/docked');
      await this._setHomeState('home');
      await this.refreshTileStatus('home');
      this._trigger('garage_home_confirmed', 'already_home');
      this._returnGuardActive = false;
      this._safeReturnInProgress = false;
      this._missionOutside = false;
      this._setReturnContext(RETURN_STATES.HOME_CONFIRMED, 'already_home');
      this._scheduleHomeClose('already_home');
      return true;
    }

    this._missionNotification('return');

    // Lock the native/static maintenance point exactly once for this return cycle.
    // The same immutable coordinate is used for command supervision, arrival proof
    // and the map overlay until the cycle ends.
    await this._lockReturnMaintenancePoint(source || 'return');
    if (!this._lockedReturnMaintenancePoint) {
      await this.returnOperationalHold('selected_maintenance_point_geometry_missing');
      return false;
    }

    // Compute the full A-B/ETA route ONCE from the return-click position,
    // before any PAUSE/STOP/native zone edit. No geometry recomputation using
    // quiet/stale post-STOP MQTT during a successful verified checkpoint.
    const snapshot = await this._decideReturnPath(source || 'return', returnOrigin);
    if (token !== this._commandToken) return false;
    if (this._returnRecoveryRequest?.token === token)
      this._returnRecoveryRequest.routeDecision = Object.freeze({...snapshot});
    this.log('[return-origin] frozen route',`token=${token}`,`mode=${snapshot.mode}`,
      `etaToLine=${snapshot.etaToLineSec ?? '?'}s`, `required=${snapshot.requiredOpenLeadSec ?? '?'}s`);
    // This one-time transaction runs ONLY if an actual native forbidden polygon
    // must be absent during return. Permanent/all-ready zones retain the old
    // continuous, short-ETA and maintenance routes without extra STOP commands.
    let zoneCheckpointIntent = null;
    if (snapshot.mode === 'direct' && this.device?._returnZoneRemovalRequired?.() === true) {
      // A maintenance detour must NOT pause/STOP just to delete a native zone
      // before opcode 109: navigate safely to the selected P1-P5 first.
      // The bounded removal/readback is owned by the VERIFIED stationary
      // waypoint arrival, while the early gate opening may run in parallel.
      const beforePosition = returnOrigin ? {...returnOrigin} : null;
      const checkpoint = await this._prepareReturnZoneCheckpoint(token,source,snapshot);
      if (checkpoint.cancelled || token !== this._commandToken) return false;
      zoneCheckpointIntent = {snapshot,beforePosition,checkpoint};
      // Never issue a fresh DOCK while a required native zone transition has
      // not produced a confirmed STOP.  A failed stop is not a route release.
      if (checkpoint.stopped !== true) {
        this.log('[return-zone-checkpoint] required stop not proven; holding return',
          `token=${token}`, `reason=${checkpoint.reason || 'unknown'}`);
        await this.returnOperationalHold('return_zone_stop_unconfirmed');
        return false;
      }
      // Native STOP may ACK while the task remains PAUSED, not IDLE. Do NOT
      // start a MAPD mutation or direct DOCK. Try the safe P1–P5 detour once,
      // where native IDLE and zone removal are proved AFTER verified arrival.
      if (checkpoint.reason==='stop_unconfirmed') {
        if (await this._tryReturnWaypointFallbackAfterUnconfirmedStop(token,source,
              dockFn,maintenanceFn,checkpoint)) return true;
        await this.returnOperationalHold('return_zone_stop_unconfirmed');
        return false;
      }
      // STOP killed the vendor-owned return task. From here on the original
      // command is no longer in flight, and either a guarded DOCK or guarded
      // opcode-109 detour MUST be dispatched (or a visible HOLD reported).
      if (checkpoint.stopped) {
        this.log('[return-zone-checkpoint] native task ENDED: Homey must dispatch a new return operation',
          `decision=${snapshot.mode}`, `token=${token}`);
      }
      this.log('[return-zone-checkpoint] return intent preserved pending physical verification',
        `original=${snapshot.mode || 'unknown'}`,`verified=${checkpoint.verified===true}`,
        `fallback=${checkpoint.verified!==true}`);
    }

    const reusedArrival = await this._reuseVerifiedMaintenanceArrivalForReturn(token);
    if (reusedArrival !== null) {
      if (!reusedArrival) {
        await this.returnOperationalHold('maintenance_current_unconfirmed');
        return false;
      }
      this._setReturnContext(RETURN_STATES.MAINTENANCE, 'verified_maintenance_arrival_reused');
      return this._continueReturnFromMaintenance(source, dockFn, token, false);
    }

    const currentRelease = await this._establishMaintenanceReturnReleaseFromCurrentPosition(token);
    if (currentRelease !== null) {
      if (!currentRelease) {
        await this.returnOperationalHold('maintenance_current_unconfirmed');
        return false;
      }
      this._setReturnContext(RETURN_STATES.MAINTENANCE, 'already_at_current_maintenance');
      return this._continueReturnFromMaintenance(source, dockFn, token, false);
    }

    // Decide return path from the original map geometry. If position/map is unclear or
    // the mower is in the garage half of the map, route through the maintenance point.
    // If it is clearly in the far half, a direct dock return is allowed; if it reaches
    // the safety line before the gate is open, pause there, open the gate, then continue.
    this._returnDecision = snapshot;
    let directZoneStopVerified=false;
    if (zoneCheckpointIntent?.checkpoint?.stopped === true &&
        zoneCheckpointIntent.snapshot.mode === 'direct') {
      if (await this._validatedDirectReturnAfterZoneStop(token,
            zoneCheckpointIntent.snapshot,zoneCheckpointIntent.beforePosition,
            zoneCheckpointIntent.checkpoint)) {
        directZoneStopVerified=true;
        if (zoneCheckpointIntent.checkpoint.verified !== true) {
          this.log('[return-zone-checkpoint] native zone deletion unverified: direct return held',
            `token=${token}`,`reason=${zoneCheckpointIntent.checkpoint.reason || 'unverified'}`);
          this._timeline?.(this._text(
            'Sperrzone noch vorhanden – Rückkehr gesichert angehalten',
            'No-go zone still present – return held safely'),
            'return:zone:mapd_unverified_hold');
          await this.returnOperationalHold('return_zone_mapd_unverified');
          return false;
        }
        // The original point/ETA remains the route owner. The actual physical
        // stop is independently proved by native SIID and raw-danger checks.
        // A successful native STOP and bounded zone check must NOT erase the
        // original distance/ETA decision.  The long lawn-side approach can
        // overlap gate opening after this checkpoint, with the A-B brake active.
        // Short ETA remains short and uses the same guarded pause owner.
        const rechecked=this._returnZoneDirectStopProof?.token===token
          ? this._returnZoneDirectStopProof.postStopDecision : null;
        const route=rechecked?.mode==='direct' ? rechecked : snapshot;
        this._returnDecision = {...route,
          reason: route.etaFits === true
            ? 'checkpoint_safe_lawn_side_parallel_after_stop'
            : 'checkpoint_safe_lawn_side_gate_first'};
        if (rechecked) this.log('[return-zone-checkpoint] refreshed post-STOP ETA and side',
          `etaToLine=${route.etaToLineSec ?? '?'}s`, `drift=${Math.round(this._distance(zoneCheckpointIntent.beforePosition,this._returnZoneDirectStopProof.position))}mm`);
      } else {
        // A missing MAPD deletion must NEVER by itself cancel return. This
        // HOLD is reserved exclusively for missing native STOP, fresh physical
        // lawn-side position or independent native IDLE evidence.
        this.log('[return-origin] direct held: physical stop/position/IDLE proof missing',
          `token=${token}`,`zoneVerified=${zoneCheckpointIntent.checkpoint?.verified === true}`);
        await this.returnOperationalHold('return_original_direct_physical_proof_missing');
        return false;
      }
    }
    const sourceText = String(source || '');
    // German A2 status strings are also used by the original-app return
    // interception (external_status_Rückkehr and its PAUSE_DOCKING variant).
    // Those are already-running native return tasks, not fresh Homey commands.
    const externalNativeReturn = this._returnZoneTaskStoppedToken !== token
      && (/external_.*(?:returning|rückkehr)/i.test(sourceText)
        || sourceText.includes('status_returning_confirmed_after_resume'));
    const lifecycleReturnTransition = this.device?._pylonLifecycleNeedsTransition?.('return') === true;
    // Routing is decided by CURRENT geometry only. Source names identify how
    // the event was detected; they are never evidence that the mower is inside
    // the physical danger radius or on the garage side of the line.
    const dangerNow = await this.markers.dangerState().catch(() => ({ known: false, inside: false }));
    if (this._returnDecision.mode === 'direct'
        && ((dangerNow.known === true && !dangerNow.inside) || directZoneStopVerified)) {
      if (token !== this._commandToken) { this.log('return cancelled before direct dock', source); return false; }

      this._setReturnContext(RETURN_STATES.DOCK, source || 'return_direct');
      this._pendingDirectDockFn = dockFn;
      this._pendingDirectReturnToken = token;
      this._pendingDirectReturnSource = source || 'return_direct';

      // THREE mutually exclusive return paths:
      // A: proven lawn side with sufficient lead: open the gate in parallel and
      //    allow the native/direct return. If ETA is short, pause at the current
      //    verified position, open the gate, then issue the same return again.
      //    The physical A-B checkpoint remains the final emergency stop.
      // B: garage side / danger / unclear position: native maintenance point.
      // The ETA is always measured to the safety line; it is not a reason to
      // park the mower several metres early and bypass the physical checkpoint.
      if (this._returnDecision.etaFits !== true) {
        this.log('short safety-line ETA: pause at current position before opening gate',
          this._returnDecision.reason || 'eta_uncertain');
        this._timeline(
          this._text(
            'Kurze ETA: Mäher am aktuellen Standort pausiert – Toröffnung wird abgewartet',
            'Short ETA: mower paused at current position – waiting for gate opening',
          ),
          'return:short_eta_current_position_hold',
        );
        return this._waitAtCurrentPositionUntilDoorOpenThenDock(dockFn, token, 'return_eta_short_current_hold');
      }

      // With NO return-phase no-go zone to remove, a sufficiently distant
      // lawn-side mower does not need a new PAUSE/STOP.  Keep one parallel
      // gate-opening owner and the independent physical A/B brake.  This is
      // never used for a short/uncertain ETA or after a zone STOP checkpoint.
      if (!zoneCheckpointIntent && this._returnDecision.etaFits === true) {
        if (externalNativeReturn) {
          this.ensureDoorOpen('external_direct_return_parallel_open', {
            allowOpenFromDanger:false,allowDegraded:true,
            reassertDisplayedOpen:!this._doorOpenReleaseVerified(),
          }).catch(e=>this.error('external direct return door open',e.message));
          this.log('external native return retained; OPEN parallel, no duplicate DOCK');
          return true;
        }
        let notifyOpenRequest;
        let notified=false;
        const openingAccepted=new Promise(resolve=>{notifyOpenRequest=resolve;});
        const signal=accepted=>{if (!notified) {notified=true;notifyOpenRequest(accepted===true);}};
        const gateOpening=this.ensureDoorOpen('direct_return_no_zone_parallel_open',{
          allowOpenFromDanger:false,allowDegraded:true,
          reassertDisplayedOpen:!this._doorOpenReleaseVerified(),
          onOpenRequestAccepted:()=>signal(true),
        }).then(ok=>{signal(ok===true && this._doorOpenReleaseVerified());return ok;})
          .catch(error=>{this.error('direct return open failed',error?.message);signal(false);return false;});
        if (!await openingAccepted || token!==this._commandToken || this._manualGateStopped) {
          await gateOpening;
          await this.returnOperationalHold('return_gate_open_request_unconfirmed');
          return false;
        }
        this._retireMaintenanceArrivalObservation('direct_return_no_zone');
        let accepted=false;
        try {accepted=await dockFn()!==false;}
        catch(error) {this.log('direct no-zone DOCK rejected',error?.message||String(error));}
        if (!accepted) {
          await gateOpening;
          await this.returnOperationalHold('return_dock_command_rejected');
          return false;
        }
        const doorReady=await gateOpening;
        if (!doorReady || token!==this._commandToken || !this._doorOpenReleaseVerified()) {
          await this.returnOperationalHold('return_gate_open_release_unconfirmed');
          return false;
        }
        this.log('direct lawn-side return without zone change: OPEN/DOCK parallel; A-B brake active');
        return true;
      }

      // With a required zone change, the verified STOP and bounded MAPD
      // checkpoint have already run. Short ETA still requires the guarded hold.
      // The 5 s reserve and A-B safety brake protect the parallel approach.
      // An unproved PAUSE or a failed gate confirmation cannot release DOCK.
      this.log('far lawn-side return: verified stop before guarded parallel gate and dock', sourceText);
      return this._waitAtCurrentPositionUntilDoorOpenThenDock(
        dockFn, token, 'return_far_lawn_side_stop_then_parallel');
    }

    // Near garage, in danger area, or unclear position: deterministic maintenance path.
    return this._startReturnMaintenanceRoute(source, dockFn, maintenanceFn, token, degradedReturn);
  }

  // Optional optimisation, never a prerequisite for a maintenance return.
  // Native waypoint travel + both physical boundaries must be freshly confirmed.
  // If the route or telemetry is uncertain, the existing stationary-arrival
  // fallback opens the gate only AFTER point verification.
  async _maintenanceTransitEarlyOpenSafe(token) {
    if (token !== this._commandToken || this._manualGateStopped
        || !this._safeReturnInProgress || !this._returnGuardActive
        || typeof this.sensorEnabled !== 'function' || !this.sensorEnabled()
        || typeof this.sensorHealthy !== 'function' || !this.sensorHealthy()
        || this._returnContext !== RETURN_STATES.MAINTENANCE
        || this._returnMaintenanceNavigationOwnerToken !== token
        || !this._maintenanceDepartureConfirmedAt
        || this._manualMaintenanceReached || this._emergencyHoldActive()
        || this._gateMotionPauseActive || this._pendingEmergencyMaintenanceReason
        || ['closing', 'opening'].includes(this.doorState())) return false;
    const pos = this.pos();
    const at = Number(pos?.ts || 0);
    const age = Date.now() - at;
    if (!at || age < 0 || age > RETURN_OPEN_POSITION_MAX_AGE_MS
        || !['mqtt','siid:1:4'].includes(String(pos.source || ''))
        || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) return false;
    const point = this._lockedReturnMaintenancePoint;
    if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return false;
    const [a, b, danger, pointDanger] = await Promise.all([
      Promise.resolve(this.markers.lineA?.()).catch(() => null),
      Promise.resolve(this.markers.lineB?.()).catch(() => null),
      this.markers.rawDangerState(pos).catch(() => null),
      this.markers.rawDangerState(point).catch(() => null),
    ]);
    // Both the current point and immutable waypoint must be well outside the
    // raw danger zone and on the SAME side of the infinite safety line: the
    // straight corridor between them then cannot cross that line. This does
    // not assume that the mower will follow a straight path; the independent
    // live gate-danger interlock remains active during real travel.
    const clear = d => d?.known === true
      && Number.isFinite(Number(d.distance)) && Number.isFinite(Number(d.radius))
      && Number(d.distance) > Number(d.radius) + RETURN_MAINTENANCE_EARLY_GATE_CLEARANCE_MM;
    if (!clear(danger) || !clear(pointDanger)
        || !a || !b || ![a.x,a.y,b.x,b.y].every(v => Number.isFinite(Number(v)))) return false;
    const dx = Number(b.x)-Number(a.x), dy = Number(b.y)-Number(a.y);
    const length = Math.hypot(dx, dy);
    if (length < 500) return false;
    const signed = p => (dx * (Number(p.y)-Number(a.y)) - dy * (Number(p.x)-Number(a.x))) / length;
    const fromSide = signed(pos), toSide = signed(point);
    const minLineClearance = RETURN_MAINTENANCE_EARLY_GATE_CLEARANCE_MM;
    if (Math.abs(fromSide) <= minLineClearance || Math.abs(toSide) <= minLineClearance
        || Math.sign(fromSide) !== Math.sign(toSide)) return false;
    // No stale, concurrent gate movement or token switch is allowed between
    // the async geometry reads and returning this positive decision.
    return token === this._commandToken && !this._manualGateStopped
      && this._safeReturnInProgress && this._returnGuardActive
      && this._returnContext === RETURN_STATES.MAINTENANCE
      && this._returnMaintenanceNavigationOwnerToken === token
      && !this._manualMaintenanceReached && !this._emergencyHoldActive()
      && !this._gateMotionPauseActive
      && Number(this.pos()?.ts || 0) === at
      && !['closing','opening'].includes(this.doorState());
  }

  async _tryMaintenanceTransitEarlyOpen(token) {
    if (this._returnMaintenanceEarlyOpenAttemptedToken === token) return false;
    if (!(await this._maintenanceTransitEarlyOpenSafe(token))) return false;
    if (this._returnMaintenanceEarlyOpenAttemptedToken === token) return false;
    this._returnMaintenanceEarlyOpenAttemptedToken = token;
    this.log('return maintenance: safe transit confirmed; gate OPEN started in parallel', `P${Number(this._lockedReturnMaintenancePoint?.index || 1)}`);
    this._returnMaintenanceEarlyOpenPromise = this.ensureDoorOpen('return_maintenance_transit_early_open', {
      allowOpenFromDanger: false, allowDegraded: false,
      reassertDisplayedOpen: !this._doorOpenReleaseVerified(),
    }).catch(error => {
      this.log('return maintenance: early gate open failed; stationary waypoint fallback remains', error?.message || String(error));
      return false;
    });
    // Never await the full gate cycle inside the navigation position watcher.
    // A DOCK command remains entirely gated by the verified maintenance
    // arrival, native standstill and completed door-open confirmation.
    return true;
  }

  async _startReturnMaintenanceRoute(source, dockFn, maintenanceFn, token, degradedReturn = false) {
    if (token !== this._commandToken) { this.log('return cancelled before maintenance', source); return false; }
    this._setReturnContext(RETURN_STATES.MAINTENANCE, source || 'return');
    this._manualMaintenanceTargetIndex = Number(this._lockedReturnMaintenancePoint?.index || 1);
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    // Never clear the manual-arrival proof before checking it (old code did so
    // at function entry). However, a *moving* or stale mower near the point is
    // not an arrival: _isCurrentlyAtKnownMaintenancePoint requires a recent
    // stationary verified position and gate clearance.
    if (await this._isCurrentlyAtKnownMaintenancePoint()) {
      this.log('maintenance point reached', 'already_at_verified_point');
      return this._continueReturnFromMaintenance(source || 'return', dockFn, token, degradedReturn);
    }

    if (token !== this._commandToken || this._returnContext !== RETURN_STATES.MAINTENANCE) return false;
    this._manualMaintenanceReached = false;
    this._manualMaintenancePhase = 'idle';
    // Acquire exclusive A--B/navigation ownership BEFORE the async native 109
    // dispatch (including its pause/retry preflight). Otherwise position/status
    // telemetry arriving during that await can issue a competing PAUSE/STOP.
    // This token alone never authorizes any garage movement or DOCK release.
    this._returnMaintenanceNavigationOwnerToken = token;
    this._returnLineStopProof = null;
    this.log('automatic return maintenance navigation owner armed before opcode 109', `token=${token}`);
    // Capture the physical start position BEFORE opcode 109. A successful API
    // response is only command acceptance; it is not proof that the mower has
    // actually started toward the maintenance point.
    // Preserve independently measured actual physical position when the
    // fallback followed a coasting original-app Return. The old MQTT sample
    // is still stored as returnOrigin but must never serve as departure proof.
    const waypointProof=this._returnWaypointFallbackProof;
    const maintenanceDepartureStartPos=waypointProof?.token===token
      && this._returnContext===RETURN_STATES.MAINTENANCE
      ? {...waypointProof.position} : (this.pos() ? {...this.pos()} : null);
    this._maintenanceDepartureConfirmedAt = 0;
    const maintenanceAccepted = await this._sendMaintenanceWithRetry(maintenanceFn, token, source || 'return');
    if (this._confirmedStationLockActive()) {
      this.log('maintenance handoff cancelled: confirmed native station remains authoritative', source || 'return');
      return true;
    }
    const maintenanceCommandAt = Number(this.device._nativeMaintenanceCommandAt || Date.now());
    if (maintenanceAccepted === false) {
      this._returnMaintenanceNavigationOwnerToken = null;
      // Some firmwares reject opcode 109 when the mower is already at its native
      // maintenance target. Accept that only when fresh telemetry confirms the
      // stored, map-bound point; otherwise keep the safety block.
      if (await this._isCurrentlyAtKnownMaintenancePoint()) {
        this.log('maintenance point reached', 'command_rejected_but_position_confirmed');
        return this._continueReturnFromMaintenance(source || 'return', dockFn, token, degradedReturn);
      }
      this.log('return: maintenance command rejected', source);
      await this.returnOperationalHold('maintenance_command_rejected');
      return false;
    }
    this.log('maintenance departure requested', source || 'return');
    this._watchMaintenanceReached(async () => {
      if (token !== this._commandToken) { this.log('return callback ignored: superseded', source); return; }
      await this._continueReturnFromMaintenance(source || 'return', dockFn, token, degradedReturn);
    }, async () => {
      if (token !== this._commandToken) { this.log('return timeout ignored: superseded', source); return; }
      // A timeout is never proof that the maintenance point was reached. The mower
      // may be standing directly in front of the gate with stale or unclear map
      // data. Therefore keep the gate state unchanged, do not release the dock
      // command and block the return until a valid position/maintenance arrival is
      // available. In particular, never open the gate from a maintenance timeout.
      this.log('return fallback: maintenance timeout - position unconfirmed, gate release blocked');
      await this.returnOperationalHold('maintenance_point_timeout_position_unconfirmed');
    }, {
      requireDepartureProof: true,
      retryFn: maintenanceFn,
      source: source || 'return',
      departureStartPos: maintenanceDepartureStartPos,
      commandAt: maintenanceCommandAt,
      onDepartureFailure: async (reason) => {
        if (token !== this._commandToken) return;
        await this.returnOperationalHold(reason);
      },
      onVerifiedTransit: () => this._tryMaintenanceTransitEarlyOpen(token),
    });
    return true;
  }

  async testExit() {
    if (!this.enabled()) return true;
    await this._beginOutbound('TEST_EXIT', false);
    this.log('TEST_EXIT');
    return this.ensureDoorOpen('test_exit');
  }

  _freshNativeDockState(maxAgeMs = 5000) {
    const diag = this.device?._mowerBinaryDiag;
    const at = Number(this.device?._mowerBinaryDiagAt || 0);
    if (!diag || !at) return null;
    const age = Date.now() - at;
    if (age < 0 || age > maxAgeMs) return null;
    return { ...diag, age };
  }

  async _rememberInterruptedExternalStart(reason) {
    // Bound this marker: app reinstall/restart may restore an old cloud HOME
    // state, but must not replay a stranded vendor task as a new departure.
    this._externalStartAbortUntil = Date.now() + 5 * 60 * 1000;
    this._externalStartRedockHoldUntil = 0;
    await Promise.resolve(this.device?.setStoreValue?.('garage_external_start_abort_until', this._externalStartAbortUntil))
      .catch((e) => this.error('external start abort persistence', e?.message || String(e)));
    this.log('EXTERNAL START: aborted station departure; native re-dock will get a bounded open-gate hold',
      reason || 'unknown');
  }

  _setExternalStartRecoveryPhase(phase, extra = '') {
    this._externalStartRecoveryPhase = phase || null;
    if (phase) this.log('EXTERNAL START RECOVERY:', phase, extra || '');
  }

  noteExternalStartTask(value) {
    // Forward every TASK frame to the independent map-editor transport waiter.
    // This does not classify a garage start and has no effect on recovery state.
    this.device?._noteMapEditTask?.(value);
    const nativeTask = value?.t === 'TASK' ? value.d : null;
    const nativeOpcode = Number(nativeTask?.o);
    const acceptedStartAt = Number(this._acceptedMowingTaskAt || 0);
    if (nativeTask?.status === true && nativeTask?.exe === true
        && acceptedStartAt > 0 && Date.now() - acceptedStartAt >= 0
        && Date.now() - acceptedStartAt <= 90000) {
      if (nativeOpcode === 109) {
        this._acceptedMowingTaskMismatchAt = Date.now();
        this.log('native task mismatch after accepted mowing start',
          `expected=mowing`, `source=${this._acceptedMowingTaskSource || '-'}`, 'actual=109');
      } else {
        this._acceptedMowingTaskConfirmedAt = Date.now();
        this.log('native mowing task confirmed after accepted start', `opcode=${nativeOpcode}`);
      }
    }
    // The original TASK can reach MQTT a moment AFTER Homey's PAUSE/STOP.
    // Capture throughout the bounded initial recovery window, not only while
    // the phase string is empty. Never overwrite an already captured P2
    // intent with a later ordinary mowing/STOP task.
    const captureStart = Number(this._externalStartIntentAt || this._externalStartRecoveryStartedAt || Date.now());
    const captureAge = Date.now() - captureStart;
    if (!this._externalStartRecoveryActive
        || captureAge < 0 || captureAge > 10000
        || ['FRESH_START','DONE','RESTORE_MAINTENANCE','MANUAL_REISSUE_REQUIRED'].includes(this._externalStartRecoveryPhase)
        || value?.t !== 'TASK' || !value.d || value.d.exe !== true) return;
    const opcode = Number(value.d.o);
    if (![100, 101, 102, 103, 109].includes(opcode)) return;
    if (Number(this._externalStartTask?.o) === 109 && opcode !== 109) return;
    this._externalStartTask = JSON.parse(JSON.stringify(value.d));
    this.log('external start original task preserved', `opcode=${opcode}`, `phase=${this._externalStartRecoveryPhase || 'capture'}`);
  }

  async _dispatchRecoveredMowingTask(did) {
    // Keep this method as a pure native task dispatcher.  Departure lifecycle
    // preparation must happen while the mower is still physically stationary,
    // before _beginOutbound() marks the mission as moving/outbound.  Putting the
    // lifecycle sync here creates a self-inflicted mower_moving failure because
    // _mapEditStationary() correctly rejects edits once _outbound is active.
    const task = this._externalStartTask;
    // Never replace an unknown original-app request (possibly P2 / opcode 109)
    // with ordinary mowing. The native PAUSE/STOP can overtake the MQTT TASK,
    // as seen in the field log of 2026-10-24 13:49:45Z.
    if (!task || ![100, 101, 102, 103].includes(Number(task.o))) {
      this.log('EXTERNAL START RECOVERY: original command unknown/unsupported; no mowing replacement');
      return false;
    }
    const map = Number(this.device._activeMapIndex || 0);
    if (Array.isArray(task?.area_id) && task.area_id.length) {
      return this.device._api.startSpotMowing(did, task.area_id, map);
    }
    if (Array.isArray(task?.region_id) && task.region_id.length && [100, 102].includes(Number(task.o))) {
      return this.device._api.startZoneMowing(did, task.region_id, map);
    }
    if (Number(task?.o) === 101) {
      return this.device._api.startEdgeMowing(did, map, Array.isArray(task.edge) ? task.edge : null);
    }
    if ([102, 103].includes(Number(task?.o))) {
      this.log('external start task cannot be restored: target ids missing', task.o);
      return false;
    }
    return this.device._api.startMowing(did);
  }

  async _waitForExternalRecovery(predicate, timeoutMs, label, intervalMs = 200) {
    const until = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    while (Date.now() < until) {
      try {
        const result = predicate();
        if (result) return result;
      } catch (_) {}
      await sleep(intervalMs);
    }
    this.log('EXTERNAL START RECOVERY: timeout', label || '-');
    return null;
  }

  _nativeStationContextForExternalRecovery(maxAgeMs = 45000) {
    const diag = this.device?._mowerBinaryDiag;
    const at = Number(this.device?._mowerBinaryDiagAt || 0);
    if (!diag || !at) return null;

    // During external-start recovery SIID 1 / PIID 1 behaves event-driven: if the
    // mower remains motionless in the station there may be no further binary push
    // for many seconds. Therefore absence of a NEW frame is not evidence that the
    // station state was lost. Reuse the last state observed DURING this recovery,
    // but invalidate it immediately on any contradictory dock telemetry.
    const age = Date.now() - at;
    if (age < 0 || age > maxAgeMs) return null;
    if (this._externalStartRecoveryStartedAt && at < this._externalStartRecoveryStartedAt) return null;
    if (this._externalStartStationWindowLost) return null;
    if (diag.dockingState !== 'IN_STATION' || Number(diag.undocking) !== 0) return null;
    return { ...diag, age, recoveryLatched: true };
  }

  noteExternalRecoveryDockTelemetry(diag, prev = null) {
    if (!this._externalStartRecoveryActive || !diag) return;
    const from = prev ? `${prev.dockingState}/u${Number(prev.undocking)}` : '-';
    const to = `${diag.dockingState}/u${Number(diag.undocking)}`;
    this.log('EXTERNAL START RECOVERY: native dock telemetry', `${from} -> ${to}`,
      `loc=${diag.locationState}`, `charge=${diag.chargingLive ? 1 : 0}`);
    if (diag.dockingState !== 'IN_STATION') this._externalStartStationWindowLost = true;
    if (diag.dockingState === 'IN_STATION' && Number(diag.undocking) === 0) {
      this._externalStartStationWindowConfirmedAt = Date.now();
    }
  }

  async _stopExternalStartOldTaskEarly(source, did) {
    this._externalStartRecoveryActive = true;
    if (!this._externalStartRecoveryStartedAt) this._externalStartRecoveryStartedAt = Date.now();
    // Snapshot the physical position immediately after PAUSE and before STOP.
    // Some A2 firmware/runtime combinations drop the charging contacts and emit
    // OUT_OF_STATION/u0 after STOP without the mower actually moving.  The
    // snapshot lets the later gate-open verification distinguish that harmless
    // contact-state transition from a real uncontrolled departure.
    const anchor = this.pos();
    const anchorAge = Date.now() - Number(anchor?.ts || 0);
    this._externalStartRecoveryAnchorPos = anchor && Number.isFinite(Number(anchor.x)) && Number.isFinite(Number(anchor.y))
      && Number.isFinite(anchorAge) && anchorAge >= 0 && anchorAge <= POSITION_CACHE_MS
      ? { x:Number(anchor.x), y:Number(anchor.y), ts:Number(anchor.ts) }
      : null;
    // Preserve any OUT_OF_STATION edge received while the PAUSE write was in
    // flight. Clearing it here could incorrectly re-arm a lost station window.
    this._setExternalStartRecoveryPhase('STOP_OLD_TASK_EARLY', source);

    let stopAccepted = true;
    this._externalStartStopSentAt = Date.now();
    if (typeof this.device._safeWrite === 'function') {
      stopAccepted = await this.device._safeWrite('garage_external_recovery_stop_early', () => this.device._api.stopMowing(did));
    } else {
      await this.device._api.stopMowing(did);
    }
    this.log('[start-latency] stop-answered',
      `roundtripMs=${Date.now()-this._externalStartStopSentAt}`, `accepted=${stopAccepted !== false}`);
    if (stopAccepted === false) {
      await this.safetyBlock('external_start_recovery_stop_rejected').catch(() => {});
      return false;
    }

    // Do not wait for a full task-state roundtrip here. The valuable firmware
    // window is the immediate IN_STATION + undock=0 edge after PAUSE/STOP, so
    // opening the gate must start without another multi-second settle delay.
    await sleep(120);
    const station = this._freshNativeDockState(2500);
    if (station) {
      this.log('EXTERNAL START RECOVERY: post-stop station window',
        `dock=${station.dockingState}`, `undock=${station.undocking}`,
        `loc=${station.locationState}`, `charge=${station.chargingLive ? 1 : 0}`);
      if (station.dockingState !== 'IN_STATION') this._externalStartStationWindowLost = true;
      if (station.dockingState === 'IN_STATION' && Number(station.undocking) === 0) {
        this._externalStartStationWindowConfirmedAt = Date.now();
      }
    }
    return true;
  }

  async _externalRecoveryColdBootStoppedNearDock() {
    // After an app installation/restart there may be no physical position before
    // PAUSE/STOP.  The A2 can then drop its native dock-contact bit to
    // OUT_OF_STATION while staying still at its parked map pose (~1.1 m away
    // from the DOCK anchor, sometimes just outside the configured 900 mm danger
    // circle).  This exceptional path must not delay ordinary station recovery.
    // Use it only after the gate has been genuinely verified open THIS runtime.
    const now = Date.now();
    const bootAge = now - Number(this._runtimeStartedAt || 0);
    const stopAge = now - Number(this._externalStartStopSentAt || 0);
    // Oct-20 field case: an ordinary (non-cold-boot) MOVA-App start remains at
    // x=540,y=-370 after PAUSE/STOP, ~40 mm beyond the 900-mm danger circle.
    // The original cold-boot-only exclusion rejected this safe parked pose even
    // after genuine IN_STATION/u0 telemetry. Permit this STRICT native-IDLE,
    // garage-side, near-dock proof after ANY confirmed station-start, including
    // when an anchor was captured. Never expand the actual danger circle or the
    // normal manual gate safety rules.
    const anchor = this._externalStartRecoveryAnchorPos;
    const startedAt = Number(this._externalStartRecoveryStartedAt || 0);
    const stationProofAt = Number(this._externalStartStationWindowConfirmedAt || 0);
    if (!this._externalStartRecoveryActive
        || !stationProofAt || !startedAt || stationProofAt < startedAt
        || !this._externalStartStationWindowLost
        || stopAge < 0 || stopAge > 45000
        || !this._doorOpenVerifiedThisRuntime?.()
        || !this._doorOpenReleaseVerified?.()
        || !this.isDoorOpenStable?.()
        || this._manualGateStopped) return null;

    const did = this.device?.getData?.()?.id;
    const api = this.device?._api;
    const dock = this.device?._dockPos;
    if (!did || !dock || typeof api?.getMowerPosition !== 'function'
        || typeof api?.getProperties !== 'function'
        || !Number.isFinite(Number(dock.x)) || !Number.isFinite(Number(dock.y))) return null;
    if (this._externalStartRecoveryMapAt == null
        || Number(this._externalStartRecoveryMapAt) !== Number(this.device?._activeMapIndex)) return null;

    const dockContactLost = () => {
      const d = this.device?._mowerBinaryDiag;
      const ts = Number(this.device?._mowerBinaryDiagAt || 0);
      const age = Date.now() - ts;
      return d && ts > 0 && age >= 0 && age <= 45000
        && ts >= Number(this._externalStartRecoveryStartedAt || 0)
        && d.dockingState === 'OUT_OF_STATION' && Number(d.undocking) === 0;
    };
    const readIdle = async () => {
      const r = await api.getProperties(did, [[2,1]], {timeout:1400}).catch(() => null);
      const item = r?.code === 0 ? r.data?.result?.find(x => Number(x.siid) === 2
        && Number(x.piid) === 1 && (!x.code || Number(x.code) === 0)) : null;
      return Number(item?.value) === 2;
    };
    const readPosition = async () => {
      let timeout;
      try {
        const d = await Promise.race([
          Promise.resolve().then(() => api.getMowerPosition(did)).catch(() => null),
          new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1800); }),
        ]);
        return d && Number.isFinite(Number(d.x)) && Number.isFinite(Number(d.y))
          ? {x:Number(d.x), y:Number(d.y), ts:Date.now(), source:'siid:1:4'} : null;
      } finally { clearTimeout(timeout); }
    };
    const safeGaragePose = async (p) => {
      if (!p || this._distance(p, dock) > 1500) return false;
      const raw = await this.markers?.rawDangerState?.(p).catch(() => null);
      if (!raw?.known || !Number.isFinite(Number(raw.distance))
          || !Number.isFinite(Number(raw.radius))
          || Number(raw.distance) > Number(raw.radius) + 450) return false;
      const line = await this.markers?.lineState?.(p).catch(() => null);
      return !!(line?.known && line.onSegment && line.direction?.known
        && line.rawSide != null && line.rawSide === line.direction.garageSide);
    };

    // An available pre-STOP anchor is a further non-movement constraint.  If
    // absent, two independent native positions + earlier IN_STATION/u0 still
    // have to pass the full geometric and IDLE proof below.
    const nearAnchor = p => !anchor || (Number.isFinite(Number(anchor.x))
      && Number.isFinite(Number(anchor.y))
      && this._distance(p, anchor) <= EXTERNAL_START_STATIONARY_ENVELOPE_DRIFT_MM);
    if (!dockContactLost() || !(await readIdle())) return null;
    const first = await readPosition();
    if (!dockContactLost() || !nearAnchor(first) || !(await safeGaragePose(first))) return null;
    // Same bounded dwell as the existing stationary-envelope proof; it runs
    // only on the rare contact-loss branch, never on the normal start path.
    await sleep(700);
    const second = await readPosition();
    if (!dockContactLost() || !second || this._distance(first, second) > 70
        || !nearAnchor(second) || !(await safeGaragePose(second)) || !(await readIdle())
        || !this._doorOpenVerifiedThisRuntime?.()
        || !this._doorOpenReleaseVerified?.()
        || !this.isDoorOpenStable?.()
        || this._manualGateStopped
        || Number(this._externalStartRecoveryMapAt) !== Number(this.device?._activeMapIndex)) return null;
    this.log('EXTERNAL START RECOVERY: stopped garage-side parked pose verified',
      `position=${Math.round(second.x)},${Math.round(second.y)}`,
      `dockDistance=${Math.round(this._distance(second,dock))}mm`,
      'nativeIdle=2', 'samples=2', anchor ? 'anchored=1' : 'anchored=0');
    return { ...this.device._mowerBinaryDiag, recoveryLatched:true,
      stationaryEnvelope:true, parkedPoseGarageProof:true,
      coldBootGarageProof:!anchor && bootAge >= 0 && bootAge <= 120000,
      position:second };
  }

  async _externalRecoveryStationaryGarageEnvelope() {
    if (!this._externalStartRecoveryActive || !this._externalStartRecoveryAnchorPos) return null;
    // Never use this fallback unless PAUSE produced a genuine IN_STATION/u0
    // frame first.  That keeps it scoped to the exact field case where STOP
    // subsequently drops only the charging/dock contact while the robot itself
    // remains stationary in the garage.
    if (!Number(this._externalStartStationWindowConfirmedAt || 0)) return null;
    const anchor = this._externalStartRecoveryAnchorPos;
    const status = String(this.status() || '').toLowerCase();
    if (!['idle', 'standby', 'paused', 'charging', 'charging_completed', 'docked'].includes(status)) return null;

    const currentDiag = () => {
      const diag = this.device?._mowerBinaryDiag;
      const at = Number(this.device?._mowerBinaryDiagAt || 0);
      const age = Date.now() - at;
      if (!diag || !at || age < 0 || age > 45000) return null;
      if (this._externalStartRecoveryStartedAt && at < this._externalStartRecoveryStartedAt) return null;
      if (diag.dockingState !== 'OUT_OF_STATION' || Number(diag.undocking) !== 0) return null;
      return { ...diag, age };
    };

    if (!currentDiag()) return null;
    const first = await this._refreshPositionForStart('external-start recovery contact-loss proof');
    if (!first || !Number.isFinite(Number(first.x)) || !Number.isFinite(Number(first.y))) return null;
    const firstAge = Date.now() - Number(first.ts || 0);
    if (!Number.isFinite(firstAge) || firstAge < 0 || firstAge > POSITION_CACHE_MS) return null;
    if (this._distance(first, anchor) > EXTERNAL_START_STATIONARY_ENVELOPE_DRIFT_MM) return null;
    const firstDanger = await this.markers.rawDangerState(first).catch(() => null);
    if (!firstDanger?.known || !firstDanger.inside) return null;

    // Require an independent second fresh sample after a short dwell.  This is
    // deliberately stricter than trusting the OUT_OF_STATION bit alone: the
    // mower must remain essentially motionless inside the configured garage
    // danger envelope while the gate is already fully open.
    await sleep(700);
    if (!currentDiag()) return null;
    const second = await this._refreshPositionForStart('external-start recovery stationary recheck');
    if (!second || !Number.isFinite(Number(second.x)) || !Number.isFinite(Number(second.y))) return null;
    const secondAge = Date.now() - Number(second.ts || 0);
    if (!Number.isFinite(secondAge) || secondAge < 0 || secondAge > POSITION_CACHE_MS) return null;
    if (this._distance(second, anchor) > EXTERNAL_START_STATIONARY_ENVELOPE_DRIFT_MM
        || this._distance(second, first) > MAINTENANCE_STATIONARY_DRIFT_MM) return null;
    const secondDanger = await this.markers.rawDangerState(second).catch(() => null);
    if (!secondDanger?.known || !secondDanger.inside) return null;

    const diag = currentDiag();
    if (!diag) return null;
    return { ...diag, recoveryLatched:true, stationaryEnvelope:true, position:{ ...second } };
  }

  async _recoverExternalStartViaNativeStation(source, did) {
    // IMPORTANT: no DOCK/return command is used here. A normal return can start
    // localization/justieren in the narrow garage. We only reuse a genuine
    // firmware-owned station window that survived the early PAUSE + STOP.
    this._setExternalStartRecoveryPhase('VERIFY_NATIVE_STATION_WINDOW', source);

    let station = this._nativeStationContextForExternalRecovery(45000);
    let recoveredFromStationaryEnvelope = false;
    if (!station || Number(station.undocking) !== 0 || this._externalStartStationWindowLost) {
      // Field log 2026-10-08: after our accepted PAUSE+STOP the A2 remained at
      // exactly the same garage position, but the binary contact bit changed to
      // OUT_OF_STATION/u0 before the gate finished opening.  Treat that as a
      // recoverable contact loss only when two fresh position samples prove the
      // mower stayed stationary inside the configured garage danger envelope.
      // Any real displacement, missing geometry, stale position or motion status
      // still takes the original hard Safety-Block path.
      const stationaryEnvelope = (await this._externalRecoveryStationaryGarageEnvelope())
        || (await this._externalRecoveryColdBootStoppedNearDock());
      if (stationaryEnvelope) {
        station = stationaryEnvelope;
        recoveredFromStationaryEnvelope = true;
        this.log('EXTERNAL START RECOVERY: STOP contact-loss accepted from stationary garage proof',
          `dock=${station.dockingState} undock=${station.undocking}`,
          `pos=${Math.round(station.position.x)},${Math.round(station.position.y)}`);
      } else {
        this.log('EXTERNAL START RECOVERY: native station window lost; no DOCK/return command will be sent',
          station ? `dock=${station.dockingState} undock=${station.undocking}` : 'dock=missing',
          `windowLost=${this._externalStartStationWindowLost ? 1 : 0}`);
        await this.safetyBlock('external_start_recovery_station_window_lost').catch(() => {});
        return false;
      }
    }

    if (!recoveredFromStationaryEnvelope) {
      // Require the genuine IN_STATION state to remain stable for a short period
      // after the gate is fully open. This is deliberately much shorter than the
      // old redock recovery and never attempts autonomous positioning.
      const stableSince = Date.now();
      const stable = await this._waitForExternalRecovery(() => {
        const dock = this._nativeStationContextForExternalRecovery(45000);
        if (!dock || Number(dock.undocking) !== 0 || this._externalStartStationWindowLost) return null;
        return Date.now() - stableSince >= 700 ? dock : null;
      }, 1400, 'native_station_window_stable', 100);

      if (!stable) {
        this.log('EXTERNAL START RECOVERY: IN_STATION did not remain stable; fresh start blocked');
        await this.safetyBlock('external_start_recovery_station_not_stable').catch(() => {});
        return false;
      }
      station = stable;
      this._setExternalStartRecoveryPhase('NATIVE_STATION_WINDOW_CONFIRMED',
        `dock=${station.dockingState} undock=${station.undocking} loc=${station.locationState} charge=${station.chargingLive ? 1 : 0}`);
    } else {
      this._setExternalStartRecoveryPhase('STATIONARY_GARAGE_ENVELOPE_CONFIRMED',
        `dock=${station.dockingState} undock=${station.undocking} pos=${Math.round(station.position.x)},${Math.round(station.position.y)}`);
    }

    // Clear only Homey's stale bookkeeping. Never forge native dock telemetry.
    this._clearOutboundStatusTimers();
    this._outbound = null;
    this._missionOutside = false;
    this._lineToLawnConfirmed = false;
    this._closeAfterExitRequested = false;
    this._dangerReleasedAfterExit = false;
    this._returnGuardActive = false;
    this._safeReturnInProgress = false;
    this._externalReturnHandling = false;
    this._spatialReturnHandling = false;
    this._returnContext = RETURN_STATES.IDLE;
    this._homeState = 'leaving';
    this._homeCloseArmed = true;

    // The recovery pause left device.js in RC34 "next action = resume" hold mode.
    // That mode deliberately rewrites an incoming native `mowing` to `paused` for
    // normal pause-button debounce. For this path however we are about to launch a
    // completely NEW task from a confirmed native station context, so that old
    // pause semantic is no longer valid. Clear it BEFORE 5:1 so the first genuine
    // native `mowing` telemetry is accepted immediately. Do not install the normal
    // resume semantic latch here: a real later `paused` must remain visible.
    if (this.device) {
      this.device._pauseButtonHoldMode = 'pause';
      this.device._pauseButtonHoldUntil = 0;
      this.device._resumeSemanticUntil = 0;
    }

    // Never substitute the configured primary for an original-app P2/P3/P4/P5
    // mission. The A2's TASK for opcode 109 may contain NO point index, so its
    // identity cannot be restored reliably after the safety STOP. Keep the door
    // open and ask the operator to reissue the native maintenance task from
    // the original app; with a freshly verified OPEN contact that task proceeds
    // without a second PAUSE/STOP and is separately observed for learning.
    const vendorMaintenanceTask = Number(this._externalStartTask?.o) === 109 ? this._externalStartTask : null;
    const vendorMaintenanceIndex = vendorMaintenanceTask
      ? Number(Array.isArray(vendorMaintenanceTask.point) ? vendorMaintenanceTask.point[0]
        : (vendorMaintenanceTask.point_index ?? vendorMaintenanceTask.pointIndex ?? vendorMaintenanceTask.maintenance_point)) : 0;
    const vendorMaintenanceTarget = vendorMaintenanceTask && vendorMaintenanceIndex >= 1 && vendorMaintenanceIndex <= 5
      ? await Promise.resolve(this.device?._resolveNativeMaintenancePoint?.(vendorMaintenanceIndex)).catch(() => null)
      : null;
    if (vendorMaintenanceTask && Number.isInteger(vendorMaintenanceIndex)
        && vendorMaintenanceIndex >= 1 && vendorMaintenanceIndex <= 5
        && vendorMaintenanceTarget && Number.isFinite(Number(vendorMaintenanceTarget.x))
        && Number.isFinite(Number(vendorMaintenanceTarget.y))) {
      this._setExternalStartRecoveryPhase('RESTORE_MAINTENANCE', `native P${vendorMaintenanceIndex}`);
      return this.maintenanceRequested('button_maintenance_external_recovered',
        () => this.device._goToMaintenancePointGuarded('external_recovered_maintenance', vendorMaintenanceIndex),
        vendorMaintenanceIndex);
    }
    if (!this._externalStartTask || vendorMaintenanceTask) {
      // The vendor A2 MQTT frame often contains only {o:109,status:false}.
      // DO NOT guess P1/P2 from the configured primary and never substitute a
      // mowing command. Offer a single explicit point choice after gate OPEN.
      this._externalMaintenanceSelectionRequiredAt = vendorMaintenanceTask ? Date.now() : 0;
      this._setExternalStartRecoveryPhase('MANUAL_REISSUE_REQUIRED',
        Number(this._externalStartTask?.o) === 109 ? 'native maintenance index unknown' : 'original task not captured');
      this.log('EXTERNAL START RECOVERY: no new mowing task; operator must reissue the original-app command with gate OPEN');
      this._garageNotice('maintenance_selection_required', this._text('Wartungspunkt auswählen: Original-App-Auftrag ohne eindeutige Punktnummer. Mäher Total öffnen.', 'Select maintenance point: original-app task has no clear point number. Open Total Overview.'), 'external_maintenance_selection_required', 60000);
      // Missing manufacturer point index is an *incomplete task*, not a
      // moving-gate emergency. Keep the guarded, explicit point chooser usable.
      // All door and native-station prerequisites remain mandatory.
      await this.safetyWarning('external_start_waiting_for_explicit_point').catch(() => {});
      return false;
    }

    // IMPORTANT: prepare departure-phase native no-go zones BEFORE beginning the
    // outbound cycle.  The field-proven pre-lifecycle implementation dispatched
    // the recovered task directly from this stationary station context.  When
    // lifecycle handling was later inserted inside _dispatchRecoveredMowingTask,
    // _beginOutbound() had already set _outbound/_missionOutside, causing
    // _mapEditStationary() to reject the lifecycle sync as `mower_moving`.  The
    // native task was then never sent, while _safeWrite() still reported success.
    // This preflight restores the original ordering and keeps lifecycle edits at
    // the intended safe stationary checkpoint with the gate fully open.
    if (typeof this.device?._syncPylonLifecyclePhase === 'function') {
      const lifecycle = await this.device._syncPylonLifecyclePhase('departure', { reason:'external_start_recovered' });
      if (lifecycle?.ok === false) {
        this.log('EXTERNAL START RECOVERY: pylon lifecycle preparation failed before outbound', lifecycle?.reason || 'unknown');
        this._outbound = null;
        this._missionOutside = false;
        this._homeState = this.isDockedHomeStatus() ? 'home' : 'unknown';
        await this.safetyBlock('external_start_pylon_lifecycle_failed').catch(() => {});
        return false;
      }
    }

    // Own the outbound cycle only after the stationary checkpoint is complete so
    // the fresh undock edge cannot be mistaken for another vendor-app start.
    await this._beginOutbound('EXTERNAL_START_RECOVERED', true);
    this._setExternalStartRecoveryPhase('FRESH_START', source);

    let startAccepted = true;
    if (typeof this.device._safeWrite === 'function') {
      startAccepted = await this.device._safeWrite('garage_external_recovery_fresh_start', async () => {
        const dispatched = await this._dispatchRecoveredMowingTask(did);
        // _safeWrite historically treats a resolved callback as accepted.  Make
        // an explicit dispatcher `false` a rejected write for this safety path.
        if (dispatched === false) throw new Error('recovered_task_dispatch_rejected');
        return dispatched;
      });
    } else {
      startAccepted = (await this._dispatchRecoveredMowingTask(did)) !== false;
    }
    if (startAccepted === false) {
      this._clearOutboundStatusTimers();
      this._outbound = null;
      this._missionOutside = false;
      this._homeState = this.isDockedHomeStatus() ? 'home' : 'unknown';
      await this.safetyBlock('external_start_recovery_fresh_start_rejected').catch(() => {});
      return false;
    }

    const freshDeparture = await this._waitForExternalRecovery(() => {
      const dock = this._freshNativeDockState(2500);
      const native = String(this.device?._nativeMowerStatus || '').toLowerCase();
      if (!dock) return null;
      if (dock.dockingState === 'IN_STATION' && Number(dock.undocking) === 1) return { phase: 'undocking', dock, native };
      if (dock.dockingState === 'OUT_OF_STATION' && native === 'mowing') return { phase: 'out', dock, native };
      return null;
    }, 8000, 'fresh_native_departure', 120);

    if (!freshDeparture) {
      this.log('EXTERNAL START RECOVERY: fresh start accepted but native station departure not confirmed');
      await this.safetyBlock('external_start_recovery_fresh_departure_not_confirmed').catch(() => {});
      return false;
    }

    this._missionOutside = true;
    this._lastOutdoorActivityAt = Date.now();
    await this._markOutboundReleased().catch((e) => this.error('external recovery outbound release', e.message));
    this.log('EXTERNAL START RECOVERY: fresh native departure confirmed',
      freshDeparture.phase, `dock=${freshDeparture.dock.dockingState}`, `undock=${freshDeparture.dock.undocking}`);
    this._setExternalStartRecoveryPhase('DONE', source);
    return true;
  }

  // A stale charging/idle status must not be allowed to initiate a garage
  // departure if the latest physical coordinates clearly locate the mower on
  // the lawn. This is only an exclusion: UNKNOWN geometry never proves home.
  async _freshExternalStartOutdoorVeto() {
    // The real IN_STATION + undock edge must retain its immediate response.
    const dock = this._freshNativeDockState();
    if (dock?.dockingState === 'IN_STATION') return false;
    if (dock?.dockingState === 'OUT_OF_STATION') return true;

    let p = this.pos();
    let age = Date.now() - Number(p?.ts || 0);
    const bootWindow = Date.now() - Number(this._runtimeStartedAt || 0) < 120000;
    // Cold restart often receives a vendor MOWING push before the first MQTT
    // position. Ask the mower once; never open the garage using stale idle /
    // charging merely because this one physical readback is not yet available.
    if (bootWindow && (!p || age < 0 || age > 10000)) {
      await this._refreshPositionForStart('external_start_boot_precheck');
      p = this.pos();
      age = Date.now() - Number(p?.ts || 0);
    }
    if (this._recentConfirmedHomePosition(p)) {
      this.log('external-start position veto suppressed: recent home confirmation and dock-proximate position agree',
        `distance=${Math.round(this._distance(p, this.device?._dockPos))}mm`);
      return false;
    }
    if (!p || age < 0 || age > 10000 || !Number.isFinite(Number(p.x))
        || !Number.isFinite(Number(p.y))) return bootWindow;
    const danger = await this.markers?.rawDangerState?.(p).catch(() => null);
    if (danger?.known === true && danger.inside === false) {
      this._missionOutside = true;
      this._homeState = 'away';
      this._lastOutdoorActivityAt = Date.now();
      return true;
    }
    // During cold bootstrap, no physical station proof means no garage-start
    // PAUSE/OPEN, even if the point is near the gate. The native station edge
    // is still exempt above.
    return bootWindow;
  }

  shouldInterceptExternalStartIntent() {
    if (!this.enabled()) return false;
    if (this._outbound || this._missionOutside || this.isReturnCycleActive()) return false;
    // Do not trust a persisted/cached OPEN capability for a native undocking
    // event. It may be stale across an app restart. Only current-runtime proof
    // is allowed to bypass the external-start safety handshake.
    if (this._doorOpenVerifiedThisRuntime()) return false;

    // Once native dock telemetry is available, only a FRESH real station state
    // is allowed to enter the external-start garage handshake. This prevents
    // stale cloud values such as charging/idle from treating a mower already
    // outside the station as a new dock departure.
    const dock = this._freshNativeDockState();
    if (dock) return dock.dockingState === 'IN_STATION';

    // Compatibility fallback for firmware/regions that do not expose 1:1 yet.
    const status = String(this.status() || '').toLowerCase();
    const homeLike = this.isDockedHomeStatus() || ['idle', 'standby', 'docked', 'charging'].includes(status);
    return homeLike;
  }

  async onExternalStartIntent(source = 'mqtt_external_start', task = null) {
    if (!this.enabled()) return false;
    const now = Date.now();
    const mqttUndockAt = Number(this.device?._externalStartTraceUndockAt || 0);

    // Homey-originated starts already own an outbound guard before the native
    // command is sent. Repeated MQTT task/control pushes during normal outdoor
    // mowing are telemetry, not new starts, and must never pause the mower.
    const freshStationAtStart = this._freshNativeDockState()?.dockingState === 'IN_STATION';
    // Cached outside ownership after a redock cannot override a NEW, fresh
    // physical IN_STATION start. An actual outside mower still stays excluded.
    if (this._outbound || (this._missionOutside && !freshStationAtStart) || this.isReturnCycleActive()) return false;
    if (this._externalStartIntentHandling && now - this._externalStartIntentAt < 120000) return true;
    // Status, native-undock and TASK can arrive together. Own the asynchronous
    // physical preflight as well as PAUSE -> STOP; a second trigger must join
    // rather than opening the gate via a competing status fallback.
    if (this._externalStartPreflightPending) return true;
    // Keep latency precheck timestamp in the whole start-owner scope: the
    // MQTT trace below is emitted *after* the preflight try/finally block.
    const precheckAt = Date.now();
    this._externalStartPreflightPending = true;
    try {

    // The synchronous MQTT prefilter is intentionally unchanged for native
    // undock timing. Before issuing PAUSE/STOP or touching the gate, recheck
    // physical outdoor geometry asynchronously in this command owner.
    if (await this._freshExternalStartOutdoorVeto()) {
      this.log('external start ignored: fresh lawn position overrides stale home status', source);
      return false;
    }
    const status = String(this.status() || '').toLowerCase();
    const nativeDock = this._freshNativeDockState();
    const homeLike = nativeDock
      ? nativeDock.dockingState === 'IN_STATION'
      : (this.isDockedHomeStatus() || ['idle', 'standby', 'docked', 'charging'].includes(status));
    if (!homeLike) {
      this.log('external start intent ignored: mower not physically in station/home-like state', source,
        `status=${status || 'unknown'}`, nativeDock ? `dock=${nativeDock.dockingState}` : 'dock=unknown');
      return false;
    }

    // A merely restored "open" capability is not enough here: the v5 field
    // test showed that a stale persisted OPEN could suppress the undock intercept
    // while the physical gate was closed. Only a fresh OPEN proof from this app
    // runtime may let the native task proceed without the pause/open handshake.
    if (this._doorOpenVerifiedThisRuntime()) {
      this.log('external start intent observed with gate freshly verified open', source);
      return false;
    }
    if (this.isDoorOpenStable()) {
      this.log('external start intent: cached/stale gate-open state ignored; fresh runtime verification required', source);
    }
    // After a failed closed-gate recovery the firmware may spontaneously retry
    // its OLD task when the operator re-docks. If the gate isn't independently
    // verified open, preserve the original PAUSE -> STOP ordering but do not
    // repeat the automatic garage/recovery cycle. Never unlock a stale state.
    if (Number(this._externalStartAbortUntil || 0) > now) {
      const did = this.device.getData().id;
      const pauseOK = typeof this.device._safeWrite === 'function'
        ? await this.device._safeWrite('garage_external_abort_replay_pause', () => this.device._api.pause(did))
        : await this.device._api.pause(did);
      const stopOK = typeof this.device._safeWrite === 'function'
        ? await this.device._safeWrite('garage_external_abort_replay_stop', () => this.device._api.stopMowing(did))
        : await this.device._api.stopMowing(did);
      this.log('EXTERNAL START: queued native replay intercepted without garage cycle',
        `pause=${pauseOK !== false}`, `stop=${stopOK !== false}`,
        `remainingMs=${this._externalStartAbortUntil-now}`);
      await this.safetyBlock('external_start_old_task_replayed_after_abort').catch(() => {});
      return false;
    }

    } finally {
      this._externalStartPreflightPending = false;
    }
    this._externalMaintenanceSelectionRequiredAt = 0;
    this._externalStartIntentHandling = true;
    this._externalStartIntentAt = now;
    // Dispatch the native PAUSE before timeline and Flow processing.

    const did = this.device.getData().id;
    try {
      // Start the recovery observation window BEFORE PAUSE. The decisive
      // IN_STATION/u1 -> IN_STATION/u0 frame can arrive within ~150 ms of 5:4,
      // well before STOP_OLD_TASK_EARLY is entered.
      this._externalStartRecoveryActive = true;
      this._externalStartRecoveryStartedAt = now;
      this._externalStartRecoveryPhase = null;
      this._externalStartTask = null;
      const intentAge = now - Number(this.device._mqttTaskIntentCandidateAt || 0);
      const activeAge = now - Number(this.device._mqttTaskCandidateAt || 0);
      if (intentAge >= 0 && intentAge <= 5000) {
        this.noteExternalStartTask(this.device._mqttTaskIntentCandidate);
      } else if (activeAge >= 0 && activeAge <= 2000) {
        this.noteExternalStartTask(this.device._mqttTaskCandidate);
      }
      this._externalStartStationWindowLost = false;
      this._externalStartStationWindowConfirmedAt = 0;
      this._externalStartRecoveryMapAt = Number(this.device?._activeMapIndex);
      this._externalStartRecoveryAnchorPos = null;

      // MQTT is fast enough to be a useful ram-protection layer, but not fast
      // enough to guarantee that a narrow garage can stop the A2 before it moves.
      // Pause therefore remains a best-effort safety interception, not a promise
      // that every installation can support starts from the vendor app.
      let pauseAccepted = true;
      this._externalStartPauseSentAt = Date.now();
      if (typeof this.device._safeWrite === 'function') {
        pauseAccepted = await this.device._safeWrite('garage_external_start_intent_pause', () => this.device._api.pause(did));
      } else {
        await this.device._api.pause(did);
      }
      if (pauseAccepted === false) {
        this.log('EXTERNAL START INTENT: pause rejected; automatic gate release aborted', source);
        await this.safetyBlock('external_start_intent_pause_rejected').catch(() => {});
        return false;
      }

      // The pause is already the immediate collision protection. Give MQTT one
      // tiny bounded window to deliver the original task descriptor before STOP
      // replaces it with opcode 3. This is especially important for vendor-app
      // maintenance (109), whose native motion status still looks like mowing.
      if (!this._externalStartTask) {
        await this._waitForExternalRecovery(() => {
          const age = Date.now() - Number(this.device._mqttTaskIntentCandidateAt || 0);
          if (age >= 0 && age <= 5000) this.noteExternalStartTask(this.device._mqttTaskIntentCandidate);
          return this._externalStartTask || null;
        }, 120, 'original_task_intent_capture', 20);
      }

      // v9: STOP the half-started task immediately after PAUSE. Field logs show a
      // very short native IN_STATION + undock=0 window here; waiting the previous
      // 1.5 s settle period let that window collapse into OUT_OF_STATION.
      const stoppedEarly = await this._stopExternalStartOldTaskEarly(source, did);
      if (!stoppedEarly) return false;
      // Passive milestone instrumentation ONLY after original PAUSE -> STOP.
      const trace = this.device?._externalStartTrace;
      if (trace && mqttUndockAt === Number(trace.receivedAt)) {
        this.log('[start-latency] milestone',
          `mqttArrival=${new Date(trace.receivedAt).toISOString()}`,
          `decodeLagMs=${trace.decodeLagMs}`,
          `previousMessageGapMs=${trace.previousGapMs ?? 'unknown'}`,
          `mqttConnectedAgeMs=${trace.connectedAgeMs ?? 'unknown'}`,
          `vendorTsRaw=${trace.vendorTsRaw ?? 'absent'}`,
          `wifiRssi=${trace.wifiRssi ?? 'unknown'}`,
          `precheckMs=${this._externalStartPauseSentAt-precheckAt}`,
          `pauseIssuedMs=${this._externalStartPauseSentAt-mqttUndockAt}`,
          `stopIssuedMs=${this._externalStartStopSentAt-mqttUndockAt}`,
          `appRuntimeMs=${now-Number(this._runtimeStartedAt || now)}`);
      }

      // The 29-Oct field log showed that ordinary status and Flow bookkeeping
      // preceded the motor OPEN request while a very short firmware station
      // window was already ticking. Keep PAUSE then STOP strictly sequential,
      // but launch the safeguarded OPEN handshake immediately after STOP ACK.
      // No new mower movement is issued while the contact is unverified.
      this._homeCloseArmed = false;
      this._homeState = 'home';
      this._clearOutboundStatusTimers();
      this._outbound = null;
      this._missionOutside = false;
      // The old unconditional 30s minimum held an already sensor-open gate for
      // ~20 extra seconds. With a healthy real contact, _doorOpenReleaseVerified
      // is the sole release gate (including its own stable-open period). Keep
      // the 30s minimum for offline/disabled sensors and time-only fallback.
      const liveDoorContact = typeof this.device?.getSetting === 'function' && this.sensorEnabled?.() === true
        && this.sensorDoorMonitoringEnabled?.() === true && this.sensorHealthy?.() === true;
      const startMinWaitMs = liveDoorContact ? 0 : START_MIN_DOOR_OPEN_WAIT_MS;
      const openRequestedAt = Date.now();
      const gateOpening = this.ensureDoorOpen('external_start', {
        allowOpenFromDanger: true, minWaitMs: startMinWaitMs,
      }).catch(error => {
        this.error('external start gate OPEN handshake failed', error?.message || String(error));
        return false;
      });
      this.log('EXTERNAL START: gate handshake dispatched after PAUSE -> STOP',
        `edge_to_gate_handshake_ms=${openRequestedAt - now}`,
        `sensorContact=${liveDoorContact ? 'healthy' : 'degraded'}`,
        `minWaitMs=${startMinWaitMs}`);
      // Notify/UI only after dispatching the actual gate handshake. Neither
      // timeline nor capability writes may add latency to the OPEN request.
      this.realtimeTimelineEvent('external_start', source);
      this._trigger('garage_external_start_blocked', 'external_start_mqtt_intent');
      this.log('EXTERNAL START INTENT: PAUSE and STOP dispatched before user-facing events', source,
        `edge_to_pause_ms=${this._externalStartPauseSentAt - now}`,
        `edge_to_stop_ms=${this._externalStartStopSentAt - now}`,
        `pause_to_stop_ms=${this._externalStartStopSentAt - this._externalStartPauseSentAt}`);
      if (typeof this.device._applyStatus === 'function') await this.device._applyStatus('paused').catch(() => {});
      const openOk = await gateOpening;
      this.log('[start-latency] door-open-handshake-result',
        `sinceMqttMs=${mqttUndockAt ? Date.now()-mqttUndockAt : 'unknown'}`,
        `sinceHandshakeMs=${Date.now()-openRequestedAt}`, `accepted=${openOk !== false}`,
        `stable=${this.isDoorOpenStable()}`);
      if (!openOk || !this.isDoorOpenStable()) {
        await this.safetyBlock('external_start_gate_open_failed').catch(() => {});
        return false;
      }

      // Do not Resume and do not send DOCK/return. The only allowed recovery is
      // a genuine firmware IN_STATION + undock=0 window surviving PAUSE + STOP
      // through the completed gate opening. Then start a completely fresh task.
      const recovered = await this._recoverExternalStartViaNativeStation(source, did);
      if (!recovered) {
        // Keep ownership of the OPEN gate following this real start attempt.
        // Never force it closed on cached charging/home: _scheduleHomeClose()
        // still needs fresh physical IN_STATION/u0 plus strong dock evidence.
        // Once that proof arrives, the normal 15-second stable-close mechanism
        // may finish this abandoned start without a manual garage session.
        // With an unknown original intent do NOT auto-close the gate before
        // the operator can reissue the maintenance command. No motor command is
        // sent by Homey; manual operator takeover is explicit.
        this._homeCloseArmed = this._externalStartRecoveryPhase !== 'MANUAL_REISSUE_REQUIRED';
        this.log('EXTERNAL START RECOVERY: failed; home-close rearmed for verified native dock only',
          `dock=${this.device?._mowerBinaryDiag?.dockingState || 'unknown'}`);
        if (this._strongDockCloseProof()) {
          this._homeState = 'home';
          // Recovery-active suppression ends in finally; allow event-driven
          // home-close on the next confirmed station telemetry after cleanup.
        } else {
          this.log('EXTERNAL START RECOVERY: dock unverified; gate remains open (no blind close)');
        }
        return false;
      }
      this.log('EXTERNAL START INTENT: gate verified open; native station context recovered and fresh task started', source);
      return true;
    } catch (e) {
      this.error('external start intent interception failed', e.message);
      await this.safetyBlock('external_start_intent_interception_failed').catch(() => {});
      return false;
    } finally {
      // Persist the aborted native task's risk before unblocking the dock-close
      // watcher. The firmware can replay it after a manual re-dock, even after
      // installing a different app version. Keep PAUSE and STOP intact.
      if (!['DONE', 'RESTORE_MAINTENANCE', 'MANUAL_REISSUE_REQUIRED'].includes(this._externalStartRecoveryPhase)) {
        await this._rememberInterruptedExternalStart(this._externalStartRecoveryPhase);
      }
      this._externalStartIntentHandling = false;
      this._externalStartRecoveryActive = false;
      // The task intercept has ended, but the explicitly requested operator
      // choice is a separate, durable UI state. Keep its phase while the
      // bounded selection is pending; otherwise the overview never sees it.
      if (!(this._externalStartRecoveryPhase === 'MANUAL_REISSUE_REQUIRED'
            && Number(this._externalMaintenanceSelectionRequiredAt || 0) > 0)) {
        this._externalStartRecoveryPhase = null;
      }
      this._externalStartRecoveryStartedAt = 0;
      this._externalStartStationWindowConfirmedAt = 0;
      this._externalStartTask = null;
      // A failed intercepted start may have genuinely redocked meanwhile. Once
      // recovery owns no further commands, schedule the standard proof-based
      // close, not an immediate close and not a cloud-status-only close.
      if (this._homeCloseArmed && this._homeState === 'home'
          && this.doorState() === 'open' && this._strongDockCloseProof()) {
        this._scheduleHomeClose('external_start_abort_native_dock_verified');
      }
    }
  }

  async onExternalMowingDetected() {
    if (!this.enabled()) return;
    if (this._externalStartRecoveryActive || this._externalStartIntentHandling || this._externalStartPreflightPending) {
      this.log('external mowing joined native station start owner', this._externalStartRecoveryPhase || '-');
      return;
    }
    const now = Date.now();
    const physicallyInStation = this._freshNativeDockState()?.dockingState === 'IN_STATION';
    if (!physicallyInStation && ((this._resumeGuardUntil && now < this._resumeGuardUntil)
        || (this._lastPauseAt && now - this._lastPauseAt < 120000))) {
      this.log('external mowing ignored: pause/resume guard active');
      this._missionOutside = true;
      this._lastOutdoorActivityAt = now;
      await this.refreshTileStatus('resume guard').catch(() => {});
      return;
    }
    if (!physicallyInStation && this._missionOutside && !this.isDockedHomeStatus()) {
      this.log('external mowing ignored: existing outdoor mission');
      this._lastOutdoorActivityAt = now;
      return;
    }

    // A generic status edge MUST NOT be a second garage-exit implementation.
    // Field 30-Oct: status fallback opened the CLOSED gate while vendor mowing
    // was already in progress. Only the native station owner may PAUSE -> STOP,
    // open the gate, verify the contact and reissue the original task.
    // An OPEN tile or a persisted capability is not physical release proof.
    if (!this._doorOpenVerifiedThisRuntime()) {
      const dock = this._freshNativeDockState();
      if (dock?.dockingState === 'IN_STATION') {
        this.log('external mowing fallback delegated to PAUSE -> STOP station owner',
          `door=${this.doorState()}`, `undock=${dock.undocking}`);
        await this.onExternalStartIntent('status_mowing_station_fallback');
      } else {
        // Fail closed, but do not PAUSE a mower on the lawn merely because an
        // outdated cloud mowing edge arrived. A native departure or fresh
        // station proof can still trigger the single guarded owner later.
        this.log('external mowing fallback: NO gate command without fresh station proof',
          `door=${this.doorState()}`, `dock=${dock?.dockingState || 'unknown'}`);
        this._trigger('garage_external_start_blocked', 'external_start_station_unverified');
      }
      return;
    }

    // Already physically confirmed OPEN by a fresh, runtime-owned contact:
    // preserve the existing outbound/line-close tracking. No extra STOP.
    if (!this._outbound) {
      this._homeCloseArmed = true;
      await this._beginOutbound('EXTERNAL_START', true);
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
      await this._markOutboundReleased().catch((e) => this.error('external outbound release', e.message));
    }
  }

  async _interceptExternalReturn(source = 'external_return', observedStatus = '') {
    if (!this.enabled() || this.isDockedHomeStatus()) return false;
    if (this._maintenanceJourneyOwnsNavigation()) {
      this.log('external return telemetry belongs to active native maintenance journey', source);
      return false;
    }
    const now = Date.now();
    const resumeGuardActive = !!(this._resumeGuardUntil && now < this._resumeGuardUntil);
    if (resumeGuardActive) {
      // Resume outside is not a return request. Suppress every generic inbound
      // interceptor (status, spatial trend and safety-line direction) while the
      // native/cloud state settles. No gate movement may be started here.
      this.log('external return ignored: resume stabilization active', source, 'status=', observedStatus || this.status());
      this._missionOutside = true;
      this._lastOutdoorActivityAt = now;
      this._spatialReturnSamples = [];
      await this.refreshTileStatus('resume stabilization').catch(() => {});
      return false;
    }
    // The spatial safety interlock can observe the returning mower before the
    // status callback confirms RETURNING. It already owns PAUSE -> gate OPEN ->
    // DOCK. Do not start a second lifecycle/return owner while it is active.
    // The line owner will perform any necessary lifecycle sync at its verified
    // stationary checkpoint before releasing the mower.
    if (this._awaitingLineDoorOpen) {
      this.log('external return joined existing safety-line wait', source);
      return true;
    }
    if (this._returnGuardActive || this._safeReturnInProgress || this._externalReturnHandling || this._spatialReturnHandling) {
      this.log('[external-return] joined guarded owner', `phase=${this._returnContext}`, `source=${source}`);
      return true;
    }
    this._spatialReturnHandling = true;
    this._externalReturnHandling = true;
    this._spatialReturnTriggeredAt = Date.now();
    this._lineToLawnConfirmed = false;
    this._closeAfterExitRequested = false;
    this._dangerReleasedAfterExit = false;
    this._clearOutboundStatusTimers();
    if (this._lineCloseTimer) { clearTimeout(this._lineCloseTimer); this._lineCloseTimer = null; }
    this._setLineState(LINE_STATES.IDLE, 'external_inbound_intercept');
    this._outbound = null;
    this._missionOutside = true;
    this._lastOutdoorActivityAt = Date.now();
    const did = this.device.getData().id;
    this.log('external return intercepted', source, 'status=', observedStatus || this.status());
    try {
      const nativeReturning = String(observedStatus || '').toLowerCase() === 'returning'
        && String(source || '').includes('status_returning');

      // IMPORTANT: route selection must happen BEFORE any generic pause/open
      // sequence. v11 paused the mower and fully opened the gate first, then
      // returnRequested() could still decide on the maintenance-point path. That
      // produced the contradictory sequence:
      //   pause -> gate open -> maintenance point -> dock.
      // A return cycle now owns exactly one strategy:
      //   direct      = keep native return, open in parallel, A-B interlock if needed
      //   maintenance = keep gate closed, go to maintenance point, then open + dock
      //   emergency   = existing danger/late-return guards remain authoritative.
      // This also preserves the freshest position for _decideReturnPath().
      if (nativeReturning) {
        this.log('external native return: route decision before any pause/open action', source);
      } else {
        this.log('external return: delegating pause/open behaviour to selected return strategy', source);
      }

      // If the vendor-app return is already inside the gate danger area,
      // immediately pause it. Never let a fresh native DOCK continue toward a
      // closed/moving gate while route selection performs map/cloud reads.
      const rawDanger = await this.markers.rawDangerState(this.pos()).catch(() => null);
      if (rawDanger?.known === true && rawDanger.inside === true) {
        this.log('[external-return] DANGER: immediate PAUSE before mandatory selected maintenance detour', source);
        const paused = await this.device._safeWrite(`garage_${source}_immediate_pause`,
          () => this.device._api.pause(did)).catch(() => false);
        if (paused === false) {
          await this.safetyBlock('external_return_danger_pause_rejected');
          return false;
        }
      }
      const accepted = await this.returnRequested(`external_${source}`,
        async () => {
          const accepted = await this.device._safeWrite(`garage_${source}_dock`, () => this.device._api.dock(did));
          if (accepted === false) return false;
          await this.device._applyStatus('returning', 0, false);
          return true;
        },
        async () => this.device._goToMaintenancePointGuarded(`garage_${source}_maintenance`),
      );
      this.log('[external-return] guarded continuation', `accepted=${accepted===true}`, `phase=${this._returnContext}`, `source=${source}`);
      if (!accepted) await this.safetyWarning('external_return_guarded_continuation_not_confirmed').catch(() => {});
      return accepted;
    } finally {
      this._externalReturnHandling = false;
      this._spatialReturnHandling = false;
    }
  }


  async _detectClosedGateFrontReturn(danger) {
    // A physically blocked RETURN may already have a return owner. In that
    // case _interceptExternalReturn() deliberately refuses a second owner;
    // the old detector excluded the very state that needed the detour.
    // Preserve the separate idle/external fallback, but use fresh, independent
    // coordinates and a bounded window for BOTH paths.
    const now = Date.now();
    const status = String(this.status() || '').toLowerCase();
    const activeReturn = this.isReturnCycleActive();
    const doorClosed = this.doorState() === 'closed';
    const resumeGuardActive = !!(this._resumeGuardUntil && now < this._resumeGuardUntil);
    const blockedStatus = ['paused', 'idle', 'standby'].includes(status);
    const inactiveExternalCandidate = !activeReturn && blockedStatus
      && !this._externalReturnHandling && !this._spatialReturnHandling
      && !this._isUserPauseGuardActive();
    const reset = () => { this._frontGateReturnSamples = []; return false; };

    if (!doorClosed || this._outbound || this._manualGateStopped || this._emergencyGateContext
        || this._frontGateReturnHandling || this._closedGateRecoveryHandling
        || this._maintenanceJourneyOwnsNavigation()
        || resumeGuardActive || (!activeReturn && !inactiveExternalCandidate)
        || this._awaitingLineDoorOpen || (this._returnContext === RETURN_STATES.MAINTENANCE
          && !!this._maintenanceWatch && !this._manualMaintenanceReached)) return reset();
    // During active RETURN, a fresh native returning edge itself proves intent;
    // an outside mission flag may have been lost during reboot or after PAUSE.
    if (!activeReturn && !this._missionOutside) return reset();

    const pos = this.pos();
    const posAt = Number(pos?.ts || 0);
    if (!pos || posAt <= 0 || now < posAt || now - posAt > 5000
        || !Number.isFinite(Number(pos.x)) || !Number.isFinite(Number(pos.y))) return reset();
    const dockState = this._freshNativeDockState?.();
    if (dockState?.dockingState === 'IN_STATION') return reset();
    const physical = await this.markers?.rawDangerState?.(pos).catch(() => null);
    if (!physical?.known || !Number.isFinite(Number(physical.distance))
        || !Number.isFinite(Number(physical.radius))) return reset();
    const dock = this.device._dockPos || this.device._cachedMapData?.chargerPos || null;
    const distanceToDockMm = this._distance(pos, dock);
    // The region must be close to the ACTUAL dock/gate, not merely the A-B line.
    // At <650mm only fresh OUT_OF_STATION telemetry excludes an already-docked
    // mower; never infer 'outside' from a charging tile or a cached position.
    if (distanceToDockMm === null || distanceToDockMm > 2300
        || (distanceToDockMm < 650 && dockState?.dockingState !== 'OUT_OF_STATION')
        || Number(physical.distance) > Number(physical.radius) + 2300) return reset();

    const samples = this._frontGateReturnSamples || [];
    // Same cached MQTT/GPS point may be polled repeatedly. Each observation
    // used to authorise a detour must have a distinct source timestamp.
    if (!samples.length || posAt > samples[samples.length - 1].posAt) {
      samples.push({ ts:now, posAt, x:Number(pos.x), y:Number(pos.y), distanceToDockMm });
    }
    while (samples.length && now - samples[0].ts > 20000) samples.shift();
    if (samples.length > 20) samples.splice(0, samples.length - 20);
    this._frontGateReturnSamples = samples;
    if (samples.length < 4) return false;
    const first = samples[0], last = samples[samples.length - 1];
    const duration = last.ts - first.ts;
    const approachMm = first.distanceToDockMm - last.distanceToDockMm;
    const displacement = this._distance(first, last) || 0;
    const approaching = duration >= 3000 && approachMm >= 250;
    const repeatedlyBlocked = duration >= 7000 && displacement <= 350;
    if (!approaching && !repeatedlyBlocked) return false;
    // After a fresh install, an outside mower may have been parked beside a
    // closed garage for minutes. Four identical fresh read timestamps prove
    // stillness, NOT that the user requested RETURN. Never launch an external
    // recovery waypoint from an inert idle mower unless we observed the
    // physical approach in this runtime or a real return owner already exists.
    // A deliberate Homey return remains available immediately.
    if (!activeReturn && !approaching && Number(this._runtimeStartedAt || 0) > 0
        && !(Number(this._spatialReturnTriggeredAt || 0) > Number(this._runtimeStartedAt || 0))) return reset();
    if (this._frontGateReturnTriggeredAt && now - this._frontGateReturnTriggeredAt < 120000) return false;

    this._frontGateReturnTriggeredAt = now;
    this._frontGateReturnHandling = true;
    this.log('closed gate front-zone return confirmed', `activeReturn=${activeReturn}`,
      `status=${status}`, `dockDistance=${Math.round(distanceToDockMm)}mm`,
      approaching ? `approach=${Math.round(approachMm)}mm` : `blocked=${Math.round(displacement)}mm`);
    this._timeline(`${this._text('Rückkehr vor geschlossenem Tor erkannt', 'Return blocked in front of closed gate')} – ${this._text('kontrollierte Umleitung über Wartungspunkt', 'controlled maintenance detour')}`, 'return:closed_gate_front_zone');
    try {
      if (activeReturn) {
        return await this._routeClosedGateReturnViaMaintenance('closed_gate_front_zone');
      }
      return await this._interceptExternalReturn('closed_gate_front_zone', status);
    } finally {
      this._frontGateReturnHandling = false;
      this._frontGateReturnSamples = [];
    }
  }

  async _routeClosedGateReturnViaMaintenance(reason = 'closed_gate_return') {
    // An already physically docked mower must never receive another
    // PAUSE/STOP or P1 detour because a delayed RETURNING status reappeared.
    if (this._confirmedStationLockActive()) return false;
    // A stationary CLOSED gate in front of a returning mower is a recoverable
    // routing condition, not an Emergency. Emergency is reserved for the real
    // collision hazard: mower in the danger area WHILE the gate is moving.
    if (this._manualGateStopped || !this.isReturnCycleActive()
        || this._maintenanceJourneyOwnsNavigation()
        || this._closedGateRecoveryHandling || this._awaitingLineDoorOpen) return false;
    // The accepted native 109 and its watcher own the whole trip, including
    // the initial period before the first departure position is observed.
    // Repeating PAUSE here would immediately sabotage that live route.
    if (this._returnContext === RETURN_STATES.MAINTENANCE
        && !!this._maintenanceWatch && !this._manualMaintenanceReached) return true;
    this._closedGateRecoveryHandling = true;
    try {
      const token = this._commandToken;
      const source = this._pendingDirectReturnSource || reason || 'closed_gate_return';
      const did = this.device.getData().id;
      const dockFn = this._pendingDirectDockFn || (async () => {
        if (typeof this.device._safeWrite === 'function') {
          return this.device._safeWrite('garage_return_recovery_dock', () => this.device._api.dock(did));
        }
        return this.device._api.dock(did);
      });

      this.log('return recovery: stationary closed gate -> controlled maintenance detour', reason || 'closed_gate_return');
      this._timeline(`${this._text('Rückkehr vor geschlossenem Tor', 'Return in front of closed gate')} – ${this._text('kontrollierte Umleitung über Wartungspunkt', 'controlled reroute via maintenance point')}`, `return:closed_gate_recovery:${reason}`);
      await this.safetyWarning('return_closed_gate_controlled_maintenance_detour').catch(() => {});

      // A previous return-zone STOP may have ALREADY ended the native task.
      // First prove IDLE + paired physical coordinates. This prevents the
      // 20-Oct PAUSE/STOP storm and permits one 109 after an actual stop.
      let stationary = await this._confirmNativeIdleForMaintenanceDispatch(token, `closed_gate_${reason}`);
      if (!stationary) {
        const pauseRequestedAt = Date.now();
        try {
          const accepted = typeof this.device._safeWrite === 'function'
            ? await this.device._safeWrite('garage_return_closed_gate_pause', () => this.device._api.pause(did))
            : await this.device._api.pause(did);
          if (accepted === false) throw new Error('native pause command was rejected');
        } catch (e) {
          this.error('closed-gate return pause failed', e.message);
          await this.returnOperationalHold('return_closed_gate_pause_failed');
          return false;
        }
        if (token !== this._commandToken || this._manualGateStopped) return false;
        stationary = await this._waitForNativePause(token, pauseRequestedAt);
      }
      // A2 may remain in RETURNING or IDLE even after accepting PAUSE. If no
      // fresh native/independent-position standstill proof arrived, end that
      // native return ONCE, then require the same physical stop proof before 109.
      if (!stationary && token === this._commandToken && !this._manualGateStopped) {
        const stopAt = Date.now();
        this.log('closed gate detour: PAUSE not independently confirmed; attempting one native STOP');
        try {
          const stopped = typeof this.device._safeWrite === 'function'
            ? await this.device._safeWrite('garage_return_front_gate_stop', () => this.device._api.stopMowing(did))
            : await this.device._api.stopMowing(did);
          if (stopped !== false) stationary = await this._waitForNativePause(token, stopAt, 5000);
        } catch (e) {
          this.error('closed-gate STOP recovery failed', e.message);
        }
      }
      if (!stationary || token !== this._commandToken || this._manualGateStopped) {
        await this.returnOperationalHold('return_closed_gate_stop_unconfirmed');
        return false;
      }
      await this._lockReturnMaintenancePoint(`closed_gate_recovery_${reason}`);
      if (token !== this._commandToken || this._manualGateStopped) return false;
      if (!this._lockedReturnMaintenancePoint) {
        await this.returnOperationalHold('return_closed_gate_maintenance_point_unavailable');
        return false;
      }
      // The former A-B wait may have latched a terminal owner. Release it
      // only when BOTH the physical stop and a valid new route are confirmed.
      this._returnLineWaitTerminalToken = null;
      this._safeReturnInProgress = true;
      this._returnGuardActive = true;
      this._setReturnContext(RETURN_STATES.MAINTENANCE, `closed_gate_recovery_${reason}`);
      this._pendingDirectDockFn = null;
      this._pendingDirectReturnToken = 0;
      this._pendingDirectReturnSource = null;

      // If the mower is already at the verified point, do not send it away and
      // back again. This also releases a late original-app return safely.
      if (await this._isCurrentlyAtKnownMaintenancePoint()) {
        if (token !== this._commandToken || this._manualGateStopped) return false;
        return this._continueReturnFromMaintenance(source, dockFn, token, false);
      }

      this._manualMaintenanceReached = false;
      this._manualMaintenancePhase = 'idle';
      this._returnMaintenanceNavigationOwnerToken = token;
      const departureStartPos = this.pos() ? { ...this.pos() } : null;
      this._maintenanceDepartureConfirmedAt = 0;
      let maintenanceAccepted = false;
      const maintenanceFn = async () => {
        if (typeof this.device._goToMaintenancePointGuarded === 'function') {
          return this.device._goToMaintenancePointGuarded(`garage_return_recovery_${reason}`);
        }
        if (typeof this.device.cmdGoToMaintenancePoint === 'function') {
          return this.device.cmdGoToMaintenancePoint();
        }
        return false;
      };
      if (typeof this.device._goToMaintenancePointGuarded === 'function') {
        maintenanceAccepted = await maintenanceFn();
      } else if (typeof this.device.cmdGoToMaintenancePoint === 'function') {
        maintenanceAccepted = await maintenanceFn();
      }
      if (token !== this._commandToken || this._manualGateStopped) return false;
      if (maintenanceAccepted === false) {
        this._returnMaintenanceNavigationOwnerToken = null;
        if (await this._isCurrentlyAtKnownMaintenancePoint()) {
          return this._continueReturnFromMaintenance(source, dockFn, token, false);
        }
        await this.returnOperationalHold('return_closed_gate_maintenance_command_rejected');
        return false;
      }
      this._watchMaintenanceReached(async () => {
        if (token !== this._commandToken || this._manualGateStopped) return;
        await this._continueReturnFromMaintenance(source, dockFn, token, false);
      }, async () => {
        if (token !== this._commandToken || this._manualGateStopped) return;
        await this.returnOperationalHold('return_closed_gate_maintenance_timeout');
      }, {
        requireDepartureProof: true,
        retryFn: maintenanceFn,
        source: `closed_gate_recovery_${reason}`,
        departureStartPos,
        commandAt: Number(this.device._nativeMaintenanceCommandAt || Date.now()),
        onDepartureFailure: async (failureReason) => {
          if (token !== this._commandToken) return;
          this._returnMaintenanceNavigationOwnerToken = null;
          await this.returnOperationalHold(failureReason);
        },
      });
      return true;
    } finally {
      this._closedGateRecoveryHandling = false;
    }
  }
  async _detectSpatialExternalReturn(danger, line) {
    if (!this.enabled() || !this._missionOutside || this._outbound || this.isDockedHomeStatus()
        || this._maintenanceJourneyOwnsNavigation()) return false;
    if (this._resumeGuardUntil && Date.now() < this._resumeGuardUntil) {
      this._spatialReturnSamples = [];
      return false;
    }
    if (this._returnGuardActive || this._safeReturnInProgress || this._externalReturnHandling || this._spatialReturnHandling) return false;
    const pos = this.pos();
    if (!pos || !danger || !danger.known || !Number.isFinite(Number(danger.distance))) return false;
    const now = Date.now();
    const direction = line?.direction?.known ? line.direction : await this.markers.directionState().catch(() => null);
    const stableSide = line?.side ?? line?.rawSide ?? null;
    const lawnSide = direction?.lawnSide ?? this._lawnLineSide;
    const sample = {
      ts: now,
      x: Number(pos.x), y: Number(pos.y),
      dangerDistance: Number(danger.distance),
      lineDistance: Number.isFinite(Number(line?.distance)) ? Number(line.distance) : null,
      side: stableSide,
    };
    this._spatialReturnSamples.push(sample);
    this._spatialReturnSamples = this._spatialReturnSamples.filter((x) => now - x.ts <= SPATIAL_RETURN_WINDOW_MS).slice(-10);
    if (this._spatialReturnSamples.length < 4) return false;
    const first = this._spatialReturnSamples[0];
    const last = this._spatialReturnSamples[this._spatialReturnSamples.length - 1];
    if (last.ts - first.ts < SPATIAL_RETURN_MIN_DURATION_MS) return false;
    const progress = first.dangerDistance - last.dangerDistance;
    let decreasing = 0;
    for (let i = 1; i < this._spatialReturnSamples.length; i++) {
      if (this._spatialReturnSamples[i].dangerDistance < this._spatialReturnSamples[i - 1].dangerDistance - 80) decreasing += 1;
    }
    const moved = Math.hypot(last.x - first.x, last.y - first.y);
    const status = this.status();

    // A geometric approach trend alone is never enough to start a return.
    // During mowing, pause/resume or positioning the mower may legitimately
    // drive toward the garage. Only accept this late-return detector when a
    // real return intent is already visible from the native state or from an
    // explicit recent return command. The safety line and danger-area guards
    // still remain active and will stop unsafe motion without cancelling the
    // mowing mission.
    const action = String(this.lastRequestedAction || '').toLowerCase();
    const explicitReturnIntent = status === 'returning'
      || action.includes('dock')
      || action.includes('return')
      || action.includes('home');
    if (!explicitReturnIntent) {
      this._spatialReturnSamples = [];
      return false;
    }

    const nearGarage = last.dangerDistance <= Number(danger.radius || 1200) + SPATIAL_RETURN_TRIGGER_MARGIN_MM;
    const onLawnApproach = lawnSide === null || lawnSide === undefined || last.side === lawnSide || last.side === null;
    const requiredProgress = status === 'mowing' ? SPATIAL_RETURN_STRONG_PROGRESS_MM : SPATIAL_RETURN_MIN_PROGRESS_MM;
    const strongTrend = progress >= requiredProgress && moved >= requiredProgress * 0.75 && decreasing >= 3;
    if (!nearGarage || !onLawnApproach || !strongTrend) return false;
    if (this._spatialReturnTriggeredAt && now - this._spatialReturnTriggeredAt < 120000) return false;
    this.log('spatial inbound trend detected', `status=${status}; progress=${Math.round(progress)}mm; distance=${Math.round(last.dangerDistance)}mm; samples=${this._spatialReturnSamples.length}`);
    await this._interceptExternalReturn('spatial_inbound_guard', status);
    return true;
  }

  noteUserPauseRequested() {
    this._clearOutsideMowingTileAck();
    this._userPauseActive = true;
    this._userPauseGuardUntil = Date.now() + 10 * 60 * 1000;
    this.lastRequestedAction = 'button_pause_mowing';
    this._cancelSuspectedPausedReturn();
    this.log('user pause guard active');
  }

  noteUserResumeRequested() {
    this._userPauseActive = false;
    this._userPauseGuardUntil = Date.now() + 90 * 1000;
    this.lastRequestedAction = 'button_resume_mowing';
    this._cancelSuspectedPausedReturn();
    this.log('user resume guard active');
  }

  _isUserPauseGuardActive() {
    return !!this._userPauseActive || (this._userPauseGuardUntil && Date.now() < this._userPauseGuardUntil);
  }

  _cancelSuspectedPausedReturn() {
    if (this._suspectedPausedReturnTimer) clearTimeout(this._suspectedPausedReturnTimer);
    this._suspectedPausedReturnTimer = null;
  }

  _notePausedOutsideNoReturn(prevStatus = '') {
    if (!this.enabled()) return;
    // A native paused state is not evidence that the mower intends to return.
    // This handler is only reached for status=paused, including pauses issued
    // in the vendor app where Homey has no local user-pause guard. Previously
    // the 12-second timeout below converted those ordinary pauses into a
    // garage return (and could route the mower through maintenance). Real
    // returns are handled from explicit RETURNING/error evidence in onStatus;
    // spatial safety detectors remain independent of this status transition.
    const diag = this.device?._mowerBinaryDiag;
    this.log('paused outside retained; no return inferred without native return/error evidence',
      `prev=${prevStatus || '-'}`, `dock=${diag?.dockingState || 'unknown'}`);
  }

  async observeNativeStatusSample(status) {
    if (!this._outbound) return false;
    const now = Date.now();
    const out = this._outbound;
    const anchor = Number(out.originalCommandSentAt || this._manualMaintenanceCommandAcceptedAt || 0);
    const mowingEligibleAt = anchor ? anchor + OUTBOUND_EXITING_DISPLAY_MS : 0;

    if (status === 'mowing') {
      // Keep mowingSince for the command-acceptance watchdog. The first five
      // seconds remain the explicit Ausfahrt phase and can never be shortened.
      // Afterwards, four consecutive effective native MOWING observations are
      // accepted as independent proof that Justieren/Positionieren has completed.
      // _applyStatus() calls this hook only after pause/resume stale-status filters.
      if (!out.mowingSince) out.mowingSince = now;
      if (!anchor || now < mowingEligibleAt) {
        out.mowingStatusHits = 0;
        out.mowingStatusLastAt = 0;
        out.stableMowingConfirmed = false;
        out.stableMowingConfirmedAt = 0;
        return false;
      }

      const lastHit = Number(out.mowingStatusLastAt || 0);
      if (lastHit && now - lastHit > OUTBOUND_NATIVE_MOWING_CONFIRM_WINDOW_MS) {
        out.mowingStatusHits = 0;
        out.mowingStatusLastAt = 0;
      }
      const previousHit = Number(out.mowingStatusLastAt || 0);
      if (!previousHit || now - previousHit >= OUTBOUND_NATIVE_MOWING_CONFIRM_MIN_GAP_MS) {
        out.mowingStatusHits = Math.min(
          OUTBOUND_NATIVE_MOWING_CONFIRM_HITS,
          Number(out.mowingStatusHits || 0) + 1,
        );
        out.mowingStatusLastAt = now;
        this.log('native mowing departure evidence', `consecutive=${out.mowingStatusHits}/${OUTBOUND_NATIVE_MOWING_CONFIRM_HITS}`);
      }
      if (!out.stableMowingConfirmed
          && out.mowingStatusHits >= OUTBOUND_NATIVE_MOWING_CONFIRM_HITS) {
        out.stableMowingConfirmed = true;
        out.stableMowingConfirmedAt = now;
        this._missionOutside = true;
        this._lastOutdoorActivityAt = now;
        await this._setHomeState('away').catch(() => {});
        this.log('native mowing departure confirmed', 'four consecutive filtered mowing status samples');
        if (this._manualMaintenanceTransit) await this._updateManualMaintenanceJourneyPhase().catch(() => {});
        await this.refreshTileStatus('four consecutive native mowing status samples confirmed').catch(() => {});
        return true;
      }
      return false;
    }

    // The proof requires FOUR CONSECUTIVE effective mowing observations. Any
    // non-mowing sample breaks the sequence; samples from the first Ausfahrt
    // window never count toward a later confirmation.
    out.mowingSince = null;
    out.mowingStatusHits = 0;
    out.mowingStatusLastAt = 0;
    if (!out.stableMowingConfirmed) out.stableMowingConfirmedAt = 0;
    return false;
  }

  async onStatus(status, prevStatus) {
    if (!this.enabled()) return;

    this.log('status', status, 'last=', this.lastRequestedAction || '-', 'outbound=', this._outbound ? this._outbound.action : '-');

    // PAUSE/STOP during external-start recovery intentionally produces paused,
    // idle and home-like telemetry. Those are recovery mechanics, not a new user
    // return cycle and must not trigger normal return routing or home-close.
    if (this._externalStartRecoveryActive
        && ['STOP_OLD_TASK_EARLY', 'VERIFY_NATIVE_STATION_WINDOW', 'NATIVE_STATION_WINDOW_CONFIRMED'].includes(this._externalStartRecoveryPhase)) {
      this.log('status handled by external-start recovery only', status, this._externalStartRecoveryPhase);
      await this.refreshTileStatus(`external-start recovery ${this._externalStartRecoveryPhase}`).catch(() => {});
      return;
    }
    // A lagging polling frame may still say RETURNING after binary IN_STATION
    // and confirmed live charging. Do not tear down the 15-second dock-close
    // stability clock or resurrect an outbound/return cycle from that frame.
    const binary = this.device?._mowerBinaryDiag;
    const binaryAge = Date.now() - Number(this.device?._mowerBinaryDiagAt || 0);
    if (status === 'returning' && !this._outbound && binary
        && binary.dockingState === 'IN_STATION' && Number(binary.undocking) === 0
        && (binary.chargingLive === true || this._homeDockStableSince > 0)
        && binaryAge >= 0 && binaryAge <= 60000) {
      this.log('late returning ignored: fresh physical IN_STATION proof preserves home-close stability');
      await this.refreshTileStatus('binary home beats stale returning').catch(() => {});
      return;
    }
    // The station lock is released only by actual OUT_OF_STATION/undocking
    // telemetry. Until then, late idle/paused/returning cloud frames must not
    // change Home back to Away or cancel the already armed stable dock-close.
    if (this._confirmedStationLockActive()
        && !['docked', 'charging', 'charging_completed'].includes(status)) {
      this._homeState = 'home';
      this._missionOutside = false;
      this._safeReturnInProgress = false;
      this._returnGuardActive = false;
      this._setReturnContext(RETURN_STATES.HOME_CONFIRMED, 'confirmed_native_station_late_status');
      this.log('late native status ignored: confirmed station lock preserves home and gate-close stability', status);
      await this.refreshTileStatus('confirmed native station late status').catch(() => {});
      return;
    }
    if (status !== 'paused') this._cancelSuspectedPausedReturn();
    if (status !== 'returning' && this._resumeNativeReturnTimer) {
      clearTimeout(this._resumeNativeReturnTimer);
      this._resumeNativeReturnTimer = null;
    }
    if (status !== 'returning') this._cancelAmbiguousNativeReturn();
    if (this._resumeGuardUntil && Date.now() < this._resumeGuardUntil && status === 'returning') {
      this._scheduleNativeReturnDuringResumeGuard(status);
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
      await this.refreshTileStatus('native return verification during resume guard').catch(() => {});
      return;
    }
    // Vendor-app Pause -> Resume can briefly report RETURNING together with the
    // binary PAUSE_DOCKING state. That is not a dock request. Real A2 return
    // traces use FINISH_DOCKING and remain immediate; only this ambiguous state
    // is held for a short confirmation window.
    if (status === 'returning' && this._nativeReturnLooksLikePauseResumeTransient(prevStatus)) {
      this._scheduleAmbiguousNativeReturnConfirmation(prevStatus);
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
      await this.refreshTileStatus('ambiguous native return debounce').catch(() => {});
      return;
    }

    const activeReturnCompletion = this.isReturnCycleActive()
      || this._safeReturnInProgress
      || (this._returnContext && this._returnContext !== RETURN_STATES.IDLE);
    if ((['docked', 'charging', 'charging_completed'].includes(status) || this._chargingIndicatesDocked())
        && (this._outbound || this._missionOutside || (this._outboundHardLockUntil && Date.now() < this._outboundHardLockUntil))
        && !activeReturnCompletion
        && this._returnContext !== RETURN_STATES.HOME_CONFIRMED) {
      // MOVA/Homey may still emit docked/charging from the just-finished cycle
      // directly after a new start. During opening/Ausfahrt/Justieren/Positionieren
      // this is stale and must never schedule "Zuhause -> Tor schließen". The
      // next valid home event is only accepted during/after a real return cycle.
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
      this._closeScheduled = false;
      this._homeCloseInProgress = false;
      this.log('stale home status ignored during active start/outbound cycle', status, 'prev=', prevStatus || '-');
      await this.refreshTileStatus('outbound stale home ignored').catch(() => {});
      return;
    }

    // Manual maintenance owns the state machine from command acceptance until
    // physical arrival (or timeout/explicit return). The mower/cloud commonly
    // reports one or more stale docked/charging samples immediately after opcode
    // 109 is accepted. Treating those as a real home confirmation tears down the
    // maintenance watcher, clears the transit flag and lets the normal outbound
    // line/door-close logic take over before the mower reaches the native maintenance point.
    if (this._manualMaintenanceTransit) {
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
      this.log('native status held during manual maintenance transit', status);
      await this.refreshTileStatus('manual maintenance transit').catch(() => {});
      return;
    }

    const nativeHomeSignal = ['docked', 'charging', 'charging_completed'].includes(status);
    const fallbackHomeSignal = !nativeHomeSignal && this._chargingHomeFallbackAllowed() && this._chargingIndicatesDocked();
    if (nativeHomeSignal || fallbackHomeSignal) {
      // The binary MQTT station state is an independent, fresh contradiction to
      // a delayed native 'docked' frame. Do not tear down return protection or
      // schedule closing while telemetry explicitly says the mower is outside.
      const binary = this.device?._mowerBinaryDiag;
      const binaryAge = Date.now() - Number(this.device?._mowerBinaryDiagAt || 0);
      if (binary && Number(this.device?._mowerBinaryDiagAt || 0) > 0
          && (binary.dockingState !== 'IN_STATION' || Number(binary.undocking) === 1)) {
        // Includes cloud CHARGING fallbacks observed while the mower remains
        // OUT_OF_STATION after an aborted external start. No synthetic HOME.
        this.log('home signal held: native docking telemetry contradicts station arrival',
          `source=${nativeHomeSignal ? 'native' : 'charging_fallback'}`, binary.dockingState);
        await this.refreshTileStatus('native home binary station contradiction').catch(() => {});
        return;
      }
      if (!nativeHomeSignal && (this._missionOutside || this._outbound || (this._outboundHardLockUntil && Date.now() < this._outboundHardLockUntil))) {
        this.log('charging fallback ignored during outdoor/start mission');
        await this.refreshTileStatus('charging fallback ignored').catch(() => {});
        return;
      }
      if (nativeHomeSignal && activeReturnCompletion) {
        // A genuine dock/charge signal at the end of a controlled return wins over
        // stale outbound remnants left by a previously interrupted start. Clear
        // those remnants atomically so HOME_CONFIRMED can arm the close sequence.
        this._clearOutboundStatusTimers();
        this._outbound = null;
        this._outboundHardLockUntil = 0;
        this._missionOutside = false;
        this._externalStartIntentHandling = false;
        this.log('return completion: native home signal cleared stale outbound state', status);
      }
      if (nativeHomeSignal) this._nativeDockVerifiedAt = Date.now();
      this._clearResumeGuard('native docked or charging');
      this._setReturnContext(RETURN_STATES.HOME_CONFIRMED, 'native_docked_or_charging');
      await this._setHomeState('home');
      // Finalize the return only AFTER the uninterrupted settling interval.
      // A first charging packet may still be followed by a docking correction.
      if (this.doorState() !== 'closed') this._scheduleHomeClose('native_docked_or_charging');
      return;
    }

    if (status === 'paused') this._lastPauseAt = Date.now();
    if (status === 'mowing' && this._userPauseGuardUntil && Date.now() < this._userPauseGuardUntil) {
      this._userPauseActive = false;
    }

    if (this._resumeGuardUntil && Date.now() < this._resumeGuardUntil && (status === 'mowing' || status === 'paused')) {
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
      if (status === 'mowing') {
        this._lastResumeMowingAt = Date.now();
        await this._maybeReleaseResumeGuard(status).catch(() => {});
      }
      // During Pause→Resume the cloud may oscillate paused/mowing for up to a
      // minute. Never let those transient paused events re-enter start/return/
      // door logic. The raw mower_status capability is still updated by device.js.
      if (status === 'paused' && (prevStatus === 'mowing' || this._lastResumeMowingAt)) {
        this.log('paused status ignored during resume guard');
        await this.refreshTileStatus('resume guard').catch(() => {});
        return;
      }
    }

    if (this._startConfirmationPending && status === 'mowing' && this._outbound && !this._outbound.mowingSince) {
      this._outbound.mowingSince = Date.now();
    }
    if (this._startConfirmationPending && ['mowing', 'remote_control', 'mapping'].includes(status)
        && this._startConfirmedByNativeOrMovement()) {
      this._clearStartConfirmation();
      this._startConfirmationFailed = false;
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
      this.log('start confirmed by stable native status', status);
      this._scheduleOutboundStatusTimers();
      await this.refreshTileStatus('native start confirmed').catch(() => {});
    }

    if (status === 'mowing' || status === 'remote_control') {
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
    }

    // Upstream already has a Home-Cycle-Lock for late cloud packets after docking,
    // but it used to be evaluated only after the generic inbound handler below.
    // A delayed `returning` packet could therefore re-arm `_missionOutside` first,
    // making the existing lock unreachable and cancelling the pending home close.
    // Evaluate the existing lock before any inbound state mutation. Deliberate new
    // start/dock commands clear `_homeCycleLocked`, so this cannot mask a real new
    // mission.
    // A genuine, sustained native departure must NOT remain suppressed by
    // the completed-home status lock. A single transient binary edge only
    // invalidates movement permission; it does not authorize any new motion.
    if (['returning','mowing','leaving','paused','idle','standby','error'].includes(status)
        && this._homeCycleNativeDepartureConfirmed()) {
      this._homeCycleLocked = false;
      this._homeCycleLockedAt = 0;
      this._homeCycleLockPhysicalDepartureAt = 0;
      this._homeCycleLockDepartureSamples = 0;
      this._homeCycleLockDepartureLastAt = 0;
      this._missionOutside = true;
      this._homeState = 'away';
      this._lastOutdoorActivityAt = Date.now();
      this.log('home-cycle-lock released by sustained native physical departure', status);
    }
    if (this._homeCycleLocked
        && !this._outbound
        && ['returning', 'paused', 'error', 'idle', 'standby'].includes(status)) {
      this.log('home-cycle-lock: ignore post-home status before inbound mutation', status, 'prev=', prevStatus || '-');
      await this.refreshTileStatus('home-cycle-lock');
      return;
    }

    // Autonomous inbound movement (low battery, long standby, app/schedule return,
    // error recovery) invalidates every pending outbound close permission. The old
    // Safety-Line result belongs to the previous direction and may never close the
    // gate while the mower is approaching it. Remember whether the mower was already
    // in a real outdoor mission before mutating state; this distinguishes a genuine
    // inbound trip from a late duplicate cloud status after docking.
    const wasOutsideBeforeInbound = !!this._missionOutside
      || !!this._outbound
      || this._homeState === 'away'
      || this._homeState === 'adjusting'
      || (this._lastOutdoorActivityAt && Date.now() - this._lastOutdoorActivityAt < 15 * 60 * 1000);
    const controlledPriority3Close = this._exitPauseForCloseActive
      && this._closeAfterExitRequested
      && this.doorState() === 'closing';
    const transientInboundDuringControlledClose = controlledPriority3Close
      && ['error', 'idle', 'standby'].includes(status);
    if (transientInboundDuringControlledClose) {
      // Priority-3 intentionally pauses the mower before closing the garage.
      // Dreame may briefly report idle/standby/error as a consequence of that
      // commanded pause. Those transient statuses are not proof of an inbound
      // trip and must never undo the close we just requested. A real returning
      // status is deliberately NOT suppressed here, and the independent
      // position/danger-area moving-gate interlock remains fully active.
      this.log('inbound reversal suppressed: controlled priority 3 close', status);
    } else {
      // Only a genuine native RETURNING state is strong enough on its own to
      // invalidate the outbound/door-close plan. Dreame may briefly emit
      // error/idle/standby while it is still mowing, especially near the garage.
      // Those ambiguous states must not be interpreted as an autonomous return
      // unless there is independent explicit return intent from a recent command.
      const actionForInbound = String(this.lastRequestedAction || '').toLowerCase();
      const explicitReturnAction = actionForInbound.includes('dock')
        || actionForInbound.includes('return')
        || actionForInbound.includes('home');
      const inboundStatusConfirmed = status === 'returning'
        || (['error', 'idle', 'standby'].includes(status) && explicitReturnAction);
      if (inboundStatusConfirmed && wasOutsideBeforeInbound && !this.isDockedHomeStatus()) {
      this._lineToLawnConfirmed = false;
      this._closeAfterExitRequested = false;
      this._dangerReleasedAfterExit = false;
      this._clearOutboundStatusTimers();
      if (this._lineCloseTimer) { clearTimeout(this._lineCloseTimer); this._lineCloseTimer = null; }
      this._setLineState(LINE_STATES.IDLE, 'inbound_motion_cancels_outbound_close');
      if (this._outbound) {
        this.log('inbound motion detected: stale outbound close permission cancelled', status);
        this._outbound = null;
      }
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
      if (this.doorState() === 'closing' && !this._emergencyGateContext && !this._emergencyGateWait) {
        // A verified stationary maintenance arrival is the explicit safe close
        // condition for this workflow. Generic idle/standby telemetry must not
        // immediately undo that close request as apparent inbound motion.
        if (this._manualMaintenanceReached) {
          this.log('inbound reversal suppressed: verified maintenance point is safe for closing', status);
        } else {
          this.log('inbound motion while gate closing: reversing gate to open', status);
          await this.ensureDoorOpen('inbound_motion_gate_reversal', { emergencyReverse: true }).catch((e) => this.error('inbound gate reversal', e.message));
        }
      }
      } else if (['error', 'idle', 'standby'].includes(status) && wasOutsideBeforeInbound) {
        this.log('ambiguous inbound status ignored without explicit return intent', status, 'prev=', prevStatus || '-');
      }
    }

    if (this._outbound) {
      if (status === 'mowing' && !this._lineToLawnConfirmed) {
        this.log('native mowing during outbound', 'sampled_for_four-hit_confirmation');
      }
      if (!this._outbound.dockLeftAt && !['docked', 'charging', 'charging_completed', 'idle', 'standby'].includes(status)) {
        this._outbound.dockLeftAt = Date.now();
        this.log('dock left during outbound');
      }
      // _applyStatus already recorded this exact native sample before invoking
      // onStatus. Counting it again here can make two packets appear as four.
    }

    if (this._nativeHomeStatus(status)) {
      // During a just-released outbound command the cloud can still report stale
      // dock/charge values although the mower is leaving. Ignore all home signals
      // until there is no active outbound/outdoor mission, unless the native
      // mower status itself explicitly says docked/charging after a return.
      if (this._outbound || (this._missionOutside && !['docked', 'charging', 'charging_completed'].includes(status))) {
        this.log('docked/charging ignored during active outbound/outdoor mission');
        await this.refreshTileStatus('outbound/outdoor mission active');
        return;
      }
      this._returnGuardActive = true;
      this._externalReturnHandling = false;
      // Keep the return owned until the complete stable-dock interval succeeds.
      this._homeState = 'home';
      if (!(this._homeState === 'home' && this.doorState() === 'closed')) this._scheduleHomeClose('docked_or_charging');
    } else {
      // If the mower was just home and suddenly reports returning, treat this as a
      // dock/charging-state glitch and do not open the garage or send another dock command.
      if (status === 'returning'
          && !wasOutsideBeforeInbound
          && this._lastHomeAt
          && Date.now() - this._lastHomeAt < 5 * 60 * 1000) {
        this.log('returning ignored: recently home/docked and no outdoor mission evidence');
        await this.refreshTileStatus('recent-home duplicate return').catch(() => {});
        return;
      }

      // After a completed dock/home cycle the mower is safe and the garage state
      // machine is idle. Ignore late/duplicated return/error/paused cloud states
      // until a deliberate new command or real outside mission starts. This is the
      // Home-Cycle-Lock and prevents the gate from re-opening after successful
      // docking or station power/charging glitches.
      if (this._homeCycleLocked && !this._missionOutside && !this._outbound && ['returning', 'paused', 'error', 'idle', 'standby'].includes(status)) {
        this.log('home-cycle-lock: ignore post-home status', status, 'prev=', prevStatus || '-');
        await this.refreshTileStatus('home-cycle-lock');
        return;
      }

      // External return/abort from Dreame/Mova app, schedule, low battery, thermal,
      // darkness/rain, lidar/thermal fault, user abort, etc. Garage mode first
      // locks one return strategy: a timely/far return may stay direct with the
      // A-B safety-line interlock, while near/unclear/late returns use maintenance.
      // Pause/Resume is a pure mower state transition. It must never start the
      // garage return flow. Return interception is therefore limited to real
      // return/error states.
      // A transient idle/standby report is common while a mowing mission is
      // starting, resuming or while cloud telemetry is incomplete. It is not a
      // return command by itself. Direct status interception is therefore only
      // allowed for explicit returning or independently corroborated error states;
      // idle/standby still remain
      // available to the independent spatial/safety-line inbound detectors.
      const returnAction = String(this.lastRequestedAction || '').toLowerCase();
      const explicitReturnAction = returnAction.includes('dock')
        || returnAction.includes('return')
        || returnAction.includes('home');
      const errorHasReturnEvidence = status === 'error'
        && (prevStatus === 'returning'
          || explicitReturnAction
          || this._returnGuardActive
          || this._safeReturnInProgress
          || (this._returnContext && this._returnContext !== RETURN_STATES.IDLE));
      const safeReturnStatuses = status === 'returning' || errorHasReturnEvidence ? [status] : [];
      if (status === 'paused' && wasOutsideBeforeInbound && !this._outbound) {
        this._notePausedOutsideNoReturn(prevStatus);
      }
      const startExitCloseSettling = (this._recentStartExitCloseUntil && Date.now() < this._recentStartExitCloseUntil) || (this._startCycleIgnoreReturnUntil && Date.now() < this._startCycleIgnoreReturnUntil);
      if (startExitCloseSettling && safeReturnStatuses.includes(status) && !wasOutsideBeforeInbound) {
        this.log('external return ignored: recent start/exit settling without outdoor mission evidence', status, 'prev=', prevStatus || '-');
        await this.refreshTileStatus('recent start exit close settling').catch(() => {});
        return;
      }

      const shouldInterceptSafeReturn = !(this._resumeGuardUntil && Date.now() < this._resumeGuardUntil)
        && (!startExitCloseSettling || wasOutsideBeforeInbound)
        && safeReturnStatuses.includes(status)
        && !this.isDockedHomeStatus()
        && !this._outbound
        && !this._returnGuardActive
        && !this._externalReturnHandling
        && !this._safeReturnInProgress
        // A COMPLETED manual maintenance trip still leaves lastRequestedAction
        // set to "button_maintenance". The old string check silently discarded
        // every genuine returning status from the vendor app in precisely that
        // state. An active transit is already handled above; a parked mower must
        // always be eligible for an explicit native return interception.
        && !this._manualMaintenanceTransit
        && !['docked', 'charging', 'charging_completed'].includes(prevStatus || '')
        && !(this._lastHomeAt && Date.now() - this._lastHomeAt < 5 * 60 * 1000);

      if (shouldInterceptSafeReturn) {
        this.log('external safe-return condition detected', 'status=', status, 'prev=', prevStatus);
        await this._interceptExternalReturn(`status_${status}`, status);
        return;
      }

      // Do not cancel the 15 s home-close timer just because the cloud briefly
      // reports idle/standby after docking. The charging capability is the more
      // reliable dock indicator in that phase.
      if ((status === 'idle' || status === 'standby') && (this._homeState === 'home_pending' || this.isDockedHomeStatus())) {
        this.log('idle/standby ignored while home confirmation is pending');
        await this.refreshTileStatus('home pending');
        return;
      }
      // Only a non-home status that survives all post-dock stale-status guards is
      // allowed to tear down HOME_CONFIRMED. This prevents a late idle/standby
      // packet from cancelling the 15-second close window while preserving real
      // departure/inbound safety handling.
      this._invalidateHomeClose(`native_${status}`);
      clearTimeout(this._closeTimer);
      await this._setHomeState('away');
      await this.refreshTileStatus('away');
    }
  }

  _watchDegradedDockResult(reason) {
    clearInterval(this._degradedDockTimer);
    const started = Date.now();
    this._degradedDockTimer = setInterval(async () => {
      if (!this.enabled()) {
        clearInterval(this._degradedDockTimer);
        this._degradedDockTimer = null;
        return;
      }
      if (['docked', 'charging', 'charging_completed'].includes(this.status())) {
        clearInterval(this._degradedDockTimer);
        this._degradedDockTimer = null;
        await this.clearSafety('degraded_return_docked');
        return;
      }
      if (Date.now() - started > DEGRADED_DOCK_TIMEOUT_MS) {
        clearInterval(this._degradedDockTimer);
        this._degradedDockTimer = null;
        this.log('degraded return failed: mower did not dock in time');
        // SAFETY: never use the UI pause/resume toggle in a fail-safe path.
        const did = this.device.getData().id;
        try {
          if (typeof this.device._safeWrite === 'function') {
            await this.device._safeWrite('garage_degraded_return_hard_pause', () => this.device._api.pause(did));
          } else {
            await this.device._api.pause(did);
          }
          if (typeof this.device._applyStatus === 'function') await this.device._applyStatus('paused', 0, false).catch(() => {});
        } catch (e) {
          this.error('degraded return hard pause failed', e.message);
        }
        if (!this.isDockedHomeStatus()) await this.device.cmdGoToMaintenancePoint().catch(() => {});
        await this.safetyBlock('garage_not_opened_or_docking_failed');
      }
    }, 5000);
  }

  _strongDockCloseProof() {
    // Arming the close window requires positive station evidence plus charging.
    // A fresh binary IN_STATION/u0 frame and a fresh cloud/native charging frame
    // may arrive separately; requiring chargingLive=true in that exact binary
    // packet caused valid docked A2 sessions to be rejected indefinitely.
    const now = Date.now();
    const binary = this.device?._mowerBinaryDiag;
    const binaryAt = Number(this.device?._mowerBinaryDiagAt || 0);
    const binaryFresh = !!binary && binaryAt > 0 && now - binaryAt >= 0 && now - binaryAt <= 15000;
    // Once native binary dock state has been observed, its absence/staleness
    // cannot silently convert an OUT_OF_STATION contradiction to home proof.
    // The old 15-second expiry let a later cloud CHARGING frame finalize an
    // aborted launch while the last physical station bit still said OUT.
    if (binaryAt > 0 && !binaryFresh) return false;
    if (binaryFresh && (binary.dockingState !== 'IN_STATION' || Number(binary.undocking) !== 0)) return false;
    if (['returning', 'mowing', 'leaving', 'error'].includes(String(this.status()))) return false;
    const freshCharging = this._freshChargingDockProof(15000);
    if (binaryFresh) {
      return binary.dockingState === 'IN_STATION' && Number(binary.undocking) === 0
        && (binary.chargingLive === true || freshCharging);
    }
    return freshCharging;
  }

  noteHomeChargingTelemetry(status, at = Date.now()) {
    const value = String(status || '').toLowerCase();
    if (!['charging', 'charging_completed', 'docked'].includes(value)) return;
    const proofAt = Number(at || Date.now());
    if (this._homeDockStableSince && proofAt > Number(this._homeDockStableSince || 0)
        && this._strongDockCloseProof()) {
      this._homeDockLastProofAt = proofAt;
    }
    this._resumeDeferredHomeClose('charging_telemetry');
  }

  _scheduleHomeClose(reason) {
    if (this._manualGateStopped || this._emergencyHoldActive()) return;
    if (this._externalStartRecoveryActive) {
      this.log('home close suppressed: external-start native-station recovery active', this._externalStartRecoveryPhase || '-', reason || '');
      return;
    }
    // RC36: never auto-close on app install/restart or from a stale docked/charging
    // restore. Closing after Home is only armed by a real start/return session in
    // this runtime.
    if (!this._homeCloseArmed) {
      this.log('home close suppressed: no active garage session after app start', reason || '');
      this._closeScheduled = false;
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
      return;
    }
    // Dock/charge is the final hard signal only at the end of a return cycle.
    // During a new start/outbound phase, any home signal is stale and must never
    // close the gate.
    if ((this._outbound || (this._outboundHardLockUntil && Date.now() < this._outboundHardLockUntil) || this._missionOutside)
        && !this._safeReturnInProgress
        && this._returnContext !== RETURN_STATES.HOME_CONFIRMED) {
      this.log('home close suppressed during active start/outbound cycle', reason || '');
      return;
    }
    const strongDockProof = this._strongDockCloseProof();
    const existingStableWindow = Number(this._homeDockStableSince || 0) > 0;
    const laterHoldProof = existingStableWindow && this._dockHoldCloseProof();
    if ((!existingStableWindow && !strongDockProof) || (existingStableWindow && !strongDockProof && !laterHoldProof)) {
      // Home/return state is still valid; only the safety-critical close proof is
      // missing. Keep the mower visibly Zuhause and wait event-driven for a fresh
      // station/charging proof instead of resetting the whole Home cycle. Once a
      // strong proof has already armed the 15-s window, a later fresh IN_STATION/u0
      // hold is sufficient to continue that *same* window; it never creates one.
      this._closeScheduled = false;
      this._homeCloseInProgress = false;
      this.log('home close deferred: station/charge proof not yet strong', reason || '');
      return;
    }
    if (!this._homeDockStableSince) {
      this._homeDockStableSince = Date.now();
      this._homeDockEpoch = Number(this._homeDockEpoch || 0) + 1;
    }
    this._homeDockLastProofAt = Date.now();
    if (this._homeCloseInProgress) return;
    if (this.doorState() === 'closed') {
      this._closeScheduled = false;
      this._closeCompleted = true;
      this.log('home detected; door already closed, no close scheduled', reason || '');
      return;
    }
    if (this._closeScheduled) clearTimeout(this._closeTimer);
    this._closeScheduled = true;
    this._homeCloseInProgress = true;
    const homeToken = this._commandToken;
    const dockEpoch = this._homeDockEpoch;
    const elapsedStable = Math.max(0, Date.now() - Number(this._homeDockStableSince || 0));
    if (Number(this._externalStartAbortUntil || 0) > Date.now()
        && !Number(this._externalStartRedockHoldUntil || 0)
        && strongDockProof && this.doorState() === 'open') {
      // The original app may resume its queued task only AFTER a manual
      // re-dock. Keep the genuinely OPEN gate for a short bounded interval so
      // this replay doesn't encounter a freshly closed barrier. This DOES NOT
      // send any native driving command or override the contact interlock.
      this._externalStartRedockHoldUntil = Date.now() + 45 * 1000;
      this.log('EXTERNAL START: verified redock after failed start; defer normal home-close for 45s');
    }
    const delayedCloseMs = Math.max(0, Number(this._externalStartRedockHoldUntil || 0) - Date.now());
    const remainingStableMs = Math.max(0, DOCK_HOME_CONFIRM_MS - elapsedStable, delayedCloseMs);
    this.log('home detected; close scheduled after remaining stable dock time', `${Math.ceil(remainingStableMs / 1000)}s`, reason || '');
    this._closeTimer = setTimeout(async () => {
      try {
        if (homeToken !== this._commandToken || this._manualGateStopped || dockEpoch !== this._homeDockEpoch) return;
        if (!this.enabled()) { this._closeScheduled = false; return; }
        const recentConfirmedHome = this._homeCycleLocked
          && this._lastHomeAt
          && Date.now() - this._lastHomeAt < 5 * 60 * 1000;
        const freshPhysicalStation = this._freshStationHoldProof(60000);
        if (!this.isDockedHomeStatus() && !recentConfirmedHome && !freshPhysicalStation) {
          this._closeScheduled = false;
          this._invalidateHomeClose('home_status_lost');
          this.log('home confirmation cancelled: mower no longer docked/charging');
          return;
        }
        if (!this.isDockedHomeStatus() && freshPhysicalStation) {
          this.log(this._text(
            'Verspäteten Cloud-Status ignoriert; frische physische IN_STATION-Telemetrie erhält das Torschließfenster',
            'Stale cloud home status ignored; fresh physical IN_STATION telemetry preserves the gate-close window',
          ));
        }
        if (!this._homeDockReadyForClose()) {
          // Missing proof is not proof of departure. Preserve HOME_CONFIRMED and
          // the already elapsed settling window; the next genuine station/charge
          // event re-enters _scheduleHomeClose() with only the remaining time.
          this._closeScheduled = false;
          this.log('home close withheld: waiting for a later independent dock proof');
          await this.safetyWarning('home_close_waits_for_strong_dock_proof').catch(() => {});
          return;
        }
        if (homeToken !== this._commandToken || this._manualGateStopped || dockEpoch !== this._homeDockEpoch) return;
        await this._enterDockedIdle('home_15s');
        if (homeToken !== this._commandToken || this._manualGateStopped || dockEpoch !== this._homeDockEpoch) return;
        this._trigger('garage_home_confirmed', reason || 'home_15s');
        this._trigger('garage_safe_return_completed', reason || 'home_15s');
        const closeOk = await this.requestClose('home_15s');
        if (!closeOk) this._closeScheduled = false;
      } finally {
        if (homeToken !== this._commandToken || this._manualGateStopped || dockEpoch !== this._homeDockEpoch) return;
        this._homeCloseInProgress = false;
    this._outboundHardLockUntil = 0;
    this._startDoorReleasedAt = 0;
    this._startCycleIgnoreReturnUntil = 0;
    this._emergencyHoldUntil = 0;
    this._dangerReleasedAfterExit = false;
      }
    }, remainingStableMs);
  }

  async confirmNativeMaintenanceArrival(reason = 'native_arrival', confirmedPosition = null, pointIndex = null) {
    if (this.device?._nativeMaintenanceArrivalClosed) return false;
    // This is the single authoritative completion path for a maintenance
    // journey. It may be called either by the geometric watcher or directly by
    // device.js when firmware status 75 / a stable native arrival is observed.
    // Keeping the journey context latched until here prevents sensor timeout,
    // Ausfahrt states or cloud packet ordering from losing the first arrival.
    if (!this._maintenanceRequestedAt && !this._manualMaintenanceTransit
        && !this._pausedMaintenanceHandoff
        && this._returnContext !== RETURN_STATES.MAINTENANCE) return false;

    clearInterval(this._maintenanceWatch);
    this._maintenanceWatch = null;
    this._maintenanceStartPos = null;
    this._maintenanceStableHits = 0;
    this._maintenanceLastConfirmPositionTs = 0;
    const targetIndex = Math.max(1, Math.min(5, Math.trunc(Number(pointIndex) || this._lockedReturnMaintenancePoint?.index || this._manualMaintenanceTargetIndex || 1)));
    if (this._pausedMaintenanceHandoff
        && targetIndex !== Number(this._pausedMaintenanceHandoff.index)) {
      this.log('paused waypoint arrival for another point ignored',
        `incoming=P${targetIndex}`, `expected=P${this._pausedMaintenanceHandoff.index}`);
      return false;
    }
    if (this._lockedReturnMaintenancePoint && this.isReturnCycleActive()
        && targetIndex !== this._lockedReturnMaintenancePoint.index) {
      this.log('maintenance arrival for wrong point ignored during return', `incoming=P${targetIndex}`, `expected=P${this._lockedReturnMaintenancePoint.index}`);
      return false;
    }
    const duplicateConfirmedArrival = this._manualMaintenanceReached === true
      && this._manualMaintenancePhase === 'reached'
      && this._manualMaintenanceTransit !== true
      && Number(this._manualMaintenanceTargetReachedIndex || 1) === targetIndex;
    if (duplicateConfirmedArrival) {
      this.log('duplicate native maintenance arrival kept original proof', `point=${targetIndex}`);
      return true;
    }
    const arrivalTime = Date.now();
    // A manually requested P2/P3 must not overwrite the P1 arrival authority.
    // In an active return the selected additional point *is* the return proof.
    const automaticReturnTarget = !!this._lockedReturnMaintenancePoint
      && Number(this._lockedReturnMaintenancePoint.index || 1) === targetIndex
      && this._returnContext !== RETURN_STATES.HOME_CONFIRMED;
    if (targetIndex === 1 || automaticReturnTarget) this._lastMaintenanceReachedAt = arrivalTime;
    if (targetIndex > 1) this._lastAdditionalMaintenanceReached = { index: targetIndex, at: arrivalTime };

    const arrivalToken = this._commandToken;
    const existingPoint = targetIndex === 1
      ? (typeof this.device._resolveStableMaintenancePoint === 'function' ? await this.device._resolveStableMaintenancePoint().catch(() => null) : null)
      : await Promise.resolve(this.device._resolveNativeMaintenancePoint?.(targetIndex)).catch(() => null);
    if (this.device?._nativeMaintenanceArrivalClosed || arrivalToken !== this._commandToken) return false;
    const reachedPos = confirmedPosition || this.pos();
    const reachedDistance = existingPoint && reachedPos ? this._distance(reachedPos, existingPoint) : null;
    // Independent geometric/stationary arrival can beat firmware code 75 and
    // mark _nativeMaintenanceArrivalCommitted first. Write the same display-
    // only icon on THIS path as well, otherwise P1 remains visually offset.
    if (targetIndex === 1 && existingPoint && reachedPos
        && reachedDistance !== null && reachedDistance <= 1200
        && ['mqtt','siid:1:4'].includes(String(reachedPos.source||''))
        && typeof this.device._recordConfirmedPrimaryVisualArrival === 'function') {
      await this.device._recordConfirmedPrimaryVisualArrival(reachedPos,existingPoint,
        `garage_${String(reason||'arrival')}`,
        Number(this.device._nativeMaintenanceCommandAt||0));
    }

    // Arrival is NOT permission to recalibrate an existing native target.
    // In particular, code 75 with a 350–700 mm normal stopping offset must
    // not silently shift the persisted primary marker. device.js owns the
    // separate high-confidence reanchor path: native 75 + proven travel +
    // independent stationary samples (or an explicit user map edit).
    // The garage completion callback only records arrival / first discovery.
    if (targetIndex > 1) {
      this.log(`additional maintenance point ${targetIndex} reached; primary point preserved`, reason);
    } else if (!existingPoint && reachedPos && typeof this.device._storeVerifiedMaintenancePoint === 'function') {
      await this.device._storeVerifiedMaintenancePoint(reachedPos, 'maintenance_arrival_initial_set').catch(() => null);
      this.log('initial maintenance marker learned from physical arrival',
        `${Math.round(reachedPos.x)},${Math.round(reachedPos.y)}`);
    } else if (existingPoint) {
      this.log(this._text(
        'Bestehende Wartungspunkt-Markierung beibehalten',
        'Existing maintenance marker preserved',
      ),
        `${Math.round(existingPoint.x)},${Math.round(existingPoint.y)}; arrivalDistance=${reachedDistance == null ? 'unknown' : `${Math.round(reachedDistance)}mm`}`);
    }

    this._manualMaintenanceCalibration = false;
    this._manualMaintenanceRecalibration = false;
    this._manualMaintenanceTransit = false;
    this._manualMaintenanceReached = true;
    if (this._maintenanceCommandAckUncertain
        && this._maintenanceCommandAckUncertain.token === this._commandToken
        && Number(this._maintenanceCommandAckUncertain.index) === targetIndex) {
      this.log('maintenance transport uncertainty resolved by verified native arrival', `P${targetIndex}`);
      this._maintenanceCommandAckUncertain = null;
    }
    this.device._nativeMaintenanceArrivalCommitted = true;
    this._manualMaintenanceTargetReachedIndex = targetIndex;
    this._manualMaintenancePhase = 'reached';
    this._manualMaintenancePhaseStartedAt = Date.now();
    this._manualMaintenanceMovementSeen = false;
    if (this._manualRecoveryActive && this._manualRecoveryPhase === 'maintenance_enroute'
        && Number(this._lockedReturnMaintenancePoint?.index || 1) === targetIndex) {
      this._manualRecoveryPhase = 'maintenance_reached';
      await this._rememberManualArrival(targetIndex);
    }
    this._manualMaintenanceLastPos = null;
    this._manualMaintenanceStableSince = 0;
    this.log('maintenance point reached', targetIndex > 1 ? `point_${targetIndex}:${reason}` : reason);
    this._trigger('garage_maintenance_point_reached', targetIndex > 1 ? `point_${targetIndex}_verified` : 'verified');
    await this.refreshTileStatus('maintenance point reached').catch(() => {});

    // Native arrival is confirmed *before* any handoff. A paused P1..P5
    // command gets a close owner only if automatic mode was re-enabled before
    // this matching arrival. Never infer the point from the primary/default.
    const handoff = this._pausedMaintenanceHandoff;
    if (handoff && Number(handoff.index) === targetIndex) {
      this._pausedMaintenanceHandoff = null; // consume once, even if blocked
      const nativeAt = Number(this.device?._nativeMaintenanceCommandAt || 0);
      const activeReturn = this._safeReturnInProgress || this._returnGuardActive
        || (this._returnContext && ![RETURN_STATES.IDLE, RETURN_STATES.HOME_CONFIRMED].includes(this._returnContext));
      const currentPoint = Number(this.device?._nativeMaintenanceTargetIndex);
      const canAdopt = this.enabled() && !this._manualGateStopped && !this._manualRecoveryActive
        && !this._emergencyGateContext && !activeReturn
        && handoff.token === this._commandToken && currentPoint === targetIndex
        && nativeAt === Number(handoff.nativeAt)
        && arrivalTime >= handoff.at && arrivalTime - handoff.at <= 10 * 60 * 1000;
      this.log('paused waypoint arrival handoff', `P${targetIndex}`,
        `adopted=${canAdopt}`, `automation=${this.enabled()}`, `return=${!!activeReturn}`,
        `token=${handoff.token}/${this._commandToken}`);
      if (canAdopt && !this._maintenanceArrivalClose) {
        this._maintenanceArrivalClose = {token:this._commandToken, index:targetIndex, createdAt:arrivalTime};
      }
    }
    const callback = this._maintenanceReachedCallback;
    this._maintenanceReachedCallback = null;
    this._maintenanceTimeoutCallback = null;
    if (callback) await callback();
    const close = this._maintenanceArrivalClose;
    this.log('maintenance arrival auto-close owner',
      `point=${targetIndex}`,`hasOwner=${!!close}`,
      `ownerToken=${close?.token ?? 'none'}`,`commandToken=${this._commandToken}`);
    if (close && close.token === this._commandToken && close.index === targetIndex && !close.position) {
      close.position = reachedPos ? { ...reachedPos } : null;
      await this._tryMaintenanceArrivalClose();
      this._scheduleMaintenanceArrivalCloseFollowup();
    }
    return true;
  }

  _scheduleMaintenanceArrivalCloseFollowup() {
    // Waypoint completion may arrive before the last firmware 'mowing' packet
    // has changed to IDLE. Without a timer, the safe close depends on a new
    // MQTT position event that a stationary A2 need not emit. Retry the GUARD
    // (not the gate command) for a bounded period. A return, STOP, new command,
    // stale position, actual mowing or danger remains an absolute veto.
    const pending=this._maintenanceArrivalClose;
    if (!pending || this._maintenanceArrivalCloseTimer) return;
    if (!Number(pending.createdAt)) pending.createdAt=Date.now();
    const elapsed=Date.now()-Number(pending.createdAt);
    if (elapsed >= 45000) {
      if (!pending.timeoutLogged) {
        pending.timeoutLogged = true;
        this.log('maintenance arrival auto-close not confirmed; gate remains unchanged',
          `point=${pending.index}`, 'reason=guard_timeout');
      }
      return;
    }
    this._maintenanceArrivalCloseTimer=setTimeout(async()=>{
      this._maintenanceArrivalCloseTimer=null;
      if (pending!==this._maintenanceArrivalClose || pending.token!==this._commandToken
          || this._manualGateStopped) return;
      try { await this._tryMaintenanceArrivalClose(); }
      catch(e) { this.error?.('maintenance arrival close followup failed',e.message); }
      if (pending===this._maintenanceArrivalClose && pending.token===this._commandToken)
        this._scheduleMaintenanceArrivalCloseFollowup();
    },2000);
    this._maintenanceArrivalCloseTimer?.unref?.();
  }

  async _tryMaintenanceArrivalClose() {
    const close = this._maintenanceArrivalClose;
    if (!close || !close.position || this._maintenanceArrivalCloseBusy) return false;
    const current = this.pos();
    const drift = this._distance(current, close.position);
    const activeReturn = this._safeReturnInProgress || this._returnGuardActive
      || (this._returnContext && ![RETURN_STATES.IDLE, RETURN_STATES.HOME_CONFIRMED].includes(this._returnContext));
    if (close.token !== this._commandToken || this._manualGateStopped || activeReturn
        || !this._maintenanceArrivalCloseAuthorized({ maintenanceArrivalVerified: true })
        || Number(this._manualMaintenanceTargetReachedIndex) !== close.index
        || (drift !== null && drift > MAINTENANCE_STATIONARY_DRIFT_MM)) {
      this._maintenanceArrivalClose = null;
      return false;
    }
    const age = Date.now() - Number(current?.ts || 0);
    const nativeStatus = String(this.device?._observedMowerStatus || this.status() || '').toLowerCase();
    if (['remote_control', 'error', 'returning'].includes(nativeStatus)) return false;
    if (!current?.ts || age < 0 || age > RETURN_OPEN_POSITION_MAX_AGE_MS
        || drift === null || Date.now() - Number(close.lastAttemptAt || 0) < 2000) return false;
    this._maintenanceArrivalCloseBusy = true;
    close.lastAttemptAt = Date.now();
    try {
      if (nativeStatus==='mowing') {
        // Firmware TASK 109 may leave a stale MOWING label after native code
        // 75/IDLE at P2. Require BOTH fresh native 2:1 IDLE and two stable
        // read-only 1:4 positions before treating this as a stopped waypoint.
        const did=this.device?.getData?.()?.id;
        const api=this.device?._api;
        if (!did || typeof api?.getProperties!=='function') return false;
        const read=await api.getProperties(did,[[2,1]],{timeout:1400}).catch(()=>null);
        const item=read?.code===0 ? read.data?.result?.find(x=>Number(x.siid)===2
          && Number(x.piid)===1 && (!x.code || Number(x.code)===0)) : null;
        if (Number(item?.value)!==2) return false;
        const observed=await this._readNativeStationaryPositionForGarage(close.token,close.position,150);
        if (!observed) return false;
        const updated=this.pos();
        if (updated?.ts && Number(updated.ts)>Number(current.ts)
            && this._distance(updated,observed)>150) return false;
        this.log('maintenance arrival: stale mowing status overridden by fresh native IDLE and stationary readback',
          `point=${close.index}`);
      }

      // A waypoint name/index never overrides actual gate clearance. In
      // particular, don't close on a debounced "outside" state alone.
      const raw = await this.markers.rawDangerState(current).catch(() => null);
      if (close !== this._maintenanceArrivalClose || close.token !== this._commandToken
          || this._manualGateStopped || this._safeReturnInProgress || this._returnGuardActive) return false;
      if (!raw?.known || !Number.isFinite(Number(raw.distance)) || !Number.isFinite(Number(raw.radius))
          || Number(raw.distance) <= Number(raw.radius) + RETURN_GATE_CLEARANCE_MM) return false;
      const accepted = await this.requestClose('maintenance_reached_close', { maintenanceArrivalVerified: true });
      this.log(this._text('Wartungspunkt: automatische Schließprüfung', 'Maintenance point: automatic close check'),
        `point=${close.index}; accepted=${!!accepted}`);
      if (accepted && this._maintenanceArrivalClose === close) this._maintenanceArrivalClose = null;
      return !!accepted;
    } finally { this._maintenanceArrivalCloseBusy = false; }
  }

  _clearManualMaintenanceStatusTimers() {
    if (Array.isArray(this._manualMaintenanceStatusTimers)) {
      for (const timer of this._manualMaintenanceStatusTimers) {
        try { clearTimeout(timer); } catch (_) {}
      }
    }
    this._manualMaintenanceStatusTimers = [];
  }

  _scheduleManualMaintenanceStatusTimers() {
    this._clearManualMaintenanceStatusTimers();
    const commandAt = Number(this._manualMaintenanceCommandAcceptedAt || 0);
    if (!this._manualMaintenanceTransit || !commandAt) return;
    const schedule = (atMs, fn) => {
      const delay = Math.max(0, commandAt + atMs - Date.now());
      const timer = setTimeout(async () => {
        if (!this._manualMaintenanceTransit || this._manualMaintenanceReached
            || Number(this._manualMaintenanceCommandAcceptedAt || 0) !== commandAt) return;
        try { await fn(); } catch (e) { this.error('manual maintenance phase timer', e.message); }
      }, delay);
      this._manualMaintenanceStatusTimers.push(timer);
    };
    schedule(OUTBOUND_EXITING_DISPLAY_MS, async () => {
      // After the fixed Ausfahrt display, enter Justieren unless physical
      // departure evidence already proved the phase complete. Safety-Line crossing
      // or four clean mowing observations may legitimately end Justieren early.
      await this._updateManualMaintenanceJourneyPhase();
      if (this._manualMaintenancePhase === 'transit') return;
      this._manualMaintenancePhase = 'adjusting';
      this._manualMaintenancePhaseStartedAt = commandAt + OUTBOUND_EXITING_DISPLAY_MS;
      const current = this.pos();
      if (current) this._manualMaintenancePhasePos = { ...current };
      await this.refreshTileStatus('manual maintenance adjusting timer').catch(() => {});
      this.log('manual maintenance status timer', 'Justieren');
    });
    schedule(OUTBOUND_EXITING_DISPLAY_MS + MAINTENANCE_ADJUSTING_MIN_MS, async () => {
      // At the end of the Justieren window, evaluate the same real transit
      // evidence. If it is still missing, Positionieren remains active without a
      // timeout escape until line crossing or four clean mowing samples arrive.
      await this._updateManualMaintenanceJourneyPhase();
      if (this._manualMaintenancePhase === 'positioning') {
        this.log('manual maintenance status timer', 'Positionieren – wartet auf bestätigte Weiterfahrt');
      }
    });
  }

  async _updateManualMaintenanceJourneyPhase() {
    if (!this._manualMaintenanceTransit || this._manualMaintenanceReached) return;
    const now = Date.now();
    const current = this.pos();
    const commandAt = Number(this._manualMaintenanceCommandAcceptedAt || this.device._nativeMaintenanceCommandAt || this._maintenanceRequestedAt || now);
    const elapsed = Math.max(0, now - commandAt);
    const exitDone = elapsed >= OUTBOUND_EXITING_DISPLAY_MS;
    const departureProven = !!(this._outbound?.departureLineConfirmed || this._outbound?.stableMowingConfirmed);

    // Ausfahrt is fixed. Once it has elapsed, either a physically confirmed
    // Garage→Lawn crossing or four clean MOWING observations can promote an
    // explicit maintenance trip directly to transit. Otherwise Justieren lasts
    // up to 45 s and then Positionieren remains until the same proof arrives.
    if (exitDone && departureProven) {
      if (this._manualMaintenancePhase !== 'transit') {
        this._manualMaintenancePhase = 'transit';
        this._manualMaintenancePhaseStartedAt = now;
        this._manualMaintenanceLastPos = current ? { ...current } : null;
        this._manualMaintenanceStableSince = 0;
        this._maintenanceStableHits = 0;
        this._clearManualMaintenanceStatusTimers();
        await this.refreshTileStatus('manual maintenance transit confirmed').catch(() => {});
        this.log(
          'manual maintenance transit confirmed',
          this._outbound?.departureLineConfirmed ? 'Safety-Line physically crossed' : 'four consecutive filtered native mowing statuses',
        );
      }
      return;
    }

    let expected = 'exiting';
    if (exitDone) {
      expected = elapsed >= OUTBOUND_EXITING_DISPLAY_MS + MAINTENANCE_ADJUSTING_MIN_MS
        ? 'positioning'
        : 'adjusting';
    }
    if (this._manualMaintenancePhase !== expected && this._manualMaintenancePhase !== 'transit') {
      this._manualMaintenancePhase = expected;
      this._manualMaintenancePhaseStartedAt = expected === 'adjusting'
        ? commandAt + OUTBOUND_EXITING_DISPLAY_MS
        : expected === 'positioning'
          ? commandAt + OUTBOUND_EXITING_DISPLAY_MS + MAINTENANCE_ADJUSTING_MIN_MS
          : commandAt;
      if (current) this._manualMaintenancePhasePos = { ...current };
      await this.refreshTileStatus(`manual maintenance ${expected} recovery`).catch(() => {});
    }
  }

  _maintenanceDepartureEvidence(startPos, current, commandAt, now = Date.now()) {
    if (!startPos || !current) return { fresh: false, moved: false, towardTarget: false, wrongWay: false, distanceMm: null, towardMm: null, positionTs: 0 };
    if (![startPos.x, startPos.y, current.x, current.y].every((v) => Number.isFinite(Number(v)))) {
      return { fresh: false, moved: false, towardTarget: false, wrongWay: false, distanceMm: null, towardMm: null, positionTs: 0 };
    }
    const positionTs = Number(current.ts || 0);
    const ageMs = positionTs > 0 ? now - positionTs : Number.POSITIVE_INFINITY;
    const postCommand = !commandAt || (positionTs > 0 && positionTs >= Number(commandAt) - 1000);
    const fresh = positionTs > 0 && ageMs >= 0 && ageMs <= POSITION_CACHE_MS && postCommand;
    const distanceMm = this._distance(startPos, current);
    const target = this._lockedReturnMaintenancePoint;
    let towardMm = null;
    if (target && [target.x, target.y].every((v) => Number.isFinite(Number(v)))) {
      const tx = Number(target.x) - Number(startPos.x);
      const ty = Number(target.y) - Number(startPos.y);
      const len = Math.hypot(tx, ty);
      if (len > 0) {
        const mx = Number(current.x) - Number(startPos.x);
        const my = Number(current.y) - Number(startPos.y);
        towardMm = (mx * tx + my * ty) / len;
      }
    }
    const movedEnough = fresh && Number.isFinite(Number(distanceMm)) && Number(distanceMm) >= MAINTENANCE_MOVEMENT_START_MM;
    const towardTarget = movedEnough && (towardMm == null || towardMm >= 100);
    const wrongWay = movedEnough && towardMm != null && towardMm <= -150;
    return { fresh, moved: towardTarget, towardTarget, wrongWay, distanceMm: Number.isFinite(Number(distanceMm)) ? Number(distanceMm) : null, towardMm, positionTs };
  }

  _manualRecoveryWaypointWatchAllowed() {
    return this._manualRecoveryActive === true && this._manualRecoveryPhase === 'maintenance_enroute';
  }

  _watchMaintenanceReached(callback, onTimeout = null, options = {}) {
    const token = this._commandToken;
    clearInterval(this._maintenanceWatch);
    this._maintenanceRequestedAt = Date.now();
    this._maintenanceReachedCallback = callback || null;
    this._maintenanceTimeoutCallback = onTimeout || null;
    const departureRequired = !!options.requireDepartureProof;
    const departureSource = String(options.source || 'maintenance');
    const departureRetryFn = typeof options.retryFn === 'function' ? options.retryFn : null;
    const departureFailureFn = typeof options.onDepartureFailure === 'function' ? options.onDepartureFailure : null;
    let departureCommandAt = Number(options.commandAt || this.device._nativeMaintenanceCommandAt || this._maintenanceRequestedAt || Date.now());
    let departureConfirmed = !departureRequired;
    let departureRetryUsed = false;
    let departureRetryAt = 0;
    let departureCandidateHits = 0;
    let departureCandidateFirstAt = 0;
    let departureLastPositionTs = 0;
    let departureFailureLatched = false;
    let maintenanceWatchBusy = false;
    // The existing MQTT handler can independently witness P1..P5 departure.
    // Do not wait for the next two-second interval after a valid pair arrives.
    this._maintenanceRealtimeDeparture = {token, commandAt:departureCommandAt,
      lastPositionTs:0, firstAt:0, hits:0, confirmed:false};

    // The live mower position is often unavailable while docked. Use an explicit
    // pre-command position when supplied; otherwise fall back to the best current
    // physical reference. The departure proof always stays separate from arrival.
    this._maintenanceStartPos = options.departureStartPos
      || this.pos()
      || this.device._dockPos
      || this.device._cachedMapData?.chargerPos
      || null;
    this._maintenanceStableHits = 0;
    this._maintenanceLastConfirmPositionTs = 0;

    const failDeparture = async (reason, detail = '') => {
      if (departureFailureLatched || token !== this._commandToken) return;
      departureFailureLatched = true;
      clearInterval(this._maintenanceWatch);
      this._maintenanceWatch = null;
      this._maintenanceRequestedAt = 0;
      this._maintenanceStartPos = null;
      this._maintenanceStableHits = 0;
      this._maintenanceLastConfirmPositionTs = 0;
      this._maintenanceReachedCallback = null;
      this._maintenanceTimeoutCallback = null;
      this._maintenanceDepartureConfirmedAt = 0;
      // Latch the failure: a late/stale paused packet must not resurrect the old
      // opcode-109 journey after the Safety Block has already taken ownership.
      this.device._nativeMaintenanceCommandAt = 0;
      this.device._pendingNativeMaintenanceArrival = null;
      this.device._nativeMaintenanceStableArrival = null;
      this.log('maintenance departure failed', reason, detail || departureSource);
      this._trigger('garage_position_uncertain', 'maintenance_departure_not_started');
      await this.refreshTileStatus('maintenance departure failed').catch(() => {});
      if (departureFailureFn) await departureFailureFn(reason);
      else await this.safetyBlock(reason);
    };

    this._maintenanceWatch = setInterval(async () => {
      if (maintenanceWatchBusy || departureFailureLatched) return;
      maintenanceWatchBusy = true;
      try {
      if (token !== this._commandToken) {
        clearInterval(this._maintenanceWatch);
        this._maintenanceWatch = null;
        this._maintenanceStartPos = null;
        this._maintenanceStableHits = 0;
        this._maintenanceLastConfirmPositionTs = 0;
        this.log('maintenance watch cancelled by newer command');
        return;
      }
      const now = Date.now();
      const current = this.pos();
      await this._updateManualMaintenanceJourneyPhase().catch(() => {});
      if (token !== this._commandToken || (this._manualGateStopped && !this._manualRecoveryWaypointWatchAllowed()) || !this._maintenanceRequestedAt) return;

      if (departureRequired && !departureConfirmed) {
        if (this._maintenanceDepartureConfirmedAt >= departureCommandAt
            && this._maintenanceRealtimeDeparture?.token === token
            && this._maintenanceRealtimeDeparture.confirmed === true) {
          departureConfirmed = true;
          this.log('maintenance departure watcher consumed live MQTT movement proof',
            `P${Number(this._lockedReturnMaintenancePoint?.index || 1)}`);
        }
        const evidence = this._maintenanceDepartureEvidence(this._maintenanceStartPos, current, departureCommandAt, now);
        if (!departureConfirmed && evidence.fresh && evidence.moved) {
          const independent = evidence.positionTs > departureLastPositionTs;
          if (independent) {
            departureLastPositionTs = evidence.positionTs;
            if (!departureCandidateHits) departureCandidateFirstAt = now;
            departureCandidateHits += 1;
          }
          if (departureCandidateHits >= MAINTENANCE_DEPARTURE_CONFIRM_HITS
              && now - departureCandidateFirstAt >= MAINTENANCE_DEPARTURE_CONFIRM_MIN_GAP_MS) {
            departureConfirmed = true;
            this._maintenanceDepartureConfirmedAt = now;
            this.log('maintenance departure confirmed', `distance=${Math.round(evidence.distanceMm)}mm`, `toward=${evidence.towardMm == null ? '?' : Math.round(evidence.towardMm)}mm`, departureSource);
          }
        } else if (!departureConfirmed && evidence.fresh) {
          departureCandidateHits = 0;
          departureCandidateFirstAt = 0;
          departureLastPositionTs = evidence.positionTs;
        }

        if (!departureConfirmed) {
          const sinceCommand = now - departureCommandAt;
          const wrongWayRecoveryDue = evidence.wrongWay && sinceCommand >= 8000;
          if (!departureRetryUsed && (sinceCommand >= MAINTENANCE_DEPARTURE_GRACE_MS || wrongWayRecoveryDue)) {
            // Never resend blindly while position telemetry is stale/missing. A
            // duplicate navigation command during unknown movement is less safe
            // than holding the mower. If the mower is physically moving AWAY
            // from the locked maintenance point (typically still following the
            // old dock task), stop it first and reassert opcode 109 once.
            if (evidence.fresh && departureRetryFn && departureCandidateHits === 0) {
              if (token !== this._commandToken || (this._manualGateStopped && !this._manualRecoveryWaypointWatchAllowed())) return;
              departureRetryUsed = true;
              departureRetryAt = now;
              this.log('maintenance departure retry', `after=${sinceCommand}ms`, `distance=${evidence.distanceMm == null ? '?' : Math.round(evidence.distanceMm)}mm`, `toward=${evidence.towardMm == null ? '?' : Math.round(evidence.towardMm)}mm`, evidence.wrongWay ? 'wrong_way_recovery' : 'no_departure');
              let retryAccepted = false;
              try {
                if (evidence.wrongWay) await this._prepareMowerForReturnPath('maintenance_wrong_way_recovery');
                retryAccepted = await departureRetryFn();
              }
              catch (e) { this.error('maintenance departure retry command', e.message); }
              if (retryAccepted === false) {
                await failDeparture('maintenance_departure_retry_rejected', departureSource);
                return;
              }
              departureCommandAt = Number(this.device._nativeMaintenanceCommandAt || departureCommandAt);
              departureCandidateHits = 0;
              departureCandidateFirstAt = 0;
              departureLastPositionTs = 0;
            } else if (sinceCommand >= MAINTENANCE_DEPARTURE_NO_TELEMETRY_MAX_MS) {
              await failDeparture('maintenance_departure_position_unconfirmed', departureSource);
              return;
            }
          } else if (departureRetryUsed && now - departureRetryAt >= MAINTENANCE_DEPARTURE_RETRY_GRACE_MS) {
            await failDeparture('maintenance_departure_not_started', departureSource);
            return;
          }
        }
      }

      if (departureConfirmed && typeof options.onVerifiedTransit === 'function') {
        try { await options.onVerifiedTransit(token); }
        catch (error) { this.log('verified maintenance transit observer failed', error?.message || String(error)); }
      }

      const reached = await this.isAtMaintenancePointHeuristic();
      if (token !== this._commandToken || (this._manualGateStopped && !this._manualRecoveryWaypointWatchAllowed())) return;
      if (reached) {
        await this.confirmNativeMaintenanceArrival('heuristic_verified_arrival', this.pos(), Number(this._lockedReturnMaintenancePoint?.index || this._manualMaintenanceTargetIndex || 1));
      } else if (this._maintenanceRequestedAt > 0 && now - this._maintenanceRequestedAt > MAINTENANCE_TIMEOUT_MS) {
        const elapsedMs = now - this._maintenanceRequestedAt;
        clearInterval(this._maintenanceWatch);
        this._maintenanceWatch = null;
        this._maintenanceRequestedAt = 0;
        this._maintenanceStartPos = null;
        this.device._nativeMaintenanceCommandAt = 0;
        this.device._pendingNativeMaintenanceArrival = null;
        this.device._nativeMaintenanceStableArrival = null;
        this._maintenanceStableHits = 0;
        this._maintenanceLastConfirmPositionTs = 0;
        this._manualMaintenanceCalibration = false;
        this._manualMaintenanceRecalibration = false;
        this._manualMaintenanceTransit = false;
        this._manualMaintenanceReached = false;
        this._manualMaintenanceLastPos = null;
        this._manualMaintenanceStableSince = 0;
        this._manualMaintenancePhase = 'idle';
        this._manualMaintenancePhaseStartedAt = 0;
        this._manualMaintenancePhasePos = null;
        this._manualMaintenanceMovementSeen = false;
        this._maintenanceReachedCallback = null;
        this._maintenanceTimeoutCallback = null;
        if (this._maintenanceCommandAckUncertain?.token === token) this._maintenanceCommandAckUncertain = null;
        await this.refreshTileStatus('maintenance point timeout').catch(() => {});
        this.log('maintenance point timeout', `status=${this.status()}`, `pos=${this.pos() ? `${Math.round(this.pos().x)},${Math.round(this.pos().y)}` : 'unknown'}`, `elapsed=${elapsedMs}ms`);
        this._trigger('garage_position_uncertain', 'maintenance_timeout');
        if (onTimeout) {
          await onTimeout();
        } else {
          this.safetyBlock('maintenance_point_timeout').catch(() => {});
        }
      }
      } finally {
        maintenanceWatchBusy = false;
      }
    }, 2000);
  }

  async onRealtimeMaintenancePosition(source = 'mqtt') {
    // MQTT can confirm the physical maintenance-point arrival faster than the
    // 2-second fallback watcher, but it must never weaken the proof. Only the
    // safety-critical return/emergency maintenance path is fed here; manual
    // calibration keeps its separate stationary/phase heuristic.
    if (source !== 'mqtt' || this._maintenanceRealtimeCheckBusy || !this._maintenanceRequestedAt) return false;
    const manualJourney = this._manualMaintenanceTransit === true;
    if (!manualJourney && (this._manualMaintenanceCalibration || this._manualMaintenanceRecalibration)) return false;
    if (!manualJourney && this._returnContext !== RETURN_STATES.MAINTENANCE && !this._safeReturnInProgress) return false;

    const current = this.pos();
    if (!current || !Number.isFinite(Number(current.ts))) return false;
    const positionTs = Number(current.ts);
    const commandAt = Number(this.device._nativeMaintenanceCommandAt || this._maintenanceRequestedAt || 0);
    if (commandAt > 0 && positionTs < commandAt) {
      this.debugLog('maintenance realtime sample ignored: pre-command position', `source=${source}`, `positionTs=${positionTs}`, `commandAt=${commandAt}`);
      return false;
    }

    this._maintenanceRealtimeCheckBusy = true;
    try {
      // Two distinct, post-command MQTT position frames with verified motion
      // TOWARD the locked point confirm transit. Never use a TASK ACK, position
      // cache refresh, status-only change, or a single frame to start OPEN.
      if (!manualJourney && this._safeReturnInProgress && this._returnGuardActive
          && this._returnContext === RETURN_STATES.MAINTENANCE
          && this._returnMaintenanceNavigationOwnerToken === this._commandToken
          && this._maintenanceRealtimeDeparture?.token === this._commandToken
          && !this._maintenanceRealtimeDeparture.confirmed
          && this._maintenanceRealtimeDeparture.commandAt === commandAt) {
        const movement = this._maintenanceDepartureEvidence(
          this._maintenanceStartPos, current, commandAt, Date.now());
        const proof = this._maintenanceRealtimeDeparture;
        if (movement.fresh && movement.moved && movement.positionTs > proof.lastPositionTs) {
          if (!proof.hits) proof.firstAt = Date.now();
          proof.lastPositionTs = movement.positionTs;
          proof.hits++;
          if (proof.hits >= MAINTENANCE_DEPARTURE_CONFIRM_HITS
              && Date.now() - proof.firstAt >= MAINTENANCE_DEPARTURE_CONFIRM_MIN_GAP_MS) {
            proof.confirmed = true;
            this._maintenanceDepartureConfirmedAt = Date.now();
            this.log('maintenance departure confirmed by live MQTT',
              `point=P${Number(this._lockedReturnMaintenancePoint?.index || 1)}`,
              `toward=${Math.round(movement.towardMm || 0)}mm`);
            // The physical safety/line/contact checks still own gate OPEN.
            await this._tryMaintenanceTransitEarlyOpen(this._commandToken);
          }
        } else if (movement.fresh && movement.positionTs > proof.lastPositionTs) {
          proof.hits = 0;
          proof.firstAt = 0;
          proof.lastPositionTs = movement.positionTs;
        }
      }
      const target = this._lockedReturnMaintenancePoint
        || (typeof this.device._resolveStableMaintenancePoint === 'function'
          ? await this.device._resolveStableMaintenancePoint().catch(() => null)
          : await safeGetStoreValue(this.device, 'garage_maintenance_point'));
      const distance = target ? this._distance(current, target) : null;
      const beforeHits = Number(this._maintenanceStableHits || 0);
      const beforeTs = Number(this._maintenanceLastConfirmPositionTs || 0);
      const reached = await this.isAtMaintenancePointHeuristic();
      const afterHits = Number(this._maintenanceStableHits || 0);
      const accepted = Number(this._maintenanceLastConfirmPositionTs || 0) > beforeTs;

      if (accepted || reached) {
        this.debugLog('maintenance realtime verification',
          `source=${source}`,
          `position=${Math.round(current.x)},${Math.round(current.y)}`,
          `positionTs=${positionTs}`,
          `distance=${distance == null ? 'unknown' : `${Math.round(distance)}mm`}`,
          `status=${this.status()}`,
          `confirmations=${afterHits}/3`,
          `accepted=${accepted}`,
          `reached=${reached}`);
      } else if (beforeHits !== afterHits) {
        this.debugLog('maintenance realtime verification reset',
          `source=${source}`, `distance=${distance == null ? 'unknown' : `${Math.round(distance)}mm`}`, `status=${this.status()}`);
      }

      if (reached) {
        await this.confirmNativeMaintenanceArrival('mqtt_live_position_verified_arrival', current, Number(this._lockedReturnMaintenancePoint?.index || this._manualMaintenanceTargetIndex || 1));
        return true;
      }
      return false;
    } finally {
      this._maintenanceRealtimeCheckBusy = false;
    }
  }

  _maintenanceMovedEnough() {
    const start = this._maintenanceStartPos;
    const now = this.pos();
    if (!start || !now) return false;
    const dx = Number(now.x) - Number(start.x);
    const dy = Number(now.y) - Number(start.y);
    return Number.isFinite(dx) && Number.isFinite(dy) && (dx * dx + dy * dy) >= (500 * 500);
  }

  async isAtMaintenancePointHeuristic() {
    // Maintenance arrival is a physical safety proof. It is accepted only from a
    // fresh mower position close to the immutable point locked at return start,
    // plus several stopped-state samples. Time, status or travelled distance alone
    // can never open the gate.
    if (!this._maintenanceRequestedAt) return false;
    const inReturnContext = this._returnContext === RETURN_STATES.MAINTENANCE
      || this._returnContext === RETURN_STATES.GARAGE_OPEN
      || this._safeReturnInProgress;
    const explicitManual = this._manualMaintenanceTransit
      || this._manualMaintenanceCalibration
      || this._manualMaintenanceRecalibration
      || String(this.lastRequestedAction || '').toLowerCase().includes('maintenance');
    if (!inReturnContext && !explicitManual) {
      this._maintenanceStableHits = 0;
      return false;
    }

    // Explicit manual maintenance journey: after Ausfahrt the A2 spends a
    // visible adjustment phase. Arrival is accepted only after that phase has
    // progressed to transit, the mower has moved, and it then remains stationary
    // at the known native point (or establishes the first point when none exists).
    if (this._manualMaintenanceCalibration || this._manualMaintenanceRecalibration || this._manualMaintenanceTransit) {
      // Additional destinations are completed by the selected native opcode's
      // status-75 evidence in device.js. The primary marker must never be used as
      // an arrival test for another index.
      if (Number(this._manualMaintenanceTargetIndex || 1) > 1) {
        this._maintenanceStableHits = 0;
        this._manualMaintenanceStableSince = 0;
        return false;
      }
      await this._updateManualMaintenanceJourneyPhase().catch(() => {});
      const current = this.pos();
      if (!current || this._manualMaintenancePhase !== 'transit') {
        this._maintenanceStableHits = 0;
        this._manualMaintenanceStableSince = 0;
        return false;
      }
      const ageMs = Number.isFinite(Number(current.ts)) ? Date.now() - Number(current.ts) : 0;
      const s = this.status();
      const last = this._manualMaintenanceLastPos;
      const drift = last ? this._distance(current, last) : null;
      this._manualMaintenanceLastPos = { ...current };
      const telemetryFresh = ageMs <= POSITION_CACHE_MS;
      // The manual stationary fallback must not mistake an ordinary brief
      // stop *while mowing* near P1 for a finished 109 journey. The firmware
      // code-75 path in device.js may confirm immediately; without that proof,
      // require the mower's own idle/paused state as well as stable geometry.
      const statusAllowed = ['idle', 'paused', 'standby'].includes(s);
      const stationary = drift != null && drift <= MAINTENANCE_STATIONARY_DRIFT_MM;
      const targetIndex = Math.max(1, Math.min(5, Math.trunc(Number(this._manualMaintenanceTargetIndex || 1))));
      const target = targetIndex === 1
        ? (typeof this.device._resolveStableMaintenancePoint === 'function' ? await this.device._resolveStableMaintenancePoint().catch(() => null) : await safeGetStoreValue(this.device, 'garage_maintenance_point'))
        : await Promise.resolve(this.device._resolveNativeMaintenancePoint?.(targetIndex)).catch(() => null);
      const distanceToTarget = target ? this._distance(current, target) : null;
      const plausibleTarget = !target
        || (Number.isFinite(Number(distanceToTarget)) && Number(distanceToTarget) <= MAINTENANCE_AUTO_REALIGN_RADIUS_MM);

      if (!telemetryFresh || !statusAllowed || !stationary || !plausibleTarget) {
        this._maintenanceStableHits = 0;
        this._manualMaintenanceStableSince = 0;
        return false;
      }
      if (!this._manualMaintenanceStableSince) this._manualMaintenanceStableSince = Date.now();
      this._maintenanceStableHits = Number(this._maintenanceStableHits || 0) + 1;
      const stableForMs = Date.now() - this._manualMaintenanceStableSince;
      return this._maintenanceStableHits >= 3 && stableForMs >= MAINTENANCE_STATIONARY_REQUIRED_MS;
    }

    const target = this._lockedReturnMaintenancePoint
      || (typeof this.device._resolveNativeMaintenancePoint === 'function'
        ? await Promise.resolve(this.device._resolveNativeMaintenancePoint(this.device._maintenancePointIndex())).catch(() => null)
        : await safeGetStoreValue(this.device, 'garage_maintenance_point'));
    const current = this.pos();

    // First-install/update fallback: the native opcode knows its internal target
    // even when Homey has no visible coordinate yet. After a recent accepted
    // maintenance command, a fresh, stable paused/idle/standby position is enough
    // to establish the initial Homey marker. This is deliberately limited to an
    // active maintenance/return context and several independent samples.
    if (!target && current) {
      const commandAt = Number(this.device._nativeMaintenanceCommandAt || 0);
      const commandAge = commandAt ? Date.now() - commandAt : Number.POSITIVE_INFINITY;
      const status = this.status();
      const eligible = commandAge >= 5000 && commandAge <= 3 * 60 * 1000
        && ['paused', 'idle', 'standby'].includes(status);
      const ageMs = Number.isFinite(Number(current.ts)) ? Date.now() - Number(current.ts) : 0;
      const last = this._manualMaintenanceLastPos;
      const drift = last ? this._distance(current, last) : null;
      this._manualMaintenanceLastPos = { ...current };
      if (eligible && ageMs <= POSITION_CACHE_MS && drift != null && drift <= 250) {
        if (!this._manualMaintenanceStableSince) this._manualMaintenanceStableSince = Date.now();
        this._maintenanceStableHits = Number(this._maintenanceStableHits || 0) + 1;
        if (this._maintenanceStableHits >= 3 && Date.now() - this._manualMaintenanceStableSince >= 4000) return true;
      } else {
        this._maintenanceStableHits = 0;
        this._manualMaintenanceStableSince = 0;
      }
      return false;
    }
    if (!target || !current) {
      this._maintenanceStableHits = 0;
      return false;
    }
    const ageMs = Number.isFinite(Number(current.ts)) ? Date.now() - Number(current.ts) : 0;
    if (ageMs > POSITION_CACHE_MS) {
      this._maintenanceStableHits = 0;
      this.log('maintenance confirmation waits for fresh position', `age=${ageMs}ms`);
      return false;
    }
    const distance = this._distance(current, target);
    if (distance == null || distance > MAINTENANCE_CONFIRM_RADIUS_MM) {
      this._maintenanceStableHits = 0;
      return false;
    }

    const s = this.status();
    if (!['paused', 'idle', 'standby'].includes(s)) {
      this._maintenanceStableHits = 0;
      this._maintenanceLastConfirmPositionTs = 0;
      return false;
    }

    // Return-maintenance arrival must be proven by independent telemetry updates.
    // The watcher runs every two seconds, while the cloud may expose the same
    // cached coordinate for several cycles. Counting that one coordinate three
    // times can falsely report "maintenance point reached" even though the A2
    // is still following its native return path. Require a new post-command
    // position timestamp for every confirmation hit.
    const positionTs = Number(current.ts || 0);
    const commandAt = Number(this.device._nativeMaintenanceCommandAt || this._maintenanceRequestedAt || 0);
    if (!Number.isFinite(positionTs) || positionTs <= 0
        || (commandAt > 0 && positionTs < commandAt)
        || positionTs <= Number(this._maintenanceLastConfirmPositionTs || 0)) {
      return false;
    }
    this._maintenanceLastConfirmPositionTs = positionTs;
    this._maintenanceStableHits = Number(this._maintenanceStableHits || 0) + 1;
    return this._maintenanceStableHits >= 3;
  }

  async isInDangerArea() {
    return this.markers.isInDangerArea();
  }

  async updatePositionGuards() {
    if (!this.enabled()) return;
    this._recordPositionForDerivedSpeed();
    this._observeReturnStartupPosition();
    await this._tryMaintenanceArrivalClose();

    // 02-Nov field: after IN_STATION + charge, native/cloud RETURNING could
    // linger >45s. The old guard tested only a cloud charging status, then
    // tried a new closed-gate detour/PAUSE/STOP after the gate was CLOSED.
    // Confirmed physical station owns the cycle until an ACTUAL undock edge.
    if (!this._emergencyHoldActive() && this._confirmedStationLockActive() && !this._outbound) {
      this._frontGateReturnSamples = [];
      this._gateMotionDangerHits = 0;
      if (this._homeState !== 'home') await this._enterDockedIdle('confirmed native station position guard');
      return;
    }
    // In the station the garage safety cycle is idle. Do not log danger-area
    // changes or fire emergency logic until a new start/return cycle begins.
    if (!this._emergencyHoldActive()
        && this.isDockedHomeStatus() && !this._outbound && !this._safeReturnInProgress && !this._returnGuardActive) {
      if (this._homeState !== 'home') await this._enterDockedIdle('docked position guard');
      return;
    }

    const danger = await this.markers.dangerState();
    await this._maybeReleaseResumeGuard(this.status(), danger).catch(() => {});
    const inside = danger.inside;
    if (inside) this._dangerOutsideSince = 0;
    else if (!this._dangerOutsideSince) this._dangerOutsideSince = Date.now();
    if (inside !== this._lastDangerInside) {
      this._lastDangerInside = inside;
      // During normal mowing the mower may legally cross the configured garage
      // danger circle. The state is still evaluated for close/open guards, but we
      // avoid noisy user-facing events unless a door is moving or a return/outbound
      // garage phase is active.
      const doorMoving = this.doorState() === 'opening' || this.doorState() === 'closing';
      const userRelevant = doorMoving || this._outbound || this._safeReturnInProgress || this.isReturning() || !this.isMowing();
      if (userRelevant) {
        this._trigger(inside ? 'garage_danger_area_entered' : 'garage_danger_area_left', inside ? 'inside' : 'outside', {
          distance: danger.distance === null ? '' : String(Math.round(danger.distance)),
          radius: String(danger.radius),
        });
        this.log('danger area', inside ? 'inside' : 'outside', 'distance=', danger.distance === null ? '-' : Math.round(danger.distance), 'radius=', danger.radius);
      }
      // Hybrid fallback: the native mowing route may legally pass beside the
      // configured safety segment and never cross it. In that case, after the
      // complete Ausfahrt/Justieren/Positionieren phase and five stable seconds
      // outside the danger area, promote the exit once. This is deliberately
      // state based and never reacts to one jumping position sample.
      if (!inside && this._outbound && !this._lineToLawnConfirmed && !this.isReturning()) {
        this.log('danger-area exit observed; waiting stable fallback window', `${DANGER_EXIT_FALLBACK_CLOSE_MS}ms`);
      }
    }

    if (inside) this._dangerExitFallbackStarted = false;

    const doorNow = this.doorState();
    // An existing MAINTENANCE owner can be superseded by a native-app DOCK.
    // While the gate is CLOSED, a fresh physical position near it must stop
    // that movement regardless of stale maintenance bookkeeping. Do not use
    // LOCN/GPS history points here and do not infer permission to open the gate.
    if (doorNow === 'closed' && this.isReturnCycleActive()
        && this._returnContext === RETURN_STATES.MAINTENANCE
        && String(this.status() || '').toLowerCase() === 'returning'
        && !this._maintenanceJourneyOwnsNavigation()) {
      const p=this.pos();
      const age=Date.now()-Number(p?.ts||0);
      if (p && ['mqtt','siid:1:4'].includes(String(p.source||''))
          && age>=0 && age<5000) {
        const raw=await this.markers.rawDangerState(p).catch(()=>null);
        const distance=Number(raw?.distance), radius=Number(raw?.radius);
        if (raw?.known && Number.isFinite(distance) && Number.isFinite(radius)
            && distance<=radius+RETURN_PRELINE_STOP_MM+300) {
          this.log('[return-gate-guard] native RETURNING approached closed gate under stale maintenance owner',
            `distance=${Math.round(distance)}mm`, `radius=${Math.round(radius)}mm`);
          // Use the existing guarded CLOSED-gate detour. It pauses, proves
          // standstill, commands one native P1 trip and opens the gate ONLY
          // after fresh stationary P1 arrival. This is the same recovery that
          // succeeded with a manual Homey DOCK at 14:06 in the field test.
          const recovered=await this._routeClosedGateReturnViaMaintenance(
            'closed_gate_native_return_owner_mismatch');
          if (!recovered) {
            // If detour preconditions cannot be proved, fail stationary. Never
            // allow a blind DOCK or OPEN near an occupied closed doorway.
            await this._pauseMowerForGateInterlock('return',
              'closed_gate_native_return_recovery_unconfirmed');
            await this.safetyWarning('closed_gate_native_return_requires_manual_clearance');
          }
          return;
        }
      }
    }
    if (await this._detectClosedGateFrontReturn(danger).catch((e) => { this.error('closed gate front-zone detector', e.message); return false; })) return;
    const garageDoorMoving = doorNow === 'opening' || doorNow === 'closing';

    // Normal map/timeline behaviour keeps the debounced danger state above, but
    // a physically moving gate is different: the danger circle becomes a hard
    // exclusion zone immediately. Use the raw geometric state so the first fresh
    // post-motion position inside can stop the mower and reverse the gate.
    const rawDanger = typeof this.markers.rawDangerState === 'function'
      ? await this.markers.rawDangerState().catch(() => danger)
      : danger;
    this._trackRawDangerExit(rawDanger);
    const movingGateDanger = garageDoorMoving ? rawDanger : danger;
    const movingGateInside = !!movingGateDanger?.inside;

    // Return pre-entry protection is handled below from the real configured
    // caution radius and the safety-line distance. A stationary gate still uses
    // the normal debounced state; only physical gate motion activates this hard
    // one-sample interlock.
    if (garageDoorMoving && movingGateInside) {
      const moving = doorNow;
      const confirmedDanger = this._confirmMovingGateDanger(moving, movingGateInside);

      if (moving === 'closing') {
        if (this._isSafeHomeClosingContext()) {
          // Expected final close with the mower safely docked/home.
          this._gateMotionDangerHits = 0;
        } else if (confirmedDanger) {
          // Hard rule: closing gate + fresh confirmed mower in danger area always
          // means pause + reverse to open, regardless of outbound locks.
          await this._pauseMowerForGateInterlock(this.isReturning() ? 'return' : 'mowing', 'closing_gate_danger');
          this.log('EMERGENCY: mower in danger area while gate is closing');
          await this._handleMovingDoorDangerEmergency('closing', 'moving_gate_danger_area');
          return;
        }
      } else if (moving === 'opening') {
        // If a closing-gate emergency deliberately reversed the gate to OPEN so
        // the mower can evacuate, that opening is part of the recovery itself.
        // Never let the generic opening-entry rule reverse it back to CLOSED;
        // doing so creates the unsafe close/open/close oscillation seen in the
        // field. The lock ends when the maintenance recovery context is cleared.
        if (this._emergencyOpeningRecoveryLockActive()) {
          this._gateMotionDangerHits = 0;
          if (!this._movingGateStartWarningShown) {
            this._movingGateStartWarningShown = true;
            this.log('opening gate danger occupancy accepted: emergency evacuation opening lock active');
          }
        } else {
          // Distinguish OCCUPANCY from ENTRY. A mower may legitimately already be
          // stationary in/near the doorway while the garage opens for a start, or
          // wait at the verified maintenance point during a return. Reversing the
          // opening gate to CLOSE in those states creates an unsafe oscillation.
          const expectedOccupancy = await this._expectedOpeningDangerOccupancy();
          if (expectedOccupancy) {
            this._gateMotionDangerHits = 0;
            if (!this._movingGateStartWarningShown) {
              this._movingGateStartWarningShown = true;
              this.log('opening gate danger occupancy accepted: mower is in an intentional stationary release context');
            }
          } else if (confirmedDanger) {
            if (!this._movingGateStartWarningShown) {
              this._movingGateStartWarningShown = true;
              this.log('EMERGENCY confirmed: mower entered danger area while gate is opening -> reverse closed and evacuate');
            }
            await this._handleOpeningGateDangerEvacuation(this.isReturning() ? 'return' : (this._outbound ? 'outbound' : 'mowing'));
            return;
          }
        }
      }
    } else {
      this._gateMotionDangerHits = 0;
      this._gateMotionDangerState = null;
      this._gateMotionDangerFirstAt = 0;
      this._gateMotionDangerLastPositionTs = 0;
    }

    // A late return at a STATIONARY closed gate is recoverable and must not be
    // reported as an Emergency. Hold the mower and reroute via the immutable
    // maintenance point. Emergency is reserved for a MOVING gate while the mower
    // occupies the danger area. The gate remains stationary until verified
    // maintenance clearance exists.
    if (doorNow === 'closed' && inside && (this.isReturning() || this._safeReturnInProgress || this._returnGuardActive)) {
      if (this._maintenanceJourneyOwnsNavigation()) {
        // This is a REAL danger-circle incursion, not merely an A-B caution
        // band. Fail closed and stop once; never issue a second 109, DOCK or
        // gate OPEN on the basis of a native RETURNING frame during navigation.
        if (this._hasFreshSafetyPosition(5000, false)) {
          await this._pauseMowerForGateInterlock('return', 'maintenance_inside_closed_gate_danger');
          await this.safetyWarning('maintenance_closed_gate_danger_stop');
        }
      } else {
        await this._routeClosedGateReturnViaMaintenance('closed_gate_return_danger');
      }
      return;
    }

    const line = await this.markers.lineState();

    // A--B is a FINITE segment. When the mower approaches the closed gate
    // outside its projection (observed t=-1.23, side=null), waiting for an
    // on-segment crossing can never provide the promised last-resort stop.
    // Use independently fresh dock/danger geometry during an ACTUAL return;
    // normal mowing/parked maintenance must never trigger this recovery.
    const now = Date.now();
    const dockPos = this.device._dockPos || this.device._cachedMapData?.chargerPos || null;
    const dockDistance = this._distance(this.pos(), dockPos);
    const rawRadius = Number(rawDanger?.radius);
    const rawDistance = Number(rawDanger?.distance);
    const offSegmentNearClosedGate = doorNow === 'closed' && !!this._missionOutside
      && this.isReturnCycleActive() && this._returnContext !== RETURN_STATES.MAINTENANCE
      && !this._maintenanceJourneyOwnsNavigation()
      && !this._emergencyGateContext && !this._awaitingLineDoorOpen
      && !line?.onSegment && this._hasFreshSafetyPosition(5000, false)
      && !!rawDanger?.known && Number.isFinite(rawRadius) && Number.isFinite(rawDistance)
      && rawDistance <= rawRadius + 2500
      && dockDistance !== null && dockDistance <= RETURN_DIRECT_MIN_DOCK_DISTANCE_MM;
    if (offSegmentNearClosedGate
        && (!this._offSegmentReturnRecoveryAt || now - this._offSegmentReturnRecoveryAt > 120000)) {
      this._offSegmentReturnRecoveryAt = now;
      this.log('return off-segment closed-gate controlled detour',
        `dockDistance=${Math.round(dockDistance)}mm; dangerDistance=${Math.round(rawDistance)}mm; lineT=${line?.t ?? '?'}; side=${line?.side ?? 'null'}`);
      await this.safetyWarning('return_off_segment_closed_gate_maintenance_detour');
      await this._routeClosedGateReturnViaMaintenance('closed_gate_off_segment_return');
      return;
    }

    // During a confirmed return, the mower must stop before the configured
    // yellow caution area / safety line whenever the door is not yet stably open.
    // Normal mowing is deliberately excluded: with a stationary closed door it
    // may pass the garage area without triggering any gate action.
    const returnActive = this.isReturnCycleActive();
    const direction = line?.direction || {};
    const lawnSide = direction.lawnSide ?? this._lawnLineSide;
    const geometricSide = line?.onSegment && Number.isFinite(Number(line.distance)) && Number(line.distance) !== 0
      ? (Number(line.distance) > 0 ? 1 : -1) : null;
    const returnObservedSide = line?.side ?? line?.rawSide ?? geometricSide;
    const onLawnSide = lawnSide !== null && returnObservedSide === lawnSide;
    const cautionRadius = Number(this._garageOption('garage_caution_radius_mm') || 0);
    const inConfiguredCaution = Number.isFinite(cautionRadius) && cautionRadius > 0
      && danger.distance !== null && Number(danger.distance) <= cautionRadius;
    const nearSafetyLine = !!line?.onSegment && Number.isFinite(Number(line.distance))
      && Math.abs(Number(line.distance)) <= RETURN_PRELINE_STOP_MM;
    // Independent final brake for an anomalous native maintenance RETURN that
    // heads to the gate BEFORE reaching its selected point. Normal maintenance
    // trips do not get a generic A-B PAUSE: they retain navigation ownership.
    // A verified return taking the wrong path, however, must stop before A-B.
    if (returnActive && this._returnContext === RETURN_STATES.MAINTENANCE
        && this._maintenanceJourneyOwnsNavigation() && onLawnSide
        && Number(this._maintenanceRequestedAt || 0) > 0
        && Number(this._maintenanceDepartureConfirmedAt || 0) >= Number(this._maintenanceRequestedAt || 0)
        && nearSafetyLine && !this._doorOpenReleaseVerified()
        && this._maintenancePrelineHoldToken !== this._commandToken) {
      this._maintenancePrelineHoldToken = this._commandToken;
      this.log('EMERGENCY maintenance return approach to closed safety line: one-way PAUSE',
        `distance=${Math.round(Math.abs(Number(line.distance)))}mm`);
      const stopped = await this._pauseMowerForGateInterlock('return', 'maintenance_wrong_way_preline');
      if (!stopped) {
        const did = this.device.getData().id;
        const stopAccepted = await this.device._safeWrite('garage_maintenance_wrong_way_preline_stop',
          () => this.device._api.stopMowing(did)).catch(() => false);
        this.log('maintenance wrong-way preline STOP backup', stopAccepted === false ? 'not_confirmed' : 'requested');
      }
      await this.safetyWarning('maintenance_wrong_way_preline_manual_verification_required');
      // Neither an accepted PAUSE nor STOP is physical motion proof. Keep
      // maintenance/dock release blocked pending native stationary evidence.
      return;
    }
    // Hard pre-entry hold for EVERY active return. Previously this guard only
    // applied when a direct-dock callback was armed. If a maintenance detour was
    // rejected/overridden by firmware, the mower could therefore approach and
    // cross the safety line with a closed gate. The A-B line is a physical safety
    // barrier and must not depend on which return route currently owns the state.
    if (returnActive && this._returnContext !== RETURN_STATES.MAINTENANCE
        && !this._maintenanceJourneyOwnsNavigation()
        && onLawnSide && !this._doorOpenReleaseVerified()
        && (inConfiguredCaution || nearSafetyLine) && !this._awaitingLineDoorOpen
        && this._returnLineWaitTerminalToken !== this._commandToken) {
      const reason = inConfiguredCaution ? 'configured_caution_zone' : 'pre_safety_line';
      this.log('return pre-entry hold', reason,
        `dangerDistance=${danger.distance == null ? '?' : Math.round(danger.distance)}mm`,
        `lineDistance=${line.distance == null ? '?' : Math.round(Math.abs(line.distance))}mm`);
      const token = this._pendingDirectReturnToken || this._commandToken;
      const sourceName = this._pendingDirectReturnSource || `return_${reason}`;
      // A transient native RETURNING can reach the A-B watchdog BEFORE the
      // external-return strategy has selected direct vs P1. Never claim a
      // direct gate/DOCK owner from that status alone (18-Oct field failure).
      // Route through the same central selector while the gate is still closed.
      // _returnGuardActive/_safeReturnInProgress mean only that a return is
      // being processed, NOT that a direct route has been selected. The latter
      // requires an explicit direct-DOCK owner plus its committed context.
      const selectedRoute = this._returnContext === RETURN_STATES.DOCK
        && typeof this._pendingDirectDockFn === 'function';
      if (!selectedRoute) {
        if (this._externalReturnHandling || this._spatialReturnHandling) {
          this.log('pre-line waiting for active return route decision; gate remains closed');
          return;
        }
        const observed = String(this.device?._observedMowerStatus || '').toLowerCase();
        const at = Number(this.device?._observedMowerStatusAt || 0);
        if (observed !== 'returning' || !at || Date.now()-at > 6000) {
          this.log('pre-line has no fresh native return intent; gate stays closed');
          return;
        }
        if (this._prelineDecisionPauseToken !== token) {
          this._prelineDecisionPauseToken = token;
          const did = this.device.getData().id;
          const paused = await this.device._safeWrite('garage_preline_route_selection_pause',
            () => token === this._commandToken ? this.device._api.pause(did) : false).catch(() => false);
          if (paused === false) {
            await this.returnOperationalHold('return_preline_pause_unconfirmed');
            return;
          }
        }
        this.log('pre-line routing via return strategy before door movement', sourceName);
        await this._interceptExternalReturn('status_returning_preline', 'returning');
        return;
      }
      await this._learnReturnEtaFromPreEntry(line, token);
      const dockAgain = this._pendingDirectDockFn || (async () => {
        const did = this.device.getData().id;
        const accepted = await this.device._safeWrite('garage_return_preline_release_dock', () => this.device._api.dock(did));
        if (accepted === false) return false;
        await this.device._applyStatus('returning', 0, false);
        return true;
      });
      await this._waitAtSafetyLineUntilDoorOpenThenDock(dockAgain, token, sourceName);
      return;
    }

    if (await this._detectSpatialExternalReturn(danger, line)) return;
    // No point-mode/A=B fallback is allowed for a door-closing safety decision.
    // Invalid/too-short lines must be re-set by the user.
    const side = line.side ?? line.rawSide;

    // Calibrate the garage side as soon as the mower is stably on one side of
    // the line during an outbound cycle. This avoids a manual "direction" setting:
    // the side seen before leaving is garage, the opposite side is lawn.
    if (this._outbound && this._outbound.lineInitialSide === null && side !== null && line.stable && line.onSegment) {
      if (this._outbound.lineArmCandidate === side) this._outbound.lineArmHits = (this._outbound.lineArmHits || 0) + 1;
      else { this._outbound.lineArmCandidate = side; this._outbound.lineArmHits = 1; }
      if (this._outbound.lineArmHits >= SAFETY_LINE_ARM_SAMPLES) {
        this._outbound.lineInitialSide = side;
        this._garageLineSide = side;
        this._lawnLineSide = -side;
        this._outbound.lineLawnSide = -side;
        this._outbound.lineArmedAt = Date.now();
        this.log('safety line armed from stable live positions fallback', 'garageSide=', side, 'lawnSide=', -side, `samples=${this._outbound.lineArmHits}`);
      }
    }

    const observedSide = line.stable ? line.side : null;
    const previousObservedSide = this._lastLineSide ?? null;
    const nearConfiguredSegment = !!line.onSegment;
    const lineUsableForOutbound = nearConfiguredSegment;
    const lineArmed = !!(this._outbound && this._outbound.lineInitialSide !== null && this._outbound.lineArmedAt);
    const crossingClearanceMm = Math.abs(Number(line.distance) || 0);
    const crossingThresholdMm = Math.max(SAFETY_LINE_CROSS_CONFIRM_MM, Number(line.hysteresis || 0));
    const sideChanged = lineUsableForOutbound && observedSide !== null && previousObservedSide !== null && observedSide !== previousObservedSide;
    const shallowSideChange = !!(this._outbound && sideChanged && crossingClearanceMm < crossingThresholdMm);
    let crossedLine = sideChanged && !shallowSideChange;
    const inferredFirstLawnHit = false;
    if (shallowSideChange) {
      this.log('safety line side change pending physical clearance', `distance=${Math.round(crossingClearanceMm)}mm required=${Math.round(crossingThresholdMm)}mm`);
    }

    if (this._outbound && this._lineState === LINE_STATES.IDLE && lineUsableForOutbound && observedSide !== null) {
      this._setLineState(LINE_STATES.PENDING, 'outbound_line_observed');
    }

    // RC80: track a continuous, stable stay on the lawn side. This is a
    // conservative fallback for routes that cross the line but do not build the
    // configured 800 mm clearance because the native mower immediately turns
    // parallel to the line. Unknown samples never reset the timer; a confirmed
    // garage-side sample does.
    if (this._outbound && lineUsableForOutbound) {
      const expectedLawnSide = this._outbound.lineLawnSide ?? this._lawnLineSide;
      if (expectedLawnSide !== null && observedSide === expectedLawnSide && line.stable) {
        this._outbound.lawnSideStableHits = Number(this._outbound.lawnSideStableHits || 0) + 1;
        if (!this._outbound.lawnSideSince) this._outbound.lawnSideSince = Date.now();
      } else if (observedSide !== null && expectedLawnSide !== null && observedSide !== expectedLawnSide) {
        if (this._outbound.lawnSideSince) {
          const elapsed = Date.now() - this._outbound.lawnSideSince;
          if (elapsed < SAFETY_LINE_DWELL_FALLBACK_MS) {
            this._outbound.failedLineDwells = Number(this._outbound.failedLineDwells || 0) + 1;
            this.log('lawn-side dwell attempt reset by confirmed return', `elapsed=${elapsed}ms failed=${this._outbound.failedLineDwells}`);
          }
        }
        this._outbound.lawnSideSince = 0;
        this._outbound.lawnSideStableHits = 0;
      }
    }

    if (crossedLine) {
      const direction = `${previousObservedSide}->${observedSide}`;
      const knownLawnSide = line.direction?.lawnSide ?? this._lawnLineSide;
      const knownGarageSide = line.direction?.garageSide ?? this._garageLineSide;
      const inboundDirection = knownLawnSide !== null && knownGarageSide !== null
        && previousObservedSide === knownLawnSide && observedSide === knownGarageSide;
      const resumeStabilizing = !!(this._resumeGuardUntil && Date.now() < this._resumeGuardUntil);
      if (!this._outbound && this._missionOutside && inboundDirection
          && !resumeStabilizing
          && !this._safeReturnInProgress && !this._returnGuardActive && !this._externalReturnHandling) {
        // RC107: A normal mowing or paused route may legitimately cross the
        // configured garage safety line. The line is a gate interlock once a
        // return is already confirmed; it is not sufficient evidence to create
        // a return request by itself. Native returning/error handling and
        // explicit Dock/Home commands continue to enter the unchanged safe-
        // return state machine before this branch is evaluated.
        const nativeStatus = String(this.status() || '').toLowerCase();
        this.log('inbound safety-line crossing observed without confirmed return context', direction, `status=${nativeStatus || 'unknown'}`);
        // A crossing during ordinary mowing is NOT a return and normally does
        // nothing. Only an independently fresh physical incursion into the
        // ACTUAL gate danger circle while its sensor says CLOSED warrants one
        // preventive PAUSE. The 20-Oct mower beside the hut was OUTSIDE this
        // circle: that ordinary pass must remain uninterrupted.
        const p = this.pos();
        const age = Date.now() - Number(p?.ts || 0);
        const physicallyInsideClosedGate = doorNow === 'closed' && nativeStatus === 'mowing'
          && rawDanger?.known === true && rawDanger.inside === true
          && p && ['mqtt','siid:1:4'].includes(String(p.source || ''))
          && age >= 0 && age <= 3000 && line?.onSegment
          && this._freshNativeDockState?.(5000)?.dockingState !== 'IN_STATION';
        if (physicallyInsideClosedGate
            && (!this._closedGateUnexpectedCrossingAt
              || Date.now() - this._closedGateUnexpectedCrossingAt > 60000)) {
          this._closedGateUnexpectedCrossingAt = Date.now();
          this.log('closed gate unexpected inbound mowing within physical danger circle: preventive PAUSE, no gate movement');
          await this._pauseMowerForGateInterlock('mowing', 'closed_gate_unexpected_inbound_danger');
          await this.safetyWarning('closed_gate_unexpected_inbound_danger');
        }
      }
      if (!this._outbound && this._missionOutside && inboundDirection && resumeStabilizing) {
        this.log('inbound safety-line sample ignored during resume stabilization', direction);
      }
      if ((this.isReturning() || this._safeReturnInProgress || this._returnGuardActive)
          && this._returnContext !== RETURN_STATES.MAINTENANCE
          && !this._maintenanceJourneyOwnsNavigation()) {
        if (!inboundDirection) {
          this.log('safety line crossing during return ignored: wrong direction', direction);
        } else {
          this.log('safety line crossed lawn->garage during return', direction);
          const doorReady = this.isDoorOpenStable() && this._doorOpenReleaseVerified();
          if (!doorReady && !this._awaitingLineDoorOpen && this._returnLineWaitTerminalToken !== this._commandToken) {
            const token = this._pendingDirectReturnToken || this._commandToken;
            const sourceName = this._pendingDirectReturnSource || 'return_line_crossing';
            const dockAgain = this._pendingDirectDockFn || (async () => {
              const did = this.device.getData().id;
              const accepted = await this.device._safeWrite('garage_return_line_release_dock', () => this.device._api.dock(did));
              if (accepted === false) return false;
              await this.device._applyStatus('returning', 0, false);
              return true;
            });
            await this._waitAtSafetyLineUntilDoorOpenThenDock(dockAgain, token, sourceName);
          } else if (doorReady) {
            this.log('return safety line crossed: door already open and stable');
          }
        }
      } else if (this._outbound) {
        const expectedLawnSide = this._outbound.lineLawnSide ?? this._lawnLineSide;
        const stableEnoughForExit = lineUsableForOutbound && line.stable && expectedLawnSide !== null && observedSide === expectedLawnSide;
        if (stableEnoughForExit) {
          this._outbound.lineCrossAttempts = Number(this._outbound.lineCrossAttempts || 0) + 1;
          this._outbound.lastLawnCrossAt = Date.now();
          // Dwell begins only after the crossing itself has passed the physical
          // clearance threshold. Time spent merely touching/hovering across the
          // hysteresis band must never count toward an automatic close.
          this._outbound.lawnSideSince = Date.now();
          this._outbound.lawnSideStableHits = 1;
          this._setLineState(LINE_STATES.CROSSED, 'garage_to_lawn');
          this._lineToLawnConfirmed = false;
          this._outboundFallbackMowingAllowed = false;
          this._lineMowingReleasedAt = Date.now();
          this._outbound.lineCrossedAt = Date.now();
          this._outbound.departureLineConfirmed = true;
          this._outbound.departureLineConfirmedAt = Date.now();
          // A physically proven Garage→Lawn crossing (including the 500 mm
          // clearance rule above) is strong departure evidence. It may end
          // Justieren/Positionieren after the fixed Ausfahrt window. It does NOT
          // by itself authorize closing; the independent 800 mm/dwell/danger/native
          // mowing close guards below remain mandatory.
          if (this._manualMaintenanceTransit) await this._updateManualMaintenanceJourneyPhase().catch(() => {});
          await this.refreshTileStatus('physical Safety-Line crossing confirmed departure phase').catch(() => {});
          const pos = this.pos();
          this._lastSafetyLineCrossing = { direction: 'garage->lawn', raw: direction, at: Date.now(), position: pos, source: inferredFirstLawnHit ? 'inferred-first-lawn-hit' : 'line-segment', distance: Math.round(line.distance || 0), t: Number(line.t).toFixed(2) };
          this._trigger('garage_safety_line_lawn', 'line_crossed_garage_to_lawn', { direction });
          this.log('safety line crossed garage->lawn during outbound', `${inferredFirstLawnHit ? 'source=inferred-first-lawn-hit' : 'source=line-segment'}; raw=${direction}; time=${new Date().toISOString()}; position=${pos ? `${Math.round(pos.x)},${Math.round(pos.y)}` : 'unknown'}; distance=${Math.round(line.distance || 0)}mm; t=${Number(line.t).toFixed(2)}`);
          this.log('safety line crossed; departure evidence confirmed and close priorities armed independently', `attempt=${this._outbound.lineCrossAttempts}`);
        } else {
          if (expectedLawnSide !== null && observedSide === this._garageLineSide) {
            const pos = this.pos();
            this._lastSafetyLineCrossing = { direction: 'lawn->garage', raw: direction, at: Date.now(), position: pos, source: 'line-segment', distance: Math.round(line.distance || 0), t: Number(line.t).toFixed(2) };
            this._outbound.lawnSideSince = 0;
            this._outbound.lawnSideStableHits = 0;
            this.log('safety line crossed lawn->garage ignored', `source=line-segment; raw=${direction}; time=${new Date().toISOString()}; position=${pos ? `${Math.round(pos.x)},${Math.round(pos.y)}` : 'unknown'}; distance=${Math.round(line.distance || 0)}mm; t=${Number(line.t).toFixed(2)}`);
          }
          else this.log('safety line crossed wrong direction', `${direction}; expectedLawnSide=${expectedLawnSide}; distance=${Math.round(line.distance || 0)}mm; t=${Number(line.t).toFixed(2)}`);
        }
      } else {
        // Outside an active start/return mission the safety line is diagnostic only.
        // Do not emit timeline state changes or reset the active state machine.
      }
    }
    if (this._outbound && !line.known) {
      const now = Date.now();
      if (!this._lastLineDiagAt || now - this._lastLineDiagAt > 10000) {
        this._lastLineDiagAt = now;
        const a = await this.markers.lineA().catch(() => null);
        const b = await this.markers.lineB().catch(() => null);
        const p = this.pos();
        this.log('safety line watch', `${a && b && a.x === b.x && a.y === b.y ? 'PUNKTMODUS/Line A=B' : 'wartet auf erste gültige Position'}; lineA=${a ? `${Math.round(a.x)},${Math.round(a.y)}` : 'missing'}; lineB=${b ? `${Math.round(b.x)},${Math.round(b.y)}` : 'missing'}; pos=${p ? `${Math.round(p.x)},${Math.round(p.y)}` : 'missing'}`);
      }
    }
    if (this._outbound && line.known && !crossedLine) {
      const now = Date.now();
      if (!this._lastLineDiagAt || now - this._lastLineDiagAt > 10000) {
        this._lastLineDiagAt = now;
        this.log('safety line watch', `side=${observedSide}; prev=${previousObservedSide}; raw=${line.rawSide}; distance=${Math.round(line.distance || 0)}mm; t=${Number(line.t).toFixed(2)}; onSegment=${!!line.onSegment}`);
      }
    }
    // During outbound, do not advance the direction latch on a shallow side
    // flip. Keep the previous garage-side reference until the mower is at least
    // SAFETY_LINE_CROSS_CONFIRM_MM beyond A-B. A brief touch/position jitter can
    // therefore never manufacture a Garage→Lawn crossing.
    if (line.stable && side !== null && !shallowSideChange) {
      this._lastLineSide = side;
      this._lastLineSideAt = Number(line.positionTs || this.pos()?.ts || Date.now());
    }

    await this._evaluateOutboundClosePriorities(danger, line);
  }

  async _scheduleCloseAfterSafetyLine(reason) {
    if (!this._outbound || this._closeAfterExitRequested || this._lineCloseTimer) return;
    const lineToken = this._commandToken, outbound = this._outbound;
    const current = () => lineToken === this._commandToken && this._outbound === outbound && !this._manualGateStopped;
    const delay = OUTBOUND_MOWING_STABLE_MS;
    this.log('safety line close grace started', reason, `delay=${delay}ms`);
    this._lineCloseTimer = setTimeout(async () => {
      this._lineCloseTimer = null;
      try {
        if (!current()) return;
        if (!this.enabled() || !this._outbound || this._closeAfterExitRequested) return;
        if (this._manualMaintenanceTransit) {
          this.log('close-after-line suppressed: manual maintenance transit active');
          return;
        }
        if (this._outboundPhaseProtected()) {
          this.log('close waits after safety line: Ausfahrt/Justieren/Positionieren still protected');
          this._scheduleCloseAfterSafetyLine('waiting_protected_outbound_phase').catch((e) => this.error('reschedule close after line', e.message));
          return;
        }
        const modeGuard = this._outboundCloseBlockedByMode();
        if (modeGuard.blocked) {
          this.log('close waits after safety line: adjusting/positioning active', `mode=${modeGuard.mode}`);
          this._scheduleCloseAfterSafetyLine('waiting_adjusting_or_positioning').catch((e) => this.error('reschedule close after line', e.message));
          return;
        }
        const nativeMowingStable = this.status() === 'mowing'
          && this._outbound.lineCrossedAt
          && Date.now() - this._outbound.lineCrossedAt >= OUTBOUND_MOWING_STABLE_MS;
        if (!nativeMowingStable) {
          this.log('close waits after safety line: native mowing not stable yet', `nativeStatus=${this.status()}`);
          this._scheduleCloseAfterSafetyLine('waiting_native_mowing').catch((e) => this.error('reschedule close after line', e.message));
          return;
        }
        const lineNow = await this.markers.lineState().catch(() => null);
        if (!current()) return;
        const clearDistance = lineNow && Number.isFinite(Number(lineNow.distance)) ? Math.abs(Number(lineNow.distance)) : 0;
        const dangerClear = !(await this.isInDangerArea())
          && this._dangerOutsideSince
          && Date.now() - this._dangerOutsideSince >= DANGER_EXIT_STABLE_MS;
        if (!current()) return;
        if (!dangerClear) {
          this.log('close waits after safety line: danger area not stably clear');
          this._scheduleCloseAfterSafetyLine('waiting_danger_area_clear').catch((e) => this.error('reschedule close after line', e.message));
          return;
        }
        if (!this._rawDangerExitConfirmed()) {
          this.log('close waits after safety line: awaiting two fresh raw positions outside danger area', `hits=${this._rawDangerOutsideHits}`);
          this._scheduleCloseAfterSafetyLine('waiting_raw_danger_clear').catch((e) => this.error('reschedule close after line', e.message));
          return;
        }

        const lawnDwellMs = this._outbound.lawnSideSince ? Date.now() - this._outbound.lawnSideSince : 0;
        const crossingAttempts = Number(this._outbound.lineCrossAttempts || 0);
        const lawnStableHits = Number(this._outbound.lawnSideStableHits || 0);
        const normalClearance = clearDistance >= SAFETY_LINE_CLEARANCE_MM;
        const maintenanceGuard = await this._outboundCloseNearMaintenancePoint();
        if (!current()) return;
        const fallbackClearance = clearDistance >= SAFETY_LINE_DWELL_MIN_CLEARANCE_MM;
        const priority3Fallback = crossingAttempts >= SAFETY_LINE_PAUSE_FALLBACK_ATTEMPT && fallbackClearance;
        const dwellFallback = crossingAttempts >= SAFETY_LINE_DWELL_MIN_ATTEMPTS
          && lawnStableHits >= SAFETY_LINE_DWELL_MIN_ATTEMPTS
          && lawnDwellMs >= SAFETY_LINE_DWELL_FALLBACK_MS
          && fallbackClearance
          && !maintenanceGuard.near;

        // A normal line-clearance or dwell decision must not close the gate while
        // the mower is at the maintenance point. After the third short crossing,
        // Priority 3 below is allowed to pause-close-resume explicitly.
        if (maintenanceGuard.near && !priority3Fallback) {
          this.log('close waits after safety line: mower near maintenance point', `distance=${maintenanceGuard.distance}mm attempts=${crossingAttempts}`);
          this._scheduleCloseAfterSafetyLine('waiting_leave_maintenance_point').catch((e) => this.error('reschedule close after line', e.message));
          return;
        }

        if (!normalClearance && !dwellFallback && !priority3Fallback) {
          this.log('close waits after safety line: clearance/dwell not yet sufficient', `distance=${Math.round(clearDistance)}mm; fallbackRequired=${SAFETY_LINE_DWELL_MIN_CLEARANCE_MM}mm; attempts=${crossingAttempts}; lawnHits=${lawnStableHits}; lawnDwell=${lawnDwellMs}ms`);
          this._scheduleCloseAfterSafetyLine('waiting_line_clearance_or_dwell').catch((e) => this.error('reschedule close after line', e.message));
          return;
        }
        this._lineToLawnConfirmed = true;
        const confirmationReason = priority3Fallback
          ? 'priority_3_pause_fallback'
          : (dwellFallback ? 'garage_to_lawn_dwell_fallback' : 'garage_to_lawn_validated');
        this._setLineState(LINE_STATES.EXIT_CONFIRMED, confirmationReason);
        this.log('exit confirmed', priority3Fallback
          ? `priority 3 after repeated short crossings (attempts=${crossingAttempts})`
          : (dwellFallback
            ? `stable lawn-side dwell fallback (${lawnDwellMs}ms, attempts=${crossingAttempts})`
            : 'native mowing + danger clear + line clearance'));
        this._setLineState(LINE_STATES.DOOR_CLOSE_ALLOWED, 'safety_line_exit_confirmed');
        this._outboundExitLocked = true;
        this._dangerReleasedAfterExit = true;
        this.log('door close allowed', 'safety_line_exit_confirmed');
        this._closeAfterExitRequested = true;
        const closeOk = await this._pauseCloseResumeAfterExit(reason || 'line_crossed_garage_to_lawn');
        if (!current()) return;
        if (closeOk) { this._outboundExitLocked = true; this._clearOutboundStatusTimers(); this._outbound = null; this._recentStartExitCloseUntil = Date.now() + 180000; this._startCycleIgnoreReturnUntil = Date.now() + 180000; }
        else this._closeAfterExitRequested = false;
      } catch (e) {
        this.error('close after safety line', e.message);
      }
    }, delay);
  }



  async _confirmOutboundExitFromSafetyLine(reason = 'safety_line_exit', details = {}) {
    if (!this._outbound || this._lineToLawnConfirmed) return false;
    this._setLineState(LINE_STATES.CROSSED, 'garage_to_lawn');
    this._outbound.lineCrossAttempts = Number(this._outbound.lineCrossAttempts || 0) + 1;
    if (!this._outbound.lawnSideSince) this._outbound.lawnSideSince = Date.now();
    this._outbound.lawnSideStableHits = Math.max(SAFETY_LINE_DWELL_MIN_ATTEMPTS, Number(this._outbound.lawnSideStableHits || 0));
    this._lineToLawnConfirmed = true;
    this._outboundFallbackMowingAllowed = false;
    this._lineMowingReleasedAt = Date.now();
    this._outbound.lineCrossedAt = Date.now();
    this._outbound.departureLineConfirmed = true;
    this._outbound.departureLineConfirmedAt = Date.now();
    // Legacy callers use the same departure-evidence rule as the live observer:
    // a physically confirmed line crossing may end Justieren/Positionieren after
    // the fixed Ausfahrt window, while gate-close guards remain independent.
    if (this._manualMaintenanceTransit) await this._updateManualMaintenanceJourneyPhase().catch(() => {});
    await this.refreshTileStatus('physical Safety-Line crossing confirmed departure phase').catch(() => {});
    const pos = this.pos();
    this._lastSafetyLineCrossing = {
      direction: 'garage->lawn',
      raw: details.raw || reason,
      at: Date.now(),
      position: pos,
      source: details.source || reason,
      distance: Number.isFinite(Number(details.distance)) ? Math.round(Number(details.distance)) : null,
      t: details.t !== undefined ? String(details.t) : undefined,
    };
    this._trigger('garage_safety_line_lawn', 'line_crossed_garage_to_lawn', { direction: 'garage->lawn' });
    this.log('safety line crossed garage->lawn during outbound', `source=${details.source || reason}; raw=${details.raw || 'garage->lawn'}; time=${new Date().toISOString()}; position=${pos ? `${Math.round(pos.x)},${Math.round(pos.y)}` : 'unknown'}${Number.isFinite(Number(details.distance)) ? `; distance=${Math.round(Number(details.distance))}mm` : ''}${details.t !== undefined ? `; t=${details.t}` : ''}`);
    this.log('legacy safety-line confirmation routed to close-priority arbiter', reason);
    return true;
  }

  async _tryDegenerateSafetyPointExit() {
    // RC81: a too-short/degenerate A-B line is diagnostic only and can never
    // authorize a gate close. The user must set two valid line endpoints.
    return false;
  }

  async canCloseAfterExit() {
    if (!this._outbound || this._closeAfterExitRequested) return false;
    if (this._outboundPhaseProtected()) return false;
    if (this.isReturning()) return false;
    if (this.status() !== 'mowing') return false;
    if (await this.isInDangerArea()) return false;
    if (!this._dangerOutsideSince || Date.now() - this._dangerOutsideSince < DANGER_EXIT_STABLE_MS) return false;
    if (!this._rawDangerExitConfirmed()) return false;
    if (!this._lineToLawnConfirmed || this._lineState !== LINE_STATES.EXIT_CONFIRMED) return false;
    const lineNow = await this.markers.lineState().catch(() => null);
    if (!lineNow || !Number.isFinite(Number(lineNow.distance)) || Math.abs(Number(lineNow.distance)) < SAFETY_LINE_CLEARANCE_MM) return false;
    return this._outbound.lineCrossedAt && Date.now() - this._outbound.lineCrossedAt >= OUTBOUND_MOWING_STABLE_MS;
  }

  async _lineSide() {
    return this.markers.currentLineSide();
  }

  async getGarageOverlayData() {
    const garageMode = !!this.device.getSetting('garage_mode_enabled');
    const data = garageMode ? await this.markers.overlayData() : {};
    if (garageMode) {
      data.ready = await this.garageSafetyReady();
      data.dangerState = await this.markers.dangerState().catch(() => null);
      data.lineState = await this.markers.lineState().catch(() => null);
      const caution = Number(this._garageOption('garage_caution_radius_mm') || 0);
      if (Number.isFinite(caution) && caution > 0 && data.dangerCenter) data.cautionRadius = caution;
    }

    // RC110: the maintenance point is immutable map configuration. Never use
    // the current mower position, dock or any telemetry coordinate as a visual
    // fallback. A partial map update must retain the persisted verified marker;
    // if it is genuinely unavailable, omit it rather than displaying a dangerous
    // false target that appears to jump across the lawn.
    const index = this.device?._maintenancePointIndex?.() || 1;
    const stored = typeof this.device._resolveNativeMaintenancePoint === 'function'
      ? await Promise.resolve(this.device._resolveNativeMaintenancePoint(index)).catch(() => null)
      : await safeGetStoreValue(this.device, 'garage_maintenance_point');
    if (stored && Number.isFinite(Number(stored.x)) && Number.isFinite(Number(stored.y))) {
      data.maintenancePoint = { x: Number(stored.x), y: Number(stored.y), index, source: stored.source || 'stored' };
    } else {
      delete data.maintenancePoint;
    }
    return Object.keys(data).length ? data : null;
  }
}

module.exports = GarageSafetyEngine;
