'use strict';
// A visual gate statement is NOT a command and never changes a physical
// sensor. However a fresh, settled real contact can supersede an obsolete
// emergency/derived-moving flag when the operator is recovering. A pending
// emergency motor transition remains a hard veto.
function currentPhysicalEndContact(garage, state, now = Date.now()) {
  const at = Number(garage._lastSensorContactAt || 0);
  const pulse = Number(garage._manualRecoveryGatePulseAt || 0);
  const motion = Number(garage._gateMotionStartedAt || 0);
  const age = now - at;
  // After Homey reports a stable sensor-confirmed end position, an explicit
  // operator sight-check may outlive the normal 2-minute edge window. This
  // requires a non-derived settled gate state and an end edge newer than the
  // emergency itself; it never just trusts an old contact across a gate pulse.
  const heldStable = age <= 10 * 60 * 1000
    && garage.doorState?.() === state && garage._doorStateDerived !== true
    && at >= Number(garage._emergencyGateContext?.createdAt || 0);
  return garage._lastSensorContactState === state
    && garage.sensorEnabled?.() && garage.sensorHealthy?.()
    && at > 0 && age >= 2500 && (age <= 120000 || heldStable)
    && at >= pulse && at >= motion;
}
function inspectGatePassage(garage, state, operatorConfirmed, now = Date.now()) {
  if (operatorConfirmed !== true) return {ok:false,reason:'visual_'+state+'_required'};
  if (!['closed','open'].includes(state)) return {ok:false,reason:'gate_state_unknown'};
  if (garage._emergencyTransitionPromise) return {ok:false,reason:'emergency_gate_active'};
  const settledContact = currentPhysicalEndContact(garage,state,now);
  const derivedMoving = ['opening','closing'].includes(garage.doorState?.());
  // A stale emergency context or a derived moving tile is not physical motion.
  // Only a subsequent settled, genuine end-contact clears this *visual* gate.
  if ((garage._emergencyGateContext || derivedMoving) && !settledContact)
    return {ok:false,reason:garage._emergencyGateContext?'emergency_gate_active':'gate_moving'};
  const pulseAt=Number(garage._manualRecoveryGatePulseAt || 0);
  if (pulseAt > 0 && now >= pulseAt && now-pulseAt < 12000 && !settledContact)
    return {ok:false,reason:'recent_gate_pulse'};
  if (garage.sensorEnabled?.() && !garage.sensorHealthy?.())
    return {ok:false,reason:'sensor_offline'};
  const contact=garage._lastSensorContactState;
  const at=Number(garage._lastSensorContactAt || 0);
  const contactAge=at>0?now-at:null;
  const opposite=state==='closed'?'open':'closed';
  if (contact===opposite && contactAge!==null && contactAge>=0 && contactAge<=120000)
    return {ok:false,reason:state==='closed'?'gate_open_contact_conflict':'gate_closed_contact_conflict'};
  // A fresh observed real end-contact is authoritative over stale derived UI.
  if (garage.doorState?.()===opposite && (!settledContact || (!garage._emergencyGateContext && garage._doorStateDerived !== true)))
    return {ok:false,reason:state==='closed'?'gate_open_contact_conflict':'gate_closed_contact_conflict'};
  // No new moving-gate command may be queued during this sight-only action.
  return {ok:true,evidence:settledContact?'visual_and_fresh_'+state+'_contact':'visual_'+state+'_only'};
}
function inspectClosedPassage(garage, operatorConfirmed, now=Date.now()) {
  return inspectGatePassage(garage,'closed',operatorConfirmed,now);
}
module.exports={inspectClosedPassage,inspectGatePassage,currentPhysicalEndContact};
