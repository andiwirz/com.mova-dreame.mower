'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  ]};
}
function device() {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._cachedMapData = { forbiddenAreas:[[102,square(1000,2000,500)],[103,square(4000,5000,600)]] };
  d._nativeZoneLabelsCache = {};
  d._nativeZoneLabelDeleteWatches = {};
  d._obstacleRulesCache = {};
  d._pylonUiRevision = 0;
  d._store = {};
  d.setStoreValue = async function(k,v){ this._store[k]=JSON.parse(JSON.stringify(v)); };
  d._scheduleMapCameraImageUpdate = () => {};
  d.log = () => {};
  return d;
}

test('1.2.37 labels, renames and clears a native zone locally without changing mower geometry or calling API', async () => {
  const d = device();
  d._api = new Proxy({}, { get(){ throw new Error('native API must not be touched by label-only save'); } });
  const before = JSON.stringify(d._cachedMapData.forbiddenAreas);
  let out = await d.updateObstacleRule({id:'native-zone:102',action:'label',nativeZoneId:102,note:'Schaukel'});
  assert.equal(out.ok,true);
  assert.equal(out.note,'Schaukel');
  assert.equal(JSON.stringify(d._cachedMapData.forbiddenAreas), before);
  assert.deepEqual(d._nativeZoneLabelsForMap(d._cachedMapData).map(x=>[x.nativeId,x.note]), [[102,'Schaukel']]);

  out = await d.updateObstacleRule({id:'native-zone:102',action:'label',nativeZoneId:102,note:'Spielgerät'});
  assert.equal(out.note,'Spielgerät');
  assert.equal(d._nativeZoneLabelsForMap(d._cachedMapData)[0].note,'Spielgerät');

  out = await d.updateObstacleRule({id:'native-zone:102',action:'label',nativeZoneId:102,note:'   '});
  assert.equal(out.note,'');
  assert.deepEqual(d._nativeZoneLabelsForMap(d._cachedMapData), []);
  assert.equal(JSON.stringify(d._cachedMapData.forbiddenAreas), before);
});

test('1.2.37 persisted native label survives simulated app restart', async () => {
  const d1 = device();
  await d1._setNativeZoneLabel({nativeZoneId:102,note:'Schaukel'});
  const d2 = device();
  d2._nativeZoneLabelsCache = JSON.parse(JSON.stringify(d1._store.native_zone_labels_v1));
  assert.equal(d2._nativeZoneLabelsForMap(d2._cachedMapData)[0].note,'Schaukel');
});

test('1.2.37 recycled native id at different geometry does not inherit old name', async () => {
  const d = device();
  await d._setNativeZoneLabel({nativeZoneId:102,note:'Ausfahrt'});
  d._cachedMapData = { forbiddenAreas:[[102,square(9000,9000,500)]] };
  assert.deepEqual(d._nativeZoneLabelsForMap(d._cachedMapData), []);
});

test('1.2.37 small native geometry drift keeps the label', async () => {
  const d = device();
  await d._setNativeZoneLabel({nativeZoneId:102,note:'Schaukel'});
  d._cachedMapData = { forbiddenAreas:[[102,square(1040,1970,520)]] };
  assert.equal(d._nativeZoneLabelsForMap(d._cachedMapData)[0].note,'Schaukel');
});

test('1.2.37 labels are isolated by active map index', async () => {
  const d = device();
  await d._setNativeZoneLabel({nativeZoneId:102,note:'Karte Null'});
  d._activeMapIndex = 1;
  d._cachedMapData = { forbiddenAreas:[[102,square(1000,2000,500)]] };
  assert.deepEqual(d._nativeZoneLabelsForMap(d._cachedMapData), []);
});

test('1.2.37 direct native label syncs only the one geometrically matching pylon rule', async () => {
  const d = device();
  d._obstacleRulesCache = {
    good: {mapIndex:0,nativeId:102,centerX:1000,centerY:2000,radius:500,note:'Alt',updatedAt:1},
    staleSameId: {mapIndex:0,nativeId:102,centerX:9000,centerY:9000,radius:500,note:'Falsch',updatedAt:1},
  };
  await d._setNativeZoneLabel({nativeZoneId:102,note:'Neu'});
  assert.equal(d._obstacleRulesCache.good.note,'Neu');
  assert.equal(d._obstacleRulesCache.staleSameId.note,'Falsch');
  assert.equal(d._store.obstacle_rules_v1.good.note,'Neu');
});

test('1.2.37 stale pylon note with recycled id is never exposed as the native-zone label', () => {
  const d = device();
  d._obstacleRulesCache = {
    stale: {mapIndex:0,nativeId:102,centerX:9000,centerY:9000,radius:500,note:'Alter Name',updatedAt:1},
  };
  assert.deepEqual(d._nativeZoneLabelsForMap(d._cachedMapData), []);
});

test('1.2.37 missing or non-fresh readback cannot purge a label; complete fresh readback can', async () => {
  const d = device();
  const oldArea = d._cachedMapData.forbiddenAreas[0][1];
  await d._setNativeZoneLabel({nativeZoneId:102,note:'Schaukel'});
  await d._rememberNativeZoneLabelDeleteWatch(102, oldArea, 0);

  const without102 = { forbiddenAreas:[[103,square(4000,5000,600)]] };
  await d._reconcileNativeZoneLabelDeleteWatches(without102, {fresh:false});
  assert.equal(Object.keys(d._nativeZoneLabelsCache).length,1);
  assert.equal(Object.keys(d._nativeZoneLabelDeleteWatches).length,1);

  await d._reconcileNativeZoneLabelDeleteWatches(without102, {fresh:true});
  assert.equal(Object.keys(d._nativeZoneLabelsCache).length,0);
  assert.equal(Object.keys(d._nativeZoneLabelDeleteWatches).length,0);
});

test('1.2.37 delete watch never purges a new label on a recycled id at another position', async () => {
  const d = device();
  const oldArea = d._cachedMapData.forbiddenAreas[0][1];
  await d._setNativeZoneLabel({nativeZoneId:102,note:'Alt'});
  await d._rememberNativeZoneLabelDeleteWatch(102, oldArea, 0);

  d._cachedMapData = { forbiddenAreas:[[102,square(9000,9000,500)]] };
  await d._setNativeZoneLabel({nativeZoneId:102,note:'Neu an anderer Stelle'});
  await d._reconcileNativeZoneLabelDeleteWatches(d._cachedMapData, {fresh:true});
  assert.equal(d._nativeZoneLabelsForMap(d._cachedMapData)[0].note,'Neu an anderer Stelle');
  assert.equal(Object.keys(d._nativeZoneLabelDeleteWatches).length,0);
});

test('1.2.37 all map editors allow naming direct native zones and render labels without pointer interception', () => {
  const root = path.join(__dirname,'..');
  for (const rel of ['widgets/map/public/index.html','widgets/overview/public/map-editor.html','drivers/mower/repair/map_editor.html']) {
    const html = fs.readFileSync(path.join(root,rel),'utf8');
    assert.match(html,/Name \/ Notiz/);
    assert.match(html,/saveBtn\.textContent = direct \? 'Namen speichern'/);
    assert.match(html,/action: selectedDirect && mode === 'save' \? 'label'/);
    assert.match(html,/noteInput\.disabled = false/);
    assert.match(html,/nativeZoneLabels/);
    assert.match(html,/escapeSvgText\(nativeName\)/);
    assert.match(html,/pointer-events="none"/);
    assert.doesNotMatch(html,/Notiz kann nur über Pylonen geändert werden/);
  }
});
