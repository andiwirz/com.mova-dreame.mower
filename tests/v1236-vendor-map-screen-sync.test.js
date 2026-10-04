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
const MovaApi = require('../lib/MovaApi');

function mapPayload(forbiddenIds = [101, 102]) {
  const map = {
    mapIndex: 0,
    name: 'Map 1',
    boundary: { x1: -1000, y1: -1000, x2: 1000, y2: 1000 },
    mowingAreas: { value: [[1, { id: 1, path: [{x:-1000,y:-1000},{x:1000,y:-1000},{x:1000,y:1000}] }]] },
    forbiddenAreas: { value: forbiddenIds.map((id, i) => [id, {
      id, type: 2, shapeType: 2,
      path: [{x:i*100,y:0},{x:i*100+50,y:0},{x:i*100+50,y:50},{x:i*100,y:50}],
    }]) },
    obstacles: { value: [] }, contours: { value: [] }, notObsAreas: { value: [] },
    spotAreas: { value: [] }, cleanPoints: { value: [] }, cruisePoints: { value: [] }, paths: { value: [] },
    md5sum: 'fresh', totalArea: 1, cut: [], merged: false, hasBack: 0,
  };
  return JSON.stringify([JSON.stringify(map)]);
}
function splitBlob(blob, chunk = 80) {
  const out = {};
  for (let i = 0, n = 0; i < blob.length; i += chunk, n++) out[`MAP.${n}`] = blob.slice(i, i + chunk);
  out['MAP.info'] = String(blob.length);
  return out;
}

test('v1236 map-screen context mirrors captured read-only wake/map sequence', async () => {
  const api = Object.create(MovaApi.prototype);
  api._log = () => {};
  const calls = [];
  api.getProperties = async (_did, props) => { calls.push(`prop:${props[0][0]}:${props[0][1]}`); return {code:0}; };
  api.sendAction = async (_did, _siid, _aiid, params) => {
    calls.push(params[0].t);
    return { result:{ out:[{ d:{} }] } };
  };
  api._getMAPIUnlocked = async () => { calls.push('MAPI'); return { d:{ idx:0, hash:'newhash', size:3297 } }; };
  api.getRawDeviceDataSnapshot = async () => { calls.push('keys:[]'); return {data:{}}; };
  const out = await api.refreshMapScreenContext('mower', 0);
  assert.deepEqual(calls, [
    'prop:1:1','prop:1:2','MPOS','DOCK','AIOBS','DEV','MAPL','MAPI','DOCK','MPOS','AIOBS','keys:[]',
  ]);
  assert.equal(out.mapi.d.hash, 'newhash');
  assert.deepEqual(out.snapshot, {data:{}});
  assert.equal(out.steps.every(x => x.ok), true);
});

test('v1236 native confirmation reads vendor keys:[] snapshot before stale named MAP batch', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d.getData = () => ({ id:'mower' });
  d.log = () => {};
  d._logNativeForbiddenReadOnly = () => {};
  const fresh = splitBlob(mapPayload([101,102,103,106]));
  const stale = splitBlob(mapPayload([101,106]));
  let fullCalls = 0;
  let namedCalls = 0;
  d._api = {
    getRawDeviceDataSnapshot: async () => { fullCalls++; return {data:fresh}; },
    getRawMapBatch: async () => { namedCalls++; return {data:stale}; },
  };
  const out = await d._readTargetedNativeMapBatch();
  assert.equal(fullCalls, 1);
  assert.equal(namedCalls, 0);
  assert.deepEqual(out.parsed.forbiddenAreas.map(e => e[0]), [101,102,103,106]);
});

test('v1236 accepted map edit launches vendor map-screen sync rather than metadata-only MAPI', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._lastMowerMapPublishRequestAt = 0;
  d._lastVendorMapScreenSyncAt = 0;
  d.getData = () => ({ id:'mower' });
  d.log = () => {};
  let syncCalls = 0, directMAPI = 0, frame = 0;
  d._api = {
    refreshMapScreenContext: async () => {
      syncCalls++;
      return { mapi:{ d:{ idx:0, hash:'after-edit', size:3297 } }, steps:[{name:'MAPI',ok:true}] };
    },
    getMAPI: async () => { directMAPI++; return { d:{hash:'wrong'} }; },
    requestMapFrame: async () => { frame++; },
  };
  assert.equal(await d._requestMowerMapPublish('pylon-create-accepted'), true);
  assert.equal(syncCalls, 1);
  assert.equal(directMAPI, 0);
  assert.equal(frame, 0);
  assert.equal(d._lastVendorMapMeta.hash, 'after-edit');
});

test('v1236 pending readback re-runs full map-screen sync after 12s, but not on every poll', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d.getData = () => ({ id:'mower' });
  d.log = () => {};
  d._lastMowerMapPublishRequestAt = 0;
  d._lastVendorMapScreenSyncAt = Date.now();
  let syncCalls = 0, mapiCalls = 0;
  d._api = {
    refreshMapScreenContext: async () => { syncCalls++; return {mapi:{d:{hash:'sync',size:1}},steps:[]}; },
    getMAPI: async () => { mapiCalls++; return {d:{hash:'meta',size:1}}; },
  };
  await d._requestMowerMapPublish('pylon-readback');
  assert.equal(syncCalls, 0);
  assert.equal(mapiCalls, 1);

  d._lastMowerMapPublishRequestAt = 0;
  d._lastVendorMapScreenSyncAt = Date.now() - 13000;
  await d._requestMowerMapPublish('pylon-readback');
  assert.equal(syncCalls, 1);
});
