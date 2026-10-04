'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const MovaApi = require('../lib/MovaApi');
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

test('manufacturer square no-go edit uses full map transaction and commits after create/delete', async () => {
  const calls = [];
  const api = Object.create(MovaApi.prototype);
  api.sendAction = async (...args) => { calls.push(args); return { result: { out: [{ status: true, r: 0 }] } }; };
  await api.setForbiddenPolygon('mower', [[-2.2536,-0.7845],[-1.2536,-0.7845],[-1.2536,0.2155],[-2.2536,0.2155]], -1, 2);
  await api.deleteForbiddenArea('mower', 106, 2);
  const ops = calls.map(c => c[3][0].o);
  assert.deepEqual(ops, [200, 204, 215, 201, 200, 204, 218, 201]);
  assert.deepEqual(calls[0][3][0], { m: 'a', p: 0, o: 200, d: { idx: 2 } });
  assert.deepEqual(calls[2][3][0], { m: 'a', p: 0, o: 215,
    d: { id: -1, type: 2, points: [[-2.2536,-0.7845],[-1.2536,-0.7845],[-1.2536,0.2155],[-2.2536,0.2155]], radius: 0 } });
  assert.deepEqual(calls[3][3][0], { m: 'a', p: 1, o: 201 });
  assert.deepEqual(calls[6][3][0], { m: 'a', p: 0, o: 218, d: { id: 106, type: 0 } });
  assert.deepEqual(calls[7][3][0], { m: 'a', p: 1, o: 201 });
});

test('map edit transaction still commits when begin/mutation rejects', async () => {
  const calls = [];
  const api = Object.create(MovaApi.prototype);
  api.sendAction = async (_did, _s, _a, params) => {
    const op = params[0].o;
    calls.push(op);
    if (op === 204) return { result: { out: [{ status: false, r: -3 }] } };
    return { result: { out: [{ status: true, r: 0 }] } };
  };
  await assert.rejects(api.setForbiddenPolygon('mower', [[-0.4,-0.3],[0.6,-0.3],[0.6,0.7],[-0.4,0.7]], -1, 0), /begin rejected/);
  assert.deepEqual(calls, [200, 204, 201], 'commit is attempted even if begin failed; mutation is not sent');
});

test('optional pylon creates and deletes only its own native square after map readback', async () => {
  const calls = [], store = {};
  const square = { shapeType: 2, path: [
    { x: 500, y: 1500 }, { x: 1500, y: 1500 }, { x: 1500, y: 2500 }, { x: 500, y: 2500 },
  ] };
  const areas = [[101, { shapeType: 2, path: [{x:-100,y:-100},{x:100,y:-100},{x:100,y:100},{x:-100,y:100}] }], [102, square]];
  const map = () => ({ mowingAreas: [[1, { path: [] }]], forbiddenAreas: areas.map(([id, area]) => [id, area]) });
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {};
  d._buildObstaclePylons = () => [{ id: 'obs:1', x: 1000, y: 2000, source: 'obs', coordinateScaleUncertain: false }];
  d.getSetting = key => key === 'map_safe_mowing';
  d.getData = () => ({ id: 'mower' });
  d.log = () => {};
  d.setStoreValue = async (key, value) => { store[key] = structuredClone(value); };
  d._parseMapDataChunks = () => map();
  d._api = {
    getRawProperties: async () => ({ data: { map: true } }),
    setForbiddenPolygon: async (...args) => { calls.push(['create', ...args]); areas.push([106, square]); return { result: { out: [{ status: true }] } }; },
    deleteForbiddenArea: async (...args) => { calls.push(['delete', ...args]); const i = areas.findIndex(e => e[0] === args[1]); areas.splice(i, 1); return { result: { out: [{ status: true }] } }; },
  };
  await d.updateObstacleRule({ id: 'obs:1', action: 'observe', radius: 500 });
  assert.equal(calls.length, 0, 'unassigned pylon has no effect on mower');
  const created = await d.updateObstacleRule({ id: 'obs:1', action: 'avoid', radiusCm: 50 });
  assert.deepEqual(calls[0].slice(0,5), ['create', 'mower', [[0.5,1.5],[1.5,1.5],[1.5,2.5],[0.5,2.5]], -1, 0]);
  assert.equal(typeof calls[0][5]?.waitForTask, 'function');
  assert.equal(created.pending, true, 'UI returns pending immediately instead of waiting for cloud MAP.*');
  assert.equal(store.obstacle_rules_v1['obs:1'].pending, 'create');
  await d._reconcilePylonNativeRules(map(), {fresh:true});
  assert.equal(store.obstacle_rules_v1['obs:1'].nativeId, 106);
  const deleted = await d.updateObstacleRule({ id: 'obs:1', deleteForbidden: true });
  assert.deepEqual(calls[1].slice(0,4), ['delete', 'mower', 106, 0]);
  assert.equal(typeof calls[1][4]?.waitForTask, 'function');
  assert.equal(deleted.pending, true);
  await d._reconcilePylonNativeRules(map(), {fresh:true});
  assert.deepEqual(areas.map(e => e[0]), [101, 102], 'existing manufacturer zones survive');
  assert.equal(store.obstacle_rules_v1['obs:1'].nativeId, null);
});

