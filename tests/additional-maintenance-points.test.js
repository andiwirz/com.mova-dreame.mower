'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let MowerDevice;
let GarageSafetyEngine;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { Device: class {} };
    if (request === 'mqtt') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  MowerDevice = require('../drivers/mower/device');
  GarageSafetyEngine = require('../lib/garage/GarageSafetyEngine');
} finally { Module._load = originalLoad; }

test('native maintenance markers retain their native indexes and Homey names', () => {
  const device = Object.create(MowerDevice.prototype);
  const map = {
    name: 'Garden',
    boundary: { x1: 0, y1: 0, x2: 10000, y2: 8000 },
    maintenancePoint: { x: 100, y: 200 },
    maintenancePoints: [
      { index: 1, x: 100, y: 200 },
      { index: 2, x: 8100, y: 6500 },
      { index: 3, x: 2400, y: 3000 },
    ],
  };
  device._unwrapDirectMapObject = () => map;
  device._asArrayMaybe = value => Array.isArray(value) ? value : [];
  device._normalizeNativeForbiddenAreas = value => value;
  device._normalizeBoundary = value => value;
  device._dockPos = null;
  device._livePos = null;
  device._cachedMapData = null;
  device._activeMapIndex = 0;
  device.getSetting = key => ({ maintenance_point_1_name: 'Garage-Service', maintenance_point_2_name: 'Rasenende', maintenance_point_3_name: 'Werkstatt' })[key] || '';

  const parsed = device._parseDirectMapData(map);
  assert.deepEqual(parsed.nativeMaintenancePoints.map(point => [point.index, point.x, point.y]), [
    [1, 100, 200], [2, 8100, 6500], [3, 2400, 3000],
  ]);
  assert.deepEqual(parsed.maintenancePoints.map(point => [point.index, point.name]), [
    [1, 'Garage-Service'], [2, 'Rasenende'], [3, 'Werkstatt'],
  ]);
});

test('native opcode 109 forwards the selected additional point index', async () => {
  const MovaApi = require('../lib/MovaApi');
  const calls = [];
  const api = Object.create(MovaApi.prototype);
  api.sendAction = async (...args) => { calls.push(args); return { result: { out: [{ status: true, r: 0 }] } }; };
  await api.goToMaintenancePoint('mower', 0, 4);
  assert.deepEqual(calls[0][3][0], { m: 'a', p: 0, o: 109, d: { point: [4] } });
});

test('additional point arrival cannot rewrite or renew the primary automatic-return marker', async () => {
  const engine = Object.create(GarageSafetyEngine.prototype);
  let storedPrimary = 0;
  Object.assign(engine, {
    _maintenanceRequestedAt: Date.now(),
    _manualMaintenanceTransit: true,
    _manualMaintenanceReached: false,
    _manualMaintenancePhase: 'transit',
    _returnContext: 'IDLE',
    _lastMaintenanceReachedAt: 123,
    _commandToken: 8,
    pos: () => ({ x: 8100, y: 6500, ts: Date.now() }),
    _distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
    _trigger: () => {},
    log: () => {},
    refreshTileStatus: async () => {},
    device: {
      _resolveNativeMaintenancePoint: () => ({ index: 2, x: 8100, y: 6500 }),
      _storeVerifiedMaintenancePoint: async () => { storedPrimary += 1; },
    },
  });
  assert.equal(await engine.confirmNativeMaintenanceArrival('test_p2_arrival', { x: 8100, y: 6500, ts: Date.now() }, 2), true);
  assert.equal(storedPrimary, 0);
  assert.equal(engine._lastMaintenanceReachedAt, 123);
  assert.equal(engine._manualMaintenanceTargetReachedIndex, 2);
});

test('verified additional arrival becomes a named Homey map marker while point 1 stays in place', async () => {
  const device = Object.create(MowerDevice.prototype);
  let persisted;
  Object.assign(device, {
    _activeMapIndex: 0,
    _storedAdditionalMaintenancePoints: {},
    _cachedMapData: { nativeMaintenancePoints: [{ index: 1, x: 100, y: 200 }] },
    getSetting: key => ({ maintenance_point_1_name: 'Garage-Service', maintenance_point_2_name: 'Rasenende' })[key] || '',
    setStoreValue: async (_key, value) => { persisted = structuredClone(value); },
    log: () => {},
  });
  const saved = await device._storeVerifiedAdditionalMaintenancePoint(2, { x: 8100.2, y: 6500.4 }, 'status_75_test');
  assert.deepEqual([saved.index, saved.x, saved.y], [2, 8100, 6500]);
  assert.equal(persisted['0']['2'].source, 'status_75_test');
  assert.deepEqual(device._cachedMapData.maintenancePoints.map(point => [point.index, point.name]), [
    [1, 'Garage-Service'], [2, 'Rasenende'],
  ]);
});
