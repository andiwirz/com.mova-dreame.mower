'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Garage = require('../lib/garage/GarageSafetyEngine');
function make() {
  const g = Object.create(Garage.prototype);
  g._commandToken = 14;
  g._outbound = {departureLineConfirmed:true,lineCrossAttempts:1};
  g._missionOutside = true;
  g._closeAfterExitRequested = false;
  g._outboundExitLocked = false;
  g._manualGateStopped = false;
  g._manualMaintenanceTransit = false;
  g._safeReturnInProgress = false;
  g._returnGuardActive = false;
  g._externalReturnHandling = false;
  g._userPauseActive = true;
  g._door = 'open';
  g._status = 'paused';
  g.enabled = () => true;
  g.isReturnCycleActive = () => false;
  g.isReturning = () => false;
  g._confirmedStationLockActive = () => false;
  g.doorState = () => g._door;
  g.status = () => g._status;
  g.log = () => {};
  g._emergencyHoldActive = () => false;
  return g;
}
test('contextual Start from paused, line-confirmed outbound preserves close owner and token', () => {
  const g = make();
  const owner = g._outbound;
  let cancelled = false;
  g.cancelPendingCommand = () => {cancelled = true;};
  assert.equal(g.beginUserCommand('start_mowing'),true);
  assert.equal(cancelled,false);
  assert.equal(g._commandToken,14);
  assert.strictEqual(g._outbound,owner);
  assert.equal(g._outbound.lineCrossAttempts,1);
});
test('new start while mowing still supersedes old outbound', () => {
  const g = make();
  g._status='mowing';
  let reason;
  g.cancelPendingCommand = r => { reason=r; g._commandToken++; g._outbound=null; };
  g.beginUserCommand('start_mowing');
  assert.equal(reason,'new_start_mowing');
  assert.equal(g._outbound,null);
});
test('no preservation without physically confirmed crossing', () => {
  const g = make();
  g._outbound.departureLineConfirmed=false;
  assert.equal(g._retainOutboundOnPausedStart('start_mowing'),false);
});
test('return, physical station, moving gate, manual stop and closed gate veto retention', () => {
  const checks = [
    g=>g.isReturnCycleActive=()=>true,
    g=>g._confirmedStationLockActive=()=>true,
    g=>g._door='closing',
    g=>g._door='closed',
    g=>g._manualGateStopped=true,
    g=>g._safeReturnInProgress=true,
    g=>g._manualMaintenanceTransit=true,
  ];
  for (const c of checks) {
    const g=make(); c(g);
    assert.equal(g._retainOutboundOnPausedStart('start_mowing'),false);
  }
});
test('dock/stop/maintenance cannot inherit paused outbound close owner',()=>{
  for (const cmd of ['dock','stop','maintenance','maintenance_point_2']) {
    const g=make();
    let reason;
    g.cancelPendingCommand=r=>{reason=r;g._outbound=null;g._commandToken++;};
    g.beginUserCommand(cmd);
    assert.equal(reason,`new_${cmd}`);
    assert.equal(g._outbound,null);
  }
});
test('priority 3 stays behind its physical confirmation and thresholds',()=>{
  const fs=require('node:fs');
  const src=fs.readFileSync(require.resolve('../lib/garage/GarageSafetyEngine'),'utf8');
  assert.match(src,/SAFETY_LINE_PAUSE_FALLBACK_ATTEMPT = 3/);
  assert.match(src,/SAFETY_LINE_DWELL_MIN_CLEARANCE_MM = SAFETY_LINE_CLEARANCE_MM/);
  assert.match(src,/SAFETY_LINE_CLEARANCE_MM = 800/);
  assert.match(src,/priority_3_third_crossing/);
});