test('pylon square creation falls back to MAPI only when complete MAP chunks are unavailable', async () => {
  const d = Object.create(Device.prototype);
  const square = { shapeType: 2, path: [
    { x: 500, y: 1500 }, { x: 1500, y: 1500 }, { x: 1500, y: 2500 }, { x: 500, y: 2500 },
  ] };
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {};
  d._buildObstaclePylons = () => [{ id: 'obs:1', x: 1000, y: 2000, source: 'obs', coordinateScaleUncertain: false }];
  d.getSetting = key => key === 'map_safe_mowing';
  d.getData = () => ({ id: 'mower' });
  d.log = () => {};
  d.setStoreValue = async () => {};
  d._parseMapDataChunks = data => data.before
    ? ({ mowingAreas: [[1, {}]], forbiddenAreas: [] })
    : ({ mowingAreas: [], forbiddenAreas: [] });
  d._parseDirectMapData = mapi => mapi;
  let rawReads = 0;
  d._api = {
    getRawProperties: async () => ({ data: { before: ++rawReads === 1 } }),
    setForbiddenPolygon: async () => ({ result: { out: [{ status: true }] } }),
    getMAPI: async () => ({ mowingAreas: [[1, {}]], forbiddenAreas: [[106, square]] }),
  };
  const result = await d.updateObstacleRule({ id: 'obs:1', action: 'avoid', radiusCm: 50 });
  assert.equal(result.pending, true);
  assert.equal(result.rule.pending, 'create');
  assert.equal(result.rule.action, 'observe');
});

test('disabled safe mowing rejects an attempted zone before contacting the mower', async () => {
  let calls = 0;
  const d = Object.create(Device.prototype);
  d._obstacleRulesCache = {};
  d._api = { getRawProperties: async () => { calls++; } };
  d.log = () => {};
  d.getSetting = () => false;
  await assert.rejects(d.updateObstacleRule({ id: 'obs:1', action: 'avoid', radiusCm: 30 }), /Sicher mähen/);
  assert.equal(calls, 0);
});

test('native pylon save rejects radii below the manufacturer 1 m diameter minimum', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {};
  d._buildObstaclePylons = () => [{ id: 'obs:1', x: 1000, y: 2000, source: 'obs', coordinateScaleUncertain: false }];
  d.getSetting = key => key === 'map_safe_mowing';
  d.getData = () => ({ id: 'mower' });
  d.log = () => {};
  d._parseMapDataChunks = () => ({ mowingAreas: [[1, {}]], forbiddenAreas: [] });
  d._api = { getRawProperties: async () => ({ data: {} }) };
  await assert.rejects(
    d.updateObstacleRule({ id: 'obs:1', action: 'avoid', radiusCm: 49 }),
    /50 und 300 cm/
  );
});

test('saving only safe mowing completes without waiting for garage or mower I/O', async () => {
  const d = Object.create(Device.prototype);
  d.getData = () => ({ id: 'mower' });
  d.log = () => {};
  d._obstacleRulesCache = {};
  d._garageSafety = { onSettings: () => { throw Error('garage hook called'); } };
  d._api = { sendAction: () => { throw Error('mower I/O called'); } };
  await d.onSettings({ changedKeys: ['map_safe_mowing'], newSettings: { map_safe_mowing: true } });
  await d.onSettings({ changedKeys: ['map_safe_mowing'], newSettings: { map_safe_mowing: false } });
});

