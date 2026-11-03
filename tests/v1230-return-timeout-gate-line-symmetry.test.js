'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Garage=require('../lib/garage/GarageSafetyEngine');
const Markers=require('../lib/garage/GarageMarkerEngine');

function fieldGate(){
  const e=Object.create(Garage.prototype);
  const points={lineA:{x:-864,y:-2089},lineB:{x:-880,y:-50},danger:{x:1480,y:-390}};
  const st={point:{x:-6240,y:-1670,source:'mqtt',ts:Date.now()},door:'closed'};
  const motor=[];const debug=[];
  const device={_dockPos:{x:1480,y:-390},_getBufferedLivePosition:()=>st.point,
    getStoreValue:async key=>({'garage_line_a':points.lineA,'garage_line_b':points.lineB,'garage_danger_center':points.danger})[key],
    getSetting:key=>({'garage_danger_radius_mm':900,'garage_danger_hysteresis_mm':150,
      'garage_line_hysteresis_mm':150})[key],setStoreValue:async()=>{},getCapabilityValue:()=>null};
  const markers=new Markers(device);
  Object.assign(e,{_commandToken:10,_returnContext:'IDLE',_manualGateStopped:false,
    device,markers,enabled:()=>true,isDockedHomeStatus:()=>false,
    _homeDockReadyForClose:()=>false,_strongDockCloseProof:()=>false,
    _manualGateOpenDockProof:()=>false,_emergencyCommandBlocked:()=>false,
    pos:()=>st.point,status:()=> 'mowing',doorState:()=>st.door,
    log:(...a)=>debug.push(a.join(' ')),
    _text:de=>de,_isCurrentlyAtKnownMaintenancePoint:async()=>false,
    requestOpen:async()=>{motor.push('open');return true;},
    requestClose:async()=>{motor.push('close');return true;}});
  return {e,motor,debug,setPoint:(x,y)=>{st.point={x,y,source:'mqtt',ts:Date.now()};},setDoor:state=>st.door=state};
}

test('finite safety-line distance protects a mower travelling parallel to the actual garage A/B segment',async()=>{
  const f=fieldGate();
  assert.ok(await f.e.markers.distanceToSafetyLineSegment({x:-1460,y:-1910})<700);
  assert.ok(await f.e.markers.distanceToSafetyLineSegment({x:-2570,y:-2020})>1500);
  assert.ok(await f.e.markers.distanceToSafetyLineSegment({x:-864,y:-2480})<500,
    'endpoint corridor also protected');
});

test('manual OPEN and CLOSE use one strict outdoor proof at field-log coordinates',async()=>{
  const f=fieldGate();
  // 13:39:48 in physical field log, away from A/B: permitted.
  assert.equal(await f.e.manualGateRequest('open'),true);
  // 13:41:57: the circle reports free but mower is only ~600 mm from A/B.
  f.setPoint(-1460,-1910);
  await assert.rejects(f.e.manualGateRequest('open'),/gesperrt/);
  // 13:40:45: CLOSE must not be less strict or more permissive than OPEN.
  f.setPoint(-1240,-1780);
  await assert.rejects(f.e.manualGateRequest('close'),/gesperrt/);
  f.setPoint(-864,-2480);
  await assert.rejects(f.e.manualGateRequest('open'),/gesperrt/);
  // 13:42:36: sufficiently far from BOTH danger circle and line.
  f.setPoint(-2570,-2020);
  assert.equal(await f.e.manualGateRequest('close'),true);
  assert.deepEqual(f.motor,['open','close']);
  assert.ok(f.debug.some(s=>s.includes('safety-line corridor')));
});

