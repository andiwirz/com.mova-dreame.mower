'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Garage = require('../lib/garage/GarageSafetyEngine');

test('configured offline contact uses time-only proof bound to this exact OPEN request and command token', () => {
  const e=Object.create(Garage.prototype);
  const now=Date.now();
  e.device={getCapabilityValue:()=> 'open'};
  e._runtimeStartedAt=now-20000;
  e._commandToken=9;
  e.sensorEnabled=()=>true;
  e.isDoorOpenStable=()=>true;
  e._lastDoorOpenRequestAt=now-12000;
  e._doorOpenTimedFallbackRequestAt=now-12000;
  e._doorOpenTimedFallbackAt=now-10;
  e._doorOpenTimedFallbackToken=9;
  e._lastSensorContactState='closed';
  e._lastSensorContactAt=now-15000;
  assert.equal(e._doorOpenReleaseVerified(),true);
  e._lastSensorContactAt=now-100;
  assert.equal(e._doorOpenReleaseVerified(),false,'new CLOSED contact overrides elapsed time');
  e._lastSensorContactAt=now-15000;
  e._commandToken=10;
  assert.equal(e._doorOpenReleaseVerified(),false,'new control cycle invalidates proof');
  e._commandToken=9;
  e._lastDoorOpenRequestAt=now-100;
  assert.equal(e._doorOpenReleaseVerified(),false,'new gate command invalidates proof');
});

test('native P2 original task captured after PAUSE survives later mowing and STOP telemetry',()=>{
 const e=Object.create(Garage.prototype);
 Object.assign(e,{device:{},_externalStartRecoveryActive:true,_externalStartIntentAt:Date.now()-1000,
  _externalStartRecoveryPhase:'STOP_OLD_TASK_EARLY',_externalStartTask:null,log:()=>{}});
 e.noteExternalStartTask({t:'TASK',d:{o:109,exe:true,status:false,point:[2]}});
 assert.equal(e._externalStartTask.o,109);
 e.noteExternalStartTask({t:'TASK',d:{o:100,exe:true,status:true}});
 e.noteExternalStartTask({t:'TASK',d:{o:3,exe:true,status:true}});
 assert.equal(e._externalStartTask.o,109);
 assert.deepEqual(e._externalStartTask.point,[2]);
});

test('mowing exit-close ETA, lawn dwell and 3rd crossing do not take over maintenance transit',async()=>{
 const e=Object.create(Garage.prototype);
 Object.assign(e,{_commandToken:4,_outbound:{},_manualGateStopped:false,_manualMaintenanceTransit:true,
  _closeAfterExitRequested:false,_maintenanceCloseProtected:()=>true,enabled:()=>true,isReturning:()=>false,
  status:()=> 'mowing',_closeAfterExitWithoutPause:()=>{throw Error('must never issue close')} });
 assert.equal(await e._evaluateOutboundClosePriorities({inside:false},{stable:true,side:1}),false);
});

test('safety line backup includes direct PAUSE+STOP and separate maintenance wrong-way stop',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
 assert.match(src,/garage_return_line_hard_pause/);
 assert.match(src,/garage_return_line_recovery_stop/);
 assert.match(src,/maintenance_wrong_way_preline/);
 assert.match(src,/garage_maintenance_wrong_way_preline_stop/);
 assert.match(src,/!this\._doorOpenReleaseVerified\(\)/);
});
