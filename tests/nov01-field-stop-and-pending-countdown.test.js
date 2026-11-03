"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('map widget and repair editor both auto-close an accepted pending create/delete without falsely marking it confirmed', () => {
  for (const file of ['widgets/map/public/index.html', 'drivers/mower/repair/map_editor.html', 'widgets/overview/public/map-editor.html']) {
    const html = read(file);
    assert.match(html, /if \(nativePending\) \{[\s\S]*?startPylonAutoClose\('Änderung angenommen – native Bestätigung steht noch aus/);
    assert.match(html, /var optimisticRule = Object\.assign\(\{\}, previousRule, \{[\s\S]*?pending: mode === 'save' \? 'create' : 'delete'/);
    assert.match(html, /pendingDeletes\.push\(\{ nativeId:selectedNativeId, pending:'delete'/);
    assert.match(html, /\.pylon-pending-zone\s*\{/);
    assert.match(html, /function startPylonAutoClose\(message\)[\s\S]*?setInterval/);
    assert.match(html, /\.catch\(function\(err\)[\s\S]*?report\(\(err &&/);
  }
});

test('return zone STOP can be reasserted once, but only native IDLE may permit map edit', () => {
  const source = read('lib/garage/GarageSafetyEngine.js');
  const segment = source.slice(source.indexOf('async _prepareReturnZoneCheckpoint('));
  assert.match(segment, /let stopReasserted=false/);
  assert.match(segment, /!stopReasserted && current\(\)/);
  assert.match(segment, /Date\.now\(\) - stopAcceptedAt >= 3500/);
  assert.match(segment, /Date\.now\(\) < deadlineAt - 6500/);
  assert.match(segment, /stopReasserted=true/);
  assert.match(segment, /return_zone_stop_task_retry/);
  assert.match(segment, /if \(Number\(status\?\.value\)!==2\)/);
  assert.match(segment, /if \(!taskEnded\) \{ audit\('stop_not_confirmed_fallback'\)/);
});
