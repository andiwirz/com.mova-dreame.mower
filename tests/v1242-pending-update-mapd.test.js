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

function square(id, cx, cy, half = 500) {
  return [id, { id, type:2, shapeType:2, path:[
    {x:cx-half,y:cy-half},{x:cx+half,y:cy-half},{x:cx+half,y:cy+half},{x:cx-half,y:cy+half},
  ] }];
}
function compact(id, cxRaw, cyRaw, halfRaw = 50) {
  return { id, type:2, data:[
    [cxRaw-halfRaw,cyRaw-halfRaw],[cxRaw+halfRaw,cyRaw-halfRaw],
    [cxRaw+halfRaw,cyRaw+halfRaw],[cxRaw-halfRaw,cyRaw+halfRaw],
  ] };
}
function baseMap() {
  return {
    boundary:{x1:-10000,y1:-10000,x2:10000,y2:10000}, name:'Map', md5sum:'cloud-old',
    mowingAreas:[[1,{id:1,path:[{x:-9000,y:-4000},{x:2000,y:-4000},{x:2000,y:5000},{x:-9000,y:5000}]}]],
    forbiddenAreas:[square(101,-8000,-1000,500),square(102,-7000,-1000,500)],
    spotAreas:[], contours:[], mapObstacles:[], livePath:[],
  };
}
function device() {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._cachedMapData = baseMap();
  d._obstacleRulesCache = {
    'obs:2': {
      pending:'create', mapIndex:0, nativeId:102, beforeIds:[101,102],
      radius:1000, centerX:-7000, centerY:-1000, note:'Schauckel neu',
      nativeWriteVersion:6, updatedAt:Date.now(),
    },
  };
  d._nativeZoneLabelsCache = {};
  d._nativeZoneLabelDeleteWatches = {};
  d._directNativeDeleteUi = new Map();
  d._directNativeDeleteTimers = new Map();
  d._pendingPylonReadbackTimers = new Map();
  d._pylonUiRevision = 0;
  d._lastVendorMapMeta = {hash:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',size:3300};
  d.log = () => {};
  d.error = () => {};
  d.setStoreValue = async () => {};
  d.unsetStoreValue = async () => {};
  d._scheduleMapCameraImageUpdate = () => {};
  d._clearPendingPylonReadback = () => {};
  d.getData = () => ({id:'mower'});
  d._logNativeForbiddenReadOnly = () => {};
  d._buildObstaclePylons = () => [{id:'obs:2',x:-7000,y:-1000,source:'obs',coordinateScaleUncertain:false}];
  d._findPylonForRule = () => ({id:'obs:2',x:-7000,y:-1000,source:'obs',coordinateScaleUncertain:false});
  return d;
}

test('1.2.42 accepts an intentional in-place o=215 geometry update with the same native id', async () => {
  const d = device();
  const payload = {
    map:[
      {id:1,area:100,data:[[-900,-400],[200,-400],[200,500],[-900,500]]},
      compact(101,-800,-100,50),
      // Native #102 deliberately changed from 1.0 m square to 2.0 m square
      // (Homey radius 100 cm / half-size 1000 mm), while keeping the same id.
      compact(102,-700,-100,100),
    ],
    name:'Garden', point:[], semantic:[], spot:[], trajectory:[], cut_relation:[], total_area:100,
  };
  const direct = d._parseAppActionMapPayload({
    idx:0, hash:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', size:3400, chunkCount:9, payload,
  }, d._cachedMapData);

  assert.equal(direct.directMapdTransportVerified,true);
  assert.equal(direct.directMapdGeometryVerified,true,'expected pending update must not be rejected as mismatched base geometry');
  assert.deepEqual(direct.directMapdPendingUpdatedIds,[102]);
  assert.deepEqual(direct.directMapdMismatchedBaseIds,[]);
  assert.deepEqual(direct.directMapdTrustedIds,[101,102]);
  const updated = direct.forbiddenAreas.find(e => e[0] === 102)[1];
  assert.equal(Math.max(...updated.path.map(p=>p.x)) - Math.min(...updated.path.map(p=>p.x)),2000);

  await d._reconcilePylonNativeRules(direct,{fresh:true});
  assert.equal(d._obstacleRulesCache['obs:2'].pending,null);
  assert.equal(d._obstacleRulesCache['obs:2'].nativeId,102);
  assert.equal(d._obstacleRulesCache['obs:2'].action,'avoid');
  assert.equal(d._obstacleRulesCache['obs:2'].note,'Schauckel neu');
  const labels = d._nativeZoneLabelsForMap(direct);
  assert.deepEqual(labels.map(x => ({nativeId:x.nativeId,note:x.note})),[{nativeId:102,note:'Schauckel neu'}],
    'after the updated geometry is confirmed, the map label must follow the pylon note instead of the old geometry label');
});

test('1.2.42 still rejects the same geometry change when there is no matching pending Homey update', () => {
  const d = device();
  d._obstacleRulesCache = {};
  const payload = {
    map:[
      {id:1,area:100,data:[[-900,-400],[200,-400],[200,500],[-900,500]]},
      compact(101,-800,-100,50),
      compact(102,-700,-100,100),
    ],
    name:'Garden', point:[], semantic:[], spot:[], trajectory:[], cut_relation:[], total_area:100,
  };
  const direct = d._parseAppActionMapPayload({idx:0,hash:'b',size:1,chunkCount:1,payload},d._cachedMapData);
  assert.equal(direct.directMapdGeometryVerified,false);
  assert.deepEqual(direct.directMapdPendingUpdatedIds,[]);
  assert.deepEqual(direct.directMapdMismatchedBaseIds,[102]);
  assert.deepEqual(direct.forbiddenAreas.map(e=>e[0]),[101,102]);
});

const fs = require('node:fs');
const path = require('node:path');

test('1.2.42 direct native-delete Pending UI is not cut off after five seconds', () => {
  const files = [
    'widgets/map/public/index.html',
    'widgets/overview/public/map-editor.html',
    'drivers/mower/repair/map_editor.html',
  ];
  for (const rel of files) {
    const html = fs.readFileSync(path.join(__dirname,'..',rel),'utf8');
    assert.doesNotMatch(html,/nativeZonePendingDeletes[\s\S]{0,240}<\s*5000/,rel);
    assert.match(html,/return Number\(op && op\.nativeId\) === nativeZoneId;/,rel);
    assert.match(html,/return Number\(op && op\.nativeId\) === id;/,rel);
    assert.match(html,/Karte wurde neu abgefragt\. Die native Bestätigung steht noch aus; der Hintergrundprüfer läuft weiter\./,rel);
  }
});
