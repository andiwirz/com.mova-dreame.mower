'use strict';
// onSettings must expose the pending values through getSetting() while the
// change is applied (Homey persists them only afterwards), and must restore
// the saved values afterwards — also when applying the change fails.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'drivers/mower/device.js'), 'utf8');
const start = source.indexOf('  getSetting(key) {');
const end = source.indexOf('\n  async _applySettingsChange(', start);
assert(start !== -1 && end > start, 'getSetting/onSettings block not found');

const Device = vm.runInNewContext(`
  class Base { getSetting(key) { return this.saved[key]; } }
  class Device extends Base {
${source.slice(start, end)}
  }
  Device;
`);

(async () => {
  const seen = [];
  const dev = new Device();
  dev.saved = { garage_mode_enabled: false, garage_sensor_enabled: false };
  dev._applySettingsChange = async () => {
    seen.push(dev.getSetting('garage_mode_enabled'), dev.getSetting('garage_sensor_enabled'));
  };
  await dev.onSettings({ changedKeys: ['garage_mode_enabled'], newSettings: { garage_mode_enabled: true } });
  assert.deepEqual(seen, [true, false], 'pending value wins, untouched keys fall back to saved');
  assert.equal(dev.getSetting('garage_mode_enabled'), false, 'overlay removed after onSettings');

  dev._applySettingsChange = async () => { throw new Error('boom'); };
  await assert.rejects(dev.onSettings({ changedKeys: [], newSettings: { garage_mode_enabled: true } }), /boom/);
  assert.equal(dev.getSetting('garage_mode_enabled'), false, 'overlay removed after a failed onSettings');

  // Garage capabilities are shown/hidden before the garage engine prunes them.
  const body = source.slice(source.indexOf('  async _applySettingsChange('));
  const visibility = body.indexOf('_applyGarageCapabilityVisibility(');
  const engine = body.indexOf('_garageSafety.onSettings(');
  assert(visibility !== -1 && engine !== -1 && visibility < engine, 'visibility must run before the garage engine');

  console.log('PASS: settings overlay during onSettings, restore on success/failure, garage order');
})().catch((err) => { console.error(err); process.exitCode = 1; });
