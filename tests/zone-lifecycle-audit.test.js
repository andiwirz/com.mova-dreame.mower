'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const original=Module._load;
let Device;
try {
  Module._load=function(id,parent,main){
    if(id==='homey') return {Device:class {}};
    if(id==='mqtt') return {};
    return original.call(this,id,parent,main);
  };
  Device=require('../drivers/mower/device');
} finally { Module._load=original; }
function fixture(german=false) {
  const d=Object.create(Device.prototype), logs=[];
  d._activeMapIndex=0;
  d._cachedMapData={forbiddenAreas:[{id:12}]};
  d._obstacleRulesCache={};d._nativeZonePoliciesCache={};
  d._garageSafety={_text:(de,en)=>german?de:en};
  d.log=(...args)=>logs.push(args);
  d._pylonLifecycleNativeActive=()=>false;
  d._pylonLifecycleDesiredActive=()=>true;
  return {d,logs};
}
test('audit explains absent rules and logs again when phase changes, without writes',()=>{
  const {d,logs}=fixture();
  d._logPylonLifecycleAudit('return');d._logPylonLifecycleAudit('return');
  assert.equal(logs.length,1);
  assert.equal(JSON.parse(logs[0][1]).reason,'no_configured_lifecycle_rules');
  d._logPylonLifecycleAudit('mowing');assert.equal(logs.length,2);
});
test('audit includes permanent/unassigned pylon and explains why no deletion is requested in both languages',()=>{
  for(const german of [false,true]) {
    const {d,logs}=fixture(german);
    d._obstacleRulesCache={p1:{note:'Einfahrt',lifecycle:'permanent',nativeId:null}};
    d._logPylonLifecycleAudit('return');
    const rule=JSON.parse(logs[0][1]).rules[0];
    assert.equal(rule.name,'Einfahrt');assert.equal(rule.nativeId,null);
    assert.equal(rule.reason,'permanent_no_automatic_edit');
    assert.equal(rule.reasonText,german?'Dauerhafte Regel: kein automatisches Löschen':'Permanent rule: no automatic deletion');
  }
});
test('sync summary preserves unverified result and exceptions rather than claiming success',async()=>{
  const {d,logs}=fixture();
  const result={ok:true,skipped:true,bestEffort:true,unverified:true,reason:'map_anomaly_no_native_edit'};
  d._syncPylonLifecyclePhaseInternal=async()=>result;
  assert.equal(await d._syncPylonLifecyclePhase('return'),result);
  assert.equal(JSON.parse(logs.at(-1)[1]).unverified,true);
  d._syncPylonLifecyclePhaseInternal=async()=>{throw Error('native timeout');};
  await assert.rejects(d._syncPylonLifecyclePhase('return'),/native timeout/);
  assert.match(logs.at(-1)[0],/synchronization failed/);
});

test('permanent rules do not block a new outside mowing start on stale moving telemetry',async()=>{
  const {d}=fixture();
  d._api={};
  d._obstacleRulesCache={p1:{lifecycle:'permanent',nativeId:null}};
  d._automaticNativeZoneMapWriteSafe=()=>true;
  d._mapEditStationary=()=>{throw Error('no-op must not require a write checkpoint');};
  const result=await d._syncPylonLifecyclePhase('mowing',{reason:'start_outside'});
  assert.equal(result.ok,true);
  assert.equal(result.reason,'no_native_transition_required');
  assert.equal(result.changed,0);
});

test('a real requested zone transition still blocks native writes while moving',async()=>{
  const {d}=fixture();
  d._api={};
  d._pylonLifecycleNeedsTransition=()=>true;
  d._mapEditStationary=()=>false;
  const result=await d._syncPylonLifecyclePhase('mowing',{reason:'start_outside'});
  assert.equal(result.ok,false);
  assert.equal(result.reason,'mower_moving');
});

test('paused display readback accepts real native mowing and retains a real pause',async()=>{
  for(const code of [1,3]) {
    const {d,logs}=fixture();
    d.getData=()=>({id:'test'});
    d._api={getProperties:async(did,props)=>{
      assert.deepEqual(props,[[2,1]]);
      return {code:0,data:{result:[{siid:2,piid:1,value:code,code:0}]}};
    }};
    assert.equal(await d._refreshConflictingPausedStatus(),code);
    assert.match(logs.at(-1)[0],/status-readback/);
    assert.equal(await d._refreshConflictingPausedStatus(),code);
  }
});

