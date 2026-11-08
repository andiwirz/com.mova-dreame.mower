'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Engine=require('../lib/garage/GarageSafetyEngine');

function setup(){
 const calls=[];const now=Date.now();const store=new Map();
 const d={_observedMowerStatus:'paused',_observedMowerStatusAt:now,_maintenancePointIndex:()=>1,
   _resolveNativeMaintenancePoint:async(index)=>({x:4000,y:4000,index}),
   _goToMaintenancePointGuarded:async(_label,index)=>{calls.push(['MAINTENANCE',index]);return true},
   _api:{dock:async()=>{calls.push(['DOCK']);return true}},_safeWrite:async(_name,fn)=>fn(),
   getData:()=>({id:'dummy'}),setStoreValue:async(k,v)=>store.set(k,v)};
 const e=Object.create(Engine.prototype);
 Object.assign(e,{device:d,homey:{i18n:{getLanguage:()=> 'en'}},_commandToken:20,
  _manualRecoveryActive:true,_manualRecoveryPhase:'manual_hold',_manualGateStopped:true,
  _manualRecoveryOpenConfirmedAt:0,_manualRecoveryGatePulseAt:0,
  _lastSensorContactState:'unknown',_lastSensorContactAt:0,
  log:()=>{},error:()=>{},_text:(_de,en)=>en,
  _trigger:(id,reason)=>calls.push(['FLOW',id,reason]),
  sensorEnabled:()=>false,sensorHealthy:()=>false,
  doorState:()=> 'unknown',status:()=> 'paused',
  setDoorState:async(state)=>calls.push(['STATE',state]),
  _setSafetyStatus:async()=>{},
  _watchMaintenanceReached:()=>{calls.push(['WATCH'])},
  markers:{rawDangerState:async()=>({known:true,inside:false,distance:10000,radius:300})},
  pos:()=>({x:4100,y:4100,ts:Date.now()}),
  _distance:(a,b)=>Math.hypot(Number(a?.x)-Number(b?.x),Number(a?.y)-Number(b?.y)),
  _setReturnContext:()=>{},
  _syncPylonLifecyclePhase:async()=>({ok:true}),
  _strongDockCloseProof:()=>false,isDockedHomeStatus:()=>false,_homeDockReadyForClose:()=>false,
  _manualGateOutsidePositionProof:async()=>false,
 });
 return {e,d,calls,store};
}

test('manual rescue gate needs explicit operator confirmation and blocks automatic OPEN/CLOSE',async()=>{
 const {e,calls}=setup();
 assert.equal(await e.manualGateRequest('open'),false);
 assert.equal(await e.manualGateRequest('open',{supervised:true}),true);
 assert.equal(calls.filter(x=>x[0]==='FLOW'&&x[1]==='garage_open_requested').length,1);
 let released=0;
 e.homey.flow={getDeviceTriggerCard:()=>({trigger:async()=>{released++}})};
 e._garageOption=()=>false;
 Engine.prototype._trigger.call(e,'garage_close_requested','automatic_late_close');
 assert.equal(released,0,'automatic gate CLOSE suppressed centrally');
 Engine.prototype._trigger.call(e,'garage_open_requested','automatic_late_open');
 assert.equal(released,0,'automatic gate OPEN suppressed centrally');
 assert.equal(calls.filter(x=>x[0]==='FLOW'&&x[1]==='garage_close_requested').length,0);
 assert.equal(await e.manualGateRequest('open',{supervised:true}),false,'no immediate second toggle');
});

test('manual waypoint route requires physical OPEN acknowledgement, not a timer',async()=>{
 const {e,calls}=setup();
 assert.equal(await e.manualRecoveryToMaintenance(1),false);
 assert.equal(await e.manualRecoveryConfirmGateOpen(true),true);
 assert.equal(await e.manualRecoveryToMaintenance(1),true);
 assert.deepEqual(calls.filter(x=>x[0]==='MAINTENANCE'),[['MAINTENANCE',1]]);
 assert.equal(e._manualGateStopped,true);
 assert.equal(e._manualRecoveryPhase,'maintenance_enroute');
 assert.equal(await e.manualRecoveryToMaintenance(1),false,'no duplicate navigation');
});

test('manual waypoint-to-dock route issues DOCK once, not gate OPEN/CLOSE',async()=>{
 const {e,calls}=setup();
 e._manualRecoveryOpenConfirmedAt=Date.now();
 e._manualRecoveryPhase='maintenance_reached';
 e._lockedReturnMaintenancePoint={x:4000,y:4000,index:1};
 e._manualMaintenanceTargetReachedIndex=1;
 e._manualMaintenanceReached=true;
 e._manualMaintenancePhase='reached';
 assert.equal(await e.manualRecoveryReturnToDock(),true);
 assert.equal(await e.manualRecoveryReturnToDock(),false);
 assert.equal(calls.filter(x=>x[0]==='DOCK').length,1);
 assert.equal(calls.filter(x=>x[0]==='FLOW'&&/garage_(open|close)_requested/.test(x[1])).length,0);
 assert.equal(e._manualGateStopped,true);
});

