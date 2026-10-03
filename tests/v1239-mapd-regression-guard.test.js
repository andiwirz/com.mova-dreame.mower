'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let Device;
try {
  Module._load = function(id, parent, main) {
    if (id === 'homey') return { Device: class {} };
    if (id === 'mqtt') return {};
    return originalLoad.call(this, id, parent, main);
  };
  Device = require('../drivers/mower/device');
} finally { Module._load = originalLoad; }

function sq(cx, cy, half=500) {
  return { id:0, type:2, shapeType:2, path:[
    {x:cx-half,y:cy-half},{x:cx+half,y:cy-half},{x:cx+half,y:cy+half},{x:cx-half,y:cy+half},
  ]};
}
function compactSquare(id, cxRaw, cyRaw, half=50) {
  return { id, type:2, data:[
    [cxRaw-half,cyRaw-half],[cxRaw+half,cyRaw-half],[cxRaw+half,cyRaw+half],[cxRaw-half,cyRaw+half],
  ]};
}
function makeDevice(ids=[101,102,103,104,106]) {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {};
  d._cachedMapData = {
    boundary:{x1:-10000,y1:-10000,x2:10000,y2:10000}, name:'Map', md5sum:'cloud-old',
    mowingAreas:[[1,{id:1,path:[{x:-9000,y:-4000},{x:2000,y:-4000},{x:2000,y:5000},{x:-9000,y:5000}]}]],
    forbiddenAreas:ids.map((id,i)=>[id,{...sq(-8000+i*1000,-1000),id}]),
    spotAreas:[],contours:[],mapObstacles:[],livePath:[],
  };
  d.getData = () => ({id:'mower'});
  d.log = () => {};
  d.error = () => {};
  d._logNativeForbiddenReadOnly = () => {};
  return d;
}
function payloadWithSemantic(ids) {
  const stableOrder = [101,102,103,104,106];
  return {
    map:[{id:1,area:100,data:[[-900,-400],[200,-400],[200,500],[-900,500]]}],
    semantic:ids.map((id)=>{ const i=stableOrder.indexOf(id); return compactSquare(id,-800+(i >= 0 ? i : stableOrder.length)*100,-100); }),
    name:'Garden',point:[],spot:[],trajectory:[],cut_relation:[],total_area:100,
  };
}

test('1.2.39 scans complete MAPD payload, not only payload.map, for native type-2 zones', () => {
  const d = makeDevice([101,102]);
  const parsed = d._parseAppActionMapPayload({idx:0,hash:'h',size:1,chunkCount:1,payload:payloadWithSemantic([101,102,103])}, d._cachedMapData);
  assert.equal(parsed.directMapdTransportVerified,true);
  assert.equal(parsed.directMapdGeometryVerified,true);
  assert.deepEqual(parsed.directMapdCandidateIds,[101,102,103]);
  assert.deepEqual(parsed.forbiddenAreas.map((e)=>e[0]),[101,102]);
  assert.deepEqual(parsed.directMapdTrustedIds,[101,102]);
  assert.deepEqual(parsed.directMapdPendingCreateIds,[]);
  assert.ok(parsed.directMapdCandidatePaths.every((p)=>p.startsWith('$.semantic[')));
});

test('1.2.39 never treats an empty/unrecognised MAPD restriction family as authoritative', async () => {
  const d = makeDevice([101,102,103,104,106]);
  const compact = {
    map:[{id:1,area:100,data:[[-900,-400],[200,-400],[200,500],[-900,500]]}],
    semantic:[],name:'Garden',point:[],spot:[],trajectory:[],cut_relation:[],total_area:100,
  };
  const parsed = d._parseAppActionMapPayload({idx:0,hash:'new',size:1,chunkCount:1,payload:compact}, d._cachedMapData);
  assert.equal(parsed.directMapdTransportVerified,true);
  assert.equal(parsed.directMapdGeometryVerified,false);
  assert.deepEqual(parsed.forbiddenAreas.map((e)=>e[0]),[101,102,103,104,106]);
  assert.deepEqual(parsed.directMapdMissingBaseIds,[101,102,103,104,106]);

  let cloudCalls = 0;
  d._api = {
    getDirectMapSnapshot: async () => ({idx:0,hash:'new',size:1,chunkCount:1,payload:compact}),
    getRawDeviceDataSnapshot: async () => { cloudCalls++; return {data:null}; },
    getRawMapBatch: async () => { cloudCalls++; return {data:null}; },
  };
  const out = await d._readTargetedNativeMapBatch();
  assert.equal(out,null);
  assert.ok(cloudCalls >= 1);
});

test('1.2.39 direct delete may remove only the explicitly pending native id and must preserve all unrelated zones', () => {
  const d = makeDevice([101,102,103,104,106]);
  d._obstacleRulesCache = {
    'geo:0:test': {mapIndex:0,pending:'delete',nativeId:103,nativeMatchIds:[103],pendingDeleteIds:[103]},
  };
  const parsed = d._parseAppActionMapPayload(
    {idx:0,hash:'after-delete',size:1,chunkCount:1,payload:payloadWithSemantic([101,102,104,106])},
    d._cachedMapData,
  );
  assert.equal(parsed.directMapdGeometryVerified,true);
  assert.deepEqual(parsed.directMapdPendingDeleteIds,[103]);
  assert.deepEqual(parsed.directMapdMissingBaseIds,[]);
  assert.deepEqual(parsed.forbiddenAreas.map((e)=>e[0]),[101,102,104,106]);
});

test('1.2.39 rejects direct delete evidence when any unrelated existing native zone disappears from the parsed MAPD set', () => {
  const d = makeDevice([101,102,103,104,106]);
  d._obstacleRulesCache = {
    'geo:0:test': {mapIndex:0,pending:'delete',nativeId:103,nativeMatchIds:[103],pendingDeleteIds:[103]},
  };
  const parsed = d._parseAppActionMapPayload(
    {idx:0,hash:'bad-delete',size:1,chunkCount:1,payload:payloadWithSemantic([101,102,104])},
    d._cachedMapData,
  );
  assert.equal(parsed.directMapdGeometryVerified,false);
  assert.deepEqual(parsed.directMapdMissingBaseIds,[106]);
  assert.deepEqual(parsed.forbiddenAreas.map((e)=>e[0]),[101,102,103,104,106]);
});
