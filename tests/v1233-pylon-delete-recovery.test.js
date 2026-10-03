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

function nativeArea(id = 102) {
  return [id, { id, type: 2, shapeType: 2, path: [
    { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 },
  ] }];
}

function baseDevice() {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {};
  d._cachedMapData = { mowingAreas: [[1, {}]], forbiddenAreas: [nativeArea()] };
  d._pylonNativeWriteBusy = false;
  d._pylonUiRevision = 0;
  d._directNativeDeleteUi = new Map();
  d._pendingPylonReadbackTimers = new Map();
  d.log = () => {};
  d.error = () => {};
  d.getData = () => ({ id: 'mower' });
  d.getSetting = () => true;
  d.setStoreValue = async () => {};
  d._scheduleMapCameraImageUpdate = () => {};
  d._requestMowerMapPublish = async () => true;
  d._scheduleDirectNativeDeleteReadback = () => {};
  d._parseMapDataChunks = () => d._cachedMapData;
  d._buildObstaclePylons = () => [];
  return d;
}

test('v1233 direct native delete never persists a pylon pending lock', async () => {
  const d = baseDevice();
  d._obstacleRulesCache = {
    'geo:0:0:0': { mapIndex:0, nativeId:102, nativeMatchIds:[102], action:'avoid', pending:null, updatedAt:Date.now() },
  };
  d._api = {
    getRawProperties: async () => ({ data: { any: true } }),
    deleteForbiddenAreas: async () => ({ ok:true, legs:[
      { name:'select', accepted:true, taskAck:true },
      { name:'begin', accepted:true, taskAck:true },
      { name:'mutation', accepted:true, taskAck:true },
      { name:'commit', accepted:true, taskAck:true },
    ] }),
  };
  const out = await d.updateObstacleRule({ id:'native-zone:102', nativeZoneId:102, deleteForbidden:true });
  assert.equal(out.ok, true);
  assert.equal(out.pending, true);
  assert.equal(d._obstacleRulesCache['geo:0:0:0'].pending, null);
  assert.equal(d._obstacleRulesCache['geo:0:0:0'].nativeId, 102);
  assert.equal(d._obstacleRulesCache['geo:0:0:0'].verification, 'native_direct_delete_requested');
  assert.equal(d._directNativeDeleteUi.has(102), true);
});

test('v1233 direct native delete confirmation detaches rule only after native id disappears', async () => {
  const d = baseDevice();
  d._obstacleRulesCache = {
    'geo:0:0:0': { mapIndex:0, nativeId:102, nativeMatchIds:[102], action:'avoid', pending:null, updatedAt:Date.now() },
  };
  d._directNativeDeleteUi.set(102, { updatedAt:Date.now()-2000, mapIndex:0, affectedRuleIds:['geo:0:0:0'] });
  await d._reconcilePylonNativeRules({ forbiddenAreas:[] }, { fresh:true });
  const rule = d._obstacleRulesCache['geo:0:0:0'];
  assert.equal(d._directNativeDeleteUi.has(102), false);
  assert.equal(rule.nativeId, null);
  assert.equal(rule.pending, null);
  assert.equal(rule.action, 'observe');
  assert.equal(rule.verification, 'native_direct_delete_confirmed');
});

test('1.2.40 supersedes v1233: unconfirmed direct native delete stays pending after 15 seconds', async () => {
  const d = baseDevice();
  d._obstacleRulesCache = {
    'geo:0:0:0': { mapIndex:0, nativeId:102, nativeMatchIds:[102], action:'avoid', pending:null, updatedAt:Date.now() },
  };
  d._directNativeDeleteUi.set(102, { updatedAt:Date.now()-16000, mapIndex:0, affectedRuleIds:['geo:0:0:0'] });
  await d._reconcilePylonNativeRules({ forbiddenAreas:[nativeArea()] }, { fresh:true });
  const rule = d._obstacleRulesCache['geo:0:0:0'];
  assert.equal(d._directNativeDeleteUi.has(102), true);
  assert.equal(rule.nativeId, 102);
  assert.equal(rule.pending, null);
  assert.equal(rule.action, 'avoid');
  assert.equal(rule.verification, undefined);
});

test('v1233 restart recovers a persisted 1.2.32 delete lock using native id, not OBS geometry', async () => {
  const d = baseDevice();
  d._obstacleRulesCache = {
    'geo:0:old': {
      mapIndex:0, nativeId:102, nativeMatchIds:[102], pendingDeleteIds:[102],
      pending:'delete', action:'avoid', centerX:-7880, centerY:-717, radius:500,
      updatedAt:Date.now()-16000,
    },
  };
  // No matching current pylon on purpose: delete verification must use native id only.
  d._buildObstaclePylons = () => [{ id:'obs:1', x:5000, y:5000, source:'obs' }];
  await d._reconcilePylonNativeRules({ forbiddenAreas:[nativeArea()] }, { fresh:true });
  const rule = d._obstacleRulesCache['geo:0:old'];
  assert.equal(rule.nativeId, 102);
  assert.equal(rule.pending, 'delete');
  assert.equal(rule.action, 'avoid');
  assert.equal(rule.verification, 'native_delete_waiting_for_map_sync');
});

test('v1233 delete confirmation is native-id based and cannot false-confirm because OBS moved', async () => {
  const d = baseDevice();
  d._obstacleRulesCache = {
    'geo:0:old': {
      mapIndex:0, nativeId:102, nativeMatchIds:[102], pendingDeleteIds:[102],
      pending:'delete', action:'avoid', centerX:-7880, centerY:-717, radius:500,
      updatedAt:Date.now()-2000,
    },
  };
  d._buildObstaclePylons = () => [{ id:'obs:1', x:5000, y:5000, source:'obs' }];
  await d._reconcilePylonNativeRules({ forbiddenAreas:[nativeArea()] }, { fresh:true });
  assert.equal(d._obstacleRulesCache['geo:0:old'].pending, 'delete');
  assert.equal(d._obstacleRulesCache['geo:0:old'].nativeId, 102);
});
