'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const GarageSafetyEngine=require('../lib/garage/GarageSafetyEngine');

test('v181 departure phases are command-clock driven and positioning has no timeout escape',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  assert.match(src,/originalCommandSentAt \|\| this\._startDoorReleasedAt/);
  assert.match(src,/elapsed < OUTBOUND_EXITING_DISPLAY_MS \+ MIN_ADJUSTING_MS/);
  assert.match(src,/Positionieren intentionally has no timeout/);
  assert.match(src,/_scheduleManualMaintenanceStatusTimers\(\)/);
  assert.match(src,/manual maintenance status timer/);
  assert.doesNotMatch(src,/manual maintenance positioning timeout fallback/);
});

test('v198 mowing shortcut requires four consecutive filtered mowing samples',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  assert.match(src,/mowingStatusHits >= OUTBOUND_NATIVE_MOWING_CONFIRM_HITS/);
  assert.match(src,/out\.mowingStatusHits = 0;/);
  assert.match(src,/four consecutive filtered mowing status samples/);
  assert.match(src,/out\?\.stableMowingConfirmed\) return true/);
});

test('v181 active map refresh follows live telemetry at sub-two-second cadence',()=>{
  const map=read('widgets/map/public/index.html');
  const overview=read('widgets/overview/public/dashboard.js');
  const device=read('drivers/mower/device.js');
  assert.match(map,/_mapMoving \? 1800 : 8000/);
  assert.match(overview,/return activeMapStatuses\.has\(lastOverviewStatus\)\?1800:8000/);
  assert.match(device,/positionUpdatedAt:/);
  assert.match(device,/mowerStatus: displayRuntimeMowerStatus/);
});

test('v185 widget camera reuses canvas, uses faster resilient polling and leaves fullscreen to native device view',()=>{
  for(const rel of ['widgets/overview/public/dashboard.js','widgets/camera/public/dashboard.js']){
    const js=read(rel);
    assert.match(js,/canvasW!==w\|\|canvasH!==h/);
    assert.match(js,/desynchronized:true/);
    assert.match(js,/setTimeout\(\(\)=>frame\(version\),nextDelay\)/);
    assert.match(js,/nextDelay=125/);
    assert.doesNotMatch(js,/requestFullscreen/);
    assert.match(js,/snapshot_error_/);
  }
  for(const rel of ['widgets/overview/public/index.html','widgets/camera/public/index.html']){
    assert.doesNotMatch(read(rel),/id="fullscreenToggle"/);
  }
});

test('v181 exposes a native Homey mowing-map media source without touching the working video source',()=>{
  const device=read('drivers/mower/device.js');
  const video=read('lib/video/DreameStandaloneVideo.js');
  assert.match(device,/setCameraImage\('mower_map', 'Mähkarte', image\)/);
  assert.match(device,/image\.setStream/);
  assert.match(device,/renderMapPng\(await this\.getMapData\(\)\)/);
  assert.match(device,/contentType = 'image\/png'/);
  assert.match(video,/setCameraVideo\('mower_live', 'Live Video', this\.video\)/);
});

test('v181 camera outside-station message is one clear shared Homey error',()=>{
  const src=read('lib/video/HomeyCamera.js');
  assert.match(src,/Livekamera ist nur außerhalb der Ladestation verfügbar/);
  assert.doesNotMatch(src,/Kamera wartet auf frischen Nachweis: Mäher hat die Station verlassen/);
});

test('v198 only four consecutive post-exit native mowing samples can confirm departure',async()=>{
  const e=Object.create(GarageSafetyEngine.prototype);
  e._outbound={mowingSince:null,mowingStatusHits:0,mowingStatusLastAt:0,stableMowingConfirmed:false,stableMowingConfirmedAt:0,released:true,originalCommandSentAt:Date.now()-60000};
  e._missionOutside=false;e._lastOutdoorActivityAt=0;e._manualMaintenanceTransit=false;e._manualMaintenanceCommandAcceptedAt=0;
  e.log=()=>{};e.refreshTileStatus=async()=>{};e._setHomeState=async()=>{};
  assert.equal(await e.observeNativeStatusSample('mowing'),false);
  assert.equal(e._outbound.mowingStatusHits,1);
  assert.equal(await e.observeNativeStatusSample('adjusting'),false);
  assert.equal(e._outbound.mowingStatusHits,0);
  assert.equal(await e.observeNativeStatusSample('mowing'),false);
  e._outbound.mowingStatusLastAt=Date.now()-800;
  assert.equal(await e.observeNativeStatusSample('mowing'),false);
  assert.equal(e._outbound.mowingStatusHits,2);
  e._outbound.mowingStatusLastAt=Date.now()-800;
  assert.equal(await e.observeNativeStatusSample('mowing'),false);
  assert.equal(e._outbound.mowingStatusHits,3);
  e._outbound.mowingStatusLastAt=Date.now()-800;
  assert.equal(await e.observeNativeStatusSample('mowing'),true);
  assert.equal(e._outbound.mowingStatusHits,4);
  assert.equal(e._outbound.stableMowingConfirmed,true);
  assert.ok(e._outbound.stableMowingConfirmedAt>0);
});

test('device feeds filtered native status samples before unchanged-status fast return',()=>{
  const src=read('drivers/mower/device.js');
  const sampleAt=src.indexOf('observeNativeStatusSample(status)');
  const staleFilterAt=src.indexOf('stale native paused ignored during confirmed resume latch');
  const returnAt=src.indexOf("if (status === prev && this.getCapabilityValue('mower_status') === displayStatus) return;");
  assert.ok(sampleAt>staleFilterAt&&returnAt>sampleAt);
});
