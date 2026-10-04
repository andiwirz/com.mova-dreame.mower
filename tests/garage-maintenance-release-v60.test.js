'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const GarageSafetyEngine = require('../lib/garage/GarageSafetyEngine');

function createReturn() {
  const engine = Object.create(GarageSafetyEngine.prototype);
  const now = Date.now();
  const point = { x: 1400, y: 0 };
  let position = { x: point.x, y: point.y, ts: now - 500 };
  let state = 'closed';
  let danger = { known: true, inside: false, distance: 1400, radius: 600 };
  let dockCalls = 0;
  let openCalls = 0;
  const blocks = [];
  const holds = [];
  engine.device = {
    _nativeMowerStatus: 'paused',
    _dockPos: { x: 0, y: 0 },
    _cachedMapData: { chargerPos: { x: 0, y: 0 } },
    _resolveStableMaintenancePoint: async () => point,
    _poll: async () => {},
  };
  engine.pos = () => position;
  engine.status = () => engine.device._nativeMowerStatus;
  engine.markers = { rawDangerState: async () => danger };
  engine._lockedReturnMaintenancePoint = point;
  engine._manualMaintenanceReached = true;
  engine._manualMaintenancePhase = 'reached';
  engine._lastMaintenanceReachedAt = now - 3000;
  engine._returnContext = 'MAINTENANCE';
  engine._safeReturnInProgress = true;
  engine._returnGuardActive = true;
  engine._commandToken = 42;
  engine._stableOpenTimer = null;
  engine._emergencyHoldActive = () => false;
  engine._lastDoorOpenReleaseAt = 0;
  engine.doorState = () => state;
  engine.homey = { setTimeout: () => null };
  engine.log = () => {};
  engine.clearSafety = async () => {};
  engine.safetyWarning = async () => {};
  engine.safetyBlock = async (reason) => { blocks.push(reason); };
  engine.returnOperationalHold = async (reason) => { holds.push(reason); };
  engine.ensureDoorOpen = async () => { openCalls++; state = 'open'; engine._lastDoorOpenReleaseAt = Date.now(); return true; };
  const dockFn = async () => { dockCalls++; return true; };
  return {
    engine, now, point, blocks, holds, dockFn,
    get dockCalls() { return dockCalls; },
    get openCalls() { return openCalls; },
    position: (p) => { position = p; },
    danger: (d) => { danger = d; },
    gate: (s) => { state = s; },
  };
}

test('verified maintenance arrival remains usable if original position cache ages while gate opens', async (t) => {
  const a = createReturn();
  const realNow = Date.now();
  const mockNow = t.mock.method(Date, 'now', () => realNow);
  a.engine.ensureDoorOpen = async () => {
    a.gate('open');
    mockNow.mock.mockImplementation(() => realNow + 15000);
    a.engine._lastDoorOpenReleaseAt = Date.now();
    // The SAME verified sample is now >10 seconds old. Do not manufacture a
    // timestamp just because Homey receives the gate-open contact.
    return true;
  };
  assert.equal(await a.engine._continueReturnFromMaintenance('test', a.dockFn, 42), true);
  assert.equal(a.dockCalls, 1);
  assert.deepEqual(a.blocks, []);
});

test('a regressed or contradicted position timestamp never authorizes the dock command', async () => {
  const a = createReturn();
  a.engine.ensureDoorOpen = async () => {
    a.gate('open');
    a.engine._lastDoorOpenReleaseAt = Date.now();
    a.position({ x: 1400, y: 0, ts: a.now - 15000 });
    return true;
  };
  assert.equal(await a.engine._continueReturnFromMaintenance('test', a.dockFn, 42), false);
  assert.equal(a.dockCalls, 0);
});

test('a 90-second-old release proof expires instead of authorizing an unobserved return', async () => {
  const a = createReturn();
  a.gate('open');
  a.engine._lastDoorOpenReleaseAt = Date.now();
  const proof = {
    token: 42, verifiedAt: Date.now() - 91000,
    arrivalAt: a.engine._lastMaintenanceReachedAt,
    position: { x: 1400, y: 0, ts: a.now - 500 },
    target: { x: 1400, y: 0 },
  };
  assert.equal(await a.engine._maintenanceReleaseAfterOpening(proof, 42), 'arrival_proof_expired');
});

test('a fresh displacement after gate opening holds return without Safety-Block notification', async () => {
  const a = createReturn();
  a.engine.ensureDoorOpen = async () => {
    a.gate('open');
    a.engine._lastDoorOpenReleaseAt = Date.now();
    a.position({ x: 1750, y: 0, ts: Date.now() });
    return true;
  };
  assert.equal(await a.engine._continueReturnFromMaintenance('test', a.dockFn, 42), false);
  assert.equal(a.dockCalls, 0);
  assert.deepEqual(a.blocks, []);
  assert.deepEqual(a.holds, ['return_maintenance_release_unconfirmed']);
});

test('new post-opening position inside gate danger clearance blocks docking', async () => {
  const a = createReturn();
  a.engine.ensureDoorOpen = async () => {
    a.gate('open');
    a.engine._lastDoorOpenReleaseAt = Date.now();
    a.position({ x: 1400, y: 0, ts: Date.now() });
    a.danger({ known: true, inside: true, distance: 800, radius: 600 });
    return true;
  };
  assert.equal(await a.engine._continueReturnFromMaintenance('test', a.dockFn, 42), false);
  assert.equal(a.dockCalls, 0);
});

