'use strict';

// Normal (not operator-supervised emergency) return via a verified maintenance
// point. A cloud ACK is never movement proof. Observe the physical departure;
// at most ONE automatic DOCK retry, and only after independent, fresh position
// packets show the mower has remained still and safely clear of the gate.
// This module does not issue STOP/PAUSE or any gate command.
const POLL_MS = 5000;
const DEPARTURE_GRACE_MS = 105000;
const POSITION_MAX_AGE_MS = 15000;
const STATIONARY_DRIFT_MM = 180;
const MOVEMENT_MM = 300;
const MIN_STATIONARY_SAMPLE_AGE_MS = 45000;
const MIN_SAMPLE_SPACING_MS = 15000;
const CLEARANCE_MM = 350;
const ACCEPTED_NATIVE_STATUSES = new Set(['paused', 'idle', 'standby', 'returning']);
const NATIVE_STATUS_MAX_AGE_MS = 20000;

class MaintenanceDockDepartureWatch {
  constructor(engine, { token, dockFn, position, target, dispatchedAt = Date.now() }) {
    this.engine = engine;
    this.token = token;
    this.dockFn = dockFn;
    this.target = { x: Number(target.x), y: Number(target.y) };
    this.baseline = { x: Number(position.x), y: Number(position.y) };
    this.dispatchedAt = dispatchedAt;
    this.attempts = 1; // initial accepted DOCK was already sent by caller
    this.samples = [];
    this.lastTs = 0;
    this.busy = false;
    this.timer = null;
    this.closed = false;
  }

