'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../lib/garage/GarageSafetyEngine');
const fs = require('node:fs');
const path = require('node:path');

function earlyGateFixture({withStop=true, checkpointAccepted=true, inside=false, recheck=true}={}) {
  const now=Date.now();
  const pos={x:-1580,y:-1590,ts:now-400,source:'siid:1:4'};
  let opens=0,holds=0,checks=0;
  const e=Object.assign(Object.create(Engine.prototype), {
    _commandToken:8,_returnContext:'DOCK',_returnGuardActive:true,_safeReturnInProgress:true,
    _missionOutside:true,_homeState:'away',_outbound:null,_manualGateStopped:false,
    _returnZoneStopProof:withStop?{token:8,statusCode:2,at:now}:null,
    _returnRecoveryRequest:{token:8,routeDecision:{mode:'direct'}},
    _returnLineStopProof:{token:8,kind:'native_pause',at:now-400,requestedAt:now-900,position:pos},
    device:{getData:()=>({id:'mova'}),getSetting:()=>true},
    doorState:()=> 'closed',status:()=> 'idle',pos:()=>pos,
    _emergencyCommandBlocked:()=>false,_emergencyHoldActive:()=>false,
    markers:{rawDangerState:async()=>({known:true,inside,distance:3287,radius:900}),dangerState:async()=>({known:true,inside})},
    _tryNativePauseReturnClearance:async()=>{checks++;return recheck;},
    _distance:(a,b)=>a&&b?Math.hypot(a.x-b.x,a.y-b.y):null,
    _doorOpenDurationSeconds:()=>20,_doorDelaySeconds:()=>20,
    _speedMetersPerSecond:()=>({mps:0.56}),
    sensorEnabled:()=>false,sensorHealthy:()=>true,
    setDoorState:async()=>{opens++;},
    _trigger:()=>{},_garageNotice:()=>{},
    returnOperationalHold:async()=>{holds++;},
    log:()=>{},safetyWarning:async()=>{}
  });
  return {e,counts:()=>({opens,holds,checks})};
}

test('Oct31 17:02 early gate OPEN accepts token-owned native STOP plus renewed physical PAUSE pair',async()=>{
 const {e,counts}=earlyGateFixture();
 const result=await e.requestOpen('return_zone_verified_stop_parallel_open');
 assert.equal(result,true);
 assert.deepEqual(counts(),{opens:1,holds:0,checks:1});
});
test('early gate retry with no token-owned native STOP may NOT open or latch manual recovery',async()=>{
 const {e,counts}=earlyGateFixture({withStop:false});
 assert.equal(await e.requestOpen('return_zone_verified_stop_parallel_open'),false);
 assert.deepEqual(counts(),{opens:0,holds:0,checks:0});
});
test('early gate with contradicting native stationary pair stays closed but leaves later final waiter alive',async()=>{
 const {e,counts}=earlyGateFixture({recheck:false});
 assert.equal(await e.requestOpen('return_zone_verified_stop_parallel_open'),false);
 assert.deepEqual(counts(),{opens:0,holds:0,checks:1});
});
test('early gate cannot open if mower is inside danger radius even after native STOP pair',async()=>{
 const {e,counts}=earlyGateFixture({inside:true});
 assert.equal(await e.requestOpen('return_zone_verified_stop_parallel_open'),false);
 assert.equal(counts().opens,0);
});
test('non-internal generic gate command cannot borrow early zone STOP witness',async()=>{
 const {e,counts}=earlyGateFixture();
 assert.equal(await e.requestOpen('external_direct_return_parallel_open'),false);
 assert.equal(counts().checks,0);
 assert.equal(counts().opens,0);
});

test('final current-position wait discards failed early attempt and starts fresh final verified gate request',async()=>{
 const e=Object.create(Engine.prototype);const events=[];
 Object.assign(e,{
  _commandToken:8,_returnZoneTaskStoppedToken:8,_returnContext:'DOCK',
  _returnZoneCheckpointAttemptedToken:8,_safeReturnInProgress:true,_returnGuardActive:true,
  _awaitingLineDoorOpen:false,_manualGateStopped:false,
  _returnZoneEarlyGateOpening:{token:8,openingStarted:Promise.resolve({ok:false}),gateOpening:Promise.resolve(false)},
  _returnZoneDirectStopProof:{token:8,nativeIdleVerified:true,position:{x:-1580,y:-1590,ts:Date.now()}},
  _maintenanceJourneyOwnsNavigation:()=>false,_reuseVerifiedReturnLineStop:()=>true,
  _awaitFreshStoppedReturnClearance:async()=>true,
  _mayParallelResumeShortReturn:async()=>false,
  _doorOpenReleaseVerified:()=>true,
  _retireMaintenanceArrivalObservation:()=>{},
  _timeline:()=>{},_text:s=>s,
  _setReturnContext:()=>{},
  clearSafety:async()=>{},_trigger:()=>{},
  ensureDoorOpen:async(_reason,options)=>{events.push(_reason);options.onOpenRequestAccepted?.();return true;},
  _returnLineStopProof:{token:8,kind:'native_checkpoint_stop',at:Date.now(),position:{x:-1580,y:-1590,ts:Date.now()}},
  device:{getData:()=>({id:'mova'})},
  _returnDecision:{mode:'direct',etaToLineSec:1},
  log:()=>{},safetyWarning:async()=>{},returnOperationalHold:async()=>{events.push('HOLD');},
 });
 const res=await e._waitAtVerifiedReturnStopUntilDoorOpenThenDock(async()=>{events.push('DOCK');return true;},8,'test','current position');
 assert.equal(res,true);assert.deepEqual(events,['return_current_position_gate_wait','DOCK']);
 assert.equal(e._returnZoneEarlyGateOpening,null);
});

test('manual takeover switch is explicitly nonmoving and independent of physical OPEN report',()=>{
 const code=fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
 assert.match(code,/async beginOperatorManualControl\(supervised = false\)/);
 assert.match(code,/skipNativePause: true/);
 assert.match(code,/this\._manualRecoveryOperatorFree = true/);
 assert.match(code,/async _manualRecoveryFreshDockRearmProof\(\)/);
});
