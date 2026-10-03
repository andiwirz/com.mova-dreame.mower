'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const GarageSafetyEngine = require('../lib/garage/GarageSafetyEngine');

const stamp = () => Date.now();
function mockEngine() {
  const engine = Object.create(GarageSafetyEngine.prototype);
  engine.homey = { setTimeout: (fn) => { /* no hardware timers in unit tests */ } };
  engine.device = {
    _dockPos: { x: 0, y: 0 },
    _cachedMapData: { chargerPos: { x: 0, y: 0 } },
    _nativeMowerStatus: 'paused',
    getCapabilityValue: () => null,
    getSetting: () => null,
    getData: () => ({ id: 'TEST_ONLY' }),
    _resolveStableMaintenancePoint: async () => ({ x: 1400, y: 0 }),
  };
  engine.pos = () => ({ x: 1400, y: 0, ts: stamp() });
  engine.status = () => engine.device._nativeMowerStatus;
  engine.markers = {
    rawDangerState: async () => ({ known: true, inside: false, distance: 1400, radius: 600 }),
    dangerState: async () => ({ known: true, inside: false, distance: 1400, radius: 600 }),
    lineState: async () => ({ known: true, onSegment: false, side: null, rawSide: null, distance: -2136, t: -1.23, rawThreshold: 60, direction: { known: true, garageSide: -1, lawnSide: 1 } }),
  };
  engine.log = () => {};
  engine.debugLog = () => {};
  engine.safetyBlock = async () => {};
  engine.safetyWarning = async () => {};
  engine._speedMetersPerSecond = () => ({ mps: 0.36, basis: 'unit_test' });
  engine._mapBoundaryNormalized = () => ({ minX: -6000, minY: -6000, maxX: 6000, maxY: 6000 });
  engine._doorOpenDurationSeconds = () => 10;
  engine._doorDelaySeconds = () => 10;
  engine._returnContext = 'IDLE';
  engine._commandToken = 7;
  engine._lockedReturnMaintenancePoint = { x: 1400, y: 0 };
  engine._manualMaintenanceReached = true;
  engine._manualMaintenancePhase = 'reached';
  engine._lastMaintenanceReachedAt = stamp();
  engine.doorState = () => 'closed';
  engine.enabled = () => true;
  engine._emergencyHoldActive = () => false;
  return engine;
}

test('off-segment t=-1.23 does not count as valid garage/lawn-side crossing', async () => {
  const engine = mockEngine();
  const route = await engine._decideReturnPath('external_status_returning');
  assert.equal(route.mode, 'maintenance');
  assert.notEqual(route.reason, 'garage_side_of_safety_line_use_maintenance');
});

test('maintenance gate-opening proof needs fresh stationary verified arrival and actual danger clearance', async () => {
  const engine = mockEngine();
  assert.equal(await engine._verifiedMaintenanceReturnClearance(), true);
  engine.device._nativeMowerStatus = 'returning';
  assert.equal(await engine._verifiedMaintenanceReturnClearance(), false);
  engine.device._nativeMowerStatus = 'paused';
  engine.pos = () => ({ x: 1400, y: 0, ts: stamp() - 12000 });
  assert.equal(await engine._verifiedMaintenanceReturnClearance(), false);
  engine.pos = () => ({ x: 1400, y: 0, ts: stamp() });
  engine.markers.rawDangerState = async () => ({ known: true, inside: true, distance: 600, radius: 600 });
  assert.equal(await engine._verifiedMaintenanceReturnClearance(), false);
  engine.markers.rawDangerState = async () => ({ known: true, inside: false, distance: 1400, radius: NaN });
  assert.equal(await engine._verifiedMaintenanceReturnClearance(), false);
});

test('return gate does not open near a moving mower inside physical danger circle', async () => {
  const engine = mockEngine();
  engine._returnContext = 'MAINTENANCE';
  engine._safeReturnInProgress = true;
  engine.device._nativeMowerStatus = 'returning';
  engine.markers.rawDangerState = async () => ({ known: true, inside: true, distance: 400, radius: 600 });
  let openTriggers = 0;
  engine._trigger = () => { openTriggers += 1; };
  const ok = await engine.requestOpen('return_from_maintenance', { allowOpenFromDanger: true });
  assert.equal(ok, false);
  assert.equal(openTriggers, 0);
});

test('opening-gate occupancy exception rejects stale maintenance arrival', async () => {
  const engine = mockEngine();
  engine._returnContext = 'MAINTENANCE';
  engine.isReturnCycleActive = () => true;
  engine.isDockedHomeStatus = () => false;
  engine._missionOutside = true;
  engine._lastMaintenanceReachedAt = stamp() - 130000;
  engine.pos = () => ({ x: 1400, y: 0, ts: stamp() - 130000 });
  assert.equal(await engine._expectedOpeningDangerOccupancy(), false);
});

