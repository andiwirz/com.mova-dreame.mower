'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: turn } = require('node:timers/promises');
const Engine = require('../lib/garage/GarageSafetyEngine');
const { DurableRoute } = require('../lib/map/DurableRoute');
const { HomeyCamera } = require('../lib/video/HomeyCamera');
const dashboard = require('../lib/widgets/MowerDashboard');
function engine() {
 const e=Object.create(Engine.prototype);
 Object.assign(e,{_commandToken:1,_lockedReturnMaintenancePoint:{x:1400,y:0},device:{_observedMowerStatus:'paused',getCapabilityValue:()=>null,getSetting:()=>false},
 pos:()=>({x:1400,y:0,ts:Date.now()}),status:()=>e.device._observedMowerStatus,doorState:()=> 'closed',_emergencyHoldActive:()=>false,
 markers:{rawDangerState:async()=>({known:true,distance:1400,radius:600})},safetyWarning:async()=>{},enabled:()=>true});return e;
}
async function advance(t,promise,seconds=13){for(let i=0;i<seconds*2;i++){await turn();t.mock.timers.tick(500);}return promise;}
test('already at maintenance: independent stable samples establish arrival without another trip',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});const e=engine();
 assert.equal(await advance(t,e._establishMaintenanceReturnReleaseFromCurrentPosition(1),3),true);
 assert.equal(e._manualMaintenancePhase,'reached');
});
test('one cached coordinate never becomes a new maintenance arrival',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});const e=engine();e.pos=()=>({x:1400,y:0,ts:100000});
 assert.equal(await advance(t,e._establishMaintenanceReturnReleaseFromCurrentPosition(1)),false);
 assert.notEqual(e._manualMaintenanceReached,true);
});
test('returning mower gets pause request but no synthetic arrival when native status remains returning',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});const e=engine();let pauses=0;e.device._observedMowerStatus='returning';e.device.getData=()=>({id:'fixture'});e.device._api={pause:async()=>{pauses++;return true;}};
 assert.equal(await advance(t,e._establishMaintenanceReturnReleaseFromCurrentPosition(1)),false);assert.equal(pauses,1);
});
test('manual STOP cancels pending release and blocks automatic gate movement',async()=>{
 const e=engine();let cancelled=0,paused=0,trigger=null;e._trigger=id=>{trigger=id;};e.cancelPendingCommand=()=>{cancelled++;e._commandToken++;};e.device.setStoreValue=async()=>{};e.setDoorState=async()=>{};e._pauseMowerForGateInterlock=async()=>{paused++;};
 await e.stopGateManually();assert.equal(e._manualGateStopped,true);assert.equal(trigger,'garage_stop_requested');assert.equal(cancelled,1);assert.equal(paused,1);
 assert.equal(await e.requestOpen('timer'),false);assert.equal(await e.requestClose('timer'),false);assert.equal(await e._forceDoorDirectionForEmergency('open'),false);
});
test('STOP latch survives rejected explicit direction and only clears after accepted safe request',async()=>{
 const e=engine();e._manualGateStopped=true;e.device.setStoreValue=async()=>{};e.requestOpen=async()=>false;
 assert.equal(await e.manualGateRequest('open'),false);assert.equal(e._manualGateStopped,true);
 e.requestOpen=async()=>true;assert.equal(await e.manualGateRequest('open'),true);assert.equal(e._manualGateStopped,false);
});
test('old charging value cannot prove physical docking; fresh OUT_OF_STATION contradicts charging',()=>{
 const e=engine();e.device.getCapabilityValue=()=> 'charging';e.device._chargingStatusAt=Date.now()-20000;assert.equal(e._strongDockCloseProof(),false);
 e.device._chargingStatusAt=Date.now();assert.equal(e._strongDockCloseProof(),true);
 e.device._mowerBinaryDiag={dockingState:'OUT_OF_STATION',undocking:0};e.device._mowerBinaryDiagAt=Date.now();assert.equal(e._strongDockCloseProof(),false);
});
test('durable route keeps all lanes across shorter cloud snapshots, restart, pause and finish',()=>{
 let d=new DurableRoute();d.begin(1);const path=[[0,0],[0,1000],[500,1000],[500,0]];d.ingest(1,path,{cloud:true});
 d=new DurableRoute(d.snapshot());d.ingest(1,[[500,1000],[500,0]],{cloud:true});assert.deepEqual(d.path(1),path);
 d.finish(1);d.ingest(1,[[800,0],[800,1000]],{cloud:true});assert.deepEqual(d.path(1),path);
 d.begin(1,{fresh:true,blockedPath:path});d.ingest(1,path,{cloud:true});assert.deepEqual(d.path(1),[]);
 d.ingest(1,[[0,0],[100,0]]);assert.deepEqual(d.path(1),[[0,0],[100,0]]);
});
test('routes on different maps and coordinate jumps never create connecting mowing stripes',()=>{
 const d=new DurableRoute();d.begin(1);d.ingest(1,[[0,0],[100,0],[10000,0],[10100,0]]);d.begin(2);d.ingest(2,[[50,50],[100,50]]);
 assert.deepEqual(d.path(1),[[0,0],[100,0],[32767,-32768],[10000,0],[10100,0]]);assert.deepEqual(d.path(2),[[50,50],[100,50]]);
});
test('automatic garage camera preview API is absent',()=>{
 const e=engine();const d=e.device;d._garageSafety=e;const b=new HomeyCamera(d,{});
 assert.equal(typeof b.autoPreviewAllowed,'undefined');assert.equal(typeof b.autoPreviewMode,'undefined');
});

test('overview exposes door state and routes commands through existing listeners',async()=>{
 const e=engine();e.doorState=()=> 'opening';e._manualGateStopped=true;let called;
 const d={_garageSafety:e,getId:()=> 'id',getData:()=>({id:'raw'}),getName:()=> 'Mäher',getCapabilityValue:()=>null,triggerCapabilityListener:async(...args)=>{called=args;}};
 const homey={drivers:{getDriver:()=>({getDevices:()=>[d]})}};
 assert.equal(dashboard.overview(d).door,'opening');assert.equal(dashboard.overview(d).doorStopped,true);
 await dashboard.command({homey,query:{deviceId:'id'},body:{action:'return'}});assert.deepEqual(called,['cmd_dock',true,{}]);
 await assert.rejects(dashboard.command({homey,query:{deviceId:'different'},body:{action:'mow'}}),/nicht gefunden/);
});
