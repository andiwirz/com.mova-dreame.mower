'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const originalLoad=Module._load;
let Device;
try {
  Module._load=function(id,parent,main){
    if(id==='homey') return {Device:class{}};
    if(id==='mqtt') return {};
    return originalLoad.call(this,id,parent,main);
  };
  Device=require('../drivers/mower/device');
} finally { Module._load=originalLoad; }

test('field fix: current g2408 MAPD no-op releases create Pending without a revision-hash change',async()=>{
  const d=Object.create(Device.prototype);
  d._activeMapIndex=0;
  d._pendingPylonReadbackTimers=new Map();
  d._nativeZoneLabelDeleteWatches={};
  d._nativeZoneLabelsCache={};
  d._directNativeDeleteUi=new Map();
  d._obstacleRulesCache={
    'geo:0:1000:2000':{
      pending:'create',mapIndex:0,nativeId:null,beforeIds:[101],
      centerX:1000,centerY:2000,radius:500,nativeWriteVersion:6,
      action:'observe',updatedAt:Date.now()-60000,
    },
  };
  d._buildObstaclePylons=()=>[{id:'obs:1',x:1000,y:2000,source:'obs',coordinateScaleUncertain:false}];
  d._nativePylonZoneMatches=()=>false;
  d._nativeForbiddenShape=()=>2;
  d._reconcileNativeZoneLabelDeleteWatches=async()=>0;
  d._scheduleMapCameraImageUpdate=()=>{};
  d._clearPendingPylonReadback=()=>{};
  d.setStoreValue=async()=>{};
  d.log=()=>{};
  const map={
    forbiddenAreas:[[101,{type:2,shapeType:2,path:[{x:-100,y:-100},{x:100,y:-100},{x:100,y:100},{x:-100,y:100}]}]],
    directMapdVerified:true,directMapdGeometryVerified:true,directMapdAuthority:'g2408_top_level_map',
  };
  await d._reconcilePylonNativeRules(map,{fresh:true});
  const rule=d._obstacleRulesCache['geo:0:1000:2000'];
  assert.equal(rule.pending,null);
  assert.equal(rule.action,'observe');
  assert.equal(rule.verification,'native_create_unconfirmed_retryable');
});

test('field fix: map hard refresh keeps the registered Homey image source alive',()=>{
  const src=read('drivers/mower/device.js');
  const start=src.indexOf('if (hard) {');
  const end=src.indexOf('this._mapForceRefreshPromise',start);
  assert.ok(start>0&&end>start);
  const block=src.slice(start,end);
  assert.doesNotMatch(block,/this\._mapCameraImage\s*=\s*null/);
  assert.match(block,/Keep the registered Homey Image object alive/);
});

test('field fix: normal and garage-fast polling share one in-flight poll',async()=>{
  const d=Object.create(Device.prototype);
  let calls=0,release;
  d._pollInFlight=null;
  d._pollCore=async()=>{calls++;await new Promise(r=>{release=r;});return 'ok';};
  const a=d._poll();
  const b=d._poll();
  await new Promise(r=>setImmediate(r));
  assert.equal(calls,1);
  release();
  assert.equal(await a,'ok');
  assert.equal(await b,'ok');
  assert.equal(d._pollInFlight,null);
});

test('field fix: moving pylon save is stored for a safe stationary checkpoint instead of native Pending',async()=>{
  const d=Object.create(Device.prototype);
  const store={};
  d._activeMapIndex=0;
  d._obstacleRulesCache={};
  d._cachedMapData={forbiddenAreas:[]};
  d._nativeMowerStatus='mowing';
  d._garageSafety={_missionOutside:true};
  d._buildObstaclePylons=()=>[{id:'obs:1',x:1000,y:2000,source:'obs',coordinateScaleUncertain:false}];
  d.getSetting=k=>k==='map_safe_mowing'?true:(k==='garage_mode_enabled'?true:null);
  d.getCapabilityValue=()=> 'mowing';
  d.getData=()=>({id:'mower'});
  d._api={};
  d.log=()=>{};
  d.setStoreValue=async(k,v)=>{store[k]=structuredClone(v);};
  d._scheduleMapCameraImageUpdate=()=>{};
  const result=await d.updateObstacleRule({id:'obs:1',action:'avoid',radiusCm:50,lifecycle:'permanent'});
  assert.equal(result.ok,true);
  assert.equal(result.deferred,true);
  assert.equal(result.rule.pending,undefined);
  assert.equal(result.rule.lifecycleTransitionPending,'activate');
  assert.equal(result.rule.lifecycle,'permanent');
  assert.equal(store.obstacle_rules_v1[result.ruleId].pending,undefined);
});

