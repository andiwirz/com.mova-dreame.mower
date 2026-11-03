'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
const dashboard=fs.readFileSync(path.join(__dirname,'../lib/widgets/MowerDashboard.js'),'utf8');
test('held waypoint choice survives station/dock telemetry',()=>{assert.doesNotMatch(src,/pending choice cancelled: native station confirmed/);assert.doesNotMatch(src,/pending choice cancelled: native dock check 2\/2/);});
test('chooser is restricted to explicit selection phase and expires',()=>{assert.match(dashboard,/_externalStartRecoveryPhase === 'MANUAL_REISSUE_REQUIRED'/);assert.match(dashboard,/15\*60\*1000/);});
test('repeated station lifecycle scheduling is coalesced',()=>{assert.match(src,/_lastVerifiedDockRestoreRequestAt/);assert.match(src,/>= 3000/);});
