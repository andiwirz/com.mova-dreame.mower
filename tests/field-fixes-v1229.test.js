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
const editors = [
  'widgets/map/public/index.html',
  'widgets/overview/public/map-editor.html',
];

test('1.2.29 ancient pending rules no longer create optimistic visual ghosts', () => {
  const d = Object.create(Device.prototype);
  const now = 10_000_000;
  const ui = d._pylonUiState({ pending:'create', updatedAt:now-481_000 }, now);
  assert.equal(ui.pending, true, 'backend metadata can remain pending until cleanup/reconcile');
  assert.equal(ui.expired, false);
  assert.equal(ui.uiPending, true);
  assert.equal(ui.optimistic, false, 'pending must never project a red square before confirmation');

  d._activeMapIndex = 0;
  d._obstacleRulesCache = {
    'obs:old': { mapIndex:0, pending:'create', updatedAt:Date.now()-600_000, centerX:1000, centerY:1000, radius:500 },
  };
  const raw = { forbiddenAreas:[[101,{shapeType:2,path:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]}]], mowingAreas:[[1,{path:[]}]] };
  assert.equal(d._mapDataForDisplay(raw).forbiddenAreas.length, 1);
});

test('1.2.29 startup/hard-refresh purge removes only stale orphan pending metadata', async () => {
  const d = Object.create(Device.prototype);
  const now = Date.now();
  d._obstacleRulesCache = {
    'obs:old': { pending:'create', updatedAt:now-600_000, mapIndex:0, centerX:1, centerY:1 },
    'obs:live': { pending:'create', updatedAt:now-600_000, mapIndex:0, centerX:2, centerY:2 },
    'obs:done': { pending:null, updatedAt:now-999_999, mapIndex:0, nativeId:123 },
  };
  d._buildObstaclePylons = () => [{id:'obs:live'}];
  d._clearPendingPylonReadback = () => {};
  d.setStoreValue = async (key, value) => { d._stored = {key, value}; };
  d.log = () => {};
  d._pylonUiRevision = 4;
  const count = await d._purgeStaleOrphanPylonRules('test');
  assert.equal(count, 1);
  assert.equal(d._obstacleRulesCache['obs:old'], undefined);
  assert.ok(d._obstacleRulesCache['obs:live']);
  assert.ok(d._obstacleRulesCache['obs:done']);
  assert.equal(d._pylonUiRevision, 5);
  assert.equal(d._stored.key, 'obstacle_rules_v1');
});

test('1.2.29 manual map reload is a real hard refresh and drops in-page geometry cache', () => {
  for (const file of editors) {
    const s = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(s, /refresh=1&hard=1/, file);
    assert.match(s, /_lastData = null;[\s\S]{0,160}_lastFullMapData = null;/, file);
    assert.match(s, /_lastPylonUiRevision = -1;/, file);
  }
  const repair = fs.readFileSync(path.join(root, 'drivers/mower/repair/map_editor.html'), 'utf8');
  assert.match(repair, /refresh_map_editor_data/);
  assert.match(repair, /_lastData = null;[\s\S]{0,160}_lastFullMapData = null;/);
});

test('1.2.29 overview refresh button requests hard map cache invalidation', () => {
  const s = fs.readFileSync(path.join(root, 'widgets/overview/public/dashboard.js'), 'utf8');
  assert.match(s, /map-snapshot\?refresh=1&hard=1/);
});

test('1.2.29 backend hard refresh invalidates parser/fallback caches and forces targeted MAP batch', () => {
  const s = fs.readFileSync(path.join(root, 'drivers/mower/device.js'), 'utf8');
  assert.match(s, /async refreshMapData\(options = \{\}\)/);
  assert.match(s, /this\._cachedMAPI = null;/);
  assert.match(s, /this\._lastMapStr = '';/);
  assert.match(s, /this\._lastRawData = null;/);
  assert.match(s, /hard \|\| nativeVerificationPending/);
  assert.match(s, /manual-hard-refresh/);
  assert.match(s, /_purgeStaleOrphanPylonRules\('manual-hard-refresh'\)/);
});

test('1.2.29 map API forwards explicit hard refresh to the device', async () => {
  const api = require('../widgets/map/api');
  let options = null;
  const device = {
    getId: () => 'dev1',
    getData: () => ({id:'native1'}),
    getMapData: async () => ({cached:true}),
    refreshMapData: async (o) => { options = o; return {fresh:true}; },
  };
  const homey = { drivers: { getDrivers: () => ({ mower: { getDevices: () => [device] } }) } };
  const result = await api.getMapData({homey, query:{deviceId:'dev1', refresh:'1', hard:'1'}});
  assert.deepEqual(options, {hard:true});
  assert.deepEqual(result, {fresh:true});
});
