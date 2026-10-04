'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {setImmediate:turn}=require('node:timers/promises');const Engine=require('../lib/garage/GarageSafetyEngine');
function fixture(){const e=Object.create(Engine.prototype);let state='open';const flows=[],blocks=[];Object.assign(e,{_commandToken:7,_homeState:'away',_returnContext:'IDLE',device:{getData:()=>({id:'fixture'}),getSetting:()=>null,getCapabilityValue:()=>null},enabled:()=>true,log:()=>{},error:()=>{},_logCloseReport:()=>{},safetyWarning:async x=>blocks.push(x),safetyBlock:async x=>blocks.push(x),markerSetupWarning:async()=>{},doorState:()=>state,setDoorState:async x=>{state=x;},_trigger:x=>flows.push(x),sensorEnabled:()=>false,sensorHealthy:()=>false,sensorDoorReliable:()=>false,sensorDoorMonitoringEnabled:()=>false,_doorCloseDurationSeconds:()=>10,_restoreSensorOnlineIfRecent:async()=>{},_rawDangerExitConfirmed:()=>true,_outboundCloseBlockedByMode:()=>({blocked:false}),status:()=> 'mowing'});
 const report={ready:true,insideDanger:false,door:'open',positionKnown:true,home:'away',nativeStatus:'mowing',lineToLawnConfirmed:true,lineState:'DOOR_CLOSE_ALLOWED'};e.closeGuardReport=async(_r,opts)=>({...report,requireExitConfirmed:!!opts.requireExitConfirmed});return{e,flows,blocks,report,state:x=>{state=x;}};}
for(const [name,setup,allowed,opts] of [
 ['confirmed outside permits closing',()=>{},true,{}],
 ['mower inside danger blocks closing',f=>{f.report.insideDanger=true;},false,{}],
 ['returning wins over previous exit',f=>{f.report.nativeStatus='returning';f.e._lineToLawnConfirmed=true;f.e._lineState='DOOR_CLOSE_ALLOWED';},false,{requireExitConfirmed:true}],
 ['return context wins over paused status',f=>{f.report.nativeStatus='paused';f.e._safeReturnInProgress=true;},false,{}],
 ['maintenance transit blocks closing',f=>{f.e._manualMaintenanceTransit=true;f.e._manualMaintenancePhase='adjusting';},false,{}],
 ['outbound protected window blocks stale home',f=>{f.e._outbound={requestedAt:Date.now()};f.report.home='home';f.report.nativeStatus='charging';f.e.device._chargingStatusAt=Date.now();f.e.device.getCapabilityValue=()=> 'charging';},false,{}],
 ['manual STOP wins over fresh home',f=>{f.e._manualGateStopped=true;f.report.home='home';},false,{}],
 ['unknown position plus old charging does not permit closing',f=>{f.report.positionKnown=false;f.report.home='home';f.report.nativeStatus='charging';},false,{}],
 ['15s stable charging dock permits home close without map position',f=>{f.report.positionKnown=false;f.report.ready=false;f.report.insideDanger=true;f.report.home='home';f.e.status=()=> 'charging';f.e._homeDockStableSince=Date.now()-15000;f.e._homeDockLastProofAt=Date.now();f.e.device._mowerBinaryDiag={dockingState:'IN_STATION',undocking:0,chargingLive:true};f.e.device._mowerBinaryDiagAt=Date.now();},true,{}],
 ['no exit-line release blocks outdoor close',f=>{f.e._missionOutside=true;},false,{}],
 ['verified line allows outdoor close',f=>{f.e._missionOutside=true;f.e._lineToLawnConfirmed=true;f.e._lineState='DOOR_CLOSE_ALLOWED';},true,{requireExitConfirmed:true}],
])test(name,async t=>{t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});const f=fixture();setup(f);assert.equal(await f.e.requestClose('test',opts),allowed);assert.equal(f.flows.includes('garage_close_requested'),allowed);});
test('closed-door wait has a defined command token; STOP cancels it',async t=>{t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});const f=fixture();f.state('closed');assert.equal(await f.e._waitForDoorClosedOrTimeout(),true);f.state('closing');const pending=f.e._waitForDoorClosedOrTimeout();f.e._manualGateStopped=true;f.e._commandToken++;t.mock.timers.tick(500);assert.equal(await pending,false);});
test('STOP during asynchronous close report never emits a CLOSE flow',async()=>{const f=fixture();f.e.closeGuardReport=async()=>{f.e._manualGateStopped=true;f.e._commandToken++;return f.report;};assert.equal(await f.e.requestClose('test'),false);assert.deepEqual(f.flows,[]);});
test('STOP during asynchronous OPEN state change never emits OPEN flow',async()=>{const f=fixture();f.state('closed');f.e.markers={dangerState:async()=>({inside:false})};f.e.setDoorState=async()=>{f.e._manualGateStopped=true;f.e._commandToken++;};assert.equal(await f.e.requestOpen('test'),false);assert.deepEqual(f.flows,[]);});
test('old timer-open handshake cannot release a newer command',async t=>{t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});const f=fixture();f.e._doorOpenDurationSeconds=()=>10;f.e.requestOpen=async()=>true;const p=f.e.ensureDoorOpen('test');await turn();f.e._commandToken++;t.mock.timers.tick(10000);await turn();assert.equal(await p,false);assert.equal(f.flows.includes('garage_door_stable_open'),false);});
test('only fresh native pause acknowledgement satisfies stop wait',async t=>{t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});const f=fixture();f.e.device._nativeMowerStatus='paused';const pending=f.e._waitForNativePause(7,100000);await turn();f.e.device._observedMowerStatus='paused';f.e.device._observedMowerStatusAt=100250;t.mock.timers.tick(250);assert.equal(await pending,true);});
test('STOP during return preparation cannot issue maintenance command',async()=>{const f=fixture();let calls=0;f.e._prepareMowerForReturnPath=async()=>{f.e._manualGateStopped=true;f.e._commandToken++;};assert.equal(await f.e._sendMaintenanceWithRetry(async()=>{calls++;},7),false);assert.equal(calls,0);});
test('manual STOP suppresses emergency recovery, gate reversal and maintenance dispatch',async()=>{const f=fixture();f.e._manualGateStopped=true;assert.equal(await f.e._dispatchEmergencyMaintenance('test'),false);assert.equal(await f.e._forceDoorDirectionForEmergency('open','test'),false);assert.equal(await f.e._restoreEmergencyPlanAfterMaintenanceOnce('test'),false);assert.deepEqual(f.flows,[]);});
test('freshness check rejects missing, future and old route timestamps',()=>{const f=fixture();for(const ts of [0,Date.now()+1000,Date.now()-31000]){f.e.pos=()=>({x:1,y:2,ts});assert.equal(f.e._freshPositionForExitDecision(),null);}f.e.pos=()=>({x:1,y:2,ts:Date.now()});assert.ok(f.e._freshPositionForExitDecision());});

