'use strict';
const assert=require('node:assert/strict');
const {MaintenancePointCoordinator}=require('../lib/garage/MaintenancePointCoordinator');
const {STORE_KEY}=require('../lib/garage/NativeAdditionalMaintenanceEvidence');
(async()=>{
  let points={'0':{'1':{index:1,x:1,y:2},'2':{index:2,mapIndex:0,x:0,y:260,confirmedAt:Date.now(),source:'operator_associated_native_task109_code75_stable'},'3':{index:3,mapIndex:0,x:4500,y:5000,confirmedAt:Date.now(),source:'operator_associated_native_task109_code75_stable'}}};
  const names={maintenance_point_2_name:'Gartentor',maintenance_point_3_name:'Vorne'};
  let refreshes=0;
  const d={_activeMapIndex:0,_cachedMapData:{mowingAreas:[{id:3}],maintenancePoints:[{index:2}],nativeMaintenancePoints:[{index:2}]},
    getStoreValue:async key=>key===STORE_KEY?points:names,setStoreValue:async(key,v)=>{assert.equal(key,STORE_KEY);points=v},
    hasCapability:()=>false,addCapability:async()=>{},setCapabilityValue:async()=>{},registerCapabilityListener:()=>{},
    _scheduleMapCameraImageUpdate:()=>refreshes++,getSetting:()=>false};
  const c=new MaintenancePointCoordinator(d,()=>{});await c.load();
  assert.equal((await c.repairPointState(2)).hasPosition,true);
  await c.removeRepairPoint(2);
  assert.equal((await c.repairPointState(2)).hasPosition,false);
  assert.equal(points['0']['2'],undefined);
  assert.ok(points['0']['3']);assert.ok(points['0']['1']);
  assert.equal(c._pointName(2),'Gartentor');
  assert.deepEqual(d._cachedMapData.mowingAreas,[{id:3}]);
  assert.ok(!d._cachedMapData.maintenancePoints.some(p=>p.index===2));
  assert.ok(refreshes>0);
  await assert.rejects(()=>c.removeRepairPoint(1));
  await assert.rejects(()=>c.removeRepairPoint(6));
  console.log('PASS V18: deleting P2 clears only its position and marker, preserves name/P1/P3 and garden zones');
})().catch(e=>{console.error(e);process.exitCode=1});
