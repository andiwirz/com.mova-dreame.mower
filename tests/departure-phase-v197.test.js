'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Engine = require('../lib/garage/GarageSafetyEngine');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

function displayEngine(now, elapsedMs, opts = {}) {
  const e = Object.create(Engine.prototype);
  e.enabled = () => true;
  e.doorState = () => 'open';
  e.isDockedHomeStatus = () => false;
  e._safeReturnInProgress = false;
  e._returnGuardActive = false;
  e._returnContext = 'IDLE';
  e._manualMaintenanceReached = false;
  e._manualMaintenanceTransit = false;
  e._startConfirmationFailed = false;
  e._startConfirmationPending = false;
  e._missionOutside = true;
  e._homeState = opts.homeState || 'away';
  e._externalStartIntentHandling = false;
  e._lineToLawnConfirmed = false;
  e._resumeGuardUntil = 0;
  e._outbound = {
    action: 'button_start_mowing',
    requiresMowingStable: true,
    released: true,
    originalCommandSentAt: now - elapsedMs,
    adjustingSince: now - elapsedMs + 5000,
    departureLineConfirmed: !!opts.line,
    departureLineConfirmedAt: opts.line ? now : 0,
    stableMowingConfirmed: !!opts.stable,
    stableMowingConfirmedAt: opts.stable ? (opts.confirmedAt || now) : 0,
  };
  return e;
}

test('v197 Ausfahrt stays fixed, then physical line crossing may end Justieren', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let e = displayEngine(Date.now(), 4000, { line: true });
  assert.equal(e._outboundDeparturePhase(), 'exiting');
  assert.equal(e.getTileStatus('mowing'), 'garage_exiting');

  e = displayEngine(Date.now(), 10000, { line: true });
  assert.equal(e._outboundDeparturePhase(), 'mowing');
  assert.equal(e.getTileStatus('mowing'), 'mowing');

  e = displayEngine(Date.now(), 49999, {});
  assert.equal(e._outboundDeparturePhase(), 'adjusting');
  assert.equal(e.getTileStatus('mowing'), 'garage_adjusting');

  e = displayEngine(Date.now(), 50000, {});
  assert.equal(e._outboundDeparturePhase(), 'positioning');
  assert.equal(e.getTileStatus('mowing'), 'garage_positioning');
});

test('v198 four consecutive filtered MOWING samples may end Justieren after Ausfahrt', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const e = Object.create(Engine.prototype);
  e._outbound = {
    requiresMowingStable: true,
    released: true,
    originalCommandSentAt: 98000, // only 2 s into fixed Ausfahrt
    mowingSince: null,
    mowingStatusHits: 0,
    mowingStatusLastAt: 0,
    stableMowingConfirmed: false,
    stableMowingConfirmedAt: 0,
  };
  e._manualMaintenanceCommandAcceptedAt = 0;
  e._missionOutside = false;
  e._manualMaintenanceTransit = false;
  e.log = () => {};
  e.refreshTileStatus = async () => {};
  e._setHomeState = async () => {};

  assert.equal(await e.observeNativeStatusSample('mowing'), false);
  assert.equal(e._outbound.mowingStatusHits, 0);

  t.mock.timers.tick(3100); // fixed 5 s Ausfahrt has elapsed
  assert.equal(await e.observeNativeStatusSample('mowing'), false);
  assert.equal(e._outbound.mowingStatusHits, 1);
  t.mock.timers.tick(800);
  assert.equal(await e.observeNativeStatusSample('mowing'), false);
  assert.equal(e._outbound.mowingStatusHits, 2);
  t.mock.timers.tick(800);
  assert.equal(await e.observeNativeStatusSample('mowing'), false);
  assert.equal(e._outbound.mowingStatusHits, 3);
  t.mock.timers.tick(800);
  assert.equal(await e.observeNativeStatusSample('mowing'), true);
  assert.equal(e._outbound.mowingStatusHits, 4);
  assert.equal(e._outbound.stableMowingConfirmed, true);
  assert.equal(e._outboundDeparturePhase(), 'mowing');
});

test('v198 any effective non-mowing sample breaks the four-hit proof', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 200000 });
  const e = Object.create(Engine.prototype);
  e._outbound = {
    released: true,
    originalCommandSentAt: 190000,
    mowingSince: null,
    mowingStatusHits: 0,
    mowingStatusLastAt: 0,
    stableMowingConfirmed: false,
    stableMowingConfirmedAt: 0,
  };
  e._manualMaintenanceCommandAcceptedAt = 0;
  e._missionOutside = false;
  e._manualMaintenanceTransit = false;
  e.log = () => {};
  e.refreshTileStatus = async () => {};
  e._setHomeState = async () => {};

  await e.observeNativeStatusSample('mowing');
  t.mock.timers.tick(800);
  await e.observeNativeStatusSample('mowing');
  assert.equal(e._outbound.mowingStatusHits, 2);
  await e.observeNativeStatusSample('adjusting');
  assert.equal(e._outbound.mowingStatusHits, 0);
  t.mock.timers.tick(800);
  await e.observeNativeStatusSample('mowing');
  assert.equal(e._outbound.mowingStatusHits, 1);
  assert.equal(e._outbound.stableMowingConfirmed, false);
});

