'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');

test('v193 keeps HTTP/file TLS strict and scopes the 1.1.65 MQTT compatibility exception',()=>{
  const api=read('lib/MovaApi.js');
  const dev=read('drivers/mower/device.js');
  assert.equal(/rejectUnauthorized\s*:\s*false/.test(api),false);
  assert.ok((api.match(/rejectUnauthorized\s*:\s*true/g)||[]).length>=2);
  const mqttStart=dev.indexOf('  _connectMqtt()');
  const mqttEnd=dev.indexOf('  async _reconnectMqttWithFreshToken',mqttStart);
  assert.ok(mqttStart>=0 && mqttEnd>mqttStart);
  const mqtt=dev.slice(mqttStart,mqttEnd);
  assert.equal((mqtt.match(/rejectUnauthorized\s*:\s*false/g)||[]).length,1);
  const outside=dev.slice(0,mqttStart)+dev.slice(mqttEnd);
  assert.equal(/rejectUnauthorized\s*:\s*false/.test(outside),false);
});

test('v184 release has no legacy external identity handoff runtime path',()=>{
  assert.equal(fs.existsSync(path.join(root,'lib/video/IdentityHandoff.js')),false);
  const video=read('lib/video/DreameStandaloneVideo.js');
  for(const term of ['fetchIdentity','importIdentityFromCompanionUrl','nodelab_saved_tx_identity_v871','video_tx_local_identity']) {
    assert.equal(video.includes(term),false,term);
  }
});

test('v184 release keeps device-local map editor independent of dashboard widget',()=>{
  const driver=read('drivers/mower/driver.js');
  const compose=read('drivers/mower/driver.compose.json');
  assert.ok(driver.includes("setHandler('get_map_editor_data'"));
  assert.ok(driver.includes("setHandler('save_map_editor_markers'"));
  assert.ok(compose.includes('map_editor'));
});
