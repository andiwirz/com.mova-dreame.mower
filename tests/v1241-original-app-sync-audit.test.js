'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
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
const MovaApi = require('../lib/MovaApi');

function square(id, cx, cy, half = 500) {
  return [id, { id, type:2, shapeType:2, path:[
    {x:cx-half,y:cy-half},{x:cx+half,y:cy-half},{x:cx+half,y:cy+half},{x:cx-half,y:cy+half},
  ] }];
}
function compact(id, cxRaw, cyRaw, half = 50) {
  return { id, type:2, data:[
    [cxRaw-half,cyRaw-half],[cxRaw+half,cyRaw-half],[cxRaw+half,cyRaw+half],[cxRaw-half,cyRaw+half],
  ] };
}
function map(ids = [101,102,103]) {
  const stable = new Map([[101,-8000],[102,-7000],[103,-6000],[104,-5000],[106,-4000]]);
  return {
    boundary:{x1:-10000,y1:-10000,x2:10000,y2:10000}, name:'Map', md5sum:'cloud',
    mowingAreas:[[1,{id:1,path:[{x:-9000,y:-4000},{x:2000,y:-4000},{x:2000,y:5000},{x:-9000,y:5000}]}]],
    forbiddenAreas:ids.map(id => square(id, stable.get(id) ?? 0, -1000)),
    spotAreas:[], contours:[], mapObstacles:[], livePath:[],
  };
}
function payload(ids = [101,102,103], overrides = {}) {
  const stable = new Map([[101,-800],[102,-700],[103,-600],[104,-500],[106,-400]]);
  return {
    map:[
      {id:1,area:100,data:[[-900,-400],[200,-400],[200,500],[-900,500]]},
      ...ids.map(id => compact(id, overrides[id]?.x ?? stable.get(id) ?? 0, overrides[id]?.y ?? -100)),
    ],
    name:'Garden', point:[], semantic:[], spot:[], trajectory:[], cut_relation:[], total_area:100,
  };
}
function device(ids = [101,102,103]) {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._cachedMapData = map(ids);
  d._obstacleRulesCache = {};
  d._nativeZoneLabelsCache = {};
  d._nativeZoneLabelDeleteWatches = {};
  d._directNativeDeleteUi = new Map();
  d._directNativeDeleteTimers = new Map();
  d._pendingPylonReadbackTimers = new Map();
  d._pylonUiRevision = 0;
  d._lastVendorMapMeta = null;
  d.log = () => {};
  d.error = () => {};
  d.setStoreValue = async () => {};
  d.unsetStoreValue = async () => {};
  d._scheduleMapCameraImageUpdate = () => {};
  d.getData = () => ({id:'mower'});
  d._logNativeForbiddenReadOnly = () => {};
  return d;
}

test('1.2.41 API lock prevents any public MAPI call from reselecting the cursor during MAPI→MAPD→MAPI', async () => {
  const api = Object.create(MovaApi.prototype);
  api._log = () => {};
  api._mapTransferTail = Promise.resolve();
  const text = JSON.stringify({map:[{id:1,data:[[0,0],[1,0],[1,1]]}],name:'Garden'});
  const size = Buffer.byteLength(text);
  const hash = crypto.createHash('md5').update(Buffer.from(text)).digest('hex');
  const order = [];
  let mapiCalls = 0;
  let enteredMapd;
  const mapdEntered = new Promise(resolve => { enteredMapd = resolve; });
  let releaseMapd;
  const mapdGate = new Promise(resolve => { releaseMapd = resolve; });
  api._getMAPIUnlocked = async (_did, idx) => {
    mapiCalls++;
    order.push(`MAPI:${mapiCalls}`);
    return {d:{idx,hash,size}};
  };
  api._getMAPDUnlocked = async (_did, start, requested) => {
    order.push(`MAPD:${start}`);
    enteredMapd();
    await mapdGate;
    assert.equal(start,0);
    assert.ok(requested >= size);
    return {d:{start:0,size,data:text}};
  };

  const directPromise = api.getDirectMapSnapshot('mower',0,{attempts:1});
  await mapdEntered;
  const externalMAPI = api.getMAPI('mower',0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order,['MAPI:1','MAPD:0'],'queued public MAPI must not enter while MAPD owns the cursor');
  releaseMapd();
  await directPromise;
  await externalMAPI;
  assert.deepEqual(order,['MAPI:1','MAPD:0','MAPI:2','MAPI:3']);
});

