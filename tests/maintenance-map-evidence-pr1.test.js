'use strict';
const assert = require('node:assert/strict');
const { nativeMaintenanceIndexes, safeMAPIShape, checkMaintenancePoint } = require('../lib/garage/MaintenancePointPreflight');
(async () => {
  const nested = {result: {out: [{m:'g',t:'MAPI',d:{map:{maintenancePoints:[
    {index:1,x:10,y:20},{pointIndex:2,position:{x:30,y:40}},
  ]}}}]}};
  assert.deepEqual(nativeMaintenanceIndexes(nested).indexes, [1,2]);
  const sparse = {d:{areas:[{id:2, x:10,y:20}], markers:{dangerArea:{x:10,y:20}}}};
  assert.deepEqual(nativeMaintenanceIndexes(sparse).indexes, []);
  assert.equal((await checkMaintenancePoint({point:2,getMAPI:async()=>nested,mapIndex:0})).allowed,true);
  assert.equal((await checkMaintenancePoint({point:2,getMAPI:async()=>sparse,mapIndex:0})).reason,'unverifiable');
  const shape = safeMAPIShape({d:{hash:'abc',data:{maintenancePoints:[{index:2,x:123456,y:654321}]}}});
  assert.ok(!shape.includes('123456') && !shape.includes('654321'),'diagnostic schema must not leak coordinate values');
  console.log('PASS: nested MAPI indexed point proof; unknown P2 remains blocked; safe schema logging');
})().catch(e => {console.error(e);process.exitCode=1;});
