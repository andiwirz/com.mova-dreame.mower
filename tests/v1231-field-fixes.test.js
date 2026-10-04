'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('v1231 all mowing modes use central outside/maintenance start classification', () => {
  const device = read('drivers/mower/device.js');
  const garage = read('lib/garage/GarageSafetyEngine.js');
  assert.doesNotMatch(device, /start_blocked_not_securely_home/);
  assert.match(garage, /_freshOutsideStartProof\(\)/);
  assert.match(garage, /_reconfirmMaintenanceForStart\(source, token\)/);
  assert.match(garage, /start_reconfirm_maintenance/);
  assert.match(garage, /_startDirectlyOutside\(source, fn, token/);
  assert.match(garage, /start_blocked_position_unconfirmed/);
  for (const source of ['button_start_spot','flow_start_edge','flow_start_zone','flow_start_spot','flow_start_border']) {
    assert.match(device, new RegExp(`startRequested\\('${source}`));
  }
});

test('v1231 map editors keep the SVG stable during edit and own touch input', () => {
  for (const file of ['widgets/map/public/index.html','widgets/overview/public/map-editor.html','drivers/mower/repair/map_editor.html']) {
    const html=read(file);
    assert.match(html, /#map-wrap\.editing, #map-wrap\.editing svg \{ touch-action:none; \}/);
    assert.match(html, /classList\.toggle\('editing', _editMode\)/);
    assert.match(html, /if \(!_dragMarker && !_editMode\) renderMap\(\);/);
    assert.match(html, /_lastPylonOpenAt/);
    assert.match(html, /svg\.editing \[data-pylon-id\] \{ cursor:pointer; touch-action:none; pointer-events:all; \}/);
  }
});
