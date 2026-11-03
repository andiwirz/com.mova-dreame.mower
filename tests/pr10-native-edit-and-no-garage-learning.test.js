'use strict';
// Targeted PR #10 regression checks: native edit safety, learning with Garage
// Mode OFF, and original-app TASK 109 docking-order tolerance.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const prev = Module._load;
let Device;
try {
  Module._load = function(name, parent, main) {
    if (name === 'homey') return {Device:class{}};
    if (name === 'mqtt') return {};
    return prev.call(this,name,parent,main);
  };
  Device = require('../drivers/mower/device');
} finally { Module._load = prev; }
const Garage = require('../lib/garage/GarageSafetyEngine');
const Api = require('../lib/MovaApi');
const acknowledged = {legs:[
  {name:'select',opcode:200,accepted:true,taskAck:true},
  {name:'begin',opcode:204,accepted:true,taskAck:true},
]};
function editing({status=2,read=true,motion=false,garageReturn=false}={}) {
  const now=Date.now();
  const d=Object.create(Device.prototype);
  const g={_commandToken:7,_manualGateStopped:false,_safeReturnInProgress:garageReturn,
    _returnGuardActive:garageReturn,_emergencyHoldActive:()=>false,
    _readNativeStationaryPositionForGarage:async(token,baseline)=>{
      if(!read)return null;
      assert.equal(token,7);
      return {x:100+(motion?600:0),y:200,ts:Date.now(),source:'siid:1:4'};
    },
  };
  Object.assign(d,{_garageSafety:g,_activeMapIndex:0,_nativeMowerStatus:'idle',
    _livePos:{x:100,y:200,ts:now,mapIndex:0},
    getData:()=>({id:'a2'}),_api:{getProperties:async()=>({
      code:0,data:{result:[{siid:2,piid:1,code:0,value:status}]},
    })},_waitForMapEditTask:async()=>true});
  return {d,g};
}
test('ordinary native editor rechecks actual idle and two-position witness after 200/204',async()=>{
  const {d}=editing();
  assert.equal(await d._nonReturnNativeZoneMutationAuthorized(0,acknowledged),true);
  assert.equal(typeof d._pylonMapEditTaskOptions().canMutate,'function');
  assert.equal(await d._pylonMapEditTaskOptions().canMutate(acknowledged),true);
});
test('no mutation if task is PAUSED or moving after editor select/begin',async()=>{
  for(const status of [3,7,8]){
    const {d}=editing({status});
    assert.equal(await d._nonReturnNativeZoneMutationAuthorized(0,acknowledged),false);
  }
});
test('no mutation on missing paired position, conflicting position or return ownership',async()=>{
  for(const opts of [{read:false},{motion:true},{garageReturn:true}]){
    const {d}=editing(opts);
    assert.equal(await d._nonReturnNativeZoneMutationAuthorized(0,acknowledged),false);
  }
});
test('no mutation after map/token shift or absent accepted task legs',async()=>{
  const {d,g}=editing();
  assert.equal(await d._nonReturnNativeZoneMutationAuthorized(1,acknowledged),false);
  assert.equal(await d._nonReturnNativeZoneMutationAuthorized(0,{legs:[]}),false);
  g._readNativeStationaryPositionForGarage=async()=>{
    g._commandToken++;
    return {x:100,y:200,ts:Date.now()};
  };
  assert.equal(await d._nonReturnNativeZoneMutationAuthorized(0,acknowledged),false);
});
test('native editor always commits but skips mutation when fresh idle is lost',async()=>{
  const {d}=editing({status:3});
  const ops=[];
  const api=Object.create(Api.prototype);
  api.sendAction=async(_did,_s,_a,params)=>{
    ops.push(Number(params[0].o));
    return {result:{out:[{status:true,error:0,r:0}]}};
  };
  await assert.rejects(api.runMapEditTransaction('a2',0,
    {m:'a',p:0,o:218,d:{id:102,type:0}},{
      ...d._pylonMapEditTaskOptions(),
      captureTaskCursor:()=>0,
      waitForTask:async()=>({t:'TASK',d:{status:true,error:0}}),
    }),/checkpoint expired/);
  assert.deepEqual(ops,[200,204,201]);
});
test('native editor includes requested mutation after fresh verification',async()=>{
  const {d}=editing();
  const ops=[];
  const api=Object.create(Api.prototype);
  api.sendAction=async(_did,_s,_a,params)=>{
    ops.push(Number(params[0].o));
    return {result:{out:[{status:true,error:0,r:0}]}};
  };
  const result=await api.runMapEditTransaction('a2',0,
    {m:'a',p:0,o:218,d:{id:102,type:0}},{
      ...d._pylonMapEditTaskOptions(),
      captureTaskCursor:()=>0,
      waitForTask:async()=>({t:'TASK',d:{status:true,error:0}}),
    });
  assert.equal(result.ok,true);
  assert.deepEqual(ops,[200,204,218,201]);
});
test('missing named P2 learning with Garage Mode OFF never drives or opens gate',async()=>{
  const e=Object.create(Garage.prototype);
  const actions=[];
  const d={
    getSetting:()=>false,_getGarageManagedSetting:key=>key==='maintenance_point_2_name'?'Lawn end':'',
    _resolveNativeMaintenancePoint:()=>null,_activeMapIndex:0,
    _observedMowerStatus:'idle',_observedMowerStatusAt:Date.now(),
    _refreshNativeDockForStart:async()=>({dockingState:'IN_STATION',undocking:0}),
  };
  Object.assign(e,{device:d,_commandToken:13,paused:false,_manualGateStopped:false,
    _manualRecoveryActive:false,_emergencyGateContext:false,_returnGuardActive:false,
    _safeReturnInProgress:false,_externalStartRecoveryActive:false,
    _externalStartIntentHandling:false,
    enabled:()=>false,isReturnCycleActive:()=>false,
    _emergencyHoldActive:()=>false,
    ensureDoorOpen:async()=>{actions.push('gate_open');throw Error('must not open');},
    log:()=>{},refreshTileStatus:async()=>{}});
  assert.equal(await e.armNamedMissingMaintenancePoint(2,'device_card'),true);
  assert.deepEqual(actions,[]);
  assert.equal(d._pendingExternalMaintenancePointAssociation.index,2);
  assert.equal(d._pendingExternalMaintenancePointAssociation.source,'named_homey_button');
  assert.equal(d._nativeMaintenanceCommandAt,0);
});
test('original-app TASK 109 is deferred at station with no-garage learning intent',()=>{
  const d=Object.create(Device.prototype);
  Object.assign(d,{
    _mowerBinaryDiag:{dockingState:'IN_STATION'},
    _activeMapIndex:0,
    _garageSafety:{_doorOpenVerifiedThisRuntime:()=>false},
    _pendingExternalMaintenancePointAssociation:{index:2,map:0,at:Date.now()},
    _nativeMaintenanceCommandAt:0,
    log:()=>{},
  });
  assert.equal(d._observeExternalMaintenanceTask({o:109,exe:true,status:true}),false);
  assert.equal(d._deferredExternalMaintenanceTask.task.o,109);
});
