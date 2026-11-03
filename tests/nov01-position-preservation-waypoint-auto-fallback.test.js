'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Engine=require('../lib/garage/GarageSafetyEngine');

function rig(overrides={}){
 const token=1001,now=Date.now();let maintenanceRequests=0;const origin=Object.freeze({x:-8900,y:-9000,ts:now-12000,mapIndex:0,source:'mqtt'});
 const actual={x:-3700,y:-8000,ts:now-100,source:'siid:1:4'};
 const e=Object.assign(Object.create(Engine.prototype),{
  _commandToken:token,_manualGateStopped:false,_returnGuardActive:true,_safeReturnInProgress:true,
  _returnRecoveryRequest:{token,returnOrigin:origin},
  _lockedReturnMaintenancePoint:{index:2,x:-3200,y:-8300,source:'native'},
  _returnZoneTaskStoppedToken:token,
  _emergencyHoldActive:()=>false,_confirmedStationLockActive:()=>false,doorState:()=> 'closed',
  _text:(de)=>de,_timeline:()=>{},log:()=>{},status:()=> 'paused',
  markers:{rawDangerState:async()=>({known:true,inside:false,distance:4400,radius:900})},
  device:{_activeMapIndex:0,getData:()=>({id:'A2'}),_api:{getProperties:async()=>({code:0,data:{result:[{siid:2,piid:1,code:0,value:3}]}})}},
  _readNativeStationaryPositionForGarage:async(_t,baseline,limit,options)=>({ ...actual,ts:Date.now()}),
  _decideReturnPath:async(_why,position)=>({mode:'direct',reason:'lawn_side',etaFits:false}),
  _startReturnMaintenanceRoute:async(src,_dock,_fn,t)=>{maintenanceRequests++;assert.equal(src,'return_verified_paused_waypoint_fallback');assert.equal(t,token);return true;},
  _confirmNativeIdleForMaintenanceDispatch:async()=>false,
  ...overrides,
 });
 return {e,token,origin,actual,count:()=>maintenanceRequests};
}
const checkpoint={reason:'stop_unconfirmed',stopped:true,verified:false};
test('vendor return retains ORIGINAL request position and uses new 5.2m post-STOP physical position for verified P2 backup',async()=>{
 const {e,token,origin,count}=rig();
 assert.equal(await e._tryReturnWaypointFallbackAfterUnconfirmedStop(token,'external_return',async()=>true,async()=>true,checkpoint),true);
 assert.equal(count(),1);
 assert.equal(e._returnRecoveryRequest.returnOrigin,origin,'unchanged frozen historical route anchor');
 assert.equal(e._returnWaypointFallbackProof.position.x,-3700,'new real measurement is separate from initial origin');
 assert.equal(e._returnWaypointFallbackProof.pointIndex,2);
});
test('unknown P2, stale map, native MOWING, or failed physical pair cannot trigger waypoint auto-drive',async()=>{
 for(const overrides of [
  {_lockedReturnMaintenancePoint:null},
  {device:{_activeMapIndex:1,getData:()=>({id:'A2'}),_api:{getProperties:async()=>({code:0,data:{result:[{siid:2,piid:1,value:3}]}})}}},
  {device:{_activeMapIndex:0,getData:()=>({id:'A2'}),_api:{getProperties:async()=>({code:0,data:{result:[{siid:2,piid:1,value:4}]}})}}},
  {_readNativeStationaryPositionForGarage:async()=>null},
  {_decideReturnPath:async()=>({mode:'maintenance',reason:'position_uncertain'})},
 ]){
  const {e,token,count}=rig(overrides);
  assert.equal(await e._tryReturnWaypointFallbackAfterUnconfirmedStop(token,'external_return',()=>true,()=>true,checkpoint),false);
  assert.equal(count(),0);
 }
});
test('unconfirmed zone MAPD edit must never be disguised as waypoint fallback',async()=>{
 const {e,token,count}=rig();
 assert.equal(await e._tryReturnWaypointFallbackAfterUnconfirmedStop(token,'external_return',()=>true,()=>true,
  {...checkpoint,reason:'mapd_unverified',stopConfirmedAt:Date.now()}),false);
 assert.equal(count(),0);
});
test('native PAUSED(3) waypoint command preflight requires preserved token, recent physical pair and native reread',async()=>{
 const {e,token,actual}=rig();
 e._returnWaypointFallbackProof={token,mapIndex:0,at:Date.now(),pointIndex:2,
   position:{...actual}};
 assert.equal(await e._verifyReturnWaypointFallbackPause(token,'return_verified_paused_waypoint_fallback'),true);
 assert.equal(await e._verifyReturnWaypointFallbackPause(token,'return_regular'),false);
 e._returnWaypointFallbackProof.at=Date.now()-17000;
 assert.equal(await e._verifyReturnWaypointFallbackPause(token,'return_verified_paused_waypoint_fallback'),false);
});
test('PAUSED alone never releases MAPD; only isolated waypoint preflight can drive native 109',async()=>{
 const {e,token,actual}=rig();
 e._returnWaypointFallbackProof={token,mapIndex:0,at:Date.now(),pointIndex:2,position:actual};
 assert.equal(await e._prepareMowerForReturnPath('return_verified_paused_waypoint_fallback'),true);
 assert.equal(await e._prepareMowerForReturnPath('return_anything_else'),false);
});