test('turning method uses scoped PRE[19] and preserves firmware-owned PRE[20]', async () => {
  const actions = [];
  const api = Object.create(MovaApi.prototype);
  api.sendAction = async (...args) => {
    actions.push(args);
    const param = args[3]?.[0];
    if (param?.m === 'g' && param?.t === 'PRE') {
      return { result: { out: [{ r: 0, d: [0, 0, 0, 1, 40, 1, 0, 1, 1, 1, 1, 1, 1, 15, 15, 7, 1, 1, 5, 0, 77] }] } };
    }
    return { result: { out: [{ status: true, r: 0 }] } };
  };
  const pre = await api.getPRE('mower', 2, 0);
  assert.equal(pre[19], 0);
  const next = [...pre]; next[0] = 0; next[1] = 2; next[2] = 0; next[19] = 1;
  await api.writePRE('mower', next);
  assert.equal(actions[0][3][0].d.idx, 2);
  assert.equal(actions[1][3][0].d[19], 1);
  assert.equal(actions[1][3][0].d[20], 77);
});

test('Rasenpflege dual-write confirms PRE[19] and SETTINGS.steeringMode', async () => {
  const d = Object.create(Device.prototype);
  const writes = [];
  let preReads = 0;
  d._activeMapIndex = 0;
  d.log = () => {};
  d.error = () => {};
  d.getData = () => ({ id: 'mower' });
  d.setStoreValue = async () => {};
  d._garageSafety = null;
  const base = [0,0,0,1,40,1,0,1,1,1,1,1,1,15,15,7,1,1,5,0,88];
  d._api = {
    getPRE: async () => {
      preReads++;
      const out = [...base];
      if (preReads > 1) out[19] = 1;
      return out;
    },
    writePRE: async (_did, pre) => { writes.push(['pre', [...pre]]); return { result: { out: [{ status: true, r: 0 }] } }; },
    writeSETTINGSField: async (...args) => { writes.push(['settings', ...args]); return { code: 0 }; },
    getSETTINGSBlob: async () => [{ settings: { '0': { steeringMode: 1 } } }],
  };
  d.hasCapability = () => false;
  d._safeWrite = async (_label, fn) => { await fn(); return true; };
  await d._writeTurningMethod(1, 'test');
  assert.equal(writes[0][0], 'pre');
  assert.equal(writes[0][1][19], 1);
  assert.equal(writes[0][1][20], 88, 'unknown new-firmware tail is preserved');
  assert.deepEqual(writes[1], ['settings', 'mower', 0, 'steeringMode', 1]);
});

test('Rasenpflege refuses firmware without PRE[19] instead of fabricating a 21-field array', async () => {
  const d = Object.create(Device.prototype);
  d._activeMapIndex = 0;
  d.log = () => {};
  d.error = () => {};
  d.getData = () => ({ id: 'mower' });
  d.hasCapability = () => false;
  d._safeWrite = async (_label, fn) => { await fn(); return true; };
  d._api = { getPRE: async () => new Array(19).fill(0) };
  await assert.rejects(
    d._writeTurningMethod(1, 'test'),
    /PRE\[19\].*nicht/
  );
});

