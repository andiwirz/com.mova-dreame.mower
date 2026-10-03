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

test('1.2.22 map-edit waiter accepts matching status=false TASK acknowledgements used by A2 edit opcodes', async () => {
  const d = Object.create(Device.prototype);
  d.homey = { setTimeout, clearTimeout };
  const after = Date.now();
  const pending = d._waitForMapEditTask(215, after, 250);
  d._noteMapEditTask({ t:'TASK', d:{ exe:true, o:215, status:false } });
  const value = await pending;
  assert.equal(value.d.o, 215);
  assert.equal(value.d.status, false);
});

test('1.2.22 current pylon write publishes pending cache before bounded verification and clears stale timeout markers', () => {
  const src = read('drivers/mower/device.js');
  assert.match(src, /nativeWriteVersion:\s*(5|6)/);
  assert.match(src, /nativeWriteProtocol:\s*'map_edit_polygon_square_m_task_serialized(?:_map_readback)?'/);
  assert.match(src, /verification:\s*null, verificationAt:\s*null, mapRevisionBefore,/);
  assert.match(src, /Publish the new pending state before any delayed verifier is armed[\s\S]{0,350}this\._obstacleRulesCache = rules;[\s\S]{0,200}setStoreValue\('obstacle_rules_v1'/);
  assert.match(src, /const deadlines = \[2000, 5000, 15000, 35000, 75000, 120000, 150000, 180000,[\s\S]{0,80}210000, 240000, 270000, 300000, 330000, 360000, 420000, PYLON_PENDING_TIMEOUT_MS\]/);
});

test('1.2.22 reload countdown can be cancelled, while explicit pylon Save has no countdown', () => {
  for (const file of ['drivers/mower/repair/map_editor.html','widgets/map/public/index.html','widgets/overview/public/map-editor.html']) {
    const html = read(file);
    const reloadStart = html.indexOf('function reloadSelectedPylon()');
    const saveStart = html.indexOf('function savePylonRule(mode)', reloadStart);
    const reload = html.slice(reloadStart, saveStart);
    const entry = html.indexOf('// ── Entry point', saveStart);
    const save = html.slice(saveStart, entry >= 0 ? entry : html.length);
    assert.match(reload, /startPylonAutoClose\(feedback\.textContent\)/, file);
    assert.match(html, /_pylonCloseRemaining = 10/, file);
    assert.match(html, /Der automatische Countdown wurde abgebrochen/, file);
    assert.match(save, /finishPylonEditorAfterSave\(\)/, file);
    assert.doesNotMatch(save, /startPylonAutoClose\(/, file);
  }
});