test('new returning status without a fresh position does not inherit old motion proof', async () => {
  const a = createReturn();
  a.engine.ensureDoorOpen = async () => {
    a.gate('open');
    a.engine._lastDoorOpenReleaseAt = Date.now();
    a.engine.device._nativeMowerStatus = 'returning';
    return true;
  };
  assert.equal(await a.engine._continueReturnFromMaintenance('test', a.dockFn, 42), false);
  assert.equal(a.dockCalls, 0);
});

test('a fresh stable position resolves delayed returning-status ambiguity', async () => {
  const a = createReturn();
  a.engine.ensureDoorOpen = async () => {
    a.gate('open');
    a.engine._lastDoorOpenReleaseAt = Date.now();
    a.engine.device._nativeMowerStatus = 'returning';
    a.position({ x: 1410, y: 0, ts: Date.now() });
    return true;
  };
  assert.equal(await a.engine._continueReturnFromMaintenance('test', a.dockFn, 42), true);
  assert.equal(a.dockCalls, 1);
});

test('an asynchronous safety lookup cannot release a superseded return', async () => {
  const a = createReturn();
  a.engine.ensureDoorOpen = async () => {
    a.gate('open');
    a.engine._lastDoorOpenReleaseAt = Date.now();
    a.position({ x: 1401, y: 0, ts: Date.now() });
    return true;
  };
  a.engine.markers.rawDangerState = async () => {
    // The first clearance check completes; the second one races a cancellation.
    a.engine._clearanceCallCount = (a.engine._clearanceCallCount || 0) + 1;
    if (a.engine._clearanceCallCount === 2) a.engine._commandToken++;
    return { known: true, inside: false, distance: 1400, radius: 600 };
  };
  assert.equal(await a.engine._continueReturnFromMaintenance('test', a.dockFn, 42), false);
  assert.equal(a.dockCalls, 0);
});

test('emergency or revoked arrival after opening prevents dock command', async () => {
  for (const alter of [
    (a) => { a.engine._emergencyGateContext = { reason: 'danger' }; },
    (a) => { a.engine._manualMaintenanceReached = false; },
    (a) => { a.engine._returnContext = 'IDLE'; },
    (a) => { a.engine._commandToken++; },
    (a) => { a.gate('closed'); },
  ]) {
    const a = createReturn();
    a.engine.ensureDoorOpen = async () => {
      a.gate('open');
      a.engine._lastDoorOpenReleaseAt = Date.now();
      alter(a);
      return true;
    };
    assert.equal(await a.engine._continueReturnFromMaintenance('test', a.dockFn, 42), false);
    assert.equal(a.dockCalls, 0);
  }
});

test('rejected native dock write becomes operational hold without Safety-Block notification', async () => {
  const a = createReturn();
  assert.equal(await a.engine._continueReturnFromMaintenance('test', async () => { return false; }, 42), false);
  assert.deepEqual(a.blocks, []);
  assert.deepEqual(a.holds, ['return_dock_command_rejected']);
});

test('missing initial stationary clearance never starts gate movement', async () => {
  const a = createReturn();
  a.engine.device._nativeMowerStatus = 'returning';
  assert.equal(await a.engine._continueReturnFromMaintenance('test', a.dockFn, 42), false);
  assert.equal(a.openCalls, 0);
  assert.equal(a.dockCalls, 0);
});

function emergencyReturn(a) {
  const e = a.engine;
  e.device.getData = () => ({ id: 'TEST_ONLY' });
  e.device._api = { dock: a.dockFn };
  e._setReturnContext = state => { e._returnContext = state; };
  e.clearSafety = async () => {};
  e._emergencyGateContext = { mowerMode: 'return', originalDoorTarget: 'closed', commandToken: 42 };
  return e;
}
test('emergency return uses normal bounded proof across slow gate opening', async t => {
  const a = createReturn(), e = emergencyReturn(a);
  const now = Date.now(); const clock = t.mock.method(Date, 'now', () => now);
  e.ensureDoorOpen = async () => { a.gate('open'); clock.mock.mockImplementation(() => now + 15000); e._lastDoorOpenReleaseAt = Date.now(); return true; };
  assert.equal(await e._restoreEmergencyPlanAfterMaintenance('test'), true);
  assert.equal(a.dockCalls, 1);
});
for (const contradiction of ['movement', 'cancel', 'door']) {
  test(`emergency return cannot dock after ${contradiction}`, async () => {
    const a = createReturn(), e = emergencyReturn(a);
    e.ensureDoorOpen = async () => {
      a.gate('open'); e._lastDoorOpenReleaseAt = Date.now();
      if (contradiction === 'movement') a.position({ x: 1800, y: 0, ts: Date.now() });
      if (contradiction === 'cancel') e._commandToken++;
      if (contradiction === 'door') a.gate('closed');
      return true;
    };
    assert.equal(await e._restoreEmergencyPlanAfterMaintenance('test'), false);
    assert.equal(a.dockCalls, 0);
  });
}
test('duplicate emergency arrival callbacks dispatch exactly one dock', async () => {
  const a = createReturn(), e = emergencyReturn(a);
  const results = await Promise.all([e._restoreEmergencyPlanAfterMaintenance('a'), e._restoreEmergencyPlanAfterMaintenance('b')]);
  assert.deepEqual(results, [true, true]); assert.equal(a.dockCalls, 1);
});
