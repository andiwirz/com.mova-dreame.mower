'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const read = p => fs.readFileSync(p, 'utf8');

test('1.2.21 restores Wendemodus as the native device picker without an Advanced Settings duplicate', () => {
  const compose = JSON.parse(read('drivers/mower/driver.compose.json'));
  const cap = JSON.parse(read('.homeycompose/capabilities/turning_method.json'));
  const device = read('drivers/mower/device.js');
  assert.ok(compose.capabilities.includes('turning_method'));
  assert.ok(!compose.capabilities.includes('lawn_care_mode'));
  assert.equal(cap.type, 'enum');
  assert.equal(cap.uiComponent, 'picker');
  assert.equal(cap.title.de, 'Wendemodus');
  assert.match(device, /capabilities_migrated_v34_turning_picker/);
  assert.match(device, /'lawn_care_mode'/);
  assert.doesNotMatch(read('drivers/mower/driver.compose.json'), /map_safe_turning/);
});

test('1.2.21 static Totalübersicht defines the pending-ring CSS so it cannot fall back to a black filled circle', () => {
  const css = read('widgets/overview/public/style.css');
  assert.match(css, /\.map-static \.pylon-pending-ring\{[^}]*fill:none[^}]*stroke:#42a5f5/);
  assert.match(css, /@keyframes pylon-pending-dash/);
});

test('1.2.22 pylon reload uses cancellable auto-close while explicit Save closes immediately', () => {
  for (const file of ['drivers/mower/repair/map_editor.html','widgets/map/public/index.html','widgets/overview/public/map-editor.html']) {
    const html = read(file);
    const reloadStart = html.indexOf('function reloadSelectedPylon()');
    const saveStart = html.indexOf('function savePylonRule(mode)', reloadStart);
    const reload = html.slice(reloadStart, saveStart);
    const saveEnd = html.indexOf('// ── Entry point', saveStart);
    const save = html.slice(saveStart, saveEnd >= 0 ? saveEnd : html.length);
    assert.match(reload, /_pylonReloadDone/);
    assert.match(reload, /Karte neu geladen ✓/);
    assert.match(reload, /startPylonAutoClose\(feedback\.textContent\)/);
    assert.match(html, /_pylonCloseRemaining = 10/);
    assert.match(html, /id="pylon-hold"/);
    assert.match(html, /Fenster bleibt geöffnet/);
    assert.match(save, /finishPylonEditorAfterSave\(\)/);
    assert.doesNotMatch(save, /startPylonAutoClose\(/);
  }
});

test('1.2.21 Totalübersicht edit footer is a separate tile footer instead of transparent controls over the map', () => {
  const html = read('widgets/overview/public/map-editor.html');
  assert.match(html, /#footer \{[\s\S]*?background: #fff;[\s\S]*?border-top:/);
  assert.match(html, /min-height: 34px/);
  assert.match(html, /@media\(prefers-color-scheme:dark\)\{#footer\{background:#1c2720/);
});
