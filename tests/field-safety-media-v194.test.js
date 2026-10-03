'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Engine=require('../lib/garage/GarageSafetyEngine');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('v194 widget fullscreen/popup UI is fully removed',()=>{
  for(const rel of ['widgets/camera/public/index.html','widgets/overview/public/index.html','widgets/camera/public/dashboard.js','widgets/overview/public/dashboard.js']){
    const src=read(rel);
    assert.doesNotMatch(src,/fullscreenBtn|maximizeCamera|Homey\.popup|H\?\.popup|cameraPopup=1|⛶/);
  }
});

test('v194 priority-2 dwell cannot close near the safety line',async()=>{
  const e=Object.create(Engine.prototype);let closed=0;
  Object.assign(e,{_commandToken:1,_manualGateStopped:false,_outbound:{lineLawnSide:1,lineCrossAttempts:1,lawnSideSince:Date.now()-20000},_closeAfterExitRequested:false,_safeReturnInProgress:false,_returnGuardActive:false,_dangerOutsideSince:Date.now()-5000,_rawDangerExitConfirmed:()=>true,_freshPositionForExitDecision:()=>({x:1,y:1,ts:Date.now()}),_outboundPhaseProtected:()=>false,_outboundCloseBlockedByMode:()=>({blocked:false}),enabled:()=>true,isReturning:()=>false,status:()=> 'mowing',_speedMetersPerSecond:()=>({mps:.12,basis:'test'}),_doorCloseDurationSeconds:()=>20,_outboundCloseNearMaintenancePoint:async()=>({near:false,distance:2000}),_closeAfterExitWithoutPause:async()=>{closed++;return true;},log:()=>{}});
  assert.equal(await e._evaluateOutboundClosePriorities({inside:false,distance:1500,radius:1000},{stable:true,side:1,distance:350}),false);assert.equal(closed,0);
  assert.equal(await e._evaluateOutboundClosePriorities({inside:false,distance:1500,radius:1000},{stable:true,side:1,distance:850}),true);assert.equal(closed,1);
});

test('v194 crossing latch waits for strong physical clearance, not a shallow side touch',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  assert.match(src,/SAFETY_LINE_CROSS_CONFIRM_MM = 500/);
  assert.match(src,/side change pending physical clearance/);
  assert.match(src,/!shallowSideChange\) this\._lastLineSide = side/);
  assert.match(src,/SAFETY_LINE_DWELL_MIN_CLEARANCE_MM = SAFETY_LINE_CLEARANCE_MM/);
  assert.match(src,/Dwell begins only after the crossing itself[\s\S]*lawnSideSince = Date\.now\(\)/);
});
