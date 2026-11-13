'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { checkMaintenancePoint } = require('../lib/garage/MaintenancePointPreflight');
const text = fs.readFileSync(require('node:path').join(__dirname, '../drivers/mower/device.js'), 'utf8');
const start = text.indexOf('  async cmdGoToMaintenancePoint(requestedPoint = null) {');
const end = text.indexOf('\n  async cmdSetEfficiencyMode(', start);
assert(start >= 0 && end > start);
const method = vm.runInNewContext('({' + text.slice(start, end) + '}).cmdGoToMaintenancePoint', { checkMaintenancePoint, ADDITIONAL_POINT_STORE: 'native_additional_maintenance_points_v1' });
const calls = [];
const d = {
  homey: { __: (key) => key },
  log: () => {}, _activeMapIndex: 0,
  getData: () => ({ id: 'A2' }),
  getSetting: key => key === 'garage_mode_enabled',
  getStoreValue: async () => null,
  _api: { getMAPI: async () => ({ maintenancePoints: [{ index: 3, x: 10, y: 20 }] }) },
  _garageSafety: { enabled: () => false },
  _goToMaintenancePointGuarded: async () => { calls.push('OPCODE109'); return true; },
};
(async () => {
  await assert.rejects(method.call(d, 3), /pausiert|paused/);
  assert.deepEqual(calls, []);
  console.log('PASS: Garage Mode paused cannot bypass gate on confirmed P3');
})().catch(e => { console.error(e); process.exitCode = 1; });
