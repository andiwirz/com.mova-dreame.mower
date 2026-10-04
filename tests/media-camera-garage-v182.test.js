'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {HomeyCamera}=require('../lib/video/HomeyCamera');
const Engine=require('../lib/garage/GarageSafetyEngine');
const {renderMapPng}=require('../lib/widgets/MapPngRenderer');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('v182 native mowing map is a real PNG and keeps garage safety geometry',()=>{
 const png=renderMapPng({boundary:{x1:0,y1:0,x2:5000,y2:4000},mowingAreas:[[1,{path:[{x:100,y:100},{x:4900,y:100},{x:4900,y:3900},{x:100,y:3900}]}]],overlayVisibility:{garageMode:true},garageOverlay:{lineA:{x:600,y:600},lineB:{x:1900,y:600},dangerCenter:{x:1300,y:1200},dangerRadius:500,cautionRadius:900,maintenancePoint:{x:1600,y:900}},chargerPos:{x:400,y:700},robotPos:{x:3000,y:2200}});
 assert.ok(Buffer.isBuffer(png));assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.ok(png.length>1000);
});

test('v188 native media registers map first as best-effort default, while keeping lazy live video available',()=>{
 const src=read('drivers/mower/device.js');
 assert.ok(src.indexOf('await this._initMapCameraImage();')<src.indexOf('this._standaloneVideo = new DreameStandaloneVideo(this)'));
 assert.match(read('lib/video/HomeyCamera.js'),/session\.release\('device_camera'\)/);
 assert.match(src,/setCameraImage\('mower_map', 'Mähkarte', image\)/);
 assert.match(read('lib/video/DreameStandaloneVideo.js'),/setCameraVideo\('mower_live', 'Live Video', this\.video\)/);
});

test('v185 automatic garage camera preview runtime path is removed',()=>{
 const src=read('lib/video/HomeyCamera.js');
 const overview=read('lib/widgets/MowerDashboard.js');
 assert.doesNotMatch(src,/autoPreviewMode|autoPreviewAllowed/);
 assert.doesNotMatch(overview,/autoPreviewMode|autoPreviewAllowed/);
});

test('v188 optional garage journey setting emits Flow trigger instead of timeline-only notification',async()=>{
 const sent=[];const settings={garage_mission_push_notifications:true,garage_mode_enabled:true};
 const e=Object.create(Engine.prototype);e._lastMissionNotificationKind='';e._lastMissionNotificationAt=0;e.device={getSetting:k=>settings[k]};e.homey={i18n:{getLanguage:()=> 'de'}};e.log=()=>{};e._trigger=(id,reason,extra)=>sent.push({id,reason,...extra});
 e._missionNotification('departure');await Promise.resolve();
 assert.equal(sent.length,1);assert.equal(sent[0].id,'garage_mower_notice');assert.equal(sent[0].kind,'departure');assert.match(sent[0].message,/Mäher Ausfahrt/);
 e._missionNotification('departure');await Promise.resolve();assert.equal(sent.length,1);
 e._missionNotification('return');await Promise.resolve();assert.equal(sent.length,2);assert.equal(sent[1].kind,'return');assert.match(sent[1].message,/Mäher Rückkehr/);
});

test('v185 settings remove garage auto-camera but retain opt-in journey notification',()=>{
 const cfg=JSON.parse(read('drivers/mower/driver.compose.json'));
 const group=cfg.settings.find(g=>g.label?.de==='Live Video');const byId=Object.fromEntries(group.children.map(x=>[x.id,x]));
 assert.equal(byId.video_garage_auto_preview,undefined);
 assert.equal(byId.garage_mission_push_notifications.value,false);
 const overview=read('widgets/overview/public/dashboard.js'), camera=read('widgets/camera/public/dashboard.js');
 for(const src of [overview,camera]){assert.doesNotMatch(src,/autoPreview/);assert.doesNotMatch(src,/Live · Ausfahrt|Live · Rückkehr/);}
});
