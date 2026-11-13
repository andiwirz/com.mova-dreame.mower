'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Garage = require('../lib/garage/GarageSafetyEngine');
const source = fs.readFileSync(require.resolve('../lib/garage/GarageSafetyEngine'), 'utf8');

// Regression for 13 November: ordinary mowing may cross a monitoring line and
// enter the danger zone while the door is stationary. Neither is return intent.
assert.doesNotMatch(source, /inbound safety-line emergency PAUSE/);
assert.doesNotMatch(source, /_scheduleSuspectedPausedReturn|external_paused_safety_return/);
assert.doesNotMatch(source, /_detectClosedGateFrontReturn/);
assert.match(source, /if \(garageDoorMoving && inside\)/);
assert.match(source, /if \(this.isReturning\(\) \\|\\| this._safeReturnInProgress \\|\\| this._returnGuardActive\)/);
assert.match(source, /const safeReturnStatuses = \['returning', 'error'\]/);
assert.match(source, /_waitAtSafetyLineUntilDoorOpenThenDock/);
assert.match(source, /this._scheduleHomeClose\('native_docked_or_charging'\)/);
assert.equal(typeof Garage.prototype._pauseMowerForGateInterlock, 'function');
assert.equal(typeof Garage.prototype._scheduleSuspectedPausedReturn, 'undefined');
console.log('PASS V24: line crossing != return; stable gate is not an interlock; native return and moving gate remain protected');
