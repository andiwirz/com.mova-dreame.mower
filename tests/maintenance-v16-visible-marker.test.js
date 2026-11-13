'use strict';
const assert=require('node:assert/strict');
const {MaintenancePointCoordinator}=require('../lib/garage/MaintenancePointCoordinator');
(async()=>{
 const orig=Date.now;let now=orig();Date.now=()=>now;
 try{
  let store={'0':{'2':{index:2,mapIndex:0,x:4200,y:3500,source:'operator_observed_native_task109_idle_stable',confirmedAt:now-300000,mapHash:'abc123456789'}}};
  let deviceReads=0;
  const device={_activeMapIndex:0,_latestNativeStatusCode:2,_nativeMowerStatus:'idle',_cachedMapData:{mowingAreas:[{id:1}]},
   _api:{getMowerPosition:async()=>({x:(++deviceReads===1?0:4200),y:(deviceReads===1?260:3500)}),getMAPI:async()=>({d:{hash:'abc123456789'}})},
   getData:()=>({id:'a2'}),getSetting:()=>false,getCapabilityValue:()=> 'idle',
   _resolveStableMaintenancePoint:async()=>({x:0,y:0}),_scheduleMapCameraImageUpdate:()=>{},
   getStoreValue:async key=>key==='native_additional_maintenance_points_v1'?store:{},
   setStoreValue:async(key,val)=>{if(key==='native_additional_maintenance_points_v1')store=val;},
   hasCapability:()=>true,registerCapabilityListener:()=>{},setCapabilityOptions:async()=>{},setCapabilityValue:async()=>{},
   homey:{i18n:{getLanguage:()=> 'de'}}};
  const m=new MaintenancePointCoordinator(device);device._additionalMaintenanceEvidence=m;await m.load();
  await m.prepareOriginalApp(2);assert.equal(m.observeTask({o:109,exe:true},0),true);
  now+=15000;await m.observeStatus(1,27);
  now+=10000;await m.observeStatus(2,75);
  now+=5000;await m.observeStatus(2,75);
  assert.equal(store['0']['2'].source,'operator_associated_native_task109_code75_stable');
  assert.ok(store['0']['2'].confirmedAt>=now-1000);
  const points=await m.visiblePoints();assert.equal(points.length,1);assert.equal(points[0].confirmed,true);
  assert.equal(device._cachedMapData.mowingAreas.length,1);
  assert.equal(device._cachedMapData.maintenancePoints[0].confirmed,true);
  now+=15000;assert.equal(m.tileStatusForNative('idle'),'garage_maintenance_reached');
  console.log('PASS V16 old candidate promoted and saved, visible map marker, arrival state persists');
 }finally{Date.now=orig;}
})().catch(e=>{console.error(e);process.exitCode=1});
