'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

const root = path.join(__dirname, '..');
const square = (cx, cy, half = 500) => ({
  shapeType: 2,
  path: [
    {x:cx-half,y:cy-half},{x:cx+half,y:cy-half},
    {x:cx+half,y:cy+half},{x:cx-half,y:cy+half},
  ],
});

test('1.2.32 recycled OBS id cannot inherit an anchored Homey rule from another physical pylon', () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  const rules = {
    'obs:1': { mapIndex:0, centerX:1000, centerY:2000, radius:500, note:'alte Ausfahrt', nativeId:102, nativeWriteVersion:6 },
  };
  const current = { id:'obs:1', x:8000, y:700, source:'obs' };
  const binding = d._resolvePylonRuleBinding(current, rules);
  assert.equal(binding.ruleId, null);
  assert.equal(binding.rule, null);
});

test('1.2.32 same physical pylon rebinds after Dreame changes the OBS id', () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  const rules = {
    'obs:1': { mapIndex:0, centerX:1000, centerY:2000, radius:500, note:'Schaukel', nativeId:102, nativeWriteVersion:6 },
  };
  const renumbered = { id:'obs:7', x:1020, y:1985, source:'obs' };
  const binding = d._resolvePylonRuleBinding(renumbered, rules);
  assert.equal(binding.ruleId, 'obs:1');
  assert.equal(binding.rule.note, 'Schaukel');
});

test('1.2.32 map payload detaches stale obs metadata instead of showing old native id on the recycled pylon', () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {
    'obs:1': { mapIndex:0, centerX:1000, centerY:2000, radius:500, note:'Ausfahrt', nativeId:102, nativeMatchIds:[102], nativeWriteVersion:6 },
  };
  d._cachedMapData = { forbiddenAreas:[[102, square(1000,2000)]] };
  d._collectObstaclePylonsRaw = () => [{ id:'obs:1', x:8000, y:700, source:'obs', coordinateScaleUncertain:false }];
  const pylons = d._buildObstaclePylons();
  assert.equal(pylons.length, 1);
  assert.equal(pylons[0].id, 'obs:1');
  assert.equal(pylons[0].ruleId, 'geo:0:8000:700');
  assert.equal(pylons[0].rule.note, '');
  assert.equal(pylons[0].rule.nativeId, null);
  assert.equal(pylons[0].rule.storedNativeId, null);
  assert.equal(pylons[0].rule.nativeConfirmed, false);
});

test('1.2.32 direct red native zone deletion does not depend on a surviving OBS pylon', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {};
  d._pylonNativeWriteBusy = false;
  d.getData = () => ({id:'mower'});
  d.getSetting = () => true;
  d.log = () => {};
  d.setStoreValue = async () => {};
  d._parseMapDataChunks = () => ({ mowingAreas:[[1,{path:[]}]], forbiddenAreas:[[102,square(1000,2000)]] });
  d._scheduleDirectNativeDeleteReadback = () => {};
  d._requestMowerMapPublish = async () => true;
  let deleted = null;
  d._api = {
    getRawProperties: async () => ({data:{map:true}}),
    deleteForbiddenAreas: async (_did, ids, mapIndex) => {
      deleted = {ids:[...ids], mapIndex};
      return {result:{out:[{status:true,error:0}]},legs:[]};
    },
  };
  const result = await d.updateObstacleRule({
    id:'native-zone:102', nativeZoneId:102, deleteForbidden:true, action:'observe',
  });
  assert.deepEqual(deleted, {ids:[102],mapIndex:0});
  assert.equal(result.ok, true);
  assert.equal(result.nativeDirect, true);
  assert.equal(result.nativeZoneId, 102);
  assert.equal(result.pending, true);
  assert.equal(d._directNativeDeleteUi.get(102).mapIndex, 0);
});

test('1.2.32 all map editors expose direct native-zone hit targets and stable rule ids', () => {
  const files = [
    'widgets/map/public/index.html',
    'widgets/overview/public/map-editor.html',
    'drivers/mower/repair/map_editor.html',
  ];
  for (const file of files) {
    const src = fs.readFileSync(path.join(root,file),'utf8');
    assert.match(src, /data-native-zone-id/, file);
    assert.match(src, /function openNativeZoneEditor\(nativeId\)/, file);
    assert.match(src, /function findNativeZone\(nativeId\)/, file);
    assert.match(src, /ruleId:\s*selectedDirect \? null : \(_selectedPylon\.ruleId \|\| null\)/, file);
    assert.match(src, /nativeZoneId:\s*selectedDirect \? selectedNativeId : null/, file);
    assert.match(src, /Native Sperrzone #.*direkt aus der Mäherkarte/, file);
  }
});

test('1.2.32 backend persists physical anchors and binding version for new native writes', () => {
  const src = fs.readFileSync(path.join(root,'drivers/mower/device.js'),'utf8');
  assert.match(src, /_stablePylonRuleKey\(/);
  assert.match(src, /_pylonRuleCanBind\(/);
  assert.match(src, /_resolvePylonRuleBinding\(/);
  assert.match(src, /nativeBindingVersion:2/);
  assert.match(src, /stale pylon\/native binding detached before save/);
  assert.match(src, /Rote Sperrzone direkt in der Karte auswählen/);
});
