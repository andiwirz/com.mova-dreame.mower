'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Engine=require('../lib/garage/GarageSafetyEngine');
const root=path.resolve(__dirname,'..');
function buildNativeCheck(nativeValue,pairedProof=true){
  const e=Object.create(Engine.prototype),now=Date.now(),token=19;
  const p={x:-6010,y:-1430,source:'siid:1:4',ts:now-150};
  e._commandToken=token;e._manualGateStopped=false;e._returnRecoveryRequest={returnOrigin:{mapIndex:0}};
  e._returnZoneDirectStopProof={token,at:now-100,stopConfirmedAt:now-800,
    stationaryPausedProofAt:pairedProof?now-1300:0,position:p,nativeIdleVerified:true};
  e.device={_activeMapIndex:0,getData:()=>({id:'m'}),_api:{getProperties:async()=>({code:0,data:{result:[{siid:2,piid:1,value:nativeValue,code:0}]}})}};
  e.doorState=()=> 'closed';e.pos=()=>p;e.log=()=>{};
  e._distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  e._readNativeStationaryPositionForGarage=async()=>({...p,ts:Date.now()});
  e.markers={rawDangerState:async()=>({known:true,inside:false,distance:3000,radius:900})};
  return {e,token};
}
test('1.2.81 paused SIID 3 remains valid across second gate check with same-token checkpoint and twin position',async()=>{
  const {e,token}=buildNativeCheck(3,true);
  assert.equal(await e._confirmNativeZoneStopDirectGateClearance(token),true);
});
test('1.2.81 SIID 3 without paired, same-token STOP cannot open gate',async()=>{
  const {e,token}=buildNativeCheck(3,false);
  assert.equal(await e._confirmNativeZoneStopDirectGateClearance(token),false);
});
test('1.2.81 active MOWING SIID 1 cannot open gate, while IDLE 2 can',async()=>{
  const {e,token}=buildNativeCheck(1,true);
  assert.equal(await e._confirmNativeZoneStopDirectGateClearance(token),false);
  e.device._api.getProperties=async()=>({code:0,data:{result:[{siid:2,piid:1,value:2,code:0}]}});
  assert.equal(await e._confirmNativeZoneStopDirectGateClearance(token),true);
});
test('1.2.81 gate ETA reserve is added once: 20+5-9=16 seconds, not fixed five',()=>{
  const e=Object.create(Engine.prototype);
  e._doorOpenDurationSeconds=()=>20;e._doorDelaySeconds=()=>18;
  assert.equal(e._shortReturnGateOverlapMs(9),16000);
  assert.equal(e._shortReturnGateOverlapMs(18),7000);
  assert.equal(e._shortReturnGateOverlapMs(27),0);
});
test('1.2.81 accepted gate-open request owns the overlap timer and widget clears obsolete return notice',()=>{
  const engine=fs.readFileSync(path.join(root,'lib/garage/GarageSafetyEngine.js'),'utf8');
  const ui=fs.readFileSync(path.join(root,'widgets/overview/public/dashboard.js'),'utf8');
  assert.match(engine,/onOpenRequestAccepted:\s*\(\)\s*=>\s*openingAcknowledged\(/);
  assert.match(engine,/waitForContactOrEta=openingStarted\.then\(async start=>/);
  assert.match(ui,/function reconcileNavigationFeedback\(snapshot\)/);
  assert.match(ui,/state==='garage_home'/);
  assert.match(ui,/pendingNavigationFeedback=null;/);
});

test('1.2.81 sparse MQTT after STOP may use a freshly rechecked native position for short return',async()=>{
  const e=Object.create(Engine.prototype),token=19,now=Date.now();
  e._commandToken=token;e._manualGateStopped=false;e._safeReturnInProgress=true;
  e._returnGuardActive=true;e._returnContext='DOCK';e._returnDecision={mode:'direct',etaFits:false};
  e._emergencyHoldActive=()=>false;e._maintenanceJourneyOwnsNavigation=()=>false;
  e.sensorEnabled=()=>true;e.sensorHealthy=()=>true;e.log=()=>{};
  e._lawnLineSide=1;e._returnZoneTaskStoppedToken=token;
  e._returnZoneDirectStopProof={token,at:now,nativeIdleVerified:true,position:{x:-6010,y:-1430,source:'siid:1:4',ts:now}};
  e._confirmNativeZoneStopDirectGateClearance=async()=>true;
  e.pos=()=>null;e.device={_observedMowerStatus:'mowing',_observedMowerStatusAt:now};
  e.markers={rawDangerState:async()=>({known:true,inside:false,distance:3500,radius:900}),
    lineState:async()=>({known:true,onSegment:true,side:1,distance:1700,direction:{lawnSide:1}})};
  assert.equal(await e._mayParallelResumeShortReturn(token),true);
  e._confirmNativeZoneStopDirectGateClearance=async()=>false;
  assert.equal(await e._mayParallelResumeShortReturn(token),false);
});