test('rejected safety-line PAUSE cannot trigger gate opening or optimistic paused status', async () => {
  const engine = mockEngine();
  engine.device._nativeMowerStatus = 'returning';
  let opened = 0;
  let fakeStatus = 0;
  engine.device._safeWrite = async () => false;
  engine.device._api = { pause: async () => true };
  engine.device._applyStatus = async () => { fakeStatus++; };
  engine.ensureDoorOpen = async () => { opened++; return true; };
  engine.error = () => {};
  const ok = await engine._waitAtSafetyLineUntilDoorOpenThenDock(async () => {}, 7, 'test');
  assert.equal(ok, false);
  assert.equal(opened, 0);
  assert.equal(fakeStatus, 0);
});

test('off-segment active return near closed gate diverts via maintenance without gate motion', async () => {
  const engine = mockEngine();
  engine.device._nativeMowerStatus = 'returning';
  engine._returnContext = 'DOCK';
  engine._missionOutside = true;
  engine.isDockedHomeStatus = () => false;
  engine._recordPositionForDerivedSpeed = () => {};
  engine._maybeReleaseResumeGuard = async () => {};
  engine._lastDangerInside = false;
  engine._detectClosedGateFrontReturn = async () => false;
  engine._trackRawDangerExit = () => {};
  engine._hasFreshSafetyPosition = () => true;
  let detours = 0;
  engine._routeClosedGateReturnViaMaintenance = async () => { detours++; return true; };
  await engine.updatePositionGuards();
  assert.equal(detours, 1);
  assert.ok(engine._offSegmentReturnRecoveryAt > 0);
});

test('maintenance outing uses distinct timeline text without relabeling a mowing mission', () => {
  const engine = mockEngine();
  const events = [];
  engine._text = (de) => de;
  engine._humanReason = (s) => s;
  engine._timeline = (message) => events.push(message);
  engine.lastRequestedAction = 'button_maintenance';
  engine.realtimeTimelineEvent('resume_outside', 'mqtt_status');
  assert.match(events[0], /Wartungspunktfahrt/);
  engine._manualMaintenanceReached = false;
  engine.realtimeTimelineEvent('resume_outside', 'mqtt_status');
  assert.match(events[1], /Mähvorgang/);
});

test('native vendor RETURNING is intercepted after completed manual maintenance outing', async () => {
  const engine = mockEngine();
  engine.lastRequestedAction = 'button_maintenance';
  engine._manualMaintenanceTransit = false;
  engine._manualMaintenanceReached = true;
  engine._missionOutside = true;
  engine._homeState = 'away';
  engine._returnContext = 'IDLE';
  engine.device._nativeMowerStatus = 'returning';
  engine.isDockedHomeStatus = () => false;
  engine._nativeHomeStatus = () => false;
  engine._chargingIndicatesDocked = () => false;
  engine._cancelSuspectedPausedReturn = () => {};
  engine._clearOutboundStatusTimers = () => {};
  engine._setLineState = () => {};
  engine.refreshTileStatus = async () => {};
  let intercepted;
  engine._interceptExternalReturn = async (source) => { intercepted = source; return true; };
  await engine.onStatus('returning', 'paused');
  assert.equal(intercepted, 'status_returning');
});

test('fresh binary OUT_OF_STATION prevents closing on a stale native dock status', async () => {
  const engine = mockEngine();
  engine._nativeDockVerifiedAt = stamp();
  engine._homeCycleLocked = true;
  engine._missionOutside = false;
  engine._homeState = 'home';
  engine._maintenanceCloseProtected = () => false;
  engine.doorState = () => 'open';
  engine.device._mowerBinaryDiag = { dockingState: 'OUT_OF_STATION', undocking: 0 };
  engine.device._mowerBinaryDiagAt = stamp();
  engine.closeGuardReport = async () => ({ home: 'home', nativeStatus: 'returning', ready: true });
  engine._logCloseReport = () => {};
  let warning;
  engine.safetyWarning = async (value) => { warning = value; };
  const closed = await engine.requestClose('home_15s');
  assert.equal(closed, false);
  assert.equal(warning, 'close_blocked_inbound_motion_active');
});


test('emergency context treats a verified maintenance hold as maintenance, not generic paused mowing', () => {
  const engine = mockEngine();
  engine._manualMaintenanceTransit = false;
  engine._manualMaintenanceReached = true;
  engine._manualMaintenancePhase = 'reached';
  engine.isReturnCycleActive = () => false;
  engine.isMowing = () => false;
  engine._outbound = null;
  engine.lastRequestedAction = 'button_maintenance';
  engine.doorState = () => 'open';
  const ctx = engine._captureEmergencyGateContext('closing', 'unit_test');
  assert.equal(ctx.mowerMode, 'maintenance');
  assert.equal(ctx.originalAction, 'button_maintenance');
});

test('emergency at an already verified maintenance point does not send a duplicate maintenance command', async () => {
  const engine = mockEngine();
  engine._emergencyGateContext = { mowerMode: 'maintenance', originalDoorTarget: 'open', originalAction: 'button_maintenance' };
  engine._lockReturnMaintenancePoint = async () => { engine._lockedReturnMaintenancePoint = { x: 1400, y: 0 }; };
  engine._isCurrentlyAtKnownMaintenancePoint = async () => true;
  let maintenanceCommands = 0;
  engine.device._goToMaintenancePointGuarded = async () => { maintenanceCommands++; return true; };
  let restored = 0;
  engine._restoreEmergencyPlanAfterMaintenance = async () => { restored++; return true; };
  assert.equal(await engine._dispatchEmergencyMaintenance('unit_test'), true);
  assert.equal(maintenanceCommands, 0, 'already-arrived mower must not receive a no-op maintenance command');
  assert.equal(restored, 1, 'existing emergency plan is restored immediately from the verified point');
});

