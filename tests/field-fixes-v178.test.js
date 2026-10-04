'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GarageSafetyEngine = require('../lib/garage/GarageSafetyEngine');
const { HomeyCamera } = require('../lib/video/HomeyCamera');

function statusEngine(elapsedMs, stableMowingConfirmed = false) {
  const e = Object.create(GarageSafetyEngine.prototype);
  e.enabled = () => true;
  e.doorState = () => 'open';
  e.isDockedHomeStatus = () => false;
  e.isReturnCycleActive = () => false;
  e._safeReturnInProgress = false;
  e._returnGuardActive = false;
  e._returnContext = 'IDLE';
  e._manualMaintenanceReached = false;
  e._manualMaintenanceTransit = false;
  e._startConfirmationFailed = false;
  e._startConfirmationPending = false;
  e._missionOutside = true;
  e._homeState = 'adjusting';
  e._externalStartIntentHandling = false;
  e._lineToLawnConfirmed = false;
  e._resumeGuardUntil = 0;
  e._outbound = {
    action: 'button_start_mowing', requiresMowingStable: true, released: true,
    originalCommandSentAt: Date.now() - elapsedMs,
    adjustingSince: Date.now() - elapsedMs,
    stableMowingConfirmed,
    departureLineConfirmed: false,
  };
  return e;
}

test('departure display does not jump to mowing on one native mowing status', () => {
  assert.equal(statusEngine(10000, false).getTileStatus('mowing'), 'garage_adjusting');
  assert.equal(statusEngine(50000, false).getTileStatus('mowing'), 'garage_positioning');
  assert.equal(statusEngine(90000, false).getTileStatus('mowing'), 'garage_positioning');
});

test('after fixed Ausfahrt, strong line crossing or four-hit mowing proof may end Justieren', () => {
  const earlyMowing = statusEngine(10000, true);
  earlyMowing._outbound.stableMowingConfirmedAt = Date.now();
  assert.equal(earlyMowing.getTileStatus('mowing'), 'mowing');

  const earlyLine = statusEngine(10000, false);
  earlyLine._outbound.departureLineConfirmed = true;
  earlyLine._outbound.departureLineConfirmedAt = Date.now();
  assert.equal(earlyLine.getTileStatus('mowing'), 'mowing');

  const stillExiting = statusEngine(4000, true);
  stillExiting._outbound.departureLineConfirmed = true;
  assert.equal(stillExiting.getTileStatus('mowing'), 'garage_exiting');
});

test('without line or four-hit mowing proof, timer falls through Justieren to Positionieren', () => {
  const lineMissing = statusEngine(60000, false);
  assert.equal(lineMissing.getTileStatus('mowing'), 'garage_positioning');
  const confirmed = statusEngine(60000, true);
  confirmed._outbound.stableMowingConfirmedAt = Date.now() - 1000;
  assert.equal(confirmed.getTileStatus('mowing'), 'mowing');
});

test('camera accepts fresh internal outdoor position after the short binary departure window expires', () => {
  const now = Date.now();
  const device = {
    _mowerBinaryDiagAt: now - 60000,
    _mowerBinaryDiag: { dockingState: 'OUT_OF_STATION' },
    _nativeMowerStatus: 'mowing',
    _dockPos: { x: 0, y: 0 },
    getCapabilityValue: () => 'mowing',
    _garageSafety: {
      pos: () => ({ x: 3200, y: 0, ts: now - 1000 }),
      isMissionOutside: () => true,
      _homeState: 'away',
      _lineToLawnConfirmed: false,
      _outbound: null,
    },
  };
  const cam = new HomeyCamera(device, {});
  assert.ok(cam.outsideEvidence());
});

test('overview map cannot trap parent dashboard scrolling and map polling is visibility-aware', () => {
  const css = fs.readFileSync(path.join(__dirname, '../widgets/overview/public/style.css'), 'utf8');
  const map = fs.readFileSync(path.join(__dirname, '../widgets/map/public/index.html'), 'utf8');
  assert.doesNotMatch(css, /iframe\{/);
  assert.match(css, /\.map-static\{[^}]*pointer-events:none/);
  assert.match(css, /html,body\{[^}]*overflow:hidden[^}]*touch-action:auto/);
  assert.match(map, /document\.visibilityState !== 'hidden'/);
  assert.match(map, /mapPollDelay\(\)/);
  assert.match(map, /_mapMoving \? 1800 : 8000/);
});

test('mowing pattern assigns stable shading by lane position, not instantaneous travel direction', () => {
  const html = fs.readFileSync(path.join(__dirname, '../widgets/map/public/index.html'), 'utf8');
  assert.match(html, /laneIndex = Math\.round/);
  assert.match(html, /laneIndex=Math\.round|laneIndex = Math\.round/);
  assert.match(html, /crossOf/);
  assert.doesNotMatch(html, /if \(projection >= 0\) light \+= cmd;/);
});
