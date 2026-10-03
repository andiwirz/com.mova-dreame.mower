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

test('1.2.17 pylon protection writes a type-2 square with side length 2x selected radius', () => {
  const api = read('lib/MovaApi.js');
  const device = read('drivers/mower/device.js');
  assert.match(api, /setForbiddenPolygon\(/);
  assert.match(api, /d:\s*\{\s*id,\s*type:\s*2,\s*points,\s*radius:\s*0\s*\}/);
  assert.match(device, /const halfM = radiusCm \/ 100/);
  assert.match(device, /nativeWriteVersion:\s*(4|5|6)/);
  assert.match(device, /map_edit_polygon_square_m/);
});

test('1.2.17 native square matcher accepts edit-frame metres and rejects displaced polygons', () => {
  const d = Object.create(Device.prototype);
  const pylon = { x: -5547, y: -2283 };
  const good = { type: 2, points: [[-6.047,-2.783],[-5.047,-2.783],[-5.047,-1.783],[-6.047,-1.783]] };
  const bad = { type: 2, points: [[-5.5,-2.0],[-4.5,-2.0],[-4.5,-1.0],[-5.5,-1.0]] };
  assert.equal(d._nativeSquareMatchesPylon(good, pylon, 500), true);
  assert.equal(d._nativeSquareMatchesPylon(bad, pylon, 500), false);
});

test('external SETTINGS steeringMode is observed without driving the live picker before PRE[19] readback', async () => {
  const d = Object.create(Device.prototype);
  const capWrites = [];
  const settingWrites = [];
  d._activeMapIndex = 0;
  d._nativePreferenceDiagSignature = null;
  d._cuttingHeightWriteTs = 0;
  d.setSettings = async value => settingWrites.push(structuredClone(value));
  d.setStoreValue = async () => {};
  d.hasCapability = cap => cap === 'turning_method';
  d._setCap = async (cap, value) => capWrites.push([cap, value]);
  d.log = () => {};
  d.error = () => {};
  d._buildPREFromSettings = () => null;
  await d._applyMOVASettings({
    'SETTINGS.0': JSON.stringify([{ settings: { '0': { steeringMode: 1 } } }]),
  });
  assert.equal(capWrites.length, 0);
  assert.equal(d._lastSettingsSteeringMode, 1);
  assert.equal(settingWrites.length, 0);
});

test('1.2.17 total overview map footer uses the discreet single-map style', () => {
  const css = read('widgets/overview/public/style.css');
  assert.match(css, /\.overview-map-footer\{[^}]*background:#fff/);
  assert.match(css, /\.overview-map-action\{[^}]*background:none/);
  assert.match(css, /\.map-static\{[^}]*border-radius:12px 12px 0 0/);
});
