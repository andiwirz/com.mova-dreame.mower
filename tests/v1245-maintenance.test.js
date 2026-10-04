'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const Engine = require('../lib/garage/GarageSafetyEngine');

let Device;
const previousLoad = Module._load;
try {
  Module._load = function(id, parent, main) {
    if (id === 'homey') return { Device: class {} };
    if (id === 'mqtt') return {};
    return previousLoad.call(this, id, parent, main);
  };
  Device = require('../drivers/mower/device');
} finally {
  Module._load = previousLoad;
}

test('1.2.45 maintenance watcher is armed before opcode 109 write can resolve', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync('lib/garage/GarageSafetyEngine.js', 'utf8');
  const start = src.indexOf('  async maintenanceRequested(source, fn)');
  const end = src.indexOf('\n  async stopGateManually', start);
  const body = src.slice(start, end);
  const watchAt = body.indexOf('this._watchMaintenanceReached(async () =>');
  const awaitAt = body.indexOf('const accepted = await fn();');
  assert.ok(watchAt >= 0 && awaitAt >= 0 && watchAt < awaitAt);
  assert.match(body, /this\._manualMaintenanceCommandAcceptedAt = Number\(this\.device\._nativeMaintenanceCommandAt \|\| 0\) \|\| Date\.now\(\)/);
});

test('1.2.45 native maintenance command timestamp prevents tile from staying garage_start_pending', () => {
  const e = Object.create(Engine.prototype);
  e.device = { _nativeMaintenanceCommandAt: Date.now() - 6000 };
  e.enabled = () => true;
  e.doorState = () => 'open';
  e.isDoorOpenStable = () => true;
  e._safeReturnInProgress = false;
  e._returnGuardActive = false;
  e._returnContext = null;
  e._outbound = null;
  e._manualMaintenanceReached = false;
  e._manualMaintenanceCommandAcceptedAt = 0;
  e._manualMaintenanceTransit = true;
  e._manualMaintenancePhase = 'transit';
  assert.equal(e.getTileStatus('mowing'), 'garage_maintenance_transit');
});

test('1.2.45 A2 error/device code 75 confirms opcode 109 only with maintenance-point geometry', async () => {
  const d = Object.create(Device.prototype);
  d._nativeMaintenanceCommandAt = Date.now() - 12000;
  d._nativeMaintenanceStableArrival = null;
  d._pendingNativeMaintenanceArrival = null;
  d._livePos = { x: -2950, y: -4600, ts: Date.now() };
  d._getBufferedLivePosition = () => d._livePos;
  d._resolveStableMaintenancePoint = async () => ({ x: -2850, y: -4650 });
  d._garageSafety = {
    isReturnCycleActive: () => true,
    _returnContext: null,
    _manualMaintenanceTransit: true,
    lastRequestedAction: 'button_maintenance_external_recovered',
  };
  d.log = () => {};
  let commits = 0;
  d._commitPendingNativeMaintenanceArrival = async () => { commits++; return true; };
  const ok = await d._observeNativeMaintenanceArrival(2, 'idle', 75);
  assert.equal(ok, true);
  assert.equal(commits, 1);
  assert.equal(d._pendingNativeMaintenanceArrival.reason, 'native_code_75_geometry_confirmed');

  d._livePos = { x: -190, y: -910, ts: Date.now() };
  d._pendingNativeMaintenanceArrival = null;
  commits = 0;
  const far = await d._observeNativeMaintenanceArrival(2, 'idle', 75);
  assert.equal(far, false);
  assert.equal(commits, 0);
});

test('1.2.45 successful maintenance arrival preserves an existing original-app target', async () => {
  const d = Object.create(Device.prototype);
  d._pendingNativeMaintenanceArrival = { at: Date.now() - 100, expiresAt: Date.now() + 10000, reason: 'native_code_75_geometry_confirmed' };
  d._getBufferedLivePosition = () => ({ x: -2950, y: -4600, ts: Date.now() });
  d._resolveStableMaintenancePoint = async () => ({ x: -2850, y: -4650, source: 'map_editor' });
  d._nativeMaintenanceArrivalLatched = false;
  d._nativeMaintenanceStableArrival = null;
  d._nativeMaintenanceCommandAt = Date.now() - 10000;
  d._maintenancePointCandidate = null;
  d._storeVerifiedMaintenancePoint = async () => { throw new Error('existing target must not be rewritten'); };
  d.log = () => {};
  d.error = () => {};
  let confirmed;
  d._garageSafety = { confirmNativeMaintenanceArrival: async (reason, pos) => { confirmed = { reason, pos }; return true; } };
  const ok = await d._commitPendingNativeMaintenanceArrival();
  assert.equal(ok, true);
  assert.equal(confirmed.reason, 'native_code_75_geometry_confirmed');
  assert.equal(confirmed.pos.x, -2950);
  assert.equal(confirmed.pos.y, -4600);
  assert.equal(d._nativeMaintenanceCommandAt, 0);
});
