'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const prior=Module._load; let Device;
try { Module._load=function(n,p,m){if(n==='homey')return{Device:class{}};if(n==='mqtt')return{};return prior.call(this,n,p,m);}; Device=require('../drivers/mower/device.js'); }
finally {Module._load=prior;}
const orphan={mapIndex:0,lifecycle:'departure_mowing',nativeId:null,centerX:-2050,centerY:-350, note:'Ausfahrt 2'};
function fixture(){
 const d=Object.create(Device.prototype);let writes=0;const store=[];
 Object.assign(d,{
  _activeMapIndex:0,_api:{},_cachedMapData:{directMapdGeometryVerified:true,forbiddenAreas:[]},
  _obstacleRulesCache:{'geo:0:-2050:-350':{...orphan}},
  _nativeZonePoliciesCache:{'zone102':{mapIndex:0,lifecycle:'departure_mowing',lifecycleSuspended:true, lastNativeId:102,nativeId:null,shape:2,pointsMm:[[0,0],[1000,0],[1000,1000]]}},
  _logPylonLifecycleAudit:()=>{},_nativeZoneLifecycleLog:()=>{},log:()=>{},
  _findPylonForRule:()=>null,_automaticNativeZoneMapWriteSafe:()=>true,
  _mapEditStationary:()=>true,_nativeMapEditTaskIdleBeforeWrite:async()=>true,
  _pylonLifecycleNativeActive:()=>false,_pylonLifecycleDesiredActive:(_r,phase)=>phase==='departure_ready',
  _nativeZonePolicyNeedsTransition:(policy,phase,map)=>phase==='departure_ready'&&policy.lifecycleSuspended===true&&!(map.forbiddenAreas||[]).some(([id])=>id===102),
  _nativeZonePolicyCurrentEntry:(_policy,map)=>map?.forbiddenAreas?.some(([id])=>id===102)?{id:102}:null,
  _nativeZonePolicyDescriptorMatches:()=>true,_nativeZonePolicyIdentity:()=>({}),_nativeZonePolicyGeometry:(area)=>({pointsMm:area.points||[]}),
  refreshMapData:async()=>{},_scheduleMapCameraImageUpdate:()=>{},
  setStoreValue:async(k,v)=>{store.push(k);},
  _createNativeZoneFromPolicy:async()=>{writes++;d._cachedMapData.forbiddenAreas=[[102,{shape:2,points:[[0,0],[1000,0],[1000,1000]]}]];},
  _waitForNativeZonePolicyTransition:async()=>true,
 });
 return {d,writes:()=>writes,store};
}
test('orphaned pylon is not a recurring poll transition by itself',()=>{
 const {d}=fixture();d._nativeZonePoliciesCache={};
 assert.equal(d._pylonLifecycleNeedsTransition('departure_ready'),false);
 assert.deepEqual(d._obstacleRulesCache['geo:0:-2050:-350'],orphan);
});
test('missing pylon cannot block native zone 102 restoration on verified dock',async()=>{
 const {d,writes}=fixture();
 assert.equal(d._pylonLifecycleNeedsTransition('departure_ready'),true);
 const result=await d._syncPylonLifecyclePhaseInternal('departure_ready',{reason:'verified_dock_restore'});
 assert.equal(writes(),1,'exactly one native restoration');
 assert.equal(result.changed,1);
 assert.equal(result.partial,true);
 assert.equal(result.skippedUnavailablePylons,1);
 assert.equal(d._nativeZonePoliciesCache.zone102.lifecycleSuspended,false);
 assert.equal(d._nativeZonePoliciesCache.zone102.nativeId,102);
 assert.equal(d._pylonLifecycleNeedsTransition('departure_ready'),false,'no repeating home-loop');
});
test('native restore still requires task-free station checkpoint',async()=>{
 const {d,writes}=fixture();d._nativeMapEditTaskIdleBeforeWrite=async()=>false;
 const result=await d._syncPylonLifecyclePhaseInternal('departure_ready',{reason:'verified_dock_restore'});
 assert.equal(writes(),0);assert.equal(result.deferred,true);
 assert.equal(result.reason,'native_restore_requires_task_free_idle');
});
test('a resurfaced pylon makes its lifecycle transition eligible again',()=>{
 const {d}=fixture();d._nativeZonePoliciesCache={};d._findPylonForRule=()=>({id:'obs:real'});
 assert.equal(d._pylonLifecycleNeedsTransition('departure_ready'),true);
});
