'use strict';

// Isolated, fail-closed external-start recovery for MOVA A2.
// The state transitions follow the proven CORE 1.2.184 PAUSE -> STOP -> OPEN
// -> native-station verification -> fresh native task concept. This module
// deliberately DOES NOT infer a maintenance-point index or redock the robot.
// Enabled by Garage Mode; verify the physical start interception on the A2 before closed-gate use.
const { decodeNativeDockFrame } = require('./NativeUndockingMilestone');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const START_TASKS = new Set([100, 101, 102, 103, 109]);
const MOW_TASKS = new Set([100, 101, 102, 103]);
const FRESH_STATION_MS = 45000;

class CoreExternalStartRecovery {
  constructor({ device, garage, now = Date.now, sleep = wait, log = () => {} }) {
    this.device = device;
    this.garage = garage;
    this.now = now;
    this.sleep = sleep;
    this.log = log;
    this.station = null;
    this.stationAt = 0;
    this.stationSeq = 0;
    this.task = null;
    this.taskAt = 0;
    this.active = false;
    this.phase = 'IDLE';
    this.abortUntil = 0;
    this.stationLost = false;
    this.stopProofAt = 0;
    this.previousStation = null;
    this.previousStationAt = 0;
    this.recentStopAt = 0;
    this.gateRequestAt = 0;
    this.anchor = null;
    this.manualReissueUntil = 0;
  }

