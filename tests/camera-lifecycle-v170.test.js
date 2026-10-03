'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {CameraSession}=require('../lib/video/CameraSession');
test('idle Homey camera never launches SDK; consumers share one worker; last OFF stops it',async()=>{
 let starts=0,stops=0;const s=new CameraSession({startWorker:async()=>{starts++;return{stop:async()=>{stops++;}};}});
 s.status();await s.tick();assert.equal(starts,0);await Promise.all([s.start('one',true),s.start('two',true)]);await s.starting;assert.equal(starts,1);
 await s.release('one');assert.equal(stops,0);await s.release('two');assert.equal(stops,1);assert.equal(s.state,'off');
});
test('OFF during startup disposes pending worker before allowing another start',async()=>{
 let ready,stops=0;const s=new CameraSession({startWorker:()=>new Promise(r=>{ready=r;})});await s.start('one',true);const stop=s.stop();ready({stop:async()=>{stops++;}});await stop;assert.equal(stops,1);assert.equal(s.state,'off');
});
test('failed shutdown stays blocked and is never reported as OFF',async()=>{
 const s=new CameraSession({startWorker:async()=>({stop:async()=>{throw Error('fixture');}})});await s.start('one',true);await s.starting;await assert.rejects(s.stop());assert.equal(s.state,'error');await assert.rejects(s.start('two',true),/restart required/);
});
test('failed shutdown during startup cancellation also remains blocked',async()=>{
 let ready;const s=new CameraSession({startWorker:()=>new Promise(r=>{ready=r;})});await s.start('one',true);const stopping=s.stop();ready({stop:async()=>{throw Error('fixture');}});await assert.rejects(stopping);assert.equal(s.error,'camera_stop_failed');
});
test('invisible clients expire and maximum camera lifetime applies despite heartbeat',async()=>{
 let time=1000,stops=0;const s=new CameraSession({now:()=>time,idleMs:100,maxMs:1000,startWorker:async()=>({stop:async()=>{stops++;}})});
 await s.start('one',true);await s.starting;time+=101;await s.tick();assert.equal(stops,1);
 await s.start('one',true);await s.starting;time+=1001;s.touch('one');await s.tick();assert.equal(stops,2);
});
test('OFF aborts a startup worker immediately and waits for its confirmed cleanup',async()=>{
 let aborted=false;const s=new CameraSession({startWorker:signal=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;const e=Error('cancelled');e.code='CAMERA_ABORTED';reject(e);},{once:true}))});
 await s.start('one',true);await s.stop();assert.equal(aborted,true);assert.equal(s.state,'off');
});
