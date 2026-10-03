'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = p => fs.readFileSync(p, 'utf8');

test('1.2.15 pylon UI enforces manufacturer minimum one-metre diameter everywhere', () => {
  for (const file of [
    'widgets/map/public/index.html',
    'widgets/overview/public/map-editor.html',
    'drivers/mower/repair/map_editor.html',
  ]) {
    const src = read(file);
    assert.match(src, /id="pylon-radius" type="number" min="50" max="300"/, file);
    assert.match(src, /radiusCm < 50 \|\| radiusCm > 300/, file);
    assert.doesNotMatch(src, /radiusCm < 15/);
  }
  const device = read('drivers/mower/device.js');
  assert.match(device, /Radius muss zwischen 50 und 300 cm liegen \(mindestens 1 m Durchmesser\)/);
});

test('1.2.15 pylon create/delete use transactional native map editing and metre edit frame', () => {
  const api = read('lib/MovaApi.js');
  const device = read('drivers/mower/device.js');
  assert.match(api, /o: 200, d: \{ idx \}/);
  assert.match(api, /o: 204/);
  assert.match(api, /o: 201/);
  assert.match(api, /o: 215/);
  assert.match(api, /o: 218, d: \{ id, type: 0 \}/);
  assert.match(device, /Math\.round\(pylon\.x\) \/ 1000/);
  assert.match(device, /radiusCm \/ 100/);
  assert.match(device, /direct_m_x1000/);
});

test('1.2.15 turning method is PRE19 plus SETTINGS steeringMode, not CFG.PROT', () => {
  const api = read('lib/MovaApi.js');
  const device = read('drivers/mower/device.js');
  assert.match(api, /async getPRE\(/);
  assert.match(api, /writeSETTINGSField\(/);
  assert.match(device, /next\[19\] = targetMode/);
  assert.match(device, /'steeringMode', targetMode/);
  assert.match(device, /s\.steeringMode/);
  const turningBlock = device.slice(device.indexOf("if (changedKeys.includes('map_safe_turning'))"), device.indexOf('// AI obstacle photo capture'));
  assert.doesNotMatch(turningBlock, /PROT/);
});

test('1.2.15 overview inline editor has explicit child-ready handshake plus bounded init retries', () => {
  const parent = read('widgets/overview/public/dashboard.js');
  const child = read('widgets/overview/public/map-editor.html');
  assert.match(parent, /message\.type==='bridge-ready'/);
  assert.match(parent, /120/);
  assert.match(parent, /500/);
  assert.match(parent, /sendLegacyInit|sendInit/);
  assert.match(child, /type: 'bridge-ready'/);
  assert.match(child, /initializeOverviewEditor/);
});

test('1.2.47 camera widget exposes only the tokenized local FLV video diagnostic', () => {
  const api = read('lib/widgets/MowerDashboard.js');
  const html = read('widgets/camera/public/index.html');
  const js = read('widgets/camera/public/dashboard.js');
  assert.match(api, /action === 'flv_url'/);
  assert.match(html, /id="flvDiagBtn"/);
  assert.match(html, /id="flvUrl"/);
  assert.match(js, /showFlvDiagnosticUrl/);
  assert.doesNotMatch(api, /audio_diagnostic|audio_probe|audio_enable|audio_stream_url|aac_url/);
  assert.doesNotMatch(html, /audioToggle|audioTestBtn|aacDiagBtn/);
  assert.doesNotMatch(js, /AudioDecoder|audioCursor|aac_url|audio_enable/);
  assert.doesNotMatch(api, /log\([^)]*flv_url/i);
});
