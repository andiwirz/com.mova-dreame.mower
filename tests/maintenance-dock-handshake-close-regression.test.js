'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Engine=require('../lib/garage/GarageSafetyEngine');
function engine(){
 const e=Object.create(Engine.prototype),events=[];
 Object.assign(e,{device:{_nativeMaintenanceCommandAt:Date.now()-80},_commandToken:3,
  _manualMaintenanceTransit:true,_manualMaintenanceReached:false,_maintenanceRequestedAt:Date.now()-100,
  _maintenanceWatch:{},_maintenanceReachedCallback:async()=>events.push('arrival-close'),
  _outbound:{action:'button_maintenance'},_returnContext:'IDLE',_safeReturnInProgress:false,_returnGuardActive:false,
  _text:(de,en)=>en,log:(...args)=>events.push(args.join(' ')),doorState:()=> 'open',
  _invalidateHomeClose:()=>{},_resumeDeferredHomeClose:()=>events.push('home-close'),
  cancelPendingCommand(){this._commandToken++;this._maintenanceWatch=null;this._maintenanceReachedCallback=null;},
 });return {e,events};
}
test('station heartbeat immediately after explicit maintenance dispatch preserves the arrival and guarded-close owner until actual undock',async()=>{
 const {e,events}=engine();
 e.noteHomeDockTelemetry({dockingState:'IN_STATION',undocking:0,chargingLive:true});
 assert.equal(e._commandToken,3);assert.ok(e._maintenanceWatch);assert.ok(e._maintenanceReachedCallback);
 assert.ok(!events.includes('home-close'));
 e.noteHomeDockTelemetry({dockingState:'IN_STATION',undocking:1,chargingLive:true});
 assert.equal(e._commandToken,3);assert.ok(e._maintenanceReachedCallback);
 await e._maintenanceReachedCallback();assert.ok(events.includes('arrival-close'));
});
test('actual dock proof still cancels automatic return navigation and an expired departure handshake',()=>{
 for(const mode of ['return','expired']){
  const {e}=engine();if(mode==='return'){e._returnContext='MAINTENANCE';e._safeReturnInProgress=true;e._returnGuardActive=true;}
  else e.device._nativeMaintenanceCommandAt=Date.now()-11000;
  e.noteHomeDockTelemetry({dockingState:'IN_STATION',undocking:0,chargingLive:true});
  assert.equal(e._commandToken,4);assert.equal(e._maintenanceReachedCallback,null);
  assert.equal(e._returnContext,'HOME_CONFIRMED');
 }
});
