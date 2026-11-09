'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const action = require('../.homeycompose/flow/actions/go_to_maintenance_point.json');
const field = action.args.find(arg => arg.name === 'maintenance_point');
assert.equal(field.required, false);
assert.deepEqual(field.values.map(v => v.id), ['1','2','3','4','5']);
const source = fs.readFileSync(path.join(root,'drivers/mower/device.js'),'utf8');
const start = source.indexOf('  async cmdGoToMaintenancePoint(requestedPoint = null) {');
const end = source.indexOf('\n  async cmdSetEfficiencyMode(', start);
assert(start !== -1 && end > start);
const method = source.slice(start,end);
const cmd = vm.runInNewContext('({' + method.trim() + '}).cmdGoToMaintenancePoint');
const events = [];
function fake(garage) {
  return {
    log: () => {}, homey: { __: (key) => key },
    _goToMaintenancePointGuarded: async (label, point) => { events.push(['native',label,point]); },
    _garageSafety: { enabled: () => garage, maintenanceRequested: async (label, handler) => { events.push(['garage',label]); await handler(); } },
  };
}
(async () => {
  await cmd.call(fake(false));
  await cmd.call(fake(false),'3');
  await cmd.call(fake(true),'1');
  await cmd.call(fake(true));
  assert.deepEqual(events,[
    ['native','flow_maintenance',1], ['native','flow_maintenance',3],
    ['garage','flow_maintenance'], ['native','flow_maintenance',undefined],
    ['garage','flow_maintenance'], ['native','flow_maintenance',undefined],
  ]);
  // Garage Mode never silently substitutes P1 for an explicitly chosen other point.
  await assert.rejects(cmd.call(fake(true),'5'), /maintenance_point_garage_p1/);
  await assert.rejects(cmd.call(fake(false),'6'), /maintenance_point_invalid/);
  await assert.rejects(cmd.call(fake(false),'invalid'), /maintenance_point_invalid/);
  console.log('PASS: optional argument, P1–P5, garage P1-only, invalid IDs');
})().catch(err => { console.error(err); process.exitCode = 1; });
