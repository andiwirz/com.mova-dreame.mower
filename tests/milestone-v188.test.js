'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('v193 preserves the native undock milestone while reverting the v188 wrapper to field-tested 1.1.65 parity',()=>{
  const device=read('drivers/mower/device.js');
  const garage=read('lib/garage/GarageSafetyEngine.js');
  assert.match(device,/nativeUndockStarted/);
  assert.doesNotMatch(device,/physicalDockEdge:\s*true/);
  assert.match(device,/mqtt_native_undock_1_1/);
  assert.match(garage,/_stopExternalStartOldTaskEarly/);
  assert.match(garage,/garage_external_start_intent_pause/);
  assert.match(garage,/garage_external_recovery_stop_early/);
  assert.match(garage,/ensureDoorOpen\('external_start'/);
  assert.match(garage,/_recoverExternalStartViaNativeStation/);
  assert.match(garage,/garage_external_recovery_fresh_start/);
  assert.match(garage,/IN_STATION/);
  assert.match(garage,/undocking\)\s*===\s*0/);
});

test('v188 reuses recent verified maintenance arrival for return instead of demanding a new stationary sample',()=>{
  const garage=read('lib/garage/GarageSafetyEngine.js');
  assert.match(garage,/_reuseVerifiedMaintenanceArrivalForReturn/);
  assert.match(garage,/verified maintenance arrival reused for return/);
  assert.match(garage,/return this\._continueReturnFromMaintenance\(source, dockFn, token, false\)/);
});

test('v188 exposes mower notice as Flow trigger and guards setting by garage mode',()=>{
  const card=JSON.parse(read('.homeycompose/flow/triggers/garage_mower_notice.json'));
  assert.equal(card.title.de,'Mäher-/Garagen-Hinweis');
  assert.ok(card.tokens.some(x=>x.name==='kind'));
  assert.ok(card.tokens.some(x=>x.name==='message'));
  const garage=read('lib/garage/GarageSafetyEngine.js');
  const device=read('drivers/mower/device.js');
  assert.match(garage,/_trigger\('garage_mower_notice'/);
  assert.doesNotMatch(garage,/createNotification\(\{ excerpt \}\)/);
  assert.match(device,/garage_mission_push_notifications[\s\S]*garage_mode_enabled/);
});

test('v1247 keeps native Homey proxy and video-only widgets while popup/audio controls stay removed',()=>{
  const video=read('lib/video/DreameStandaloneVideo.js');
  assert.match(video,/createVideoOther\(\)/);
  assert.doesNotMatch(video,/disableWebRTCProxy\s*:\s*true/);
  for(const rel of ['widgets/camera/public/index.html','widgets/overview/public/index.html']){
    const html=read(rel);
    assert.doesNotMatch(html,/id="audioToggle"|id="audioTestBtn"|id="aacDiagBtn"/);
    assert.doesNotMatch(html,/id="fullscreenBtn"/);
  }
  for(const rel of ['widgets/camera/public/dashboard.js','widgets/overview/public/dashboard.js']){
    const js=read(rel);
    assert.match(js,/VideoDecoder/);
    assert.doesNotMatch(js,/AudioDecoder|audioCursor|aac-webcodecs|aac-webaudio/);
    assert.doesNotMatch(js,/H\.popup|Homey\.popup|cameraPopup=1|requestFullscreen/);
  }
});

test('v188 registers map media before lazy live video as best-effort default ordering',()=>{
  const device=read('drivers/mower/device.js');
  assert.ok(device.indexOf('await this._initMapCameraImage()') < device.indexOf('this._standaloneVideo = new DreameStandaloneVideo(this)'));
});
