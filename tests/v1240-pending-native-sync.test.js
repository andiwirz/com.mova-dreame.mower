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

function square(id, cx = 0, cy = 0, half = 500) {
  return [id, { id, type:2, shapeType:2, path:[
    {x:cx-half,y:cy-half},{x:cx+half,y:cy-half},{x:cx+half,y:cy+half},{x:cx-half,y:cy+half},
  ] }];
}
function compact(id, cxRaw = 0, cyRaw = 0, half = 50) {
  return { id, type:2, data:[
    [cxRaw-half,cyRaw-half],[cxRaw+half,cyRaw-half],[cxRaw+half,cyRaw+half],[cxRaw-half,cyRaw+half],
  ] };
}
function baseMap(ids = [101,102,103]) {
  return {
    boundary:{x1:-10000,y1:-10000,x2:10000,y2:10000}, name:'Map', md5sum:'cloud-old',
    mowingAreas:[[1,{id:1,path:[{x:-9000,y:-4000},{x:2000,y:-4000},{x:2000,y:5000},{x:-9000,y:5000}]}]],
    forbiddenAreas:ids.map((id,i)=>square(id,-8000+i*1000,-1000)),
    spotAreas:[], contours:[], mapObstacles:[], livePath:[],
  };
}
function payload(ids = [101,102,103]) {
  return {
    map:[{id:1,area:100,data:[[-900,-400],[200,-400],[200,500],[-900,500]]}],
    semantic:ids.map((id,i)=>compact(id,-800+i*100,-100)),
    name:'Garden', point:[], spot:[], trajectory:[], cut_relation:[], total_area:100,
  };
}
function device() {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {};
  d._nativeZoneLabelDeleteWatches = {};
  d._nativeZoneLabelsCache = {};
  d._directNativeDeleteUi = new Map();
  d._directNativeDeleteTimers = new Map();
  d._pendingPylonReadbackTimers = new Map();
  d._cachedMapData = baseMap();
  d._pylonUiRevision = 0;
  d.log = () => {};
  d.error = () => {};
  d.setStoreValue = async () => {};
  d._scheduleMapCameraImageUpdate = () => {};
  d.getData = () => ({id:'mower'});
  return d;
}

test('1.2.40 direct native delete id is exempt from MAPD preservation guard, so MAPD can actually confirm it', () => {
  const d = device();
  d._directNativeDeleteUi.set(103, {mapIndex:0,updatedAt:Date.now()});
  const parsed = d._parseAppActionMapPayload(
    {idx:0,hash:'after',size:1,chunkCount:1,payload:payload([101,102])},
    d._cachedMapData,
  );
  assert.equal(parsed.directMapdGeometryVerified, true);
  assert.deepEqual(parsed.directMapdPendingDeleteIds, [103]);
  assert.deepEqual(parsed.directMapdMissingBaseIds, []);
  assert.deepEqual(parsed.forbiddenAreas.map(e=>e[0]), [101,102]);
});

test('1.2.40 unrelated missing zone still invalidates direct MAPD during direct delete', () => {
  const d = device();
  d._directNativeDeleteUi.set(103, {mapIndex:0,updatedAt:Date.now()});
  const parsed = d._parseAppActionMapPayload(
    {idx:0,hash:'bad',size:1,chunkCount:1,payload:payload([101])},
    d._cachedMapData,
  );
  assert.equal(parsed.directMapdGeometryVerified, false);
  assert.deepEqual(parsed.directMapdMissingBaseIds, [102]);
  assert.deepEqual(parsed.forbiddenAreas.map(e=>e[0]), [101,102,103]);
});

