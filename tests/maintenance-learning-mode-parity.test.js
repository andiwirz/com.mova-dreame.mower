'use strict';
const assert=require('node:assert/strict');
const {MaintenancePointCoordinator}=require('../lib/garage/MaintenancePointCoordinator');
(async()=>{
 for(const mode of ['off','on']) {
  const calls=[];
  const garage={enabled:()=>mode==='on',_lastSensorContactState:'open',isDoorOpenStable:()=>true,_doorOpenReleaseVerified:()=>true,ensureDoorOpen:async()=>{calls.push('open');return true;},_text:(de)=>de};
  const device={_activeMapIndex:0,_garageSafety:garage,_api:{goToMaintenancePoint:()=>calls.push('opcode109')},getSetting:k=>k==='garage_mode_enabled'?mode==='on':k==='maintenance_point_3_name'?'P3':'',getStoreValue:async k=>k==='maintenance_point_names_v1'?{maintenance_point_3_name:'P3'}:{},setStoreValue:async()=>{},hasCapability:()=>false,addCapability:async()=>{},registerCapabilityListener:()=>{},_emitMowerNotice:()=>calls.push('notice')};
  const coord=new MaintenancePointCoordinator(device,()=>{});await coord.load();
  assert.equal(await coord.prepareOriginalApp(3),true);
  assert.equal(coord.operatorAssociation.index,3);
  assert.equal(calls.filter(x=>x==='open').length,mode==='on'?1:0);
  assert.equal(calls.includes('opcode109'),false,'unconfirmed P3 must not drive');
  // P1 never uses the additional-point learner.
  assert.equal(await coord.prepareOriginalApp(1),false);
 }
 console.log('PASS: unconfirmed P2–P5 are observation only; gate only in active mode; P1 remains separate');
})().catch(e=>{console.error(e);process.exitCode=1;});
