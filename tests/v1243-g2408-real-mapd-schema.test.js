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

function mmSquare(id, cx, cy, radius = 500) {
  return [id, { id, type:2, shapeType:2, path:[
    {x:cx-radius,y:cy-radius},{x:cx+radius,y:cy-radius},
    {x:cx+radius,y:cy+radius},{x:cx-radius,y:cy+radius},
  ] }];
}

// Exact structural family observed in the real g2408 Windows before/after captures:
// identity on the outer map[] record, polygon in description.points.
function g2408Zone(id, cxRaw, cyRaw, halfRaw = 50) {
  return {
    id, type:2,
    description:{
      type:2,
      points:[
        [cxRaw-halfRaw,cyRaw-halfRaw],[cxRaw+halfRaw,cyRaw-halfRaw],
        [cxRaw+halfRaw,cyRaw+halfRaw],[cxRaw-halfRaw,cyRaw+halfRaw],
      ],
    },
  };
}
function g2408Payload(zones) {
  return {
    cut_relation:[],
    map:[
      {id:1,type:0,area:100,data:[[-900,-400],[200,-400],[200,500],[-900,500]]},
      ...zones,
    ],
    name:'Garden', point:[], semantic:[], spot:[], total_area:100, trajectory:[],
  };
}
function baseMap(ids = [101,102,106]) {
  const centers = {101:[-8000,-1000],102:[-7000,-1000],103:[-5500,-700],106:[-6000,-1000]};
  return {
    boundary:{x1:-10000,y1:-10000,x2:10000,y2:10000}, name:'Map', md5sum:'cloud-stale',
    mowingAreas:[[1,{id:1,path:[{x:-9000,y:-4000},{x:2000,y:-4000},{x:2000,y:5000},{x:-9000,y:5000}]}]],
    forbiddenAreas:ids.map(id => mmSquare(id, ...centers[id], id===103 ? 1000 : 500)),
    spotAreas:[],contours:[],mapObstacles:[],livePath:[],
  };
}
function device(ids = [101,102,106]) {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._devModel = 'dreame.mower.g2408';
  d._cachedMapData = baseMap(ids);
  d._obstacleRulesCache = {};
  d._nativeZoneLabelsCache = {};
  d._nativeZoneLabelDeleteWatches = {};
  d._directNativeDeleteUi = new Map();
  d._directNativeDeleteTimers = new Map();
  d._pendingPylonReadbackTimers = new Map();
  d._pylonUiRevision = 0;
  d.log = () => {};
  d.error = () => {};
  d.setStoreValue = async () => {};
  d.unsetStoreValue = async () => {};
  d._scheduleMapCameraImageUpdate = () => {};
  d._clearPendingPylonReadback = () => {};
  d.getData = () => ({id:'mower'});
  d._logNativeForbiddenReadOnly = () => {};
  return d;
}

const baseZones = () => [
  g2408Zone(101,-800,-100,50),
  g2408Zone(102,-700,-100,50),
  g2408Zone(106,-600,-100,50),
];

test('1.2.43 real g2408 description.points family is parsed using outer native id/type', () => {
  const d = device();
  const parsed = d._parseAppActionMapPayload({idx:0,hash:'before',size:3177,chunkCount:8,payload:g2408Payload(baseZones())}, d._cachedMapData);
  assert.equal(parsed.directMapdTransportVerified,true);
  assert.equal(parsed.directMapdGeometryVerified,true);
  assert.equal(parsed.directMapdScale,10);
  assert.deepEqual(parsed.directMapdCandidateIds,[101,102,106]);
  assert.deepEqual(parsed.directMapdCandidatePaths,['$.map[1]','$.map[2]','$.map[3]']);
  assert.deepEqual(parsed.forbiddenAreas.map(e=>e[0]),[101,102,106]);
});

test('1.2.43 real g2408 create is confirmed directly from MAPD even while cloud base is stale', async () => {
  const d = device([101,102,106]);
  d._buildObstaclePylons = () => [{id:'obs:new',x:-5500,y:-700,source:'obs',coordinateScaleUncertain:false}];
  d._findPylonForRule = () => ({id:'obs:new',x:-5500,y:-700,source:'obs',coordinateScaleUncertain:false});
  d._obstacleRulesCache = {
    'geo:0:-5500:-700': {
      pending:'create', mapIndex:0, nativeId:null,
      beforeIds:[101,102,106], nativeCandidateId:104, // intentionally stale/wrong hint
      centerX:-5500, centerY:-700, radius:1000, nativeWriteVersion:6,
      action:'observe', note:'new zone', updatedAt:Date.now()-2000,
    },
  };
  const payload = g2408Payload([
    ...baseZones().slice(0,2),
    g2408Zone(103,-550,-70,100), // real capture: gap id 103 is reused
    baseZones()[2],
  ]);
  const parsed = d._parseAppActionMapPayload({idx:0,hash:'after-create',size:3322,chunkCount:9,payload}, d._cachedMapData);
  assert.equal(parsed.directMapdGeometryVerified,true);
  assert.deepEqual(parsed.directMapdCandidateIds,[101,102,103,106]);
  assert.deepEqual(parsed.directMapdPendingCreateIds,[103], 'geometry must outrank stale provisional id hint');
  assert.deepEqual(parsed.directMapdTrustedIds,[101,102,103,106]);

  await d._reconcilePylonNativeRules(parsed,{fresh:true});
  const rule = d._obstacleRulesCache['geo:0:-5500:-700'];
  assert.equal(rule.pending,null);
  assert.equal(rule.nativeId,103);
  assert.equal(rule.verification,'native_square_create_confirmed');
});

