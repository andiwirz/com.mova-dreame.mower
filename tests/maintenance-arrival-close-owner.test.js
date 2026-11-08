'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../lib/garage/GarageSafetyEngine');

function fixture(index) {
  const e = Object.create(Engine.prototype);
  const position = { x: -2950, y: -4610, ts: Date.now() };
  const calls = [];
  Object.assign(e, {
    _commandToken: 3, _maintenanceRequestedAt: Date.now(),
    _manualMaintenanceTransit: true, _manualMaintenancePhase: 'transit',
    _maintenanceArrivalClose: { token: 3, index }, _returnContext: 'IDLE',
    device: { _observedMowerStatus: 'paused',
      _resolveStableMaintenancePoint: async () => position,
      _resolveNativeMaintenancePoint: () => position },
    markers: { rawDangerState: async () => ({ known: true, distance: 5000, radius: 900 }) },
    pos: () => position, status: () => 'paused',
    log() {}, _text: (de, en) => en, _trigger() {}, refreshTileStatus: async () => {},
    requestClose: async (reason, options) => { calls.push({ reason, options }); return true; },
  });
  return { e, position, calls };
}

test('all supported maintenance indexes close on confirmed arrival without a navigation callback', async () => {
  for (const index of [1, 2, 3, 4, 5]) {
    const { e, calls } = fixture(index);
    assert.equal(await e.confirmNativeMaintenanceArrival('native_command_arrival', null, index), true);
    assert.deepEqual(calls, [{ reason: 'maintenance_reached_close', options: { maintenanceArrivalVerified: true } }]);
    assert.equal(e._maintenanceArrivalClose, null);
    assert.equal(await e._tryMaintenanceArrivalClose(), false);
  }
});

test('a transient guard denial is retried using current physical clearance', async () => {
  const { e, calls } = fixture(2);
  e.requestClose = async () => { calls.push('check'); return calls.length > 1; };
  await e.confirmNativeMaintenanceArrival('native_command_arrival', null, 2);
  assert.ok(e._maintenanceArrivalClose);
  assert.equal(await e._tryMaintenanceArrivalClose(), false); // rate limited
  e._maintenanceArrivalClose.lastAttemptAt = Date.now() - 2100;
  assert.equal(await e._tryMaintenanceArrivalClose(), true);
  assert.equal(calls.length, 2);
});

test('return, STOP, supersession, movement, stale position and raw danger never release maintenance close', async () => {
  for (const mutate of [
    e => { e._safeReturnInProgress = true; },
    e => { e._manualGateStopped = true; },
    e => { e._commandToken++; },
    (e, p) => { p.x += 500; },
    (e, p) => { p.ts = Date.now() - 60000; },
    e => { e.markers.rawDangerState = async () => ({ known: true, distance: 1000, radius: 900 }); },
    e => { e.device._observedMowerStatus = 'mowing'; },
  ]) {
    const { e, position, calls } = fixture(2);
    e._manualMaintenanceTransit = false; e._manualMaintenanceReached = true;
    e._manualMaintenancePhase = 'reached'; e._manualMaintenanceTargetReachedIndex = 2;
    e._maintenanceArrivalClose.position = { ...position };
    mutate(e, position);
    assert.equal(await e._tryMaintenanceArrivalClose(), false);
    assert.equal(calls.length, 0);
  }
});

test('new command during asynchronous raw clearance cancels the close', async () => {
  const { e, calls } = fixture(2);
  e.markers.rawDangerState = async () => { e._commandToken++; return { known: true, distance: 5000, radius: 900 }; };
  await e.confirmNativeMaintenanceArrival('native_command_arrival', null, 2);
  assert.equal(calls.length, 0);
});