test('manual outdoor gate commands fail shut with absent or stale markers; garage-side passage rejected',async()=>{
  const f=fieldGate();
  const original=f.e.markers.distanceToSafetyLineSegment;
  f.e.markers.distanceToSafetyLineSegment=async()=>null;
  await assert.rejects(f.e.manualGateRequest('open'),/gesperrt/);
  await assert.rejects(f.e.manualGateRequest('close'),/gesperrt/);
  f.e.markers.distanceToSafetyLineSegment=original.bind(f.e.markers);
  f.setPoint(4500,-4000); // outside small danger circle but on the garage-side of A-B
  await assert.rejects(f.e.manualGateRequest('open'),/gesperrt/);
  assert.equal(f.motor.length,0);
});

test('direct return after a 20-second vendor timeout depends on physical stop, not MAPD zone deletion',async()=>{
  const e=Object.create(Garage.prototype);
  const now=Date.now();
  const click=now-22000;
  const origin={x:-4330,y:-2260,source:'mqtt',ts:click,mapIndex:0};
  let physical={x:-4330,y:-2260,source:'siid:1:4',ts:now};
  let statusCode=2;
  const device={_activeMapIndex:0,_observedMowerStatus:'mowing',_observedMowerStatusAt:now,
    getData:()=>({id:'A2'}),_api:{getProperties:async()=>({code:0,data:{result:[{siid:2,piid:1,value:statusCode}]}})}};
  Object.assign(e,{_commandToken:3,_manualGateStopped:false,device,
    pos:()=>origin,log:()=>{},_readNativeStationaryPositionForGarage:async()=>physical,
    markers:{rawDangerState:async()=>({known:true,inside:false,distance:4600,radius:900})},
  });
  const checkpoint={stopped:true,verified:false,stopConfirmedAt:click+200,startedAt:click,reason:'checkpoint_timeout'};
  assert.equal(await e._validatedDirectReturnAfterZoneStop(3,{mode:'direct'},origin,checkpoint),true);
  assert.equal(e._returnZoneDirectStopProof.nativeIdleVerified,true);
  statusCode=1;
  assert.equal(await e._validatedDirectReturnAfterZoneStop(3,{mode:'direct'},origin,checkpoint),false,
    'native IDLE cannot be bypassed by an unverified zone');
  statusCode=2;
  assert.equal(await e._validatedDirectReturnAfterZoneStop(3,{mode:'direct'},origin,{...checkpoint,stopped:false}),false);
  physical={...physical,x:-1000};
  assert.equal(await e._validatedDirectReturnAfterZoneStop(3,{mode:'direct'},origin,checkpoint),false,
    'unexpected movement still blocks direct return');
});

test('30-second checkpoint ends when manufacturer never answers without treating zone as deleted',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  const e=Object.create(Garage.prototype);const events=[];
  const device={_activeMapIndex:0,_observedMowerStatus:'idle',_observedMowerStatusAt:100000,
    getData:()=>({id:'A2'}),_returnZoneRemovalCandidates:()=>[{id:102,kind:'native'}],
    _safeWrite:async(_name,fn)=>fn(),
    _api:{stopMowing:async()=>true,getProperties:async()=>({code:0,data:{result:[{siid:2,piid:1,value:2}]}})},
    _syncPylonLifecyclePhase:()=>new Promise(()=>{}),_verifyReturnZoneRemoval:async()=>false};
  Object.assign(e,{device,_commandToken:3,_manualGateStopped:false,
    _confirmedStationLockActive:()=>false,log:(...a)=>events.push(a.join(' ')),
    _timeline:()=>{},_text:s=>s,status:()=> 'idle',refreshTileStatus:async()=>{}});
  const pending=e._prepareReturnZoneCheckpoint(3,'button_dock',{mode:'direct'});
  for(let i=0;i<20;i++) await Promise.resolve();
  assert.ok(events.some(x=>x.includes('stage=native_edit_begin')));
  t.mock.timers.tick(30001);
  const result=await pending;
  assert.equal(result.stopped,true);
  assert.equal(result.verified,false);
  assert.ok(result.stopConfirmedAt>0);
  assert.equal(result.startedAt,100000);
  assert.ok(events.some(x=>x.includes('stage=timeout_native_edit_still_pending_fallback')));
});
