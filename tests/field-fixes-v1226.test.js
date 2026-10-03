
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const read = p => fs.readFileSync(p, 'utf8');

test('1.2.40 supersedes 1.2.26: pending delete keeps one real native representation visible', () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {
    'obs:2': { mapIndex:0, nativeId:103, nativeMatchIds:[102,103], pendingDeleteIds:[102,103], pending:'delete' },
  };
  const map = { forbiddenAreas:[[101,{shapeType:2}],[102,{shapeType:2}],[103,{shapeType:2}],[104,{shapeType:2}]], mowingAreas:[[1,{path:[]}]] };
  const display = d._mapDataForDisplay(map);
  assert.deepEqual(display.forbiddenAreas.map(e => e[0]), [101,103,104]);
  assert.deepEqual(map.forbiddenAreas.map(e => e[0]), [101,102,103,104], 'raw verification map must remain untouched');
});

test('1.2.26 confirmed duplicate Homey squares render once, canonical nativeId remains visible', () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = { 'obs:2': { mapIndex:0, nativeId:103, nativeMatchIds:[102,103], pending:null } };
  const map = { forbiddenAreas:[[101,{}],[102,{}],[103,{}],[104,{}]] };
  const display = d._mapDataForDisplay(map);
  assert.deepEqual(display.forbiddenAreas.map(e => e[0]), [101,103,104]);
});

test('1.2.35 targeted MAP key read uses vendor keys field for MAP.0..127 plus MAP.info', async () => {
  const api = Object.create(MovaApi.prototype);
  api._ensureAuth = async () => {};
  let request = null;
  api._request = async (path, body) => { request={path,body}; return {code:0,data:{}}; };
  await api.getRawMapBatch('mower');
  assert.equal(request.path, '/dreame-user-iot/iotuserdata/getDeviceData');
  assert.equal(request.body.did, 'mower');
  assert.equal(request.body.model, undefined);
  assert.equal(request.body.keys.length, 129);
  assert.equal(request.body.keys[0], 'MAP.0');
  assert.equal(request.body.keys[127], 'MAP.127');
  assert.equal(request.body.keys[128], 'MAP.info');
});

test('1.2.26 confirmed/pending native pylon does not draw misleading second red radius circle', () => {
  for (const file of ['drivers/mower/repair/map_editor.html','widgets/map/public/index.html','widgets/overview/public/map-editor.html']) {
    const html = read(file);
    assert.match(html, /Do not draw an additional red radius circle once a native zone exists/, file);
    assert.match(html, /!rawPendingRule && !\(py\.rule && py\.rule\.nativeId != null\)/, file);
    assert.match(html, /pylon-pending-ring/, file);
  }
});

test('1.2.26 targeted MAP batch is parsed as a complete active map', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d.getData = () => ({id:'mower'});
  d.log = () => {};
  d._logNativeForbiddenReadOnly = () => {};
  const map = {
    mapIndex:0, name:'Map 1', boundary:{x1:0,y1:0,x2:1000,y2:1000},
    mowingAreas:{value:[[1,{path:[{x:0,y:0},{x:1000,y:0},{x:1000,y:1000}]}]]},
    forbiddenAreas:{value:[[104,{id:104,type:2,shapeType:2,path:[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}]}]]}
  };
  d._api = { getRawMapBatch: async () => ({data:{'MAP.0':JSON.stringify([JSON.stringify(map)])}}) };
  const out = await d._readTargetedNativeMapBatch();
  assert.ok(out);
  assert.equal(out.parsed.mowingAreas.length,1);
  assert.equal(out.parsed.forbiddenAreas.length,1);
  assert.equal(out.parsed.forbiddenAreas[0][0],104);
});

test('1.2.26 fresh targeted map can resolve an older delete timeout after Dreame app already removed the zone', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._pendingPylonReadbackTimers = new Map();
  d.homey = { clearTimeout() {} };
  d.log = () => {};
  d.setStoreValue = async () => {};
  d._obstacleRulesCache = {'obs:2':{action:'avoid',radius:500,mapIndex:0,nativeId:103,nativeMatchIds:[102,103],pending:null,verification:'native_delete_partial_timeout'}};
  d._buildObstaclePylons = () => [{id:'obs:2',x:0,y:0,rule:d._obstacleRulesCache['obs:2']}];
  d._nativeForbiddenShape = () => 2;
  d._nativePylonZoneMatches = () => true;
  await d._reconcilePylonNativeRules({forbiddenAreas:[[101,{shapeType:2}],[104,{shapeType:2}]]},{fresh:true});
  assert.equal(d._obstacleRulesCache['obs:2'].nativeId,null);
  assert.equal(d._obstacleRulesCache['obs:2'].action,'observe');
  assert.equal(d._obstacleRulesCache['obs:2'].verification,'native_late_delete_confirmed');
});
