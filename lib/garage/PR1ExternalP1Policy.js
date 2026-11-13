'use strict';
// Conservative PR1 external MOVA-return policy. Normal Homey return routing
// remains separately gated pending the complete CORE safety port (PR2).
function externalP1Preflight({garageEnabled, sensorEnabled, sensorHealthy, home, marker, returnBusy}) {
  if (!garageEnabled || home || returnBusy) return {allowed:false,reason:'not_applicable_or_busy'};
  if (!sensorEnabled || !sensorHealthy) return {allowed:false,reason:'physical_gate_sensor_required'};
  if (!marker || !Number.isFinite(Number(marker.x)) || !Number.isFinite(Number(marker.y)))
    return {allowed:false,reason:'P1_position_not_verified'};
  return {allowed:true,point:1};
}
function dockAllowed({p1Reached, sensorEnabled, realOpenContact, stableOpen, gateProof}) {
  // Do not infer gate position from configured travel times. In particular,
  // a timed-out OPEN command cannot release DOCK.
  return p1Reached===true && sensorEnabled===true && realOpenContact===true
    && stableOpen===true && gateProof===true;
}
module.exports={externalP1Preflight,dockAllowed};
