'use strict';
const assert=require('node:assert/strict');
const E=require('../lib/garage/GarageSafetyEngine');
async function run(gateReady) {
 const e=Object.create(E.prototype);
 const events=[];
 e.enabled=()=>true;e.sensorEnabled=()=>true;e.sensorHealthy=()=>true;e.isDockedHomeStatus=()=>false;
 e._lockReturnMaintenancePoint=async()=>({x:1,y:2});
 e._setReturnContext=()=>{};e.log=()=>{};e._timeline=()=>{};e._text=(de)=>de;
 e._commandToken=3;e._pauseMowerForGateInterlock=async()=>{events.push('PAUSE');return true;};
 e._isCurrentlyAtKnownMaintenancePoint=async()=>events.includes('P1_ARRIVED');
 e._sendMaintenanceWithRetry=async(fn)=>{await fn();return true;};
 e._watchMaintenanceReached=(cb)=>{e.onP1=cb};
 e.ensureDoorOpen=async()=>{events.push('OPEN_REQUESTED');return gateReady;};
 e._lastSensorContactState=gateReady?'open':'closed';
 e.isDoorOpenStable=()=>gateReady;
 e._doorOpenReleaseVerified=()=>gateReady;
 e.safetyBlock=async()=>{};
 e._pr1HoldUnsafeReturn=async()=>{events.push('FAILSAFE_HOLD');};
 e.device={getData:()=>({id:'mower'}),_api:{dock:async()=>{events.push('DOCK');return true;}},
  _safeWrite:async(_label,fn)=>fn(),_goToMaintenancePointGuarded:async(_label,p)=>{assert.equal(p,1);events.push('P1_COMMAND');return true;}};
 assert.equal(await e._pr1ExternalP1Return('test_native_return'),true);
 assert.deepEqual(events,['PAUSE','P1_COMMAND']);
 events.push('P1_ARRIVED');
 await e.onP1();
 if(gateReady)assert.deepEqual(events,['PAUSE','P1_COMMAND','P1_ARRIVED','OPEN_REQUESTED','DOCK']);
 else {assert.equal(events.includes('DOCK'),false);assert.equal(events.includes('FAILSAFE_HOLD'),true);}
}
(async()=>{await run(true);await run(false);console.log('PASS: P1 must arrive before gate command; DOCK only after real open proof');})().catch(e=>{console.error(e);process.exitCode=1});
