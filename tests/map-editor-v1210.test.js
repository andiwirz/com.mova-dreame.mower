'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = p => fs.readFileSync(p, 'utf8');

test('v1214 overview uses the same compact map editor inline instead of a full-screen overlay', () => {
  const html = read('widgets/overview/public/index.html');
  const css = read('widgets/overview/public/style.css');
  const js = read('widgets/overview/public/dashboard.js');
  assert.match(html, /overview-map-footer/);
  assert.match(html, /id="overviewMapEdit"[^>]*>Edit</);
  assert.match(html, /id="overviewMapRefresh"/);
  assert.match(html, /id="overviewMapInline" class="map-editor-inline" hidden/);
  assert.doesNotMatch(html, /overviewMapEditor|map-editor-pane|Mähkarte bearbeiten/);
  assert.doesNotMatch(css, /\.map-editor-pane\{position:fixed;inset:0/);
  assert.match(css, /\.map-editor-inline\{width:100%;height:300px/);
  assert.match(js, /staticMap\.hidden=true;footer\.hidden=true;host\.hidden=false/);
  assert.match(js, /frame\.src='map-editor\.html\?_='\+Date\.now\(\)/);
  assert.match(js, /message\.type==='height'/);
  assert.match(js, /refreshMap\(true\)/);
});

test('v1210 all map editors expose native reload and larger pylon hit target', () => {
  for (const file of ['widgets/map/public/index.html','widgets/overview/public/map-editor.html','drivers/mower/repair/map_editor.html']) {
    const s = read(file);
    assert.match(s, /id="pylon-reload"[^>]*>Karte neu laden \/ prüfen</, file);
    assert.match(s, /data-pylon-id=/, file);
    assert.match(s, /pr \* 2\.55/, file);
    assert.match(s, /pylon-pending-ring/, file);
    assert.match(s, /Date\.now\(\) - tap\.at < 900/, file);
    assert.match(s, /pointer-events="none">!<\/text>/, file);
    assert.match(s, /Bestätigung (?:läuft im Hintergrund weiter|vom Mäher steht noch aus)|Kartenbestätigung steht noch aus/, file);
  }
});

test('v1210 force refresh bypasses cached map in widget and repair editor', () => {
  const api = read('widgets/map/api.js');
  const driver = read('drivers/mower/driver.js');
  const device = read('drivers/mower/device.js');
  assert.match(api, /query\?\.refresh/);
  assert.match(api, /device\.refreshMapData\(/);
  assert.match(driver, /refresh_map_editor_data/);
  assert.match(device, /async refreshMapData\(/);
  assert.match(device, /forced native refresh requested/);
});

test('v1210 compiled overview manifest exposes map snapshot route', () => {
  const app = JSON.parse(read('app.json'));
  assert.deepEqual(app.widgets.overview.api.getMapSnapshot, { method:'GET', path:'/map-snapshot' });
});
