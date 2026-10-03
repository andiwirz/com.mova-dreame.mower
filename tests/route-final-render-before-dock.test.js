'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');

const originalLoad=Module._load;
let Device;
try {
  Module._load=function(id,parent,main){
    if(id==='homey') return {Device:class{}};
    if(id==='mqtt') return {};
    return originalLoad.call(this,id,parent,main);
  };
  Device=require('../drivers/mower/device');
} finally { Module._load=originalLoad; }

function fixture(){
  const d=Object.create(Device.prototype);
  d._activeMapIndex=0;
  d._cachedMapData={livePath:[[0,0],[1000,10],[2000,-10]]};
  d._liveRouteTrail=[];
  d._wasMowingSession=true;
  d._completedMapRoute=null;
  d._durableRoute={
    entry:()=>({active:true}),
    path:()=>[[0,0],[1000,10],[2000,-10]],
    ingest:()=>{}, snapshot:()=>({schema:1,maps:{}}),
  };
  d._collectDurableRoute=()=>{};
  d.setStoreValue=async()=>{};
  d._scheduleMapCameraImageUpdate=()=>{};
  d.log=()=>{};
  return d;
}

test('returning freezes mowing geometry before the dock path can be appended',async()=>{
  const d=fixture();
  const ok=await d._freezeCompletedMapRouteForDisplay('returning_transition',{definitive:false});
  assert.equal(ok,true);
  assert.equal(d._completedMapRoute.visualFinal,true);
  assert.equal(d._completedMapRoute.definitive,false);
  assert.deepEqual(d._completedMapRoute.path,[[0,0],[1000,10],[2000,-10]]);

  // Simulate a later return-to-dock segment in the durable route. Definitive
  // completion must upgrade metadata without replacing the already frozen lawn.
  d._durableRoute.path=()=>[[0,0],[1000,10],[2000,-10],[2600,900],[3200,1700]];
  await d._freezeCompletedMapRouteForDisplay('confirmed_home',{definitive:true});
  assert.equal(d._completedMapRoute.definitive,true);
  assert.deepEqual(d._completedMapRoute.path,[[0,0],[1000,10],[2000,-10]]);
});

test('mowing resume cancels a provisional/final visual snapshot',async()=>{
  const d=fixture();
  d._completedMapRoute={mapIndex:0,path:[[0,0],[1000,0]],visualFinal:true,definitive:false};
  await d._clearVisualRouteCompletion('native_mowing_resumed');
  assert.equal(d._completedMapRoute,null);
});
