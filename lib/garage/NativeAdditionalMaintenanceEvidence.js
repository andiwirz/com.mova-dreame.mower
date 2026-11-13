'use strict';

// Observation ONLY: never sends mower commands or changes P1 calibration.
// Requires explicit native TASK 109 index, real firmware status 75, independent
// stationary native position readbacks, known P1 distinction and map identity.
const STORE_KEY = 'native_additional_maintenance_points_v1';
const LEARNING_WINDOW_MS = 15 * 60000;
// Resolve the map parser lazily: the preflight module also imports our proof helpers.

// Inspect only known manufacturer target field names. Never mistake the
// selected map index or arbitrary coordinates for a maintenance point number.
const INDEX_KEYS = ['point','point_index','pointIndex','maintenance_point',
  'maintenancePointIndex','service_point_index','target_point','targetPoint'];
function taskAnyTarget(task) {
  if (!task || Number(task.o) !== 109 || task.exe !== true) return null;
  const roots = [task, task.d, task.target, task.args].filter(x => x && typeof x === 'object');
  for (const root of roots) for (const key of INDEX_KEYS) {
    const v = root[key];
    const scalar = Array.isArray(v) && v.length === 1 ? v[0] : v;
    const n = Number(scalar);
    if (scalar != null && Number.isInteger(n) && n >= 1 && n <= 5) return n;
  }
  return null;
}

function taskTarget(task) {
  const point=taskAnyTarget(task);
  return point && point >= 2 ? point : null;
}

/** Diagnostic schema only: field names and types, never coordinates or raw values. */
function maintenanceTaskShape(task) {
  if (!task || Number(task.o) !== 109) return '';
  const visible = v => Object.entries(v).filter(([k]) => /^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/.test(k))
    .slice(0, 24).map(([k,x]) => `${k}:${Array.isArray(x)?`array(${x.length})`:x===null?'null':typeof x}`).join(',');
  const parts = ['root{' + visible(task) + '}'];
  for (const k of ['d','target','args']) if (task[k] && typeof task[k] === 'object')
    parts.push(`${k}{${visible(task[k])}}`);
  return parts.join(' / ').slice(0, 600);
}

function mapRevision(raw) {
  let o = raw;
  for (let i = 0; i < 6; i++) {
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (_) { return ''; } }
    if (!o || typeof o !== 'object') return '';
    const value = o.hash ?? o.md5sum ?? o.md5;
    if (typeof value === 'string' && value.length >= 8 && value.length <= 128) return value;
    o = o.d ?? o.data ?? o.result ?? o.out ?? o.map;
    if (Array.isArray(o)) o = o[0];
  }
  return '';
}

function knownLearnedPoint(stored, point, mapIndex, currentHash, now = Date.now()) {
  const proof = stored?.[String(mapIndex)]?.[String(point)];
  if (!proof || !['native_task109_code75_stable',
    'operator_associated_native_task109_code75_stable',
    'native_indexed_map_position_stable', 'operator_associated_native_indexed_map_position_stable'].includes(proof.source)
    || Number(proof.index) !== point || Number(proof.mapIndex) !== Number(mapIndex)) return null;
  const age = now - Number(proof.confirmedAt || 0);
  if (age < 0) return null;
  // No map revision means the firmware might have since deleted this point.
  // Keep such confirmation intentionally short-lived instead of a fake permanent marker.
  const revision = String(proof.mapHash || '');
  if (revision && currentHash && revision !== currentHash) return null;
  if (age > (revision && currentHash ? 7 * 86400000 : 20 * 60000)) return null;
  return proof;
}

function devStatusIsMoving(device) {
  return ['mowing', 'mapping', 'moving', 'positioning', 'adjusting'].includes(
    String(device?._nativeMowerStatus || device?.getCapabilityValue?.('mower_status') || '').toLowerCase());
}

