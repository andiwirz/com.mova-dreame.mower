'use strict';
const assert=require('node:assert/strict');
const {MaintenancePointCoordinator}=require('../lib/garage/MaintenancePointCoordinator');
const {nativeMaintenancePosition,checkMaintenancePoint}=require('../lib/garage/MaintenancePointPreflight');
const {knownLearnedPoint}=require('../lib/garage/NativeAdditionalMaintenanceEvidence');
(async()=>{
 const mapi={md5sum:'a2indexproof1234',d:{maintenancePoints:[{index:2,position:{x:4800,y:3200}}]}};
 assert.deepEqual(nativeMaintenancePosition(mapi,2),{x:4800,y:3200});
 assert.equal(nativeMaintenancePosition({markers:{point_2:{x:4800,y:3200}}},2),null);
 assert.equal(nativeMaintenancePosition({maintenancePoints:[{index:3,position:{x:4800,y:3200}}]},2),null);
 let store={}, names={maintenance_point_2_name:'Rear service'};
 let clock=0;
 const d={_activeMapIndex:0,_latestNativeStatusCode:2,_nativeMaintenanceCommandAt:0,
   getData:()=>({id:'mova-a2'}),getSetting:()=>false,
   _resolveStableMaintenancePoint:async()=>({x:0,y:0}),
   _api:{getMowerPosition:async()=> (++clock===1 ? ({x:0,y:260}) : ({x:4805+(clock%2),y:3200})),getMAPI:async()=>mapi},
   getStoreValue:async key=>key==='maintenance_point_names_v1'?names:store,
   setStoreValue:async(key,value)=>{assert.equal(key,'native_additional_maintenance_points_v1');store=value;},
   hasCapability:()=>false,addCapability:async()=>{},setCapabilityValue:async()=>{},
   registerCapabilityListener:()=>{},_scheduleMapCameraImageUpdate:()=>{},homey:{i18n:{getLanguage:()=> 'de'}},
 };
 const coordinator=new MaintenancePointCoordinator(d,()=>{});
 await coordinator.load();
 await coordinator.prepareOriginalApp(2);
 assert.equal(coordinator.observeTask({o:109,exe:true,status:true},0),true);
 assert.equal(await coordinator.observeStatus(2,75),true);
 assert.ok(knownLearnedPoint(store,2,0,mapi.md5sum));
 assert.equal((await coordinator.visiblePoints())[0].confirmed,true);
 assert.equal((await checkMaintenancePoint({point:2,mapIndex:0,getMAPI:async()=>mapi,learned:store})).allowed,true);
 // Without a distinct native indexed coordinate, fault75 must never become proof.
 store={};clock=0;
 d._api.getMAPI=async()=>({md5sum:'a2indexproof1234'});
 const blocked=new MaintenancePointCoordinator(d,()=>{});
 await blocked.load();await blocked.prepareOriginalApp(2);
 blocked.observeTask({o:109,exe:true,status:true},0);
 await blocked.observeStatus(2,75);
 assert.equal(blocked.pending.index,2);
 assert.equal((await checkMaintenancePoint({point:2,mapIndex:0,getMAPI:d._api.getMAPI,learned:store})).allowed,false);
 console.log('PASS: A2 2/75 can learn only with native indexed map position + stable separate location; no indexed evidence fails closed');
})().catch(e=>{console.error(e);process.exitCode=1;});
