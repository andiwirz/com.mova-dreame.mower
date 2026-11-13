'use strict';
/** Core 1.2.184 A2 completion contract; only pure evidence validation here.
 * Never sends 109, opens gates, or edits the manufacturer map.
 * Callers must additionally require two independent stable readbacks.
 */
function canConfirmCoreOperatorArrival(v) {
  return (v.operatorConfirmed === true || v.explicitNativeIndex === true)
    && v.sawTransit === true
    && Number(v.nativeCode) === 2 && Number(v.faultCode) === 75
    && v.mowerStatus === 'idle'
    && Number.isFinite(v.taskAgeMs) && v.taskAgeMs >= 5000 && v.taskAgeMs <= 15*60000
    && v.mapMatch === true && v.positionStable === true && v.p1Separated === true
    && v.hasContradictoryIndexedMap !== true
    && v.conflictsWithOtherPoint !== true && v.docked !== true;
}
module.exports={canConfirmCoreOperatorArrival};
