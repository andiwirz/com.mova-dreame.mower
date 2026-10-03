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
const read = p => fs.readFileSync(p, 'utf8');

test('1.2.23 direct PRE[19] mirror updates Homey after an original-app steering change without echo write', async () => {
  const d = Object.create(Device.prototype);
  const caps = [];
  d._turningWriteBusy = false;
  d._activeMapIndex = 0;
  d._lastNativeSteeringMode = 0;
  d._api = { getPRE: async () => Array.from({length:20}, (_, i) => i === 19 ? 1 : 0) };
  d.hasCapability = cap => cap === 'turning_method';
  d.getCapabilityValue = () => 'efficient';
  d.setCapabilityValue = async (cap, value) => { caps.push([cap, value]); };
  d.setStoreValue = async () => {};
  d.log = () => {};
  d._writeTurningMethod = async () => { throw new Error('must not echo'); };
  await d._syncTurningMethodFromNativePRE('mower');
  assert.deepEqual(caps.at(-1), ['turning_method', 'lawn_care']);
  assert.equal(d._lastNativeSteeringMode, 1);
});

test('1.2.23 forced pylon refresh keeps complete MAP.* authoritative instead of overwriting it with stale MAPI', async () => {
  const d = Object.create(Device.prototype);
  const rawMap = { boundary:{x1:0,y1:0,x2:1,y2:1}, mowingAreas:[{id:1}], forbiddenAreas:[{id:101},{id:102}] };
  let mapiCalls = 0;
  d._api = {
    getRawProperties: async () => ({data:{}}),
    getMAPI: async () => { mapiCalls++; return {}; },
  };
  d.getData = () => ({id:'mower'});
  d._activeMapIndex = 0;
  d._obstacleRulesCache = { 'obs:2': { pending:'create', mapIndex:0 } };
  d._mapForceRefreshPromise = null;
  d._parseMapDataChunks = () => rawMap;
  d._parseDirectMapData = () => ({ boundary:{x1:0,y1:0,x2:1,y2:1}, mowingAreas:[{id:1}], forbiddenAreas:[{id:101}] });
  d._logNativeForbiddenReadOnly = () => {};
  d._reconcilePylonNativeRules = async () => {};
  d._saveLastCompleteMap = async () => {};
  d._scheduleMapCameraImageUpdate = () => {};
  d.getMapData = async () => d._cachedMapData;
  d.log = () => {};
  const out = await d.refreshMapData();
  assert.equal(mapiCalls, 1, 'vendor MAPI metadata refresh may precede MAP.*, but must not replace its geometry');
  assert.equal(out.forbiddenAreas.length, 2);
  assert.equal(d._cachedMapData, rawMap);
});

test('1.2.23 pylon readback is MAP-first and captures mower-assigned TASK id only as provisional evidence', () => {
  const src = read('drivers/mower/device.js');
  assert.match(src, /Never[\s\S]{0,220}complete MAP\.\* read be overwritten by a stale MAPI snapshot/);
  assert.match(src, /using MAPI only because complete MAP\.\* readback was unavailable/);
  assert.match(src, /mower assigned provisional native id/);
  assert.match(src, /nativeCandidateId:/);
  assert.match(src, /nativeWriteVersion:\s*6/);
});
