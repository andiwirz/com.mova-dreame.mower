const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { forOverview } = require('../widgets/overview/public/garage-summary.js');

const safe = {
  garageEnabled: true, garagePaused: false, manualRecovery: false,
  status: 'garage_home', safety: 'ok', sensor: 'online',
  door: 'closed', sensorContact: 'closed', doorEstimated: false,
  recoveryNativeDock: 'IN_STATION', recoveryNativeUndock: 0,
  recoveryNativeAgeMs: 5000,
};

test('clean normal operation shows only separately verified native dock and sensor gate', () => {
  const result = forOverview(safe);
  assert.equal(result.state, 'active');
  assert.match(result.detailDe, /nativ angedockt/);
  assert.match(result.detailDe, /ZU \(Sensor\)/);
});

test('expired native evidence is never shown as confirmed', () => {
  const result = forOverview({ ...safe, recoveryNativeAgeMs: 31000 });
  assert.match(result.detailDe, /Zuhause \(Mäherstatus\)/);
  assert.doesNotMatch(result.detailDe, /nativ angedockt/);
});

test('missing native frame age is not misread as a fresh zero-millisecond proof', () => {
  for (const recoveryNativeAgeMs of [null, undefined, '']) {
    const result = forOverview({ ...safe, recoveryNativeAgeMs });
    assert.match(result.detailDe, /Zuhause \(Mäherstatus\)/);
  }
});

test('a timed/estimated gate end position does not count as physical sensor proof', () => {
  const result = forOverview({ ...safe, doorEstimated: true });
  assert.match(result.detailDe, /unbestätigt/);
});

test('an offline gate sensor is clearly distinguished from a closed contact', () => {
  const result = forOverview({ ...safe, sensor: 'offline' });
  assert.match(result.detailDe, /Sensor offline/);
  assert.doesNotMatch(result.detailDe, /ZU \(Sensor\)/);
});

test('a sensor contradiction does not produce a gate confirmation', () => {
  const result = forOverview({ ...safe, sensorContact: 'open' });
  assert.match(result.detailDe, /widersprechen/);
});

test('emergency has priority over manually selected automation and does not imply release', () => {
  const result = forOverview({ ...safe, manualRecovery: true, garagePaused: true });
  assert.equal(result.state, 'emergency');
  assert.match(result.titleDe, /Notfall/);
});

test('normal paused mode has a concise status with retained evidence', () => {
  const result = forOverview({ ...safe, garagePaused: true });
  assert.equal(result.state, 'paused');
  assert.match(result.titleDe, /pausiert/);
});

test('normal warning is not advertised as ready', () => {
  const result = forOverview({ ...safe, safety: 'warning' });
  assert.equal(result.state, 'attention');
  assert.match(result.titleDe, /prüfen/);
});

test('overview binds the read-only summary; safety and actuator source files remain separate', () => {
  const base = path.resolve(__dirname, '../widgets/overview/public');
  const html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(base, 'dashboard.js'), 'utf8');
  assert.match(html, /id="garageSummary"/);
  assert.match(html, /garage-summary\.js/);
  assert.match(js, /MovaGarageSummary\.forOverview\(r\)/);
  assert.match(js, /garageSummary\.dataset\.state/);
});
