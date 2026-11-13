'use strict';
/** Observation-only threshold for A2 vendor trips with no reported P2..P5 index.
 * The result is NEVER native movement authorization. No Homey commands here.
 * Keep detached from garage return, P1 calibration and native preflight.
 */
function canRecordOperatorObservation(v) {
  return v.operatorConfirmed === true && v.sawTransit === true
    && Number(v.nativeCode) === 2 && Number(v.faultCode) === 75
    && v.mowerStatus === 'idle'
    && Number.isFinite(v.taskAgeMs) && v.taskAgeMs >= 0 && v.taskAgeMs <= 15*60000
    && v.mapMatch === true && v.positionStable === true
    && v.p1Separated === true && v.hasContradictoryIndexedMap !== true;
}
module.exports = { canRecordOperatorObservation };
