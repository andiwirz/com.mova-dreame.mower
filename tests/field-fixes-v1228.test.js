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
  'drivers/mower/repair/map_editor.html',
];

test('1.2.40 supersedes 1.2.28: UI pending remains until native geometry confirms', () => {
  const d = Object.create(Device.prototype);
  const now = 1_000_000;
  let ui = d._pylonUiState({pending:'create',updatedAt:now-4_999}, now);
  assert.equal(ui.uiPending, true);
  assert.equal(ui.optimistic, false);
  ui = d._pylonUiState({pending:'create',updatedAt:now-5_000}, now);
  assert.equal(ui.uiPending, true);
  assert.equal(ui.optimistic, false);
  assert.equal(ui.pending, true, 'native verification must remain visibly pending');
});

test('1.2.40 pending create never manufactures an optimistic red native square', () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {
    'obs:2': { mapIndex:0, pending:'create', updatedAt:Date.now()-6000, centerX:1000, centerY:2000, radius:500, nativeCandidateId:102 },
  };
  const raw = { forbiddenAreas:[[101,{shapeType:2,path:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]}]], mowingAreas:[[1,{path:[]}]] };
  const display = d._mapDataForDisplay(raw);
  assert.equal(raw.forbiddenAreas.length, 1, 'raw verification map must remain untouched');
  assert.equal(display.forbiddenAreas.length, 1);
  assert.deepEqual(display.forbiddenAreas, raw.forbiddenAreas);
});

test('1.2.40 pending delete keeps the real red native zone visible until confirmation', () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  const raw = { forbiddenAreas:[[101,{}],[102,{}]], mowingAreas:[[1,{path:[]}]] };
  d._obstacleRulesCache = {
    'obs:2': { mapIndex:0, pending:'delete', updatedAt:Date.now()-4000, nativeId:102, pendingDeleteIds:[102] },
  };
  assert.deepEqual(d._mapDataForDisplay(raw).forbiddenAreas.map(e=>e[0]), [101,102]);
  d._obstacleRulesCache['obs:2'].updatedAt = Date.now()-6000;
  assert.deepEqual(d._mapDataForDisplay(raw).forbiddenAreas.map(e=>e[0]), [101,102]);
  assert.deepEqual(raw.forbiddenAreas.map(e=>e[0]), [101,102]);
});

test('1.2.40 editors keep blue pending animation for the full backend pending lifetime', () => {
  for (const file of editors) {
    const s = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(s, /var rawPendingRule = py\.rule && py\.rule\.pending;/, file);
    assert.match(s, /var pendingRule = rawPendingRule \|\| null;/, file);
    assert.match(s, /pendingRule === 'create'/, file);
    assert.match(s, /!rawPendingRule && !\(py\.rule && py\.rule\.nativeId != null\)/, file);
  }
});

test('1.2.40 verifier has dense checkpoints plus persistent read-only rechecks without optimistic UI switch', () => {
  const s = fs.readFileSync(path.join(root, 'drivers/mower/device.js'), 'utf8');
  assert.match(s, /const PYLON_PENDING_RECHECK_MS = 120_000;/);
  assert.match(s, /persistent geometry readback/);
  assert.doesNotMatch(s, /optimistic map projection active/);
  assert.match(s, /pylonUiRevision: Number\(this\._pylonUiRevision \|\| 0\)/);
});

test('1.2.28 pylon UI revision invalidates each in-page map cache like a clean reopen', () => {
  for (const file of editors) {
    const s = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(s, /var _lastPylonUiRevision = -1;/, file);
    assert.match(s, /incomingPylonRevision !== _lastPylonUiRevision/, file);
    assert.match(s, /_lastData = null;[\s\S]{0,120}_lastFullMapData = null;/, file);
  }
});
