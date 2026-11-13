'use strict';
const assert = require('node:assert/strict');
const {NativeAdditionalMaintenanceEvidence,taskTarget,knownLearnedPoint,mapRevision} = require('../lib/garage/NativeAdditionalMaintenanceEvidence');
const {checkMaintenancePoint} = require('../lib/garage/MaintenancePointPreflight');
(async()=>{
  assert.equal(taskTarget({o:109,exe:true,d:{point:[2]}}),2);
  assert.equal(taskTarget({o:109,exe:true,point:[4]}),4);
  assert.equal(taskTarget({o:109,exe:true}),null);
  assert.equal(taskTarget({o:100,exe:true,d:{point:[2]}}),null);
  const mapHash = 'current-native-map-revision-001';
  const mapi={d:{hash:mapHash}};
  let store={}; let reads=0;
  const dev={
    _activeMapIndex:0,_latestNativeStatusCode:75,_nativeMaintenanceCommandAt:0,
    getData:()=>({id:'A2'}),_api:{
      getMowerPosition:async()=>{reads++;return {x:2250+reads,y:1000};},
      getMAPI:async()=>mapi,
    },
    _resolveStableMaintenancePoint:async()=>({x:0,y:0}),
    getStoreValue:async()=>store,
    setStoreValue:async(key,value)=>{assert.equal(key,'native_additional_maintenance_points_v1');store=value;},
  };
  const logs=[];const learner=new NativeAdditionalMaintenanceEvidence(dev,(line)=>logs.push(line));
  assert.equal(learner.observeTask({o:109,exe:true,p:0,d:{point:[2]}},0),true);
  assert.equal(await learner.observeStatus(29),true,'P1 observer is suppressed while indexed P2 is in flight');
  assert.deepEqual(store,{});
  assert.equal(await learner.observeStatus(75),true);
  assert.equal(learner.isPending(),false);
  assert.equal(await learner.observeStatus(75),true,'repeat 75 cannot overwrite P1');
  assert.ok(knownLearnedPoint(store,2,0,mapHash));
  assert.equal((await checkMaintenancePoint({point:2,mapIndex:0,getMAPI:async()=>mapi,learned:store})).allowed,true);
  assert.equal((await checkMaintenancePoint({point:4,mapIndex:0,getMAPI:async()=>mapi,learned:store})).allowed,false);
  assert.equal(knownLearnedPoint(store,2,0,'different-native-map-revision'),null);
  assert.equal(knownLearnedPoint(store,2,1,mapHash),null);
  assert.equal(mapRevision(mapi),mapHash);
  assert.equal(learner.observeTask({o:109,exe:true,p:1,d:{point:[3]}},0),false,'wrong map must be ignored');
  console.log('PASS: native P2 proof requires TASK 109 + status 75 + stationary readback + P1 separation; P4 stays blocked');
})().catch(e=>{console.error(e);process.exitCode=1;});
