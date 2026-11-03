'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Engine=require('../lib/garage/GarageSafetyEngine');
const {setImmediate:turn}=require('node:timers/promises');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

function bareEngine(){
  const e=Object.create(Engine.prototype);
  e._distance=(a,b)=>Math.hypot(Number(b.x)-Number(a.x),Number(b.y)-Number(a.y));
  return e;
}

test('v195 maintenance departure proof needs fresh post-command physical movement',()=>{
  const e=bareEngine();
  const now=100000;
  const start={x:0,y:0,ts:90000};
  let r=e._maintenanceDepartureEvidence(start,{x:100,y:0,ts:99500},90000,now);
  assert.equal(r.fresh,true); assert.equal(r.moved,false);
  r=e._maintenanceDepartureEvidence(start,{x:200,y:0,ts:99500},90000,now);
  assert.equal(r.fresh,true); assert.equal(r.moved,true);
  r=e._maintenanceDepartureEvidence(start,{x:300,y:0,ts:70000},90000,now);
  assert.equal(r.fresh,false); assert.equal(r.moved,false);
  r=e._maintenanceDepartureEvidence(start,{x:300,y:0,ts:89500},90000,now);
  assert.equal(r.fresh,true); // 1 s ordering tolerance for normal cloud packet ordering
});

test('v195 maintenance command is not retried merely because status still looks active',async()=>{
  const e=bareEngine();
  let maintenanceCalls=0,pauseCalls=0;
  Object.assign(e,{
    _commandToken:7,
    _manualGateStopped:false,
    _prepareMowerForReturnPath:async()=>{},
    status:()=> 'returning',
    device:{getData:()=>({id:'fixture'}),_api:{pause:async()=>{pauseCalls++;}}},
    log:()=>{},error:()=>{},
  });
  const ok=await e._sendMaintenanceWithRetry(async()=>{maintenanceCalls++;return true;},7,'test');
  assert.equal(ok,true);
  assert.equal(maintenanceCalls,1);
  assert.equal(pauseCalls,0);
});

test('v195 return timeline does not claim movement until physical departure is confirmed',()=>{
  const e=bareEngine();
  e._text=(de)=>de;
  e.device={getSetting:(key)=>key==='garage_debug_verbose'};
  const selected=e._timelineFromLog(['return context','MAINTENANCE','test'],'');
  assert.match(selected.msg,/Wartungspunkt-Route aktiv/);
  assert.doesNotMatch(selected.msg,/Fährt zum Wartungspunkt/);
  const requested=e._timelineFromLog(['maintenance departure requested','test'],'');
  assert.match(requested.msg,/Start wird geprüft/);
  const moving=e._timelineFromLog(['maintenance departure confirmed','distance=220mm','test'],'');
  assert.match(moving.msg,/Bewegung bestätigt/);
});

test('v195 position watcher owns exactly one delayed maintenance retry and early no-departure block',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  assert.match(src,/MAINTENANCE_DEPARTURE_GRACE_MS = 45000/);
  assert.match(src,/MAINTENANCE_DEPARTURE_RETRY_GRACE_MS = 45000/);
  assert.match(src,/MAINTENANCE_DEPARTURE_CONFIRM_HITS = 2/);
  assert.match(src,/Never resend blindly while position telemetry is stale\/missing/);
  assert.match(src,/maintenance departure retry/);
  assert.match(src,/maintenance_departure_not_started/);
  assert.doesNotMatch(src,/_sendMaintenanceWithRetry[\s\S]{0,1800}sleep\(3500\)/);
});

test('v195 generic paused maintenance arrival needs movement or known-target proximity',()=>{
  const src=read('drivers/mower/device.js');
  assert.match(src,/generic paused\/standby not accepted as arrival without movement\/target proof/);
  assert.match(src,/_maintenanceMovedEnough/);
  assert.match(src,/distance <= 700/);
});

test('v195 keeps all three close priorities and all three guarded return/open routes',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  assert.match(src,/exit close priority 1: ETA sufficient/);
  assert.match(src,/priority 2 held: lawn-side clearance too small/);
  assert.match(src,/exit close priority 3: third crossing pause fallback/);
  assert.match(src,/lawn_side_eta_sufficient_direct/); // direct/parallel-open route
  assert.match(src,/_waitAtSafetyLineUntilDoorOpenThenDock/); // safety-line pause/open/release route
  assert.match(src,/Near garage, in danger area, or unclear position: deterministic maintenance path/); // maintenance route
});

