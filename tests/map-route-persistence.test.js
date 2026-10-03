'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSessionTransientStatus,
  isRouteSessionActive,
  isChargeBreakContinuation,
  compactRouteTrail,
} = require('../lib/map/RouteSessionPolicy');

test('pause/error/return/adjustment remain part of the same mowing session', () => {
  for (const status of ['mowing','edge_mowing','leaving','returning','paused','error','adjusting','positioning']) {
    assert.equal(isSessionTransientStatus(status), true, status);
  }
  for (const status of ['idle','standby','docked','charging']) {
    assert.equal(isSessionTransientStatus(status), false, status);
  }
});

test('route stays active during error and paused states instead of falling back to a shorter cached path', () => {
  for (const status of ['mowing','returning','paused','error','remote_control','adjusting','positioning']) {
    assert.equal(isRouteSessionActive(status), true, status);
  }
  assert.equal(isRouteSessionActive('docked'), false);
});

test('automatic charge break continuation is bounded', () => {
  const now = 1_000_000;
  assert.equal(isChargeBreakContinuation(now + 1, now), true);
  assert.equal(isChargeBreakContinuation(now, now), false);
  assert.equal(isChargeBreakContinuation(now - 1, now), false);
  assert.equal(isChargeBreakContinuation(null, now), false);
});

test('long live-route compaction retains the whole mowing time span instead of tail slicing', () => {
  const route = [];
  for (let i = 0; i < 2000; i++) route.push([i * 100, i % 2 ? 100 : 0]);
  const compacted = compactRouteTrail(route, 1600);
  assert.ok(compacted.length < route.length);
  assert.deepEqual(compacted[0], route[0], 'start of mowing job remains visible');
  assert.deepEqual(compacted.at(-1), route.at(-1), 'latest point remains visible');
  assert.ok(compacted.some(pt => pt[0] > 90000 && pt[0] < 110000), 'middle of long job remains represented');
});

test('route compaction preserves pen-up boundaries without creating duplicate sentinels', () => {
  const route = [];
  for (let i = 0; i < 900; i++) route.push([i * 100, 0]);
  route.push([32767,-32768],[32767,-32768]);
  for (let i = 0; i < 900; i++) route.push([100000 + i * 100, 1000]);
  route.push([32767,-32768]); // trailing pen-up must not make us lose the final real point
  const compacted = compactRouteTrail(route, 1600);
  const sentinels = compacted.filter(pt => pt[0] === 32767);
  assert.equal(sentinels.length, 1);
  assert.deepEqual(compacted[0], [0,0]);
  assert.deepEqual(compacted.at(-1), [189900,1000]);
});
