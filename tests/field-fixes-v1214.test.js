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

test('1.2.14 momentary command clears its Homey boolean before slow position refresh', async () => {
  const d = Object.create(Device.prototype);
  const events = [];
  d._momentButtonLocks = new Map();
  d.hasCapability = () => true;
  d.setCapabilityValue = async (_cap, value) => { events.push(['value', value]); };
  d.homey = { setTimeout: (fn) => { events.push(['timer']); return 1; }, clearTimeout: () => {} };
  d._refreshPositionBeforeGarageCommand = async () => { events.push(['refresh']); };
  d._commandUnavailableReason = () => null;
  d._commandLockFromCapability = () => 'pause';
  d._resetConflictingButtons = async () => {};
  d.log = () => {};
  d._garageSafety = null;
  const ok = await d._momentButtonPressed('cmd_pause', 'pause', 30000);
  assert.equal(ok, true);
  assert.deepEqual(events[0], ['value', false], 'button is released before any await-heavy refresh');
  assert.ok(events.findIndex(e => e[0] === 'refresh') > 0);
});

test('1.2.14 total overview editor is inline and relays the standalone editor height', () => {
  const html = read('widgets/overview/public/index.html');
  const js = read('widgets/overview/public/dashboard.js');
  const child = read('widgets/overview/public/map-editor.html');
  assert.match(html, /id="overviewMapInline" class="map-editor-inline" hidden/);
  assert.doesNotMatch(html, /map-editor-pane|Mähkarte bearbeiten/);
  assert.match(js, /staticMap\.hidden=true;footer\.hidden=true;host\.hidden=false/);
  assert.match(js, /mapEditing=true;\s*clearTimeout\(mapTimer\)/);
  assert.match(js, /document\.hidden\|\|!inView\|\|mapEditing/);
  assert.match(js, /message\.type==='height'/);
  assert.match(child, /type: 'height', height: height/);
});

test('1.2.14 outbound phase text and evidence threshold consistently say four mowing samples', () => {
  const src = read('lib/garage/GarageSafetyEngine.js');
  assert.doesNotMatch(src, /drei sauberen Mähstatus/);
  assert.doesNotMatch(src, /THREE CONSECUTIVE effective mowing/);
  assert.match(src, /four consecutive filtered native MOWING/);
  assert.match(src, /adjusting consistency check/);
  assert.match(src, /positioning consistency check/);
});

test('1.2.14 dock close preserves home state on missing final proof and accepts later station hold proof', () => {
  const src = read('lib/garage/GarageSafetyEngine.js');
  const start = src.indexOf('  _scheduleHomeClose(reason)');
  const end = src.indexOf('  async confirmNativeMaintenanceArrival', start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /_invalidateHomeClose\('final_station_proof_missing'\)/);
  assert.match(body, /remainingStableMs/);
  assert.match(src, /_freshStationHoldProof/);
  assert.match(src, /binary\.chargingLive === true \|\| freshCharging/);
});
