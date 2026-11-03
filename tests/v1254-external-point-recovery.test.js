'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad=Module._load;
let Device, Garage;
try {
  Module._load=function(id,parent,main){
    if(id==='homey')return {Device:class{}};
    if(id==='mqtt')return {};
    return originalLoad.call(this,id,parent,main);
  };
  Device=require('../drivers/mower/device');
  Garage=require('../lib/garage/GarageSafetyEngine');
} finally { Module._load=originalLoad; }

function deviceFixture(){
 const d=Object.create(Device.prototype),store=new Map();
 d.homey={i18n:{getLanguage:()=> 'de'}};
 d.getSetting=(k)=>({garage_mode_enabled:false})[k];
 d.getSettings=()=>({});
 d.getStoreValue=async k=>store.get(k);
 d.setStoreValue=async(k,v)=>{store.set(k,v);};
 d._garageMaintenanceConfig={primary:2,rotation:'alternate'};
 d._garageRepairSettings={maintenance_point_2_name:'Wartungspunkt 2'};
 d._activeMapIndex=0;
 d._storedAdditionalMaintenancePoints={};
 d._cachedMapData={nativeMaintenancePoints:[{index:1,x:-3000,y:-4800}]};
 d._resolveStableMaintenancePoint=async()=>({index:1,x:-3000,y:-4800});
 d._syncAdditionalMaintenancePointCapabilities=async()=>{};
 d._syncPrimaryMaintenancePointCapability=async()=>{};
 d._scheduleMapCameraImageUpdate=()=>{};
 d.log=()=>{};d.error=()=>{};
 return {d,store};
}

test('unknown original-app TASK must not silently become a mowing start',async()=>{
 const g=Object.create(Garage.prototype);
 let calls=0;
 g.device={_activeMapIndex:0,_api:{startMowing:async()=>calls++}};
 g.log=()=>{};
 g._externalStartTask=null;
 assert.equal(await g._dispatchRecoveredMowingTask('mower'),false);
 assert.equal(calls,0);
 g._externalStartTask={o:109};
 assert.equal(await g._dispatchRecoveredMowingTask('mower'),false);
 assert.equal(calls,0);
 g._externalStartTask={o:100};
 assert.equal(await g._dispatchRecoveredMowingTask('mower'),0);
 assert.equal(calls,1);
});

test('stranded named primary P2 can be deleted and safely falls back to fixed P1',async()=>{
 const {d,store}=deviceFixture();
 const result=await d.updateMaintenancePointName(2,'',false);
 assert.deepEqual({name:result.name,primary:result.primary},{name:'',primary:false});
 assert.equal(d._maintenancePointIndex(),1);
 assert.equal(d._garageMaintenanceConfig.rotation,'fixed');
 assert.equal(store.get('garage_repair_settings_v1').values.maintenance_point_2_name,'');
 assert.equal(store.get('garage_maintenance_configuration_v1').primary,1);
});

test('rotation preference can be changed during a one-point recovery state',async()=>{
 const {d}=deviceFixture();
 assert.equal(d._validateGarageMaintenanceAdvancedChange({primary:1,rotation:'fixed',garageEnabled:true}).rotation,'fixed');
 assert.equal(d._validateGarageMaintenanceAdvancedChange({primary:2,rotation:'alternate',garageEnabled:true}).rotation,'alternate');
 assert.equal(d._maintenanceFlowRotationEnabled(),false);
});

test('external code-109 task is learned even without Homey cmd_maintenance_point',()=>{
 const {d}=deviceFixture();
 const now=Date.now();
 d._mowerBinaryDiag={dockingState:'OUT_OF_STATION'};
 d._nativeMaintenanceCommandAt=0;
 d._livePos={x:-6530,y:-1300,ts:now};
 d._getBufferedLivePosition=()=>d._livePos;
 assert.equal(d._observeExternalMaintenanceTask({o:109,exe:true,status:true}),true);
 assert.equal(d._nativeMaintenanceCommandSource,'original_app');
 assert.equal(d._nativeMaintenanceTargetIndex,2);
 assert.equal(d._nativeMaintenanceIndexInferred,true);
 assert.equal(d._nativeMaintenanceArrivalCommitted,false);
});

