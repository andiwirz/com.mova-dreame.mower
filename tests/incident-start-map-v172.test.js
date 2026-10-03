'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const Engine=require('../lib/garage/GarageSafetyEngine');
function engine(){
 const e=Object.create(Engine.prototype);
 e._commandToken=4;e._homeState='leaving';e._returnContext='IDLE';e._manualGateStopped=false;e._outbound={requiresMowingStable:true,requestedAt:Date.now(),released:false,originalCommandSentAt:null};
 e.device={_nativeMowerStatus:'idle',getCapabilityValue:()=> 'idle',hasCapability:()=>true,getSetting:()=>null};
 e.enabled=()=>true;e.status=()=>e.device._nativeMowerStatus;e.doorState=()=> 'open';e.isDoorOpenStable=()=>true;e.isDockedHomeStatus=()=>false;e._setHomeState=async value=>{e._homeState=value;};e.refreshTileStatus=async()=>{};e._scheduleOutboundStatusTimers=()=>{};e.log=()=>{};
 return e;
}
test('an open gate alone is never departure; accepted mower command starts five seconds Ausfahrt immediately',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});const e=engine();e._outbound.requestedAt=Date.now();assert.equal(e.getTileStatus('idle'),'garage_start_pending');e.doorState=()=> 'opening';assert.equal(e.getTileStatus('idle'),'garage_opening');e.doorState=()=> 'open';await e._markOutboundReleased();assert.equal(e.getTileStatus('idle'),'garage_exiting');t.mock.timers.tick(4999);assert.equal(e.getTileStatus('idle'),'garage_exiting');t.mock.timers.tick(1);assert.equal(e.getTileStatus('idle'),'garage_adjusting');t.mock.timers.tick(44999);assert.equal(e.getTileStatus('idle'),'garage_adjusting');t.mock.timers.tick(1);assert.equal(e.getTileStatus('idle'),'garage_positioning');
});
test('a brief mowing status does not acknowledge a start that later falls back to idle',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});const e=engine();e._outbound.mowingSince=Date.now();e.device._nativeMowerStatus='mowing';assert.equal(e._startConfirmedByNativeOrMovement(),false);t.mock.timers.tick(2000);e.device._nativeMowerStatus='idle';e._outbound.mowingSince=null;assert.equal(e._startConfirmedByNativeOrMovement(),false);e.device._nativeMowerStatus='mowing';e._outbound.mowingSince=Date.now();t.mock.timers.tick(8000);assert.equal(e._startConfirmedByNativeOrMovement(),true);
});
test('maintenance departure uses the same immediate Ausfahrt then Justieren contract',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});const e=engine();e._manualMaintenanceTransit=true;e._manualMaintenancePhase='start_pending';assert.equal(e.getTileStatus('idle'),'garage_start_pending');e._manualMaintenanceCommandAcceptedAt=Date.now();e._manualMaintenanceExitUntil=Date.now()+5000;e._manualMaintenancePhase='exiting';assert.equal(e.getTileStatus('idle'),'garage_exiting');t.mock.timers.tick(5000);e._manualMaintenancePhase='adjusting';assert.equal(e.getTileStatus('idle'),'garage_adjusting');
});
const Module=require('node:module');
const savedLoad=Module._load;
let Device;
try {
 Module._load=function(id,parent,main){if(id==='homey')return{Device:class{}};if(id==='mqtt')return{};return savedLoad.call(this,id,parent,main);};
 Device=require('../drivers/mower/device');
} finally {Module._load=savedLoad;}
function mapDevice(store={}){
 const d=Object.create(Device.prototype);
 d._activeMapIndex=0;d._api=null;d._cachedMapData=null;d._livePos=null;d._dockPos=null;d._garageSafety=null;d._obstacleDiagUpdatedAt=Date.now();d._cachedObstacles={obs:[],aiobs:[]};
 d.getStoreValue=k=>store[k]??null;d.setStoreValue=async(k,v)=>{store[k]=v;};d.getSetting=k=>k==='garage_mode_enabled'||k==='garage_map_overlay_enabled';d.getData=()=>({id:'fixture'});d.log=()=>{};d.getCapabilityValue=()=> 'idle';d._buildObstaclePylons=()=>[{id:'p1',x:1,y:1,rule:{action:'observe',radius:500}}];d._resolveStableMaintenancePoint=async()=>null;return d;
}
test('a cached complete manufacturer garden survives an empty cloud response and retains lanes',async()=>{
 const store={},d=mapDevice(store);d._cachedMapData={name:'Originalgarten',boundary:{x1:0,y1:0,x2:4000,y2:4000},md5sum:'version-a',mowingAreas:[[1,{path:[{x:0,y:0},{x:4000,y:0},{x:4000,y:4000}]}]],livePath:[[100,100],[300,100]]};
 await d._saveLastCompleteMap();assert.ok(store.last_complete_mower_map_v1.map.mowingAreas.length);assert.equal(store.last_complete_mower_map_v1.map.livePath,undefined);
 const fresh=mapDevice(store);fresh._durableRoute={entry:()=>({active:false}),path:()=>[[100,100],[300,100]]};fresh._collectDurableRoute=()=>{};fresh._garageSafety={getGarageOverlayData:async()=>({lineA:{x:0,y:0},lineB:{x:0,y:1000},dangerCenter:{x:10,y:10}})};
 const actual=await fresh.getMapData();assert.equal(actual.name,'Originalgarten');assert.equal(actual.mowingAreas.length,1);assert.ok(actual.boundary);assert.equal(actual.livePath.length,2);
});
test('with absent cloud garden, actual stored line and retained route yield a marked diagnostic canvas',async()=>{
 const d=mapDevice({garage_line_a:{x:0,y:0},garage_line_b:{x:0,y:1500},garage_danger_center:{x:200,y:300}});
 d._durableRoute={path:()=>[[300,300],[600,400]]};const fallback=await d.getMapData();assert.equal(fallback.mapFallbackReason,'no_official_map_payload');assert.deepEqual(fallback.livePath,[[300,300],[600,400]]);assert.equal(fallback.obstaclePylons.length,1);assert.equal(fallback.mowingAreas.length,0);assert.ok(fallback.boundary);
});
test('verified maintenance start closes the gate and skips garage exit phases',async()=>{
 const e=engine();e._outbound=null;e._manualMaintenanceReached=true;e._manualMaintenancePhase='reached';e._manualMaintenanceTransit=false;
 e.isReturnCycleActive=()=>false;e._isCurrentlyAtKnownMaintenancePoint=async()=>true;
 e.doorState=()=>e._testDoor||'open';e.requestClose=async(_reason,opts)=>{assert.equal(opts.maintenanceArrivalVerified,true);e._testDoor='closing';return true;};
 e._waitForDoorClosedOrTimeout=async()=>{e._testDoor='closed';return true;};
 e._waitForMowerOnlineBeforeStart=async()=>true;e._beginOutbound=async()=>{throw Error('no garage departure at maintenance');};
 let resolve,entered=false;const running=e.startRequested('button_start_mowing',()=>new Promise(r=>{entered=true;resolve=r;}));
 for(let i=0;i<15&&!entered;i++)await new Promise(r=>setImmediate(r));
 assert.equal(entered,true);assert.equal(e._testDoor,'closed');assert.equal(e._outbound,null);
 resolve(true);assert.equal(await running,true);assert.equal(e._manualMaintenanceReached,false);assert.equal(e._homeState,'away');
});
