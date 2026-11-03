'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Garage = require('../lib/garage/GarageSafetyEngine');

function gateFixture(){
  const e=Object.create(Garage.prototype);
  let door='closed';
  const actions=[];
  const warnings=[];
  Object.assign(e,{
    device:{getCapabilityValue:()=>null,setStoreValue:async()=>{}},
    _commandToken:4,_manualGateStopped:false,_runtimeStartedAt:Date.now()-1000,
    _lastSensorContactState:'closed',_lastSensorContactAt:Date.now()-4000,
    _lastGateOpenHandshakeAt:0,_lastDoorOpenReleaseAt:0,
    sensorEnabled:()=>true,sensorDoorMonitoringEnabled:()=>true,sensorHealthy:()=>true,
    isDoorOpenStable:()=>door==='open',doorState:()=>door,
    _doorOpenDurationSeconds:()=>10,_doorDelaySeconds:()=>10,
    _restoreSensorOnlineIfRecent:async()=>{},
    requestOpen:async()=>{e._lastDoorOpenRequestAt=Date.now();door='opening';actions.push('open-request');return true;},
    setDoorState:async(state,opts={})=>{door=state; actions.push(`${state}:${opts.derived?'derived':'sensor'}`);},
    _trigger:(event)=>actions.push(event),
    _recordSensorMovementTimeout:async()=>{actions.push('sensor-timeout');},
    safetyWarning:async(code)=>{warnings.push(code);},
    _garageNotice:(kind,message)=>{actions.push(`notice:${kind}:${message}`);},
    _text:(de,en)=>de,
    clearSafety:async()=>{},
    log:(...parts)=>actions.push(parts.join(' ')),
  });
  return {e,actions,warnings,door:()=>door,realOpen(){
    e._lastSensorContactState='open';
    e._lastSensorContactAt=Date.now();
    e._lastGateOpenHandshakeAt=e._lastSensorContactAt;
    door='open';
    e._lastDoorOpenReleaseAt=Date.now();
  }};
}
async function flush(){for(let n=0;n<30;n++) await Promise.resolve();}

test('enabled nonresponding sensor: holds before 90s watchdog, then blocks without assuming gate opened',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const f=gateFixture();
  const result=f.e.ensureDoorOpen('return_current_position_gate_wait');
  await flush();
  assert.ok(f.actions.includes('open-request'));
  t.mock.timers.tick(30001);await flush();
  assert.equal(f.door(),'opening');
  assert.equal(f.e._doorOpenReleaseVerified(),false);
  assert.equal(f.actions.some(x=>x==='garage_door_stable_open'),false);
  t.mock.timers.tick(60000);await flush();
  assert.equal(await result,false);
  assert.equal(f.door(),'unknown');
  assert.ok(f.actions.some(x=>x==='unknown:derived'));
  assert.ok(!f.actions.some(x=>x==='open:derived'));
  assert.ok(f.actions.some(x=>x.startsWith('notice:gate_open_unconfirmed:')));
  assert.equal(f.e._doorOpenReleaseVerified(),false);
  assert.equal(f.e._doorOpenTimedFallbackAt || 0,0, 'no false timed proof');
});

test('delayed real OPEN contact at ~54s safely releases after confirmation, without timer fallback',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const f=gateFixture();
  const result=f.e.ensureDoorOpen('return_current_position_gate_wait');
  await flush();
  t.mock.timers.tick(54000);
  f.realOpen();
  await flush();
  assert.equal(f.e._doorOpenReleaseVerified(),true);
  assert.equal(await result,true);
  assert.equal(f.actions.filter(x=>x==='sensor-timeout').length,0);
  assert.equal(f.actions.filter(x=>x==='open:derived').length,0);
});

test('real contact OPEN from an earlier gate cycle cannot authorize a new motor request',()=>{
  const f=gateFixture();
  f.realOpen();
  assert.equal(f.e._doorOpenReleaseVerified(),true);
  f.e._lastDoorOpenRequestAt=Date.now()+1000; // clearly future despite scheduling jitter
  assert.equal(f.e._doorOpenReleaseVerified(),false);
  f.e._lastSensorContactAt=f.e._lastDoorOpenRequestAt;
  f.e._lastGateOpenHandshakeAt=f.e._lastSensorContactAt;
  assert.equal(f.e._doorOpenReleaseVerified(),false, 'future OPEN readings are invalid');
});

test('home-close ignores 30s-old station telemetry but revokes exception for 60s stale or genuine undock',async t=>{
  t.mock.timers.enable({apis:['Date'],now:100000});
  const e=Object.create(Garage.prototype);
  Object.assign(e,{device:{_mowerBinaryDiag:{dockingState:'IN_STATION',undocking:0,chargingLive:true},_mowerBinaryDiagAt:70000},
    _confirmedNativeStationLock:true,_confirmedNativeStationAt:70000,
    _homeState:'home',_homeCloseIssuedAt:85000,_outbound:null,_manualGateStopped:false,
    doorState:()=> 'closing',status:()=> 'returning',_homeDockReadyForClose:()=>false});
  assert.equal(e._isSafeHomeClosingContext(),true, '30s stale cloud return is not an undock');
  e.device._mowerBinaryDiagAt=39999;
  assert.equal(e._isSafeHomeClosingContext(),false, 'physical proof cannot remain valid forever');
  e.device._mowerBinaryDiagAt=100000;
  e.device._mowerBinaryDiag={dockingState:'OUT_OF_STATION',undocking:1,chargingLive:false};
  e._confirmedNativeStationLock=false;
  assert.equal(e._isSafeHomeClosingContext(),false, 'real undocking remains urgent');
});

test('return A/B crossing accepts only fresh real contact or current-token timed proof, never stale OPEN display',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
  assert.match(src,/const doorReady = this\.isDoorOpenStable\(\) && this\._doorOpenReleaseVerified\(\)/);
  assert.match(src,/this\._lastDoorOpenRequestAt = Date\.now\(\)/);
  assert.match(src,/this\._timedDoorOpenReleaseVerified\(maxAgeMs\)/);
  assert.match(src,/door OPEN contact timed out; gate UNVERIFIED – no timed release/);
});