test('inferred external P2 arrival cannot overwrite known P1, but passes far-side geometry',async()=>{
 const {d}=deviceFixture();
 d._nativeMaintenanceTargetIndex=2;
 d._nativeMaintenanceIndexInferred=true;
 assert.equal(await d._externalMaintenanceArrivalIndex({x:-3000,y:-4800}),null);
 assert.equal(await d._externalMaintenanceArrivalIndex({x:-5850,y:-7510}),2);
});

test('external firmware-completed P2 with fresh position is durably stored without touching P1',async()=>{
 const {d,store}=deviceFixture();
 const now=Date.now();
 d._nativeMaintenanceCommandAt=now-9000;
 d._nativeMaintenanceCommandSource='original_app';
 d._nativeMaintenanceTargetIndex=2;
 d._nativeMaintenanceIndexInferred=true;
 d._nativeMaintenanceCommandStartPosition={x:-6530,y:-1300,ts:now-9000};
 d._nativeMaintenanceArrivalClosed=false;
 d._nativeMaintenanceArrivalCommitted=false;
 d._nativeMaintenanceArrivalLatched=false;
 d._pendingNativeMaintenanceArrival={at:now-1000,expiresAt:now+45000,targetIndex:2,reason:'native_additional_point_status_75_stable'};
 d._getBufferedLivePosition=()=>({x:-5850,y:-7510,ts:Date.now(),source:'mqtt'});
 d._garageSafety={confirmNativeMaintenanceArrival:async()=>true};
 assert.equal(await d._commitPendingNativeMaintenanceArrival(),true);
 assert.equal(store.get('native_additional_maintenance_points_v1')['0']['2'].x,-5850);
 assert.equal(d._cachedMapData.nativeMaintenancePoints.find(p=>p.index===1).x,-3000);
});


test('original-app learning rejects stale positions and does not interpret map idx as point number',()=>{
 const {d}=deviceFixture();
 d._mowerBinaryDiag={dockingState:'OUT_OF_STATION'};
 d._nativeMaintenanceCommandAt=0;
 d._livePos={x:-6500,y:-1300,ts:Date.now()-22000};
 d._getBufferedLivePosition=()=>d._livePos;
 assert.equal(d._observeExternalMaintenanceTask({o:109,exe:true,status:true,idx:2}),false);
 d._livePos={...d._livePos,ts:Date.now()};
 assert.equal(d._observeExternalMaintenanceTask({o:109,exe:true,status:true,idx:1}),true);
 assert.equal(d._nativeMaintenanceTargetIndex,2); // only named missing P2, not generic idx
 assert.equal(d._nativeMaintenanceIndexInferred,true);
});

test('maintenance view permits removing an orphaned currently selected P2',()=>{
 const fs=require('node:fs');
 const html=fs.readFileSync(require('node:path').join(__dirname,'../drivers/mower/repair/maintenance_settings.html'),'utf8');
 assert.ok(html.includes("$('remove').disabled=!!cfg.busy||index===1||!nameOf(index);"));
 assert.ok(!html.includes('if(index===1||index===Number(cfg.selected||1))return;'));
});


test('manufacturer P2 TASK received at verified OPEN gate is observed after real undocking',async()=>{
 const {d}=deviceFixture();
 d._garageSafety={_doorOpenVerifiedThisRuntime:()=>true};
 d._mowerBinaryDiag={dockingState:'IN_STATION'};
 d._livePos={x:-6500,y:-1300,ts:Date.now()};
 d._getBufferedLivePosition=()=>d._livePos;
 d._nativeMaintenanceCommandAt=0;
 assert.equal(d._observeExternalMaintenanceTask({o:109,exe:true,status:true}),false);
 assert.ok(d._deferredExternalMaintenanceTask);
 d._mowerBinaryDiag={dockingState:'OUT_OF_STATION'};
 await d._observeNativeMaintenanceArrival(1,'mowing',0,'mqtt_status');
 assert.equal(d._nativeMaintenanceCommandSource,'original_app');
 assert.equal(d._nativeMaintenanceTargetIndex,2);
 assert.equal(d._deferredExternalMaintenanceTask,null);
});