test('1.2.43 real g2408 delete is confirmed from MAPD when exactly the intended id disappears', async () => {
  const d = device([101,102,103,106]);
  d._buildObstaclePylons = () => [{id:'obs:old',x:-5500,y:-700,source:'obs',coordinateScaleUncertain:false}];
  d._obstacleRulesCache = {
    'geo:0:-5500:-700': {
      pending:'delete', mapIndex:0, nativeId:103, nativeMatchIds:[103], pendingDeleteIds:[103],
      centerX:-5500, centerY:-700, radius:1000, nativeWriteVersion:6,
      action:'avoid', updatedAt:Date.now()-2000,
    },
  };
  const parsed = d._parseAppActionMapPayload({idx:0,hash:'after-delete',size:3177,chunkCount:8,payload:g2408Payload(baseZones())}, d._cachedMapData);
  assert.equal(parsed.directMapdGeometryVerified,true);
  assert.deepEqual(parsed.directMapdPendingDeleteIds,[103]);
  assert.deepEqual(parsed.directMapdMissingBaseIds,[]);
  assert.deepEqual(parsed.directMapdTrustedIds,[101,102,106]);

  await d._reconcilePylonNativeRules(parsed,{fresh:true});
  const rule = d._obstacleRulesCache['geo:0:-5500:-700'];
  assert.equal(rule.pending,null);
  assert.equal(rule.nativeId,null);
  assert.equal(rule.action,'observe');
  assert.equal(rule.verification,'native_delete_confirmed');
});

test('1.2.43 legacy witness guard still rejects loss of an unrelated native zone outside strict g2408 authority', () => {
  const d = device([101,102,103,106]);
  d._devModel = 'dreame.mower.legacy';
  d._obstacleRulesCache = {
    'geo:0:-5500:-700': {
      pending:'delete', mapIndex:0, nativeId:103, nativeMatchIds:[103], pendingDeleteIds:[103],
      centerX:-5500, centerY:-700, radius:1000, nativeWriteVersion:6, action:'avoid', updatedAt:Date.now(),
    },
  };
  // 103 is the intended delete, but 102 has also disappeared: must not become authoritative.
  const parsed = d._parseAppActionMapPayload({idx:0,hash:'bad',size:1,chunkCount:1,payload:g2408Payload([
    g2408Zone(101,-800,-100,50), g2408Zone(106,-600,-100,50),
  ])}, d._cachedMapData);
  assert.equal(parsed.directMapdGeometryVerified,false);
  assert.deepEqual(parsed.directMapdMissingBaseIds,[102]);
  assert.deepEqual(parsed.forbiddenAreas.map(e=>e[0]),[101,102,103,106]);
});

test('1.2.43 real g2408 in-place update keeps native id and accepts only the pending new geometry', async () => {
  const d = device([101,102,106]);
  // Cloud/base knows #102 as a 1.0 m square; Homey has just changed it to a 2.0 m square.
  d._obstacleRulesCache = {
    'geo:0:-7000:-1000': {
      pending:'create', mapIndex:0, nativeId:102, beforeIds:[101,102,106],
      centerX:-7000, centerY:-1000, radius:1000, nativeWriteVersion:6,
      action:'avoid', note:'updated', updatedAt:Date.now()-2000,
    },
  };
  d._buildObstaclePylons = () => [{id:'obs:update',x:-7000,y:-1000,source:'obs',coordinateScaleUncertain:false}];
  d._findPylonForRule = () => ({id:'obs:update',x:-7000,y:-1000,source:'obs',coordinateScaleUncertain:false});
  const payload = g2408Payload([
    g2408Zone(101,-800,-100,50),
    g2408Zone(102,-700,-100,100), // same id, intentionally larger geometry
    g2408Zone(106,-600,-100,50),
  ]);
  const parsed = d._parseAppActionMapPayload({idx:0,hash:'after-update',size:3300,chunkCount:9,payload}, d._cachedMapData);
  assert.equal(parsed.directMapdGeometryVerified,true);
  assert.deepEqual(parsed.directMapdPendingUpdatedIds,[102]);
  assert.deepEqual(parsed.directMapdMismatchedBaseIds,[]);
  const zone = parsed.forbiddenAreas.find(e => e[0] === 102)[1];
  assert.equal(Math.max(...zone.path.map(p=>p.x)) - Math.min(...zone.path.map(p=>p.x)),2000);

  await d._reconcilePylonNativeRules(parsed,{fresh:true});
  const rule = d._obstacleRulesCache['geo:0:-7000:-1000'];
  assert.equal(rule.pending,null);
  assert.equal(rule.nativeId,102);
  assert.equal(rule.verification,'native_square_create_confirmed');
});
