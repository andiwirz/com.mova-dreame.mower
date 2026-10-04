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

const editorFiles = [
  'drivers/mower/repair/map_editor.html',
  'widgets/map/public/index.html',
  'widgets/overview/public/map-editor.html',
];

test('current pylon verification window covers measured multi-minute MAP propagation with bounded late checks', () => {
  const src = read('drivers/mower/device.js');
  assert.match(src, /const PYLON_PENDING_TIMEOUT_MS = 480_000;/);
  assert.match(src, /const deadlines = \[2000, 5000, 15000, 35000, 75000, 120000, 150000, 180000,[\s\S]{0,80}210000, 240000, 270000, 300000, 330000, 360000, 420000, PYLON_PENDING_TIMEOUT_MS\]/);
  assert.match(src, /square accepted; native readback pending/);
  assert.match(src, /return \{ ok: true, id, rule: rules\[id\], pending: true \};/);
});

test('1.2.24 map editors show animated optimistic blue pending state immediately after Save/Delete', () => {
  for (const file of editorFiles) {
    const html = read(file);
    assert.match(html, /pylon-pending-ring[\s\S]{0,250}pylon-pending-pulse/, file);
    assert.match(html, /pending:\s*mode === 'save' \? 'create' : 'delete'/, file);
    assert.match(html, /renderMap\(\);[\s\S]{0,500}native Bestätigung läuft im Hintergrund/, file);
    assert.match(html, /previousRule[\s\S]{0,1600}rollbackLive/, file);
  }
});

test('1.2.24 late MAP publication is adopted and makes an existing Homey zone deletable', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {
    'obs:1': {
      action: 'observe', radius: 500, mapIndex: 0,
      nativeWriteVersion: 6, nativeCandidateId: 104,
      pending: null, verification: 'native_create_unconfirmed_timeout',
    },
  };
  d._cachedMapData = { forbiddenAreas: [] };
  d._buildObstaclePylons = () => [{ id:'obs:1', x:-1674, y:-269, rule:d._obstacleRulesCache['obs:1'] }];
  d._nativeForbiddenShape = () => 2;
  d._nativePylonZoneMatches = (_area, _pylon, rule) => Number(rule.radius) === 500;
  d.log = () => {};
  let stored = false;
  d.setStoreValue = async () => { stored = true; };
  await d._reconcilePylonNativeRules({ forbiddenAreas:[[104,{ type:2, shapeType:2, path:[[0,0],[1,0],[1,1],[0,1]] }]] });
  assert.equal(d._obstacleRulesCache['obs:1'].nativeId, 104);
  assert.equal(d._obstacleRulesCache['obs:1'].pending, null);
  assert.equal(d._obstacleRulesCache['obs:1'].action, 'avoid');
  assert.equal(d._obstacleRulesCache['obs:1'].verification, 'native_late_create_adopted');
  assert.equal(stored, true);
});

test('1.2.24 delete recovery prefers exact TASK candidate / managed geometry and UI enables Delete for nativeId', () => {
  const src = read('drivers/mower/device.js');
  assert.match(src, /recovered late native ownership for delete/);
  assert.match(src, /nativeMatchIds:/);
  assert.match(src, /const candidateId = Number\(previous\.nativeCandidateId\)/);
  for (const file of editorFiles) {
    const html = read(file);
    assert.match(html, /var owned = p\.rule && p\.rule\.nativeId != null/);
    assert.match(html, /pylon-delete-zone'\)\.disabled = !owned \|\| !!pending/);
  }
});
