'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const original=Module._load;
let Device;
try {
  Module._load=function(id,parent,main){
    if(id==='homey')return {Device:class{}};
    if(id==='mqtt')return {};
    return original.call(this,id,parent,main);
  };
  Device=require('../drivers/mower/device');
} finally {Module._load=original;}
const id='geo:0:1000:2000';
const square=(x=1000,y=2000,r=500)=>({shapeType:2,path:[
  {x:x-r,y:y-r},{x:x+r,y:y-r},{x:x+r,y:y+r},{x:x-r,y:y+r}
]});
function mock(age=60000) {
  const d=Object.create(Device.prototype);
  d._activeMapIndex=0;
  d._obstacleRulesCache={[id]:{ pending:'create',mapIndex:0,nativeId:null,
    beforeIds:[101], centerX:1000,centerY:2000,radius:500,nativeWriteVersion:6,
    action:'observe',updatedAt:Date.now()-age }};
  d._nativeZonePoliciesCache={};
  d._directNativeDeleteUi=new Map();
  d._buildObstaclePylons=()=>[]; // essential regression: MOVA OBS no longer has this pylon
  d._reconcileNativeZoneLabelDeleteWatches=async()=>0;
  d._nativeMapRevisionReadyForConfirmation=()=>true;
  d._clearPendingPylonReadback=()=>{};
  d._scheduleMapCameraImageUpdate=()=>{};
  d.setStoreValue=async()=>{};
  d.log=()=>{};
  return d;
}
function map(areas){ return {forbiddenAreas:areas,
  directMapdVerified:true,directMapdGeometryVerified:true,
  directMapdAuthority:'g2408_top_level_map'}; }
test('1.2.128 native MAPD confirms exact new square despite vanished OBS pylon',async()=>{
  const d=mock();
  assert.deepEqual(d._buildObstaclePylons(),[]);
  assert.equal(d._pendingOrphanPylonOverlays([]).length,1);
  await d._reconcilePylonNativeRules(map([[101,square(5000,6000)],[109,square()]]),{fresh:true});
  const rule=d._obstacleRulesCache[id];
  assert.equal(rule.pending,null);
  assert.equal(rule.action,'avoid');
  assert.equal(rule.nativeId,109);
  assert.equal(rule.verification,'native_square_create_confirmed');
  assert.deepEqual(d._pendingOrphanPylonOverlays([]),[],'blue pending overlay must disappear');
});
test('1.2.128 native current MAPD rejects missing square, clears blue pending as retryable without success',async()=>{
  const d=mock();
  await d._reconcilePylonNativeRules(map([[101,square(5000,6000)]]),{fresh:true});
  const rule=d._obstacleRulesCache[id];
  assert.equal(rule.pending,null);
  assert.equal(rule.action,'observe');
  assert.equal(rule.nativeId,null);
  assert.equal(rule.verification,'native_create_unconfirmed_retryable');
  assert.deepEqual(d._pendingOrphanPylonOverlays([]),[]);
});
test('1.2.128 no false confirmation from stale MAPD or absent direct frame',async()=>{
  const d=mock();
  const old=map([[109,square()]]);
  await d._reconcilePylonNativeRules(old,{fresh:false});
  assert.equal(d._obstacleRulesCache[id].pending,'create');
  assert.equal(d._pendingOrphanPylonOverlays([]).length,1);
});
test('1.2.128 no frozen anchor for invalid map, non-write version, no pending or invalid coordinates',()=>{
  const d=mock();
  const r=d._obstacleRulesCache[id];
  assert.equal(d._pendingPylonReadbackAnchor(id,{...r,mapIndex:1},[]),null);
  assert.equal(d._pendingPylonReadbackAnchor(id,{...r,nativeWriteVersion:3},[]),null);
  assert.equal(d._pendingPylonReadbackAnchor(id,{...r,pending:null},[]),null);
  assert.equal(d._pendingPylonReadbackAnchor(id,{...r,centerX:NaN},[]),null);
  assert.equal(d._pendingPylonReadbackAnchor(id,{...r,centerX:null},[]),null);
  assert.equal(d._pendingPylonReadbackAnchor(id,r,[]).storedAnchor,true);
});
test('1.2.128 duplicate native exact squares must not confirm an ambiguous user write',async()=>{
  const d=mock(1000); // do not release on miss within direct verification window
  await d._reconcilePylonNativeRules(map([[109,square()],[110,square()]]),{fresh:true});
  assert.equal(d._obstacleRulesCache[id].pending,'create');
  assert.equal(d._obstacleRulesCache[id].nativeId,null);
});
