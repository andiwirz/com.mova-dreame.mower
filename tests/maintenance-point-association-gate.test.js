'use strict';
const assert=require('node:assert/strict');
const {MaintenancePointCoordinator}=require('../lib/garage/MaintenancePointCoordinator');
(async()=>{
 const actions=[];
 let sensorOpen=false,storage={},names={maintenance_point_3_name:'P3'};
 const garage={enabled:()=>true,_lastSensorContactState:'closed',isDoorOpenStable:()=>sensorOpen,ensureDoorOpen:async()=>{actions.push('gate:open');return sensorOpen;},
   _doorOpenReleaseVerified:()=>sensorOpen,_text:(de,en)=>de};
 const dev={
   _activeMapIndex:0,_garageSafety:garage,_resolveStableMaintenancePoint:async()=>({x:0,y:0}),getSetting:k=>k==='maintenance_point_3_name'?'P3': '',
   getStoreValue:async k=>k==='maintenance_point_names_v1'?names:storage,setStoreValue:async(k,v)=>{storage=v;},
   _emitMowerNotice:()=>actions.push('notice'),hasCapability:()=>false,addCapability:async()=>{},
   registerCapabilityListener:()=>{},
   _api:{goToMaintenancePoint:async()=>{actions.push('OPCODE109');}}
 };
 const c=new MaintenancePointCoordinator(dev,()=>{});
 await c.load();
 assert.equal(await c.prepareOriginalApp(3),false,'closed gate cannot pair');
 assert.equal(c.operatorAssociation,null);
 sensorOpen=true;garage._lastSensorContactState='open';
 assert.equal(await c.prepareOriginalApp(3),true);
 assert.deepEqual(actions,['gate:open','gate:open','notice']);
 assert.ok(!actions.includes('OPCODE109'));
 assert.equal(c.operatorAssociation.index,3);
 assert.equal(c.observeTask({o:109,exe:true,status:true},0),true);
 assert.equal(c.pending.index,3);
 assert.equal(c.operatorAssociation,null,'single-use pairing');
 const ambiguous={...dev,getStoreValue:async k=>k==='maintenance_point_names_v1'?{maintenance_point_2_name:'P2',maintenance_point_3_name:'P3'}:storage};
 const x=new MaintenancePointCoordinator(ambiguous,()=>{});
 await x.load();
 assert.equal(x.observeTask({o:109,exe:true,status:true},0),false,'2 names without pairing cannot be guessed');
 assert.equal(x.pending,null);
 console.log('PASS: safe gate verified pairing, no 109 dispatch, one-shot owner association, ambiguous target rejected');
})().catch(e=>{console.error(e);process.exitCode=1;});
