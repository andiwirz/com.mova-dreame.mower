'use strict';

const GarageMarkerEngine = require('./GarageMarkerEngine');

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
const SENSOR_WATCHDOG_DEFAULT_MINUTES = 30;
const DEGRADED_DOOR_WAIT_MS = 25000;
const DEGRADED_DOCK_TIMEOUT_MS = 180000;
const EMERGENCY_HOLD_MS = 120000;
const DOOR_SENSOR_TIMEOUT_MS = 30000;
const SENSOR_CONTACT_STORE_KEY = 'garage_sensor_last_real_contact';
const SENSOR_MOVEMENT_TIMEOUT_STORE_KEY = 'garage_sensor_last_movement_timeout';
const DEFAULT_MOWER_SPEED_KMH = 1.8;
const RETURN_NEAR_HALF_RATIO = 0.5;
const RETURN_DOOR_ETA_RESERVE_SECONDS = 5;
const MAINTENANCE_CONFIRM_RADIUS_MM = 700;
// Garage return: a maintenance arrival is NOT proved by being somewhere within
// the old 1.2 m shortcut radius. Require recent position, verified arrival and
// additional clearance from the physically moving gate.
const RETURN_OPEN_POSITION_MAX_AGE_MS = 10000;
const RETURN_GATE_CLEARANCE_MM = 350;
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
const MAINTENANCE_AUTO_REALIGN_RADIUS_MM = 500;
const MAINTENANCE_ADJUSTING_MIN_MS = MIN_ADJUSTING_MS;
const MAINTENANCE_POSITIONING_MAX_MS = POSITIONING_FALLBACK_MS;
const MAINTENANCE_MOVEMENT_START_MM = 180;
const MAINTENANCE_STATIONARY_DRIFT_MM = 180;
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
const RETURN_PRELINE_STOP_MM = 2500;
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
    this._returnMaintenanceStopProof = null;
    // Native dock/charging acknowledgement from the CURRENT cycle. A later stale
    // `returning` frame must not defeat an already verified home-close, but a
    // previous cycle or a restored charging capability must never arm closing.
    this._nativeDockVerifiedAt = 0;
    this._offSegmentReturnRecoveryAt = 0;
    this._lockedReturnMaintenancePoint = null;

    this._lastDangerInside = false;
    this._lastLineSide = null;
    this._lastLineRawSide = null;
    this._clearOutboundStatusTimers();
    this._outboundFallbackMowingAllowed = false;
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._closeAfterExitRequested = false;

    this._outbound = null;
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
    this._sensorMovementTimeoutAt = 0;
    this._sensorMovementTimeoutReason = null;
    this._lastGateOpenHandshakeAt = 0;
    this._lastDoorOpenReleaseAt = 0;
    this._lastSensorSignalAt = 0;
    this._sensorAvailabilityUpdatedAt = 0;
    this._lastMarkerSetupWarningAt = 0;
    this._lastSafetyBlockNoticeAt = 0;
    this._lastCommandUiStateKey = '';
    this._commandToken = 0;
    this._homeCycleLocked = false;
    this._homeCycleLockedAt = 0;
    this._lineState = LINE_STATES.IDLE;
    this._returnContext = RETURN_STATES.IDLE;
    this._resumeGuardUntil = 0;
    this._lastPauseAt = 0;
    this._lastResumeMowingAt = 0;
    this._resumeStableSince = 0;
    this._resumeNativeReturnTimer = null;
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
    // External-start interception deliberately does not use Dreame DND.
    // Field testing showed DND does not prevent a manual/original-app start on A2.
    this._timelineSeen = new Map();
    this._degradedDockTimer = null;
  }

  cancelPendingCommand(reason = 'superseded') {
    this._invalidateHomeClose(reason);
    clearTimeout(this._returnRecoveryHold?.timer);
    this._returnRecoveryHold = null;
    this._returnRecoveryRequest = null;
    this._commandToken += 1;
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
    this._lineState = LINE_STATES.IDLE;
    this._returnContext = RETURN_STATES.IDLE;
    this._resumeGuardUntil = 0;
    this._lastPauseAt = 0;
    this._lastResumeMowingAt = 0;
    this._resumeStableSince = 0;
    if (this._resumeNativeReturnTimer) clearTimeout(this._resumeNativeReturnTimer);
    this._resumeNativeReturnTimer = null;
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

  markResumeInProgress(ms = 120000, reason = 'resume') {
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

  beginUserCommand(command) {
    // Only one long garage command may be pending. New explicit user actions
    // replace older maintenance/return/start waits instead of being queued.
    const switchingCommands = ['start_mowing', 'start_spot', 'dock', 'maintenance', 'stop'];
    if (switchingCommands.includes(command)) {
      this.cancelPendingCommand(`new_${command}`);
    } else {
      this._commandToken += 1;
    }
    if (switchingCommands.includes(command)) {
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
  }

  _language() {
    try {
      return String(this.homey?.i18n?.getLanguage?.() || 'en').toLowerCase();
    } catch (e) { return 'en'; }
  }

  _text(de, en) {
    return this._language().startsWith('de') ? de : en;
  }

  _formatLogArgs(args) {
    return args.map((arg) => {
      if (arg instanceof Error) return arg.message;
      if (typeof arg === 'string') return arg;
      try { return JSON.stringify(arg); } catch (e) { return String(arg); }
    }).join(' ');
  }

  _garageNotice(kind, message, reason = '', dedupeMs = 120000) {
    // Timeline logging stays independent. This optional Flow trigger is the
    // reliable bridge to Homey's mobile push action.
    if (!this.device.getSetting('garage_mission_push_notifications')) return;
    if (!this.device.getSetting('garage_mode_enabled')) return;
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
      message: String(message || normalized),
    });
    this.log('garage notice flow trigger', normalized, reason || '');
  }

  _missionNotification(kind) {
    const normalized = kind === 'return' ? 'return' : 'departure';
    const message = normalized === 'return'
      ? this._text('⚠️ Achtung, Mäher Rückkehr', '⚠️ Mower returning')
      : this._text('⚠️ Achtung, Mäher Ausfahrt', '⚠️ Mower departing');
    this._garageNotice(normalized, message, normalized, 120000);
  }

  _timeline(message, key = '') {
    if (!this.device.getSetting('garage_logging_enabled')) return;
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
    const debug = !!this.device.getSetting('garage_debug_verbose');
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
    if (first === 'manual maintenance transit started') return { key: 'state:maintenance_requested', msg: T('Wartungspunktfahrt angefordert', 'Maintenance-point trip requested') };
    if (first === 'maintenance departure requested') return { key: 'state:maintenance_requested', msg: T('Wartungspunktfahrt angefordert – Start wird geprüft', 'Maintenance-point trip requested – waiting for departure proof') };
    if (first === 'maintenance departure confirmed') return { key: 'state:maintenance_departed', msg: T('Fährt zum Wartungspunkt – Bewegung bestätigt', 'Going to maintenance point – movement confirmed') };
    if (first === 'maintenance departure retry') return { key: 'state:maintenance_retry', msg: T('Wartungspunktfahrt startet nicht – Befehl wird einmal wiederholt', 'Maintenance-point trip did not start – retrying command once') };
    if (first === 'maintenance departure failed') return { key: 'block:maintenance_departure_failed', msg: T('Wartungspunktfahrt nicht gestartet – blockiert', 'Maintenance-point trip did not start – blocked') };
    if (first === 'manual maintenance position read from native map') return { key: 'state:maintenance_map_read', msg: T('Wartungspunkt aus Originalkarte gelesen', 'Maintenance point read from original map') };
    if (first === 'maintenance point reached') return { key: 'state:maintenance_reached', msg: T('Wartungspunkt erreicht', 'Maintenance point reached') };
    if (first === 'return continues from maintenance point') return { key: 'state:return_continue_from_maintenance', msg: T('Rückkehr vom Wartungspunkt zur Garage fortgesetzt', 'Return from maintenance point to garage continued') };
    if (first === 'maintenance point timeout') return { key: 'block:maintenance_timeout', msg: T('Wartungspunkt Timeout – blockiert', 'Maintenance point timed out – blocked') };
    if (first === 'danger area') return { key: `state:danger:${second}`, msg: second === 'inside' ? T('Mäher im Gefahrenbereich', 'Mower in danger area') : T('Mäher außerhalb Gefahrenbereich', 'Mower outside danger area') };
    if (first === 'line state') {
      if (!this.device.getSetting('garage_debug_verbose')) return null;
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
      if (!this.device.getSetting('garage_debug_verbose')) return null;
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
    if (first === 'return decision') return this.device.getSetting('garage_debug_verbose') ? { key: `return:decision:${second}:${third}`, msg: `${T('Rückkehr-Entscheidung', 'Return decision')}: ${this._humanReason(second)}${third ? ` – ${third}` : ''}` } : null;
    if (first === 'speed basis') return this.device.getSetting('garage_debug_verbose') ? { key: `return:speed:${second}:${third}`, msg: `${T('Rückkehr-Berechnung', 'Return calculation')}: ${second}${third ? ` – ${third}` : ''}` } : null;
    if (first === 'return wait at safety line') return { key: `return:linewait:${second}`, msg: `${T('Rückkehr wartet an Sicherheitslinie', 'Return waiting at safety line')} – ${this._humanReason(second)}` };
    if (first === 'return line wait released') return { key: 'return:linewait:released', msg: T('Rückkehr freigegeben – Tor offen, Fahrt zur Garage wird fortgesetzt', 'Return released – door open, continuing to garage') };
    if (first === 'safety line crossed garage->lawn during outbound') return { key: 'state:line:lawn', msg: T('Sicherheitslinie Richtung Garten überfahren', 'Safety line crossed toward lawn') };
    if (first === 'safety line crossed lawn->garage ignored') return { key: 'state:line:garage', msg: T('Sicherheitslinie Richtung Garage überfahren – Tor bleibt unverändert', 'Safety line crossed toward garage – door unchanged') };
    if (first === 'safety line crossed wrong direction') return { key: 'state:line:wrong', msg: T('Sicherheitslinie in falscher Richtung überfahren – Tor bleibt unverändert', 'Safety line crossed in wrong direction – door unchanged') };
    if (first === 'safety line watch') {
      if (!this.device.getSetting('garage_debug_verbose')) return null;
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
    const labels = { maintenance_current_wait: 'Warte auf frische Stillstandsbestätigung am Wartungspunkt', maintenance_current_unconfirmed: 'Wartungspunkt: Stillstand oder Position nicht bestätigt', manual_gate_stop_hold: 'Tor manuell gestoppt – sichere neue Torfreigabe erforderlich', return_release_wait: 'Warte auf Tor- und Wartungspunktfreigabe', return_safety_line_pause_confirmation_pending: 'Rückkehr wartet sicher an der Sicherheitslinie – Stillstand wird bestätigt', return_safety_line_pause_failed_recovery: 'Rückkehr wartet sicher an der Sicherheitslinie – STOP-Recovery läuft', return_safety_line_stop_recovered: 'Stillstand an Sicherheitslinie bestätigt – Toröffnung läuft', return_safety_line_stop_unconfirmed: 'Stillstand an Sicherheitslinie nicht verifizierbar – Rückkehr blockiert' };
    if (labels[reason]) return labels[reason];
    const r = String(reason || '').replace(/^ERROR\s+/, '');
    const T = (de, en) => this._text(de, en);
    const known = {
      garage_open_timeout: T('Tor hat nicht rechtzeitig offen gemeldet', 'Door did not report open in time'),
      close_blocked_door_moving: T('Tor bewegt sich gerade', 'Door is moving'),
      close_blocked_markers_incomplete: T('Marker unvollständig', 'Markers incomplete'),
      markers_incomplete_close_disabled: T('Marker unvollständig, automatisches Schließen gesperrt', 'Markers incomplete, automatic closing disabled'),
      close_blocked_position_unknown: T('Position unklar', 'Position uncertain'),
      close_blocked_mower_in_danger_area: T('Mäher im Gefahrenbereich', 'Mower in danger area'),
      close_blocked_raw_danger_clear_unconfirmed: T('Gefahrenbereich noch nicht durch zwei frische Positionen freigegeben', 'Danger area not yet cleared by two fresh positions'),
      close_blocked_adjusting_active: T('Justieren aktiv', 'Adjusting active'),
      maintenance_point_timeout: T('Wartungspunkt nicht erreicht', 'Maintenance point not reached'),
      maintenance_point_timeout_mower_in_danger_area: T('Wartungspunkt-Timeout, Mäher noch im Gefahrenbereich', 'Maintenance-point timeout, mower still in danger area'),
      maintenance_departure_not_started: T('Wartungspunktfahrt wurde nicht gestartet', 'Maintenance-point trip did not start'),
      maintenance_departure_position_unconfirmed: T('Wartungspunktfahrt nicht prüfbar – keine frische Position', 'Maintenance-point departure cannot be verified – no fresh position'),
      maintenance_departure_retry_rejected: T('Wartungspunkt-Befehl beim Wiederholen abgelehnt', 'Maintenance-point retry command rejected'),
      maintenance_reached_close: T('Wartungspunkt erreicht', 'Maintenance point reached'),
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
    const pairs = [
      ['active garage command', 'Aktiver Garagenbefehl'], ['resume guard active', 'Fortsetzen-Schutz aktiv'],
      ['tile status', 'Kachelstatus'], ['door state', 'Torstatus'], ['safety status', 'Sicherheitsstatus'],
      ['request open', 'Toröffnung angefordert'], ['request close', 'Torschließung angefordert'],
      ['close requested', 'Torschließung angefordert'], ['maintenance point reached', 'Wartungspunkt erreicht'],
      ['maintenance point timeout', 'Wartungspunkt-Timeout'], ['danger area', 'Gefahrenbereich'],
      ['line state', 'Sicherheitslinienstatus'], ['exit confirmed', 'Ausfahrt bestätigt'],
      ['door close allowed', 'Torschließen freigegeben'], ['return context', 'Rückkehrstatus'],
      ['return decision', 'Rückkehrentscheidung'], ['speed basis', 'Geschwindigkeitsgrundlage'],
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
        ['Fehler', 'Error'], ['Wartungspunkt', 'Maintenance point'], ['Gefahrenbereich', 'Danger area'],
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
    if (!this.device.getSetting('garage_logging_enabled')) return;
    const raw = this._formatLogArgs(args);
    const msg = this._localizeDebugText(raw);
    this.device.log('[Garage]', msg);
    const evt = this._timelineFromLog(args, raw);
    if (evt) this._timeline(evt.msg, evt.key);
  }

  debugLog(...args) {
    if (!this.device.getSetting('garage_logging_enabled') || !this.device.getSetting('garage_debug_verbose')) return;
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
    const unit = String(this.device.getSetting('garage_speed_unit') || 'kmh');
    const raw = Number(this.device.getSetting('garage_mower_speed_value'));
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
    const mode = String(this.device.getSetting('garage_speed_source') || 'auto');
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

  async _lockReturnMaintenancePoint(source = 'return') {
    if (this._lockedReturnMaintenancePoint
      && Number.isFinite(Number(this._lockedReturnMaintenancePoint.x))
      && Number.isFinite(Number(this._lockedReturnMaintenancePoint.y))) {
      return this._lockedReturnMaintenancePoint;
    }
    const resolved = typeof this.device._resolveStableMaintenancePoint === 'function'
      ? await this.device._resolveStableMaintenancePoint().catch(() => null)
      : await safeGetStoreValue(this.device, 'garage_maintenance_point');
    if (!resolved || !Number.isFinite(Number(resolved.x)) || !Number.isFinite(Number(resolved.y))) {
      this.log('return maintenance point unavailable; maintenance confirmation will remain blocked', source || 'return');
      return null;
    }
    this._lockedReturnMaintenancePoint = Object.freeze({
      x: Number(resolved.x),
      y: Number(resolved.y),
      source: resolved.source || 'return_locked',
    });
    this.log('return maintenance point locked',
      `${Math.round(this._lockedReturnMaintenancePoint.x)},${Math.round(this._lockedReturnMaintenancePoint.y)}`,
      this._lockedReturnMaintenancePoint.source, source || 'return');
    return this._lockedReturnMaintenancePoint;
  }

  async _decideReturnPath(source = 'return') {
    const pos = this.pos();
    const positionFresh = !!pos && Number.isFinite(Number(pos.ts))
      && Number(pos.ts) > 0 && Date.now() - Number(pos.ts) >= 0
      && Date.now() - Number(pos.ts) <= POSITION_CACHE_MS;
    const dock = this.device._dockPos || this.device._cachedMapData?.chargerPos || null;
    const boundary = this._mapBoundaryNormalized();
    const speed = this._speedMetersPerSecond();
    const distanceToDockMm = this._distance(pos, dock);
    const diagMm = boundary ? Math.sqrt(Math.pow(boundary.maxX-boundary.minX,2)+Math.pow(boundary.maxY-boundary.minY,2)) : null;
    const halfMm = diagMm ? diagMm * RETURN_NEAR_HALF_RATIO : null;
    const etaSec = distanceToDockMm != null ? Math.round((distanceToDockMm/1000) / speed.mps) : null;
    const line = await this.markers.lineState().catch(() => ({ known: false }));
    const danger = await this.markers.dangerState().catch(() => ({ known: false, inside: false }));
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
    const distanceToLineMm = line && Number.isFinite(Number(line.distance)) ? Math.abs(Number(line.distance)) : null;
    const etaToLineSec = distanceToLineMm != null ? Math.round((distanceToLineMm / 1000) / speed.mps) : null;
    const requiredOpenLeadSec = Math.max(this._doorOpenDurationSeconds(), this._doorDelaySeconds()) + RETURN_DOOR_ETA_RESERVE_SECONDS;

    this.log('speed basis', speed.basis,
      `dockDist=${distanceToDockMm == null ? '?' : Math.round(distanceToDockMm)}mm dockEta=${etaSec == null ? '?' : etaSec+'s'}`,
      `lineDist=${distanceToLineMm == null ? '?' : Math.round(distanceToLineMm)}mm lineEta=${etaToLineSec == null ? '?' : etaToLineSec+'s'}`,
      `source=${source}`);

    // Hard safety rules always win over ETA and map-half fallbacks. Once the mower
    // is on the garage side of the A-B line or already in the danger area, the
    // gate must remain closed until the immutable maintenance point is reached.
    if (!positionFresh) {
      const detail = `position_stale_or_missing; source=${source}`;
      this.log('return decision', 'position_stale_use_maintenance', detail);
      return { mode: 'maintenance', reason: 'position_stale_use_maintenance', detail, etaSec, etaToLineSec, distanceToDockMm };
    }
    if (danger?.inside) {
      const detail = `danger=true; lineSide=${currentSide}; garageSide=${garageSide}; ${speed.basis}`;
      this.log('return decision', 'danger_area_use_maintenance', detail);
      return { mode: 'maintenance', reason: 'danger_area_use_maintenance', detail, etaSec, etaToLineSec, distanceToDockMm };
    }
    if (exactLineSideKnown && currentSide === garageSide) {
      const detail = `lineSide=${currentSide}=garageSide; lineDistance=${Math.round(distanceToLineMm || 0)}mm; ${speed.basis}`;
      this.log('return decision', 'garage_side_of_safety_line_use_maintenance', detail);
      return { mode: 'maintenance', reason: 'garage_side_of_safety_line_use_maintenance', detail, etaSec, etaToLineSec, distanceToDockMm };
    }

    // A reliable mower on the LAWN side remains on the native/direct return.
    // ETA only decides whether the gate is likely to be open before the mower
    // reaches A-B. If lead time is short, the existing safety-line interlock
    // performs the normal stop -> open -> continue handshake. Routing to the
    // maintenance point merely because ETA is short created competing return
    // owners (maintenance + line wait) and unnecessary Safety Blocks.
    if (exactLineSideKnown && currentSide === lawnSide) {
      const etaFits = etaToLineSec != null && etaToLineSec >= requiredOpenLeadSec;
      const reason = etaFits ? 'lawn_side_eta_sufficient_direct' : 'lawn_side_eta_short_line_wait';
      const detail = `lineSide=${currentSide}=lawnSide; etaToLine=${etaToLineSec == null ? '?' : etaToLineSec}s; required=${requiredOpenLeadSec}s; ${speed.basis}`;
      this.log('return decision', reason, detail);
      return { mode: 'direct', reason, detail, etaFits, etaSec, etaToLineSec, requiredOpenLeadSec, distanceToDockMm };
    }

    // The map-half rule is intentionally only a coarse fallback when exact line-
    // side classification is unavailable. It must never override a known line
    // side, danger-area result or confirmed maintenance position.
    if (pos && dock && boundary && halfMm && distanceToDockMm != null) {
      if (distanceToDockMm <= halfMm) {
        const detail = `fallback only: distance=${Math.round(distanceToDockMm)}mm <= half=${Math.round(halfMm)}mm; lineSide=unknown; ${speed.basis}`;
        this.log('return decision', 'fallback_half_map_near_garage', detail);
        return { mode: 'maintenance', reason: 'fallback_half_map_near_garage', detail, etaSec, etaToLineSec, distanceToDockMm };
      }
      const detail = `fallback only: distance=${Math.round(distanceToDockMm)}mm > half=${Math.round(halfMm)}mm; lineSide=unknown; ${speed.basis}`;
      this.log('return decision', 'fallback_half_map_lawn_side_direct', detail);
      return { mode: 'direct', reason: 'fallback_half_map_lawn_side_direct', detail, etaSec, etaToLineSec, distanceToDockMm };
    }

    const detail = `pos=${!!pos} dock=${!!dock} map=${!!boundary} lineSideKnown=${exactLineSideKnown}; ${speed.basis}`;
    this.log('return decision', 'position_unclear_use_maintenance', detail);
    return { mode: 'maintenance', reason: 'position_unclear_use_maintenance', detail, etaSec, etaToLineSec, distanceToDockMm };
  }

  async _waitForNativePause(token, requestedAt, timeoutMs = RETURN_NATIVE_PAUSE_ACK_TIMEOUT_MS) {
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
      if (nativeStopped()) {
        this._returnLineStopProof = { at: Date.now(), kind: 'native_pause', requestedAt };
        this.log('return safety-line stop confirmed', 'native_status');
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
            position: { x: Number(p.x), y: Number(p.y), ts },
            hits: stationaryHits,
          };
          this.log('return safety-line stop confirmed', 'stationary_position', `hits=${stationaryHits}`);
          return true;
        }
      }
      await sleep(250);
    }
    return false;
  }

  async _recoverReturnSafetyLineStop(token, source) {
    if (token !== this._commandToken || this._manualGateStopped) return false;
    this._timeline(
      this._text(
        'Rückkehr an Sicherheitslinie gestoppt – Pausebestätigung fehlt, Recovery läuft',
        'Return stopped at safety line – pause confirmation missing, recovery running',
      ),
      'return:linewait:pause_recovery',
    );

    const did = this.device.getData().id;

    // The first PAUSE has already had a bounded confirmation window. Do not keep
    // the mower trapped at the line with repeated PAUSE commands: terminate the
    // stale native return once, prove the physical stop, then recreate the
    // original dock/return command after the gate is verified open.
    try {
      const stopAt = Date.now();
      const stop = () => this.device._api.stopMowing(did);
      const accepted = typeof this.device._safeWrite === 'function'
        ? await this.device._safeWrite('garage_return_line_recovery_stop', stop)
        : await stop();
      if (accepted === false) return false;
      this.log('return safety-line recovery', 'STOP sent after missing pause acknowledgement');
      this._timeline(
        this._text(
          'Rückkehrtask an Sicherheitslinie sicher beendet – Stillstand wird geprüft',
          'Return task safely stopped at safety line – verifying standstill',
        ),
        'return:linewait:recovery_stop',
      );
      if (await this._waitForNativePause(token, stopAt, 4500)) {
        this.log('return safety-line recovery', 'stop proof confirmed; original return can be recreated');
        return true;
      }
    } catch (e) {
      this.error('return safety-line recovery STOP failed', e.message);
    }
    return false;
  }

  async _waitAtSafetyLineUntilDoorOpenThenDock(dockFn, token, source) {
    if (token !== this._commandToken) return false;
    this._awaitingLineDoorOpen = true;
    this.log('return wait at safety line', 'safety_line_wait_door_not_open', source || 'return');
    // SAFETY: cmdPause() is a UI toggle and resumes when the mower is already
    // paused. A safety-line interlock must be one-way only: always issue the
    // native PAUSE action and never turn an existing pause into a resume.
    const did = this.device.getData().id;
    const pauseRequestedAt = Date.now();
    let pauseCommandAccepted = true;
    try {
      if (typeof this.device._safeWrite === 'function') {
        const accepted = await this.device._safeWrite('garage_return_line_hard_pause', () => this.device._api.pause(did));
        if (accepted === false) pauseCommandAccepted = false;
      } else {
        const accepted = await this.device._api.pause(did);
        if (accepted === false) pauseCommandAccepted = false;
      }
    } catch (e) {
      pauseCommandAccepted = false;
      this.error('return safety-line hard pause failed', e.message);
    }

    // Reaching the configured A-B line on the lawn side is an expected return
    // waiting point, not a danger event. A missing PAUSED telegram therefore
    // stays a WARNING while we prove physical standstill (fresh position samples)
    // or perform one bounded STOP recovery. Only an unprovable stop becomes a
    // real Safety Block.
    let stopped = false;
    if (pauseCommandAccepted) stopped = await this._waitForNativePause(token, pauseRequestedAt);
    if (!stopped) {
      this.log('return line stop confirmation missing; entering controlled recovery', source || 'return',
        pauseCommandAccepted ? 'pause_ack_missing' : 'pause_rejected_or_failed');
      await this.safetyWarning(pauseCommandAccepted
        ? 'return_safety_line_pause_confirmation_pending'
        : 'return_safety_line_pause_failed_recovery');
      const recovered = await this._recoverReturnSafetyLineStop(token, source || 'return');
      if (!recovered) {
        this._awaitingLineDoorOpen = false;
        this.log('return line recovery failed: stop proof still unavailable', source || 'return');
        await this.returnOperationalHold('return_safety_line_stop_unconfirmed');
        this._timeline(
          this._text(
            'Rückkehr bleibt aus Sicherheitsgründen an der Linie gestoppt – Stillstand nicht verifizierbar',
            'Return remains stopped at the line for safety – standstill could not be verified',
          ),
          'return:linewait:recovery_failed',
        );
        return false;
      }
      await this.safetyWarning('return_safety_line_stop_recovered');
      this._timeline(
        this._text(
          'Stillstand an Sicherheitslinie bestätigt – Toröffnung wird fortgesetzt',
          'Standstill at safety line confirmed – continuing gate opening',
        ),
        'return:linewait:recovered',
      );
    }
    // Do not explicitly allow opening from inside the danger area here. If a
    // late sample says the mower is already underneath the gate, opening it can
    // lift the mower; the emergency/maintenance path must clear the area first.
    const ok = await this.ensureDoorOpen('return_safety_line_wait', { allowOpenFromDanger: false, allowDegraded: true, reassertDisplayedOpen: true });
    if (!ok) {
      this._awaitingLineDoorOpen = false;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._suspectedPausedReturnTimer = null;
      await this.returnOperationalHold('garage_cannot_open_at_safety_line');
      return false;
    }
    if (token !== this._commandToken) { this._awaitingLineDoorOpen = false; return false; }
    if (this._manualGateStopped || !this._doorOpenReleaseVerified()) { this._awaitingLineDoorOpen = false; return false; }
    this.log('return line wait released', 'door_open_stable', source || 'return');
    await this.clearSafety('return_safety_line_released').catch(() => {});
    this._timeline(
      this._text('Rückkehr wird nach Torfreigabe fortgesetzt', 'Return continues after gate release'),
      'return:linewait:released',
    );
    await dockFn();
    this._awaitingLineDoorOpen = false;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._suspectedPausedReturnTimer = null;
    return true;
  }



  async _prepareMowerForReturnPath(source = 'return') {
    // A return command must take control immediately.  Field tests showed that
    // issuing the maintenance command while the A2 is still actively mowing can
    // be ignored by the cloud/device, which leaves the mower mowing although the
    // garage state machine has already made a return decision.  Therefore we
    // first get the mower into a stopped/paused commandable state, then release
    // the chosen return path.  This is deliberately not used for Pause/Resume.
    const s = this.status();
    if (['mowing', 'mapping', 'remote_control', 'returning', 'positioning', 'adjusting'].includes(s)) {
      this.log('return prepare: hard pause mower before path command', source || 'return', 'status=', s);
      const did = this.device.getData().id;
      try {
        if (typeof this.device._safeWrite === 'function') {
          const accepted = await this.device._safeWrite('garage_return_prepare_pause', () => this.device._api.pause(did));
          if (accepted === false) this.log('return prepare pause rejected', source || 'return');
        } else {
          await this.device._api.pause(did);
        }
        // Never manufacture a native PAUSED status: the cloud/device must prove it.
      } catch (e) {
        this.error('return prepare hard pause', e.message);
      }
      await sleep(2500);
    }
  }

  async _sendMaintenanceWithRetry(maintenanceFn, token, source = 'return') {
    // Legacy method name kept for compatibility. The old implementation retried
    // after 3.5 s solely because the cloud still reported mowing/returning. Real
    // A2 field logs prove that a correctly accepted opcode 109 can remain PAUSED
    // for ~32 s before physical movement starts, so status is not a safe retry
    // signal. The position-based watcher below now owns the single retry.
    if (token !== this._commandToken) return false;
    await this._prepareMowerForReturnPath(source);
    if (token !== this._commandToken || this._manualGateStopped) return false;
    const accepted = await maintenanceFn();
    if (accepted === false) return false;
    return true;
  }

  _sensorWatchdogMinutes() {
    const raw = Number(this.device.getSetting('garage_sensor_watchdog_minutes') ?? SENSOR_WATCHDOG_DEFAULT_MINUTES);
    if (!Number.isFinite(raw) || raw <= 0) return SENSOR_WATCHDOG_DEFAULT_MINUTES;
    return raw;
  }
  _touchSensorSignal(reason = '') {
    this._lastSensorSignalAt = Date.now();
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
  sensorEnabled() { return !!this.device.getSetting('garage_sensor_enabled'); }
  sensorDoorReliable() { return this.sensorEnabled() && this.sensorHealthy(); }
  // Availability is advisory. If the user enabled a real door contact, always
  // give that contact a chance to confirm the CURRENT movement. A stale
  // offline/timeout capability must not skip directly to the timer fallback.
  // Only a critically low sensor battery disables the movement waiter.
  sensorDoorMonitoringEnabled() {
    if (!this.sensorEnabled()) return false;
    const batt = Number(this.device.getCapabilityValue('garage_sensor_battery') ?? 100);
    const min = Number(this.device.getSetting('garage_sensor_min_battery') ?? 15);
    return batt > min;
  }
  doorState() { return this.device.getCapabilityValue('garage_door_status') || 'unknown'; }
  isDoorOpenStable() { return this.doorState() === 'open' && !this._stableOpenTimer; }

  // A restored Homey capability can still say "open" after an app restart even
  // when the physical gate has since been closed without a fresh sensor event.
  // For the safety-critical vendor-app start interception, only an OPEN proof
  // produced in this runtime may bypass the pause/open handshake.
  _doorOpenVerifiedThisRuntime() {
    if (!this.isDoorOpenStable()) return false;
    const startedAt = Number(this._runtimeStartedAt || 0);
    const realOpenThisRuntime = this._lastSensorContactState === 'open'
      && Number(this._lastSensorContactAt || 0) >= startedAt;
    const releaseThisRuntime = Number(this._lastDoorOpenReleaseAt || 0) >= startedAt;
    return realOpenThisRuntime || releaseThisRuntime;
  }

  _doorOpenReleaseVerified(maxAgeMs = 5 * 60 * 1000) {
    if (!this.isDoorOpenStable()) return false;
    const now = Date.now();
    const freshRealOpen = this._lastSensorContactState === 'open'
      && !!this._lastGateOpenHandshakeAt
      && now - this._lastGateOpenHandshakeAt <= maxAgeMs;
    // RC113: a real open contact is the authoritative start handshake even when
    // the availability capability still says timeout/offline. The old code chose
    // between sensor and timer proof based on sensorHealthy(), which could change
    // during the same open cycle and make a successfully opened gate fail the
    // second verification in startRequested(). Accept either fresh proof source.
    return freshRealOpen
      || (!!this._lastDoorOpenReleaseAt && now - this._lastDoorOpenReleaseAt <= maxAgeMs);
  }

  _outboundDeparturePhase(now = Date.now()) {
    const out = this._outbound;
    if (!out || !out.released || !out.originalCommandSentAt) return null;
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

  async _pauseCloseResumeAfterExit(reason) {
    const token = this._commandToken;
    if (this._manualGateStopped) return false;
    if (this._exitPauseForCloseActive) return false;
    this._exitPauseForCloseActive = true;
    const did = this.device.getData().id;
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
        if (!(await this._waitForNativePause(token, pauseAt))) { await this.safetyWarning('exit_pause_unconfirmed'); return false; }
        this.log('mower paused for safe garage close', reason || 'exit');
        if (EXIT_PAUSE_SETTLE_MS > 0) await sleep(EXIT_PAUSE_SETTLE_MS);
      }
      if (typeof this.device?._syncPylonLifecyclePhase === 'function') {
        const lifecycle = await this.device._syncPylonLifecyclePhase('mowing', { reason:'garage_exit_complete' });
        if (lifecycle?.ok === false) {
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
      const closeOk = await this.requestClose(reason || 'exit_confirmed', {
        requireExitConfirmed: true,
        controlledOutboundPauseClose: pausedByGarage,
      });
      if (!closeOk) return false;
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
          return false;
        }
        if (token !== this._commandToken || this._manualGateStopped) return false;
        if (typeof this.device._resumeMowingRobust === 'function') await this.device._resumeMowingRobust('garage_exit_resume_after_close');
        else await this.device._safeWrite('garage_exit_resume_after_close', () => this.device._api.resume(did));
        this.log('mower resumed after garage closed', reason || 'exit');
      }
      return true;
    } finally {
      this._exitPauseForCloseActive = false;
    }
  }


  async _closeAfterExitWithoutPause(reason) {
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
    return this._homeDockReadyForClose();
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
    if (['returning', 'mowing', 'leaving', 'error'].includes(String(this.status()))) return false;
    // After the initial strong station+charge proof has armed the 15-second
    // settling window, a later fresh IN_STATION/u0 heartbeat is the independent
    // proof that no redock/undock correction occurred. It need not repeat the
    // chargingLive bit in the very same binary frame.
    if (this._freshStationHoldProof()) return true;
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
    if (this._manualMaintenanceTransit && Date.now() - maintenanceCommandAt < OUTBOUND_EXITING_DISPLAY_MS) return 'garage_exiting';
    if (this._manualMaintenanceTransit) {
      if (!this.isDoorOpenStable()) return 'garage_opening';
      if (this._manualMaintenancePhase === 'exiting') return 'garage_exiting';
      if (this._manualMaintenancePhase === 'adjusting') return 'garage_adjusting';
      if (this._manualMaintenancePhase === 'positioning') return 'garage_positioning';
      return 'garage_maintenance_transit';
    }
    if (!this.enabled()) return nativeStatus;

    // The physical departure state machine is authoritative for every
    // mowing/spot/external dock start: fixed Ausfahrt -> Justieren, then either a
    // physically confirmed Safety-Line crossing or four clean native MOWING
    // observations may release Mäht; otherwise the timer advances to Positionieren.
    const outboundPhase = this._outbound?.requiresMowingStable ? this._outboundDeparturePhase() : null;
    if (outboundPhase === 'exiting') return 'garage_exiting';
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
      await this._ensureCapValue('garage_door_status', 'closed');
      if (this.doorState() === 'unknown') await this._setCap('garage_door_status', 'closed');
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
    this._manualGateStopped = !!(await safeGetStoreValue(this.device, 'garage_manual_gate_stopped'));
    await this.syncGarageIndicatorCapabilities();
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
    if (await this.garageSafetyReady()) {
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
      await this._ensureCapValue('garage_door_status', this.isDockedHomeStatus() ? 'closed' : 'unknown');
      if (this.isDockedHomeStatus() && this.doorState() === 'unknown') await this._setCap('garage_door_status', 'closed');
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
    const parts = [
      `Gefahrenbereich: ${danger ? 'gesetzt' : 'fehlt'}`,
      `Sicherheitslinie A: ${a ? 'gesetzt' : 'fehlt'}`,
      `Sicherheitslinie B: ${b ? 'gesetzt' : 'fehlt'}`,
      `Linie plausibel: ${linePlausible ? 'ja' : 'nein'}`,
      `Radius: ${this.markers.dangerRadius()} mm`,
      `Gefahren-Hysterese: ${this.markers.dangerHysteresis()} mm`,
      `Linien-Hysterese: ${this.markers.lineHysteresis()} mm`,
      `A/B-Karenz: ${this.markers.lineSegmentMargin()} mm`,
      `Schließfreigabe: ${ready ? 'möglich' : 'gesperrt'}`,
    ];
    return parts.join(' | ');
  }

  async updateMarkerDiagnosis() {
    try {
      const text = await this.markerDiagnosisText();
      if (typeof this.device.setSettings === 'function') {
        await this.device.setSettings({ garage_marker_diagnosis: text }).catch(() => {});
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
    const raw = Number(this.device.getSetting('garage_open_stabilize_seconds') ?? DOOR_OPEN_DELAY_DEFAULT);
    if (!Number.isFinite(raw) || raw < 0) return DOOR_OPEN_DELAY_DEFAULT;
    return raw;
  }

  _doorOpenDurationSeconds() {
    const raw = Number(this.device.getSetting('garage_open_duration_seconds') ?? this.device.getSetting('garage_open_stabilize_seconds') ?? DOOR_OPEN_DELAY_DEFAULT);
    if (!Number.isFinite(raw) || raw < 0) return DOOR_OPEN_DELAY_DEFAULT;
    return raw;
  }

  _doorCloseDurationSeconds() {
    const raw = Number(this.device.getSetting('garage_close_duration_seconds') ?? this.device.getSetting('garage_open_stabilize_seconds') ?? DOOR_OPEN_DELAY_DEFAULT);
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
    this._sensorAvailabilityUpdatedAt = Date.now();
    this._touchSensorSignal(`available_${status}`);
    await this._setCap('garage_sensor_available_status', status);
    this.log('sensor available', status);
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

    const min = Number(this.device.getSetting('garage_sensor_min_battery') ?? 15);
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
    const min = Number(this.device.getSetting('garage_sensor_min_battery') ?? 15);
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
    const min = Number(this.device.getSetting('garage_sensor_min_battery') ?? 15);
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
    if (this._returnContext === state) return;
    this._returnContext = state;
    this.log('return context', state, reason || '');
  }

  _resetGarageCycle(reason = '') {
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
    const payload = { reason: String(reason), ...extra };
    const important = [
      'garage_open_requested', 'garage_close_requested', 'garage_stop_requested', 'garage_safety_block', 'garage_emergency',
      'garage_maintenance_point_reached', 'garage_home_confirmed', 'garage_door_stable_open',
      'garage_danger_area_entered', 'garage_danger_area_left', 'garage_safety_line_lawn',
      'garage_safe_return_started', 'garage_safe_return_completed', 'garage_external_start_blocked',
      'garage_position_uncertain',
    ];
    if (important.includes(id) && (this.device.getSetting('garage_debug_verbose') || ['garage_emergency','garage_safety_block'].includes(id))) {
      const names = {
        garage_open_requested: 'Flow: Garagentor öffnen angefordert',
        garage_stop_requested: 'Flow: Garagentor stoppen angefordert',
        garage_close_requested: 'Flow: Garagentor schließen angefordert',
        garage_safety_block: 'Flow: Safety Block',
        garage_emergency: 'Flow: Emergency/Notfall',
        garage_maintenance_point_reached: 'Flow: Wartungspunkt erreicht',
        garage_home_confirmed: 'Flow: Zuhause bestätigt',
        garage_door_stable_open: 'Flow: Tor stabil offen',
        garage_danger_area_entered: 'Flow: Gefahrenbereich betreten',
        garage_danger_area_left: 'Flow: Gefahrenbereich verlassen',
        garage_safety_line_lawn: 'Flow: Sicherheitslinie Richtung Garten',
        garage_safe_return_started: 'Flow: sichere Rückkehr gestartet',
        garage_safe_return_completed: 'Flow: sichere Rückkehr beendet',
        garage_external_start_blocked: 'Flow: externer Start blockiert',
        garage_position_uncertain: 'Flow: Position unklar',
      };
      this._timeline(`${names[id] || `Flow: ${id}`} – ${this._humanReason(payload.reason)}`, `trigger:${id}:${payload.reason}`);
    }
    try {
      this.homey.flow.getDeviceTriggerCard(id).trigger(this.device, payload, {}).catch(() => {});
    } catch (e) {}
  }

  async _setSafetyStatus(status, reason) {
    const allowed = ['ok', 'warning', 'blocked', 'emergency'];
    const safeStatus = allowed.includes(status) ? status : 'blocked';
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
  }

  async markerSetupWarning(reason) {
    // Missing markers during setup are not a hard safety fault: the mower may be
    // operated and the door may open, but automatic closing is disabled. Keep the
    // dashboard warning visible without spamming Safety-Block flows/timeline.
    await this._setSafetyStatus('warning', reason);
    const now = Date.now();
    if (!this._lastMarkerSetupWarningAt || now - this._lastMarkerSetupWarningAt > 60000) {
      this._lastMarkerSetupWarningAt = now;
      this._timeline(`Einrichtungsmodus: ${this._humanReason(reason)}. Tor schließt nicht automatisch.`, `setup:${reason}`);
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
    // A warning is not a physical hold. Stop the native return even when a
    // clearance check failed before the ordinary return branch sent PAUSE.
    if (!hold.busy) {
      hold.busy = true;
      try { hold.stopped = await this._stopReturnForRecovery(hold); }
      finally { hold.busy = false; }
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

  _scheduleReturnRecovery(hold) {
    if (!this._returnRecoveryCurrent(hold) || hold.timer || hold.busy) return;
    if (hold.attempts >= 3) {
      this.log('return recovery exhausted; gate release remains blocked', hold.reason);
      this._timeline(this._text('Rückkehr angehalten – Freigabe nicht bestätigt. Bitte Position prüfen und Rückkehr erneut anfordern.',
        'Return held – clearance unconfirmed. Check position and request return again.'), 'return:recovery_exhausted');
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
      // Reuse verified waypoint arrival if possible; otherwise force the
      // controlled waypoint route. Never open blindly at the closed gate.
      const accepted = await this.returnRequested('closed_gate_front_zone_hold_recovery', request.dockFn, request.maintenanceFn);
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
    } else {
      this.log('Safety Block flow notification throttled', reason || 'blocked');
    }
  }

  async emergency(reason, action = '') {
    await this._setSafetyStatus('emergency', reason);
    this._trigger('garage_emergency', reason || 'emergency', { action: String(action || '') });
  }

  async clearSafety(reason) {
    if (this._manualGateStopped) return;
    if (/^(sensor_|door_)/.test(String(reason)) && (this._returnGuardActive || this._emergencyGateContext)
        && ['blocked', 'emergency'].includes(this._lastSafetyStatus)) return;
    await this._setSafetyStatus('ok', reason || 'clear');
  }

  _emergencyHoldActive() {
    return !!this._emergencyHoldUntil && Date.now() < this._emergencyHoldUntil;
  }

  async _forceDoorDirectionForEmergency(target, reason) {
    const gateToken = this._commandToken;
    if (this._manualGateStopped) return false;
    const finalTarget = target === 'close' ? 'closing' : 'opening';
    await this.setDoorState(finalTarget, { immediate: true, derived: true });
    if (gateToken !== this._commandToken || this._manualGateStopped) return false;
    this._trigger(target === 'close' ? 'garage_close_requested' : 'garage_open_requested', reason || `emergency_reverse_to_${target}`);
    this._garageNotice(
      target === 'close' ? 'door_closing' : 'door_opening',
      target === 'close' ? this._text('Garagentor schließt', 'Garage door closing') : this._text('Garagentor öffnet', 'Garage door opening'),
      reason || `emergency_reverse_to_${target}`,
      15000,
    );
    this.log('EMERGENCY: gate movement reversed', `target=${target}`, reason || '');
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
      createdAt: Date.now(),
      commandToken: this._commandToken,
      reason: reason || 'garage_emergency',
    };
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
    if (this.doorState() === finalState) return true;

    const startedAt = Date.now();
    if (!opts.alreadyRequested) {
      await this._forceDoorDirectionForEmergency(action, reason || `emergency_restore_${action}`);
    }
    const configuredMs = Math.max(0, (finalState === 'closed'
      ? this._doorCloseDurationSeconds()
      : this._doorOpenDurationSeconds()) * 1000);
    const sensorWindow = this.sensorDoorMonitoringEnabled() ? DOOR_SENSOR_TIMEOUT_MS : 0;
    const deadline = startedAt + Math.max(3000, configuredMs, sensorWindow) + 3000;

    while (Date.now() < deadline) {
      if (token !== this._commandToken) return false;
      if (this.doorState() === finalState) return true;
      await sleep(500);
    }

    // The contact sensor is preferred, but an emergency recovery must not
    // deadlock forever if it misses the final edge. The configured physical
    // travel time is the same fallback used by normal gate operations.
    if (token !== this._commandToken || this.sensorDoorMonitoringEnabled()) return false;
    this.log('EMERGENCY gate target not confirmed; applying configured-time fallback', `target=${finalState}`);
    await this.setDoorState(finalState, { immediate: true, derived: true });
    return true;
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
      let accepted = false;
      if (typeof this.device._resumeMowingRobust === 'function') {
        accepted = await this.device._resumeMowingRobust('garage_emergency_restore_original_mission');
      } else if (typeof this.device._safeWrite === 'function' && this.device?._api?.resume) {
        accepted = await this.device._safeWrite('garage_emergency_resume_mowing', () => this.device._api.resume(did));
      } else if (this.device?._api?.resume) {
        accepted = await this.device._api.resume(did);
      }
      return accepted !== false && (context.commandToken === undefined || context.commandToken === this._commandToken);
    }

    // A manual maintenance trip is already complete when this callback runs.
    // Unknown/idle contexts are deliberately left stopped rather than guessing
    // a movement command.
    return true;
  }

  async _restoreEmergencyPlanAfterMaintenance(reason) {
    if (this._emergencyRestorePromise) return this._emergencyRestorePromise;
    this._emergencyRestorePromise = this._restoreEmergencyPlanAfterMaintenanceOnce(reason);
    try { return await this._emergencyRestorePromise; }
    finally { this._emergencyRestorePromise = null; }
  }

  async _restoreEmergencyPlanAfterMaintenanceOnce(reason) {
    if (this._manualGateStopped) return false;
    const context = this._emergencyGateContext;
    if (!context) return false;
    const token = this._commandToken;
    if (context.commandToken !== undefined && context.commandToken !== token) return false;
    if (context.mowerMode === 'return') {
      // Use exactly the normal return's bounded arrival proof, open confirmation,
      // contradiction detection and cancellation checks. No direct dock shortcut.
      if (!(await this._verifiedMaintenanceReturnClearance()) || token !== this._commandToken) {
        await this.safetyBlock('emergency_return_gate_clearance_unconfirmed');
        return false;
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

    // A mower that was genuinely returning must leave the maintenance point
    // only through a fully open gate. The interrupted physical gate target is
    // therefore NOT restored first for return missions: opening is the safe
    // prerequisite for releasing the original dock command. For mowing/outbound
    // emergencies we restore the gate's originally requested target as before.
    const recoveryGateTarget = context.mowerMode === 'return'
      ? 'open'
      : context.originalDoorTarget;
    // Emergency restoration previously bypassed requestOpen() entirely via
    // _forceDoorDirectionForEmergency(). That path may only restore an OPEN gate
    // after the actual stationary maintenance/clearance evidence has arrived.
    if (!(await this._verifiedMaintenanceReturnClearance())) {
      this.log('emergency return gate opening withheld: verified physical clearance missing');
      await this.safetyBlock('emergency_return_gate_clearance_unconfirmed');
      return false;
    }
    if (token !== this._commandToken || this._emergencyGateContext !== context) return false;
    const gateRestored = await this._waitForEmergencyGateTarget(
      recoveryGateTarget,
      `emergency_restore_${context.mowerMode === 'return' ? 'return_open' : `original_${context.originalDoorTarget}`}`,
    );
    if (token !== this._commandToken || this._emergencyGateContext !== context) return false;
    if (!gateRestored) {
      await this.safetyBlock('emergency_original_gate_action_failed');
      return false;
    }

    if (!(await this._verifiedMaintenanceReturnClearance()) || token !== this._commandToken) {
      await this.safetyBlock('emergency_mission_release_clearance_unconfirmed');
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

  async _dispatchEmergencyMaintenance(reason) {
    if (this._manualGateStopped) return false;
    const token = this._commandToken;
    await this._lockReturnMaintenancePoint(`emergency_${reason || 'danger'}`);
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
      await this.device._goToMaintenancePointGuarded(`emergency_${reason || 'danger'}`).catch((e) => this.error('emergency maintenance command', e.message));
    } else if (typeof this.device.cmdGoToMaintenancePoint === 'function') {
      await this.device.cmdGoToMaintenancePoint().catch((e) => this.error('emergency maintenance command', e.message));
    }
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
      await this.safetyBlock('emergency_maintenance_timeout');
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
    // Moving-gate emergencies evacuate immediately after the reversal command.
    // The pause above is deliberately followed without an additional wait by the
    // maintenance command so the mower turns away as quickly as possible.
    if (opts.immediateEvacuation) {
      this._pendingEmergencyMaintenanceReason = null;
      this.log('EMERGENCY: immediate evacuation to maintenance point', reason || 'danger');
      await this._dispatchEmergencyMaintenance(reason || 'danger');
      return;
    }
    if (!this.isDoorOpenStable()) {
      this._pendingEmergencyMaintenanceReason = reason || 'danger';
      this.log('emergency maintenance queued until gate stable open', reason || 'danger');
      return;
    }
    await this._dispatchEmergencyMaintenance(reason || 'danger');
  }

  async _handleOpeningGateDangerEvacuation(reason = '') {
    const now = Date.now();
    if (this._emergencyReverseAt && now - this._emergencyReverseAt < 10000) return true;
    this._emergencyReverseAt = now;
    this._captureEmergencyGateContext('opening', reason);
    // Unexpected entry while OPENING can lift/flip the mower. Reverse immediately
    // to CLOSED, then evacuate to maintenance. Intentional stationary occupancy
    // (dock/start or verified maintenance wait) is filtered before this handler,
    // preventing the restart/return open-close-open loop seen in field testing.
    await this.emergency('mower_in_danger_area_while_gate_opening', 'reverse_to_closed_and_maintenance');
    await this._pauseMowerForGateInterlock('emergency', 'opening_gate_danger').catch(() => {});
    await this._forceDoorDirectionForEmergency('close', 'emergency_mower_in_danger_area_while_gate_opening');
    this.log('EMERGENCY: unexpected mower entry while gate opening -> reverse to CLOSED and evacuate');
    await this._sendMowerToMaintenanceForEmergency(`gate_opening_danger_${reason || 'detected'}`, { immediateEvacuation: true });
    return true;
  }

  async _handleMovingDoorDangerEmergency(moving, reason = '') {
    const now = Date.now();
    if (this._emergencyReverseAt && now - this._emergencyReverseAt < 10000) return true;
    this._emergencyReverseAt = now;
    this._captureEmergencyGateContext(moving, reason);
    const reverseTarget = 'open';
    await this.emergency(`mower_in_danger_area_while_gate_${moving}`, `reverse_to_${reverseTarget}_and_maintenance`);
    await this._pauseMowerForGateInterlock('emergency', `${moving}_gate_danger`).catch(() => {});
    // This generic handler is used for CLOSING movement. Closing over a mower
    // must reverse immediately to OPEN. OPENING emergencies use the dedicated
    // handler above and reverse immediately to CLOSED to prevent lifting/flipping.
    await this._forceDoorDirectionForEmergency(reverseTarget, `emergency_mower_in_danger_area_while_gate_${moving}`);
    // Anti-lift / anti-crush recovery: the first action is always to reverse the
    // physical gate back toward its pre-motion state. Immediately afterwards send
    // the mower away from the gate to the verified maintenance point. Do not wait
    // for a full gate travel here: field geometry makes lingering underneath the
    // moving gate the greater risk. _sendMowerToMaintenanceForEmergency performs
    // a best-effort pause immediately followed by the maintenance command, so any
    // stop is kept as short as the device/cloud permits.
    await this._sendMowerToMaintenanceForEmergency(`gate_${moving}_danger`, { immediateEvacuation: true });
    return true;
  }

  async _expectedOpeningDangerOccupancy() {
    // Opening the garage while the mower is intentionally stationary inside is
    // normal for a start. Likewise, a verified maintenance point is a deliberate
    // safe waiting position for a return. These are OCCUPANCY cases, not a new
    // ENTRY into the moving-gate danger area. Keep the exemption narrow: a stale
    // persisted home flag alone must never suppress an opening emergency after an
    // app restart while the mower is actually moving.
    const st = String(this.status() || '').toLowerCase();
    const stationaryHome = this.isDockedHomeStatus()
      || (!this._missionOutside && this._homeState === 'home'
        && ['idle', 'standby', 'docked', 'charging', 'charging_completed', 'paused'].includes(st));
    if (stationaryHome) return true;

    if (this._outbound && !this._outbound.released
        && ['paused', 'idle', 'standby', 'docked', 'charging', 'charging_completed'].includes(st)) return true;

    if (this.isReturnCycleActive()) {
      const atMaintenance = await this._verifiedMaintenanceReturnClearance().catch(() => false);
      if (atMaintenance && ['paused', 'idle', 'standby'].includes(st)) return true;
    }
    return false;
  }

  async requestOpen(reason, opts = {}) {
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
      const pos = this.pos();
      const age = Date.now() - Number(pos?.ts || 0);
      const raw = await this.markers.rawDangerState(pos).catch(() => null);
      const clearanceKnown = !!pos?.ts && age >= 0 && age <= RETURN_OPEN_POSITION_MAX_AGE_MS
        && !!raw?.known && Number.isFinite(Number(raw.radius)) && Number.isFinite(Number(raw.distance))
        && Number(raw.distance) > Number(raw.radius) + RETURN_GATE_CLEARANCE_MM;
      let routeProof = false;
      const openingReason = String(reason || '').toLowerCase();
      if (openingReason.includes('maintenance')) {
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
    if (this.doorState() !== 'open') {
      await this.setDoorState('opening', { immediate: true });
    }
    if (gateToken !== this._commandToken || this._manualGateStopped) return false;
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
    // into the Homey timeline. The timeline gets one concise German line only.
    this.device.log('[Garage]', 'close guard', verdict, JSON.stringify(report));
    if (!this.device.getSetting('garage_logging_enabled') || !this.device.getSetting('garage_mode_enabled')) return;
    if (verdict === 'evaluate') return;
    const reason = this._humanReason(verdict.replace(/^blocked_/, 'close_blocked_'));
    const detail = [
      report.insideDanger ? 'Mäher im Gefahrenbereich' : null,
      !report.positionKnown ? 'Position unklar' : null,
      report.door && report.door !== 'open' ? `Tor: ${report.door}` : null,
      report.requireExitConfirmed && !report.lineToLawnConfirmed ? 'Sicherheitslinie fehlt' : null,
    ].filter(Boolean).join(', ');
    const msg = verdict.startsWith('blocked') ? `Schließen blockiert – ${reason}${detail ? ` (${detail})` : ''}` : `Schließen freigegeben – ${this._humanReason(report.reason)}`;
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
    const gateToken = this._commandToken;
    if (this._manualGateStopped) { await this.safetyWarning('manual_gate_stop_hold'); return false; }
    // Absolute maintenance safety: Ausfahrt, Justieren and Fahrt zum
    // Wartungspunkt must never share the doorway with a closing gate. Do not
    // trust a caller-provided option on its own; only the internally latched,
    // verified arrival state may release this guard. Emergency reversal remains
    // the sole exception because it is itself a collision-avoidance action.
    const maintenanceArrivalAuthorized = this._maintenanceArrivalCloseAuthorized(opts);
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

    const inboundMotionActive = ['returning', 'error'].includes(report.nativeStatus)
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
    if (this._outboundCloseProtected() && !maintenanceArrivalAuthorized && !opts.manualOutsidePositionVerified) {
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
    if (!safelyDockedHomeForClose && closeModeGuard.blocked && !maintenanceArrivalAuthorized && !opts.manualOutsidePositionVerified) {
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
    if (opts.reassertDisplayedOpen && this.doorState() === 'open') {
      // A displayed OPEN may be stale. Re-send the actual motor OPEN flow, even
      // when the contact is already OPEN (it need not publish a second edge).
      // Do not use an old release timestamp to skip this handshake.
      const sensorWasOpen = this._lastSensorContactState === 'open'
        && Number(this._lastSensorContactAt || 0) > 0;
      const issuedAt = Date.now();
      const requested = await this.requestOpen(reason, { allowOpenFromDanger: !!opts.allowOpenFromDanger });
      if (!requested || !current()) return false;
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
      await this.setDoorState('open', { immediate: true, derived: true });
      if (!current()) return false;
      this._lastDoorOpenReleaseAt = Date.now();
      this.log('return gate OPEN reasserted: full travel time elapsed', freshOpen ? 'fresh_sensor_open' : 'sensor_remained_open');
      return true;
    }
    if (this._doorOpenReleaseVerified()) {
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
      this.log('door open by configured time', fallbackReason, 'waiting', Math.ceil(waitMs / 1000), 's');
      await this.setDoorState('opening', { immediate: true, derived: true });
      if (waitMs > 0) await sleep(waitMs);
      if (!current()) return false;
      await this.setDoorState('open', { immediate: true, derived: true });
      await this.clearSafety('sensor_open_time_fallback_completed').catch(() => {});
      this._lastDoorOpenReleaseAt = Date.now();
      this._trigger('garage_door_stable_open', fallbackReason || 'door_open_time_elapsed');
      return current();
    };

    await this._restoreSensorOnlineIfRecent('open_guard').catch(() => {});
    if (!this.sensorDoorMonitoringEnabled()) {
      const requested = await this.requestOpen(reason, { allowOpenFromDanger: !!opts.allowOpenFromDanger });
      if (!requested) return false;
      return useTimerFallback(this.sensorEnabled() ? 'sensor_battery_low_open_time_elapsed' : 'sensor_disabled_open_time_elapsed');
    }
    // Even if the availability capability currently says offline/timeout, a
    // configured contact sensor is authoritative for this movement. Wait for a
    // fresh OPEN edge first; only after the movement watchdog expires use the
    // configured physical travel-time fallback.
    if (this._doorOpenReleaseVerified()) {
      await waitRemainingMinimum('already_open_verified');
      return current();
    }
    if (this.isDoorOpenStable()) {
      this.log('cached open state not trusted for start; requesting fresh gate-open handshake');
    }

    const requested = await this.requestOpen(reason, { allowOpenFromDanger: !!opts.allowOpenFromDanger });
    if (!requested) return false;

    const max = Date.now() + DOOR_SENSOR_TIMEOUT_MS;
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
      if (!current() || this._lastSensorContactState !== 'open' || ['closing','closed'].includes(this.doorState())) return false;
      this.log('door open confirmed by late fresh sensor contact; completing settle time');
      await this.setDoorState('open', { immediate: true, derived: false });
      await waitRemainingMinimum('late_sensor_open_contact');
      await this.clearSafety('late_sensor_open_confirmed').catch(() => {});
      this._lastDoorOpenReleaseAt = Date.now();
      this._trigger('garage_door_stable_open', 'late_sensor_open_confirmed');
      return current();
    }

    // The contact is preferred, but it must not deadlock the complete garage
    // sequence when the sensor is temporarily offline or misses an update. After
    // the explicit timeout, record a movement-specific confirmation timeout and fall back to the
    // configured physical opening duration. The mower remains paused until that
    // duration has elapsed; only then is the outbound/return command released.
    if (!current()) return false;
    this.log('door open sensor timeout; using configured-time fallback');
    await this._recordSensorMovementTimeout('open');
    return useTimerFallback('sensor_open_confirmation_timeout_time_fallback', Date.now() - openedRequestedAt);
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

  async _freshPositionProvesOutsideHome() {
    const pos = this.pos();
    if (!pos) return false;
    const age = Date.now() - Number(pos.ts || 0);
    if (Number.isFinite(age) && age > POSITION_CACHE_MS) return false;
    const danger = await this.markers.dangerState().catch(() => null);
    if (danger?.known && danger.inside === false) return true;
    const dock = this.device._dockPos;
    const dockDistance = dock ? this._distance(pos, dock) : null;
    return Number.isFinite(dockDistance) && dockDistance >= 1500;
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

  async _confirmReleasedStart(source, token, retryFn = null) {
    this._clearStartConfirmation();
    this._startConfirmationPending = true;
    this._startConfirmationFailed = false;
    this._startConfirmSource = source || 'start';
    this._startRetryFn = typeof retryFn === 'function' ? retryFn : null;
    this._startRetrySent = false;
    this._startFinalRetrySent = false;
    const p = this.pos();
    this._startConfirmInitialPos = p ? { x: Number(p.x), y: Number(p.y), ts: p.ts || Date.now() } : null;
    await this.refreshTileStatus('start command sent; waiting for mower confirmation').catch(() => {});

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
      if (this._physicalOutsideRecoveryEvidence()) {
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
      const gateReleased = !!this._outbound?.released && this.isDoorOpenStable();
      const homeLike = ['docked', 'charging', 'charging_completed', 'idle', 'standby'].includes(this.status());
      if (gateReleased && homeLike && !this._outbound?.dockLeftAt && this._startRetryFn && !this._startFinalRetrySent) {
        this._startFinalRetrySent = true;
        this.log('start confirmation final recovery retry', 'gate released; native state still home/idle-like');
        try {
          const accepted = await this._startRetryFn();
          if (accepted === false) this.log('start final recovery retry rejected');
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
          this._missionOutside = !!this.positionKnown() || !!this._outbound;
          this._homeState = this._missionOutside ? 'away' : 'adjusting';
          this.log('start not confirmed after recovery retry; mower left controllable, no STOP sent');
          await this.refreshTileStatus('start not confirmed; retry or return available').catch(() => {});
          await this.safetyWarning('start_not_confirmed').catch(() => {});
        }, START_CONFIRM_NOTICE_MS);
        return;
      }

      this._startConfirmationPending = false;
      this._startConfirmationFailed = true;
      // No STOP here. Preserve the outbound context so the garage cannot close on
      // a mower whose exact state is uncertain.
      this._missionOutside = !!this.positionKnown() || !!this._outbound;
      this._homeState = this._missionOutside ? 'away' : 'adjusting';
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
    try { await this.device._api.stopMowing(did); } catch (_) {}
    this._startConfirmationPending = false;
    this._startConfirmationFailed = true;
    this._outbound = null;
    this._missionOutside = false;
    this._homeState = this.isDockedHomeStatus() ? 'home' : 'unknown';
    this._lineToLawnConfirmed = false;
    this._closeAfterExitRequested = false;
    this._setLineState(LINE_STATES.IDLE, 'start_online_timeout');
    await this.refreshTileStatus('start failed: mower offline').catch(() => {});
    await this.safetyWarning('start_online_timeout').catch(() => {});
    // The door may already have been opened for the attempted start. With no
    // reachable mower there is no valid Ausfahrt/Justieren/Positionieren phase.
    // Abort the cycle and close again using sensor confirmation or configured time.
    if (this.isDoorOpenStable() || this.doorState() === 'open') {
      await this.requestClose('start_online_timeout_abort').catch(() => false);
    }
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
    const p = this.pos();
    const ts = Number(p?.ts || 0);
    const age = Date.now() - ts;
    if (!p || !ts || age < 0 || age > POSITION_CACHE_MS || this.isDockedHomeStatus()) return false;
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
    if (token !== this._commandToken || this._manualGateStopped) return false;
    if (!await this._waitForMowerOnlineBeforeStart(source || 'outside_start')) return false;
    const accepted = await fn();
    if (accepted === false || token !== this._commandToken) return false;
    clearInterval(this._maintenanceWatch);
    this._maintenanceWatch = null;
    this._manualMaintenanceReached = false;
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
    await this.refreshTileStatus(`mowing start released outside: ${reason}`).catch(() => {});
    this.log('start accepted outside; garage bypass', reason, source || 'start');
    return true;
  }

  async startRequested(source, fn) {
    if (this._manualGateStopped) { await this.safetyWarning('manual_gate_stop_hold'); return false; }
    const token = this._commandToken;
    const completedMaintenanceBeforeStart = !!this._manualMaintenanceReached;
    const secureHomeBeforeStart = this.isDockedHomeStatus();

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
      if (verifiedMaintenanceOutsideBeforeStart && this.doorState() !== 'closed') {
        if (!await this.requestClose('maintenance_start_close', { maintenanceArrivalVerified: true })) return false;
        if (!await this._waitForDoorClosedOrTimeout(token)) return false;
      }
      if (typeof this.device?._syncPylonLifecyclePhase === 'function') {
        const lifecycle = await this.device._syncPylonLifecyclePhase('mowing', { reason:'start_outside' });
        if (lifecycle?.ok === false) {
          await this.safetyWarning('pylon_lifecycle_mowing_sync_failed').catch(() => {});
          return false;
        }
      }
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
    if (!this.enabled()) return fn();
    this._homeCloseArmed = true;
    clearTimeout(this._closeTimer);
    this._closeTimer = null;
    this._closeScheduled = false;
    this._homeCloseInProgress = false;
    this._homeState = 'leaving';
    await this.refreshTileStatus('start cycle begins').catch(() => {});
    if (typeof this.device?._syncPylonLifecyclePhase === 'function') {
      const lifecycle = await this.device._syncPylonLifecyclePhase('departure', { reason:'garage_start' });
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
    if (accepted === false) {
      this.log('start command rejected by API', source);
      this._startConfirmationFailed = true;
      this._outbound = null;
      await this.refreshTileStatus('start command rejected').catch(() => {});
      return false;
    }
    if (token !== this._commandToken || this._manualGateStopped) { this.log('start cancelled after release', source); return false; }
    await this._markOutboundReleased();
    await this._confirmReleasedStart(source, token, fn);
    return true;
  }

  async maintenanceRequested(source, fn) {
    if (this._manualGateStopped) { await this.safetyWarning('manual_gate_stop_hold'); return false; }
    const token = this._commandToken;
    if (!this.enabled()) return fn();
    // A second button press at the confirmed stationary point is an idempotent
    // acknowledgement. Do not clear the proof and issue another opcode 109.
    if (this._manualMaintenanceReached && !this._manualMaintenanceTransit
        && await this._isCurrentlyAtKnownMaintenancePoint().catch(() => false)) {
      this.log('maintenance point reached', 'already_at_verified_point');
      this._trigger('garage_maintenance_point_reached', 'already_verified');
      await this.refreshTileStatus('maintenance point reconfirmed').catch(() => {});
      return true;
    }
    const src = String(source || 'MAINTENANCE');
    const startedFromHome = this.isHomeStatus();
    const explicitManualMaintenance = ['button_maintenance', 'flow_maintenance', 'cmd_maintenance_point']
      .some((name) => src.includes(name));
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
      await this._prepareMowerForReturnPath('manual_maintenance_outside');
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
    this._watchMaintenanceReached(async () => {
      if (token !== this._commandToken) { this.log('maintenance callback ignored: superseded', source); return; }
      this._manualMaintenanceTransit = false;
      this._manualMaintenanceReached = true;
      this._clearManualMaintenanceStatusTimers();
      await this.refreshTileStatus('maintenance point reached').catch(() => {});
      if (this._outbound && !this._outbound.requiresMowingStable) {
        await this.requestClose('maintenance_reached_close', { maintenanceArrivalVerified: true });
      }
    });

    const accepted = await fn();
    if (accepted === false) {
      // A late cloud rejection must not leave the early watcher alive.
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
    if (this._manualMaintenanceReached && !this._manualMaintenanceTransit) return true;

    if (explicitManualMaintenance) {
      // Phase timing belongs to command DISPATCH, not to the delayed HTTP response.
      this._manualMaintenanceCommandAcceptedAt = Number(this.device._nativeMaintenanceCommandAt || 0) || Date.now();
      this._manualMaintenancePhasePos = this.pos() ? { ...this.pos() } : this._manualMaintenancePhasePos;
      if (directOutsideMaintenance) {
        this._manualMaintenanceExitUntil = 0;
        this._manualMaintenancePhase = 'transit';
        this._manualMaintenancePhaseStartedAt = this._manualMaintenanceCommandAcceptedAt;
        this._clearManualMaintenanceStatusTimers();
        this.log('manual maintenance transit started outside; garage phases bypassed', `native_index_${this.device._maintenancePointIndex?.() || '?'}`);
        await this.refreshTileStatus('manual maintenance transit outside').catch(() => {});
      } else {
        this._manualMaintenanceExitUntil = this._manualMaintenanceCommandAcceptedAt + OUTBOUND_EXITING_DISPLAY_MS;
        await this._updateManualMaintenanceJourneyPhase().catch(() => {});
        this.log('manual maintenance command acknowledged', `native_index_${this.device._maintenancePointIndex?.() || '?'}`, `dispatchAge=${Math.max(0, Date.now() - this._manualMaintenanceCommandAcceptedAt)}ms`);
        await this.refreshTileStatus('manual maintenance command acknowledged').catch(() => {});
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
    if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return false;
    const age = Date.now() - Number(p.ts || 0);
    if (age < 0 || age > RETURN_OPEN_POSITION_MAX_AGE_MS) return false;
    const native = String(this.status() || '').toLowerCase();
    if (['returning', 'docked', 'charging', 'charging_completed'].includes(native)
        || this._safeReturnInProgress || this._returnGuardActive) return false;
    const danger = await this.markers.rawDangerState().catch(() => null);
    if (!danger?.known || danger.inside) return false;
    const clearance = Number(danger.distance) - Number(danger.radius);
    if (!Number.isFinite(clearance) || clearance <= RETURN_GATE_CLEARANCE_MM) return false;
    const dock = this.device?._dockPos;
    const dockDistance = dock ? this._distance(p, dock) : null;
    if (Number.isFinite(Number(dockDistance)) && Number(dockDistance) < 1500) return false;
    this.log('manual gate close: fresh internal outside position accepted',
      `clearance=${Math.round(clearance)}mm; dockDistance=${Number.isFinite(Number(dockDistance)) ? Math.round(Number(dockDistance)) : 'unknown'}mm`);
    return true;
  }

  _manualGateOpenDockProof() {
    const now = Date.now();
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

  async manualGateRequest(action) {
    if (!this.enabled()) throw new Error('Garagenmodus ist deaktiviert');
    if (action === 'stop') return this.stopGateManually();
    if (!['open', 'close'].includes(action)) throw new Error('Ungültiger Torbefehl');
    // A new explicit request may leave STOP only with fresh physical clearance.
    const manualToken = this._commandToken;
    const p = this.pos(), age = Date.now() - Number(p?.ts || 0);
    const d = await this.markers.rawDangerState().catch(() => null);
    const safeDockClose = (this._homeDockReadyForClose() || this._strongDockCloseProof())
      && this.isDockedHomeStatus() && !this._outbound && !this._manualMaintenanceTransit;
    const safeDockOpen = action === 'open' && this._manualGateOpenDockProof();
    const safeDock = action === 'open' ? safeDockOpen : safeDockClose;
    const clearOutside = !!p?.ts && age >= 0 && age <= RETURN_OPEN_POSITION_MAX_AGE_MS && !!d?.known
      && Number.isFinite(Number(d.distance)) && Number.isFinite(Number(d.radius))
      && Number(d.distance) > Number(d.radius) + RETURN_GATE_CLEARANCE_MM;
    if (!safeDock && !clearOutside) {
      throw new Error(action === 'open'
        ? 'Tor öffnen gesperrt: Mäher weder sicher in Station noch mit frischer Position außerhalb des Gefahrenbereichs bestätigt'
        : 'Tor schließen gesperrt: frische sichere Dock- oder Außenposition erforderlich');
    }
    if (manualToken !== this._commandToken) return false;
    const wasStopped = this._manualGateStopped;
    this._manualGateStopped = false;
    let accepted = false;
    try {
      const maintenanceClear = action === 'close' && await this._isCurrentlyAtKnownMaintenancePoint().catch(() => false);
      const internalOutsideClear = action === 'close' && !safeDock && !maintenanceClear
        ? await this._manualGateOutsidePositionProof().catch(() => false)
        : false;
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
    if (!this._manualMaintenanceReached || this._manualMaintenancePhase !== 'reached'
        || this._manualMaintenanceTransit || !Number(this._lastMaintenanceReachedAt || 0)) return null;
    const proofAge = Date.now() - Number(this._lastMaintenanceReachedAt || 0);
    if (proofAge < 0 || proofAge > RETURN_MAINTENANCE_ARRIVAL_REUSE_MAX_MS) return null;
    if (token !== this._commandToken || this._manualGateStopped || this._emergencyGateContext
        || this._emergencyHoldActive() || ['opening', 'closing'].includes(this.doorState())) return false;

    const target = this._lockedReturnMaintenancePoint
      || (typeof this.device._resolveStableMaintenancePoint === 'function'
        ? await this.device._resolveStableMaintenancePoint().catch(() => null)
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

    const hadPriorVerifiedArrival = this._manualMaintenanceReached === true
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
      || (typeof this.device._resolveStableMaintenancePoint === 'function'
        ? await this.device._resolveStableMaintenancePoint().catch(() => null)
        : await safeGetStoreValue(this.device, 'garage_maintenance_point'));
    const distance = this._distance(current, target);
    if (distance === null || distance > radiusMm) return false;
    const danger = await this.markers.rawDangerState(current).catch(() => null);
    return !!danger?.known && Number.isFinite(Number(danger.radius)) && Number.isFinite(Number(danger.distance))
      && Number(danger.distance) > Number(danger.radius) + RETURN_GATE_CLEARANCE_MM;
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
      return `contradictory_native_status_${status}`;
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

  async _continueReturnFromMaintenance(source, dockFn, token, degradedReturn = false) {
    if (token !== this._commandToken || !(await this._verifiedMaintenanceReturnClearance())) {
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
    // The maintenance point is the deterministic stationary checkpoint for
    // return-only / mowing-only no-go rules. Apply and verify the native map
    // before the gate opens or the final dock command is released.
    if (typeof this.device?._syncPylonLifecyclePhase === 'function') {
      const lifecycle = await this.device._syncPylonLifecyclePhase('return', { reason:'return_from_maintenance' });
      if (lifecycle?.ok === false) {
        this.log('return held at maintenance point: pylon lifecycle transition failed', lifecycle?.reason || 'unknown');
        await this.returnOperationalHold('pylon_lifecycle_return_sync_failed');
        return false;
      }
    }
    const ok = await this.ensureDoorOpen('return_from_maintenance', { allowDegraded: degradedReturn, allowOpenFromDanger: false, reassertDisplayedOpen: true });
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
    await this.clearSafety('return_release_verified');
    if (this.device && typeof this.device._poll === 'function') {
      this.homey.setTimeout(() => this.device._poll().catch(() => {}), 5000);
      this.homey.setTimeout(() => this.device._poll().catch(() => {}), 12000);
      this.homey.setTimeout(() => this.device._poll().catch(() => {}), 25000);
    }
    if (degradedReturn) this._watchDegradedDockResult('return_degraded_sensor');
    return true;
  }

  async returnRequested(source, dockFn, maintenanceFn) {
    if (this._manualGateStopped) { await this.safetyWarning('manual_gate_stop_hold'); return false; }
    const token = this._commandToken;
    if (!this.enabled()) return dockFn();

    // Once a return/recovery owns the maintenance watcher, later duplicate
    // returning/error signals must not tear that watcher down. It is responsible
    // for opening the gate and continuing docking after maintenance-point arrival.
    if (this._returnContext !== RETURN_STATES.IDLE || this._safeReturnInProgress || this._returnGuardActive) {
      this.log('return ignored: context already active', this._returnContext, source || 'return');
      return true;
    }

    this._returnRecoveryRequest = { token, source, dockFn, maintenanceFn };

    // A new real return request may supersede an ACTIVE maintenance transit, but
    // must never erase a just-verified maintenance arrival before the return path
    // can consume it. This was the field regression where the mower was already
    // parked at the maintenance point, Return was pressed, and Homey discarded
    // the proof then let the mower drive toward the closed gate.
    const preserveVerifiedMaintenanceArrival = this._manualMaintenanceReached === true
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
    const physicalOutside = this._physicalOutsideRecoveryEvidence()
      || await this._freshPositionProvesOutsideHome();
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
    this._returnDecision = await this._decideReturnPath(source || 'return');
    const sourceText = String(source || '');
    const externalNativeReturn = sourceText.includes('external_status_returning')
      || sourceText.includes('status_returning_confirmed_after_resume');
    // Spatial/front-zone recovery means the mower is already close to the gate or
    // the native return signal was too late. Keep the deterministic maintenance
    // detour for those cases. A timely native `returning` signal, however, is safe
    // to keep on its original route and is intercepted at the A-B safety line.
    const lifecycleReturnTransition = this.device?._pylonLifecycleNeedsTransition?.('return') === true;
    const forceMaintenanceReturn = sourceText.includes('spatial_inbound')
      || sourceText.includes('line_inbound_guard')
      || sourceText.includes('closed_gate_front_zone')
      || lifecycleReturnTransition;
    if (forceMaintenanceReturn) {
      this._returnDecision = { ...(this._returnDecision || {}), mode:'maintenance',
        reason:lifecycleReturnTransition ? 'pylon_lifecycle_return_transition' : 'external_return_safety_route' };
      if (lifecycleReturnTransition) this.log('return forced through maintenance point for native no-go lifecycle transition');
    }
    const dangerNow = await this.markers.dangerState().catch(() => ({ inside: false }));
    if (!forceMaintenanceReturn && this._returnDecision.mode === 'direct' && !dangerNow.inside) {
      if (token !== this._commandToken) { this.log('return cancelled before direct dock', source); return false; }
      this._setReturnContext(RETURN_STATES.DOCK, source || 'return_direct');
      this._pendingDirectDockFn = dockFn;
      this._pendingDirectReturnToken = token;
      this._pendingDirectReturnSource = source || 'return_direct';

      if (externalNativeReturn) {
        // The original MOVA app has already issued the dock command. When the
        // return is recognised early and the mower is still safely outside the
        // danger area, start opening the gate immediately so a continuous return
        // remains possible. The inbound A-B interlock is still authoritative: if
        // the gate has not been released by sensor/timer proof when the mower
        // reaches the line, the mower is paused there until opening is complete.
        this.log('external native return: opening gate in parallel, safety-line interlock armed', sourceText);
        this._timeline(`${this._text('Externe Rückkehr erkannt', 'External return detected')} – ${this._text('Toröffnung gestartet, Sicherheitslinie überwacht', 'gate opening started, safety line monitored')}`, 'return:external_parallel_open');
        this.ensureDoorOpen('external_direct_return_parallel_open', { allowOpenFromDanger: false, allowDegraded: true, reassertDisplayedOpen: true })
          .catch((e) => this.error('external direct return door open', e.message));
        return true;
      }

      // Explicit Homey return: the mower is still awaiting our command. Hold
      // it until the door has a current verified OPEN release (contact or the
      // configured full travel time). External-app returns are handled above.
      const doorReady = await this.ensureDoorOpen('direct_return_before_dock', { allowDegraded: true, reassertDisplayedOpen: true });
      if (!doorReady || token !== this._commandToken || !this._doorOpenReleaseVerified()) {
        await this.returnOperationalHold('return_gate_open_release_unconfirmed');
        return false;
      }
      let dockAccepted;
      try { dockAccepted = await dockFn(); }
      catch (error) {
        this.log('direct return dock command failed', error?.message || String(error));
        await this.returnOperationalHold('return_dock_command_rejected');
        return false;
      }
      if (dockAccepted === false) {
        await this.returnOperationalHold('return_dock_command_rejected');
        return false;
      }
      return true;
    }

    // Near garage, in danger area, or unclear position: deterministic maintenance path.
    if (token !== this._commandToken) { this.log('return cancelled before maintenance', source); return false; }
    this._setReturnContext(RETURN_STATES.MAINTENANCE, source || 'return');
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

    this._manualMaintenanceReached = false;
    this._manualMaintenancePhase = 'idle';
    // Capture the physical start position BEFORE opcode 109. A successful API
    // response is only command acceptance; it is not proof that the mower has
    // actually started toward the maintenance point.
    const maintenanceDepartureStartPos = this.pos() ? { ...this.pos() } : null;
    this._maintenanceDepartureConfirmedAt = 0;
    const maintenanceAccepted = await this._sendMaintenanceWithRetry(maintenanceFn, token, source || 'return');
    const maintenanceCommandAt = Number(this.device._nativeMaintenanceCommandAt || Date.now());
    if (maintenanceAccepted === false) {
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

  _setExternalStartRecoveryPhase(phase, extra = '') {
    this._externalStartRecoveryPhase = phase || null;
    if (phase) this.log('EXTERNAL START RECOVERY:', phase, extra || '');
  }

  noteExternalStartTask(value) {
    // Forward every TASK frame to the independent map-editor transport waiter.
    // This does not classify a garage start and has no effect on recovery state.
    this.device?._noteMapEditTask?.(value);
    // The interrupted opcode arrives as status=false immediately after PAUSE
    // on A2. Capture it BEFORE our STOP replaces TASK with opcode 3.
    if (!this._externalStartRecoveryActive || this._externalStartRecoveryPhase
        || value?.t !== 'TASK' || !value.d || value.d.exe !== true) return;
    const opcode = Number(value.d.o);
    if (![100, 101, 102, 103, 109].includes(opcode)) return;
    this._externalStartTask = JSON.parse(JSON.stringify(value.d));
    this.log('external start original task preserved', `opcode=${opcode}`);
  }

  async _dispatchRecoveredMowingTask(did) {
    if (typeof this.device?._syncPylonLifecyclePhase === 'function') {
      const lifecycle = await this.device._syncPylonLifecyclePhase('departure', { reason:'external_start_recovered' });
      if (lifecycle?.ok === false) {
        this.log('EXTERNAL START RECOVERY: pylon lifecycle preparation failed', lifecycle?.reason || 'unknown');
        await this.safetyBlock('external_start_pylon_lifecycle_failed').catch(() => {});
        return false;
      }
    }
    const task = this._externalStartTask;
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

  async _recoverExternalStartViaNativeStation(source, did) {
    // IMPORTANT: no DOCK/return command is used here. A normal return can start
    // localization/justieren in the narrow garage. We only reuse a genuine
    // firmware-owned station window that survived the early PAUSE + STOP.
    this._setExternalStartRecoveryPhase('VERIFY_NATIVE_STATION_WINDOW', source);

    let station = this._nativeStationContextForExternalRecovery(45000);
    if (!station || Number(station.undocking) !== 0 || this._externalStartStationWindowLost) {
      this.log('EXTERNAL START RECOVERY: native station window lost; no DOCK/return command will be sent',
        station ? `dock=${station.dockingState} undock=${station.undocking}` : 'dock=missing',
        `windowLost=${this._externalStartStationWindowLost ? 1 : 0}`);
      await this.safetyBlock('external_start_recovery_station_window_lost').catch(() => {});
      return false;
    }

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

    // Own the outbound cycle before the fresh start so its new undock edge cannot
    // be mistaken for another vendor-app start interception.
    if (Number(this._externalStartTask?.o) === 109) {
      this._setExternalStartRecoveryPhase('RESTORE_MAINTENANCE', source);
      return this.maintenanceRequested('button_maintenance_external_recovered',
        () => this.device._goToMaintenancePointGuarded('external_recovered_maintenance'));
    }
    await this._beginOutbound('EXTERNAL_START_RECOVERED', true);
    this._setExternalStartRecoveryPhase('FRESH_START', source);

    let startAccepted = true;
    if (typeof this.device._safeWrite === 'function') {
      startAccepted = await this.device._safeWrite('garage_external_recovery_fresh_start', () => this._dispatchRecoveredMowingTask(did));
    } else {
      await this._dispatchRecoveredMowingTask(did);
    }
    if (startAccepted === false) {
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

    // Homey-originated starts already own an outbound guard before the native
    // command is sent. Repeated MQTT task/control pushes during normal outdoor
    // mowing are telemetry, not new starts, and must never pause the mower.
    if (this._outbound || this._missionOutside || this.isReturnCycleActive()) return false;
    if (this._externalStartIntentHandling && now - this._externalStartIntentAt < 120000) return true;

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
      this.realtimeTimelineEvent('external_start', source);
      this._trigger('garage_external_start_blocked', 'external_start_mqtt_intent');
      this.log('EXTERNAL START INTENT: PAUSE and STOP dispatched before user-facing events', source,
        `edge_to_pause_ms=${this._externalStartPauseSentAt - now}`,
        `edge_to_stop_ms=${this._externalStartStopSentAt - now}`,
        `pause_to_stop_ms=${this._externalStartStopSentAt - this._externalStartPauseSentAt}`);
      // UI capability writes can be slow: publish PAUSED only after the native
      // STOP has secured the narrow IN_STATION window.
      if (typeof this.device._applyStatus === 'function') await this.device._applyStatus('paused').catch(() => {});

      // Do NOT establish an outbound cycle yet. At this point the A2 is still
      // genuinely IN_STATION and charging. Starting the outbound guard here made
      // Homey show "Ausfahrt" and arm safety-line monitoring while nothing was
      // moving. The recovered station remains HOME until the fresh 5:1 command is
      // actually about to be sent; _recoverExternalStartViaNativeStation() owns
      // the new outbound cycle immediately before that command.
      this._homeCloseArmed = false;
      this._homeState = 'home';
      this._clearOutboundStatusTimers();
      this._outbound = null;
      this._missionOutside = false;

      const openOk = await this.ensureDoorOpen('external_start', {
        allowOpenFromDanger: true,
        minWaitMs: START_MIN_DOOR_OPEN_WAIT_MS,
      });
      if (!openOk || !this.isDoorOpenStable()) {
        await this.safetyBlock('external_start_gate_open_failed').catch(() => {});
        return false;
      }

      // Do not Resume and do not send DOCK/return. The only allowed recovery is
      // a genuine firmware IN_STATION + undock=0 window surviving PAUSE + STOP
      // through the completed gate opening. Then start a completely fresh task.
      const recovered = await this._recoverExternalStartViaNativeStation(source, did);
      if (!recovered) return false;
      this.log('EXTERNAL START INTENT: gate verified open; native station context recovered and fresh task started', source);
      return true;
    } catch (e) {
      this.error('external start intent interception failed', e.message);
      await this.safetyBlock('external_start_intent_interception_failed').catch(() => {});
      return false;
    } finally {
      this._externalStartIntentHandling = false;
      this._externalStartRecoveryActive = false;
      this._externalStartRecoveryPhase = null;
      this._externalStartRecoveryStartedAt = 0;
      this._externalStartStationWindowConfirmedAt = 0;
      this._externalStartTask = null;
    }
  }

  async onExternalMowingDetected() {
    if (!this.enabled()) return;
    if (this._externalStartRecoveryActive) {
      this.log('external mowing ignored: external-start native-station recovery active', this._externalStartRecoveryPhase || '-');
      return;
    }
    const now = Date.now();
    if ((this._resumeGuardUntil && now < this._resumeGuardUntil) || (this._lastPauseAt && now - this._lastPauseAt < 120000)) {
      this.log('external mowing ignored: pause/resume guard active');
      this._missionOutside = true;
      this._lastOutdoorActivityAt = now;
      await this.refreshTileStatus('resume guard').catch(() => {});
      return;
    }
    if (this._missionOutside && !this.isDockedHomeStatus()) {
      this.log('external mowing ignored: existing outdoor mission');
      this._lastOutdoorActivityAt = now;
      return;
    }
    if (this.sensorEnabled() && !this.isDoorOpenStable()) {
      // External/app/schedule start is a real new mowing cycle. Enter outbound
      // BEFORE opening the gate so stale dock/charging callbacks cannot schedule
      // a home close while the mower is already leaving.
      this._homeCloseArmed = true;
      if (!this._outbound) await this._beginOutbound('EXTERNAL_START', true);
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
      if (this.doorState() === 'opening') {
        this.log('external mowing during gate opening: outbound lock active until exit line');
        return;
      }
      this.log('external mowing detected while gate not open: open gate and keep close locked');
      this._trigger('garage_external_start_blocked', 'external_start_gate_not_open');
      const ok = await this.ensureDoorOpen('external_start', { allowOpenFromDanger: true });
      if (ok) await this._markOutboundReleased().catch((e) => this.error('external outbound release', e.message));
    } else if (!this._outbound) {
      this._homeCloseArmed = true;
      await this._beginOutbound('EXTERNAL_START', true);
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
      await this._markOutboundReleased().catch((e) => this.error('external outbound release', e.message));
    }
  }

  async _interceptExternalReturn(source = 'external_return', observedStatus = '') {
    if (!this.enabled() || this.isDockedHomeStatus()) return false;
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
    if (this._returnGuardActive || this._safeReturnInProgress || this._externalReturnHandling || this._spatialReturnHandling) return true;
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

      return await this.returnRequested(`external_${source}`,
        async () => {
          const accepted = await this.device._safeWrite(`garage_${source}_dock`, () => this.device._api.dock(did));
          if (accepted === false) return false;
          await this.device._applyStatus('returning', 0, false);
          return true;
        },
        async () => this.device._goToMaintenancePointGuarded(`garage_${source}_maintenance`),
      );
    } finally {
      this._externalReturnHandling = false;
      this._spatialReturnHandling = false;
    }
  }


  async _detectClosedGateFrontReturn(danger) {
    const now = Date.now();
    const status = String(this.status() || '').toLowerCase();
    const doorClosed = this.doorState() === 'closed';
    const resumeGuardActive = !!(this._resumeGuardUntil && now < this._resumeGuardUntil);
    const blockedStatus = ['paused', 'idle', 'standby'].includes(status);
    const returnInactive = !this._outbound && !this._safeReturnInProgress
      && !this._returnGuardActive && !this._externalReturnHandling
      && !this._frontGateReturnHandling && !this.isDockedHomeStatus();

    if (!doorClosed || !this._missionOutside || resumeGuardActive || !blockedStatus || !returnInactive || this._isUserPauseGuardActive()) {
      this._frontGateReturnSamples = [];
      return false;
    }

    const pos = this.pos();
    const dock = this.device._dockPos || this.device._cachedMapData?.chargerPos || null;
    const distanceToDockMm = this._distance(pos, dock);
    if (!pos || !dock || distanceToDockMm == null || distanceToDockMm < 650 || distanceToDockMm > 2300) {
      this._frontGateReturnSamples = [];
      return false;
    }

    // The mower is in the narrow approach area immediately in front of the
    // closed gate. Require several fresh samples and either a clear approach
    // trend or a stable blocked position. This avoids reviving the old generic
    // line-crossing false return while still catching the real external-app case.
    const samples = this._frontGateReturnSamples || [];
    samples.push({ ts: now, x: Number(pos.x), y: Number(pos.y), distanceToDockMm });
    while (samples.length && now - samples[0].ts > 12000) samples.shift();
    if (samples.length > 12) samples.splice(0, samples.length - 12);
    this._frontGateReturnSamples = samples;

    if (samples.length < 4) return false;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const observedMs = last.ts - first.ts;
    const approachMm = first.distanceToDockMm - last.distanceToDockMm;
    const movementMm = this._distance(first, last) || 0;
    const approaching = observedMs >= 3000 && approachMm >= 250;
    const blockedStable = observedMs >= 7000 && movementMm <= 350;
    if (!approaching && !blockedStable) return false;
    if (this._frontGateReturnTriggeredAt && now - this._frontGateReturnTriggeredAt < 120000) return false;

    this._frontGateReturnTriggeredAt = now;
    this._frontGateReturnHandling = true;
    this.log('closed gate front-zone external return suspected', `status=${status}`, `dist=${Math.round(distanceToDockMm)}mm`, approaching ? `approach=${Math.round(approachMm)}mm` : `stable=${Math.round(movementMm)}mm`);
    this._timeline(`${this._text('Externe Rückkehr vor geschlossenem Tor erkannt', 'External return detected in front of closed gate')} – ${this._text('Umleitung über Wartungspunkt', 'rerouting via maintenance point')}`, 'return:closed_gate_front_zone');
    try {
      await this._interceptExternalReturn('closed_gate_front_zone', status);
      return true;
    } finally {
      this._frontGateReturnHandling = false;
      this._frontGateReturnSamples = [];
    }
  }

  async _routeClosedGateReturnViaMaintenance(reason = 'closed_gate_return') {
    // A stationary CLOSED gate in front of a returning mower is a recoverable
    // routing condition, not an Emergency. Emergency is reserved for the real
    // collision hazard: mower in the danger area WHILE the gate is moving.
    if (this._manualGateStopped || !this.isReturnCycleActive()) return false;
    if (this._returnContext === RETURN_STATES.MAINTENANCE) return true;
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

    // Stop the current return before changing its destination. This is a one-way
    // native PAUSE and must be confirmed by a fresh native PAUSED status.
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
    if (token !== this._commandToken || this._manualGateStopped
        || !(await this._waitForNativePause(token, pauseRequestedAt))) {
      await this.returnOperationalHold('return_closed_gate_pause_unconfirmed');
      return false;
    }

    await this._lockReturnMaintenancePoint(`closed_gate_recovery_${reason}`);
    if (token !== this._commandToken || this._manualGateStopped) return false;
    if (!this._lockedReturnMaintenancePoint) {
      await this.returnOperationalHold('return_closed_gate_maintenance_point_unavailable');
      return false;
    }
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
    let maintenanceAccepted = false;
    if (typeof this.device._goToMaintenancePointGuarded === 'function') {
      maintenanceAccepted = await this.device._goToMaintenancePointGuarded(`garage_return_recovery_${reason}`);
    } else if (typeof this.device.cmdGoToMaintenancePoint === 'function') {
      maintenanceAccepted = await this.device.cmdGoToMaintenancePoint();
    }
    if (token !== this._commandToken || this._manualGateStopped) return false;
    if (maintenanceAccepted === false) {
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
    });
    return true;
  }

  async _detectSpatialExternalReturn(danger, line) {
    if (!this.enabled() || !this._missionOutside || this._outbound || this.isDockedHomeStatus()) return false;
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

  _scheduleSuspectedPausedReturn(prevStatus = '') {
    if (this._suspectedPausedReturnTimer || !this.enabled()) return;
    const action = String(this.lastRequestedAction || '').toLowerCase();
    const explicitPause = this._isUserPauseGuardActive()
      || action.includes('pause')
      || action.includes('resume')
      || (this._resumeGuardUntil && Date.now() < this._resumeGuardUntil);
    if (explicitPause) return;
    this.log('unexpected paused outside: verifying possible safety return', 'prev=', prevStatus || '-');
    this._suspectedPausedReturnTimer = setTimeout(async () => {
      this._suspectedPausedReturnTimer = null;
      if (!this.enabled() || !this._missionOutside || this.isDockedHomeStatus()) return;
      if (this.status() !== 'paused') return;
      if (this._isUserPauseGuardActive()) return;
      if (this._returnGuardActive || this._safeReturnInProgress || this._externalReturnHandling) return;
      this._externalReturnHandling = true;
      const did = this.device.getData().id;
      this.log('unexpected paused persisted outside: start safe return');
      await this.returnRequested('external_paused_safety_return',
        async () => {
          await this.device._safeWrite('garage_external_paused_dock', () => this.device._api.dock(did));
          await this.device._applyStatus('returning', 0, false);
        },
        async () => this.device._goToMaintenancePointGuarded('garage_external_paused_maintenance'),
      ).finally(() => { this._externalReturnHandling = false; });
    }, 12000);
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
    if (status !== 'paused') this._cancelSuspectedPausedReturn();
    if (status !== 'returning' && this._resumeNativeReturnTimer) {
      clearTimeout(this._resumeNativeReturnTimer);
      this._resumeNativeReturnTimer = null;
    }
    if (this._resumeGuardUntil && Date.now() < this._resumeGuardUntil && status === 'returning') {
      this._scheduleNativeReturnDuringResumeGuard(status);
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
      await this.refreshTileStatus('native return verification during resume guard').catch(() => {});
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
      if (nativeHomeSignal && binary && Number(this.device?._mowerBinaryDiagAt || 0) > 0
          && binaryAge >= 0 && binaryAge <= 15000
          && (binary.dockingState !== 'IN_STATION' || Number(binary.undocking) === 1)) {
        this.log('native home frame held: fresh binary docking telemetry contradicts station arrival', binary.dockingState);
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
      if (this.doorState() === 'closing') {
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
        this._scheduleSuspectedPausedReturn(prevStatus);
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
    if (this._manualGateStopped) return;
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
    const remainingStableMs = Math.max(0, DOCK_HOME_CONFIRM_MS - elapsedStable);
    this.log('home detected; close scheduled after remaining stable dock time', `${Math.ceil(remainingStableMs / 1000)}s`, reason || '');
    this._closeTimer = setTimeout(async () => {
      try {
        if (homeToken !== this._commandToken || this._manualGateStopped || dockEpoch !== this._homeDockEpoch) return;
        if (!this.enabled()) { this._closeScheduled = false; return; }
        const recentConfirmedHome = this._homeCycleLocked
          && this._lastHomeAt
          && Date.now() - this._lastHomeAt < 5 * 60 * 1000;
        if (!this.isDockedHomeStatus() && !recentConfirmedHome) {
          this._closeScheduled = false;
          this._invalidateHomeClose('home_status_lost');
          this.log('home confirmation cancelled: mower no longer docked/charging');
          return;
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

  async confirmNativeMaintenanceArrival(reason = 'native_arrival', confirmedPosition = null) {
    // This is the single authoritative completion path for a maintenance
    // journey. It may be called either by the geometric watcher or directly by
    // device.js when firmware status 75 / a stable native arrival is observed.
    // Keeping the journey context latched until here prevents sensor timeout,
    // Ausfahrt states or cloud packet ordering from losing the first arrival.
    if (!this._maintenanceRequestedAt && !this._manualMaintenanceTransit
        && this._returnContext !== RETURN_STATES.MAINTENANCE) return false;

    clearInterval(this._maintenanceWatch);
    this._maintenanceWatch = null;
    this._maintenanceStartPos = null;
    this._maintenanceStableHits = 0;
    this._maintenanceLastConfirmPositionTs = 0;
    this._lastMaintenanceReachedAt = Date.now();

    const existingPoint = typeof this.device._resolveStableMaintenancePoint === 'function'
      ? await this.device._resolveStableMaintenancePoint().catch(() => null)
      : null;
    const reachedPos = confirmedPosition || this.pos();
    const reachedDistance = existingPoint && reachedPos ? this._distance(reachedPos, existingPoint) : null;

    // The original-app/native map maintenance marker is the coordinate authority.
    // A normal arrival proves that the mower reached that point; it must NOT move
    // the stored target to the robot's final wheel position. Only first discovery
    // (no known point at all) may learn the coordinate from a verified arrival.
    if (!existingPoint && reachedPos && typeof this.device._storeVerifiedMaintenancePoint === 'function') {
      await this.device._storeVerifiedMaintenancePoint(reachedPos, 'maintenance_arrival_initial_set').catch(() => null);
      this.log('initial maintenance marker learned from physical arrival',
        `${Math.round(reachedPos.x)},${Math.round(reachedPos.y)}`);
    } else if (existingPoint) {
      this.log('existing maintenance marker preserved',
        `${Math.round(existingPoint.x)},${Math.round(existingPoint.y)}; arrivalDistance=${reachedDistance == null ? 'unknown' : `${Math.round(reachedDistance)}mm`}`);
    }

    this._manualMaintenanceCalibration = false;
    this._manualMaintenanceRecalibration = false;
    this._manualMaintenanceTransit = false;
    this._manualMaintenanceReached = true;
    this._manualMaintenancePhase = 'reached';
    this._manualMaintenancePhaseStartedAt = Date.now();
    this._manualMaintenanceMovementSeen = false;
    this._manualMaintenanceLastPos = null;
    this._manualMaintenanceStableSince = 0;
    this.log('maintenance point reached', reason);
    this._trigger('garage_maintenance_point_reached', 'verified');
    await this.refreshTileStatus('maintenance point reached').catch(() => {});

    const callback = this._maintenanceReachedCallback;
    this._maintenanceReachedCallback = null;
    this._maintenanceTimeoutCallback = null;
    if (callback) await callback();
    return true;
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
      if (token !== this._commandToken || this._manualGateStopped) return;

      if (departureRequired && !departureConfirmed) {
        const evidence = this._maintenanceDepartureEvidence(this._maintenanceStartPos, current, departureCommandAt, now);
        if (evidence.fresh && evidence.moved) {
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
        } else if (evidence.fresh) {
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
              if (token !== this._commandToken || this._manualGateStopped) return;
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

      const reached = await this.isAtMaintenancePointHeuristic();
      if (token !== this._commandToken || this._manualGateStopped) return;
      if (reached) {
        await this.confirmNativeMaintenanceArrival('heuristic_verified_arrival', this.pos());
      } else if (now - this._maintenanceRequestedAt > MAINTENANCE_TIMEOUT_MS) {
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
        await this.refreshTileStatus('maintenance point timeout').catch(() => {});
        this.log('maintenance point timeout', `status=${this.status()}`, `pos=${this.pos() ? `${Math.round(this.pos().x)},${Math.round(this.pos().y)}` : 'unknown'}`, `elapsed=${Date.now() - this._maintenanceRequestedAt}ms`);
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
        await this.confirmNativeMaintenanceArrival('mqtt_live_position_verified_arrival', current);
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
      const statusAllowed = !['remote_control', 'mapping', 'error', 'returning', 'docked', 'charging'].includes(s);
      const stationary = drift != null && drift <= MAINTENANCE_STATIONARY_DRIFT_MM;
      const target = typeof this.device._resolveStableMaintenancePoint === 'function'
        ? await this.device._resolveStableMaintenancePoint().catch(() => null)
        : await safeGetStoreValue(this.device, 'garage_maintenance_point');
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
      || (typeof this.device._resolveStableMaintenancePoint === 'function'
        ? await this.device._resolveStableMaintenancePoint().catch(() => null)
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

    // In the station the garage safety cycle is idle. Do not log danger-area
    // changes or fire emergency logic until a new start/return cycle begins.
    if (this.isDockedHomeStatus() && !this._outbound && !this._safeReturnInProgress && !this._returnGuardActive) {
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
      await this._routeClosedGateReturnViaMaintenance('closed_gate_return_danger');
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
    const cautionRadius = Number(this.device.getSetting('garage_caution_radius_mm') || 0);
    const inConfiguredCaution = Number.isFinite(cautionRadius) && cautionRadius > 0
      && danger.distance !== null && Number(danger.distance) <= cautionRadius;
    const nearSafetyLine = !!line?.onSegment && Number.isFinite(Number(line.distance))
      && Math.abs(Number(line.distance)) <= RETURN_PRELINE_STOP_MM;
    // Hard pre-entry hold for EVERY active return. Previously this guard only
    // applied when a direct-dock callback was armed. If a maintenance detour was
    // rejected/overridden by firmware, the mower could therefore approach and
    // cross the safety line with a closed gate. The A-B line is a physical safety
    // barrier and must not depend on which return route currently owns the state.
    if (returnActive && this._returnContext !== RETURN_STATES.MAINTENANCE
        && onLawnSide && !this.isDoorOpenStable()
        && (inConfiguredCaution || nearSafetyLine) && !this._awaitingLineDoorOpen) {
      const reason = inConfiguredCaution ? 'configured_caution_zone' : 'pre_safety_line';
      this.log('return pre-entry hold', reason,
        `dangerDistance=${danger.distance == null ? '?' : Math.round(danger.distance)}mm`,
        `lineDistance=${line.distance == null ? '?' : Math.round(Math.abs(line.distance))}mm`);
      const token = this._pendingDirectReturnToken || this._commandToken;
      const sourceName = this._pendingDirectReturnSource || `return_${reason}`;
      const dockAgain = this._pendingDirectDockFn || (async () => {
        const did = this.device.getData().id;
        await this.device._safeWrite('garage_return_preline_release_dock', () => this.device._api.dock(did));
        await this.device._applyStatus('returning', 0, false);
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
      }
      if (!this._outbound && this._missionOutside && inboundDirection && resumeStabilizing) {
        this.log('inbound safety-line sample ignored during resume stabilization', direction);
      }
      if ((this.isReturning() || this._safeReturnInProgress || this._returnGuardActive)
          && this._returnContext !== RETURN_STATES.MAINTENANCE) {
        if (!inboundDirection) {
          this.log('safety line crossing during return ignored: wrong direction', direction);
        } else {
          this.log('safety line crossed lawn->garage during return', direction);
          const doorReady = this.isDoorOpenStable();
          if (!doorReady && !this._awaitingLineDoorOpen) {
            const token = this._pendingDirectReturnToken || this._commandToken;
            const sourceName = this._pendingDirectReturnSource || 'return_line_crossing';
            const dockAgain = this._pendingDirectDockFn || (async () => {
              const did = this.device.getData().id;
              await this.device._safeWrite('garage_return_line_release_dock', () => this.device._api.dock(did));
              await this.device._applyStatus('returning', 0, false);
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
    if (line.stable && side !== null && !shallowSideChange) this._lastLineSide = side;

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
      const caution = Number(this.device.getSetting('garage_caution_radius_mm') || 0);
      if (Number.isFinite(caution) && caution > 0 && data.dangerCenter) data.cautionRadius = caution;
    }

    // RC110: the maintenance point is immutable map configuration. Never use
    // the current mower position, dock or any telemetry coordinate as a visual
    // fallback. A partial map update must retain the persisted verified marker;
    // if it is genuinely unavailable, omit it rather than displaying a dangerous
    // false target that appears to jump across the lawn.
    const stored = typeof this.device._resolveStableMaintenancePoint === 'function'
      ? await this.device._resolveStableMaintenancePoint().catch(() => null)
      : await safeGetStoreValue(this.device, 'garage_maintenance_point');
    if (stored && Number.isFinite(Number(stored.x)) && Number.isFinite(Number(stored.y))) {
      data.maintenancePoint = { x: Number(stored.x), y: Number(stored.y), source: stored.source || 'stored' };
    } else {
      delete data.maintenancePoint;
    }
    return Object.keys(data).length ? data : null;
  }
}

module.exports = GarageSafetyEngine;