test('direct MAPI polygon form confirms a pylon square in native edit-frame metres', async () => {
  const d = Object.create(Device.prototype);
  const directSquare = { type: 2, points: [[0.5,1.5],[1.5,1.5],[1.5,2.5],[0.5,2.5]], radius: 0 };
  d._activeMapIndex = 0;
  d._obstacleRulesCache = {};
  d._buildObstaclePylons = () => [{ id: 'obs:raw', x: 1000, y: 2000, source: 'obs', coordinateScaleUncertain: false }];
  d.getSetting = key => key === 'map_safe_mowing';
  d.getData = () => ({ id: 'mower' });
  d.log = () => {};
  d.setStoreValue = async () => {};
  d._parseMapDataChunks = data => data.before
    ? ({ mowingAreas: [[1, {}]], forbiddenAreas: [] })
    : ({ mowingAreas: [], forbiddenAreas: [] });
  d._parseDirectMapData = mapi => mapi;
  let rawReads = 0;
  d._api = {
    getRawProperties: async () => ({ data: { before: ++rawReads === 1 } }),
    setForbiddenPolygon: async () => ({ result: { out: [{ status: true, error: 0 }] } }),
    getMAPI: async () => ({ mowingAreas: [[1, {}]], forbiddenAreas: [[222, directSquare]] }),
  };
  const result = await d.updateObstacleRule({ id: 'obs:raw', action: 'avoid', radiusCm: 50 });
  assert.equal(result.pending, true);
  assert.equal(result.rule.pending, 'create');
  await d._reconcilePylonNativeRules({ mowingAreas:[[1,{}]], forbiddenAreas:[[222,directSquare]] }, {fresh:true});
  assert.equal(d._obstacleRulesCache['obs:raw'].nativeId, 222);
  assert.equal(d._obstacleRulesCache['obs:raw'].action, 'avoid');
});

test('native circle matcher accepts both expanded map-mm paths and direct cm circles without weakening location match', () => {
  const d = Object.create(Device.prototype);
  const pylon = { x: -5391, y: -3165 };
  assert.equal(d._nativeCircleMatchesPylon({ type: 3, points: [[-539.1, -316.5]], radius: 50 }, pylon, 500), true);
  assert.equal(d._nativeCircleMatchesPylon({ type: 3, points: [[-520, -316.5]], radius: 50 }, pylon, 500), false);
});

test('native circle matcher accepts native edit-frame metres only when center and radius both match', () => {
  const d = Object.create(Device.prototype);
  const pylon = { x: -5391, y: -3165 };
  assert.equal(d._nativeCircleMatchesPylon({ type: 3, points: [[-5.391, -3.165]], radius: 0.5 }, pylon, 500), true);
  assert.equal(d._nativeCircleMatchesPylon({ type: 3, points: [[-5.0, -3.165]], radius: 0.5 }, pylon, 500), false);
});

test('direct circle rendering normalization uses the pylon-matched unit scale only', () => {
  const d = Object.create(Device.prototype);
  d._cachedMapData = null;
  d._cachedObstacles = null;
  d._obstacleRulesCache = {};
  d._buildObstaclePylons = () => [{ id: 'obs:one', x: -5391, y: -3165, rule: { radius: 500 } }];
  const input = [[321, { type: 3, points: [[-539.1, -316.5]], radius: 50 }]];
  const out = d._normalizeNativeForbiddenAreas(input);
  assert.equal(out[0][1].nativeCircleScale, 10);
  assert.equal(out[0][1].path.length, 32);
  const xs = out[0][1].path.map(p => p.x);
  const ys = out[0][1].path.map(p => p.y);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 + 5391) < 1);
  assert.ok(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 + 3165) < 1);
});

test('unrelated compact manufacturer circle is not rescaled on a guess', () => {
  const d = Object.create(Device.prototype);
  d._buildObstaclePylons = () => [{ id: 'obs:one', x: -5391, y: -3165, rule: { radius: 500 } }];
  const native = { type: 3, points: [[200, 300]], radius: 70 };
  const out = d._normalizeNativeForbiddenAreas([[55, native]]);
  assert.equal(out[0][1].path, undefined);
  assert.deepEqual(out[0][1].points, [[200, 300]]);
});

test('1.2.40 pending pylon verification keeps dense checkpoints and adds persistent read-only recheck', async () => {
  const d = Object.create(Device.prototype);
  const scheduled = [];
  let reads = 0;
  d._obstacleRulesCache = { 'obs:one': { pending: 'create', mapIndex:0, updatedAt:Date.now()+100 } };
  d.log = () => {};
  d.homey = {
    setTimeout: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; },
    clearTimeout: () => {},
  };
  d.refreshMapData = async () => { reads++; };
  d._schedulePendingPylonReadback('obs:one');
  assert.deepEqual(scheduled.map(x => x.delay), [2000, 5000, 15000, 35000, 75000, 120000, 150000, 180000, 210000, 240000, 270000, 300000, 330000, 360000, 420000, 480000, 600000]);
  for (const item of scheduled.slice(0,16)) await item.fn();
  assert.equal(reads, 16);
});
