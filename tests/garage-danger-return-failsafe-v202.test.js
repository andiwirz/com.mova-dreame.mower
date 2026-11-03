'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GarageSafetyEngine = require('../lib/garage/GarageSafetyEngine');

const stamp = () => Date.now();

function engineBase() {
  const e = Object.create(GarageSafetyEngine.prototype);
  e.homey = { setTimeout: () => {} };
  e.device = {
    _dockPos: { x: 0, y: 0 },
    _cachedMapData: { chargerPos: { x: 0, y: 0 } },
    _nativeMowerStatus: 'returning',
    getCapabilityValue: () => null,
    getSetting: (key) => key === 'garage_caution_radius_mm' ? 1200 : null,
    getData: () => ({ id: 'TEST_ONLY' }),
  };
  e.pos = () => ({ x: 500, y: 0, ts: stamp() });
  e.status = () => e.device._nativeMowerStatus;
  e.enabled = () => true;
  e.doorState = () => 'closed';
  e.isDockedHomeStatus = () => false;
  e._missionOutside = true;
  e._returnContext = 'DOCK';
  e._safeReturnInProgress = true;
  e._returnGuardActive = true;
  e._commandToken = 10;
  e._outbound = null;
  e._emergencyGateContext = null;
  e._awaitingLineDoorOpen = false;
  e._lastDangerInside = false;
  e._recordPositionForDerivedSpeed = () => {};
  e._maybeReleaseResumeGuard = async () => {};
  e._detectClosedGateFrontReturn = async () => false;
  e._detectSpatialExternalReturn = async () => false;
  e._trackRawDangerExit = () => {};
  e._hasFreshSafetyPosition = () => true;
  e._emergencyHoldActive = () => false;
  e.log = () => {};
  e.debugLog = () => {};
  e._trigger = () => {};
  e._timeline = () => {};
  e.safetyWarning = async () => {};
  e.markers = {
    dangerState: async () => ({ known: true, inside: true, distance: 500, radius: 900 }),
    rawDangerState: async () => ({ known: true, inside: true, distance: 500, radius: 900 }),
    lineState: async () => ({ known: true, onSegment: true, side: -1, rawSide: -1, distance: -400, stable: true, direction: { known: true, garageSide: -1, lawnSide: 1 } }),
  };
  return e;
}

test('v202 closed gate + mower in danger area during return never opens gate and reroutes to maintenance', async () => {
  const e = engineBase();
  let detours = 0;
  let opens = 0;
  e._routeClosedGateReturnViaMaintenance = async (reason) => {
    detours += 1;
    assert.equal(reason, 'closed_gate_return_danger');
    return true;
  };
  e.ensureDoorOpen = async () => { opens += 1; return true; };
  await e.updatePositionGuards();
  assert.equal(detours, 1, 'danger-area return at a closed gate must be diverted to maintenance');
  assert.equal(opens, 0, 'gate must not move while mower occupies the danger area');
});

test('v202 maintenance return opens gate only after verified stationary clearance, then releases dock only after open proof', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/garage/GarageSafetyEngine.js'), 'utf8');
  const start = src.indexOf('async _continueReturnFromMaintenance(');
  const end = src.indexOf('\n  async returnRequested(', start);
  assert.ok(start >= 0 && end > start);
  const block = src.slice(start, end);
  const verify = block.indexOf('_ensureVerifiedMaintenanceReturnClearance(token)');
  const open = block.indexOf("ensureDoorOpen('return_from_maintenance'");
  const release = block.indexOf('_maintenanceReleaseAfterOpening(');
  const dock = block.indexOf('accepted = await dockFn()');
  assert.ok(verify >= 0 && open > verify, 'maintenance clearance must be verified before gate opening');
  assert.match(block, /async _ensureVerifiedMaintenanceReturnClearance\(token\)[\s\S]*?_verifiedMaintenanceReturnClearance\(\)[\s\S]*?_establishMaintenanceReturnReleaseFromCurrentPosition\(token\)/,
    'a native arrival signal must be followed by independent stationary-position proof');
  assert.ok(release > open, 'door-open/stability proof must be checked after opening');
  assert.ok(dock > release, 'dock command must be released only after door-open proof');
  assert.match(block, /allowOpenFromDanger:\s*false/, 'maintenance return must not open gate while danger occupancy remains');
});
