'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = rel => JSON.parse(read(rel));
const { renderMapPng } = require('../lib/widgets/MapPngRenderer');

test('1.2.0 version metadata and changelog are aligned', () => {
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  const app = json('app.json');
  const compose = json('.homeycompose/app.json');
  const changelog = json('.homeychangelog.json');
  assert.equal(pkg.version, '1.2.0');
  assert.equal(lock.version, '1.2.0');
  assert.equal(lock.packages[''].version, '1.2.0');
  assert.equal(app.version, '1.2.0');
  assert.equal(compose.version, '1.2.0');
  assert.ok(changelog['1.2.0']?.en);
  assert.ok(changelog['1.2.0']?.de);
  assert.deepEqual(app.changelog['1.2.0'], changelog['1.2.0']);
  assert.deepEqual(compose.changelog['1.2.0'], changelog['1.2.0']);
});

test('1.2.0 Total Overview hides the complete gate section unless Garage Mode is enabled', () => {
  const html = read('widgets/overview/public/index.html');
  const js = read('widgets/overview/public/dashboard.js');
  assert.match(html, /<section id="garageSection" hidden>/);
  assert.match(js, /\$\('garageSection'\)\.hidden=!r\.garageEnabled/);
  assert.match(html, /data-action="gate_open"/);
  assert.match(html, /data-action="gate_close"/);
});

test('1.2.0 maintenance point remains independent of Garage Mode in all interactive map editors', () => {
  for (const rel of [
    'widgets/map/public/index.html',
    'widgets/overview/public/map-editor.html',
    'drivers/mower/repair/map_editor.html',
  ]) {
    const src = read(rel);
    assert.match(src, /showMaintenancePoint = s\.show_maintenance_point !== false && \(!data\.overlayVisibility \|\| data\.overlayVisibility\.showMaintenancePoint !== false\)/, rel);
    assert.doesNotMatch(src, /showMaintenancePoint = !!\(data\.overlayVisibility && data\.overlayVisibility\.garageMode\)/, rel);
    assert.match(src, /hasPylons = Array\.isArray\(displayData\.obstaclePylons\)/, rel);
    assert.match(src, /\(!garageActive && !hasPylons\)/, rel);
  }
});

test('1.2.0 map payload keeps maintenance visibility independent of Garage Mode', () => {
  const src = read('drivers/mower/device.js');
  assert.match(src, /const showMaintenancePoint = this\.getSetting\('map_show_maintenance_point'\) !== false;/);
  assert.doesNotMatch(src, /const showMaintenancePoint = garageMode &&/);
  assert.match(src, /showMaintenancePoint,\s*showGarageOverlay,\s*garageMode,/);
});

test('1.2.0 static overview map hides garage geometry while retaining maintenance point and pylons', () => {
  const base = {
    boundary: { x1: 0, y1: 0, x2: 5000, y2: 4000 },
    mowingAreas: [[1, { path: [
      { x: 100, y: 100 }, { x: 4900, y: 100 }, { x: 4900, y: 3900 }, { x: 100, y: 3900 },
    ] }]],
    robotPos: { x: 3000, y: 2200 },
    obstaclePylons: [{ id: 'p1', x: 2400, y: 1800, rule: { action: 'observe', radius: 500 } }],
  };
  const off = {
    ...base,
    chargerPos: { x: -2200, y: -1800 },
    garageOverlay: {
      lineA: { x: -1800, y: -1000 },
      lineB: { x: -700, y: -1000 },
      dangerCenter: { x: -1300, y: -1500 },
      dangerRadius: 900,
      cautionRadius: 1400,
      maintenancePoint: { x: -2600, y: -2500 },
    },
    overlayVisibility: { garageMode: false, showGarageOverlay: false, showMaintenancePoint: true },
  };
  const maintenanceOnly = {
    ...base,
    garageOverlay: { maintenancePoint: { x: -2600, y: -2500 } },
    overlayVisibility: { garageMode: false, showGarageOverlay: false, showMaintenancePoint: true },
  };
  assert.deepEqual(renderMapPng(off), renderMapPng(maintenanceOnly), 'disabled Garage Mode must remove line/danger/charger geometry but keep maintenance point');

  const maintenanceHidden = {
    ...maintenanceOnly,
    overlayVisibility: { garageMode: false, showGarageOverlay: false, showMaintenancePoint: false },
  };
  assert.notDeepEqual(renderMapPng(maintenanceOnly), renderMapPng(maintenanceHidden), 'maintenance point remains independently visible when enabled');

  const noPylon = { ...maintenanceOnly, obstaclePylons: [] };
  assert.notDeepEqual(renderMapPng(maintenanceOnly), renderMapPng(noPylon), 'pylons remain visible when Garage Mode is disabled');
});