test('v197 Positionieren has no timeout escape for gate closing', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 300000 });
  const pending = displayEngine(Date.now(), 0, {});
  pending._outbound.released = false;
  pending._outbound.originalCommandSentAt = null;
  assert.equal(pending._outboundPhaseProtected(), true);

  const e = displayEngine(Date.now(), 150000, {});
  assert.equal(e._outboundDeparturePhase(), 'positioning');
  assert.equal(e._outboundPhaseProtected(), true);

  e._outbound.stableMowingConfirmed = true;
  e._outbound.stableMowingConfirmedAt = Date.now();
  assert.equal(e._outboundDeparturePhase(), 'mowing');
  assert.equal(e._outboundPhaseProtected(), false);
});

test('v197 physical Safety-Line crossing marks departure evidence without fabricating native mowing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 400000 });
  const e = Object.create(Engine.prototype);
  e._outbound = {
    lineCrossAttempts: 0,
    lawnSideSince: 0,
    lawnSideStableHits: 0,
    stableMowingConfirmed: false,
    stableMowingConfirmedAt: 0,
    departureLineConfirmed: false,
    departureLineConfirmedAt: 0,
    released: true,
    originalCommandSentAt: Date.now() - 10000,
  };
  e._lineToLawnConfirmed = false;
  e._outboundFallbackMowingAllowed = false;
  e._manualMaintenanceTransit = false;
  e._setLineState = () => {};
  e.refreshTileStatus = async () => {};
  e.pos = () => ({ x: 1, y: 2, ts: Date.now() });
  e._trigger = () => {};
  e.log = () => {};
  const ok = await e._confirmOutboundExitFromSafetyLine('test', { distance: 900, t: 0.5, source: 'test' });
  assert.equal(ok, true);
  assert.equal(e._outbound.departureLineConfirmed, true);
  assert.equal(e._outbound.stableMowingConfirmed, false);
  assert.equal(e._outboundDeparturePhase(), 'mowing');
});

test('v198 maintenance departure uses the same line-or-four-mowing proof after fixed Ausfahrt', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 500000 });
  const e = Object.create(Engine.prototype);
  e._manualMaintenanceTransit = true;
  e._manualMaintenanceReached = false;
  e._manualMaintenanceCommandAcceptedAt = 494000; // 6 s ago
  e._manualMaintenancePhase = 'adjusting';
  e._manualMaintenancePhaseStartedAt = 499000;
  e._manualMaintenanceLastPos = null;
  e._manualMaintenanceStableSince = 0;
  e._maintenanceStableHits = 0;
  e._outbound = { departureLineConfirmed: false, stableMowingConfirmed: false };
  e.device = { _nativeMaintenanceCommandAt: 0 };
  e.pos = () => ({ x: 1000, y: 1000, ts: Date.now() });
  e._clearManualMaintenanceStatusTimers = () => {};
  e.refreshTileStatus = async () => {};
  e.log = () => {};

  await e._updateManualMaintenanceJourneyPhase();
  assert.equal(e._manualMaintenancePhase, 'adjusting');

  e._outbound.departureLineConfirmed = true;
  await e._updateManualMaintenanceJourneyPhase();
  assert.equal(e._manualMaintenancePhase, 'transit');

  // Without proof, the same journey progresses to Positionieren after 50 s.
  const p = Object.create(Engine.prototype);
  Object.assign(p, {
    _manualMaintenanceTransit: true,
    _manualMaintenanceReached: false,
    _manualMaintenanceCommandAcceptedAt: 440000,
    _manualMaintenancePhase: 'adjusting',
    _outbound: { departureLineConfirmed: false, stableMowingConfirmed: false },
    device: { _nativeMaintenanceCommandAt: 0 },
    pos: () => ({ x: 1000, y: 1000, ts: Date.now() }),
    refreshTileStatus: async () => {},
  });
  await p._updateManualMaintenanceJourneyPhase();
  assert.equal(p._manualMaintenancePhase, 'positioning');
});

test('v198 source keeps all close entry points protected until departure proof', () => {
  const src = read('lib/garage/GarageSafetyEngine.js');
  assert.match(src, /Positionieren has no timeout escape/);
  assert.match(src, /if \(this\._outboundPhaseProtected\(\)\) return false;\n    if \(this\.isReturning\(\)\) return false;/);
  assert.match(src, /if \(this\._outboundPhaseProtected\(\)\) return false;\n    if \(this\.status\(\) !== 'mowing'\) return false;/);
  assert.match(src, /close waits after safety line: Ausfahrt\/Justieren\/Positionieren still protected/);
  assert.match(src, /departureLineConfirmed/);
  assert.match(src, /OUTBOUND_NATIVE_MOWING_CONFIRM_HITS = 4/);
});

test('v198 restored home-state fallback obeys the same line-or-four-hit departure proof', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 600000 });
  const base = displayEngine(Date.now(), 10000, { homeState: 'adjusting' });
  // Force getTileStatus through its restored/incomplete-runtime fallback instead
  // of the normal requiresMowingStable phase shortcut.
  base._outbound.requiresMowingStable = false;
  base._outbound.departureLineConfirmed = true;
  assert.equal(base.getTileStatus('adjusting'), 'mowing');

  base._outbound.departureLineConfirmed = false;
  base._outbound.stableMowingConfirmed = true;
  assert.equal(base.getTileStatus('adjusting'), 'mowing');

  base._outbound.stableMowingConfirmed = false;
  assert.equal(base.getTileStatus('adjusting'), 'garage_adjusting');

  base._outbound.originalCommandSentAt = Date.now() - 60000;
  assert.equal(base.getTileStatus('adjusting'), 'garage_positioning');
});
