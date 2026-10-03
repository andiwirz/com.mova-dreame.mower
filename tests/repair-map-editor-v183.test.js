'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('repair flow exposes menu, map editor and re-auth views', () => {
  const driver = JSON.parse(read('drivers/mower/driver.compose.json'));
  assert.deepEqual(driver.repair.map(v => v.id), ['repair', 'map_editor', 'reauth']);
  assert.match(read('drivers/mower/repair/repair.html'), /Homey\.showView\('map_editor'\)/);
  assert.match(read('drivers/mower/repair/repair.html'), /Homey\.showView\('reauth'\)/);
});

test('map editor is device-local and does not depend on widget APIs', () => {
  const html = read('drivers/mower/repair/map_editor.html');
  assert.match(html, /get_map_editor_data/);
  assert.match(html, /save_map_editor_markers/);
  assert.match(html, /save_map_obstacle_rule/);
  assert.doesNotMatch(html, /Homey\.getDeviceIds\(/);
  assert.doesNotMatch(html, /_homey\.api\(/);
  assert.match(html, /data-edit-marker="line/);
  assert.match(html, /data-edit-marker="dangerCenter"/);
  assert.match(html, /data-edit-marker="maintenancePoint"/);
});

test('repair driver routes map editor to existing persistent device methods', () => {
  const js = read('drivers/mower/driver.js');
  assert.match(js, /session\.setHandler\('get_map_editor_data'/);
  assert.match(js, /device\.getMapData\(\)/);
  assert.match(js, /session\.setHandler\('save_map_editor_markers'/);
  assert.match(js, /device\.updateGarageOverlayMarkers/);
  assert.match(js, /session\.setHandler\('save_map_obstacle_rule'/);
  assert.match(js, /device\.updateObstacleRule/);
});