test('1.2.41 MAPD transport advances by firmware-reported size even when JSON escape overhead makes it larger than decoded UTF-8', async () => {
  const api = Object.create(MovaApi.prototype);
  api._log = () => {};
  api._mapTransferTail = Promise.resolve();
  const text = JSON.stringify({map:[{id:101,type:2,data:[[1,2],[3,4],[5,6]]}],name:'Garden'});
  const decoded = Buffer.byteLength(text,'utf8');
  const transportSize = decoded + 8;
  const hash = crypto.createHash('md5').update(Buffer.from(text,'utf8')).digest('hex');
  let mapiCalls = 0;
  api._getMAPIUnlocked = async (_did, idx) => { mapiCalls++; return {d:{idx,hash,size:transportSize}}; };
  api._getMAPDUnlocked = async (_did, start, requested) => {
    assert.equal(start,0);
    assert.equal(requested,transportSize);
    return {d:{start,size:transportSize,data:text}};
  };
  const out = await api.getDirectMapSnapshot('mower',0,{attempts:1});
  assert.equal(out.receivedSize,transportSize);
  assert.equal(out.decodedSize,decoded);
  assert.equal(out.hash,hash);
  assert.equal(mapiCalls,2);
});

test('1.2.41 MAPD semantic guard requires unchanged cloud-established ids to keep matching geometry', () => {
  const d = device([101,102]);
  const parsed = d._parseAppActionMapPayload(
    {idx:0,hash:'after',size:1,chunkCount:1,payload:payload([101,102],{102:{x:-100,y:-100}})},
    d._cachedMapData,
  );
  assert.equal(parsed.directMapdTransportVerified,true);
  assert.equal(parsed.directMapdGeometryVerified,false);
  assert.deepEqual(parsed.directMapdMismatchedBaseIds,[102]);
  assert.deepEqual(parsed.forbiddenAreas.map(e=>e[0]),[101,102],'untrusted MAPD may not replace known native geometry');
});

test('1.2.41 unknown extra type-2 MAPD object is diagnostic only unless a pending Homey create proves its geometry', () => {
  const d = device([101,102]);
  const parsed = d._parseAppActionMapPayload(
    {idx:0,hash:'after',size:1,chunkCount:1,payload:payload([101,102,103])},
    d._cachedMapData,
  );
  assert.equal(parsed.directMapdGeometryVerified,true);
  assert.deepEqual(parsed.directMapdCandidateIds,[101,102,103]);
  assert.deepEqual(parsed.directMapdTrustedIds,[101,102]);
  assert.deepEqual(parsed.forbiddenAreas.map(e=>e[0]),[101,102]);
});

test('1.2.41 direct delete accepts exactly the expected missing id only when every unrelated base zone still matches geometry', () => {
  const d = device([101,102,103]);
  d._directNativeDeleteUi.set(103,{mapIndex:0,updatedAt:Date.now()});
  const good = d._parseAppActionMapPayload(
    {idx:0,hash:'after',size:1,chunkCount:1,payload:payload([101,102])}, d._cachedMapData);
  assert.equal(good.directMapdGeometryVerified,true);
  assert.deepEqual(good.directMapdPendingDeleteIds,[103]);
  assert.deepEqual(good.forbiddenAreas.map(e=>e[0]),[101,102]);

  const bad = d._parseAppActionMapPayload(
    {idx:0,hash:'bad',size:1,chunkCount:1,payload:payload([101],{101:{x:-800,y:-100}})}, d._cachedMapData);
  assert.equal(bad.directMapdGeometryVerified,false);
  assert.deepEqual(bad.directMapdMissingBaseIds,[102]);
});

