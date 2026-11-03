'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Engine=require('../lib/garage/GarageSafetyEngine');
const Dashboard=require('../lib/widgets/MowerDashboard');
function fixture({atPoint=false,operatorOutside=true,wrongLine=false,moving=false,gateOpen=false,pointOutside=true}={}) {
 const calls=[],store=new Map(),now=Date.now();
 const d={getId:()=> 'm',getData:()=>({id:'m'}),getName:()=> 'MOVA',getSetting:()=>true,
 getCapabilityValue:()=> 'idle',setStoreValue:async(k,v)=>{store.set(k,v);calls.push('store:'+k);},
 _mowerBinaryDiag:{dockingState:'OUT_OF_STATION',undocking:0,chargingLive:false},_mowerBinaryDiagAt:Date.now(),
 _observedMowerStatus:moving?'mowing':'idle',_observedMowerStatusAt:Date.now(),_dockPos:{x:0,y:0},_activeMapIndex:0,
 _api:{getMowerPosition:async()=>{calls.push('pos');return {x:5000,y:-4000}},goToMaintenancePoint:async(...a)=>{calls.push('point:'+a[2]);return true}},
 _safeWrite:async(_label,fn)=>fn(),_resolveNativeMaintenancePoint:async(n)=>({x:5000+(n-1)*300,y:-4000})};
 const e=Object.assign(Object.create(Engine.prototype),{
 device:d,paused:true,_manualRecoveryActive:true,_manualGateStopped:true,
 _manualRecoveryOperatorFree:true,_manualRecoveryPhase:'manual_hold',
 _manualOperatorPosition:operatorOutside?'outside':'unknown',_manualRecoveryMowerCommandBusy:false,_manualRecoveryGateCommandBusy:false,
 _manualRecoveryGatePulseAt:0,_manualRecoveryOpenConfirmedAt:gateOpen?now:0,
 _manualRecoveryGateClosedAt:now,_lastSensorContactState:'closed',_lastSensorContactAt:now-600000,
 _manualMaintenanceReached:atPoint,_manualMaintenancePhase:atPoint?'reached':'none',_manualMaintenanceTargetReachedIndex:atPoint?2:0,
 _lastAdditionalMaintenanceReached:atPoint?{index:2,at:now}:null,_lastMaintenanceReachedAt:0,_commandToken:1,
 sensorEnabled:()=>true,sensorHealthy:()=>true,doorState:()=>gateOpen?'open':'closed',
 status:()=>moving?'mowing':'idle',log:()=>{},clearSafety:async()=>{},_stopManualReturnWatch:()=>{},
 markers:{rawDangerState:async()=>({known:true,inside:false,distance:5000,radius:900}),
 distanceToSafetyLineSegment:async()=>pointOutside?2600:50,
 signedDistanceToLine:async()=>({distance:wrongLine?-2600:2600}),directionState:async()=>({known:true,lawnSide:1})}
 });
 d._garageSafety=e;e.pos=()=>({x:5000,y:-4000,source:'mqtt',ts:Date.now()});
 e._manualRecoveryFreshDockRearmProof=async()=>{e._manualRecoveryDockRearmLast={result:'dock_not_locked'};return false};
 const homey={drivers:{getDriver:()=>({getDevices:()=>[d]})},i18n:{getLanguage:()=> 'de'}};
 return {e,d,calls,store,homey};
}
test('outdoor position + closed gate can rearm without native dock or motor command',async()=>{
 const {e,homey,calls,store}=fixture();
 const r=await Dashboard.command({homey,query:{deviceId:'m'},body:{action:'recovery_restore_normal',supervised:true}});
 assert.equal(r.restored,true);assert.equal(e._manualRecoveryActive,false);assert.equal(e._missionOutside,true);
 assert.equal(e._confirmedNativeStationLock,false);assert.equal(store.get('garage_manual_recovery_active'),false);
 assert.equal(calls.filter(x=>x==='pos').length,2);
 assert.ok(!calls.some(x=>x.startsWith('point:')||x==='dock'||x==='door'));
});
test('native P2 arrival enables outdoor rearm without visual outside click',async()=>{
 const {e,homey}=fixture({atPoint:true,operatorOutside:false});
 const r=await Dashboard.command({homey,query:{deviceId:'m'},body:{action:'recovery_restore_normal',supervised:true}});
 assert.equal(r.restored,true);
});
test('outdoor rearm rejects moving mower, wrong safety-line side and unknown location',async()=>{
 for(const opts of [{moving:true},{wrongLine:true},{operatorOutside:false}]) {
  const {e,homey,store}=fixture(opts);
  await assert.rejects(()=>Dashboard.command({homey,query:{deviceId:'m'},body:{action:'recovery_restore_normal',supervised:true}}));
  assert.equal(e._manualRecoveryActive,true);assert.notEqual(store.get('garage_manual_recovery_active'),false);
 }
});
test('native waypoint command with CLOSED gate only for verified outdoor lawn-side target',async()=>{
 const {e,calls}=fixture();
 assert.equal(await e.manualRecoveryDirectMaintenance(2,true),true);
 assert.equal(calls.filter(x=>x==='point:2').length,1);
 const x=fixture({pointOutside:false});
 assert.equal(await x.e.manualRecoveryDirectMaintenance(2,true),false);
 assert.equal(x.calls.filter(y=>y.startsWith('point:')).length,0);
});
test('widget minimal visible buttons: outdoor confirm and restore, emergency advanced collapsed',()=>{
 const root=path.resolve(__dirname,'..');const ui=fs.readFileSync(path.join(root,'widgets/overview/public/dashboard.js'),'utf8');
 const html=fs.readFileSync(path.join(root,'widgets/overview/public/index.html'),'utf8');
 assert.match(html,/data-action="recovery_position_outside"/);
 assert.match(ui,/restore.hidden=!manualEmergency&&!recentlyRestored/);
 assert.match(ui,/more.open=false/);
 assert.match(ui,/doorActions.hidden=!gateMotorAccessible/);
 assert.match(ui,/gateMotorAccessible=\(!!r.manualRecovery && !!r.manualOperatorFree\)/);
});