test('field fix: all pylon editors expose identical time/mission lifecycle choices',()=>{
  const files=['drivers/mower/repair/map_editor.html','widgets/map/public/index.html','widgets/overview/public/map-editor.html'];
  const modes=['permanent','days_3','days_7','days_14','departure','departure_mowing','mowing','mowing_return','return'];
  for(const file of files){
    const src=read(file);
    assert.match(src,/id="pylon-lifecycle"/,file);
    for(const mode of modes) assert.ok(src.includes('value="'+mode+'"'),file+' '+mode);
    assert.match(src,/lifecycle:\s*mode === 'save' \? document\.getElementById\('pylon-lifecycle'\)\.value : null/,file);
  }
});

test('field fix: Garage Mode owns stationary lifecycle checkpoints before motion and final docking',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  assert.match(src,/_syncPylonLifecyclePhase\('departure', \{ reason:'garage_start' \}\)[\s\S]{0,800}_beginOutbound\(source \|\| 'START'/);
  assert.match(src,/_pylonLifecycleNeedsTransition\?\.\('mowing'\)[\s\S]{0,500}_pauseCloseResumeAfterExit/);
  assert.match(src,/lifecycleReturnTransition[\s\S]{0,600}mode:'maintenance'/);
  const returnHook=src.indexOf("_syncPylonLifecyclePhase('return', { reason:'return_from_maintenance' })");
  const gateOpen=src.indexOf("ensureDoorOpen('return_from_maintenance'",returnHook);
  assert.ok(returnHook>0&&gateOpen>returnHook,'return lifecycle must be verified before opening the gate');
});


test('field fix: native zones from the original app expose and persist lifecycle metadata',async()=>{
  const d=Object.create(Device.prototype);
  const store={};
  d._activeMapIndex=0;
  d._nativeZoneLabelsCache={};
  d._nativeZonePoliciesCache={};
  d._obstacleRulesCache={};
  d._cachedMapData={forbiddenAreas:[[101,{shapeType:2,path:[{x:0,y:0},{x:1000,y:0},{x:1000,y:1000},{x:0,y:1000}]}]]};
  d.getSetting=k=>k==='garage_mode_enabled'?true:null;
  d._currentPylonLifecyclePhase=()=> 'mowing';
  d._mapEditStationary=()=> false;
  d._schedulePylonLifecycleSync=()=>{};
  d._scheduleMapCameraImageUpdate=()=>{};
  d._matchingPylonRulesForNativeArea=()=>[];
  d.setStoreValue=async(k,v)=>{store[k]=structuredClone(v);};
  d.log=()=>{};
  const result=await d._setNativeZoneLabel({nativeZoneId:101,note:'soft ground',lifecycle:'departure_mowing'});
  assert.equal(result.ok,true);
  assert.equal(result.policy.lifecycle,'departure_mowing');
  const saved=Object.values(store.native_zone_policies_v1)[0];
  assert.equal(saved.nativeId,101);
  assert.equal(saved.lifecycle,'departure_mowing');
  assert.equal(saved.shape,2);
  assert.equal(saved.pointsMm.length,4);
  assert.equal(saved.note,'soft ground');
});

test('field fix: externally deleted original-app zone is not resurrected unless Homey suspended it',()=>{
  const d=Object.create(Device.prototype);
  d._nativeMowerStatus='mowing';
  d._cachedMapData={forbiddenAreas:[]};
  d.getSetting=k=>k==='garage_mode_enabled'?true:null;
  const policy={mapIndex:0,shape:2,centerX:500,centerY:500,width:1000,height:1000,areaScale:1000,pointCount:4,lifecycle:'mowing',lifecycleSuspended:false};
  assert.equal(d._nativeZonePolicyNeedsTransition(policy,'mowing',d._cachedMapData),false);
  assert.equal(d._nativeZonePolicyNeedsTransition({...policy,lifecycleSuspended:true},'mowing',d._cachedMapData),true);
});

test('field fix: original-app lifecycle is available in all three map editors',()=>{
  const files=['drivers/mower/repair/map_editor.html','widgets/map/public/index.html','widgets/overview/public/map-editor.html'];
  for(const file of files){
    const src=read(file);
    assert.match(src,/var policies = Array\.isArray\(_lastData\.nativeZonePolicies\)/,file);
    assert.doesNotMatch(src,/lifecycleInput\.disabled = direct \|\|/,file);
    assert.match(src,/lifecycle: mode === 'save' \? document\.getElementById\('pylon-lifecycle'\)\.value : null/,file);
  }
});
