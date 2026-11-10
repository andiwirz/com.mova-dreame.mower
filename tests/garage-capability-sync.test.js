'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'drivers/mower/device.js'), 'utf8');
const start = source.indexOf('  async _applyGarageCapabilityVisibility(');
const end = source.indexOf('\n  async _migrate()', start);
assert(start >= 0 && end > start, 'garage visibility method exists');
const method = source.slice(start, end);
const capMatch = source.match(/const GARAGE_DISPLAY_CAPS = (\[[\s\S]*?\]);/);
assert(capMatch, 'garage capability list exists');
const caps = vm.runInNewContext(capMatch[1]);
const Factory = vm.runInNewContext(`(function(CAPS) {
  return class Device {
    constructor() {
      this.capabilities = new Set();
      this.settings = false;
      this.errors = [];
      this._garageVisibilityQueue = Promise.resolve();
      this._garageVisibilityTarget = null;
      this._garageVisibilityRevision = 0;
      this._garageVisibilityRetry = null;
      this._garageVisibilityRetryCount = 0;
      this.homey = {
        setTimeout: (f) => setTimeout(f, 2),
        clearTimeout: (id) => clearTimeout(id),
      };
    }
    hasCapability(cap) { return this.capabilities.has(cap); }
    getSetting() { return this.settings; }
    async addCapability(cap) {
      await new Promise(resolve => setTimeout(resolve, 1));
      this.capabilities.add(cap);
    }
    async removeCapability(cap) {
      await new Promise(resolve => setTimeout(resolve, 1));
      this.capabilities.delete(cap);
    }
    error(...args) { this.errors.push(args.join(' ')); }
    ${method}
  };
})`, { setTimeout, clearTimeout, Promise })(caps);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const allPresent = d => caps.every(c => d.hasCapability(c));
const allAbsent = d => caps.every(c => !d.hasCapability(c));

(async () => {
  const d = new Factory();
  // onSettings can see an old setting: explicit newSettings must win.
  await d._applyGarageCapabilityVisibility(true);
  assert(allPresent(d), 'enable adds garage controls despite stale settings');
  await d._applyGarageCapabilityVisibility(false);
  assert(allAbsent(d), 'disable removes garage controls');

  const r = new Factory();
  await Promise.all([
    r._applyGarageCapabilityVisibility(false),
    r._applyGarageCapabilityVisibility(true),
  ]);
  assert(allPresent(r), 'last rapid toggle wins');

  const mid = new Factory();
  await mid._applyGarageCapabilityVisibility(true);
  const p1 = mid._applyGarageCapabilityVisibility(false);
  await sleep(3);
  const p2 = mid._applyGarageCapabilityVisibility(true);
  await Promise.all([p1, p2]);
  assert(allPresent(mid), 'toggle during async SDK mutation converges');

  const failing = new Factory();
  let shouldFail = true;
  const add = failing.addCapability.bind(failing);
  failing.addCapability = async cap => {
    if (shouldFail && cap === caps[0]) {
      shouldFail = false;
      throw new Error('temporary SDK error');
    }
    await add(cap);
  };
  await failing._applyGarageCapabilityVisibility(true);
  await sleep(100);
  await failing._garageVisibilityQueue;
  assert(allPresent(failing), 'temporary error is retried');
  console.log('PASS: garage capability sync (' + caps.length + ' capabilities)');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
