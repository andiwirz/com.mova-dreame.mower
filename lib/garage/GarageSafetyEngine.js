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
const MAINTENANCE_TIMEOUT_MS = 90000;
const OUTBOUND_MOWING_STABLE_MS = 3000; // RC59: require stable native mowing after the physical line crossing
const OUTBOUND_EXITING_DISPLAY_MS = 5000;
const MIN_ADJUSTING_MS = 45000;
const POSITIONING_FALLBACK_MS = 30000;
const OUTBOUND_FREE_DRIVE_MS = 50000;
const SENSOR_WATCHDOG_DEFAULT_MINUTES = 30;
const DEGRADED_DOOR_WAIT_MS = 25000;
const DEGRADED_DOCK_TIMEOUT_MS = 180000;
const EMERGENCY_HOLD_MS = 120000;
const DOOR_SENSOR_TIMEOUT_MS = 30000;
const DEFAULT_MOWER_SPEED_KMH = 1.8;
const RETURN_NEAR_HALF_RATIO = 0.5;
const RETURN_LINE_WAIT_TIMEOUT_MS = 180000;
const START_MIN_DOOR_OPEN_WAIT_MS = 30000;
const START_AFTER_OPEN_EXTRA_WAIT_MS = 3000;
const OUTBOUND_IGNORE_HOME_MS = 6 * 60 * 1000;
const POSITION_CACHE_MS = 15000;
const START_CONFIRM_NOTICE_MS = 15000;
const START_CONFIRM_TIMEOUT_MS = 45000;
const START_ONLINE_PREFLIGHT_TIMEOUT_MS = 30000;
const START_ONLINE_PREFLIGHT_POLL_MS = 5000;
const START_CONFIRM_MOVEMENT_MM = 250;
const SAFETY_LINE_ARM_SAMPLES = 3;
const SAFETY_LINE_CLEARANCE_MM = 800;
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
    this._maintenanceStartPos = null;
    this._maintenanceStableHits = 0;
    this._lastMaintenanceReachedAt = 0;

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
    this._outboundFallbackMowingAllowed = false;
    this._lastHomeAt = 0;
    this._returnGuardActive = false;
    this._externalReturnHandling = false;
    this._homeState = 'unknown';
    this._missionOutside = false;
    this._lastOutdoorActivityAt = 0;
    this._safeReturnInProgress = false;
    this._lastTimelineKey = '';
    this._lastTimelineAt = 0;
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
    this._lastGateOpenHandshakeAt = 0;
    this._lastDoorOpenReleaseAt = 0;
    this._lastSensorSignalAt = 0;
    this._lastMarkerSetupWarningAt = 0;
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
    this._emergencyHoldUntil = 0;
    this._dangerReleasedAfterExit = false;
    // RC36: after an app restart / reinstall the mower may already report
    // docked/charging while the door is open. This must never create an
    // automatic close request. Only a real garage session started in this
    // runtime may schedule Home -> close.
    this._homeCloseArmed = false;
    this._bootHomeCloseSuppressUntil = Date.now() + 5 * 60 * 1000;

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
    this._startConfirmInitialPos = null;
    this._startConfirmSource = null;
    this._outboundExitLocked = false;
    this._movingGateStartWarningShown = false;
    this._dangerOutsideSince = 0;
    this._dangerExitFallbackStarted = false;
    this._exitPauseForCloseActive = false;
    // RC60: hard gate-motion interlock. While the gate is moving, a moving mower
    // may not enter/continue through the danger area. Closing + mower in danger
    // always reverses to open (except confirmed safe-home closing). Opening holds
    // the mower paused until the door is stably open.
    this._gateMotionDangerHits = 0;
    this._gateMotionDangerState = null;
    this._gateMotionDangerFirstAt = 0;
    this._gateMotionPauseActive = false;
    this._gateMotionPauseMode = null;
    this._gateMotionPauseAt = 0;
    this._pendingEmergencyMaintenanceReason = null;
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
  }

  cancelPendingCommand(reason = 'superseded') {
    this._commandToken += 1;
    this.log('cancel pending garage command', reason, 'token=', this._commandToken);
    clearInterval(this._maintenanceWatch);
    this._maintenanceWatch = null;
    this._maintenanceStartPos = null;
    this._maintenanceStableHits = 0;
    this._maintenanceRequestedAt = 0;
    this._lastMaintenanceReachedAt = 0;
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
    this._dangerExitFallbackStarted = false;
    this._exitPauseForCloseActive = false;
    this._gateMotionDangerHits = 0;
    this._gateMotionDangerState = null;
    this._gateMotionDangerFirstAt = 0;
    this._gateMotionPauseActive = false;
    this._gateMotionPauseMode = null;
    this._gateMotionPauseAt = 0;
    this._pendingEmergencyMaintenanceReason = null;
    this._spatialReturnSamples = [];
    this._spatialReturnTriggeredAt = 0;
    this._spatialReturnHandling = false;
    this._frontGateReturnSamples = [];
    this._frontGateReturnTriggeredAt = 0;
    this._frontGateReturnHandling = false;
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
    // In normal mode keep the timeline readable: retain user actions, states,
    // door requests, safety-line decisions and real blocks, but hide repeated
    // technical sensor/position fallback chatter. Verbose debug can be enabled
    // in settings for full field diagnostics.
    if (!debug) {
      const lower = clean.toLowerCase();
      const keep = lower.includes('sicherheitslinie') || lower.includes('safety line')
        || lower.includes('exit confirmed') || lower.includes('door close allowed')
        || lower.includes('tor ') || lower.includes('garage') || lower.includes('status:')
        || lower.includes('taste ') || lower.includes('rückkehr') || lower.includes('wartungspunkt')
        || lower.includes('zuhause') || lower.includes('blockiert') || lower.includes('notfall');
      const noisy = lower.includes('sensor unhealthy') || lower.includes('sensor timeout')
        || lower.includes('fallback sensor timeout') || lower.includes('speed basis')
        || lower.includes('return context: idle') || lower.includes('return context: home_confirmed');
      if (noisy && !keep) return;
    }
    const text = `[Garage] ${clean.slice(0, 220)}`;
    const now = Date.now();
    const dedupeKey = String(key || text).replace(/^flush:/, '');
    if (!this._timelineSeen) this._timelineSeen = new Map();
    const last = this._timelineSeen.get(dedupeKey) || 0;
    // Homey timeline must be readable. Suppress repeated poll/guard events for a
    // short window, while still keeping state changes and real blocks visible.
    const quietKey = String(key || '').replace(/^flush:/, '');
    const quietMs = quietKey && quietKey.startsWith('state:') ? 60000 : 10000;
    if (now - last < quietMs) return;
    this._timelineSeen.set(dedupeKey, now);
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
      garage_exiting: T('Ausfahrt', 'Exiting'), garage_free_drive: T('Positionieren', 'Positioning'), garage_positioning: T('Positionieren', 'Positioning'),
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
    if (first === 'maintenance point reached') return { key: 'state:maintenance_reached', msg: T('Wartungspunkt erreicht', 'Maintenance point reached') };
    if (first === 'return continues from maintenance point') return { key: 'state:return_continue_from_maintenance', msg: T('Rückkehr vom Wartungspunkt zur Garage fortgesetzt', 'Return from maintenance point to garage continued') };
    if (first === 'maintenance point timeout') return { key: 'block:maintenance_timeout', msg: T('Wartungspunkt Timeout – blockiert', 'Maintenance point timed out – blocked') };
    if (first === 'danger area') return { key: `state:danger:${second}`, msg: second === 'inside' ? T('Mäher im Gefahrenbereich', 'Mower in danger area') : T('Mäher außerhalb Gefahrenbereich', 'Mower outside danger area') };
    if (first === 'line state') return { key: `state:line:${second}`, msg: `${T('Sicherheitslinie', 'Safety line')}: ${second}${third ? ` – ${this._humanReason(third)}` : ''}` };
    if (first === 'exit confirmed') return { key: 'state:line:exit_confirmed', msg: T('Ausfahrt bestätigt', 'Exit confirmed') };
    if (first === 'door close allowed') return { key: 'state:line:door_close_allowed', msg: T('Tor darf geschlossen werden', 'Door may be closed') };
    if (first === 'return context') return this.device.getSetting('garage_debug_verbose') ? { key: `state:return:${second}`, msg: `${T('Rückkehrstatus', 'Return context')}: ${second}` } : null;
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
    const r = String(reason || '').replace(/^ERROR\s+/, '');
    const T = (de, en) => this._text(de, en);
    const known = {
      garage_open_timeout: T('Tor hat nicht rechtzeitig offen gemeldet', 'Door did not report open in time'),
      close_blocked_door_moving: T('Tor bewegt sich gerade', 'Door is moving'),
      close_blocked_markers_incomplete: T('Marker unvollständig', 'Markers incomplete'),
      markers_incomplete_close_disabled: T('Marker unvollständig, automatisches Schließen gesperrt', 'Markers incomplete, automatic closing disabled'),
      close_blocked_position_unknown: T('Position unklar', 'Position uncertain'),
      close_blocked_mower_in_danger_area: T('Mäher im Gefahrenbereich', 'Mower in danger area'),
      close_blocked_adjusting_active: T('Justieren aktiv', 'Adjusting active'),
      maintenance_point_timeout: T('Wartungspunkt nicht erreicht', 'Maintenance point not reached'),
      maintenance_point_timeout_mower_in_danger_area: T('Wartungspunkt-Timeout, Mäher noch im Gefahrenbereich', 'Maintenance-point timeout, mower still in danger area'),
      maintenance_reached_close: T('Wartungspunkt erreicht', 'Maintenance point reached'),
      external_start: T('Externer Start', 'External start'),
      return_from_maintenance: T('Rückkehr vom Wartungspunkt', 'Return from maintenance point'),
      no_sensor_delay_elapsed: T('Sicherheitszeit ohne Sensor abgelaufen', 'Safety delay without sensor elapsed'),
      stable_open: T('Tor stabil offen', 'Door stably open'),
      home_15s: T('Zuhause 15 Sekunden stabil', 'Home stable for 15 seconds'),
      already_home: T('Bereits Zuhause', 'Already home'),
      sensor_watchdog_timeout: T('Torsensor meldet sich nicht', 'Door sensor is not responding'),
      sensor_watchdog_timeout_fallback_to_timer: T('Torsensor meldet sich nicht, Zeitsteuerung wird genutzt', 'Door sensor is not responding, timer fallback is used'),
      sensor_offline_fallback_to_timer: T('Torsensor offline, Zeitsteuerung wird genutzt', 'Door sensor offline, timer fallback is used'),
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

  async _decideReturnPath(source = 'return') {
    const pos = this.pos();
    const dock = this.device._dockPos || this.device._cachedMapData?.chargerPos || null;
    const boundary = this._mapBoundaryNormalized();
    const speed = this._speedMetersPerSecond();
    const distanceToDockMm = this._distance(pos, dock);
    const diagMm = boundary ? Math.sqrt(Math.pow(boundary.maxX-boundary.minX,2)+Math.pow(boundary.maxY-boundary.minY,2)) : null;
    const halfMm = diagMm ? diagMm * RETURN_NEAR_HALF_RATIO : null;
    const etaSec = distanceToDockMm != null ? Math.round((distanceToDockMm/1000) / speed.mps) : null;
    this.log('speed basis', speed.basis, `dist=${distanceToDockMm == null ? '?' : Math.round(distanceToDockMm)}mm eta=${etaSec == null ? '?' : etaSec+'s'} source=${source}`);
    if (!pos || !dock || !boundary || !halfMm || distanceToDockMm == null) {
      const detail = `pos=${!!pos} dock=${!!dock} map=${!!boundary}; ${speed.basis}`;
      this.log('return decision', 'position_unclear_use_maintenance', detail);
      return { mode: 'maintenance', reason: 'position_unclear_use_maintenance', detail, etaSec, distanceToDockMm };
    }
    if (distanceToDockMm <= halfMm) {
      const detail = `distance=${Math.round(distanceToDockMm)}mm <= half=${Math.round(halfMm)}mm; ${speed.basis}; eta=${etaSec}s`;
      this.log('return decision', 'half_map_near_garage', detail);
      return { mode: 'maintenance', reason: 'half_map_near_garage', detail, etaSec, distanceToDockMm };
    }
    const detail = `distance=${Math.round(distanceToDockMm)}mm > half=${Math.round(halfMm)}mm; ${speed.basis}; eta=${etaSec}s`;
    this.log('return decision', 'half_map_far_from_garage', detail);
    return { mode: 'direct', reason: 'half_map_far_from_garage', detail, etaSec, distanceToDockMm };
  }

  async _waitAtSafetyLineUntilDoorOpenThenDock(dockFn, token, source) {
    if (token !== this._commandToken) return false;
    this._awaitingLineDoorOpen = true;
    this.log('return wait at safety line', 'safety_line_wait_door_not_open', source || 'return');
    await this.device.cmdPause().catch(() => {});
    const ok = await this.ensureDoorOpen('return_safety_line_wait', { allowOpenFromDanger: true, allowDegraded: true });
    if (!ok) {
      this._awaitingLineDoorOpen = false;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._suspectedPausedReturnTimer = null;
      await this.safetyBlock('garage_cannot_open_at_safety_line');
      return false;
    }
    if (token !== this._commandToken) { this._awaitingLineDoorOpen = false; return false; }
    this.log('return line wait released', 'door_open_stable', source || 'return');
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
    if (['mowing', 'mapping', 'remote_control'].includes(s)) {
      this.log('return prepare: pause mower before path command', source || 'return', 'status=', s);
      await this.device.cmdPause().catch((e) => this.error('return prepare pause', e.message));
      await sleep(2500);
    }
  }

  async _sendMaintenanceWithRetry(maintenanceFn, token, source = 'return') {
    if (token !== this._commandToken) return false;
    await this._prepareMowerForReturnPath(source);
    let accepted = await maintenanceFn();
    if (accepted === false) return false;
    await sleep(3500);
    // If the cloud is still reporting active mowing after the maintenance point
    // request, send one explicit retry.  The retry is harmless if the first
    // command was already accepted, but it fixes the field regression where the
    // mower simply continued mowing in the background.
    if (token !== this._commandToken) return false;
    if (['mowing', 'mapping', 'remote_control'].includes(this.status())) {
      this.log('maintenance command retry: mower still active after first request', source || 'return');
      await this.device.cmdPause().catch((e) => this.error('maintenance retry pause', e.message));
      await sleep(1500);
      accepted = await maintenanceFn();
      if (accepted === false) return false;
    }
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
  _startSensorWatchdog() {
    // RC2.1: The door contact sensor is only judged during an expected
    // open/close movement. In idle/home/mowing phases we must not mark it
    // offline just because it has not emitted a signal recently.
    if (this._sensorWatchdogTimer) clearInterval(this._sensorWatchdogTimer);
    this._sensorWatchdogTimer = null;
    this._lastSensorContactAt = 0;
    this._lastSensorContactState = null;
  }
  _stopSensorWatchdog() {
    if (this._sensorWatchdogTimer) clearInterval(this._sensorWatchdogTimer);
    this._sensorWatchdogTimer = null;
    this._lastSensorContactAt = 0;
    this._lastSensorContactState = null;
  }
  sensorEnabled() { return !!this.device.getSetting('garage_sensor_enabled'); }
  sensorDoorReliable() { return this.sensorEnabled() && this.sensorHealthy(); }
  doorState() { return this.device.getCapabilityValue('garage_door_status') || 'unknown'; }
  isDoorOpenStable() { return this.doorState() === 'open' && !this._stableOpenTimer; }

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

  _outboundPhaseProtected() {
    if (!this._outbound) return false;
    const releasedAt = Number(this._outbound.originalCommandSentAt || this._outbound.requestedAt || Date.now());
    const elapsed = Math.max(0, Date.now() - releasedAt);
    // Absolute rule from field tests: Ausfahrt, Justieren and Positionieren must
    // never share the doorway with a closing gate. Only after the full configured
    // outbound display window may a fallback close be considered. A real line
    // crossing is also queued until that protected phase has ended.
    return elapsed < (MIN_ADJUSTING_MS + POSITIONING_FALLBACK_MS);
  }

  _outboundCloseProtected() {
    return !!this._outbound && (
      this._outboundPhaseProtected()
      || !(this._lineToLawnConfirmed && this._lineState === LINE_STATES.DOOR_CLOSE_ALLOWED)
    );
  }

  async _waitForDoorClosedOrTimeout() {
    const fallbackMs = Math.max(0, this._doorCloseDurationSeconds() * 1000);
    const maxWait = this.sensorDoorReliable() ? DOOR_SENSOR_TIMEOUT_MS + fallbackMs + 3000 : fallbackMs + 3000;
    const deadline = Date.now() + Math.max(3000, maxWait);
    while (Date.now() < deadline) {
      if (this.doorState() === 'closed') return true;
      await sleep(EXIT_RESUME_AFTER_CLOSE_POLL_MS);
    }
    return this.doorState() === 'closed';
  }

  async _pauseCloseResumeAfterExit(reason) {
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
        await this.device._safeWrite('garage_exit_pause_before_close', () => this.device._api.pause(did));
        pausedByGarage = true;
        await this.device._applyStatus('paused').catch(() => {});
        this.log('mower paused for safe garage close', reason || 'exit');
        if (EXIT_PAUSE_SETTLE_MS > 0) await sleep(EXIT_PAUSE_SETTLE_MS);
      }
      const closeOk = await this.requestClose(reason || 'exit_confirmed', { requireExitConfirmed: true });
      if (!closeOk) return false;
      const closed = await this._waitForDoorClosedOrTimeout();
      if (!closed) {
        this.log('door close completion not confirmed; mower remains paused', reason || 'exit');
        return false;
      }
      if (pausedByGarage && !this.isReturning() && !this._safeReturnInProgress) {
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
      const closeOk = await this.requestClose(reason || 'safe_exit', { requireExitConfirmed: true });
      if (!closeOk) {
        this._closeAfterExitRequested = false;
        return false;
      }
      const closed = await this._waitForDoorClosedOrTimeout();
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
    if (ts > 0 && Date.now() - ts > EXIT_POSITION_MAX_AGE_MS) return null;
    return p;
  }

  async _evaluateOutboundClosePriorities(danger, line) {
    if (!this.enabled() || !this._outbound || this._closeAfterExitRequested || this.isReturning()) return false;
    if (this._outboundPhaseProtected()) return false;
    if (this.status() !== 'mowing') return false;
    if (!danger || danger.inside) return false;
    if (!this._dangerOutsideSince || Date.now() - this._dangerOutsideSince < DANGER_EXIT_STABLE_MS) return false;
    if (!this._freshPositionForExitDecision()) return false;

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

    // Priority 2 runs in parallel with ETA. One confirmed Garage→Lawn crossing
    // plus ten uninterrupted seconds on the lawn side is sufficient even when
    // the conservative ETA calculation cannot decide. No pause is sent.
    if (onLawnSide && Number(this._outbound.lineCrossAttempts || 0) >= 1
        && lawnDwellMs >= SAFETY_LINE_DWELL_FALLBACK_MS) {
      this.log('lawn side stable for close', `dwell=${lawnDwellMs}ms attempts=${this._outbound.lineCrossAttempts}`);
      return this._closeAfterExitWithoutPause('priority_2_line_dwell');
    }

    // Priority 3 is the final fallback only: after two failed dwell attempts,
    // the third confirmed Garage→Lawn crossing pauses once, closes, then resumes.
    if (onLawnSide && Number(this._outbound.lineCrossAttempts || 0) >= SAFETY_LINE_PAUSE_FALLBACK_ATTEMPT) {
      this.log('exit close priority 3: third crossing pause fallback', `attempts=${this._outbound.lineCrossAttempts}`);
      this._setLineState(LINE_STATES.DOOR_CLOSE_ALLOWED, 'priority_3_pause_fallback');
      this._lineToLawnConfirmed = true;
      this._outboundExitLocked = true;
      this._dangerReleasedAfterExit = true;
      this._closeAfterExitRequested = true;
      const closeOk = await this._pauseCloseResumeAfterExit('priority_3_third_crossing');
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
    return this.isDockedHomeStatus()
      || this._returnContext === RETURN_STATES.HOME_CONFIRMED
      || this._homeState === 'home';
  }

  _hasFreshSafetyPosition(maxAgeMs = 5000) {
    const at = Number(this.device._lastLivePosAt || this.device._livePos?.ts || 0);
    return !!at && Date.now() - at <= maxAgeMs;
  }

  _confirmMovingGateDanger(moving, inside) {
    if (!inside || !this._hasFreshSafetyPosition(5000)) {
      this._gateMotionDangerHits = 0;
      this._gateMotionDangerState = null;
      this._gateMotionDangerFirstAt = 0;
      return false;
    }
    const now = Date.now();
    if (this._gateMotionDangerState === moving && now - this._gateMotionDangerFirstAt <= 6000) {
      this._gateMotionDangerHits += 1;
    } else {
      this._gateMotionDangerState = moving;
      this._gateMotionDangerHits = 1;
      this._gateMotionDangerFirstAt = now;
    }
    // Two fresh consecutive samples eliminate stale single-position reversals,
    // while still reacting within the normal fast poll cadence.
    return this._gateMotionDangerHits >= 2;
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
        await this.device._safeWrite('garage_gate_motion_pause', () => this.device._api.pause(did));
      } else if (this.device._api && typeof this.device._api.pause === 'function') {
        await this.device._api.pause(did);
      }
      if (typeof this.device._applyStatus === 'function') await this.device._applyStatus('paused').catch(() => {});
      return true;
    } catch (e) {
      this.error('gate-motion interlock pause failed', e.message);
      return false;
    }
  }

  async _releaseGateMotionInterlockAfterOpen() {
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
    // Opening is not reversed: a moving mower is held paused until stable open.
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
    if (!this.enabled()) return nativeStatus;
    if (this._startConfirmationFailed) return nativeStatus || (this.isDockedHomeStatus() ? 'garage_home' : 'idle');
    if (this._startConfirmationPending && !['mowing', 'leaving', 'remote_control', 'mapping'].includes(nativeStatus)) return 'garage_exiting';
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

    // RC28: while a return cycle is active, never show transient native mowing/paused.
    // The current garage state replaces the previous one until HOME/IDLE closes the cycle.
    if (this._safeReturnInProgress || this._returnGuardActive || (this._returnContext && this._returnContext !== RETURN_STATES.IDLE)) {
      if (this.isDockedHomeStatus() && this._returnContext === RETURN_STATES.HOME_CONFIRMED) return 'garage_home';
      return 'returning';
    }

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
      const elapsed = out && out.adjustingSince ? now - out.adjustingSince : 0;
      // Garage-only display contract:
      // 0..5s after release: Ausfahrt
      // then Justieren until line crossing or max. 45s
      // after 45s: Positionieren until line crossing, max. 30s
      // after that: fallback to real native mower status as secondary confirmation only;
      // it must never overpaint Ausfahrt/Justieren/Positionieren before the timers.
      // Door close still requires Safety-Line / exit confirmation.
      if (out && elapsed < OUTBOUND_EXITING_DISPLAY_MS) return 'garage_exiting';

      // With a complete safety line, the clean transition is line garage->lawn.
      if (this._lineToLawnConfirmed) {
        // Contract: the configured Safety Line garage→lawn is the only normal
        // early release to "Mäht". Do not wait for a delayed native cloud
        // mowing status, otherwise the tile can remain in Positionieren although
        // the exit was already proven.
        return 'mowing';
      }

      if (out && elapsed < MIN_ADJUSTING_MS) return 'garage_adjusting';
      if (out && elapsed < MIN_ADJUSTING_MS + POSITIONING_FALLBACK_MS) return 'garage_positioning';

      // Last-resort display fallback only after Ausfahrt + Justieren + Positionieren.
      // Native mowing is allowed here as an additional backup/confirmation, not as
      // the primary trigger. This does not grant door close; close remains blocked
      // until LINE_CROSSED/EXIT_CONFIRMED/DOOR_CLOSE_ALLOWED.
      if (this._outboundFallbackMowingAllowed || (out && elapsed >= MIN_ADJUSTING_MS + POSITIONING_FALLBACK_MS)) return 'mowing';
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
      'garage_exiting', 'garage_adjusting', 'garage_opening', 'garage_closing',
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
    await this.syncGarageIndicatorCapabilities();
    await this._ensureCapValue('garage_door_status', 'unknown');
    if (this.sensorEnabled()) {
      await this._ensureCapValue('garage_sensor_available_status', 'online');
    } else {
      await this._ensureCapValue('garage_sensor_available_status', 'unknown');
    }
    await this._ensureCapValue('garage_sensor_battery', 100);
    await this._ensureCapValue('garage_safety_status', 'ok');
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
    // Docked/home is the safe-space baseline. Only confirmed native home/docked
    // status may activate this override. Until that moment all normal danger-area
    // and moving-gate emergency rules remain active.
    this._homeState = 'home';
    this._outbound = null;
    this._missionOutside = false;
    this._safeReturnInProgress = false;
    this._returnGuardActive = false;
    this._externalReturnHandling = false;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    if (this._suspectedPausedReturnTimer) clearTimeout(this._suspectedPausedReturnTimer);
    this._suspectedPausedReturnTimer = null;
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._closeAfterExitRequested = false;
    this._emergencyHoldUntil = 0;
    this._emergencyReverseAt = 0;
    this._dangerReleasedAfterExit = false;
    this._setLineState(LINE_STATES.IDLE, reason);
    this._setReturnContext(RETURN_STATES.IDLE, reason);
    this._lastDangerInside = false;
    this._lastLineSide = null;
    this._lastLineRawSide = null;
    this._lastHomeAt = Date.now();
    this._homeCycleLocked = true;
    this._homeCycleLockedAt = this._lastHomeAt;
    clearInterval(this._maintenanceWatch);
    this._maintenanceWatch = null;
    this._maintenanceRequestedAt = 0;
    this.lastRequestedAction = null;
    if (this.markers) this.markers.resetRuntime();
    await this.clearSafety(reason).catch(() => {});
    this.log('Safe Space: Zuhause/Gedockt – Gefahrenbereich ignoriert');
    await this.refreshTileStatus(reason).catch(() => {});
  }

  async syncMarkerButtons() {
    // Keep marker command capabilities installed permanently. Removing them after
    // a save looks nice, but stale Homey mobile dashboards can still send the old
    // capability and then show "Invalid Capability". The listener below blocks
    // already-saved markers and resets the button, so the setup stays safe.
    const saved = {
      cmd_garage_save_danger_center: !!(await this.markers.dangerCenter()),
      cmd_garage_save_safety_line_a: !!(await this.markers.lineA()),
      cmd_garage_save_safety_line_b: !!(await this.markers.lineB()),
    };
    for (const [cap, isSaved] of Object.entries(saved)) {
      try {
        if (isSaved && this.device.hasCapability(cap)) await this.device.removeCapability(cap);
        else if (!isSaved && !this.device.hasCapability(cap)) await this.device.addCapability(cap);
        if (this.device.hasCapability(cap)) await this.device.setCapabilityValue(cap, false).catch(() => {});
      } catch (e) { this.error('marker button sync', cap, e.message); }
    }
  }

  async _syncMarkerButton(cap, shouldExist) {
    try {
      if (shouldExist && !this.device.hasCapability(cap)) await this.device.addCapability(cap);
      if (this.device.hasCapability(cap)) await this.device.setCapabilityValue(cap, false).catch(() => {});
    } catch (e) {
      this.error('marker button sync', cap, e.message);
    }
  }

  async _hideSavedMarkerButton(kind) {
    // PR-cleanup: marker buttons remain installed and momentary. Hiding/removing
    // them caused stale Homey UI state and later false marker/setup warnings.
    // The marker diagnosis is now the source of truth; reset markers re-enables
    // saving by clearing stored marker points, not by adding/removing caps.
    const cap = { danger: 'cmd_garage_save_danger_center', line_a: 'cmd_garage_save_safety_line_a', line_b: 'cmd_garage_save_safety_line_b' }[kind];
    if (cap && this.device.hasCapability(cap)) await this.device.setCapabilityValue(cap, false).catch(() => {});
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
    const value = { x: Math.round(p.x), y: Math.round(p.y), ts: Date.now() };

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
    if (!['open', 'closed', 'opening', 'closing', 'unknown'].includes(state)) state = 'unknown';
    if (this.sensorEnabled() && ['open', 'closed'].includes(state) && !opts.derived) {
      // RC110: every real contact edge is authoritative proof that the sensor is
      // alive. Reset all movement timeout/fallback state immediately, restore the
      // availability capability and clear stale safety warnings. This also closes
      // the race where Smart Life reports open/closed while a previously armed
      // timeout still emits an "unhealthy sensor" warning seconds later.
      this._touchSensorSignal(`door_${state}`);
      this._lastSensorContactAt = Date.now();
      this._lastSensorContactState = state;
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

    clearTimeout(this._stableOpenTimer);
    clearTimeout(this._doorFinalTimer);
    this._stableOpenTimer = null;
    this._doorFinalTimer = null;

    const delay = this._doorDelaySeconds();
    const applyFinal = async (finalState, reason) => {
      if (finalState === 'closed') { this._closeScheduled = false; this._closeCompleted = true; clearTimeout(this._closeTimer); }
      if (finalState === 'open') { this._closeCompleted = false; }
      await this._setCap('garage_door_status', finalState);
        await this.refreshTileStatus('door final');
      this.log('door state', finalState, reason || '');
      if (finalState === 'open') {
        // A stable real-contact open completes the same release proof consumed by
        // startRequested(). This timestamp is deliberately set for both real and
        // timer-backed finalisation so a late contact can resume the waiting start.
        this._lastDoorOpenReleaseAt = Date.now();
        this._trigger('garage_door_stable_open', 'stable_open');
        await this._releaseGateMotionInterlockAfterOpen().catch((e) => this.error('gate-motion release after open', e.message));
        if (this._outbound && this._outbound.requiresMowingStable && !this._outbound.released) {
          this._markOutboundReleased().catch((e) => this.error('outbound release after stable open', e.message));
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
  }

  async setSensorAvailable(status) {
    if (!['online', 'offline', 'timeout', 'unknown'].includes(status)) status = 'unknown';
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
    const recentContact = this._lastSensorContactAt && Date.now() - this._lastSensorContactAt < 10 * 60 * 1000;
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
    this._dangerReleasedAfterExit = false;
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._lastLineSide = null;
    this._lastLineRawSide = null;
    this._closeAfterExitRequested = false;
    this._setLineState(LINE_STATES.IDLE, 'markers_reset');
    this._garageLineSide = null;
    this._lawnLineSide = null;
    this._returnDecision = null;
    this._awaitingLineDoorOpen = false;
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    this._suspectedPausedReturnTimer = null;
    this._closeScheduled = false;
    this._setLineState(LINE_STATES.IDLE, reason || 'cycle_reset');
    this._setReturnContext(RETURN_STATES.IDLE, reason || 'cycle_reset');
  }

  _trigger(id, reason = '', extra = {}) {
    const payload = { reason: String(reason), ...extra };
    const important = [
      'garage_open_requested', 'garage_close_requested', 'garage_safety_block', 'garage_emergency',
      'garage_maintenance_point_reached', 'garage_home_confirmed', 'garage_door_stable_open',
      'garage_danger_area_entered', 'garage_danger_area_left', 'garage_safety_line_lawn',
      'garage_safe_return_started', 'garage_safe_return_completed', 'garage_external_start_blocked',
      'garage_position_uncertain',
    ];
    if (important.includes(id) && (this.device.getSetting('garage_debug_verbose') || ['garage_emergency','garage_safety_block'].includes(id))) {
      const names = {
        garage_open_requested: 'Flow: Garagentor öffnen angefordert',
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
    await this._setSafetyStatus('blocked', reason);
    this._trigger('garage_safety_block', reason || 'blocked', { severity: 'block' });
  }

  async emergency(reason, action = '') {
    await this._setSafetyStatus('emergency', reason);
    this._trigger('garage_emergency', reason || 'emergency', { action: String(action || '') });
  }

  async clearSafety(reason) {
    await this._setSafetyStatus('ok', reason || 'clear');
  }

  _emergencyHoldActive() {
    return !!this._emergencyHoldUntil && Date.now() < this._emergencyHoldUntil;
  }

  async _forceDoorDirectionForEmergency(target, reason) {
    const finalTarget = target === 'close' ? 'closing' : 'opening';
    await this.setDoorState(finalTarget, { immediate: true, derived: true });
    this._trigger(target === 'close' ? 'garage_close_requested' : 'garage_open_requested', reason || `emergency_reverse_to_${target}`);
    this.log('EMERGENCY: gate movement reversed', `target=${target}`, reason || '');
  }

  async _dispatchEmergencyMaintenance(reason) {
    if (typeof this.device._goToMaintenancePointGuarded === 'function') {
      await this.device._goToMaintenancePointGuarded(`emergency_${reason || 'danger'}`).catch((e) => this.error('emergency maintenance command', e.message));
    } else if (typeof this.device.cmdGoToMaintenancePoint === 'function') {
      await this.device.cmdGoToMaintenancePoint().catch((e) => this.error('emergency maintenance command', e.message));
    }
    this._watchMaintenanceReached(async () => {
      this.log('emergency maintenance point reached; awaiting explicit return/retry');
      await this.safetyWarning('emergency_waiting_at_maintenance_point');
    }, async () => {
      this.log('emergency maintenance point timeout');
      await this.safetyBlock('emergency_maintenance_timeout');
    });
  }

  async _sendMowerToMaintenanceForEmergency(reason, opts = {}) {
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
    // RC61: when the gate is OPENING and a moving mower has reached the danger
    // area, waiting below the moving gate is the unsafe option. Immediately
    // issue the original maintenance-point command so the mower evacuates away
    // from the gate. For all other emergency contexts keep the stable-open queue.
    if (opts.immediateEvacuation) {
      this._pendingEmergencyMaintenanceReason = null;
      this.log('EMERGENCY: immediate evacuation to maintenance point', reason || 'danger');
      await this._dispatchEmergencyMaintenance(reason || 'danger');
      return;
    }
    // Do not move the mower while the gate is still travelling in the normal
    // emergency path. Queue the maintenance command and release it only after
    // stable-open confirmation.
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
    await this.emergency('mower_in_danger_area_while_gate_opening', 'immediate_maintenance_evacuation');
    // Do not leave the mower paused below an opening gate. The maintenance-point
    // command is sent immediately and moves it away from the gate path.
    await this._sendMowerToMaintenanceForEmergency(`gate_opening_danger_${reason || 'detected'}`, { immediateEvacuation: true });
    return true;
  }

  async _handleMovingDoorDangerEmergency(moving, reason = '') {
    const now = Date.now();
    if (this._emergencyReverseAt && now - this._emergencyReverseAt < 10000) return true;
    this._emergencyReverseAt = now;
    const reverseTarget = moving === 'opening' ? 'close' : 'open';
    await this.emergency(`mower_in_danger_area_while_gate_${moving}`, `reverse_to_${reverseTarget}_and_maintenance`);
    await this._forceDoorDirectionForEmergency(reverseTarget, `emergency_mower_in_danger_area_while_gate_${moving}`);
    await this._sendMowerToMaintenanceForEmergency(`gate_${moving}_danger`);
    return true;
  }

  async requestOpen(reason, opts = {}) {
    if (this._emergencyHoldActive() && !opts.emergencyReverse && !opts.allowEmergencyResume) {
      const atMaintenance = (this._lastMaintenanceReachedAt && Date.now() - this._lastMaintenanceReachedAt < 120000) || await this.isAtMaintenancePointHeuristic().catch(() => false);
      const danger = await this.markers.dangerState().catch(() => ({ inside: true }));
      const returnOrMaintenanceOpen = this._safeReturnInProgress || this._returnGuardActive || this._returnContext === RETURN_STATES.MAINTENANCE;
      if (!(returnOrMaintenanceOpen && atMaintenance && danger && !danger.inside)) {
        this.log('open blocked: emergency hold active', reason || 'open');
        await this.safetyWarning('open_blocked_emergency_hold');
        return false;
      }
    }
    this.log('request open', reason, 'door=', this.doorState(), 'home=', this._homeState);
    const danger = await this.markers.dangerState();
    const mowerInDanger = !!danger.inside;
    const returnOrMaintenanceOpen = this._safeReturnInProgress || this._returnGuardActive || this._returnContext === RETURN_STATES.MAINTENANCE;
    if (mowerInDanger && !opts.allowOpenFromDanger && !opts.emergencyReverse && !returnOrMaintenanceOpen) {
      // Hard guard for normal operation only. During safe return the mower is
      // expected to wait at/near the maintenance point; opening the gate is the
      // only way to release it. A false danger-circle hit must not strand it.
      this.log('open blocked: mower in danger area');
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
    if (this.doorState() !== 'open') {
      await this.setDoorState('opening', { immediate: true });
    }
    this._trigger('garage_open_requested', reason || 'open');
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
      positionKnown: this.positionKnown(),
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

  async requestClose(reason, opts = {}) {
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
    const safelyDockedHomeForClose = report.home === 'home'
      && (['docked', 'charging', 'charging_completed'].includes(report.nativeStatus) || (this._chargingHomeFallbackAllowed() && this._chargingIndicatesDocked()));

    const inboundMotionActive = ['returning', 'error'].includes(report.nativeStatus)
      || this._safeReturnInProgress
      || this._returnGuardActive
      || (this._returnContext && this._returnContext !== RETURN_STATES.IDLE && this._returnContext !== RETURN_STATES.HOME_CONFIRMED);
    if (inboundMotionActive && !safelyDockedHomeForClose) {
      this._logCloseReport(report, 'blocked_inbound_motion_active');
      await this.safetyWarning('close_blocked_inbound_motion_active');
      return false;
    }

    // HARD SAFETY: during outbound/start/adjusting the door may only close after
    // the exit line has been confirmed and canCloseAfterExit() has promoted the
    // line state to DOOR_CLOSE_ALLOWED. No fallback, home glitch, maintenance
    // timeout or emergency reverse may bypass this.
    if (this._outboundCloseProtected()) {
      this._logCloseReport(report, 'blocked_outbound_exit_not_confirmed');
      await this.safetyWarning('close_blocked_outbound_exit_not_confirmed');
      return false;
    }

    // Absolute field safety: while the mower is considered outside / in an active
    // mowing mission, the door may not close from stale HOME_CONFIRMED, timeout,
    // maintenance or sensor messages. The only allowed outdoor close path is the
    // explicit exit-line path (requireExitConfirmed + DOOR_CLOSE_ALLOWED). Final
    // docked/charging home close is still allowed below.
    if (this._missionOutside && !safelyDockedHomeForClose && !opts.requireExitConfirmed) {
      this._logCloseReport(report, 'blocked_outdoor_mission_active');
      await this.safetyWarning('close_blocked_outdoor_mission_active');
      return false;
    }

    // Fail-safe: without complete, plausible markers no automatic close is allowed
    // during outbound mowing. Home/docked close is different: once the mower is
    // charging/docked, closing the already-open garage must not depend on marker
    // geometry. This fixes the real test where the mower was charging but the
    // return context/marker state prevented the final close request.
    if (!report.ready && !safelyDockedHomeForClose) {
      this._logCloseReport(report, 'markers_incomplete_close_disabled');
      await this.markerSetupWarning('markers_incomplete_close_disabled');
      return false;
    }

    if (report.door === 'opening' || report.door === 'closing') {
      this._logCloseReport(report, 'blocked_door_moving');
      await this.safetyWarning('close_blocked_door_moving');
      return false;
    }
    if (report.home === 'adjusting') {
      this._logCloseReport(report, 'blocked_adjusting_active');
      await this.safetyWarning('close_blocked_adjusting_active');
      return false;
    }
    if (this.sensorDoorReliable() && report.door === 'unknown') {
      this._logCloseReport(report, 'blocked_door_unknown');
      await this.safetyBlock('close_blocked_door_unknown');
      return false;
    }
    if (!report.positionKnown && report.home !== 'home' && !['docked', 'charging', 'charging_completed'].includes(report.nativeStatus)) {
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
    if (report.insideDanger && !safelyDockedHome) {
      this._logCloseReport(report, 'blocked_mower_in_danger_area');
      await this.safetyWarning('close_blocked_mower_in_danger_area');
      return false;
    }
    if (opts.requireExitConfirmed && !(this._lineToLawnConfirmed && this._lineState === LINE_STATES.DOOR_CLOSE_ALLOWED)) {
      this._logCloseReport(report, 'blocked_line_not_confirmed');
      return false;
    }

    this._logCloseReport(report, 'close_requested');
    const delay = this._doorCloseDurationSeconds();
    if (this.doorState() !== 'closed') {
      await this.setDoorState('closing', { immediate: true });
    }
    this._trigger('garage_close_requested', reason || 'close');
    const applyTimedClosed = (why) => {
      this.log('door close by configured time:', why, 'waiting', delay, 's');
      clearTimeout(this._doorFinalTimer);
      const finish = () => {
        this._doorFinalTimer = null;
        this.setDoorState('closed', { immediate: true, derived: true }).catch((e) => this.error('door timed closed', e.message));
      };
      if (delay > 0) this._doorFinalTimer = setTimeout(finish, delay * 1000);
      else finish();
    };

    if (!this.sensorDoorReliable()) {
      applyTimedClosed('sensor unavailable');
    } else {
      clearTimeout(this._doorFinalTimer);
      this._doorFinalTimer = setTimeout(async () => {
        this._doorFinalTimer = null;
        if (this.doorState() !== 'closed') {
          this.log('door close sensor timeout; falling back to configured close time');
          await this._setCap('garage_sensor_available_status', 'timeout');
          await this.safetyWarning('sensor_timeout_close_fallback_to_timer');
          applyTimedClosed('sensor timeout');
        }
      }, DOOR_SENSOR_TIMEOUT_MS);
    }
    return true;
  }

  async ensureDoorOpen(reason, opts = {}) {
    const openedRequestedAt = Date.now();
    const minWaitMs = Math.max(0, Number(opts.minWaitMs || 0));
    const waitRemainingMinimum = async (why) => {
      const remaining = minWaitMs - (Date.now() - openedRequestedAt);
      if (remaining > 0) {
        this.log('door open minimum wait', why || reason || 'open', 'waiting', Math.ceil(remaining / 1000), 's');
        await sleep(remaining);
      }
    };
    const useTimerFallback = async (fallbackReason) => {
      const configuredMs = Math.max(0, this._doorOpenDurationSeconds() * 1000);
      const waitMs = Math.max(configuredMs, minWaitMs);
      this.log('door open by configured time', fallbackReason, 'waiting', Math.ceil(waitMs / 1000), 's');
      await this.setDoorState('opening', { immediate: true, derived: true });
      if (waitMs > 0) await sleep(waitMs);
      await this.setDoorState('open', { immediate: true, derived: true });
      this._lastDoorOpenReleaseAt = Date.now();
      this._trigger('garage_door_stable_open', fallbackReason || 'door_open_time_elapsed');
      return true;
    };

    await this._restoreSensorOnlineIfRecent('open_guard').catch(() => {});
    if (!this.sensorDoorReliable()) {
      const requested = await this.requestOpen(reason, { allowOpenFromDanger: !!opts.allowOpenFromDanger });
      if (!requested) return false;
      return useTimerFallback('sensor_unavailable_open_time_elapsed');
    }
    if (this._doorOpenReleaseVerified()) {
      await waitRemainingMinimum('already_open_verified');
      return true;
    }
    if (this.isDoorOpenStable()) {
      this.log('cached open state not trusted for start; requesting fresh gate-open handshake');
    }

    const requested = await this.requestOpen(reason, { allowOpenFromDanger: !!opts.allowOpenFromDanger });
    if (!requested) return false;

    const max = Date.now() + DOOR_SENSOR_TIMEOUT_MS;
    while (Date.now() < max) {
      if (this._doorOpenReleaseVerified()) {
        await waitRemainingMinimum('sensor_open_stable');
        this._lastDoorOpenReleaseAt = Date.now();
        await this.clearSafety('door_open_stable');
        return true;
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
        if (this._doorOpenReleaseVerified()) {
          await waitRemainingMinimum('late_sensor_open_stable');
          await this.clearSafety('late_door_open_stable');
          return true;
        }
        await sleep(500);
      }
    }

    this.log('door open sensor timeout; falling back to configured open time');
    await this._setCap('garage_sensor_available_status', 'timeout');
    await this.safetyWarning('sensor_timeout_open_fallback_to_timer');
    return useTimerFallback('sensor_timeout_open_time_elapsed');
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
    this._homeCycleLockedAt = 0;
    this.lastRequestedAction = action;
    this._lineToLawnConfirmed = false;
    this._lineMowingReleasedAt = 0;
    this._lastLineSide = null;
    this._lastLineRawSide = null;
    this._closeAfterExitRequested = false;
    this._setLineState(LINE_STATES.IDLE, 'markers_reset');
    this._garageLineSide = null;
    this._lawnLineSide = null;
    this._returnDecision = null;
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
      stableMowingConfirmed: false,
      adjustingSince: null,
      lineInitialSide: null,
      lineLawnSide: null,
      lineCrossedAt: null,
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
    const schedule = (delay, fn) => {
      const t = setTimeout(async () => {
        try { await fn(); } catch (e) { this.error('outbound status timer', e.message); }
      }, delay);
      this._outboundStatusTimers.push(t);
    };
    schedule(OUTBOUND_EXITING_DISPLAY_MS + 150, async () => {
      if (!this._outbound || this._lineToLawnConfirmed) return;
      await this.refreshTileStatus('outbound display: adjusting timer').catch(() => {});
      this.log('status timer', 'Justieren aktiv – warte auf Safety-Line');
    });
    schedule(MIN_ADJUSTING_MS + 250, async () => {
      if (!this._outbound || this._lineToLawnConfirmed) return;
      await this.refreshTileStatus('outbound display: positioning timer').catch(() => {});
      this.log('status timer', 'Positionieren aktiv – Safety-Line noch nicht erkannt');
    });
    schedule(MIN_ADJUSTING_MS + POSITIONING_FALLBACK_MS + 500, async () => {
      if (!this._outbound || this._lineToLawnConfirmed) return;
      this._outboundFallbackMowingAllowed = true;
      await this.refreshTileStatus('outbound display: positioning timeout fallback').catch(() => {});
      this.log('outbound fallback mowing after positioning timeout', 'Safety-Line nicht erkannt; Tor bleibt gesperrt bis Safety-Line');
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
    this._outboundExitLocked = false;
    this._movingGateStartWarningShown = false;
    this._dangerOutsideSince = 0;
  }

  _startConfirmedByNativeOrMovement() {
    const status = this.status();
    if (['mowing', 'leaving', 'remote_control', 'mapping'].includes(status)) return true;
    const nowPos = this.pos();
    const startPos = this._startConfirmInitialPos;
    if (nowPos && startPos) {
      const moved = Math.hypot(Number(nowPos.x) - Number(startPos.x), Number(nowPos.y) - Number(startPos.y));
      if (Number.isFinite(moved) && moved >= START_CONFIRM_MOVEMENT_MM) return true;
    }
    // RC109: once the gate has released the mower, any fresh native map position
    // away from a securely docked/charging state is sufficient proof that the
    // mower physically left the station. Some firmware revisions briefly report
    // ready/idle and provide the first POS only after the initial confirmation
    // sample, which previously caused Homey to stop an already exited mower.
    if (nowPos && this._outbound?.released && !this.isDockedHomeStatus()) {
      const age = Date.now() - Number(nowPos.ts || 0);
      if (!Number.isFinite(age) || age < POSITION_CACHE_MS) return true;
    }
    return false;
  }

  _physicalOutsideRecoveryEvidence() {
    const pos = this.pos();
    if (!pos || this.isDockedHomeStatus()) return false;
    const age = Date.now() - Number(pos.ts || 0);
    if (Number.isFinite(age) && age > POSITION_CACHE_MS) return false;
    return !!this._outbound || this._missionOutside || this._homeState === 'away' || this._homeState === 'adjusting' || this.positionKnown();
  }

  async _confirmReleasedStart(source, token) {
    this._clearStartConfirmation();
    this._startConfirmationPending = true;
    this._startConfirmationFailed = false;
    this._startConfirmSource = source || 'start';
    const p = this.pos();
    this._startConfirmInitialPos = p ? { x: Number(p.x), y: Number(p.y), ts: p.ts || Date.now() } : null;
    await this.refreshTileStatus('start command sent; waiting for mower confirmation').catch(() => {});

    this._startConfirmNoticeTimer = setTimeout(() => {
      if (!this._startConfirmationPending || token !== this._commandToken) return;
      this.log('start confirmation pending', 'native status or real movement still missing');
      this.refreshTileStatus('start still waiting for confirmation').catch(() => {});
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

      this._startConfirmationPending = false;
      this._startConfirmationFailed = true;
      this._clearOutboundStatusTimers();
      this._outbound = null;
      this._outboundFallbackMowingAllowed = false;
      this._lineToLawnConfirmed = false;
      this._closeAfterExitRequested = false;
      this._missionOutside = false;
      this._homeState = this.isDockedHomeStatus() ? 'home' : 'unknown';
      this._setLineState(LINE_STATES.IDLE, 'start_not_confirmed');
      this.log('start failed: mower did not confirm native mowing or movement within timeout', `${Math.round(START_CONFIRM_TIMEOUT_MS / 1000)}s`);
      try {
        const did = this.device.getData().id;
        await this.device._safeWrite('garage_start_confirmation_timeout_stop', () => this.device._api.stopMowing(did));
      } catch (e) {
        this.error('start timeout stop', e.message);
      }
      await this.refreshTileStatus('start failed: mower unreachable or command not accepted').catch(() => {});
      await this.safetyWarning('start_not_confirmed').catch(() => {});
    }, START_CONFIRM_TIMEOUT_MS);
  }

  async _markOutboundReleased() {
    if (this.enabled() && this._outbound && this._outbound.requiresMowingStable) {
      this._outbound.adjustingSince = Date.now();
      this._outbound.released = true;
      this._outbound.originalCommandSentAt = Date.now();
      this._startDoorReleasedAt = Date.now();
      this._startCycleIgnoreReturnUntil = Date.now() + 4 * 60 * 1000;
      await this._setHomeState('adjusting').catch(() => {});
      await this.refreshTileStatus('adjusting').catch(() => {});
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

  async startRequested(source, fn) {
    const token = this._commandToken;
    this._closeCompleted = false;
    if (!this.enabled()) return fn();
    this._homeCloseArmed = true;
    clearTimeout(this._closeTimer);
    this._closeTimer = null;
    this._closeScheduled = false;
    this._homeCloseInProgress = false;
    this._homeState = 'leaving';
    await this.refreshTileStatus('start cycle begins').catch(() => {});
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
    const alreadyOutside = this.isDoorOpenStable()
      && this._homeState === 'away'
      && this.positionKnown()
      && !(await this.markers.isInDangerArea())
      && !this.isDockedHomeStatus();
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
    const onlineReady = await this._waitForMowerOnlineBeforeStart(source || 'start');
    if (!onlineReady || token !== this._commandToken) return false;
    // RC32: enter the outbound display state before the native start command is sent.
    // The cloud may report native mowing immediately; it must not overpaint Ausfahrt/Justieren.
    await this._markOutboundReleased();
    const accepted = await fn();
    if (accepted === false) {
      this.log('start command rejected by API', source);
      this._startConfirmationFailed = true;
      this._outbound = null;
      await this.refreshTileStatus('start command rejected').catch(() => {});
      return false;
    }
    if (token !== this._commandToken) { this.log('start cancelled after release', source); return false; }
    await this._confirmReleasedStart(source, token);
    return true;
  }

  async maintenanceRequested(source, fn) {
    const token = this._commandToken;
    if (!this.enabled()) return fn();
    const src = String(source || 'MAINTENANCE');
    // In garage mode the maintenance point is only part of an explicit return
    // path or a deliberate manual maintenance button. It must never be requested
    // from normal mowing/status/position heuristics.
    if (this.isMowing() && !src.includes('return') && src !== 'button_maintenance') {
      this.log('maintenance request blocked during mowing', src);
      await this.safetyWarning('maintenance_blocked_while_mowing');
      return false;
    }
    await this._beginOutbound(source || 'MAINTENANCE', false);
    this.log('MAINTENANCE_REQUESTED', source);

    // From dock/home, open first so the mower can leave the garage to the original maintenance point.
    if (this.isHomeStatus()) {
      const ok = await this.ensureDoorOpen('maintenance_from_home', { allowOpenFromDanger: true });
      if (!ok) return false;
    }

    if (token !== this._commandToken) { this.log('maintenance cancelled before command', source); return false; }
    const accepted = await fn();
    if (accepted === false) {
      this.log('maintenance command rejected; no heuristic reached state', source);
      await this.safetyBlock('maintenance_command_rejected');
      return false;
    }
    this._watchMaintenanceReached(async () => {
      if (token !== this._commandToken) { this.log('maintenance callback ignored: superseded', source); return; }
      if (this._outbound && !this._outbound.requiresMowingStable) {
        // At the original Dreame/Mova maintenance point the mower is outside the gate area.
        // It is therefore safe to close when danger area is free. No mowing status required.
        await this.requestClose('maintenance_reached_close');
      }
    });
    return true;
  }

  async returnRequested(source, dockFn, maintenanceFn) {
    const token = this._commandToken;
    if (!this.enabled()) return dockFn();
    if (this._returnContext !== RETURN_STATES.IDLE || this._safeReturnInProgress || this._returnGuardActive) {
      this.log('return ignored: context already active', this._returnContext, source || 'return');
      return true;
    }
    this.lastRequestedAction = source || 'RETURN';
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
    if (this.isHomeStatus() && !this._physicalOutsideRecoveryEvidence()) {
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

    // Decide return path from the original map geometry. If position/map is unclear or
    // the mower is in the garage half of the map, route through the maintenance point.
    // If it is clearly in the far half, a direct dock return is allowed; if it reaches
    // the safety line before the gate is open, pause there, open the gate, then continue.
    this._returnDecision = await this._decideReturnPath(source || 'return');
    const forceMaintenanceReturn = String(source || '').startsWith('external_') || String(source || '').includes('spatial_inbound') || String(source || '').includes('line_inbound_guard');
    if (forceMaintenanceReturn) this._returnDecision = { ...(this._returnDecision || {}), mode: 'maintenance', reason: 'external_return_safety_route' };
    const dangerNow = await this.markers.dangerState().catch(() => ({ inside: false }));
    if (!forceMaintenanceReturn && this._returnDecision.mode === 'direct' && !dangerNow.inside) {
      // Far from the garage: command the mower to return immediately, while the
      // door is opened in parallel.  Waiting for the door before sending dock()
      // was the reason why the mower kept mowing although the state machine had
      // already logged a return decision.
      if (token !== this._commandToken) { this.log('return cancelled before direct dock', source); return false; }
      this._setReturnContext(RETURN_STATES.DOCK, source || 'return_direct');
      this._pendingDirectDockFn = dockFn;
      this._pendingDirectReturnToken = token;
      this._pendingDirectReturnSource = source || 'return_direct';
      await dockFn();
      this.ensureDoorOpen('direct_return_parallel_open', { allowOpenFromDanger: true, allowDegraded: true })
        .catch((e) => this.error('direct return door open', e.message));
      return true;
    }

    // Near garage, in danger area, or unclear position: deterministic maintenance path.
    if (token !== this._commandToken) { this.log('return cancelled before maintenance', source); return false; }
    this._setReturnContext(RETURN_STATES.MAINTENANCE, source || 'return');
    this._pendingDirectDockFn = null;
    this._pendingDirectReturnToken = 0;
    this._pendingDirectReturnSource = null;
    const maintenanceAccepted = await this._sendMaintenanceWithRetry(maintenanceFn, token, source || 'return');
    if (maintenanceAccepted === false) {
      this.log('return: maintenance command rejected', source);
      if (this.isDoorOpenStable()) {
        this.log('return fallback: door already safely open, direct dock allowed');
        await dockFn();
        return true;
      }
      await this.safetyBlock('maintenance_command_rejected');
      return false;
    }
    this._watchMaintenanceReached(async () => {
      if (token !== this._commandToken) { this.log('return callback ignored: superseded', source); return; }
      const ok = await this.ensureDoorOpen('return_from_maintenance', { allowDegraded: degradedReturn, allowOpenFromDanger: true });
      if (ok) {
        if (token !== this._commandToken) { this.log('return cancelled before dock', source); return; }
        this.log('return continues from maintenance point', 'dock command released');
        await dockFn();
        if (this.device && typeof this.device._poll === 'function') {
          this.homey.setTimeout(() => this.device._poll().catch(() => {}), 5000);
          this.homey.setTimeout(() => this.device._poll().catch(() => {}), 12000);
          this.homey.setTimeout(() => this.device._poll().catch(() => {}), 25000);
        }
        if (degradedReturn) this._watchDegradedDockResult('return_degraded_sensor');
      } else if (degradedReturn) {
        await this.safetyBlock('garage_cannot_open_degraded_return');
      }
    }, async () => {
      if (token !== this._commandToken) { this.log('return timeout ignored: superseded', source); return; }
      if (this.isDoorOpenStable()) {
        this.log('return fallback: maintenance timeout but door safely open, release dock command');
        await dockFn();
      } else {
        // The maintenance point may still be inside the configured danger circle.
        // For a deliberate return cycle the correct fail-safe is not to freeze
        // forever, but to open the gate with the configured sensor/timer guard
        // and then release the original dock command.
        this.log('return fallback: maintenance timeout -> open gate and release dock command');
        const ok = await this.ensureDoorOpen('return_maintenance_timeout_release', { allowOpenFromDanger: true, allowDegraded: true });
        if (ok) await dockFn();
        else await this.safetyBlock('maintenance_point_timeout');
      }
    });
    return true;
  }

  async testExit() {
    if (!this.enabled()) return true;
    await this._beginOutbound('TEST_EXIT', false);
    this.log('TEST_EXIT');
    return this.ensureDoorOpen('test_exit');
  }

  async onExternalMowingDetected() {
    if (!this.enabled()) return;
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
      // Stop the already-running native return before rerouting. This prevents the
      // mower from continuing toward a closed/moving gate while Homey opens it.
      await this._pauseMowerForGateInterlock('return', `external_return_${source}`).catch(() => {});
      return await this.returnRequested(`external_${source}`,
        async () => {
          await this.device._safeWrite(`garage_${source}_dock`, () => this.device._api.dock(did));
          await this.device._applyStatus('returning');
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
          await this.device._applyStatus('returning');
        },
        async () => this.device._goToMaintenancePointGuarded('garage_external_paused_maintenance'),
      ).finally(() => { this._externalReturnHandling = false; });
    }, 12000);
  }

  async onStatus(status, prevStatus) {
    if (!this.enabled()) return;

    this.log('status', status, 'last=', this.lastRequestedAction || '-', 'outbound=', this._outbound ? this._outbound.action : '-');
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

    if ((['docked', 'charging', 'charging_completed'].includes(status) || this._chargingIndicatesDocked())
        && (this._outbound || this._missionOutside || (this._outboundHardLockUntil && Date.now() < this._outboundHardLockUntil))
        && !this._safeReturnInProgress
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

    const nativeHomeSignal = ['docked', 'charging', 'charging_completed'].includes(status);
    const fallbackHomeSignal = !nativeHomeSignal && this._chargingHomeFallbackAllowed() && this._chargingIndicatesDocked();
    if (nativeHomeSignal || fallbackHomeSignal) {
      if (!nativeHomeSignal && (this._missionOutside || this._outbound || (this._outboundHardLockUntil && Date.now() < this._outboundHardLockUntil))) {
        this.log('charging fallback ignored during outdoor/start mission');
        await this.refreshTileStatus('charging fallback ignored').catch(() => {});
        return;
      }
      this._clearResumeGuard('native docked or charging');
      this._setReturnContext(RETURN_STATES.HOME_CONFIRMED, 'native_docked_or_charging');
      await this._setHomeState('home');
      await this._enterDockedIdle('native_docked_or_charging_safe_space');
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

    if (this._startConfirmationPending && ['mowing', 'leaving', 'remote_control', 'mapping'].includes(status)) {
      this._clearStartConfirmation();
      this._startConfirmationFailed = false;
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
      this.log('start confirmed by native status', status);
      this._scheduleOutboundStatusTimers();
      await this.refreshTileStatus('native start confirmed').catch(() => {});
    }

    if (status === 'mowing' || status === 'remote_control') {
      this._missionOutside = true;
      this._lastOutdoorActivityAt = Date.now();
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
    if (['returning', 'error', 'idle', 'standby'].includes(status) && wasOutsideBeforeInbound && !this.isDockedHomeStatus()) {
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
        this.log('inbound motion while gate closing: reversing gate to open', status);
        await this.ensureDoorOpen('inbound_motion_gate_reversal', { emergencyReverse: true }).catch((e) => this.error('inbound gate reversal', e.message));
      }
    }

    if (this._outbound) {
      if (status === 'mowing' && !this._lineToLawnConfirmed) {
        this.log('native mowing during outbound', 'info_only_no_state_change_until_safety_line_or_positioning_timeout');
      }
      if (!this._outbound.dockLeftAt && !['docked', 'charging', 'charging_completed', 'idle', 'standby'].includes(status)) {
        this._outbound.dockLeftAt = Date.now();
        this.log('dock left during outbound');
      }
      if (status === 'mowing') {
        if (!this._outbound.mowingSince) {
          this._outbound.mowingSince = Date.now();
          this.log('mowing seen during outbound: waiting stability buffer');
        }
      } else {
        this._outbound.mowingSince = null;
        this._outbound.stableMowingConfirmed = false;
      }
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
      await this._enterDockedIdle('docked/charging seen');
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
      // darkness/rain, lidar/thermal fault, user abort, etc. In garage mode every
      // outside mission must be resolved through the original maintenance point
      // before the gate opens and before the final dock command is released.
      // Pause/Resume is a pure mower state transition. It must never start the
      // garage return flow. Return interception is therefore limited to real
      // return/error states.
      // A transient idle/standby report is common while a mowing mission is
      // starting, resuming or while cloud telemetry is incomplete. It is not a
      // return command by itself. Direct status interception is therefore only
      // allowed for explicit returning/error states; idle/standby still remain
      // available to the independent spatial/safety-line inbound detectors.
      const safeReturnStatuses = ['returning', 'error'];
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
        && (['returning', 'error'].includes(status) || wasOutsideBeforeInbound)
        && !this.isDockedHomeStatus()
        && !this._outbound
        && !this._returnGuardActive
        && !this._externalReturnHandling
        && !this._safeReturnInProgress
        && !String(this.lastRequestedAction || '').includes('maintenance')
        && !['docked', 'charging', 'charging_completed'].includes(prevStatus || '')
        && !(this._lastHomeAt && Date.now() - this._lastHomeAt < 5 * 60 * 1000);

      if (shouldInterceptSafeReturn) {
        this.log('external safe-return condition detected: route through maintenance point', 'status=', status, 'prev=', prevStatus);
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
      clearTimeout(this._closeTimer);
      await this._setHomeState('away');
      await this.refreshTileStatus('away');
    }
  }

  _watchDegradedDockResult(reason) {
    const started = Date.now();
    const timer = setInterval(async () => {
      if (!this.enabled()) {
        clearInterval(timer);
        return;
      }
      if (['docked', 'charging', 'charging_completed'].includes(this.status())) {
        clearInterval(timer);
        await this.clearSafety('degraded_return_docked');
        return;
      }
      if (Date.now() - started > DEGRADED_DOCK_TIMEOUT_MS) {
        clearInterval(timer);
        this.log('degraded return failed: mower did not dock in time');
        await this.device.cmdPause().catch(() => {});
        if (!this.isDockedHomeStatus()) await this.device.cmdGoToMaintenancePoint().catch(() => {});
        await this.safetyBlock('garage_not_opened_or_docking_failed');
      }
    }, 5000);
  }

  _scheduleHomeClose(reason) {
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
    this.log('home detected; close scheduled in 15s', reason);
    this._closeTimer = setTimeout(async () => {
      try {
        if (!this.enabled()) { this._closeScheduled = false; return; }
        if (!this.isDockedHomeStatus()) {
          this._closeScheduled = false;
          this.log('home confirmation cancelled: mower no longer docked/charging');
          return;
        }
        await this._enterDockedIdle('home_15s');
        this._trigger('garage_home_confirmed', reason || 'home_15s');
        this._trigger('garage_safe_return_completed', reason || 'home_15s');
        const closeOk = await this.requestClose('home_15s');
        if (!closeOk) this._closeScheduled = false;
      } finally {
        this._homeCloseInProgress = false;
    this._outboundHardLockUntil = 0;
    this._startDoorReleasedAt = 0;
    this._startCycleIgnoreReturnUntil = 0;
    this._emergencyHoldUntil = 0;
    this._dangerReleasedAfterExit = false;
      }
    }, DOCK_HOME_CONFIRM_MS);
  }

  _watchMaintenanceReached(callback, onTimeout = null) {
    const token = this._commandToken;
    clearInterval(this._maintenanceWatch);
    this._maintenanceRequestedAt = Date.now();
    this._maintenanceStartPos = this.pos();
    this._maintenanceStableHits = 0;
    this._maintenanceWatch = setInterval(async () => {
      if (token !== this._commandToken) {
        clearInterval(this._maintenanceWatch);
        this._maintenanceWatch = null;
        this._maintenanceStartPos = null;
        this._maintenanceStableHits = 0;
        this.log('maintenance watch cancelled by newer command');
        return;
      }
      const reached = await this.isAtMaintenancePointHeuristic();
      if (reached) {
        clearInterval(this._maintenanceWatch);
        this._maintenanceWatch = null;
        this._maintenanceStartPos = null;
        this._maintenanceStableHits = 0;
        this._lastMaintenanceReachedAt = Date.now();
        // RC111: reaching the maintenance state must never overwrite the configured
        // visual marker with the current mower telemetry. The old behaviour could
        // permanently move the purple marker across the lawn after a delayed or
        // false arrival heuristic. Keep the last validated static marker instead.
        if (typeof this.device._resolveStableMaintenancePoint === 'function') {
          await this.device._resolveStableMaintenancePoint().catch(() => null);
        }
        this.log('maintenance point reached');
        this._trigger('garage_maintenance_point_reached', 'verified');
        if (callback) await callback();
      } else if (Date.now() - this._maintenanceRequestedAt > MAINTENANCE_TIMEOUT_MS) {
        clearInterval(this._maintenanceWatch);
        this._maintenanceWatch = null;
        this._maintenanceStartPos = null;
        this._maintenanceStableHits = 0;
        this.log('maintenance point timeout');
        this._trigger('garage_position_uncertain', 'maintenance_timeout');
        if (onTimeout) {
          await onTimeout();
        } else {
          this.safetyBlock('maintenance_point_timeout').catch(() => {});
        }
      }
    }, 2000);
  }

  _maintenanceMovedEnough() {
    const start = this._maintenanceStartPos;
    const now = this.pos();
    if (!start || !now) return false;
    const dx = Number(now.x) - Number(start.x);
    const dy = Number(now.y) - Number(start.y);
    return Number.isFinite(dx) && Number.isFinite(dy) && (dx * dx + dy * dy) >= (1000 * 1000);
  }

  async isAtMaintenancePointHeuristic() {
    // The original API does not expose exact maintenance-point coordinates.
    // RC5 hardening: never accept a single paused/idle blip as reached.  The
    // mower must have had time to travel and either show position movement or
    // remain in a stopped/ready state for consecutive polls during a return or
    // explicit maintenance command. This prevents false "Wartungspunkt erreicht"
    // while normal mowing/resume states are still settling.
    if (!this._maintenanceRequestedAt) return false;
    if (Date.now() - this._maintenanceRequestedAt < 30000) return false;
    const s = this.status();
    if (!['paused', 'idle', 'standby'].includes(s)) {
      this._maintenanceStableHits = 0;
      return false;
    }
    const inReturnContext = this._returnContext === RETURN_STATES.MAINTENANCE || this._returnContext === RETURN_STATES.GARAGE_OPEN || this._safeReturnInProgress;
    const explicitManual = String(this.lastRequestedAction || '').toLowerCase().includes('maintenance');
    if (!inReturnContext && !explicitManual) {
      this._maintenanceStableHits = 0;
      return false;
    }
    // RC6: the real test showed a false hit immediately after Return because
    // the mower had merely paused where it was. Arrival now requires actual
    // movement away from the start position plus a stopped/paused state. No pure
    // timeout/status fallback may claim the maintenance point.
    if (!this._maintenanceMovedEnough() && Date.now() - this._maintenanceRequestedAt < 60000) {
      this._maintenanceStableHits = 0;
      return false;
    }
    if (!this._maintenanceMovedEnough()) {
      this.log('maintenance point accepted by stable stopped timeout');
    }
    if (Date.now() - this._maintenanceRequestedAt < 30000) {
      this._maintenanceStableHits = 0;
      return false;
    }
    this._maintenanceStableHits = (this._maintenanceStableHits || 0) + 1;
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
    // RC61 pre-entry interlock: during a return, if the gate is opening and the
    // mower approaches the danger boundary, redirect it to maintenance before it
    // can enter the gate path. The inner confirmed-danger rule below remains the
    // hard fallback.
    const nearDangerBoundary = danger.distance !== null && Number.isFinite(Number(danger.distance))
      && Number.isFinite(Number(danger.radius))
      && Number(danger.distance) <= Number(danger.radius) + 500;
    if (doorNow === 'opening' && !inside && nearDangerBoundary
        && (this.isReturning() || this._safeReturnInProgress || this._returnGuardActive)) {
      this.log('return approaching opening gate danger boundary -> maintenance interlock');
      await this._handleOpeningGateDangerEvacuation('return_pre_entry');
      return;
    }
    if (garageDoorMoving && inside) {
      const moving = doorNow;
      const confirmedDanger = this._confirmMovingGateDanger(moving, inside);

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
        // RC61 hard rule: a moving mower must never wait underneath/in front of
        // an opening gate. If it reaches the danger area, immediately evacuate it
        // to the original maintenance point instead of waiting for stable-open.
        const mowerMoving = ['mowing', 'returning'].includes(this.status());
        if (mowerMoving && confirmedDanger) {
          if (!this._movingGateStartWarningShown) {
            this._movingGateStartWarningShown = true;
            this.log('EMERGENCY: gate opening with moving mower in danger area -> evacuate to maintenance');
          }
          await this._handleOpeningGateDangerEvacuation(this.isReturning() ? 'return' : (this._outbound ? 'outbound' : 'mowing'));
          return;
        }
      }
    } else {
      this._gateMotionDangerHits = 0;
      this._gateMotionDangerState = null;
      this._gateMotionDangerFirstAt = 0;
    }

    // If a return has already entered the danger area while the gate is still
    // closed, stop immediately, open the gate, and continue only after stable open.
    if (doorNow === 'closed' && inside && (this.isReturning() || this._safeReturnInProgress || this._returnGuardActive)) {
      await this._pauseMowerForGateInterlock('return', 'closed_gate_return_danger');
      const opened = await this.ensureDoorOpen('closed_gate_return_interlock', { allowOpenFromDanger: true, allowDegraded: true });
      if (opened) await this._releaseGateMotionInterlockAfterOpen();
      return;
    }

    const line = await this.markers.lineState();
    // RC77: spatial movement alone is diagnostic and must never invent a return.
    // External return handling is driven by native/explicit return context only.
    // if (await this._detectSpatialExternalReturn(danger, line)) return;
    // RC77: no point-mode/A=B fallback for a door-closing safety decision.
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
    let crossedLine = lineUsableForOutbound && observedSide !== null && previousObservedSide !== null && observedSide !== previousObservedSide;
    const inferredFirstLawnHit = false && false;

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
      if (this.isReturning() || this._safeReturnInProgress || this._returnGuardActive) {
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
              await this.device._applyStatus('returning');
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
          if (!this._outbound.lawnSideSince) this._outbound.lawnSideSince = Date.now();
          this._setLineState(LINE_STATES.CROSSED, 'garage_to_lawn');
          this._lineToLawnConfirmed = false;
          this._outboundFallbackMowingAllowed = false;
          this._clearOutboundStatusTimers();
          this._lineMowingReleasedAt = Date.now();
          this._outbound.lineCrossedAt = Date.now();
          // Treat the real Safety-Line crossing as the garage-side mowing
          // release. Native cloud status may lag behind; the door close request
          // and display state are driven by the physical line event.
          if (!this._outbound.mowingSince) this._outbound.mowingSince = Date.now();
          this._outbound.stableMowingConfirmed = true;
          this._outbound.adjustingSince = null;
          await this._setHomeState('away').catch(() => {});
          await this.refreshTileStatus('line crossed to lawn').catch(() => {});
          const pos = this.pos();
          this._lastSafetyLineCrossing = { direction: 'garage->lawn', raw: direction, at: Date.now(), position: pos, source: inferredFirstLawnHit ? 'inferred-first-lawn-hit' : 'line-segment', distance: Math.round(line.distance || 0), t: Number(line.t).toFixed(2) };
          this._trigger('garage_safety_line_lawn', 'line_crossed_garage_to_lawn', { direction });
          this.log('safety line crossed garage->lawn during outbound', `${inferredFirstLawnHit ? 'source=inferred-first-lawn-hit' : 'source=line-segment'}; raw=${direction}; time=${new Date().toISOString()}; position=${pos ? `${Math.round(pos.x)},${Math.round(pos.y)}` : 'unknown'}; distance=${Math.round(line.distance || 0)}mm; t=${Number(line.t).toFixed(2)}`);
          this.log('safety line crossed; close priorities armed', `attempt=${this._outbound.lineCrossAttempts}`);
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
    if (line.stable && side !== null) this._lastLineSide = side;

    await this._evaluateOutboundClosePriorities(danger, line);
  }

  async _scheduleCloseAfterSafetyLine(reason) {
    if (!this._outbound || this._closeAfterExitRequested || this._lineCloseTimer) return;
    const delay = OUTBOUND_MOWING_STABLE_MS;
    this.log('safety line close grace started', reason, `delay=${delay}ms`);
    this._lineCloseTimer = setTimeout(async () => {
      this._lineCloseTimer = null;
      try {
        if (!this.enabled() || !this._outbound || this._closeAfterExitRequested) return;
        if (this._outboundPhaseProtected()) {
          this.log('close waits after safety line: Ausfahrt/Justieren/Positionieren still protected');
          this._scheduleCloseAfterSafetyLine('waiting_protected_outbound_phase').catch((e) => this.error('reschedule close after line', e.message));
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
        const clearDistance = lineNow && Number.isFinite(Number(lineNow.distance)) ? Math.abs(Number(lineNow.distance)) : 0;
        const dangerClear = !(await this.isInDangerArea())
          && this._dangerOutsideSince
          && Date.now() - this._dangerOutsideSince >= DANGER_EXIT_STABLE_MS;
        if (!dangerClear) {
          this.log('close waits after safety line: danger area not stably clear');
          this._scheduleCloseAfterSafetyLine('waiting_danger_area_clear').catch((e) => this.error('reschedule close after line', e.message));
          return;
        }

        const lawnDwellMs = this._outbound.lawnSideSince ? Date.now() - this._outbound.lawnSideSince : 0;
        const crossingAttempts = Number(this._outbound.lineCrossAttempts || 0);
        const lawnStableHits = Number(this._outbound.lawnSideStableHits || 0);
        const normalClearance = clearDistance >= SAFETY_LINE_CLEARANCE_MM;
        const dwellFallback = crossingAttempts >= SAFETY_LINE_DWELL_MIN_ATTEMPTS
          && lawnStableHits >= SAFETY_LINE_DWELL_MIN_ATTEMPTS
          && lawnDwellMs >= SAFETY_LINE_DWELL_FALLBACK_MS;

        if (!normalClearance && !dwellFallback) {
          this.log('close waits after safety line: clearance/dwell not yet sufficient', `distance=${Math.round(clearDistance)}mm; attempts=${crossingAttempts}; lawnHits=${lawnStableHits}; lawnDwell=${lawnDwellMs}ms`);
          this._scheduleCloseAfterSafetyLine('waiting_line_clearance_or_dwell').catch((e) => this.error('reschedule close after line', e.message));
          return;
        }
        this._lineToLawnConfirmed = true;
        this._setLineState(LINE_STATES.EXIT_CONFIRMED, dwellFallback ? 'garage_to_lawn_dwell_fallback' : 'garage_to_lawn_validated');
        this.log('exit confirmed', dwellFallback
          ? `stable lawn-side dwell fallback (${lawnDwellMs}ms, attempts=${crossingAttempts})`
          : 'native mowing + danger clear + line clearance');
        this._setLineState(LINE_STATES.DOOR_CLOSE_ALLOWED, 'safety_line_exit_confirmed');
        this._outboundExitLocked = true;
        this._dangerReleasedAfterExit = true;
        this.log('door close allowed', 'safety_line_exit_confirmed');
        this._closeAfterExitRequested = true;
        const closeOk = await this._pauseCloseResumeAfterExit(reason || 'line_crossed_garage_to_lawn');
        if (closeOk) { this._outboundExitLocked = true; this._clearOutboundStatusTimers(); this._outbound = null; this._recentStartExitCloseUntil = Date.now() + 180000; this._startCycleIgnoreReturnUntil = Date.now() + 180000; }
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
    this._clearOutboundStatusTimers();
    this._lineMowingReleasedAt = Date.now();
    this._outbound.lineCrossedAt = Date.now();
    if (!this._outbound.mowingSince) this._outbound.mowingSince = Date.now();
    this._outbound.stableMowingConfirmed = true;
    this._outbound.adjustingSince = null;
    await this._setHomeState('away').catch(() => {});
    await this.refreshTileStatus('line crossed to lawn').catch(() => {});
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
    if (this.isReturning()) return false;
    if (this.status() !== 'mowing') return false;
    if (await this.isInDangerArea()) return false;
    if (!this._dangerOutsideSince || Date.now() - this._dangerOutsideSince < DANGER_EXIT_STABLE_MS) return false;
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