test('new STOP while manual OPEN checks geometry is never cleared',async()=>{const f=fixture();f.e.pos=()=>({x:1,y:1,ts:Date.now()});f.e.markers={rawDangerState:async()=>{f.e._commandToken++;f.e._manualGateStopped=true;return{known:true,distance:2000,radius:500};}};assert.equal(await f.e.manualGateRequest('open'),false);assert.equal(f.e._manualGateStopped,true);assert.deepEqual(f.flows,[]);});

test('fresh charging HOME cannot bypass the 15-second interlock through a direct close request',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
 const f=fixture();f.report.home='home';f.report.nativeStatus='charging';f.e.status=()=> 'charging';
 f.e.device._mowerBinaryDiag={dockingState:'IN_STATION',undocking:0,chargingLive:true};
 f.e.device._mowerBinaryDiagAt=Date.now();
 f.e._homeDockStableSince=Date.now()-14999;f.e._homeDockLastProofAt=Date.now();
 assert.equal(await f.e.requestClose('another_close_path'),false);
 assert.equal(f.flows.includes('garage_close_requested'),false);
});
test('dock loss during asynchronous door-state update prevents physical CLOSE flow',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
 const f=fixture();f.report.home='home';f.report.nativeStatus='charging';f.e.status=()=> 'charging';
 f.e.device._mowerBinaryDiag={dockingState:'IN_STATION',undocking:0,chargingLive:true};
 f.e.device._mowerBinaryDiagAt=Date.now();f.e._homeDockStableSince=85000;f.e._homeDockLastProofAt=100000;
 f.e.setDoorState=async state=>{if(state==='closing')f.e._invalidateHomeClose('dock_departure');};
 assert.equal(await f.e.requestClose('home_15s'),false);
 assert.equal(f.flows.includes('garage_close_requested'),false);
});
