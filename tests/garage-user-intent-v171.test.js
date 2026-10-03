'use strict'
const test = require('node:test');
const assert = require('node:assert/strict');
const GarageSafetyEngine = require('../lib/garage/GarageSafetyEngine');

function baseEngine() {
  const e = Object.create(GarageSafetyEngine.prototype);
  e.homey = { setTimeout: () => null };
  e.device = {
    _nativeMowerStatus: 'paused',
    _observedMowerStatus: 'paused',
    _observedMowerStatusAt: Date.now(),
    getData: () => ({ id: 'TEST' }),
    getSetting: () => null,
    _api: {},
    _safeWrite: async (_label, fn) => fn(),
    error: () => {},
    log: () => {},
  };
  e.status = () => e.device._nativeMowerStatus;
  e.pos = () => ({ x: 1400, y: 0, ts: Date.now() });
  e.log = () => {};
  e.error = () => {};
  e.debugLog = () => {};
  e.refreshTileStatus = async () => {};
  e._setReturnContext = function (state) { this._returnContext = state; };
  e._returnContext = 'IDLE';
  e._commandToken = 11;
  e._missionOutside = true;
  e._homeState = 'away';
  e._manualGateStopped = false;
  e._timeline = () => {};
  e._text = (de) => de;
  e.safetyWarning = async () => {};
  e.safetyBlock = async (reason) => { throw new Error(`unexpected block ${reason}`); };
  return e;
}

test('stationary closed gate during return is controlled recovery, never Emergency', async () => {
  const e = baseEngine();
  e._returnContext = 'DOCK';
  e._safeReturnInProgress = true;
  e._returnGuardActive = true;
  e.isReturnCycleActive = () => true;
  e.device._nativeMowerStatus = 'returning';
  e.device._api.pause = async () => {
    e.device._nativeMowerStatus = 'paused';
    e.device._observedMowerStatus = 'paused';
    e.device._observedMowerStatusAt = Date.now() + 1;
    return true;
  };
  e._lockReturnMaintenancePoint = async () => { e._lockedReturnMaintenancePoint = { x: 1400, y: 0 }; };
  e._isCurrentlyAtKnownMaintenancePoint = async () => false;
  let maintenance = 0;
  e.device._goToMaintenancePointGuarded = async () => { maintenance++; return true; };
  e._watchMaintenanceReached = () => {};
  let emergencies = 0;
  e.emergency = async () => { emergencies++; };
  const ok = await e._routeClosedGateReturnViaMaintenance('test');
  assert.equal(ok, true);
  assert.equal(maintenance, 1);
  assert.equal(emergencies, 0);
  assert.equal(e._returnContext, 'MAINTENANCE');
});

test('gate may not start opening with mower in danger area unless securely home', async () => {
  const e = baseEngine();
  e.doorState = () => 'closed';
  e.isDockedHomeStatus = () => false;
  e.markers = { dangerState: async () => ({ inside: true }) };
  e._trigger = () => { throw new Error('gate flow must not trigger'); };
  let warning = '';
  e.safetyWarning = async (r) => { warning = r; };
  const ok = await e.requestOpen('test_front_of_gate', { allowOpenFromDanger: true });
  assert.equal(ok, false);
  assert.match(warning, /open_blocked_mower/);
});

test('verified maintenance point can start a new mowing command without moving closed gate', async () => {
  const e = baseEngine();
  e.enabled = () => true;
  e._manualMaintenanceReached = true;
  e._manualMaintenancePhase = 'reached';
  e._lastMaintenanceReachedAt = Date.now();
  e._isCurrentlyAtKnownMaintenancePoint = async () => true;
  e.isDoorOpenStable = () => false;
  e.doorState = () => 'closed';
  e.positionKnown = () => true;
  e.isDockedHomeStatus = () => false;
  e.markers = {
    ready: async () => true,
    rawLineA: async () => ({x:0,y:0}),
    rawLineB: async () => ({x:1,y:0}),
    dangerCenter: async () => ({x:0,y:0}),
    isInDangerArea: async () => false,
  };
  e.sensorEnabled = () => false;
  e._beginOutbound = async () => {};
  e._waitForMowerOnlineBeforeStart = async () => true;
  e._markOutboundReleased = async () => {};
  e._confirmReleasedStart = async () => {};
  e.ensureDoorOpen = async () => { throw new Error('gate must stay closed for outside maintenance start'); };
  let started = 0;
  const ok = await e.startRequested('button_start_mowing', async () => { started++; return true; });
  assert.equal(ok, true);
  assert.equal(started, 1);
});