  get armed() {
    // NEVER default to enabled after an app update or device re-pair.
    return !!this.garage?.enabled?.();
  }
  get ownsStart() { return this.active; }
  emit(phase, fields = {}) {
    this.phase = phase;
    this.log('[core-external-start]', JSON.stringify({ time: new Date(this.now()).toISOString(), phase, ...fields }));
  }
  onNativeFrame(value) {
    const state = decodeNativeDockFrame(value);
    if (!state) return null;
    const previous = this.station;
    const previousAt = this.stationAt;
    this.previousStation = previous;
    this.previousStationAt = previousAt;
    this.station = state;
    this.stationAt = this.now();
    const edge = previousAt && this.stationAt - previousAt >= 0 && this.stationAt - previousAt <= 30000
      && previous?.dockingState === 'IN_STATION' && previous.undocking === 0
      && state.dockingState === 'IN_STATION' && state.undocking === 1;
    this.stationSeq++;
    if (this.active) {
      if (state.dockingState !== 'IN_STATION' || state.undocking === 1) this.stationLost = true;
      if (state.dockingState === 'IN_STATION' && state.undocking === 0 && this.stopProofAt === 0) {
        this.stopProofAt = this.stationAt;
      }
    }
    return edge ? { type: 'native-undock-edge', ...state } : { type: 'sample', ...state };
  }
  onTask(value) {
    const d = value?.t === 'TASK' ? value.d : null;
    if (!d || d.exe !== true || !START_TASKS.has(Number(d.o))) return;
    // Store immediately; a later generic STOP must not overwrite original 109.
    if (this.active && Number(this.task?.o) === 109) return;
    this.task = JSON.parse(JSON.stringify(d));
    this.taskAt = this.now();
    this.emit(this.phase, { observedTask: Number(d.o) });
    // A fresh user-issued mowing task after intercepted TASK109 is a new
    // departure, not a replay of the stopped maintenance task.
    if (!this.active && MOW_TASKS.has(Number(d.o)) && this.now() < this.manualReissueUntil
        && this._gateProof(this.gateRequestAt)) {
      this.manualReissueUntil = 0;
      this.garage.onManualReissueMowingDetected().catch(e => {
        this.log('[core-external-start] manual reissue outbound failed', e?.message || String(e));
        this.garage.safetyWarning?.('manual_reissue_outbound_failed').catch(() => {});
      });
    }
  }
  freshStation(maxAge = 5000) {
    if (!this.stationAt || this.now() - this.stationAt < 0 || this.now() - this.stationAt > maxAge) return null;
    return this.station;
  }
  // Only native IN_STATION is enough to OWN an early external start.
  // Cloud charging / GUI garage_home must NEVER initiate PAUSE -> STOP.
  eligible() {
    if (!this.armed || !this.garage.enabled() || this.active || this.now() < this.abortUntil) return false;
    if (this.garage._outbound || this.garage._missionOutside || this.garage._safeReturnInProgress) return false;
    if (!this.garage.sensorEnabled() || !this.garage.sensorHealthy()) return false;
    // CORE parity: when the gate is already physically verified OPEN, the
    // original MOVA maintenance task may run unchanged. The point coordinator
    // observes TASK109 + arrival without PAUSE/STOP or a second gate cycle.
    if (this.garage.isDoorOpenStable?.() && this.garage._doorOpenReleaseVerified?.()
      && this.garage._lastSensorContactState === 'open') return false;
    const st = this.freshStation(5000);
    return !!st && st.dockingState === 'IN_STATION' && st.undocking === 1;
  }
  async _write(label, call) {
    const result = typeof this.device._safeWrite === 'function'
      ? await this.device._safeWrite(label, async () => {
        const r = await call();
        if (r === false || (r && typeof r === 'object' && r.code != null && Number(r.code) !== 0))
          throw new Error(label + ' rejected');
        return r;
      })
      : await call();
    return result !== false;
  }
  async _until(predicate, timeoutMs, step = 100) {
    const start = this.now();
    while (this.now() - start < timeoutMs) {
      if (predicate()) return true;
      await this.sleep(step);
    }
    return false;
  }
  _stationProof(since) {
    const state = this.freshStation(FRESH_STATION_MS);
    return !!state && this.stationAt >= since && state.dockingState === 'IN_STATION'
      && state.undocking === 0 && !this.stationLost;
  }
  _gateProof(requestedAt) {
    // A cached OPEN tile alone is never a release authorization.
    return !!this.garage.isDoorOpenStable() && !!this.garage._doorOpenReleaseVerified?.()
      && this.garage._lastSensorContactState === 'open'
      && (
        // New physical contact reported during this opening attempt, OR
        // an independently verified real OPEN contact that was already fresh
        // when the original-app command arrived. Do not demand an artificial
        // second open edge from a sensor that is already open.
        Number(this.garage._lastGateOpenHandshakeAt || 0) >= requestedAt
        || (Number(this.garage._lastSensorContactAt || 0) > 0
          && this.now() - Number(this.garage._lastSensorContactAt) >= 0
          && this.now() - Number(this.garage._lastSensorContactAt) <= 5 * 60000)
      );
  }
  async _stationaryGarageProof(sinceAt) {
    // CORE A2 exception: after STOP, charging contacts may disappear without motion.
    // Require independent fresh idle, two positions, known native garage geometry.
    if (!this.stopProofAt || this.stopProofAt < sinceAt || !this.anchor
        || !this.garage.markers || !this.device._dockPos || !this.device._api?.getMowerPosition
        || !this.device._api?.getProperties || !this._gateProof(this.gateRequestAt)) return false;
    const did = this.device.getData().id;
    const api = this.device._api;
    const dist = (a,b) => Math.hypot(Number(a.x)-Number(b.x),Number(a.y)-Number(b.y));
    const contactLost = () => { const st = this.freshStation(45000); return st?.dockingState === 'OUT_OF_STATION' && st.undocking === 0; };
    const idle = async () => {
      const raw = await api.getProperties(did, [[2,1]], {timeout:1400}).catch(() => null);
      const item = raw?.code === 0 ? raw.data?.result?.find(x=>Number(x.siid)===2 && Number(x.piid)===1 && (!x.code || Number(x.code)===0)) : null;
      return Number(item?.value)===2;
    };
    const position = async () => {
      const p = await api.getMowerPosition(did).catch(()=>null);
      return p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) ? {x:Number(p.x),y:Number(p.y)} : null;
    };
    const safe = async (p) => {
      if (!p || dist(p,this.anchor)>180 || dist(p,this.device._dockPos)>1500) return false;
      const danger = await this.garage.markers.rawDangerState(p).catch(()=>null);
      const line = await this.garage.markers.lineState(p).catch(()=>null);
      return !!(danger?.known && Number.isFinite(Number(danger.distance)) && Number.isFinite(Number(danger.radius))
        && Number(danger.distance)<=Number(danger.radius)+450
        && line?.known && line.onSegment && line.direction?.known
        && line.rawSide!=null && line.rawSide===line.direction.garageSide);
    };
    if (!contactLost() || !(await idle())) return false;
    const first = await position();
    if (!contactLost() || !(await safe(first))) return false;
    await this.sleep(700);
    const second = await position();
    return !!(contactLost() && second && dist(first,second)<=70 && (await safe(second))
      && (await idle()) && this._gateProof(this.gateRequestAt));
  }
  async restoreAbort() {
    const ts = Number(await Promise.resolve(this.device.getStoreValue?.('garage_external_start_abort_until')).catch(()=>0))||0;
    this.abortUntil = ts>this.now()?ts:0;
  }
  async _holdAbort() {
    this.abortUntil = this.now() + 300000;
    await Promise.resolve(this.device.setStoreValue?.('garage_external_start_abort_until',this.abortUntil)).catch(()=>{});
  }
  async suppressReplay() {
    if (!this.armed || this.active || this.now()>=this.abortUntil || this.garage.isDoorOpenStable?.()) return false;
    const st = this.freshStation();
    if (!st || st.dockingState!=='IN_STATION' || st.undocking!==1) return false;
    this.active=true;
    try {
      const did=this.device.getData().id;
      const a=await this._write('external_core_replay_pause',()=>this.device._api.pause(did));
      const b=await this._write('external_core_replay_stop',()=>this.device._api.stopMowing(did));
      return a && b;
    } finally { this.active=false; }
  }
  async suppressMissingNativeEdge(previousStatus) {
    if (!this.armed || this.active || this.garage._outbound || this.garage._missionOutside
      || !['docked','charging','idle','standby'].includes(String(previousStatus||''))
      || this.garage.isDoorOpenStable?.()) return false;
    this.active=true;
    try {
      const did=this.device.getData().id;
      const paused=await this._write('external_core_fallback_pause',()=>this.device._api.pause(did));
      const stopped=await this._write('external_core_fallback_stop',()=>this.device._api.stopMowing(did));
      await this._holdAbort();
      await this.garage.safetyWarning?.('external_start_native_milestone_missing');
      return paused && stopped;
    } finally {this.active=false;}
  }
  async _dispatch(did, task) {
    const map = Number(this.device._activeMapIndex || 0);
    const api = this.device._api;
    const o = Number(task.o);
    if (o === 100 && Array.isArray(task.region_id) && task.region_id.length) {
      return api.startZoneMowing(did, task.region_id, map);
    }
    if (o === 100 && Array.isArray(task.area_id) && task.area_id.length) {
      return api.startSpotMowing(did, task.area_id, map);
    }
    if (o === 100) return api.startMowing(did);
    if (o === 101) return api.startEdgeMowing(did, map, Array.isArray(task.edge) ? task.edge : null);
    if (o === 102 && Array.isArray(task.region_id) && task.region_id.length) {
      return api.startZoneMowing(did, task.region_id, map);
    }
    if (o === 103 && Array.isArray(task.area_id) && task.area_id.length) {
      return api.startSpotMowing(did, task.area_id, map);
    }
    throw new Error('original task target missing or unsupported');
  }
  async onUndockingEdge(source = 'mqtt_1_1') {
    if (!this.eligible()) return false;
    this.active = true; // exclusive ownership BEFORE first await
    const started = this.now();
    const did = this.device.getData().id;
    this.stationLost = false;
    this.stopProofAt = 0;
    this.anchor = null;
    // A previously seen task must be close to this actual undock edge.
    if (this.now() - this.taskAt > 5000) this.task = null;
    this.emit('INTERCEPT', { source });
    let success = false;
    try {
      // The early native edge must go straight to PAUSE, without any gate work.
      if (!(await this._write('external_core_pause', () => this.device._api.pause(did))))
        throw new Error('pause rejected');
      this.emit('PAUSED_REQUESTED');
      // The vendor TASK sometimes follows the Undock packet. Small bounded wait.
      if (!this.task) await this._until(() => !!this.task, 120, 20);
      const stopAt = this.now();
      if (!(await this._write('external_core_stop', () => this.device._api.stopMowing(did))))
        throw new Error('stop rejected');
      this.emit('STOPPED_REQUESTED', { pauseToStopMs: stopAt - started });
      const stationWindow = await this._until(() => this._stationProof(stopAt), 600, 80);
      if (!stationWindow) throw new Error('post-pause native IN_STATION/u0 proof missing');
      // Only once the mower is physically stopped in station, request OPEN.
      const openAt = this.now();
      this.gateRequestAt = openAt;
      this.emit('OPEN_REQUESTED');
      const opened = await this.garage.ensureDoorOpen('external_core_start', {
        allowOpenFromDanger: true, minWaitMs: 0,
      });
      if (opened !== true || !this._gateProof(openAt)) throw new Error('fresh door sensor proof missing');
      this.emit('GATE_VERIFIED');
      // No automatic retry/redocking if contact changed. CORE's elaborate
      // contact-loss geometry fallback is *not* yet implemented here.
      if (!this._stationProof(stopAt) && !(await this._stationaryGarageProof(stopAt))) throw new Error('native station lost without stationary garage proof');
      const task = this.task && this.now() - this.taskAt <= 90000 ? this.task : null;
      if (!task || !MOW_TASKS.has(Number(task.o))) {
        this.emit('MANUAL_REISSUE_REQUIRED', { opcode: task?.o ?? null });
        this.manualReissueUntil = this.now() + 5 * 60000;
        this.garage._homeCloseArmed = false;
        clearTimeout(this.garage._closeTimer); this.garage._closeTimer = null;
        const message = this.garage._text?.(
          'Wartungspunktauftrag nicht eindeutig erkannt. Bitte den Wartungspunkt bei geöffnetem Tor in der MOVA-App erneut auswählen.',
          'Maintenance point request could not be identified. Please select it again in the MOVA app with the gate open.',
        ) || 'Maintenance point selection required.';
        // PR 1 has no central notice router yet; keep this user instruction in
        // the existing Homey timeline instead of issuing an unexpected push.
        this.garage._timeline?.(message, 'maintenance:original_app_reissue');
        await this.garage.safetyWarning?.('external_start_waiting_for_explicit_point');
        return false; // original maintenance P? cannot be inferred
      }
      // Never resume the old STOPped task; issue a new exact native task.
      this.garage._homeCloseArmed = true;
      await this.garage._beginOutbound('EXTERNAL_CORE_RECOVERED', true);
      this.emit('FRESH_START', { opcode: Number(task.o) });
      if (!(await this._write('external_core_fresh_start', () => this._dispatch(did, task))))
        throw new Error('fresh task rejected');
      if (!(await this._until(() => {
        const st = this.freshStation(3000);
        return st && (st.undocking === 1 || st.dockingState === 'OUT_OF_STATION');
      }, 8000, 120))) throw new Error('fresh departure not confirmed');
      // Reuse Andi's existing exit-line, danger and door-close flow.
      this.garage._missionOutside = true;
      await this.garage._markOutboundReleased();
      success = true;
      this.emit('DONE');
      return true;
    } catch (e) {
      this.emit('BLOCKED', { reason: e?.message || String(e) });
      await this.garage.safetyBlock('external_core_start_blocked').catch(() => {});
      return false;
    } finally {
      if (!success) {
        await this._holdAbort();
        this.garage._homeCloseArmed=false;
        clearTimeout(this.garage._closeTimer); this.garage._closeTimer=null;
        // Do not blindly close: unsafe dock proof or unknown task may remain.
        this.emit('OPERATOR_CHECK_REQUIRED');
      }
      this.active = false;
      this.task = null;
    }
  }
}
module.exports = { CoreExternalStartRecovery };
