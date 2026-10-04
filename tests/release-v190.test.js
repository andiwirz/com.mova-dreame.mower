'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('v198 expected safety-line wait stays operational-hold only when stop proof fails', () => {
  const src = read('lib/garage/GarageSafetyEngine.js');
  const start = src.indexOf('async _waitAtSafetyLineUntilDoorOpenThenDock');
  const end = src.indexOf('async _prepareMowerForReturnPath', start);
  const fn = src.slice(start, end);
  assert.match(fn, /return_safety_line_pause_confirmation_pending/);
  assert.match(fn, /return_safety_line_pause_failed_recovery/);
  assert.match(fn, /_recoverReturnSafetyLineStop/);
  assert.match(fn, /returnOperationalHold\('return_safety_line_stop_unconfirmed'\)/);
  assert.doesNotMatch(fn, /safetyBlock\('return_safety_line_native_pause_unconfirmed'\)/);
  assert.doesNotMatch(fn, /safetyBlock\('return_safety_line_pause_failed'\)/);
  assert.match(fn, /ensureDoorOpen\('return_safety_line_wait'/);
  assert.match(fn, /await dockFn\(\)/);
});

test('v190 return takeover preserves a verified maintenance arrival before route selection', () => {
  const src = read('lib/garage/GarageSafetyEngine.js');
  const start = src.indexOf('async returnRequested');
  const end = src.indexOf('async testExit', start);
  const fn = src.slice(start, end);
  assert.match(fn, /preserveVerifiedMaintenanceArrival/);
  assert.match(fn, /verified maintenance arrival preserved for return takeover/);
  assert.match(fn, /_reuseVerifiedMaintenanceArrivalForReturn/);
  assert.ok(fn.indexOf('preserveVerifiedMaintenanceArrival') < fn.indexOf('_reuseVerifiedMaintenanceArrivalForReturn'));
});

test('v190 keeps the physical undock interception milestone intact', () => {
  const device = read('drivers/mower/device.js');
  const garage = read('lib/garage/GarageSafetyEngine.js');
  assert.match(device, /nativeUndockStarted/);
  assert.match(device, /mqtt_native_undock_1_1/);
  assert.match(garage, /_stopExternalStartOldTaskEarly/);
  assert.match(garage, /_recoverExternalStartViaNativeStation/);
  assert.match(garage, /garage_external_recovery_fresh_start/);
});
