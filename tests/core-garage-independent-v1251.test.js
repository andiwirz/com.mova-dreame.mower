'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root,rel),'utf8');
let Device;
const originalLoad = Module._load;
try {
  Module._load = function(id, parent, main) {
    if (id==='homey') return {Device:class{}};
    if (id==='mqtt') return {};
    return originalLoad.call(this,id,parent,main);
  };
  Device = require('../drivers/mower/device');
} finally { Module._load = originalLoad; }
const Garage = require('../lib/garage/GarageSafetyEngine');
const d = () => {
  const device = Object.create(Device.prototype);
  device.getSetting=()=>false;
  return device;
};
test('Garage Mode OFF: all phase rules follow mower phases, protective prestart remains conservative',()=>{
  const device=d();
  for (const mode of ['departure','departure_mowing','mowing','mowing_return']) {
    assert.equal(device._pylonLifecycleDesiredActive({lifecycle:mode},'prestart'),true,mode+' protective prestart');
  }
  assert.equal(device._pylonLifecycleDesiredActive({lifecycle:'return'},'prestart'),false,
    'return-only must not block an outgoing mission');
  assert.equal(device._pylonLifecycleDesiredActive({lifecycle:'departure'},'mowing'),false);
  assert.equal(device._pylonLifecycleDesiredActive({lifecycle:'departure'},'departure'),true);
  assert.equal(device._pylonLifecycleDesiredActive({lifecycle:'departure_mowing'},'return'),false);
  assert.equal(device._pylonLifecycleDesiredActive({lifecycle:'mowing'},'mowing'),true);
  assert.equal(device._pylonLifecycleDesiredActive({lifecycle:'mowing'},'return'),false);
  assert.equal(device._pylonLifecycleDesiredActive({lifecycle:'return'},'return'),true);
  assert.equal(device._pylonLifecycleDesiredActive({lifecycle:'return'},'mowing'),false);
});
function standaloneFixture(result={ok:true}) {
  const events=[];
  const engine=Object.create(Garage.prototype);
  engine._commandToken=0;
  engine._manualMaintenanceReached=false;
  engine.enabled=()=>false;
  engine.isDockedHomeStatus=()=>true;
  engine._freshNativeDockState=()=>({dockingState:'IN_STATION'});
  engine.log=()=>{};
  engine.device={_syncPylonLifecyclePhase:async(phase,options)=>{
    events.push('zone:'+phase);
    assert.equal(options.reason,'standalone_mower_start');
    return result;
  }};
  return {engine,events};
}
test('standalone Homey mowing start completes protective zone preflight before mower command',async()=>{
  const {engine,events}=standaloneFixture();
  assert.equal(await engine.startRequested('homey',async()=>{events.push('mower_start');return 'started';}), 'started');
  assert.deepEqual(events,['zone:prestart','mower_start']);
  assert.ok(engine.device._standalonePrestartActiveUntil>Date.now());
});
test('standalone mowing start fails closed on zone verification failure',async()=>{
  const {engine,events}=standaloneFixture({ok:false,reason:'map_unverified'});
  const accepted=await engine.startRequested('homey',async()=>{events.push('mower_start');return true;});
  assert.equal(accepted,false);
  assert.deepEqual(events,['zone:prestart']);
});
test('prestart survives idle status until mower starts with Garage Mode disabled',()=>{
  const device=d();device._nativeMowerStatus='idle';
  device._standalonePrestartActiveUntil=Date.now()+90000;
  assert.equal(device._currentPylonLifecyclePhase(),'prestart');
  device._nativeMowerStatus='mowing';
  assert.equal(device._currentPylonLifecyclePhase(),'mowing');
});
test('map and maintenance editors remain editable without garage and pylons',()=>{
  for(const rel of ['drivers/mower/repair/map_editor.html','widgets/map/public/index.html','widgets/overview/public/map-editor.html']){
    const s=read(rel);
    assert.match(s,/classList\.toggle\('hidden', _editMode\)/);
    assert.doesNotMatch(s,/_editMode \|\| \(!garageActive && !hasPylons\)/);
    assert.match(s,/showMaintenancePoint = !_editMarkersHidden/);
    assert.match(s,/toggle-markers-btn/);
  }
});
test('core variant contains no live-video widgets, cloud provisioning or runtime',()=>{
  const exists=rel=>fs.existsSync(path.join(root,rel));
  for(const rel of ['lib/video','native/xp2p','widgets/camera','lib/video_credentials.js','lib/video_identity_contract.js','docs/THIRD_PARTY_NOTICES.md'])assert.equal(exists(rel),false,rel);
  for(const rel of ['drivers/mower/device.js','lib/MovaApi.js','lib/widgets/MowerDashboard.js','widgets/overview/public/index.html','widgets/overview/public/dashboard.js']) {
    assert.doesNotMatch(read(rel),/_standaloneVideo|DreameStandaloneVideo|xp2p-sdk|getTxVideoRuntimeInputs|video_privacy_acknowledged|cameraToggle/,rel);
  }
  const app=JSON.parse(read('app.json'));
  const widget=JSON.parse(read('widgets/overview/widget.compose.json'));
  assert.equal(app.widgets.camera,undefined);
  assert.equal(app.widgets.overview.api.camera,undefined);
  assert.equal(widget.api.camera,undefined);
  const compose=JSON.parse(read('drivers/mower/driver.compose.json'));
  assert.equal(JSON.stringify(compose).includes('video_enabled'),false);
});

test('standalone start with no phase zones does not require native map verification',async()=>{
  const device=d();
  device._api={};
  device._activeMapIndex=0;
  device._obstacleRulesCache={};
  device._nativeZonePoliciesCache={};
  device._automaticNativeZoneMapWriteSafe=()=>false;
  device._mapEditStationary=()=>{throw Error('no native writes needed');};
  device.log=()=>{};
  const result=await device._syncPylonLifecyclePhase('prestart',{reason:'standalone_mower_start'});
  assert.equal(result.ok,true);
  assert.equal(result.reason,'no_native_transition_required');
});