test('v195 normal resume wording no longer labels an ordinary pause as an error',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  assert.match(src,/Mähvorgang fortgesetzt – außerhalb der Garage, kein Torvorgang nötig/);
  assert.doesNotMatch(src,/Mähvorgang nach Fehler\/Pause fortgesetzt/);
});


test('v195 stationary return-maintenance retries once after grace then blocks instead of waiting five minutes',async t=>{
  t.mock.timers.enable({apis:['setInterval','Date'],now:100000});
  const e=bareEngine();
  let retryCalls=0; const failures=[];
  Object.assign(e,{
    _commandToken:1,
    _maintenanceWatch:null,
    _maintenanceRequestedAt:0,
    _maintenanceStableHits:0,
    _maintenanceLastConfirmPositionTs:0,
    _manualMaintenanceTransit:false,
    _manualMaintenanceCalibration:false,
    _manualMaintenanceRecalibration:false,
    _returnContext:'MAINTENANCE',
    _safeReturnInProgress:true,
    pos:()=>({x:0,y:0,ts:Date.now()}),
    _updateManualMaintenanceJourneyPhase:async()=>{},
    isAtMaintenancePointHeuristic:async()=>false,
    refreshTileStatus:async()=>{},
    safetyBlock:async()=>{},
    log:()=>{},error:()=>{},_trigger:()=>{},
    device:{_nativeMaintenanceCommandAt:100000,_pendingNativeMaintenanceArrival:null,_nativeMaintenanceStableArrival:null,_dockPos:null,_cachedMapData:null},
  });
  e._watchMaintenanceReached(async()=>{},async()=>{}, {
    requireDepartureProof:true,
    departureStartPos:{x:0,y:0,ts:100000},
    commandAt:100000,
    source:'test',
    retryFn:async()=>{retryCalls++;e.device._nativeMaintenanceCommandAt=Date.now();return true;},
    onDepartureFailure:async r=>failures.push(r),
  });
  t.mock.timers.tick(46000); await turn(); await turn();
  assert.equal(retryCalls,1); assert.deepEqual(failures,[]);
  t.mock.timers.tick(46000); await turn(); await turn();
  assert.deepEqual(failures,['maintenance_departure_not_started']);
  assert.equal(e._maintenanceWatch,null);
  assert.equal(e._maintenanceRequestedAt,0);
});


test('v195 first real movement sample suppresses retry while waiting for second confirmation',async t=>{
  t.mock.timers.enable({apis:['setInterval','Date'],now:100000});
  const e=bareEngine();
  let x=0,retryCalls=0; const failures=[];
  Object.assign(e,{
    _commandToken:1,_maintenanceWatch:null,_maintenanceRequestedAt:0,_maintenanceStableHits:0,_maintenanceLastConfirmPositionTs:0,
    _manualMaintenanceTransit:false,_manualMaintenanceCalibration:false,_manualMaintenanceRecalibration:false,
    _returnContext:'MAINTENANCE',_safeReturnInProgress:true,
    pos:()=>({x,y:0,ts:Date.now()}),
    _updateManualMaintenanceJourneyPhase:async()=>{},isAtMaintenancePointHeuristic:async()=>false,
    refreshTileStatus:async()=>{},safetyBlock:async()=>{},log:()=>{},error:()=>{},_trigger:()=>{},
    device:{_nativeMaintenanceCommandAt:100000,_pendingNativeMaintenanceArrival:null,_nativeMaintenanceStableArrival:null,_dockPos:null,_cachedMapData:null},
  });
  e._watchMaintenanceReached(async()=>{},async()=>{}, {
    requireDepartureProof:true,departureStartPos:{x:0,y:0,ts:100000},commandAt:100000,source:'test',
    retryFn:async()=>{retryCalls++;return true;},onDepartureFailure:async r=>failures.push(r),
  });
  t.mock.timers.tick(44000); await turn(); await turn();
  x=200;
  t.mock.timers.tick(2000); await turn(); await turn();
  assert.equal(retryCalls,0); // first moved sample must not trigger a concurrent retry
  t.mock.timers.tick(2000); await turn(); await turn();
  assert.equal(retryCalls,0); assert.deepEqual(failures,[]);
  t.mock.timers.tick(50000); await turn(); await turn();
  assert.equal(retryCalls,0); assert.deepEqual(failures,[]);
  clearInterval(e._maintenanceWatch); e._maintenanceWatch=null;
});
