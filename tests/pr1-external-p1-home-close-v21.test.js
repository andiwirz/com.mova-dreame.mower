'use strict';
const assert = require('node:assert/strict');
const Garage = require('../lib/garage/GarageSafetyEngine');

(async () => {
  // Regression from the field log: a legitimate, running PR1 P1 return had
  // _homeCloseArmed=false and thus never entered the 15-second close window.
  const e=Object.create(Garage.prototype);
  const logs=[], timeline=[];
  let writes=0;
  e.enabled=()=>true;
  e.sensorEnabled=()=>true;
  e.sensorHealthy=()=>true;
  e.isDockedHomeStatus=()=>false;
  e._lockReturnMaintenancePoint=async()=>({x:1000,y:2000});
  e._isCurrentlyAtKnownMaintenancePoint=async()=>true;
  e._pauseMowerForGateInterlock=async()=>true;
  e.ensureDoorOpen=async()=>true;
  e.isDoorOpenStable=()=>true;
  e._doorOpenReleaseVerified=()=>true;
  e._lastSensorContactState='open';
  e._setReturnContext=()=>{};
  e._text=(de,en)=>de;
  e._timeline=(...a)=>timeline.push(a);
  e.log=(...a)=>logs.push(a.join(' '));
  e.error=()=>{};
  e._commandToken=3;
  e._homeCloseArmed=false;
  e._pr1ExternalP1Active=false;
  e._safeReturnInProgress=false;
  e.device={getData:()=>({id:'mower'}),_safeWrite:async(_k,fn)=>fn(),_api:{dock:async()=>{writes++;return true}}};
  assert.equal(await e._pr1ExternalP1Return('external_status_returning'),true);
  assert.equal(writes,1);
  assert.equal(e._homeCloseArmed,true,'accepted runtime DOCK must arm later close');

  // A rejected native DOCK must not arm automatic close.
  const rejected=Object.create(Garage.prototype);
  Object.assign(rejected,e);
  rejected._pr1ExternalP1Active=false;
  rejected._safeReturnInProgress=false;
  rejected._homeCloseArmed=false;
  rejected.device={getData:()=>({id:'mower'}),_safeWrite:async()=>false,_api:{dock:async()=>true}};
  rejected._pr1HoldUnsafeReturn=async()=>true;
  rejected.safetyBlock=async()=>{};
  await rejected._pr1ExternalP1Return('external_status_returning');
  assert.equal(rejected._homeCloseArmed,false);

  const close=Object.create(Garage.prototype);
  let scheduled=[];
  let closed=0;
  const origSetTimeout=global.setTimeout, origClearTimeout=global.clearTimeout;
  try {
    global.setTimeout=(fn,ms)=>{scheduled.push({fn,ms});return scheduled.length;};
    global.clearTimeout=()=>{};
    close._homeCloseArmed=true;
    close._closeScheduled=false;
    close._homeCloseInProgress=false;
    close._outbound=null;close._outboundHardLockUntil=0;close._missionOutside=false;
    close._returnContext='idle';
    close.enabled=()=>true;
    close.isDockedHomeStatus=()=>true;
    close.doorState=()=> 'open';
    close.log=()=>{};close._trigger=()=>{};
    close._enterDockedIdle=async()=>{};
    close.requestClose=async()=>{closed++;return true;};
    close._scheduleHomeClose('native_docked_or_charging');
    close._scheduleHomeClose('native_docked_or_charging');
    assert.equal(scheduled.length,1,'repeated native charge status must not restart close timer');
    assert.equal(scheduled[0].ms,15000);
    await scheduled[0].fn();
    assert.equal(closed,1);
    assert.equal(close._homeCloseArmed,false,'completed close cycle must not rearm on a poll');
    close._scheduleHomeClose('native_docked_or_charging');
    assert.equal(scheduled.length,1,'no later stale charge-triggered close');

    // Negative: after a restart the unarmed app cannot schedule any close.
    const boot=Object.create(Garage.prototype);
    boot._homeCloseArmed=false;boot.log=()=>{};boot._closeScheduled=false;
    boot._scheduleHomeClose('native_docked_or_charging');
    assert.equal(scheduled.length,1);

    // Native home confirmation withdrawn while waiting => no close.
    const stopped=Object.create(Garage.prototype);
    stopped._homeCloseArmed=true;stopped._closeScheduled=false;
    stopped._outbound=null;stopped._missionOutside=false;stopped._outboundHardLockUntil=0;
    stopped.doorState=()=> 'open'; stopped.log=()=>{};
    stopped.enabled=()=>true;stopped.isDockedHomeStatus=()=>false;
    stopped.requestClose=async()=>{throw Error('must not run');};
    stopped._scheduleHomeClose('native_docked_or_charging');
    assert.equal(scheduled.length,2);
    await scheduled[1].fn();
    assert.equal(stopped._closeScheduled,false);
  } finally {global.setTimeout=origSetTimeout;global.clearTimeout=origClearTimeout;}
  console.log('PASS: accepted external P1 DOCK arms one safe 15s home-close, rejects missing proof and repeats');
})().catch(e=>{console.error(e);process.exitCode=1});
