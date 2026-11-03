'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
test('1.2.69: native PAUSED may satisfy maintenance preflight only with recent same-token checkpoint and twin positions',()=>{
  assert.match(code,/stoppedByCheckpoint = this\._returnZoneTaskStoppedToken === token/);
  assert.match(code,/this\._returnLineStopProof\.at\) < 20000/);
  assert.match(code,/freshPaused = String\(device\._observedMowerStatus/);
  assert.match(code,/this\._readNativeStationaryPositionForGarage\(token, baseline, 900\)/);
  assert.match(code,/if \(!finalIdle && !\(stoppedByCheckpoint && freshPaused/);
});
test('1.2.69: unknown vendor waypoint waits as warning, manual pick stays repeatable only on rejection',()=>{
  assert.match(code,/safetyWarning\('external_start_waiting_for_explicit_point'\)/);
  assert.doesNotMatch(code,/safetyBlock\('external_start_manual_reissue_required'\)/);
  assert.match(code,/if \(ok !== true\) \{[\s\S]*?this\._externalMaintenanceSelectionRequiredAt = at/);
  assert.match(code,/goToMaintenancePointGuarded\('external_operator_maintenance', point\)/);
  assert.match(code,/maintenance departure retry/);
  assert.match(code,/departureCandidateHits === 0/);
});
