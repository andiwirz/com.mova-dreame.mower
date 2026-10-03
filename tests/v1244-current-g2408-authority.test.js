'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let Device;
try {
  Module._load = function(id, parent, main) {
    if (id === 'homey') return { Device: class {} };
    if (id === 'mqtt') return {};
    return originalLoad.call(this, id, parent, main);
  };
  Device = require('../drivers/mower/device');
} finally { Module._load = originalLoad; }

function mmSquare(id, cx, cy, half = 500) {
  return [id, { id, type:2, shapeType:2, path:[
    {x:cx-half,y:cy-half},{x:cx+half,y:cy-half},
    {x:cx+half,y:cy+half},{x:cx-half,y:cy+half},
  ] }];
}
function zone(id, cxRaw, cyRaw, halfRaw = 50) {
  return { id, type:2, description:{ type:2, points:[
    [cxRaw-halfRaw,cyRaw-halfRaw],[cxRaw+halfRaw,cyRaw-halfRaw],
    [cxRaw+halfRaw,cyRaw+halfRaw],[cxRaw-halfRaw,cyRaw+halfRaw],
  ] } };
}
function payload(zones = []) {
  return {
    cut_relation:[],
    map:[{id:1,type:0,area:100,data:[[-900,-400],[200,-400],[200,500],[-900,500]]}, ...zones],
    name:'Garden',point:[],semantic:[],spot:[],total_area:100,trajectory:[],
  };
}
function base(ids = [101,102,106]) {
  const centers={101:[-8000,-1000],102:[-7000,-1000],103:[-6500,-1000],104:[-7755,-2425],106:[-6000,-1000]};
  return {
    boundary:{x1:-10000,y1:-10000,x2:10000,y2:10000},name:'Map',md5sum:'cloud-stale',
    mowingAreas:[[1,{id:1,path:[{x:-9000,y:-4000},{x:2000,y:-4000},{x:2000,y:5000},{x:-9000,y:5000}]}]],
    forbiddenAreas:ids.map(id=>mmSquare(id,...centers[id],id===104?500:500)),
    spotAreas:[],contours:[],mapObstacles:[],livePath:[],
  };
}
function makeDevice(ids=[101,102,106]) {
  const d=Object.create(Device.prototype);
  d._activeMapIndex=0;
  d._devModel='dreame.mower.g2408';
  d._cachedMapData=base(ids);
  d._obstacleRulesCache={};
  d._nativeZoneLabelsCache={};
  d._nativeZoneLabelDeleteWatches={};
  d._directNativeDeleteUi=new Map();
  d._directNativeDeleteTimers=new Map();
  d._pendingPylonReadbackTimers=new Map();
  d._pylonUiRevision=0;
  d.log=()=>{}; d.error=()=>{};
  d.setStoreValue=async()=>{}; d.unsetStoreValue=async()=>{};
  d._clearPendingPylonReadback=()=>{};
  d._clearDirectNativeDeleteReadback=()=>{};
  d.getData=()=>({id:'mower'});
  d.getSetting=(key)=> key==='map_safe_mowing' ? true : (key==='device_model_id' ? 'dreame.mower.g2408' : null);
  d._logNativeForbiddenReadOnly=()=>{};
  return d;
}

test('1.2.44 real g2408 top-level map publishes all current native zones even when cloud base knows only three', () => {
  const d=makeDevice([101,102,106]);
  const parsed=d._parseAppActionMapPayload({idx:0,hash:'live-five',size:3600,chunkCount:9,payload:payload([
    zone(101,-800,-100),zone(102,-700,-100),zone(103,-650,-100),zone(104,-775.5,-242.5),zone(106,-600,-100),
  ])},d._cachedMapData);
  assert.equal(parsed.directMapdGeometryVerified,true);
  assert.equal(parsed.directMapdAuthority,'g2408_top_level_map');
  assert.deepEqual(parsed.directMapdCandidateIds,[101,102,103,104,106]);
  assert.deepEqual(parsed.directMapdTrustedIds,[101,102,103,104,106]);
  assert.deepEqual(parsed.forbiddenAreas.map(e=>e[0]),[101,102,103,104,106]);
});

test('1.2.44 real g2408 can authoritatively report zero native zones after the last one is deleted', () => {
  const d=makeDevice([101]);
  const parsed=d._parseAppActionMapPayload({idx:0,hash:'empty-current',size:2500,chunkCount:7,payload:payload([])},d._cachedMapData);
  assert.equal(parsed.directMapdGeometryVerified,true);
  assert.equal(parsed.directMapdAuthority,'g2408_top_level_map');
  assert.deepEqual(parsed.forbiddenAreas,[]);
});

