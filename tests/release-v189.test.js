'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('v189 limits reusable maintenance arrival proof to 60 seconds', () => {
  const src = read('lib/garage/GarageSafetyEngine.js');
  assert.match(src, /RETURN_MAINTENANCE_RELEASE_PROOF_MAX_MS\s*=\s*60000/);
  assert.match(src, /RETURN_MAINTENANCE_ARRIVAL_REUSE_MAX_MS\s*=\s*60000/);
  assert.doesNotMatch(src, /proofAge\s*>\s*120000/);
});

test('v189 safety-line pause failure enters bounded STOP recovery and recreates return', () => {
  const src = read('lib/garage/GarageSafetyEngine.js');
  assert.match(src, /return_safety_line_(?:native_pause_unconfirmed|pause_confirmation_pending)/);
  assert.match(src, /_recoverReturnSafetyLineStop/);
  assert.match(src, /garage_return_line_recovery_stop/);
  assert.match(src, /STOP sent after missing pause acknowledgement/);
  assert.match(src, /await dockFn\(\)/);
  assert.match(src, /return_safety_line_released/);
});

test('v189 can prove physical standstill from fresh bounded position samples', () => {
  const src = read('lib/garage/GarageSafetyEngine.js');
  assert.match(src, /RETURN_STOP_POSITION_DRIFT_MM\s*=\s*220/);
  assert.match(src, /RETURN_STOP_POSITION_REQUIRED_MS\s*=\s*1500/);
  assert.match(src, /baselineAge/);
  assert.match(src, /stationary_position/);
});

test('v189 maintenance return accepts a bounded physical stop proof when native PAUSED lags', () => {
  const src = read('lib/garage/GarageSafetyEngine.js');
  assert.match(src, /_returnMaintenanceStopProof/);
  assert.match(src, /maintenanceStopProofFresh/);
  assert.match(src, /garage_verified_maintenance_return_pause/);
  assert.match(src, /garage_current_maintenance_pause/);
});

test('v189 optional notice Flow covers departure, return and door movement while Timeline stays independent', () => {
  const src = read('lib/garage/GarageSafetyEngine.js');
  const card = JSON.parse(read('.homeycompose/flow/triggers/garage_mower_notice.json'));
  assert.equal(card.title.de, 'Mäher-/Garagen-Hinweis');
  assert.match(src, /_missionNotification\('return'\)/);
  assert.match(src, /door_opening/);
  assert.match(src, /door_closing/);
  assert.match(src, /this\.log\('request open'/);
  assert.match(src, /first === 'door state'/);
  assert.match(src, /createNotification\(\{ excerpt: text \}\)/);
});

test('v189 repair editor hides stale Edit button and cleans persistent host listeners', () => {
  const html = read('drivers/mower/repair/map_editor.html');
  assert.match(html, /classList\.toggle\('hidden', _editMode \|\|/);
  assert.match(html, /window\.__movaRepairMapCleanup/);
  assert.match(html, /removeEventListener\('pointermove'/);
  assert.match(html, /setEditUi\(false\)/);
  assert.match(html, /if \(_editMode\) \{\s*scheduleMap\(1000\)/);
});
