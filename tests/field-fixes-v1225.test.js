'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const MovaApi = require('../lib/MovaApi');
const read = p => fs.readFileSync(p, 'utf8');

test('1.2.25 batch deletion removes duplicate Homey no-go ids in one native edit transaction', async () => {
  const calls = [];
  const api = Object.create(MovaApi.prototype);
  api.sendAction = async (_did,_s,_a,input) => {
    calls.push(input[0]);
    return { result:{ out:[{ r:0, status:true, error:0 }] } };
  };
  const result = await api.deleteForbiddenAreas('mower', [102,103], 0);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(v => v.o), [200,204,218,218,201]);
  assert.deepEqual(calls.filter(v => v.o === 218).map(v => v.d.id), [102,103]);
});

test('1.2.25 pylon Delete sends the complete exact managed duplicate set, not only nativeId', async () => {
  const square = { shapeType:2, path:[
    {x:-6047,y:-2783},{x:-5047,y:-2783},{x:-5047,y:-1783},{x:-6047,y:-1783},
  ]};
  const map = { mowingAreas:[[1,{path:[]}]], forbiddenAreas:[[101,{shapeType:2,path:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]}],[102,square],[103,square],[104,{shapeType:2,path:[{x:-2174,y:-769},{x:-1174,y:-769},{x:-1174,y:231},{x:-2174,y:231}]}]] };
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {'obs:2':{action:'avoid',radius:500,mapIndex:0,nativeId:103,nativeMatchIds:[102,103],nativeWriteVersion:6}};
  d._buildObstaclePylons = () => [{id:'obs:2',x:-5547,y:-2283,source:'obs',coordinateScaleUncertain:false,rule:d._obstacleRulesCache['obs:2']}];
  d.getSetting = key => key === 'map_safe_mowing';
  d.getData = () => ({id:'mower'});
  d.log = () => {};
  d.setStoreValue = async () => {};
  d._parseMapDataChunks = () => map;
  let deleted = null;
  d._api = {
    getRawProperties: async () => ({data:{}}),
    deleteForbiddenAreas: async (_did,ids) => { deleted = ids; return {ok:true,legs:[]}; },
  };
  const result = await d.updateObstacleRule({id:'obs:2',deleteForbidden:true});
  assert.deepEqual(deleted,[102,103]);
  assert.deepEqual(result.rule.pendingDeleteIds,[102,103]);
  assert.equal(result.rule.pending,'delete');
});

test('1.2.25 delete reconciliation stays pending while any requested duplicate remains and confirms only when all are gone', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._pendingPylonReadbackTimers = new Map();
  d.homey = { clearTimeout() {} };
  d.log = () => {};
  d.setStoreValue = async () => {};
  d._obstacleRulesCache = {'obs:2':{action:'avoid',radius:500,mapIndex:0,nativeId:103,nativeMatchIds:[102,103],pendingDeleteIds:[102,103],pending:'delete',updatedAt:Date.now()}};
  d._buildObstaclePylons = () => [{id:'obs:2',x:0,y:0,rule:d._obstacleRulesCache['obs:2']}];
  d._nativeForbiddenShape = () => 2;
  d._nativePylonZoneMatches = () => true;
  await d._reconcilePylonNativeRules({forbiddenAreas:[[102,{shapeType:2}]]},{fresh:true});
  assert.equal(d._obstacleRulesCache['obs:2'].pending,'delete');
  await d._reconcilePylonNativeRules({forbiddenAreas:[]},{fresh:true});
  assert.equal(d._obstacleRulesCache['obs:2'].pending,null);
  assert.equal(d._obstacleRulesCache['obs:2'].nativeId,null);
  assert.equal(d._obstacleRulesCache['obs:2'].action,'observe');
  assert.equal(d._obstacleRulesCache['obs:2'].verification,'native_delete_confirmed');
});


test('1.2.25 legacy 1.2.24 pending delete does not falsely confirm while an older duplicate id remains', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._pendingPylonReadbackTimers = new Map();
  d.homey = { clearTimeout() {} };
  d.log = () => {};
  d.setStoreValue = async () => {};
  d._obstacleRulesCache = {'obs:2':{action:'avoid',radius:500,mapIndex:0,nativeId:103,nativeMatchIds:[102,103],pending:'delete',updatedAt:Date.now()}};
  d._buildObstaclePylons = () => [{id:'obs:2',x:0,y:0,rule:d._obstacleRulesCache['obs:2']}];
  d._nativeForbiddenShape = () => 2;
  d._nativePylonZoneMatches = () => true;
  await d._reconcilePylonNativeRules({forbiddenAreas:[[102,{shapeType:2}]]},{fresh:true});
  assert.equal(d._obstacleRulesCache['obs:2'].pending,'delete');
  assert.deepEqual(d._obstacleRulesCache['obs:2'].nativeMatchIds,[102,103]);
});

test('1.2.25 live turning picker is PRE[19]-authoritative and stale SETTINGS cannot toggle it every poll', () => {
  const src = read('drivers/mower/device.js');
  assert.match(src, /SETTINGS\.steeringMode can lag the device-applied PRE\[19\]/);
  assert.match(src, /this\._lastSettingsSteeringMode = Number\(s\.steeringMode\)/);
  const start = src.indexOf('SETTINGS.steeringMode can lag');
  const end = src.indexOf('if (Object.keys(update).length', start);
  const block = src.slice(start,end);
  assert.doesNotMatch(block, /_setCap\('turning_method'/);
});
