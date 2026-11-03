'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const Garage=require('../lib/garage/GarageSafetyEngine');
const Api=require('../lib/MovaApi');
const previous=Module._load;
let Device;
try {
 Module._load=function(name,parent,main){if(name==='homey')return {Device:class{}};if(name==='mqtt')return {};return previous.call(this,name,parent,main);};
 Device=require('../drivers/mower/device');
} finally {Module._load=previous;}
function fixture({noPhysical=false, changedPosition=false, noIdleProof=false, noStopWitness=false, closing=false, emergency=false}={}){
 const now=Date.now();
 const e=Object.create(Garage.prototype);const d=Object.create(Device.prototype);
 const anchor={x:-2820,y:-4670,ts:now-150};
 const door=closing?'closing':'opening';
 const opening={token:10,arrivedAt:now-1300,mapIndex:0,at:now-300,position:{x:anchor.x,y:anchor.y}};
 const idle={token:10,arrivedAt:opening.arrivedAt,mapIndex:0,at:now-200,position:anchor};
 Object.assign(e,{device:d,_commandToken:10,_returnContext:'MAINTENANCE',_safeReturnInProgress:true,
  _returnGuardActive:true,_manualGateStopped:false,_manualMaintenanceTransit:false,_manualMaintenanceReached:true,
  _manualMaintenancePhase:'reached',_outbound:false,_manualMaintenanceTargetReachedIndex:1,
  _lockedReturnMaintenancePoint:{index:1,x:-3090,y:-4700},_lastMaintenanceReachedAt:opening.arrivedAt,
  _returnMaintenanceOpeningMapCheckpoint:opening,_returnMaintenanceStopProof:noStopWitness?null:{token:10,at:now-350,
   mapIndex:0,statusCode:2,position:anchor},_returnMaintenanceTaskIdleProof:noIdleProof?null:idle,
  _returnRecoveryRequest:{returnOrigin:{mapIndex:0}},_emergencyHoldActive:()=>emergency,
  enabled:()=>true,doorState:()=>door,status:()=> 'mowing',
  pos:()=>changedPosition?{x:anchor.x+1200,y:anchor.y,ts:Date.now()-100}:{...anchor,ts:Date.now()-100},
  _distance:(a,b)=>Math.hypot(Number(a.x)-Number(b.x),Number(a.y)-Number(b.y)),
  _readNativeStationaryPositionForGarage:async()=>noPhysical?null:{x:anchor.x,y:anchor.y,ts:Date.now()},
 });
 Object.assign(d,{_garageSafety:e,_activeMapIndex:0,
  _nativeMowerStatus:'mapping',_observedMowerStatus:'mowing',_observedMowerStatusAt:now-50,
  _livePos:{x:anchor.x,y:anchor.y,ts:now-100},getCapabilityValue:()=> 'mapping'});
 const api=Object.create(Api.prototype);const ops=[];
 api.sendAction=async (_did,_s,_a,params)=>{
   const op=Number(params?.[0]?.o);ops.push(op);
   return {result:{out:[{status:true,error:0,r:0}]}};
 };
 const opts={deadlineAt:now+10000,captureTaskCursor:()=>0,
  waitForTask:async op=>({t:'TASK',d:{o:op,status:true,error:0}}),
  canMutate:async legs=>d._returnZoneMutationAuthorized(10,0,legs)};
 return {e,d,api,ops,opts};
}
test('Nov03 native 200/204 transient MOWING at verified P1: paired SIID permits exactly 218',async()=>{
 const s=fixture();
 assert.equal(s.e.isVerifiedMaintenanceOpeningMapCheckpoint(),false,
  'generic callers must not bypass transient MOWING');
 const result=await s.api.deleteForbiddenAreas('mower',[102],0,s.opts);
 assert.equal(result.ok,true);assert.deepEqual(s.ops,[200,204,218,201]);
});
test('Nov03 editor MOWING may be verified with two fresh physical positions even without a retained old P1 STOP object',async()=>{
 const s=fixture({noStopWitness:true});
 assert.equal((await s.api.deleteForbiddenAreas('mower',[102],0,s.opts)).ok,true);
 assert.deepEqual(s.ops,[200,204,218,201]);
});
for(const [name,options] of [
 ['no native paired positions',{noPhysical:true}],
 ['physical position has moved',{changedPosition:true}],
 ['no proven task-free IDLE',{noIdleProof:true}],
 ['gate closing',{closing:true}],
 ['emergency active',{emergency:true}],
])test(`Nov03 native map mutation forbidden: ${name}`,async()=>{
 const s=fixture(options);
 await assert.rejects(s.api.deleteForbiddenAreas('mower',[102],0,s.opts),/checkpoint expired/);
 assert.deepEqual(s.ops,[200,204,201]);
});
test('Nov03 independent direct MAPD proof is reused by maintenance same-token continuation',async()=>{
 const e=Object.create(Garage.prototype),now=Date.now();
 const calls=[];
 Object.assign(e,{_commandToken:10,_manualGateStopped:false,_safeReturnInProgress:true,_returnGuardActive:true,
  _returnContext:'RETURN_STARTED',_returnZoneRecoveryRequest:{token:10},
  _confirmedStationLockActive:()=>false,_emergencyHoldActive:()=>false,
  _returnZoneCheckpointAttemptedToken:null,_returnZoneCheckpointVerifiedToken:null,
  status:()=> 'idle',log:()=>{},_timeline:()=>{},_text:s=>s,
  refreshTileStatus:async()=>{},_awaitFreshStoppedReturnClearance:async()=>false,
  device:{_observedMowerStatus:'idle',getData:()=>({id:'a'}),_activeMapIndex:0,
    _returnZoneRemovalCandidates:()=>[{id:102}],_api:{stopMowing:async()=>true,
      getProperties:async()=>({code:0,data:{result:[{siid:2,piid:1,code:0,value:2}]}})},
    _safeWrite:async(_tag,fn)=>fn(),refreshMapData:async()=>{},
    _cachedMapData:{directMapdGeometryVerified:true},_automaticNativeZoneMapWriteSafe:()=>true,
    _syncPylonLifecyclePhase:async()=>({ok:true}),_verifyReturnZoneRemoval:async()=>true},
 });
 const p=await e._prepareReturnZoneCheckpoint(10,'original_app',{mode:'direct'});
 assert.equal(p.verified,true);
 assert.equal(e._returnZoneCheckpointVerifiedToken,10,
  'same-token P1 continuation must not re-delete already absent zone');
 assert.equal(e._returnZoneCheckpointAttemptedToken,10);
 e._returnContext='MAINTENANCE';
 assert.equal(await e._prepareMaintenanceReturnZoneCheckpoint(10),true);
});