class NativeAdditionalMaintenanceEvidence {
  constructor(device, log = () => {}) {
    this.device = device;
    this.log = log;
    this.pending = null;
    this.suppressP1Until = 0;
  }
  observeTask(task, mapIndex) {
    const index = taskTarget(task);
    if (!index) {
      // A new/ambiguous 109 supersedes an earlier association. Never attach
      // its later status75 to an old index by accident.
      if (Number(task?.o) === 109 && task?.exe === true) this.pending = null;
      return false;
    }
    const now = Date.now();
    if (this.device._nativeMaintenanceCommandAt
      && now - Number(this.device._nativeMaintenanceCommandAt) < 180000) return false;
    if (task.p != null && Number(task.p) !== Number(mapIndex)) return false;
    if (this.pending && this.pending.index === index && this.pending.mapIndex === Number(mapIndex)
      && now - this.pending.at < LEARNING_WINDOW_MS) return true;
    this.pending = { index, mapIndex: Number(mapIndex), at: now, explicitNativeIndex: true };
    this.log(`[maintenance-learn] native original-app TASK109 index=P${index} map=${mapIndex}; waiting for code75`);
    return true;
  }
  isPending() {
    if (this.pending && Date.now() - this.pending.at > LEARNING_WINDOW_MS) this.pending = null;
    return !!this.pending;
  }
  async observeStatus(nativeCode, faultCode = 0) {
    if (!this.isPending()) {
      // Status 75 can repeat on every poll long after a confirmed P2 arrival.
      // Never let those repetitions retroactively overwrite the P1 marker.
      const explicitNewP1 = Number(this.device._nativeMaintenanceCommandPoint) === 1
        && Number(this.device._nativeMaintenanceCommandAt || 0) > this.suppressP1Until - 90000;
      if (Number(nativeCode) === 75 && Date.now() < this.suppressP1Until && !explicitNewP1) return true;
      if (Number(nativeCode) !== 75) this.suppressP1Until = 0;
      return false;
    }
    const pending = this.pending;
    // An actual prior transit state is required before accepting an idle arrival.
    // The A2 reports (status=1, fault=27) during the observed vendor trip.
    if (Number(nativeCode) === 1 && Number(faultCode) === 27) pending.sawTransit = true;
    // MOVA A2 real-world trace: TASK109 while mower_status transitions to
    // mowing, followed by 1/75 and 2/75. A hard-coded 1/27 requirement
    // rejected this valid movement. Only count movement AFTER correlated 109.
    if (Number(nativeCode) === 1 && devStatusIsMoving(this.device)) pending.sawTransit = true;
    // While a P2–P5 native task is pending, do NOT let the legacy P1 arrival
    // observer overwrite its confirmed marker, even on incomplete telemetry.
    const code75 = Number(nativeCode) === 75 && Number(faultCode || 0) === 0;
    const dev = this.device, did = dev.getData().id;
    // A2 field observations included latestStatus=2/fault=75 while the
    // vendor UI reported arrival. That combination is NOT arrival evidence.
    // A separately indexed map coordinate may, however, prove the target
    // together with two consistent native position observations.
    if (!code75 && !(Number(nativeCode) === 2 && Number(faultCode) === 75)) return true;
    if (!dev._api?.getMowerPosition || !dev._resolveStableMaintenancePoint) return true;
    if (Number(dev._activeMapIndex ?? 0) !== pending.mapIndex) return true;
    const p1 = await dev._resolveStableMaintenancePoint().catch(() => null);
    if (!p1 || !Number.isFinite(Number(p1.x)) || !Number.isFinite(Number(p1.y))) return true;
    const pos = async () => {
      const p = await dev._api.getMowerPosition(did).catch(() => null);
      return p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))
        ? { x: Number(p.x), y: Number(p.y) } : null;
    };
    const a = await pos();
    if (!a) return true;
    // The previous V17 hardware run committed the dock-side (0,260)
    // while the OEM trip later continued to (-5880,-7470). Never accept
    // an arrival which has not departed the independent arming position.
    const start = pending.startPosition;
    if (start && Math.hypot(a.x-start.x,a.y-start.y) < 1000) {
      this.log(`[maintenance-learn] P${pending.index} arrival withheld: still near learning start; awaiting actual OEM destination`);
      pending.arrivalCandidate=null;
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
    const b = await pos();
    if (!b || (start && Math.hypot(b.x-start.x,b.y-start.y)<1000)
      || Math.hypot(a.x - b.x, a.y - b.y) > 220
      || Math.hypot(b.x - Number(p1.x), b.y - Number(p1.y)) < 1000
      || Number(dev._latestNativeStatusCode) !== Number(nativeCode) || Number(dev._activeMapIndex ?? 0) !== pending.mapIndex
      || this.pending !== pending) return true;
    const raw = await dev._api.getMAPI(did, pending.mapIndex).catch(() => null);
    const { maintenanceMapEvidence } = require('./MaintenancePointPreflight');
    const mapEvidence = maintenanceMapEvidence(raw, pending.index);
    const mapPos = mapEvidence.position;
    const mapMatches = mapPos && Math.hypot(b.x - mapPos.x,b.y - mapPos.y) <= 300;
    // Unlike the garden rendering cache, this diagnostic reads partial MAPI
    // metadata even when the response has no mowing zones. Never log raw
    // coordinates, credentials or entire manufacturer replies.
    const diagKey = `${pending.mapIndex}:${pending.index}:${mapEvidence.evidence}:${mapEvidence.indexes.join(',')}:${!!mapPos}`;
    if (diagKey !== this._lastMapDiagKey || Date.now() - (this._lastMapDiagAt || 0) > 60000) {
      this._lastMapDiagKey = diagKey; this._lastMapDiagAt = Date.now();
      this.log(`[maintenance-learn] P${pending.index} MAPI evidence labels=${mapEvidence.evidence} indexed=${mapEvidence.indexes.join(',')||'none'} targetPos=${!!mapPos} positionMatch=${!!mapMatches} shape=${mapEvidence.shape}`);
    }
    if (!code75 && !mapMatches) {
      // Core 1.2.184: MOVA A2 announces native maintenance arrival as
      // latestStatus=2/fault=75, NOT necessarily latestStatus=75. Bind this
      // completion to the exact original-app TASK 109 and the explicitly armed
      // P2..P5 device-card selection. Never infer a target from fault=75 alone.
      const { canConfirmCoreOperatorArrival } = require('./CoreOperatorArrivalProof');
      const otherPoint = Object.entries(this.stored?.[String(pending.mapIndex)] || {})
        .some(([key,p])=>Number(key)!==pending.index && p &&
          Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) &&
          Math.hypot(b.x-Number(p.x),b.y-Number(p.y)) < 1000);
      const signal={
        operatorConfirmed: pending.operatorConfirmed === true,
        explicitNativeIndex: pending.explicitNativeIndex === true,
        sawTransit: pending.sawTransit === true,
        nativeCode: nativeCode, faultCode, // Use native mower telemetry: the Homey tile may deliberately display
        // garage_maintenance_transit while the native A2 has already reached idle.
        mowerStatus: dev._nativeMowerStatus,
        taskAgeMs: Date.now()-pending.at,
        mapMatch: Number(dev._activeMapIndex ?? 0) === pending.mapIndex,
        positionStable: Math.hypot(a.x-b.x,a.y-b.y)<=220,
        p1Separated: Math.hypot(b.x-Number(p1.x),b.y-Number(p1.y))>=1000,
        hasContradictoryIndexedMap: !!mapPos && !mapMatches,
        conflictsWithOtherPoint: otherPoint,
        docked: dev._mowerBinaryDiag?.dockingState === 'IN_STATION',
      };
      if (!canConfirmCoreOperatorArrival(signal)) {
        pending.arrivalCandidate=null;
        const failed = Object.entries(signal).filter(([key,value]) =>
          ['operatorConfirmed','explicitNativeIndex'].includes(key) ? false :
          ['sawTransit','mapMatch','positionStable','p1Separated'].includes(key) ? value !== true :
          ['hasContradictoryIndexedMap','conflictsWithOtherPoint','docked'].includes(key) ? value === true : false
        ).map(([key])=>key);
        if (!signal.operatorConfirmed && !signal.explicitNativeIndex) failed.push('operatorAssociation');
        if (signal.mowerStatus !== 'idle') failed.push('mowerNotIdle');
        this.log(`[maintenance-learn] P${pending.index} native 2/75: proof blocked ${failed.join(',')||'taskAge_or_nativeSignal'}; no point committed`);
        return true;
      }
      // Require a second independent poll >= 4s later, not just two reads in
      // one poll. Native status must still be 2/75 on that next observation.
      const now=Date.now(), prev=pending.arrivalCandidate;
      if (!prev || now-prev.at<4000 || now-prev.at>45000
          || Math.hypot(b.x-prev.x,b.y-prev.y)>350) {
        if (!prev || now-prev.at>45000 || Math.hypot(b.x-prev.x,b.y-prev.y)>350)
          pending.arrivalCandidate={at:now,x:b.x,y:b.y};
        this.log(`[maintenance-learn] P${pending.index} native A2 2/75 candidate: awaiting independent stable arrival sample`);
        return true;
      }
      const existing=await Promise.resolve(dev.getStoreValue(STORE_KEY)).catch(()=>null)||{};
      const byMap={...(existing[String(pending.mapIndex)]||{})};
      // A native, operator-associated 109 completion is Core's bounded point
      // authority. It is NOT evidence that the OEM MAPI exposed an index.
      const already=byMap[String(pending.index)];
      // A previously observed/unconfirmed marker may be at the same position.
      // A fresh, independently verified native arrival must promote its proof,
      // refresh its timestamp and persist it; retaining the old candidate
      // caused the success log without a visible confirmed P2 marker.
      const samePosition = already && Number.isFinite(Number(already.x)) && Number.isFinite(Number(already.y))
        && Math.hypot(b.x-Number(already.x),b.y-Number(already.y)) <= 700;
      const verifiedSource = pending.operatorConfirmed
        ? 'operator_associated_native_task109_code75_stable'
        : 'native_task109_code75_stable';
      byMap[String(pending.index)] = {
        index:pending.index,mapIndex:pending.mapIndex,
        x:samePosition ? Number(already.x) : Math.round(b.x),
        y:samePosition ? Number(already.y) : Math.round(b.y),
        confirmedAt:now,mapHash:mapRevision(raw) || (samePosition ? already.mapHash : '') || '',
        source:verifiedSource,
      };
      await dev.setStoreValue(STORE_KEY,{...existing,[String(pending.mapIndex)]:byMap});
      this.log(`[maintenance-learn] P${pending.index} ${samePosition?'existing marker reverified':'new marker'}; persisted verified source`);
      this.log(`[maintenance-learn] P${pending.index} CORE native 109 + A2 2/75 + repeated stable arrival VERIFIED; stored map=${pending.mapIndex}, P1 unchanged`);
      this.suppressP1Until=now+90000;
      this.pending=null;
      return true;
    }
    if (code75 && mapPos && !mapMatches) return true; // contradictory manufacturer evidence
    const existing = await Promise.resolve(dev.getStoreValue(STORE_KEY)).catch(() => null) || {};
    const byMap = { ...(existing[String(pending.mapIndex)] || {}) };
    byMap[String(pending.index)] = {
      index: pending.index, mapIndex: pending.mapIndex, x: b.x, y: b.y,
      confirmedAt: Date.now(), mapHash: mapRevision(raw), source: code75 ? 'native_task109_code75_stable' : 'native_indexed_map_position_stable',
    };
    await dev.setStoreValue(STORE_KEY, { ...existing, [String(pending.mapIndex)]: byMap });
    this.log(`[maintenance-learn] native P${pending.index} ${code75?'code75':'indexed-map'} + stationary position confirmed map=${pending.mapIndex}; indexed Flow now eligible`);
    this.suppressP1Until = Date.now() + 90000;
    this.pending = null;
    return true;
  }
}

module.exports = { NativeAdditionalMaintenanceEvidence, taskTarget, taskAnyTarget, maintenanceTaskShape, mapRevision, knownLearnedPoint, STORE_KEY, LEARNING_WINDOW_MS };
