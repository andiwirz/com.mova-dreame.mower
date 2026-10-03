'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Engine = require('../lib/garage/GarageSafetyEngine');

const previousLoad = Module._load;
let Device;
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

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('v1.2.12 active return/maintenance can never be classified as outdoor Pause→Resume', async () => {
  const d = Object.create(Device.prototype);
  d._garageSafety = {
    enabled: () => true,
    isReturnCycleActive: () => true,
    isMissionOutside: () => true,
  };
  d._lastLivePosAt = Date.now();
  d._livePos = { x: 1, y: 2, ts: d._lastLivePosAt };
  d.log = () => {};
  assert.equal(await d._isOutsideGarageMissionResume('paused'), false);
  assert.equal(await d._isOutsideGarageMissionResume('idle'), false);
});

test('v1.2.12 Resume no longer fabricates native mowing state', () => {
  const src = read('drivers/mower/device.js');
  const start = src.indexOf('  async _resumeMowingRobust(');
  const end = src.indexOf('  async cmdPause()', start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /_applyStatus\('mowing',\s*0,\s*false\)/);
  assert.match(body, /freshMowingConfirmed/);
  // 1.2.13 follow-up: callers must not restore the same fabrication that the
  // helper deliberately removed.
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('_resumeMowingRobust(')) continue;
    assert.doesNotMatch(lines.slice(i, i + 5).join('\n'), /_applyStatus\(['\"]mowing['\"]/, `synthetic mowing after resume near line ${i + 1}`);
  }
  const applyStart = src.indexOf('  async _applyStatus(');
  const applyEnd = src.indexOf('  async _setMowingStarted', applyStart);
  const apply = src.slice(applyStart, applyEnd);
  assert.doesNotMatch(apply, /status === 'paused'[\s\S]{0,450}status = 'mowing'/);
});

test('v1.2.12 confirmed maintenance transit owns route and is not stopped by current-position hold', async () => {
  const e = Object.create(Engine.prototype);
  e._returnContext = 'MAINTENANCE';
  e._maintenanceWatch = {};
  e._maintenanceRequestedAt = 1000;
  e._maintenanceDepartureConfirmedAt = 1500;
  e._manualMaintenanceReached = false;
  e.log = () => {};
  e.safetyWarning = async () => {};
  e._timeline = () => {};
  e._safeReturnInProgress = true;
  e._returnGuardActive = true;
  e._returnRecoveryRequest = { token: 1 };
  e._commandToken = 1;
  e._manualGateStopped = false;
  e._emergencyGateContext = null;
  e._emergencyHoldActive = () => false;
  let stopped = 0;
  e._stopReturnForRecovery = async () => { stopped++; return true; };
  await e.returnOperationalHold('maintenance_current_unconfirmed');
  assert.equal(stopped, 0);
  assert.equal(e._returnRecoveryHold, undefined);
});

test('v1.2.12 repeated charging telemetry can provide the second stable-dock proof', () => {
  const e = Object.create(Engine.prototype);
  e._homeDockStableSince = 1000;
  e._homeDockLastProofAt = 1000;
  e._strongDockCloseProof = () => true;
  e.noteHomeChargingTelemetry('charging', 2000);
  assert.equal(e._homeDockLastProofAt, 2000);
  e.noteHomeChargingTelemetry('not_charging', 3000);
  assert.equal(e._homeDockLastProofAt, 2000);
});

test('v1.2.12 manual OPEN accepts fresh IN_STATION/u0 without weakening CLOSE proof', () => {
  const e = Object.create(Engine.prototype);
  e.device = {
    _mowerBinaryDiag: { dockingState: 'IN_STATION', undocking: 0, chargingLive: false },
    _mowerBinaryDiagAt: Date.now(),
    getCapabilityValue: () => 'not_charging',
    _chargingStatusAt: 0,
  };
  e.isDockedHomeStatus = () => false;
  e._outbound = false;
  e._manualMaintenanceTransit = false;
  assert.equal(e._manualGateOpenDockProof(), true);
  e.device._mowerBinaryDiag.undocking = 1;
  assert.equal(e._manualGateOpenDockProof(), false);
  const src = read('lib/garage/GarageSafetyEngine.js');
  const start = src.indexOf('  async manualGateRequest(action)');
  const end = src.indexOf('  async _reuseVerifiedMaintenanceArrivalForReturn', start);
  const body = src.slice(start, end);
  assert.match(body, /safeDockClose = \(this\._homeDockReadyForClose\(\) \|\| this\._strongDockCloseProof\(\)\)/);
  assert.match(body, /safeDockOpen = action === 'open' && this\._manualGateOpenDockProof\(\)/);
});

test('v1.2.12 status 75 only commits inside a current maintenance context or recent native command', () => {
  const src = read('drivers/mower/device.js');
  const start = src.indexOf('  async _observeNativeMaintenanceArrival(');
  const end = src.indexOf('\n  async ', start + 10);
  const body = src.slice(start, end > start ? end : undefined);
  assert.match(body, /activeMaintenanceContext/);
  assert.match(body, /raw75 && noFault && \(recentNativeCommand \|\| activeMaintenanceContext\)/);
});

test('v1.2.12 recoverable code 27 after explicit outdoor pause is not announced as a hard fault', () => {
  const src = read('drivers/mower/device.js');
  assert.match(src, /recoverablePauseFault = isError && Number\(faultCode\) === 27 && this\._recoverablePausedOutsideError\(\)/);
  assert.match(src, /_setCap\('alarm_generic', isError && !recoverablePauseFault\)/);
  assert.match(src, /\(isError \|\| isWarning\) && !recoverablePauseFault/);
});
