'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const Engine=require('../lib/garage/GarageSafetyEngine');
const previousLoad=Module._load;
let Device;
try {
 Module._load=function(id,parent,main){if(id==='homey')return{Device:class{}};if(id==='mqtt')return{};return previousLoad.call(this,id,parent,main);};
 Device=require('../drivers/mower/device');
} finally {Module._load=previousLoad;}
function outsideDevice(){
 const d=Object.create(Device.prototype);
 let door='closed';
 const garage={enabled:()=>true,isMissionOutside:()=>true,isReturnCycleActive:()=>false,doorState:()=>door,noteUserResumeRequested:()=>{},markResumeInProgress:()=>{}};
 d._garageSafety=garage;d._nativeMowerStatus='error';d._mqttErrorCode=27;
 d._lastUserPauseAt=Date.now();d._pauseButtonHoldMode='pause';d._resumeSemanticUntil=Date.now()+120000;
 d.getCapabilityValue=()=> 'error';d.getData=()=>({id:'test'});
 d.log=()=>{};d.homey={setTimeout:()=>{}};
 d._mowerBinaryDiag={dockingState:'OUT_OF_STATION'};d._mowerBinaryDiagAt=Date.now();
 return {d,garage,setDoor:s=>door=s};
}
test('position error 27 after explicit pause can resume with either button and gate remains closed',()=>{
 const {d,setDoor}=outsideDevice();
 assert.equal(d._recoverablePausedOutsideError(),true);
 assert.equal(d._isPausedLike(),true);
 assert.equal(d._commandUnavailableReason('cmd_pause'),null);
 assert.equal(d._canResumePausedOutside(),true);
 setDoor('closing');assert.equal(d._canResumePausedOutside(),false);
 setDoor('closed');d._garageSafety._manualGateStopped=true;assert.equal(d._canResumePausedOutside(),false);
});
test('unrelated faults, no user pause and in-station state never trigger recovery',()=>{
 const {d}=outsideDevice();d._mqttErrorCode=26;assert.equal(d._recoverablePausedOutsideError(),false);
 d._mqttErrorCode=27;d._lastUserPauseAt=0;assert.equal(d._recoverablePausedOutsideError(),false);
 d._lastUserPauseAt=Date.now();d._mowerBinaryDiag.dockingState='IN_STATION';assert.equal(d._canResumePausedOutside(),false);
});
test('outbound four-hit evidence is sampled once per filtered device update',()=>{
 const body=fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
 const onStatus=body.slice(body.indexOf('  async onStatus('),body.indexOf('  async confirmNativeMaintenanceArrival('));
 assert.doesNotMatch(onStatus,/await this\.observeNativeStatusSample\(status\)/);
 const device=fs.readFileSync(path.join(__dirname,'../drivers/mower/device.js'),'utf8');
 assert.match(device,/if \(nativeEvidence && this\._garageSafety\?\.observeNativeStatusSample\)/);
});
test('status phase is five seconds exit then adjustment/positioning until independent proof',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});
 const e=Object.create(Engine.prototype);
 e.enabled=()=>true;e.doorState=()=> 'open';e.isDockedHomeStatus=()=>false;e._homeState='adjusting';
 e._returnContext='IDLE';e._missionOutside=true;
 e._outbound={requiresMowingStable:true,released:true,originalCommandSentAt:100000,departureLineConfirmed:false,stableMowingConfirmed:false};
 assert.equal(e.getTileStatus('mowing'),'garage_exiting');
 t.mock.timers.tick(5000);assert.equal(e.getTileStatus('mowing'),'garage_adjusting');
 t.mock.timers.tick(45000);assert.equal(e.getTileStatus('mowing'),'garage_positioning');
 t.mock.timers.tick(120000);assert.equal(e.getTileStatus('mowing'),'garage_positioning');
 e._outbound.departureLineConfirmed=true;assert.equal(e.getTileStatus('mowing'),'mowing');
});
test('original-app departure sends STOP before any Homey status write',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
 const body=src.slice(src.indexOf('  async onExternalStartIntent('),src.indexOf('  async onExternalMowingDetected('));
 const pause=body.indexOf("garage_external_start_intent_pause");
 const stop=body.indexOf('await this._stopExternalStartOldTaskEarly(source, did)');
 const status=body.indexOf("await this.device._applyStatus('paused')");
 assert.ok(pause>=0 && stop>pause && status>stop);
});
test('failed positioning-error resume does not promote tile to mowing',async()=>{
 const {d}=outsideDevice();let statuses=0,writes=0;
 d._api={resume:async()=>{writes++;return true;},startMowing:async()=>{writes++;return true;}};
 d._safeWrite=async(_name,fn)=>fn();
 d._poll=async()=>{d._observedMowerStatus='error';d._observedMowerStatusAt=Date.now();};
 d._applyStatus=async()=>{statuses++;};
 d._updateCommandButtonUi=async()=>{};
 const result=await d._resumeMowingRobust('test');
 assert.equal(result,false);assert.ok(writes>=1);assert.equal(statuses,0);
 assert.equal(d._pauseButtonHoldMode,'resume');
 assert.equal(d._resumeSemanticUntil,0);
});
