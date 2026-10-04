'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const previousLoad = Module._load;
let Device;
try {
  Module._load = function(id, parent, main) {
    if (id === 'homey') return { Device: class {} };
    if (id === 'mqtt') return {};
    return previousLoad.call(this, id, parent, main);
  };
  Device = require('../drivers/mower/device');
} finally {
  Module._load = previousLoad;
}

const src = fs.readFileSync(path.join(__dirname, '..', 'drivers/mower/device.js'), 'utf8');

function methodBody(name, nextName) {
  const start = src.indexOf(`  ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = nextName ? src.indexOf(`  ${nextName}`, start + 2) : -1;
  return src.slice(start, end > start ? end : undefined);
}

test('v1.2.13 all robust-resume callers leave physical mowing status to telemetry', () => {
  // A regression in 1.2.12 removed the synthetic write from the helper but left
  // two caller-side writes behind. No robust-resume call may be immediately
  // followed by an _applyStatus("mowing") fabrication.
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('_resumeMowingRobust(')) continue;
    const window = lines.slice(i, i + 5).join('\n');
    assert.doesNotMatch(window, /_applyStatus\(['"]mowing['"]/, `synthetic mowing after resume near line ${i + 1}`);
  }
});

test('v1.2.13 Flow Pause/Resume uses paused-like resolver so recoverable code 27 resumes', async () => {
  const d = Object.create(Device.prototype);
  let resumed = 0;
  let paused = 0;
  let applied = 0;
  d.log = () => {};
  d._isPausedLike = () => true; // includes the code-27 recoverable state
  d._resumeMowingRobust = async label => { assert.equal(label, 'flow_resume'); resumed++; return true; };
  d._safeWrite = async () => { paused++; return true; };
  d._applyStatus = async () => { applied++; };
  d._garageSafety = { enabled: () => true, noteUserPauseRequested: () => {} };
  d._api = { pause: async () => true };
  d.getData = () => ({ id: 'mower' });

  await d.cmdPause();
  assert.equal(resumed, 1);
  assert.equal(paused, 0);
  assert.equal(applied, 0);
  assert.equal(d._pauseButtonHoldMode, 'pause');
});

test('v1.2.13 Flow Pause records the same explicit-pause intent used by code-27 recovery', async () => {
  const d = Object.create(Device.prototype);
  let pauseNoted = 0;
  let pauseWrites = 0;
  let applied = null;
  d.log = () => {};
  d._isPausedLike = () => false;
  d._resumeSemanticUntil = Date.now() + 999999;
  d._garageSafety = { enabled: () => true, noteUserPauseRequested: () => { pauseNoted++; } };
  d._api = { pause: async () => true };
  d.getData = () => ({ id: 'mower' });
  d._safeWrite = async (label, fn) => { assert.equal(label, 'flow_pause'); pauseWrites++; return fn(); };
  d._applyStatus = async (...args) => { applied = args; };

  const before = Date.now();
  await d.cmdPause();
  assert.equal(pauseWrites, 1);
  assert.equal(pauseNoted, 1);
  assert.ok(d._lastUserPauseAt >= before);
  assert.equal(d._resumeSemanticUntil, 0);
  assert.equal(d._pauseButtonHoldMode, 'resume');
  assert.deepEqual(applied, ['paused', 0, false]);
});

test('v1.2.13 outdoor resume classifier uses public return-cycle ownership boundary', () => {
  const body = methodBody('async _isOutsideGarageMissionResume(', 'async _applyStatus(');
  assert.match(body, /isReturnCycleActive\?\.\(\)/);
  assert.doesNotMatch(body, /_manualMaintenanceTransit/);
  assert.doesNotMatch(body, /_returnContext/);
});