test('restoring a maintenance emergency sends no mower movement command', async () => {
  const engine = mockEngine();
  engine.device.getData = () => ({ id: 'TEST_ONLY' });
  engine.device._api = {
    dock: async () => { throw new Error('dock must not run'); },
    resume: async () => { throw new Error('resume must not run'); },
  };
  engine.device._safeWrite = async () => { throw new Error('safeWrite must not run'); };
  engine.device._resumeMowingRobust = async () => { throw new Error('resume robust must not run'); };
  engine._setReturnContext = () => {};
  engine._safeReturnInProgress = true;
  engine._returnGuardActive = true;
  engine.lastRequestedAction = null;
  const result = await engine._resumeInterruptedMissionAfterEmergency({
    mowerMode: 'maintenance',
    originalAction: 'button_maintenance',
  }, 'unit_test');
  assert.equal(result, true);
  assert.equal(engine._safeReturnInProgress, false);
  assert.equal(engine._returnGuardActive, false);
  assert.equal(engine.lastRequestedAction, 'button_maintenance');
});

test('final garage close requires positive physical dock proof', () => {
  const engine = mockEngine();
  engine.device.getCapabilityValue = (name) => name === 'charging_status' ? null : null;

  engine.device._mowerBinaryDiag = { dockingState: 'OUT_OF_STATION', undocking: 0 };
  engine.device._mowerBinaryDiagAt = stamp();
  engine.device._nativeMowerStatus = 'docked';
  assert.equal(engine._strongDockCloseProof(), false, 'fresh out-of-station bit overrides a cloud docked frame');

  engine.device._mowerBinaryDiag = { dockingState: 'IN_STATION', undocking: 0, chargingLive: true };
  engine.device._mowerBinaryDiagAt = stamp();
  assert.equal(engine._strongDockCloseProof(), true, 'fresh physical in-station and charging bits establish dock proof');

  engine.device._mowerBinaryDiag = { dockingState: 'IN_STATION', undocking: 1 };
  assert.equal(engine._strongDockCloseProof(), false, 'undocking/adjusting blocks the gate');

  engine.device._mowerBinaryDiag = null;
  engine.device._mowerBinaryDiagAt = 0;
  engine.device._nativeMowerStatus = 'docked';
  assert.equal(engine._strongDockCloseProof(), false, 'plain docked status alone is intentionally insufficient');

  engine.device._nativeMowerStatus = 'charging';
  engine.device._observedMowerStatusAt = stamp();
  assert.equal(engine._strongDockCloseProof(), true, 'actual charging is accepted when binary station proof is unavailable');
});

for (const phase of ['exiting', 'adjusting', 'positioning', 'transit', 'reached']) {
  test(`emergency preserves maintenance mission during ${phase}`, async () => {
    const e = mockEngine();
    e._manualMaintenancePhase = phase;
    e._manualMaintenanceTransit = phase !== 'reached';
    e._manualMaintenanceReached = phase === 'reached';
    e._outbound = { requiresMowingStable: false };
    e.isReturnCycleActive = () => false;
    e._safeReturnInProgress = false;
    e._returnGuardActive = false;
    e.lastRequestedAction = 'button_maintenance';
    const ctx = e._captureEmergencyGateContext('closing', 'test');
    assert.equal(ctx.mowerMode, 'maintenance');
    let movement = 0;
    e.device._api = { dock: async () => movement++, resume: async () => movement++ };
    e.device._resumeMowingRobust = async () => movement++;
    e._setReturnContext = () => {};
    await e._resumeInterruptedMissionAfterEmergency(ctx);
    assert.equal(movement, 0);
  });
}
test('unknown paused and non-mowing outbound never infer mowing', () => {
  const e = mockEngine(); e._manualMaintenanceReached = false; e._manualMaintenancePhase = 'idle';
  e._outbound = { requiresMowingStable: false }; e.lastRequestedAction = null;
  assert.equal(e._captureEmergencyGateContext('opening').mowerMode, 'other');
});
test('confirmed mowing outbound retains mowing mission', () => {
  const e = mockEngine(); e._manualMaintenanceReached = false; e._manualMaintenancePhase = 'idle';
  e._outbound = { requiresMowingStable: true };
  assert.equal(e._captureEmergencyGateContext('opening').mowerMode, 'mowing');
});
test('cancelled emergency cannot resume mower', async () => {
  const e = mockEngine(); let moved = false;
  e.device._resumeMowingRobust = async () => { moved = true; };
  assert.equal(await e._resumeInterruptedMissionAfterEmergency({ mowerMode: 'mowing', commandToken: 6 }), false);
  assert.equal(moved, false);
});
