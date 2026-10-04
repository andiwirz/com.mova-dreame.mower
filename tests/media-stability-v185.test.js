'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {renderMapPng}=require('../lib/widgets/MapPngRenderer');
const {FlvH264}=require('../lib/video/FlvH264');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('v185 native video uses Homey WebRTC proxy and keeps a reconnect grace window',()=>{
 const video=read('lib/video/DreameStandaloneVideo.js');
 const camera=read('lib/video/HomeyCamera.js');
 assert.match(video,/createVideoOther\(\)/);
 assert.doesNotMatch(video,/disableWebRTCProxy\s*:\s*true/);
 assert.match(camera,/30000/);
 assert.match(camera,/Homey requested stream URL/);
 assert.match(video,/Homey video URL listener failed/);
});

test('v185 native map is high resolution and retains complete garage overlays',()=>{
 const png=renderMapPng({boundary:{x1:0,y1:0,x2:5000,y2:4000},mowingAreas:[[1,{path:[{x:100,y:100},{x:4900,y:100},{x:4900,y:3900},{x:100,y:3900}]}]],livePath:[[200,500],[4500,500],[4500,800],[200,800]],routeRenderMode:'final',overlayVisibility:{garageMode:true},garageOverlay:{lineA:{x:600,y:600},lineB:{x:1900,y:600},dangerCenter:{x:1300,y:1200},dangerRadius:500,cautionRadius:900,maintenancePoint:{x:1600,y:900}},chargerPos:{x:400,y:700},robotPos:{x:3000,y:2200},mapObstacles:[{x:2200,y:1800}]});
 assert.ok(Buffer.isBuffer(png));assert.equal(png.readUInt32BE(16),1440);assert.equal(png.readUInt32BE(20),1040);assert.ok(png.length>5000);
});

test('v186 repair custom views live in repair folder required by Homey repair flow',()=>{
 for(const name of ['repair.html','map_editor.html','reauth.html']){
  assert.equal(fs.existsSync(path.join(root,'drivers/mower/repair',name)),true,name);
  assert.equal(fs.existsSync(path.join(root,'drivers/mower/pair',name)),false,`repair view must not be packaged in pair/: ${name}`);
 }
});

test('v1247 FLV relay deliberately strips camera audio while retaining H.264 video',()=>{
 const p=new FlvH264();
 const header=Buffer.from([70,76,86,1,5,0,0,0,9,0,0,0,0]);
 const tag=(type,body)=>{const b=Buffer.alloc(15+body.length);b[0]=type;b.writeUIntBE(body.length,1,3);body.copy(b,11);b.writeUInt32BE(body.length+11,b.length-4);return b;};
 const audio=tag(8,Buffer.from([0xaf,0,0x12,0x10]));
 const config=tag(9,Buffer.from([0x17,0,0,0,0,1,0x64,0,0x1f,255,225,0]));
 const frame=tag(9,Buffer.from([0x17,1,0,0,0,0,0,0,2,0x65,0x88]));
 p.push(Buffer.concat([header,audio,config,frame]));
 const initial=p.initial();
 assert.equal(initial[4] & 0x04,0,'FLV audio flag must be cleared');
 assert.equal(initial.includes(audio),false,'audio tag must not be relayed');
 const snap=p.snapshot();
 assert.ok(Array.isArray(snap.frames));
 assert.ok(snap.frames.length>=1);
 assert.equal(Object.hasOwn(snap,'audio'),false);
});

test('v185 widget frontend reports diagnostics into device log and has no garage auto preview/fullscreen path',()=>{
 const dash=read('lib/widgets/MowerDashboard.js');
 assert.match(dash,/\[video-widget\]/);
 for(const rel of ['widgets/camera/public/dashboard.js','widgets/overview/public/dashboard.js']){
  const js=read(rel);assert.match(js,/diagnostic\('snapshot_error_/);assert.doesNotMatch(js,/requestFullscreen|autoPreview/);
 }
 const cfg=JSON.parse(read('drivers/mower/driver.compose.json'));const group=cfg.settings.find(g=>g.label?.de==='Live Video');assert.equal(group.children.some(x=>x.id==='video_garage_auto_preview'),false);
});