test('1.2.44 persisted create with stale beforeIds is recovered from one exact current g2408 square', async () => {
  const d=makeDevice([101,102,106]);
  const rid='geo:0:-7750:-2400';
  d._obstacleRulesCache={
    [rid]:{pending:'create',mapIndex:0,nativeId:null,beforeIds:[101,102,104,106],nativeCandidateId:null,
      centerX:-7755,centerY:-2425,radius:500,nativeWriteVersion:6,action:'observe',updatedAt:Date.now()-20000,
      mapRevisionAdvancedAt:Date.now()-18000},
  };
  const pyl={id:'obs:3',x:-7755,y:-2425,source:'obs',coordinateScaleUncertain:false};
  d._buildObstaclePylons=()=>[pyl];
  d._findPylonForRule=()=>pyl;
  const parsed=d._parseAppActionMapPayload({idx:0,hash:'current',size:3400,chunkCount:9,payload:payload([
    zone(101,-800,-100),zone(102,-700,-100),zone(104,-775.5,-242.5),zone(106,-600,-100),
  ])},d._cachedMapData);
  await d._reconcilePylonNativeRules(parsed,{fresh:true});
  assert.equal(d._obstacleRulesCache[rid].pending,null);
  assert.equal(d._obstacleRulesCache[rid].nativeId,104);
  assert.equal(d._obstacleRulesCache[rid].verification,'native_square_create_confirmed_recovered');
});

test('1.2.44 verified current g2408 MAPD releases an unmatched create after revision advance instead of spinning for minutes', async () => {
  const d=makeDevice([101,102,106]);
  const rid='geo:0:-7900:-700';
  d._obstacleRulesCache={
    [rid]:{pending:'create',mapIndex:0,nativeId:null,beforeIds:[101,102,106],nativeCandidateId:null,
      centerX:-7900,centerY:-700,radius:500,nativeWriteVersion:6,action:'observe',updatedAt:Date.now()-20000,
      mapRevisionAdvancedAt:Date.now()-18000},
  };
  const pyl={id:'obs:1',x:-7900,y:-700,source:'obs',coordinateScaleUncertain:false};
  d._buildObstaclePylons=()=>[pyl];
  d._findPylonForRule=()=>pyl;
  d._logPylonReadbackSummary=()=>{};
  const parsed=d._parseAppActionMapPayload({idx:0,hash:'current-no-match',size:3200,chunkCount:8,payload:payload([
    zone(101,-800,-100),zone(102,-700,-100),zone(106,-600,-100),
  ])},d._cachedMapData);
  await d._reconcilePylonNativeRules(parsed,{fresh:true});
  assert.equal(d._obstacleRulesCache[rid].pending,null);
  assert.equal(d._obstacleRulesCache[rid].verification,'native_create_unconfirmed_retryable');
});

test('1.2.44 pylon delete edit preflight uses current direct MAPD and does not consult stale cloud MAP.*', async () => {
  const d=makeDevice([101,102,106]);
  const rid='geo:0:-7750:-2400';
  const pyl={id:'obs:3',x:-7755,y:-2425,source:'obs',coordinateScaleUncertain:false};
  const rules={
    [rid]:{mapIndex:0,nativeId:104,nativeMatchIds:[104],centerX:-7755,centerY:-2425,radius:500,
      nativeWriteVersion:6,nativeBindingVersion:3,action:'avoid',verification:'native_square_create_confirmed',updatedAt:Date.now()-1000},
  };
  d._obstacleRulesCache=rules;
  d._buildObstaclePylons=()=>[pyl];
  d._resolvePylonRuleBinding=()=>({ruleId:rid,rule:rules[rid]});
  d._captureNativeMapRevision=async()=>({hash:'before',size:3300});
  d._pylonMapEditTaskOptions=()=>({});
  d._requestMowerMapPublish=async()=>true;
  d._schedulePendingPylonReadback=()=>{};
  let cloudReads=0, deleted=null;
  d._api={
    getDirectMapSnapshot:async()=>({idx:0,hash:'current',size:3360,chunkCount:9,payload:payload([
      zone(101,-800,-100),zone(102,-700,-100),zone(104,-775.5,-242.5),zone(106,-600,-100),
    ])}),
    getRawProperties:async()=>{ cloudReads++; return {data:{}}; },
    getMAPI:async()=>({d:{hash:'before',size:3300}}),
    deleteForbiddenAreas:async(_did,ids)=>{ deleted=ids; return {legs:[
      {name:'select',accepted:true,taskAck:true},{name:'begin',accepted:true,taskAck:true},
      {name:'mutation',accepted:true,taskAck:true},{name:'commit',accepted:true,taskAck:true},
    ],result:{out:[{status:true,error:0}]}}; },
  };
  const out=await d._updatePylonForbiddenArea({id:'obs:3',deleteForbidden:true,radiusCm:50},rules);
  assert.deepEqual(deleted,[104]);
  assert.equal(cloudReads,0,'verified direct g2408 MAPD must prevent stale cloud preflight');
  assert.equal(out.pending,true);
  assert.equal(d._obstacleRulesCache[rid].pending,'delete');
});
