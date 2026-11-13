'use strict';
const assert=require('node:assert/strict');
const {MaintenancePointCoordinator}=require('../lib/garage/MaintenancePointCoordinator');
(async()=>{
 const store={maintenance_point_names_v1:{maintenance_point_2_name:'Old P2'}},added=[],listener=new Map();
 const d={_activeMapIndex:0,_api:{},getData:()=>({id:'mower'}),
 getStoreValue:async key=>store[key],setStoreValue:async(key,v)=>{store[key]=v},
 getSetting:()=>undefined,hasCapability:c=>added.includes(c),
 addCapability:async c=>added.push(c),setCapabilityOptions:async()=>{},
 registerCapabilityListener:(c,fn)=>listener.set(c,fn),setCapabilityValue:async()=>{},};
 const coordinator=new MaintenancePointCoordinator(d);
 await coordinator.load();
 assert.equal(store.maintenance_point_names_v1.maintenance_point_2_name,'Old P2');
 assert.equal(coordinator._pointName(2),'Old P2');
 assert(added.includes('cmd_maintenance_point_2'));
 store.maintenance_point_names_v1={maintenance_point_2_name:'New P2',maintenance_point_3_name:'P3'};
 await coordinator.reloadNames();
 assert.equal(coordinator._pointName(2),'New P2');
 assert(added.includes('cmd_maintenance_point_3'));
 assert.equal(listener.size,2);
 console.log('PASS: repair-only store names refresh coordinator and P2/P3 buttons');
})().catch(e=>{console.error(e);process.exitCode=1});
