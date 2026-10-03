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

function appPayload(forbidden = [101, 102]) {
  return {
    cut_relation: [],
    map: [
      { id:1, area:24, data:[[-900,-400],[200,-400],[200,500],[-900,500]] },
      ...forbidden.map((id, i) => ({
        id, type:2,
        data:[[-840 + i * 100,-120],[-740 + i * 100,-120],[-740 + i * 100,-20],[-840 + i * 100,-20]],
      })),
    ],
    name:'Garden', point:[], semantic:[], spot:[], total_area:24, trajectory:[],
  };
}
function squareFromRaw(rawCx, rawCy, halfRaw=50, scale=10) {
  return {shapeType:2,path:[
    {x:(rawCx-halfRaw)*scale,y:(rawCy-halfRaw)*scale},
    {x:(rawCx+halfRaw)*scale,y:(rawCy-halfRaw)*scale},
    {x:(rawCx+halfRaw)*scale,y:(rawCy+halfRaw)*scale},
    {x:(rawCx-halfRaw)*scale,y:(rawCy+halfRaw)*scale},
  ]};
}
function baseDevice() {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._cachedMapData = {
    boundary:{x1:-10000,y1:-6000,x2:5000,y2:7000},
    name:'Map', md5sum:'cloud-old',
    mowingAreas:[[1,{id:1,path:[{x:-9000,y:-4000},{x:2000,y:-4000},{x:2000,y:5000},{x:-9000,y:5000}]}]],
    forbiddenAreas:[[101,squareFromRaw(-790,-70)]],
    spotAreas:[],contours:[],mapObstacles:[],livePath:[],
  };
  d.getData = () => ({id:'mower'});
  d.log = () => {};
  d.error = () => {};
  d._logNativeForbiddenReadOnly = () => {};
  return d;
}

function fakeDirectApi(payload, chunkSize=37) {
  const api = Object.create(MovaApi.prototype);
  api._log = () => {};
  const text = JSON.stringify(payload);
  const size = Buffer.byteLength(text, 'utf8');
  const hash = crypto.createHash('md5').update(Buffer.from(text, 'utf8')).digest('hex');
  api._getMAPIUnlocked = async (_did, idx) => ({d:{idx,hash,size}});
  api._getMAPDUnlocked = async (_did, start, requested) => {
    // Fixtures are ASCII so character and byte offsets are identical.
    const part = text.slice(start, start + Math.min(requested, chunkSize));
    return {d:{start,size:Buffer.byteLength(part,'utf8'),data:part}};
  };
  return {api,text,size,hash};
}

test('1.2.38 MAPI+MAPD reassembles and MD5-verifies a complete direct mower map', async () => {
  const {api,size,hash} = fakeDirectApi(appPayload([101,102]), 43);
  const out = await api.getDirectMapSnapshot('mower',0,{chunkSize:80,attempts:1});
  assert.equal(out.size,size);
  assert.equal(out.receivedSize,size);
  assert.equal(out.hash,hash);
  assert.equal(out.payload.name,'Garden');
  assert.ok(out.chunkCount > 1);
});

test('1.2.38 direct MAPD rejects a torn/hash-mismatched snapshot', async () => {
  const {api,size} = fakeDirectApi(appPayload([101,102]), 50);
  api._getMAPIUnlocked = async (_did, idx) => ({d:{idx,hash:'00000000000000000000000000000000',size}});
  await assert.rejects(() => api.getDirectMapSnapshot('mower',0,{attempts:1}), /MAPD hash mismatch/);
});

test('1.2.38 direct MAPD rejects metadata changing during the read', async () => {
  const {api,size,hash} = fakeDirectApi(appPayload([101,102]), 50);
  let calls = 0;
  api._getMAPIUnlocked = async (_did, idx) => {
    calls++;
    return {d:{idx,hash:calls === 1 ? hash : '11111111111111111111111111111111',size}};
  };
  await assert.rejects(() => api.getDirectMapSnapshot('mower',0,{attempts:1}), /map changed while reading/);
});

test('1.2.38 MAPD compact schema becomes native forbidden geometry in Homey mm coordinates', () => {
  const d = baseDevice();
  d._cachedMapData.forbiddenAreas.push([102,squareFromRaw(-690,-70)]);
  const payload = appPayload([101,102]);
  const snapshot = {idx:0,hash:'abcd',size:123,chunkCount:4,payload};
  const parsed = d._parseAppActionMapPayload(snapshot,d._cachedMapData);
  assert.equal(parsed.directMapdVerified,true);
  assert.equal(parsed.directMapdScale,10);
  assert.deepEqual(parsed.forbiddenAreas.map(e=>e[0]),[101,102]);
  // first raw forbidden polygon is centered at (-790,-70) -> (-7900,-700) mm
  const p = parsed.forbiddenAreas[0][1].path;
  const cx = (Math.min(...p.map(x=>x.x)) + Math.max(...p.map(x=>x.x))) / 2;
  const cy = (Math.min(...p.map(x=>x.y)) + Math.max(...p.map(x=>x.y))) / 2;
  assert.equal(cx,-7900);
  assert.equal(cy,-700);
});