  start() {
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.poll().catch(error => this._fail('return_maintenance_dock_watch_failed', error))
        .finally(() => { this.busy = false; });
    }, POLL_MS);
    this.timer.unref?.();
    return this;
  }

  stop(reason = 'cancelled') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
    if (this.engine._normalMaintenanceDockWatch === this) this.engine._normalMaintenanceDockWatch = null;
    this.engine.log('maintenance DOCK departure watch ended', reason, `attempts=${this.attempts}`);
  }

  _current() {
    const e = this.engine;
    return !this.closed && e._normalMaintenanceDockWatch === this
      && e._commandToken === this.token && e.enabled()
      && e._returnContext === 'MAINTENANCE'
      && e._safeReturnInProgress && e._returnGuardActive
      && !e._manualRecoveryActive && !e._manualGateStopped && !e._outbound
      && !e._emergencyGateContext && !e._emergencyHoldActive()
      && !e._gateMotionPauseActive && !e._pendingEmergencyMaintenanceReason;
  }

  _position(now = Date.now()) {
    const p = this.engine.pos();
    const ts = Number(p?.ts);
    if (!p || !['mqtt', 'siid:1:4'].includes(String(p.source || ''))
        || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))
        || !Number.isFinite(ts) || ts <= 0 || now < ts || now - ts > POSITION_MAX_AGE_MS) return null;
    return { x: Number(p.x), y: Number(p.y), ts };
  }

  _observedNativeStation() {
    const e = this.engine;
    const age = Date.now() - Number(e.device?._mowerBinaryDiagAt || 0);
    return age >= 0 && age <= NATIVE_STATUS_MAX_AGE_MS
      && e.device?._mowerBinaryDiag?.dockingState === 'IN_STATION';
  }

  _stationaryEvidence(now, p) {
    if (!p) return false;
    // The initial command may be accepted long before the vendor starts moving.
    // Evidence collected *before* the departure grace cannot prove a failed
    // departure; only compare independent packets from the later window.
    const late = this.samples.filter(sample => sample.ts >= this.dispatchedAt + MIN_STATIONARY_SAMPLE_AGE_MS);
    if (late.length < 2) return false;
    const first = late[0];
    const last = late[late.length - 1];
    const nativeAt = Number(this.engine.device?._observedMowerStatusAt || 0);
    const nativeAge = now - nativeAt;
    const native = String(this.engine.device?._observedMowerStatus || '').toLowerCase();
    return first.ts >= this.dispatchedAt + MIN_STATIONARY_SAMPLE_AGE_MS
      && last.ts > first.ts && last.ts - first.ts >= MIN_SAMPLE_SPACING_MS
      && last.ts === p.ts
      && this.engine._distance(p, this.baseline) <= STATIONARY_DRIFT_MM
      && this.engine._distance(p, this.target) <= 700
      && nativeAge >= 0 && nativeAge <= NATIVE_STATUS_MAX_AGE_MS
      && ACCEPTED_NATIVE_STATUSES.has(native);
  }

  async _fail(reason, error = null) {
    if (this.closed) return false;
    const e = this.engine;
    e._normalMaintenanceDockTerminalToken = this.token;
    this.stop(reason);
    if (error) e.error('maintenance DOCK departure watch', error?.message || String(error));
    const message = e._humanReason(reason);
    await e.safetyWarning(reason);
    e._timeline(`${e._text('Rückkehr am Wartungspunkt angehalten', 'Return held at maintenance point')}: ${message}. ${e._text('Mäher und Tor prüfen; erneute Rückkehr nur bewusst auslösen.', 'Inspect mower and gate; restart return only deliberately.')}`, `return:maintenance_dock:${reason}`);
    e._trigger('garage_position_uncertain', reason);
    // Exactly one guarded retry was available for this DOCK journey. Once the
    // watcher fails terminally, stop AUTO instead of leaving a blocked return
    // with no visible operator path. No further DOCK command is generated.
    if (typeof e._enterManualRecovery === 'function') {
      try { await e._enterManualRecovery(`automatic_dock_exhausted_${reason}`); }
      catch (handoffError) { e.error('automatic DOCK -> manual takeover failed', handoffError?.message || String(handoffError)); }
    }
    return false;
  }

  async poll() {
    if (!this._current()) { this.stop('return_superseded'); return false; }
    const e = this.engine;
    if (e._confirmedStationLockActive() || this._observedNativeStation()) {
      this.stop('confirmed_station'); return true;
    }
    const now = Date.now();
    const p = this._position(now);
    if (p && e._distance(p, this.baseline) > MOVEMENT_MM) {
      // Genuine mower movement: the vendor return owns navigation. Do not
      // replace its command or pause it. Existing home/danger interlocks remain.
      this.stop('physical_departure_confirmed'); return true;
    }
    if (p && p.ts > this.dispatchedAt && p.ts > this.lastTs) {
      this.lastTs = p.ts;
      if (e._distance(p, this.baseline) > STATIONARY_DRIFT_MM) {
        // Small but non-trivial drift is ambiguous, never proof of standstill.
        return this._fail('return_maintenance_dock_departure_unclear');
      }
      this.samples.push(p);
    }
    if (now - this.dispatchedAt < DEPARTURE_GRACE_MS) return true;
    if (this.attempts >= 2) return this._fail('return_maintenance_dock_retry_no_departure');
    if (!this._stationaryEvidence(now, p)) return this._fail('return_maintenance_dock_retry_needs_proof');
    if (!e._doorOpenReleaseVerified() || !e.isDoorOpenStable() || this._observedNativeStation()) {
      return this._fail('return_maintenance_dock_retry_gate_unconfirmed');
    }
    const positionBefore = { ...p };
    const raw = await e.markers.rawDangerState(positionBefore).catch(() => null);
    // Async map read may have yielded to a competing command or new location.
    const after = this._position();
    if (!this._current() || !after || after.ts !== positionBefore.ts
        || after.x !== positionBefore.x || after.y !== positionBefore.y
        || !this._stationaryEvidence(Date.now(), after)
        || !e._doorOpenReleaseVerified() || !e.isDoorOpenStable()
        || this._observedNativeStation()
        || !raw?.known || raw.inside === true
        || !Number.isFinite(Number(raw.distance)) || !Number.isFinite(Number(raw.radius))
        || Number(raw.distance) <= Number(raw.radius) + CLEARANCE_MM) {
      return this._fail('return_maintenance_dock_retry_clearance_unconfirmed');
    }
    // Mark the retry consumed BEFORE awaiting a potentially lost cloud ACK.
    this.attempts = 2;
    this.dispatchedAt = Date.now();
    this.baseline = { x: after.x, y: after.y };
    this.lastTs = 0;
    this.samples = [];
    e.log('maintenance DOCK no departure: one guarded automatic retry', `token=${this.token}`);
    e._timeline(e._text('Rückkehr am Wartungspunkt: DOCK einmalig erneut angefordert',
      'Return at maintenance point: DOCK requested once more'), `return:maintenance_dock_retry:${this.token}`);
    let accepted;
    try { accepted = await this.dockFn(); }
    catch (error) { return this._fail('return_maintenance_dock_retry_rejected', error); }
    if (accepted === false) return this._fail('return_maintenance_dock_retry_rejected');
    if (!this._current()) this.stop('retry_superseded');
    return true;
  }
}

module.exports = MaintenanceDockDepartureWatch;