test('1.2.40 direct delete participates in strong map-screen/MAPD targeted refresh even without a pylon pending rule', async () => {
  const d = device();
  d._directNativeDeleteUi.set(103, {mapIndex:0,updatedAt:Date.now()});
  let publish = 0, targeted = 0, reconciledFresh = false;
  d._api = {};
  d._requestMowerMapPublish = async () => { publish++; return false; };
  d._readTargetedNativeMapBatch = async () => {
    targeted++;
    return {source:'MAPD',parsed:{...baseMap([101,102]),directMapdVerified:true,directMapdGeometryVerified:true}};
  };
  d._reconcilePylonNativeRules = async (_map,{fresh}) => { reconciledFresh = fresh === true; };
  d._saveLastCompleteMap = async () => {};
  d.getMapData = async () => ({ok:true});
  const out = await d.refreshMapData();
  assert.deepEqual(out,{ok:true});
  assert.equal(publish,1);
  assert.equal(targeted,1);
  assert.equal(reconciledFresh,true);
});

test('1.2.40 unconfirmed direct delete remains Pending instead of becoming retryable at 15 seconds', async () => {
  const d = device();
  d._directNativeDeleteUi.set(103,{mapIndex:0,updatedAt:Date.now()-20_000,affectedRuleIds:[]});
  await d._reconcilePylonNativeRules(baseMap([101,102,103]),{fresh:true});
  assert.equal(d._directNativeDeleteUi.has(103),true);
  assert.equal(d._directNativeDeleteUi.get(103).waitingLogged,true);
  assert.deepEqual(d._mapDataForDisplay(baseMap([101,102,103])).forbiddenAreas.map(e=>e[0]),[101,102,103]);
});

test('1.2.40 pylon delete stays Pending past old 15-second retry unlock and past old 480-second timeout', async () => {
  const d = device();
  d._obstacleRulesCache = {
    'geo:0:test': {mapIndex:0,pending:'delete',nativeId:103,nativeMatchIds:[103],pendingDeleteIds:[103],action:'avoid',updatedAt:Date.now()-600_000},
  };
  await d._reconcilePylonNativeRules(baseMap([101,102,103]),{fresh:true});
  const rule=d._obstacleRulesCache['geo:0:test'];
  assert.equal(rule.pending,'delete');
  assert.deepEqual(rule.pendingDeleteIds,[103]);
  assert.equal(rule.verification,'native_delete_waiting_for_map_sync');
  assert.equal(d._pylonUiState(rule).uiPending,true);
  assert.equal(d._pylonUiState(rule).optimistic,false);
});

test('1.2.40 MAPI revision advance is progress evidence only and never geometry confirmation', async () => {
  const d = device();
  d._obstacleRulesCache = {
    'geo:0:test': {mapIndex:0,pending:'delete',nativeId:103,pendingDeleteIds:[103],updatedAt:Date.now()-1000,
      mapRevisionBefore:{hash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',size:3300}},
  };
  await d._noteNativeMapRevisionProgress({hash:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',size:3200});
  const rule=d._obstacleRulesCache['geo:0:test'];
  assert.equal(rule.pending,'delete');
  assert.ok(rule.mapRevisionAdvancedAt > 0);
  assert.deepEqual(rule.mapRevisionAfter,{hash:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',size:3200});
});

test('1.2.40 vendor map-screen wake is serialized so it cannot race the next direct readback', async () => {
  const d = device();
  d._mapPublishPromise = null;
  d._lastMowerMapPublishRequestAt = 0;
  d._lastVendorMapScreenSyncAt = 0;
  d._noteNativeMapRevisionProgress = async () => {};
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  d._api = {
    refreshMapScreenContext: async () => {
      calls++;
      await gate;
      return {mapi:{d:{hash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',size:3300}},steps:[{ok:true}]};
    },
    getMAPI: async () => ({d:{hash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',size:3300}}),
  };
  const first = d._requestMowerMapPublish('pylon-delete-accepted');
  await new Promise(resolve => setImmediate(resolve));
  const second = d._requestMowerMapPublish('pylon-readback');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls,1,'second wake must wait for the accepted-edit wake');
  release();
  assert.equal(await first,true);
  assert.equal(await second,false,'immediately repeated wake is safely throttled after the first completes');
  assert.equal(calls,1);
});
