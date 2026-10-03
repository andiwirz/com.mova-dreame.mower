'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Engine = require('../lib/garage/GarageSafetyEngine');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');

test('v198 short ETA on proven lawn side stays direct and uses safety-line wait instead of maintenance', async()=>{
  const e=Object.create(Engine.prototype);
  const now=Date.now();
  e.pos=()=>({x:0,y:1000,ts:now});
  e.device={_dockPos:{x:0,y:0},_cachedMapData:{boundary:{x1:-5000,y1:-5000,x2:5000,y2:5000}}};
  e._speedMetersPerSecond=()=>({mps:0.5,basis:'test'});
  e._doorOpenDurationSeconds=()=>20;
  e._doorDelaySeconds=()=>20;
  e._garageLineSide=-1; e._lawnLineSide=1;
  e.markers={
    lineState:async()=>({known:true,onSegment:true,side:1,rawSide:1,distance:1000,rawThreshold:60,direction:{garageSide:-1,lawnSide:1}}),
    dangerState:async()=>({known:true,inside:false}),
  };
  e.log=()=>{};
  const r=await e._decideReturnPath('external_status_returning');
  assert.equal(r.mode,'direct');
  assert.equal(r.etaFits,false);
  assert.equal(r.reason,'lawn_side_eta_short_line_wait');
});

test('v198 maintenance departure evidence must progress toward the locked point',()=>{
  const e=Object.create(Engine.prototype);
  const now=Date.now();
  e._lockedReturnMaintenancePoint={x:1000,y:0};
  e._distance=Engine.prototype._distance;
  let r=e._maintenanceDepartureEvidence({x:0,y:0},{x:220,y:0,ts:now},now-100,now);
  assert.equal(r.moved,true);
  assert.equal(r.towardTarget,true);
  assert.equal(r.wrongWay,false);
  r=e._maintenanceDepartureEvidence({x:0,y:0},{x:-220,y:0,ts:now},now-100,now);
  assert.equal(r.moved,false);
  assert.equal(r.wrongWay,true);
});

test('v198 active maintenance route cannot be hijacked by the normal safety-line wait owner',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  assert.match(src,/if \(returnActive && this\._returnContext !== RETURN_STATES\.MAINTENANCE/);
  assert.match(src,/&& this\._returnContext !== RETURN_STATES\.MAINTENANCE\) \{/);
  assert.match(src,/maintenance_wrong_way_recovery/);
});

test('v198 return operational holds never fire Safety-Block flow and genuine blocks are globally throttled',async()=>{
  const e=Object.create(Engine.prototype);
  let triggers=0;
  e.log=()=>{};
  e._timeline=()=>{};
  e.safetyWarning=async()=>{};
  e._trigger=()=>{triggers++;};
  await e.returnOperationalHold('return_gate_open_clearance_unconfirmed');
  assert.equal(triggers,0);

  e._outboundCloseProtected=()=>false;
  e._homeState='away'; e._outboundHardLockUntil=0; e._resumeGuardUntil=0;
  e._lastSafetyStatus='ok'; e._emergencyGateContext=null; e._emergencyHoldActive=()=>false;
  e._lastBlockReason=''; e._lastBlockAt=0; e._lastSafetyBlockNoticeAt=0;
  e._setSafetyStatus=async(status,reason)=>{e._lastSafetyStatus=status;e._lastSafetyReason=reason;};
  await e.safetyBlock('one');
  await e.safetyBlock('two');
  assert.equal(triggers,1);
});

test('v198 line-wait gate release trusts dedicated stop proof plus raw clearance, not a second side debounce',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  const start=src.indexOf("openingReason.includes('line_wait')");
  const end=src.indexOf('} else {',start);
  const block=src.slice(start,end);
  assert.match(block,/routeProof = stopProofFresh/);
  assert.doesNotMatch(block,/line\.side|line\.onSegment|lawnSide/);
});
