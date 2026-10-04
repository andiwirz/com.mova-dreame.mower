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

function splitBlob(blob, chunk = 40) {
  const out = {};
  for (let i = 0, n = 0; i < blob.length; i += chunk, n++) out[`MAP.${n}`] = blob.slice(i, i + chunk);
  out['MAP.info'] = String(blob.length);
  return out;
}

test('v1235 official v2 named reads use keys and full snapshot uses keys:[]', async () => {
  const api = Object.create(MovaApi.prototype);
  api._ensureAuth = async () => {};
  const calls = [];
  api._request = async (path, body) => { calls.push({path, body}); return { code:0, data:{} }; };
  await api.getRawDeviceDataKeys('mower', ['FBD_NTYPE.0']);
  await api.getRawDeviceDataSnapshot('mower');
  assert.deepEqual(calls[0].body, { did:'mower', keys:['FBD_NTYPE.0'] });
  assert.deepEqual(calls[1].body, { did:'mower', keys:[] });
  assert.equal(calls[0].body.model, undefined);
});

test('v1235 MAP.info bounds current payload and ignores stale residual MAP.N chunks', () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d.log = () => {};
  const current = mapPayload([101, 102]);
  const raw = splitBlob(current, 73);
  const lastCurrentIndex = Math.max(...Object.keys(raw).filter(k => /^MAP\.\d+$/.test(k)).map(k => Number(k.split('.')[1])));
  raw[`MAP.${lastCurrentIndex + 1}`] = mapPayload([999]);
  raw[`MAP.${lastCurrentIndex + 2}`] = 'OLD-TAIL';
  const env = d._joinNativeMapChunks(raw);
  assert.equal(env.text, current);
  assert.equal(env.complete, true);
  assert.ok(env.staleTailLength > 0);
  const parsed = d._parseMapDataChunks(raw);
  assert.deepEqual(parsed.forbiddenAreas.map(e => e[0]), [101, 102]);
});

test('v1235 MAP.info rejects incomplete chunk sets instead of confirming stale geometry', () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d.log = () => {};
  const current = mapPayload([101, 102]);
  const raw = { 'MAP.0': current.slice(0, 100), 'MAP.info': String(current.length) };
  const env = d._joinNativeMapChunks(raw);
  assert.equal(env.complete, false);
  assert.equal(d._parseMapDataChunks(raw), null);
});

test('v1235 vendor map refresh uses MAPI metadata path instead of unsupported 6:1 frame write', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._lastMowerMapPublishRequestAt = 0;
  d.getData = () => ({ id:'mower' });
  d.log = () => {};
  let mapi = 0, frame = 0;
  d._api = {
    getMAPI: async () => { mapi++; return { d:{ idx:0, hash:'abc', size:3407 } }; },
    requestMapFrame: async () => { frame++; },
  };
  assert.equal(await d._requestMowerMapPublish('test'), true);
  assert.equal(mapi, 1);
  assert.equal(frame, 0);
  assert.equal(d._lastVendorMapMeta.hash, 'abc');
});

test('v1235 targeted read falls back to official keys:[] snapshot when named MAP batch is incomplete', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d.getData = () => ({ id:'mower' });
  d.log = () => {};
  d._logNativeForbiddenReadOnly = () => {};
  const fullRaw = splitBlob(mapPayload([101, 106]), 97);
  let snapshotCalls = 0;
  d._api = {
    getRawMapBatch: async () => ({ data:{ 'MAP.0':'[', 'MAP.info':'500' } }),
    getRawDeviceDataSnapshot: async () => { snapshotCalls++; return { data:fullRaw }; },
  };
  const out = await d._readTargetedNativeMapBatch();
  assert.ok(out);
  assert.equal(snapshotCalls, 1);
  assert.deepEqual(out.parsed.forbiddenAreas.map(e => e[0]), [101, 106]);
});