test('pause during readback and active safety return prevent stale correction',async()=>{
  const {d}=fixture();d.getData=()=>({id:'test'});
  d._api={getProperties:async()=>{
    d._lastUserPauseAt=Date.now();
    return {code:0,data:{result:[{siid:2,piid:1,value:1}]}};
  }};
  assert.equal(await d._refreshConflictingPausedStatus(),null);
  d._lastUserPauseAt=0;d._pausedStatusReadAt=0;
  d._garageSafety.isReturnCycleActive=()=>true;
  d._api.getProperties=async()=>{throw Error('must not query during safety return');};
  assert.equal(await d._refreshConflictingPausedStatus(),null);
});

test('missing direct property never synthesizes mowing',async()=>{
  const {d}=fixture();d.getData=()=>({id:'test'});
  d._api={getProperties:async()=>({code:0,data:{result:[]}})};
  assert.equal(await d._refreshConflictingPausedStatus(),null);
});

test('idle readback reports the cached idle state and uses only native mowing evidence',async()=>{
  const {d,logs}=fixture();d.getData=()=>({id:'test'});
  d._api={getProperties:async()=>({code:0,data:{result:[{siid:2,piid:1,value:1}]}})};
  assert.equal(await d._refreshConflictingPausedStatus('idle'),1);
  assert.match(logs.at(-1)[2],/cached=idle native=mowing/);
});

test('lifecycle deletion is retried only once at a verified unchanged return checkpoint',async()=>{
  const {d}=fixture();let writes=0;
  d.getData=()=>({id:'test'});
  d._garageSafety._commandToken=123;
  d._automaticNativeZoneMapWriteSafe=()=>true;
  d._nativeForbiddenGeometryEquivalent=()=>true;
  d._mapEditStationary=()=>true;
  d._currentPylonLifecyclePhase=()=> 'return';
  d._garageSafety.isVerifiedReturnLifecycleCheckpoint=()=>true;
  d._pylonMapEditTaskOptions=()=>({});
  d._api={getProperties:async()=>({code:0,data:{result:[{siid:2,piid:1,code:0,value:2}]}}),
    deleteForbiddenAreas:async(did,ids,map,options)=>{
    assert.deepEqual(ids,[12]);assert.equal(options.canMutate(),true);writes++;
  }};
  const op={lifecycleRetryAllowed:true,mapIndex:0,returnToken:123,retryGeometry:{id:12}};
  assert.equal(await d._retryUnappliedLifecycleDelete(12,op),true);
  assert.equal(await d._retryUnappliedLifecycleDelete(12,op),false);
  assert.equal(writes,1);assert.equal(d._pylonNativeWriteBusy,false);
});

test('missing return token cannot authorize a native lifecycle deletion (including missing command token)',async()=>{
  const {d}=fixture();
  d.getData=()=>({id:'test'});
  d._automaticNativeZoneMapWriteSafe=()=>true;
  d._nativeForbiddenGeometryEquivalent=()=>true;
  d._mapEditStationary=()=>true;
  d._currentPylonLifecyclePhase=()=> 'return';
  d._garageSafety.isVerifiedReturnLifecycleCheckpoint=()=>true;
  d._api={deleteForbiddenAreas:async()=>{throw Error('must not write with missing token');}};
  const op={lifecycleRetryAllowed:true,mapIndex:0,retryGeometry:{id:12}};
  assert.equal(await d._retryUnappliedLifecycleDelete(12,op),false);
  assert.equal(op.retryAttempted,true);
});

test('verified return checkpoint cannot override PAUSED as native task-free IDLE',async()=>{
  const {d}=fixture();
  d.getData=()=>({id:'test'});
  d._garageSafety._commandToken=123;
  d._automaticNativeZoneMapWriteSafe=()=>true;
  d._nativeForbiddenGeometryEquivalent=()=>true;
  d._mapEditStationary=()=>true;
  d._currentPylonLifecyclePhase=()=> 'return';
  d._garageSafety.isVerifiedReturnLifecycleCheckpoint=()=>true;
  d._api={getProperties:async()=>({code:0,data:{result:[{siid:2,piid:1,code:0,value:3}]}}),
    deleteForbiddenAreas:async()=>{throw Error('PAUSED must not allow native map mutation');}};
  assert.equal(await d._retryUnappliedLifecycleDelete(12,
    {lifecycleRetryAllowed:true,mapIndex:0,returnToken:123,retryGeometry:{id:12}}),false);
});

test('no delete retry after return checkpoint is lost or zone geometry changes',async()=>{
  for(const geometryMatches of [false,true]) {
    const {d}=fixture();d._automaticNativeZoneMapWriteSafe=()=>true;
    d._nativeForbiddenGeometryEquivalent=()=>geometryMatches;
    d._mapEditStationary=()=>false;
    d._api={deleteForbiddenAreas:async()=>{throw Error('must not delete');}};
    assert.equal(await d._retryUnappliedLifecycleDelete(12,{lifecycleRetryAllowed:true,mapIndex:0}),false);
  }
});