test('manual recovery rearm impossible before independently proven dock',async()=>{
 const {e,store}=setup();
 assert.equal(await e.manualRecoveryRearmAutomation(),false);
 // Persistent recovery no longer trusts a HOME tile or old 15s timer.
 // Explicit rearm asks the device for fresh physical IN_STATION/u0/charge proof.
 const dock={dockingState:'IN_STATION',undocking:0,chargingLive:true};
 e.device._mowerBinaryDiag=dock;e.device._mowerBinaryDiagAt=Date.now();
 e.device._refreshNativeDockForStart=async()=>dock;
 e.clearSafety=async()=>{};
 assert.equal(await e.manualRecoveryRearmAutomation(),true);
 assert.equal(e._manualRecoveryActive,false);
 assert.equal(e._manualGateStopped,false);
 assert.equal(store.get('garage_manual_recovery_active'),false);
});

test('newly reported unrecoverable emergency latches manual mode persistently',async()=>{
 const {e,store,calls}=setup();
 e._manualRecoveryActive=false;
 e._emergencyGateContext={commandToken:20,createdAt:1234};
 e._timeline=()=>{};
 await e._reportEmergencyRecoveryBlocked(e._emergencyGateContext,'test_failure');
 assert.equal(store.get('garage_manual_recovery_active'),true);
 assert.equal(store.get('garage_manual_gate_stopped'),true);
 assert.equal(e._manualGateStopped,true);
 assert.equal(calls.filter(x=>x[0]==='FLOW'&&x[1]==='garage_position_uncertain').length,1);
});

test('new recovery safety-state changes never implicitly authorize timed gate release',async()=>{
 const {e}=setup();e._manualRecoveryOpenConfirmedAt=Date.now();
 e._lastSensorContactState='closed';e._lastSensorContactAt=Date.now();
 assert.equal(e._manualRecoveryGateOpenProof(),false);
 e._lastSensorContactState='unknown';e._lastSensorContactAt=0;
 assert.equal(e._manualRecoveryGateOpenProof(),true);
 e._manualRecoveryOpenConfirmedAt=0;
 assert.equal(e._manualRecoveryGateOpenProof(),false);
});

test('manual gate OPEN remains available after terminal alarm but physical CLOSED sensor vetoes acknowledgement',async()=>{
 const {e,calls}=setup();
 e._lastSensorContactState='closed';e._lastSensorContactAt=Date.now();
 e.sensorEnabled=()=>true;e.sensorHealthy=()=>true;
 assert.equal(await e.manualGateRequest('open',{supervised:true}),true);
 assert.equal(await e.manualRecoveryConfirmGateOpen(true),false);
 assert.equal(await e.manualRecoveryToMaintenance(1),false);
 assert.equal(calls.filter(x=>x[0]==='MAINTENANCE').length,0);
});

test('manual recovery persists across restart but never persists an unverified open passage',async()=>{
 const {e,store}=setup();
 e._manualRecoveryActive=false;
 await e._enterManualRecovery('exhausted');
 const fresh=Object.create(Engine.prototype);
 fresh.device={getStoreValue:async k=>store.get(k),getSetting:()=>false};
 // A persisted emergency lock must be recoverable, never an implicit OPEN.
 assert.equal(store.get('garage_manual_recovery_active'),true);
 assert.equal(e._manualRecoveryGateOpenProof(),false);
 assert.equal(e._manualGateStopped,true);
});

test('supervised gate release is still available if native telemetry has stalled, but never auto-releases mower',async()=>{
 const {e,calls}=setup();
 e.device._observedMowerStatus='paused';e.device._observedMowerStatusAt=Date.now()-60000;
 assert.equal(await e.manualGateRequest('open',{supervised:true}),true);
 assert.equal(e._manualRecoveryGateOpenProof(),false);
 assert.equal(await e.manualRecoveryToMaintenance(1),false);
 assert.equal(calls.filter(x=>x[0]==='MAINTENANCE').length,0);
});
test('fresh native mowing or returning status vetoes supervised gate motion',async()=>{
 const {e}=setup();
 e.device._observedMowerStatus='returning';e.device._observedMowerStatusAt=Date.now();
 assert.equal(await e.manualGateRequest('open',{supervised:true}),false);
});

