'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../lib/garage/GarageSafetyEngine');

test('native PAUSE and STOP run before timeline, Flow and capability writes', async () => {
  const events = [];
  const engine = Object.create(Engine.prototype);
  Object.assign(engine, {
    enabled: () => true,
    status: () => 'charging',
    _freshNativeDockState: () => ({ dockingState: 'IN_STATION', undocking: 1 }),
    _doorOpenVerifiedThisRuntime: () => false,
    isDoorOpenStable: () => false,
    isDockedHomeStatus: () => true,
    isReturnCycleActive: () => false,
    log: () => {},
    realtimeTimelineEvent: () => events.push('timeline'),
    _trigger: () => events.push('flow'),
    _stopExternalStartOldTaskEarly: async () => { events.push('stop'); return true; },
    _clearOutboundStatusTimers: () => {},
    ensureDoorOpen: async () => false,
    safetyBlock: async () => {},
    device: {
      getData: () => ({ id: 'fixture' }),
      _api: { pause: async () => { events.push('pause'); } },
      _safeWrite: async (_label, command) => { await command(); return true; },
      _applyStatus: async () => { events.push('capability'); },
    },
  });
  assert.equal(await engine.onExternalStartIntent('mqtt_native_undock_1_1'), false);
  assert.deepEqual(events.slice(0, 5), ['pause', 'stop', 'timeline', 'flow', 'capability']);
});

test('station loss observed during PAUSE is not cleared by the STOP stage', async () => {
  const engine = Object.create(Engine.prototype);
  engine._externalStartRecoveryStartedAt = Date.now();
  engine._externalStartStationWindowLost = true;
  engine._setExternalStartRecoveryPhase = () => {};
  engine.log = () => {};
  engine._freshNativeDockState = () => ({ dockingState: 'IN_STATION', undocking: 0 });
  engine.device = {
    _api: { stopMowing: async () => true },
    _safeWrite: async (_label, command) => { await command(); return true; },
  };
  assert.equal(await engine._stopExternalStartOldTaskEarly('test', 'fixture'), true);
  assert.equal(engine._externalStartStationWindowLost, true);
  engine.device._mowerBinaryDiag = { dockingState: 'IN_STATION', undocking: 0 };
  engine.device._mowerBinaryDiagAt = Date.now();
  assert.equal(engine._nativeStationContextForExternalRecovery(45000), null);
});
