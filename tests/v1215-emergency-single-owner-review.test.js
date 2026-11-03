// Emergency single-owner and user-visible terminal recovery tests.
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Engine=require('../lib/garage/GarageSafetyEngine');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
function build(){
 const e=Object.create(Engine.prototype), events=[];
 let resolve;
 const wait=new Promise(r=>{resolve=r});
 Object.assign(e,{
  _commandToken:11,_manualGateStopped:false,_returnContext:'MAINTENANCE',
  _emergencyGateContext:{mowerMode:'return', originalDoorTarget:'closed', commandToken:11, createdAt:1234},
  device:{getData:()=>({id:'dummy'}),getSetting:()=>false},homey:{i18n:{getLanguage:()=> 'en'}},
  log:()=>{},error:()=>{},_garageOption:()=>false,
  _setSafetyStatus:async(s,r)=>events.push(['status',s,r]),
  _trigger:(id,reason)=>events.push(['flow',id,reason]),
  _timeline:()=>{},_text:(de,en)=>en,
  _lockReturnMaintenancePoint:async()=>{events.push(['lock']);await wait},
  _lockedReturnMaintenancePoint:{index:1},
  _isCurrentlyAtKnownMaintenancePoint:async()=>false,
  safetyBlock:async r=>events.push(['blocked',r]),
  _goToMaintenancePointGuarded:async()=>true,
  _watchMaintenanceReached:()=>{},
 });
 e.device._goToMaintenancePointGuarded=async()=>{events.push(['navigate']);return true};
 return {e,events,resolve};
}
test('emergency dispatch is a single native maintenance action even across concurrent and later events',async()=>{
 const {e,events,resolve}=build();
 const first=e._dispatchEmergencyMaintenance('event1'),second=e._dispatchEmergencyMaintenance('event2');
 resolve();assert.equal(await first,true);assert.equal(await second,true);
 assert.equal(await e._dispatchEmergencyMaintenance('event3'),false);
 assert.equal(events.filter(x=>x[0]==='navigate').length,1);
 assert.equal(events.filter(x=>x[0]==='lock').length,1);
});
test('restoration callback is one-shot across sequential arrivals',async()=>{
 const {e}=build();let recoveries=0;
 e._restoreEmergencyPlanAfterMaintenanceOnce=async()=>{recoveries++;return false};
 assert.equal(await e._restoreEmergencyPlanAfterMaintenance('first'),false);
 assert.equal(await e._restoreEmergencyPlanAfterMaintenance('late duplicate'),false);
 assert.equal(recoveries,1);
});
test('failed restoration issues one actionable manual clearance notice, not new gate commands',async()=>{
 const {e,events}=build();let gate=0;
 e._restoreEmergencyPlanAfterMaintenanceOnce=async()=>{gate++;return false};
 await e._restoreEmergencyPlanAfterMaintenance('first');
 await e._restoreEmergencyPlanAfterMaintenance('again');
 assert.equal(gate,1);
 assert.equal(events.filter(x=>x[0]==='flow'&&x[1]==='garage_position_uncertain').length,1);
 assert.equal(events.filter(x=>x[0]==='status'&&x[1]==='emergency').length,1);
});
test('return recovery does not replay interrupted CLOSE before guarded DOCK',async()=>{
 const {e,events}=build();let closeCalls=0,docks=0;
 e.doorState=()=> 'open';
 e._verifiedMaintenanceReturnClearance=async()=>true;
 e._setReturnContext=()=>{};
 e.clearSafety=async()=>{};
 e._continueReturnFromMaintenance=async(_why,dock)=>{await dock();return true};
 e._waitForEmergencyGateTarget=async()=>{closeCalls++;return true};
 e.device._api={dock:async()=>{docks++;return true}};
 assert.equal(await e._restoreEmergencyPlanAfterMaintenance('dock'),true);
 assert.equal(closeCalls,0);
 assert.equal(docks,1);
});
test('critical UI strings are localized instead of hard-coded',()=>{
 const dash=readFileSync(join(__dirname,'../lib/widgets/MowerDashboard.js'),'utf8');
 const safety=readFileSync(join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
 const history=readFileSync(join(__dirname,'../widgets/history/public/index.html'),'utf8');
 assert.match(dash,/Gate action blocked by safety checks/);
 assert.match(dash,/Invalid mower command/);
 assert.match(safety,/Waiting for fresh standstill confirmation at maintenance point/);
 assert.match(history,/_homey\.getLanguage/);
});

test('exhausted return recovery never repeats PAUSE after later telemetry',async()=>{
 const {e,events}=build(); let pauses=0;
 e._emergencyGateContext=null;
 e.enabled=()=>true;e._safeReturnInProgress=true;
 e._returnRecoveryRequest={token:11,dockFn:async()=>true};
 const hold={token:11,request:e._returnRecoveryRequest,attempts:3,busy:false,timer:null};
 e._returnRecoveryHold=hold;
 e._stopReturnForRecovery=async()=>{pauses++;return false};
 e.safetyWarning=async()=>{};
 for(let n=0;n<4;n++) await e.returnOperationalHold('generic_pause_missing');
 assert.equal(pauses,0);
 assert.equal(events.filter(x=>x[0]==='flow'&&x[1]==='garage_position_uncertain').length,1);
 assert.equal(hold.terminal,true);
});
test('emergency reversal reserves the one motor pulse before asynchronous state write completes',async()=>{
 const {e,events}=build();
 let release;const blocker=new Promise(r=>{release=r});
 e._emergencyGateContext={createdAt:1234,commandToken:11};
 e._emergencyGateWait=null;
 e._doorFinalTimer=null;e._stableOpenTimer=null;
 e.doorState=()=> 'closing';
 e.setDoorState=async()=>{await blocker};
 e._garageNotice=()=>{};
 const first=e._forceDoorDirectionForEmergency('open','test');
 assert.equal(e._emergencyGateContext.reverseIssued,true);
 const duplicate=await e._forceDoorDirectionForEmergency('open','duplicate');
 assert.equal(duplicate,true);
 release();assert.equal(await first,true);
 assert.equal(events.filter(x=>x[0]==='flow'&&x[1]==='garage_open_requested').length,1);
});

test('failed asynchronous gate state update does not resend or emit an emergency motor pulse',async()=>{
 const {e,events}=build();
 e._emergencyGateContext={commandToken:11,createdAt:99};
 e.doorState=()=> 'closing';
 e._garageNotice=()=>{};
 e.setDoorState=async()=>{throw Error('storage temporarily unavailable')};
 e.error=()=>{};
 assert.equal(await e._forceDoorDirectionForEmergency('open','first'),false);
 assert.equal(await e._forceDoorDirectionForEmergency('open','duplicate'),false);
 assert.equal(e._manualRecoveryActive,true);
 assert.equal(e._manualGateStopped,true);
 assert.equal(events.filter(x=>x[0]==='flow'&&x[1]==='garage_open_requested').length,0);
 assert.equal(events.filter(x=>x[0]==='flow'&&x[1]==='garage_position_uncertain').length,1);
});

test('mowing emergency is only restored after native confirmation, not an API ACK',async()=>{
 const {e,events}=build();
 e._emergencyGateContext={commandToken:11,mowerMode:'mowing',createdAt:1234};
 e._setReturnContext=()=>{};e.doorState=()=> 'closed';e.pos=()=>({x:100,y:100,ts:Date.now()});
 e.device._resumeMowingRobust=async()=>true;
 let confirms=0;
 e._confirmEmergencyMowingResumed=async()=>{confirms++;return false};
 assert.equal(await e._resumeInterruptedMissionAfterEmergency(e._emergencyGateContext),false);
 assert.equal(confirms,1);
 assert.ok(e._emergencyGateContext,'unconfirmed emergency remains latched');
});
test('mowing emergency releases after a fresh positive native continuation proof',async()=>{
 const {e}=build();
 e._emergencyGateContext={commandToken:11,mowerMode:'mowing',createdAt:1234};
 e._setReturnContext=()=>{};e.doorState=()=> 'closed';e.pos=()=>({x:100,y:100,ts:Date.now()});
 e.device._resumeMowingRobust=async()=>true;
 e._confirmEmergencyMowingResumed=async()=>true;
 assert.equal(await e._resumeInterruptedMissionAfterEmergency(e._emergencyGateContext),true);
});

test('fresh native mowing plus actual position movement confirms recovery without waiting or another command',async()=>{
 const {e}=build(),now=Date.now();
 const ctx=e._emergencyGateContext;
 e.doorState=()=> 'closed';
 e.device._observedMowerStatus='mowing';e.device._observedMowerStatusAt=now;
 e.pos=()=>({x:430,y:100,ts:now});
 assert.equal(await e._confirmEmergencyMowingResumed(ctx,now-1000,{x:100,y:100}),true);
});
