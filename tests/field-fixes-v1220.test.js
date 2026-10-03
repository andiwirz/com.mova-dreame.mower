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

test('current build exposes one live Wendemodus picker and keeps Advanced Settings duplicate removed', () => {
  const compose = JSON.parse(read('drivers/mower/driver.compose.json'));
  const cap = JSON.parse(read('.homeycompose/capabilities/turning_method.json'));
  assert.ok(compose.capabilities.includes('turning_method'));
  assert.ok(!compose.capabilities.includes('lawn_care_mode'));
  assert.equal(cap.type, 'enum');
  assert.equal(cap.uiComponent, 'picker');
  assert.equal(cap.getable, true);
  assert.equal(cap.setable, true);
  assert.doesNotMatch(read('drivers/mower/driver.compose.json'), /"id": "map_safe_turning"/);
  assert.match(read('drivers/mower/device.js'), /'lawn_care_mode'/, 'obsolete boolean is explicitly removed during migration');
});

test('laggy SETTINGS steeringMode is diagnostic-only; live picker is not flickered before PRE[19] readback', async () => {
  const d = Object.create(Device.prototype);
  const caps = [];
  const settings = [];
  d._activeMapIndex = 0;
  d._nativePreferenceDiagSignature = null;
  d._cuttingHeightWriteTs = 0;
  d._lastNativeSteeringMode = 1;
  d.hasCapability = cap => cap === 'turning_method';
  d._setCap = async (cap, value) => caps.push([cap, value]);
  d.setSettings = async value => settings.push(value);
  d.setStoreValue = async () => {};
  d.getSetting = () => null;
  d.log = () => {};
  d.error = () => {};
  d._buildPREFromSettings = () => null;
  await d._applyMOVASettings({
    'SETTINGS.0': JSON.stringify([{ settings: { '0': { steeringMode: 0 } } }]),
  });
  assert.equal(caps.length, 0, 'stale SETTINGS must not overwrite the live PRE-backed picker');
  assert.equal(settings.length, 0);
  assert.equal(d._lastNativeSteeringMode, 1);
  assert.equal(d._lastSettingsSteeringMode, 0);
});

test('1.2.40 supersedes 1.2.20: current native pending stays locked until geometry confirms', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._pendingPylonReadbackTimers = new Map();
  d._buildObstaclePylons = () => [{ id:'obs:1', x:1000, y:2000 }];
  d.homey = { clearTimeout() {} };
  d.log = () => {};
  d.setStoreValue = async () => {};

  d._obstacleRulesCache = {
    'obs:1': { action:'observe', radius:500, mapIndex:0, pending:'create', nativeId:null,
      nativeWriteVersion:4, updatedAt:Date.now() },
  };
  await d._reconcilePylonNativeRules({ forbiddenAreas:[] }, { fresh:true });
  assert.equal(d._obstacleRulesCache['obs:1'].pending, 'create');

  d._obstacleRulesCache['obs:1'].updatedAt = Date.now() - 490_000;
  await d._reconcilePylonNativeRules({ forbiddenAreas:[] }, { fresh:true });
  assert.equal(d._obstacleRulesCache['obs:1'].pending, 'create');
  assert.equal(d._obstacleRulesCache['obs:1'].action, 'observe');
  assert.equal(d._obstacleRulesCache['obs:1'].verification, 'native_create_waiting_for_map_sync');
});

test('1.2.20 app restart re-arms persisted pending verification instead of leaving a permanent lock', async () => {
  const d = Object.create(Device.prototype);
  const scheduled = [];
  let refreshes = 0;
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {
    'obs:1': { pending:'create', mapIndex:0, updatedAt:Date.now()-120_000, nativeWriteVersion:4 },
  };
  d.log = () => {};
  d.homey = {
    setTimeout: (fn, delay) => { scheduled.push({fn,delay}); return scheduled.length; },
    clearTimeout: () => {},
  };
  d.refreshMapData = async () => { refreshes++; };
  d._resumePendingPylonVerification();
  assert.equal(scheduled.length, 11);
  assert.ok(scheduled[0].delay >= 29_000 && scheduled[0].delay <= 30_100);
  await scheduled[0].fn();
  assert.equal(refreshes, 1);
});

test('1.2.20 a late native square from a timed-out Homey write is adopted before any duplicate create', async () => {
  const d = Object.create(Device.prototype);
  const writes = [];
  const square = { shapeType:2, path:[
    {x:500,y:1500},{x:1500,y:1500},{x:1500,y:2500},{x:500,y:2500},
  ] };
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {
    'obs:1': { action:'observe', radius:500, mapIndex:0, pending:null, nativeId:null,
      nativeWriteVersion:4, verification:'native_create_unconfirmed_timeout', updatedAt:Date.now()-100_000 },
  };
  d._buildObstaclePylons = () => [{ id:'obs:1', x:1000, y:2000, source:'obs', coordinateScaleUncertain:false }];
  d.getSetting = key => key === 'map_safe_mowing';
  d.getData = () => ({id:'mower'});
  d.log = () => {};
  d.setStoreValue = async () => {};
  d._parseMapDataChunks = () => ({ mowingAreas:[[1,{}]], forbiddenAreas:[[106,square]] });
  d._api = {
    getRawProperties: async () => ({data:{map:true}}),
    setForbiddenPolygon: async () => { writes.push('create'); throw Error('must not write'); },
  };
  const result = await d.updateObstacleRule({id:'obs:1', action:'avoid', radiusCm:50});
  assert.equal(writes.length, 0);
  assert.equal(result.rule.nativeId, 106);
  assert.equal(result.rule.action, 'avoid');
  assert.equal(result.rule.verification, 'native_late_create_adopted');
});

test('1.2.20 native no-go transaction exactly uses routed map select/begin/mutation/commit and no TASK waiter', async () => {
  const api = Object.create(MovaApi.prototype);
  const calls = [];
  api.sendAction = async (_did,_s,_a,input) => { calls.push(input[0]); return {result:{out:[{r:0}]}}; };
  await api.setForbiddenPolygon('mower', [[0.5,1.5],[1.5,1.5],[1.5,2.5],[0.5,2.5]], -1, 0);
  assert.deepEqual(calls.map(x=>x.o), [200,204,215,201]);
  assert.deepEqual(calls[2], {m:'a',p:0,o:215,d:{id:-1,type:2,points:[[0.5,1.5],[1.5,1.5],[1.5,2.5],[0.5,2.5]],radius:0}});
  assert.equal(typeof api.setMapEditTaskWaiter, 'undefined');
});
