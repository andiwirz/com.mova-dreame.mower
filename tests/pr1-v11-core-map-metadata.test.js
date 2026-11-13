'use strict';
const assert=require('node:assert/strict');
const {maintenanceMapEvidence}=require('../lib/garage/MaintenancePointPreflight');
const {MaintenancePointCoordinator}=require('../lib/garage/MaintenancePointCoordinator');
(async()=>{
  // A zone-less partial MAPI response may carry manufacturer-indexed service
  // points. It must not be rejected merely because mowingAreas are absent.
  const partial={d:{hash:'a2map123456789',maintenancePoints:[{index:2,position:{x:-5790,y:-7540}}]}};
  const evidence=maintenanceMapEvidence(partial,2);
  assert.equal(evidence.evidence,true);
  assert.deepEqual(evidence.indexes,[2]);
  assert.deepEqual(evidence.position,{x:-5790,y:-7540});
  assert.equal(maintenanceMapEvidence({d:{markers:{point_2:{x:9,y:9}}}},2).position,null);
  const data={mowingAreas:[{id:1}],maintenancePoint:{x:100,y:200},maintenancePoints:[]};
  const stored={'0':{'2':{index:2,mapIndex:0,x:-5790,y:-7540,source:'native_indexed_map_position_stable',confirmedAt:Date.now(),mapHash:'a2map123456789'}}};
  const device={_activeMapIndex:0,_cachedMapData:data,_cachedMAPI:partial,
    getData:()=>({id:'test'}),getStoreValue:async k=>k==='native_additional_maintenance_points_v1'?stored:{},
    hasCapability:()=>false,registerCapabilityListener:()=>{},addCapability:async()=>{},_api:{getMAPI:async()=>partial},homey:{i18n:{getLanguage:()=> 'de'}}};
  const c=new MaintenancePointCoordinator(device,()=>{});
  await c.load();
  const withPoints=await c.attachMap(data);
  assert.equal(withPoints.maintenancePoints.length,1);
  assert.equal(withPoints.maintenancePoints[0].index,2);
  assert.equal(withPoints.maintenancePoints[0].confirmed,true);
  assert.deepEqual(data.mowingAreas,[{id:1}]);
  assert.deepEqual(data.maintenancePoint,{x:100,y:200});
  console.log('PASS: core-style map marker overlay, independent partial-MAPI service metadata, primary marker safe');
})().catch(err=>{console.error(err);process.exitCode=1});