test('terminal emergency emits at most one native PAUSE and does not mark standstill proven',async()=>{
 const {e}=setup();let pauses=0;
 e._manualRecoveryActive=false;
 e.device._observedMowerStatus='returning';e.device._observedMowerStatusAt=Date.now();
 e.device._api.pause=async()=>{pauses++;return true};
 await e._enterManualRecovery('blocked');
 assert.equal(pauses,1);
 await e._enterManualRecovery('repeated');
 assert.equal(pauses,1);
 assert.equal(e._manualRecoveryStationary(),false);
});

test('reboot arrival breadcrumb is only usable following fresh geometry + operator OPEN confirmation',async()=>{
 const {e,store,calls}=setup();
 const record={index:1,x:4000,y:4000,at:Date.now()};
 e._manualRecoveryStoredArrival=record;
 e._manualRecoveryPhase='revalidate_point';
 assert.equal(await e.manualRecoveryReturnToDock(),false,'historical arrival never authorizes return alone');
 e._manualRecoveryOpenConfirmedAt=Date.now();
 assert.equal(await e.manualRecoveryReturnToDock(),true,'fresh position + native target + stillness + OPEN proof');
 assert.equal(calls.filter(c=>c[0]==='DOCK').length,1);
 assert.equal(store.get('garage_manual_return_pending'),true);
 e._stopManualReturnWatch();
});

test('reboot revalidation rejects moved native target and stale telemetry without any gate pulse',async()=>{
 const {e,calls}=setup();
 e._manualRecoveryStoredArrival={index:1,x:4000,y:4000,at:Date.now()};
 e._manualRecoveryPhase='revalidate_point';e._manualRecoveryOpenConfirmedAt=Date.now();
 e.device._resolveNativeMaintenancePoint=async()=>({index:1,x:6500,y:6500});
 assert.equal(await e.manualRecoveryReturnToDock(),false);
 e.device._resolveNativeMaintenancePoint=async()=>({index:1,x:4000,y:4000});
 e.device._observedMowerStatusAt=Date.now()-30000;
 assert.equal(await e.manualRecoveryReturnToDock(),false);
 assert.equal(calls.filter(c=>c[0]==='DOCK'||c[0]==='FLOW').length,0);
});

test('return watchdog reports no departure without retrying DOCK or toggling garage gate',async()=>{
 const {e,calls}=setup();
 e.safetyWarning=async()=>{};
 e._manualRecoveryPhase='returning';
 let observer;
 const interval=global.setInterval;
 global.setInterval=(fn)=>{observer=fn;return {unref(){}}};
 try{ e._startManualReturnWatch({x:4100,y:4100,ts:Date.now()}); }
 finally{global.setInterval=interval}
 // Simulate elapsed watchdog interval without waiting or touching hardware.
 const realNow=Date.now;
 Date.now=()=>realNow()+110000;
 try {await observer();} finally {Date.now=realNow}
 assert.equal(e._manualRecoveryPhase,'manual_hold');
 assert.equal(e._manualGateStopped,true);
 assert.equal(calls.filter(c=>c[0]==='DOCK').length,0);
 assert.equal(calls.filter(c=>c[0]==='FLOW'&&/garage_(open|close)_requested/.test(c[1])).length,0);
 assert.equal(calls.filter(c=>c[0]==='FLOW'&&c[1]==='garage_position_uncertain').length,1);
});

test('manual return is capped at two explicit attempts and cannot restart while returning',async()=>{
 const {e,calls}=setup();
 e._manualRecoveryOpenConfirmedAt=Date.now();
 e._manualRecoveryPhase='maintenance_reached';
 e._lockedReturnMaintenancePoint={x:4000,y:4000,index:1};
 e._manualMaintenanceTargetReachedIndex=1;e._manualMaintenanceReached=true;e._manualMaintenancePhase='reached';
 assert.equal(await e.manualRecoveryReturnToDock(),true);
 assert.equal(await e.manualRecoveryReturnToDock(),false);
 e._stopManualReturnWatch();
 e._manualRecoveryPhase='manual_hold';
 e._manualRecoveryStoredArrival={index:1,x:4000,y:4000,at:Date.now()};
 e._manualReturnDispatchUncertainUntil=Date.now()-1; // simulate completed 105 s anti-duplicate cooldown
 assert.equal(await e.manualRecoveryReturnToDock(),true);
 e._stopManualReturnWatch();
 e._manualRecoveryPhase='manual_hold';
 e.safetyWarning=async()=>{};
 assert.equal(await e.manualRecoveryReturnToDock(),false);
 assert.equal(calls.filter(c=>c[0]==='DOCK').length,2);
});
