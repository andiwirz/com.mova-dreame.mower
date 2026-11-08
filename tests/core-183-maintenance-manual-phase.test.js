'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('module');
const orig=Module._load;
let Safety;
try { Module._load=function(id,parent,main){if(id==='homey')return {Device:class{}};if(id==='mqtt')return {};return orig.call(this,id,parent,main)};Safety=require('../lib/garage/GarageSafetyEngine'); }
finally {Module._load=orig}
const source=fs.readFileSync(path.resolve(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');

test('selection branch preserves selected P2 and does not use automatic rotation/default P1',()=>{
  const branch=source.slice(source.indexOf('async resumeUnknownExternalMaintenance('),source.indexOf('async maintenanceRequested('));
  assert.match(branch,/operator_target_locked/);
  assert.match(branch,/maintenanceRequested\('button_maintenance_external_operator_selection'/);
  assert.match(branch,/_goToMaintenancePointGuarded\('external_operator_maintenance', point\)/);
  assert.doesNotMatch(branch,/_goToMaintenancePointGuarded\('external_operator_maintenance', 1\)/);
});

test('manual takeover CLOSE is direct relay request and skips automatic close priorities',async()=>{
  const calls=[];
  const e=Object.create(Safety.prototype);
  Object.assign(e,{
    _manualRecoveryActive:true,_manualRecoveryOperatorFree:true,_manualRecoveryPhase:'manual_hold',
    _manualRecoveryMowerCommandBusy:false,_manualRecoveryGateCommandBusy:false,
    _manualRecoveryGatePulseAt:0,_emergencyGateContext:null,_emergencyTransitionPromise:null,
    _observedMowerStatus:'paused',_observedMowerStatusAt:Date.now(),
    device:{_observedMowerStatus:'paused',_observedMowerStatusAt:Date.now(),getCapabilityValue:()=>null},
    doorState:()=> 'open',_strongDockCloseProof:()=>false,isDockedHomeStatus:()=>false,
    _manualGateOutsidePositionProof:async()=>true,_manualRecoveryStationary:()=>true,
    _trigger:(...args)=>calls.push(args),log:()=>{},
  });
  assert.equal(await e.manualRecoveryGateCommand('close',true),true);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'garage_close_requested');
  assert.equal(calls[0][1],'manual_recovery_supervised_close');
});

test('manual takeover CLOSE rejects a moving mower at the passage',async()=>{
  const calls=[];
  const e=Object.create(Safety.prototype);
  Object.assign(e,{
    _manualRecoveryActive:true,_manualRecoveryOperatorFree:true,_manualRecoveryPhase:'manual_hold',
    _manualRecoveryMowerCommandBusy:false,_emergencyGateContext:null,_emergencyTransitionPromise:null,
    device:{_observedMowerStatus:'returning',_observedMowerStatusAt:Date.now(),getCapabilityValue:()=>null},
    doorState:()=> 'open', _trigger:(...args)=>calls.push(args),log:()=>{},
  });
  assert.equal(await e.manualRecoveryGateCommand('close',true),false);
  assert.equal(calls.length,0);
});

test('manufacturer-app explicit P2 chooser dispatches P2 even when rotation primary is P1',async()=>{
  const seen=[];
  const e=Object.create(Safety.prototype);
  const device={
    _activeMapIndex:0,
    _cachedMapData:{nativeMaintenancePoints:[{index:1,x:0,y:0},{index:2,x:3000,y:2000}]},
    _resolveNativeMaintenancePoint:(point)=>({index:point,x:point*1000,y:0}),
    _getGarageManagedSetting:()=> 'Rasenende',
    _garageMaintenanceCyclePointIndex:1,
    _maintenancePointIndex:()=>1,
    _refreshNativeDockForStart:async()=>({dockingState:'IN_STATION',undocking:0}),
    _goToMaintenancePointGuarded:async(_,point)=>{seen.push(['dispatch',point]);return true;},
    getSetting:()=>true,
  };
  Object.assign(e,{
    device, _externalMaintenanceSelectionRequiredAt:Date.now(),
    _externalStartRecoveryPhase:'MANUAL_REISSUE_REQUIRED',
    _commandToken:17, _manualGateStopped:false,_manualRecoveryActive:false,
    _returnGuardActive:false,_emergencyGateContext:null,_doorState:'open',
    enabled:()=>true,isDoorOpenStable:()=>true,_doorOpenReleaseVerified:()=>true,
    maintenanceRequested:async(_,fn,point)=>{seen.push(['selected',point]);await fn();return true;},
    log:()=>{},
  });
  assert.equal(await e.resumeUnknownExternalMaintenance(2,true),true);
  assert.deepEqual(seen,[['selected',2],['dispatch',2]]);
});

test('a stale P1 arrival cannot consume the watcher for selected P2',async()=>{
  const messages=[];
  const e=Object.create(Safety.prototype);
  const watch=setInterval(()=>{},100000); watch.unref();
  Object.assign(e,{
    _maintenanceRequestedAt:Date.now(),_manualMaintenanceTransit:true,
    _manualMaintenanceTargetIndex:2,_manualMaintenanceReached:false,
    _commandToken:8,_maintenanceWatch:watch,
    _returnContext:'IDLE',
    log:(...args)=>messages.push(args),
    device:{getCapabilityValue:()=> 'open'},
  });
  assert.equal(await e.confirmNativeMaintenanceArrival('stale_p1',null,1),false);
  assert.equal(e._maintenanceWatch,watch);
  assert.equal(e._manualMaintenanceReached,false);
  assert.equal(messages.some(parts=>String(parts[1]).includes('arrival_wrong_target_ignored')),true);
  clearInterval(watch);
});
