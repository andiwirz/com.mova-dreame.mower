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

function square(cx, cy, half=500) {
  return { shapeType:2, path:[
    {x:cx-half,y:cy-half},{x:cx+half,y:cy-half},{x:cx+half,y:cy+half},{x:cx-half,y:cy+half},
  ] };
}

function base() {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._pylonNativeWriteBusy = false;
  d._pylonUiRevision = 0;
  d._pendingPylonReadbackTimers = new Map();
  d._directNativeDeleteUi = new Map();
  d.getSetting = key => key === 'map_safe_mowing';
  d.getData = () => ({id:'mower'});
  d.log = () => {};
  d.error = () => {};
  d.setStoreValue = async () => {};
  d._requestMowerMapPublish = async () => true;
  d._schedulePendingPylonReadback = () => {};
  d._scheduleMapCameraImageUpdate = () => {};
  return d;
}

test('v1234 explicit native-id geometry repairs a stale OBS centroid and restores menu id', () => {
  const d = base();
  d._obstacleRulesCache = {
    'obs:old': { mapIndex:0, centerX:1000, centerY:2000, radius:500, note:'Ausfahrt', nativeId:102, nativeMatchIds:[102], nativeWriteVersion:6 },
  };
  d._cachedMapData = { forbiddenAreas:[[102,square(-7880,-700,500)]] };
  d._collectObstaclePylonsRaw = () => [{ id:'obs:1', x:-7880, y:-716, source:'obs', coordinateScaleUncertain:false }];
  const pylons = d._buildObstaclePylons();
  assert.equal(pylons.length,1);
  assert.equal(pylons[0].ruleId,'obs:old');
  assert.equal(pylons[0].rule.nativeId,102);
  assert.equal(pylons[0].rule.nativeConfirmed,true);
  assert.equal(pylons[0].rule.note,'Ausfahrt');
});

test('v1234 unknown manufacturer square is not silently claimed by an unassigned pylon', () => {
  const d = base();
  d._obstacleRulesCache = {};
  d._cachedMapData = { forbiddenAreas:[[101,square(1000,2000,500)]] };
  d._collectObstaclePylonsRaw = () => [{ id:'obs:1', x:1000, y:2000, source:'obs', coordinateScaleUncertain:false }];
  const p = d._buildObstaclePylons()[0];
  assert.equal(p.rule.nativeId,null);
  assert.equal(p.rule.nativeConfirmed,false);
});

test('v1234 colliding TASK id that existed before create is ignored as provisional native id', async () => {
  const d = base();
  const pylon = { id:'obs:1', x:5000, y:2000, source:'obs', coordinateScaleUncertain:false };
  d._obstacleRulesCache = {};
  d._cachedMapData = { forbiddenAreas:[[102,square(1000,2000,500)]], mowingAreas:[[1,{}]] };
  d._buildObstaclePylons = () => [pylon];
  d._parseMapDataChunks = () => d._cachedMapData;
  d._api = {
    getRawProperties: async () => ({data:{map:true}}),
    setForbiddenPolygon: async () => ({ ok:true, legs:[
      {name:'select',accepted:true,taskAck:true},
      {name:'begin',accepted:true,taskAck:true},
      {name:'mutation',accepted:true,taskAck:true,task:{d:{id:102}}},
      {name:'commit',accepted:true,taskAck:true},
    ]}),
  };
  const out = await d.updateObstacleRule({id:'obs:1',action:'avoid',radiusCm:50});
  assert.equal(out.pending,true);
  assert.equal(out.rule.nativeCandidateId,null);
  assert.deepEqual(out.rule.beforeIds,[102]);
});

test('v1234 fresh MAP id not present before write becomes the real confirmed id', async () => {
  const d = base();
  const pylon = { id:'obs:1', x:5000, y:2000, source:'obs', coordinateScaleUncertain:false };
  d._obstacleRulesCache = {
    'obs:1': { mapIndex:0, centerX:5000, centerY:2000, radius:500, pending:'create', beforeIds:[101,102], nativeCandidateId:null, nativeWriteVersion:6, updatedAt:Date.now()-3000 },
  };
  d._buildObstaclePylons = () => [pylon];
  await d._reconcilePylonNativeRules({ forbiddenAreas:[
    [101,square(-2000,-2000,500)],
    [102,square(1000,2000,500)],
    [105,square(5000,2000,500)],
  ] }, {fresh:true});
  assert.equal(d._obstacleRulesCache['obs:1'].nativeId,105);
  assert.equal(d._obstacleRulesCache['obs:1'].pending,null);
  assert.equal(d._obstacleRulesCache['obs:1'].verification,'native_square_create_confirmed');
});
