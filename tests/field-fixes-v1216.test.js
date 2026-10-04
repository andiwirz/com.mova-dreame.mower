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

test('1.2.16 overview editor prefers direct same-origin parent API adapter', () => {
  const parent = read('widgets/overview/public/dashboard.js');
  const child = read('widgets/overview/public/map-editor.html');
  assert.match(parent, /function directEditorAdapter\(\)/);
  assert.match(parent, /frame\.contentWindow/);
  assert.match(parent, /child\.initializeOverviewEditor/);
  assert.match(parent, /api:\(method,path,body\)=>H\.api\(method,path,body\|\|\{\}\)/);
  assert.match(child, /window\.initializeOverviewEditor\s*=\s*initializeOverviewEditor/);
  // Keep the old bridge only as a compatibility fallback, not as the sole API path.
  assert.match(parent, /bridge-ready/);
});

test('1.2.16 all pylon editors enforce 50 cm minimum and consistent explanation', () => {
  for (const file of [
    'widgets/map/public/index.html',
    'widgets/overview/public/map-editor.html',
    'drivers/mower/repair/map_editor.html',
  ]) {
    const src = read(file);
    assert.match(src, /id="pylon-radius" type="number" min="50" max="300"/, file);
    assert.match(src, /mindestens 1 m Durchmesser/, file);
    assert.doesNotMatch(src, /15 und 300 cm/, file);
  }
});

test('current transactional pylon writes use version 6 TASK-serialized MAP-readback square polygons', () => {
  const src = read('drivers/mower/device.js');
  assert.match(src, /nativeWriteVersion:\s*6/);
  assert.match(src, /nativeWriteProtocol:\s*'map_edit_polygon_square_m_task_serialized_map_readback'/);
});

test('1.2.16 fresh native read releases only legacy unconfirmed pylon pending', async () => {
  const saved = [];
  const logs = [];
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._pendingPylonReadbackTimers = new Map();
  d._buildObstaclePylons = () => [{ id: 'obs:1', x: 1000, y: 2000 }];
  d.setStoreValue = async (_key, value) => saved.push(structuredClone(value));
  d.log = (...args) => logs.push(args.join(' '));
  d.homey = { clearTimeout() {} };
  d._obstacleRulesCache = {
    'obs:1': { action:'observe', radius:500, mapIndex:0, pending:'create', nativeId:null },
  };
  await d._reconcilePylonNativeRules({ forbiddenAreas: [] }, { fresh: false });
  assert.equal(d._obstacleRulesCache['obs:1'].pending, 'create', 'cached/ambiguous read must not clear pending');
  await d._reconcilePylonNativeRules({ forbiddenAreas: [] }, { fresh: true });
  assert.equal(d._obstacleRulesCache['obs:1'].pending, null);
  assert.equal(d._obstacleRulesCache['obs:1'].action, 'observe');
  assert.equal(d._obstacleRulesCache['obs:1'].verification, 'legacy_unconfirmed_cleared');
  assert.ok(saved.length >= 1);
  assert.ok(logs.some(l => l.includes('released legacy pending')));
});

test('fresh native read migrates legacy pending and keeps a recent current square transaction', async () => {
  const saved = [];
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._pendingPylonReadbackTimers = new Map();
  d._buildObstaclePylons = () => [{ id: 'obs:1', x: 1000, y: 2000 }];
  d.setStoreValue = async (_key, value) => { saved.push(structuredClone(value)); };
  d.log = () => {};
  d.homey = { clearTimeout() {} };

  d._obstacleRulesCache = {
    'obs:1': { action:'observe', radius:500, mapIndex:0, pending:'create', nativeId:null, nativeWriteVersion:2 },
  };
  await d._reconcilePylonNativeRules({ forbiddenAreas: [] }, { fresh: true });
  assert.equal(d._obstacleRulesCache['obs:1'].pending, null);
  assert.equal(d._obstacleRulesCache['obs:1'].verification, 'legacy_circle_unconfirmed_cleared');

  d._obstacleRulesCache = {
    'obs:1': { action:'observe', radius:500, mapIndex:0, pending:'create', nativeId:null, nativeWriteVersion:4, updatedAt:Date.now() },
  };
  const before = saved.length;
  await d._reconcilePylonNativeRules({ forbiddenAreas: [] }, { fresh: true });
  assert.equal(d._obstacleRulesCache['obs:1'].pending, 'create');
  assert.equal(d._obstacleRulesCache['obs:1'].nativeWriteVersion, 4);
  assert.equal(saved.length, before, 'current square pending must not be mutated');
});

test('1.2.17 forced map refresh explicitly reconciles with fresh-native semantics', () => {
  const src = read('drivers/mower/device.js');
  assert.match(src, /_reconcilePylonNativeRules\(parsed, \{ fresh: true \}\)/);
});
