'use strict';
const assert=require('node:assert/strict');
const {MaintenancePointCoordinator}=require('../lib/garage/MaintenancePointCoordinator');
const {canRecordOperatorObservation}=require('../lib/garage/OperatorMaintenanceArrival');
const {canConfirmCoreOperatorArrival}=require('../lib/garage/CoreOperatorArrivalProof');
const {checkMaintenancePoint}=require('../lib/garage/MaintenancePointPreflight');
(async()=>{
  const base={operatorConfirmed:true,sawTransit:true,nativeCode:2,faultCode:75,mowerStatus:'idle',taskAgeMs:45000,mapMatch:true,positionStable:true,p1Separated:true,hasContradictoryIndexedMap:false};
  assert.equal(canRecordOperatorObservation(base),true);
  for (const key of ['operatorConfirmed','sawTransit','mapMatch','positionStable','p1Separated'])
    assert.equal(canRecordOperatorObservation({...base,[key]:false}),false,key);
  assert.equal(canConfirmCoreOperatorArrival({operatorConfirmed:true,sawTransit:true,nativeCode:2,faultCode:75,mowerStatus:'idle',taskAgeMs:20000,mapMatch:true,positionStable:true,p1Separated:true,hasContradictoryIndexedMap:false,conflictsWithOtherPoint:false,docked:false}),true);
  for (const point of [2,3,4,5]) {
    let store={},reads=0,cap='idle';
    const realNow=Date.now;let clock=realNow();Date.now=()=>clock; const logs=[], messages=[];
    const names={}; names[`maintenance_point_${point}_name`]=`P${point}`;
    const device={
      _activeMapIndex:0,_latestNativeStatusCode:2,_nativeMowerStatus:'idle',_nativeMaintenanceCommandAt:0,
      _cachedMapData:{},homey:{i18n:{getLanguage:()=> 'de'}},
      getData:()=>({id:'a2'}),getSetting:()=>false,
      getCapabilityValue:k=>k==='mower_status'?cap:null,
      _resolveStableMaintenancePoint:async()=>({x:0,y:0}),
      _api:{getMowerPosition:async()=> (++reads===1 ? ({x:0,y:260}) : ({x:4200+reads,y:3500})),getMAPI:async()=>({d:{hash:'abc123456789',idx:0,size:123}})},
      getStoreValue:async k=> k==='maintenance_point_names_v1'?names:store,
      setStoreValue:async(k,v)=>{assert.equal(k,'native_additional_maintenance_points_v1');store=v;},
      hasCapability:()=>true,registerCapabilityListener:()=>{},setCapabilityOptions:async()=>{},
      setCapabilityValue:async(k,v)=>messages.push([k,v]),_scheduleMapCameraImageUpdate:()=>{},
    };
    const c=new MaintenancePointCoordinator(device,line=>logs.push(line));
    await c.load();
    assert.equal(await c.prepareOriginalApp(point),true);
    assert.equal(c.observeTask({o:109,exe:true,status:true},0),true);
    assert.equal(c.pending.operatorConfirmed,true);
    clock+=10000;
    await c.observeStatus(1,27); // observed real transit before arrival
    clock+=10000;
    await c.observeStatus(2,75); // A2 arrival candidate; unknown native index
    assert.equal(c.isPending(),true,'first sample is not sufficient');
    clock+=5000;
    await c.observeStatus(2,75); // independent stable completion, same native trip
    assert.equal(c.isPending(),false);
    const proof=store['0'][String(point)];
    assert.equal(proof.source,'operator_associated_native_task109_code75_stable');
    const points=await c.visiblePoints();
    assert.equal(points.length,1);
    assert.equal(points[0].observed,false);
    assert.equal(points[0].confirmed,true);
    assert.equal((await checkMaintenancePoint({point,mapIndex:0,getMAPI:async()=>({d:{hash:'abc123456789'}}),learned:store})).allowed,true,'Core-style bounded original-app arrival proof');
    assert.ok(messages.some(([k,v])=>k==='maintenance_learning_status'&&v.includes('bestätigt')));
    assert.ok(logs.some(x=>x.includes('VERIFIED')));
    Date.now=realNow;
  }
  console.log('PASS: P2–P5 Core-style native A2 arrival proof, stable repeat, persisted map and bounded preflight');
})().catch(e=>{console.error(e);process.exitCode=1});
