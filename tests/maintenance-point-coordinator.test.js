'use strict';
const assert=require('node:assert/strict');
const {MaintenancePointCoordinator}=require('../lib/garage/MaintenancePointCoordinator');
const {checkMaintenancePoint}=require('../lib/garage/MaintenancePointPreflight');

(async()=>{
 let store={},names={maintenance_point_2_name:'P2 Test'},n=0, revision='abcdef012345';
 const calls=[];
 let pairedPoseCount=0;
 const device={
   _activeMapIndex:1,_latestNativeStatusCode:75,_nativeMaintenanceCommandAt:0,
   _cachedMapData:{md5sum:'abcdef012345'},
   getData:()=>({id:'a2'}),getSetting:key=> key==='maintenance_point_2_name'?'P2 Test':'',
   _resolveStableMaintenancePoint:async()=>({x:0,y:0}),
   _api:{getMowerPosition:async()=>({x:4800,y:3200}),getMAPI:async()=>({md5sum:revision})},
   getStoreValue:async k=>k==='maintenance_point_names_v1'?names:store, setStoreValue:async(k,v)=>{assert.equal(k,'native_additional_maintenance_points_v1');store=v;},
   hasCapability:cap=>calls.includes('add '+cap),
   addCapability:async cap=>{calls.push('add '+cap);},
   setCapabilityOptions:async(cap,opts)=>{calls.push('options '+cap+' '+opts.uiComponent);},
   setCapabilityValue:async()=>{},registerCapabilityListener:(cap,fn)=>{calls.push('listen '+cap);},
   _scheduleMapCameraImageUpdate:()=>calls.push('map refresh'),
 };
 const coordinator=new MaintenancePointCoordinator(device,()=>{});
 await coordinator.load();
 assert.equal((await coordinator.visiblePoints()).length,0);
 assert.equal(coordinator.observeTask({o:109,exe:true,status:true},1),true,'single named missing P2 can be tentatively paired');
 assert.equal(coordinator.observeTask({o:109,exe:true,status:true},1),true,'duplicate must not clear pending association');
 assert.equal(coordinator.pending.index,2);
 await coordinator.observeStatus(75,0);
 let list=await coordinator.visiblePoints();
 assert.equal(list.length,1);
 assert.equal(list[0].index,2);
 assert.deepEqual((await coordinator.attachMap({name:'yard'})).maintenancePoints,list);
 assert.ok(calls.includes('map refresh'));
 assert.ok(calls.includes('add cmd_maintenance_point_2'));
 assert.ok(calls.includes('listen cmd_maintenance_point_2'));
 // Proven P2 becomes preflight-eligible; P4 remains blocked.
 const getMAPI=async()=>({md5sum:'abcdef012345'});
 assert.equal((await checkMaintenancePoint({point:2,mapIndex:1,getMAPI,learned:store})).allowed,false, 'unpaired observation must not license a native index');
 assert.equal((await checkMaintenancePoint({point:4,mapIndex:1,getMAPI,learned:store})).allowed,false);
 // Explicit owner pairing makes P2 a verified native destination.
 store={};
 device._api.getMowerPosition=async()=> (++pairedPoseCount===1 ? {x:0,y:260} : {x:4800,y:3200});
 const paired=new MaintenancePointCoordinator(device,()=>{});
 await paired.load();
 assert.equal(await paired.prepareOriginalApp(2),true);
 assert.equal(paired.observeTask({o:109,exe:true,status:true},1),true);
 await paired.observeStatus(75,0);
 assert.equal((await checkMaintenancePoint({point:2,mapIndex:1,getMAPI,learned:store})).allowed,true);
 assert.equal((await paired.visiblePoints())[0].confirmed,true);
 // Manufacturer map revision change invalidates native proof.
 revision='xxxxxxx12345';
 paired.revisionCache=null;
 assert.equal((await paired.visiblePoints()).length,0);
 // Without any explicitly named candidate the foreign TASK cannot be assigned.
 const other={...device,getStoreValue:async k=>k==='maintenance_point_names_v1'?{}:store};
 const unknown=new MaintenancePointCoordinator(other,()=>{});
 await unknown.load();
 assert.equal(unknown.observeTask({o:109,exe:true,status:true},1),false);
 assert.equal(unknown.pending,null);
 console.log('PASS: inferred CORE point requires unique name, code75, stable native P1-separated arrival, map scope and preserves P4 fail-closed');
})().catch(e=>{console.error(e);process.exitCode=1;});
