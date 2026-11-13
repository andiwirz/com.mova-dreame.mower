'use strict';
const assert=require('node:assert/strict');
const {MaintenancePointCoordinator}=require('../lib/garage/MaintenancePointCoordinator');
const {STORE_KEY}=require('../lib/garage/NativeAdditionalMaintenanceEvidence');
(async()=>{
 for (const garageOn of [false,true]) {
  const calls=[];
  const stores={
   [STORE_KEY]: {'0':{'1':{index:1,x:0,y:0},'2':{index:2,mapIndex:0,x:5000,y:3500,source:'operator_associated_native_task109_code75_stable',confirmedAt:Date.now()}}},
   maintenance_point_names_v1:{maintenance_point_2_name:'Rasenende'},
  };
  const gate={enabled:()=>garageOn,ensureDoorOpen:async()=>{calls.push('gate-open');return true},_lastSensorContactState:'open',isDoorOpenStable:()=>true,_doorOpenReleaseVerified:()=>true};
  const d={_activeMapIndex:0,_garageSafety:gate,
   _cachedMapData:{mowingAreas:[{id:1}],maintenancePoints:[],nativeMaintenancePoints:[]},
   _api:{getMowerPosition:async()=>({x:0,y:200}),goToMaintenancePoint:()=>calls.push('command')},
   getData:()=>({id:'a2'}),getSetting:k=>k==='garage_mode_enabled'?garageOn:false,
   getStoreValue:async k=>stores[k],setStoreValue:async(k,v)=>{stores[k]=v},
   hasCapability:()=>false,registerCapabilityListener:()=>{},addCapability:async()=>{},
   _emitMowerNotice:()=>calls.push('notice'),_scheduleMapCameraImageUpdate:()=>calls.push('map-refresh')};
  const c=new MaintenancePointCoordinator(d,()=>{});await c.load();
  const previous=await c.repairPointState(2);
  assert.equal(previous.name,'Rasenende');assert.equal(previous.hasPosition,true);
  assert.equal((await c.removeRepairPoint(2)).ok,true);
  const cleared=await c.repairPointState(2);
  assert.equal(cleared.hasPosition,false);assert.equal(cleared.name,'Rasenende');
  assert.ok(stores[STORE_KEY]['0']['1'],'P1 retained');
  assert.deepEqual(d._cachedMapData.mowingAreas,[{id:1}]);
  assert.equal(await c.prepareOriginalApp(2),true);
  assert.equal(c.operatorAssociation.index,2);
  assert.equal(calls.filter(x=>x==='gate-open').length,garageOn?1:0);
  assert.ok(!calls.includes('command'),'learning must not launch mower movement');
 }
 console.log('PASS: Repair delete, name retention, P1 preservation and native observer arming in both garage modes');
})().catch(e=>{console.error(e);process.exitCode=1});