test('1.2.41 deleting the last known native zone cannot be confirmed from an empty/unrecognised MAPD restriction family alone', () => {
  const d = device([103]);
  d._directNativeDeleteUi.set(103,{mapIndex:0,updatedAt:Date.now()});
  const noRestrictions = {
    map:[{id:1,area:100,data:[[-900,-400],[200,-400],[200,500],[-900,500]]}],
    name:'Garden',point:[],semantic:[],spot:[],trajectory:[],cut_relation:[],total_area:100,
  };
  const parsed = d._parseAppActionMapPayload(
    {idx:0,hash:'after',size:1,chunkCount:1,payload:noRestrictions}, d._cachedMapData);
  assert.equal(parsed.directMapdTransportVerified,true);
  assert.equal(parsed.directMapdGeometryVerified,false);
  assert.deepEqual(parsed.forbiddenAreas.map(e=>e[0]),[103]);
});

test('1.2.41 a non-fresh cache can never clear Pending; stale cloud geometry also waits for MAPI revision advance', async () => {
  const d = device([101,102,103]);
  const before = {hash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',size:3300};
  d._lastVendorMapMeta = {...before};
  d._directNativeDeleteUi.set(103,{mapIndex:0,updatedAt:Date.now()-20000,mapRevisionBefore:before});
  const cloudMissing = map([101,102]);

  await d._reconcilePylonNativeRules(cloudMissing,{fresh:false});
  assert.equal(d._directNativeDeleteUi.has(103),true,'cached/non-fresh map is never confirmation');

  await d._reconcilePylonNativeRules(cloudMissing,{fresh:true});
  assert.equal(d._directNativeDeleteUi.has(103),true,'fresh HTTP cloud response at the old MAPI revision is still stale');

  d._lastVendorMapMeta = {hash:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',size:3200};
  await d._reconcilePylonNativeRules(cloudMissing,{fresh:true});
  assert.equal(d._directNativeDeleteUi.has(103),false,'cloud absence may confirm only after native revision advanced');
});

test('1.2.41 verified direct MAPD can confirm Pending without waiting for cloud MAP.* catch-up', async () => {
  const d = device([101,102,103]);
  const before = {hash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',size:3300};
  d._lastVendorMapMeta = {...before};
  d._directNativeDeleteUi.set(103,{mapIndex:0,updatedAt:Date.now()-3000,mapRevisionBefore:before});
  const direct = d._parseAppActionMapPayload(
    {idx:0,hash:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',size:3200,chunkCount:9,payload:payload([101,102])},
    d._cachedMapData,
  );
  assert.equal(direct.directMapdGeometryVerified,true);
  await d._reconcilePylonNativeRules(direct,{fresh:true});
  assert.equal(d._directNativeDeleteUi.has(103),false);
});

test('1.2.41 captured vendor keys:[] snapshot is consumed once before independent MAPD verification instead of issuing a duplicate cloud request', async () => {
  const d = device([101,102]);
  const cloudParsed = map([101,102]);
  d._lastVendorMapScreenSnapshot = {at:Date.now(),mapIndex:0,response:{data:{captured:true}}};
  d._parseMapDataChunks = raw => raw?.captured ? cloudParsed : null;
  let cloudCalls = 0;
  d._noteNativeMapRevisionProgress = async () => {};
  d._api = {
    getRawDeviceDataSnapshot: async () => { cloudCalls++; return {data:{duplicate:true}}; },
    getDirectMapSnapshot: async () => ({idx:0,hash:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',size:3200,chunkCount:9,payload:payload([101,102])}),
  };
  const out = await d._readTargetedNativeMapBatch();
  assert.equal(out.source,'MAPD');
  assert.equal(cloudCalls,0);
  assert.equal(d._lastVendorMapScreenSnapshot,null);
});
