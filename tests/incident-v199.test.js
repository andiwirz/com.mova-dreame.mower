'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {setImmediate: turn} = require('node:timers/promises');
const Engine = require('../lib/garage/GarageSafetyEngine');
function fixture(t) {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  const e = Object.create(Engine.prototype), closes = [];
  Object.assign(e, {
    _commandToken:1, _homeCloseArmed:true, _returnContext:'HOME_CONFIRMED',
    _homeState:'home',
    device:{_mowerBinaryDiag:{dockingState:'IN_STATION',undocking:0,chargingLive:true},
      _mowerBinaryDiagAt:100000, _chargingStatusAt:100000, _observedMowerStatusAt:100000,
      _observedMowerStatus:'charging', getCapabilityValue:name=>name==='charging_status'?'charging':null},
    status:()=> 'charging', doorState:()=> 'open', enabled:()=>true,
    log:()=>{}, error:()=>{}, safetyWarning:async()=>{}, _trigger:()=>{},
    isDockedHomeStatus:()=>true, _enterDockedIdle:async()=>{},
    requestClose:async reason=>{closes.push(reason);return true;}
  });
  const frame = (diag=e.device._mowerBinaryDiag) => {
    e.device._mowerBinaryDiag=diag;
    e.device._mowerBinaryDiagAt=Date.now();
    e.noteHomeDockTelemetry(diag);
  };
  return {e,closes,frame};
}
test('home timer emits no close before full 15 seconds and requires renewed dock evidence',async t=>{
  const {e,closes,frame}=fixture(t);
  e._scheduleHomeClose('test');
  t.mock.timers.tick(14999);frame();
  await turn();assert.equal(closes.length,0);
  t.mock.timers.tick(1);await turn();assert.deepEqual(closes,['home_15s']);
});
test('brief charge then redocking cancels timer; new stable dock needs another full 15 seconds',async t=>{
  const {e,closes,frame}=fixture(t);
  e._scheduleHomeClose('test');t.mock.timers.tick(14000);
  frame({dockingState:'OUT_OF_STATION',undocking:1,chargingLive:false});
  t.mock.timers.tick(1000);await turn();assert.equal(closes.length,0);
  frame({dockingState:'IN_STATION',undocking:0,chargingLive:true});
  e._scheduleHomeClose('redock');
  t.mock.timers.tick(14999);frame();await turn();assert.equal(closes.length,0);
  t.mock.timers.tick(1);await turn();assert.equal(closes.length,1);
});
test('single initial dock proof cannot authorize timer close without a later independent proof',async t=>{
  const {e,closes}=fixture(t);e._scheduleHomeClose('test');
  // No later binary/charging event: the gate stays open, but HOME_CONFIRMED and
  // the elapsed settling window are deliberately preserved for the next event.
  t.mock.timers.tick(15000);await turn();assert.equal(closes.length,0);
  assert.equal(e._homeDockStableSince,100000);
  assert.equal(e._homeState,'home');
});
test('late station proof after the first 15s wait closes without restarting the full interval',async t=>{
  const {e,closes,frame}=fixture(t);e._scheduleHomeClose('test');
  t.mock.timers.tick(15000);await turn();
  assert.equal(closes.length,0);
  assert.equal(e._homeDockStableSince,100000);
  // The first timer deliberately waited because there was no independent proof.
  // A real later IN_STATION/u0 heartbeat should reuse the already elapsed 15 s.
  t.mock.timers.tick(5000);
  e.device.getCapabilityValue=()=>null;e.device._chargingStatusAt=0;e.device._observedMowerStatusAt=0;
  frame({dockingState:'IN_STATION',undocking:0,chargingLive:false});
  t.mock.timers.tick(0);await turn();
  assert.deepEqual(closes,['home_15s']);
});
test('later IN_STATION/u0 heartbeat completes stable interval even when chargingLive bit lags',async t=>{
  const {e,closes,frame}=fixture(t);e._scheduleHomeClose('test');
  t.mock.timers.tick(10000);
  // Simulate the real A2 sequence from the field: physical station remains true,
  // but the binary charging bit is false while cloud charging is stale/absent.
  e.device.getCapabilityValue=()=>null;e.device._chargingStatusAt=0;e.device._observedMowerStatusAt=0;
  frame({dockingState:'IN_STATION',undocking:0,chargingLive:false});
  assert.equal(e._homeDockStableSince,100000);
  assert.equal(e._homeDockLastProofAt,110000);
  t.mock.timers.tick(5000);await turn();
  assert.deepEqual(closes,['home_15s']);
});
test('fresh cloud charging and fresh IN_STATION may form one strong dock proof',t=>{
  const {e}=fixture(t);
  e.device._mowerBinaryDiag={dockingState:'IN_STATION',undocking:0,chargingLive:false};
  e.device._mowerBinaryDiagAt=Date.now();
  e.device._chargingStatusAt=Date.now();
  e.device.getCapabilityValue=name=>name==='charging_status'?'charging':null;
  assert.equal(e._strongDockCloseProof(),true);
});
test('dock departure during closing invokes existing emergency reversal',t=>{
  const {e,frame}=fixture(t);let reversals=0;
  e.doorState=()=> 'closing';e._homeCloseIssuedAt=Date.now();
  e._handleMovingDoorDangerEmergency=async()=>{reversals++;};
  frame({dockingState:'OUT_OF_STATION',undocking:1,chargingLive:false});
  assert.equal(reversals,1);
});
test('return retry never dispatches a route without native pause acknowledgement',async t=>{
  const {e}=fixture(t);let paused=0,routed=0;
  e._emergencyHoldActive=()=>false;e.device.getData=()=>({id:'test'});
  e.device._api={pause:async()=>{paused++;}};
  e._waitForNativePause=async()=>false;
  e.returnRequested=async()=>{routed++;return true;};
  const hold={token:1,request:{},attempts:0,busy:false,timer:null};
  e._returnRecoveryHold=hold;
  assert.equal(await e._retryReturnRecovery(hold),false);
  assert.equal(paused,1);assert.equal(routed,0);
  e._manualGateStopped=true;
  t.mock.timers.tick(3000);await turn();assert.equal(paused,1);
});
test('confirmed pause allows exactly one return replanning; superseded token blocks retry',async t=>{
  const {e}=fixture(t);let routed=0;
  e._emergencyHoldActive=()=>false;e._stopReturnForRecovery=async()=>true;
  e.returnRequested=async()=>{routed++;return true;};
  const hold={token:1,request:{},attempts:0,busy:false,timer:null};
  e._returnRecoveryHold=hold;
  assert.equal(await e._retryReturnRecovery(hold),true);
  assert.equal(await e._retryReturnRecovery(hold),false);assert.equal(routed,1);
  e._returnRecoveryHold=hold;e._commandToken++;
  assert.equal(await e._retryReturnRecovery(hold),false);assert.equal(routed,1);
});
test('original maintenance TASK survives pause cancellation packet and rejects STOP task',t=>{
  const {e}=fixture(t);e._externalStartRecoveryActive=true;
  e.noteExternalStartTask({t:'TASK',d:{o:109,exe:true,status:false}});
  assert.equal(e._externalStartTask.o,109);
  e._externalStartRecoveryPhase='STOP_OLD_TASK_EARLY';
  e.noteExternalStartTask({t:'TASK',d:{o:3,exe:true,status:true}});
  assert.equal(e._externalStartTask.o,109);
});