test('1.2.41 targeted native read reproduces vendor keys:[] first, but verified MAPD can still outrank stale/unavailable cloud MAP.*', async () => {
  const d = baseDevice();
  d._cachedMapData.forbiddenAreas.push([102,squareFromRaw(-690,-70)]);
  let cloudCalls = 0, namedCalls = 0;
  d._noteNativeMapRevisionProgress = async () => {};
  d._api = {
    getRawDeviceDataSnapshot: async () => { cloudCalls++; throw new Error('simulated cloud lag'); },
    getDirectMapSnapshot: async () => ({idx:0,hash:'direct-new',size:3513,chunkCount:9,payload:appPayload([101,102])}),
    getRawMapBatch: async () => { namedCalls++; throw new Error('named fallback should not be needed after verified MAPD'); },
  };
  const out = await d._readTargetedNativeMapBatch();
  assert.equal(out.source,'MAPD');
  assert.equal(cloudCalls,1,'captured original-app keys:[] read must be attempted before MAPD');
  assert.equal(namedCalls,0);
  assert.deepEqual(out.parsed.forbiddenAreas.map(e=>e[0]),[101,102]);
});

test('1.2.38 stale cloud cannot visually undo a still-current verified MAPD zone set', async () => {
  const d = baseDevice();
  d._cachedMapData.forbiddenAreas.push([102,squareFromRaw(-690,-70)]);
  const direct = d._parseAppActionMapPayload({idx:0,hash:'direct-hash',size:1,chunkCount:1,payload:appPayload([101,102])},d._cachedMapData);
  d._cachedMapData = direct;
  d._lastVendorMapMeta = {hash:'direct-hash'};
  d._lastMapStr = 'old';
  d._activeZoneIds = [1];
  d._discoveredMaps = [];
  d._extractMapInfo = () => ({ids:[1],spotIds:[],maps:[]});
  d._updateZonePicker = async () => {};
  d._updateSpotPicker = async () => {};
  d.getSetting = () => '1';
  d.setSettings = async () => {};
  d._parseMapDataChunks = () => ({
    ...direct,
    md5sum:'stale-cloud',
    directMapdVerified:false,
    forbiddenAreas:[[101,squareFromRaw(-790,-70)]],
    livePath:[],
  });
  d._joinNativeMapChunks = () => ({text:'new-cloud-string'});
  await d._detectAndSyncZones({});
  assert.deepEqual(d._cachedMapData.forbiddenAreas.map(e=>e[0]),[101,102]);
  assert.equal(d._cachedMapData.directMapdVerified,true);
});

test('1.2.38 incomplete/unsupported MAPD geometry falls back without becoming delete evidence', async () => {
  const d = baseDevice();
  let cloudCalls = 0;
  d._api = {
    getDirectMapSnapshot: async () => ({idx:0,hash:'bad',size:10,chunkCount:1,payload:{map:[]}}),
    getRawDeviceDataSnapshot: async () => { cloudCalls++; return {data:null}; },
    getRawMapBatch: async () => { cloudCalls++; return {data:null}; },
  };
  const out = await d._readTargetedNativeMapBatch();
  assert.equal(out,null);
  assert.ok(cloudCalls >= 1);
});

test('1.2.38 fresh verified MAPD can confirm create while cloud base still lacks the new native id', async () => {
  const d = baseDevice();
  d._pylonUiRevision = 0;
  d._directNativeDeleteUi = new Map();
  d._pendingPylonReadbackTimers = new Map();
  d._nativeZoneLabelDeleteWatches = {};
  d._nativeZoneLabelsCache = {};
  d.setStoreValue = async () => {};
  d._scheduleMapCameraImageUpdate = () => {};
  d._buildObstaclePylons = () => [{id:'obs:1',x:-6900,y:-700,source:'obs',coordinateScaleUncertain:false}];
  d._obstacleRulesCache = {
    'geo:0:-6900:-700': {
      mapIndex:0, centerX:-6900, centerY:-700, radius:500,
      pending:'create', beforeIds:[101], nativeCandidateId:102,
      nativeWriteVersion:6, action:'observe', updatedAt:Date.now()-3000,
    },
  };
  const parsed = d._parseAppActionMapPayload(
    {idx:0,hash:'after-create',size:1,chunkCount:1,payload:appPayload([101,102])},
    d._cachedMapData,
  );
  await d._reconcilePylonNativeRules(parsed,{fresh:true});
  const rule = d._obstacleRulesCache['geo:0:-6900:-700'];
  assert.equal(rule.nativeId,102);
  assert.equal(rule.pending,null);
  assert.equal(rule.verification,'native_square_create_confirmed');
});

test('1.2.38 fresh verified MAPD can confirm delete while stale cloud base still contains the old native id', async () => {
  const d = baseDevice();
  d._cachedMapData.forbiddenAreas.push([102,squareFromRaw(-690,-70)]);
  d._pylonUiRevision = 0;
  d._directNativeDeleteUi = new Map();
  d._pendingPylonReadbackTimers = new Map();
  d._nativeZoneLabelDeleteWatches = {};
  d._nativeZoneLabelsCache = {};
  d.setStoreValue = async () => {};
  d._scheduleMapCameraImageUpdate = () => {};
  d._buildObstaclePylons = () => [{id:'obs:1',x:-6900,y:-700,source:'obs',coordinateScaleUncertain:false}];
  d._obstacleRulesCache = {
    'geo:0:-6900:-700': {
      mapIndex:0, nativeId:102, nativeMatchIds:[102], pendingDeleteIds:[102],
      pending:'delete', action:'avoid', centerX:-6900, centerY:-700, radius:500,
      updatedAt:Date.now()-3000,
    },
  };
  const parsed = d._parseAppActionMapPayload(
    {idx:0,hash:'after-delete',size:1,chunkCount:1,payload:appPayload([101])},
    d._cachedMapData,
  );
  await d._reconcilePylonNativeRules(parsed,{fresh:true});
  const rule = d._obstacleRulesCache['geo:0:-6900:-700'];
  assert.equal(rule.nativeId,null);
  assert.equal(rule.pending,null);
  assert.equal(rule.action,'observe');
  assert.equal(rule.verification,'native_delete_confirmed');
});
