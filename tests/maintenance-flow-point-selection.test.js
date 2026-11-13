'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { checkMaintenancePoint, nativeMaintenanceIndexes } = require('../lib/garage/MaintenancePointPreflight');
const root = path.join(__dirname, '..');
const action = require('../.homeycompose/flow/actions/go_to_maintenance_point.json');
const field = action.args.find(arg => arg.name === 'maintenance_point');
assert.equal(field.required, false);
assert.deepEqual(field.values.map(v => v.id), ['1','2','3','4','5']);

const source = fs.readFileSync(path.join(root,'drivers/mower/device.js'), 'utf8');
const start = source.indexOf('  async cmdGoToMaintenancePoint(requestedPoint = null) {');
const end = source.indexOf('\n  async cmdSetEfficiencyMode(', start);
assert(start !== -1 && end > start);
const cmd = vm.runInNewContext('({' + source.slice(start, end).trim() + '}).cmdGoToMaintenancePoint',
  { checkMaintenancePoint });

const currentMap = {
  d: { maintenancePoints: [
    { index: 1, x: 100, y: 200 },
    { index: 2, x: 300, y: 400 },
  ] },
};
const events = [];
function fake(garage, mapi = currentMap) {
  return {
    log: () => {},
    error: () => {},
    homey: {
      __: (key, vars) => `${key}:${vars?.point || ''}`,
      notifications: { createNotification: async () => { throw Error('direct push forbidden'); } },
    },
    _emitMowerNotice: (kind, text, reason) => events.push(['notice', text, kind, reason]),
    _activeMapIndex: 3,
    getData: () => ({ id: 'A2' }),
    _api: { getMAPI: async (did, mapIndex) => {
      events.push(['mapi', did, mapIndex]);
      return mapi;
    } },
    _goToMaintenancePointGuarded: async (label, point) => {
      events.push(['native', label, point]); return true;
    },
    _garageSafety: {
      enabled: () => garage,
      maintenanceRequested: async (label, handler) => {
        events.push(['garage', label]); await handler();
      },
      additionalMaintenanceRequested: async (label, point, handler) => {
        events.push(['garage_additional', label, point]); return handler();
      },
    },
  };
}
(async () => {
  assert.deepEqual(nativeMaintenanceIndexes(currentMap).indexes, [1,2]);
  assert.deepEqual(nativeMaintenanceIndexes({ d: {maintenancePoints:[{x:3,y:4}]} }).indexes, []);
  assert.deepEqual(nativeMaintenanceIndexes({d:{maintenancePoint:[1,2]}}).indexes, []);
  await cmd.call(fake(false)); // historical P1 default
  await cmd.call(fake(false), '2'); // present on native map
  await cmd.call(fake(true), '1');
  await cmd.call(fake(true));
  const prior = events.length;
  await assert.rejects(cmd.call(fake(true), '4'), /maintenance_point_preflight_not_configured/);
  await assert.rejects(cmd.call(fake(false), '4'), /maintenance_point_preflight_not_configured/);
  assert(events.slice(prior).every(([kind]) => kind !== 'native' && kind !== 'garage'));
  assert(events.slice(prior).some(([kind, text]) => kind === 'notice' && text.includes('P4')));
  assert.deepEqual(events.filter(([kind]) => kind === 'native'), [
    ['native','flow_maintenance',1],
    ['native','flow_maintenance',2],
    ['native','flow_maintenance',undefined],
    ['native','flow_maintenance',undefined],
  ]);
  // Unknown MAPI never sends an opcode 109, even if the vendor rejects empty map data.
  const priorUnknown = events.length;
  await assert.rejects(cmd.call(fake(true, { d: { maintenancePoint: [3, 4] }}), '3'),
    /maintenance_point_preflight_unverifiable/);
  assert(!events.slice(priorUnknown).some(([kind]) => kind === 'native'));
  // No MAPI connection -> fail closed; don't claim the point is absent.
  const offline = fake(true);
  offline._api.getMAPI = async () => { throw new Error('offline'); };
  await assert.rejects(cmd.call(offline, '2'), /maintenance_point_preflight_unverifiable/);
  // A truly verified native P2 is allowed with Garage Mode active, and must
  // keep the exact P2 index after the gate safety gate.
  const priorGarageP2 = events.length;
  await cmd.call(fake(true), '2');
  assert(events.slice(priorGarageP2).some(e => e[0] === 'garage_additional' && e[2] === 2));
  assert(events.slice(priorGarageP2).some(e => e[0] === 'native' && e[2] === 2));
  await assert.rejects(cmd.call(fake(false), '6'), /maintenance_point_invalid/);
  await assert.rejects(cmd.call(fake(false), 'invalid'), /maintenance_point_invalid/);
  // Vendor rejection of an actually confirmed point still fails the Flow visibly.
  const rejected = fake(false);
  rejected._goToMaintenancePointGuarded = async () => false;
  await assert.rejects(cmd.call(rejected, '2'), /maintenance_point_rejected/);
  console.log('PASS: both garage modes reject absent/unverifiable targets before motion; P2 preserved');
})().catch(err => { console.error(err); process.exitCode = 1; });
