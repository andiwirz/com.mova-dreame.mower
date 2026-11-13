'use strict';
const assert = require('node:assert/strict');
const { CoreExternalStartRecovery } = require('../lib/garage/CoreExternalStartRecovery');
const Garage = require('../lib/garage/GarageSafetyEngine');

(async () => {
  let time = 100000;
  const calls = [];
  const e = Object.create(Garage.prototype);
  e.enabled = () => true;
  e.isDoorOpenStable = () => true;
  e.isReturning = () => false;
  e._safeReturnInProgress = false;
  e._outbound = null;
  e._homeCloseArmed = false;
  e._beginOutbound = async action => { calls.push(action); e._outbound = {action}; };
  e._markOutboundReleased = async () => { calls.push('released'); };
  e.log = () => {};
  const core = new CoreExternalStartRecovery({
    device: {}, garage: e, now: () => time, log: () => {},
  });
  core.manualReissueUntil = time + 300000;
  core.gateRequestAt = time - 1000;
  core._gateProof = () => true;
  // The original TASK109 cannot re-arm an exit.
  core.onTask({t:'TASK',d:{exe:true,o:109}});
  await new Promise(setImmediate);
  assert.equal(calls.length,0);
  // A fresh TASK100 reuses the existing outbound/line-close state machine.
  core.onTask({t:'TASK',d:{exe:true,o:100}});
  await new Promise(setImmediate);
  assert.deepEqual(calls,['EXTERNAL_MANUAL_REISSUE','released']);
  assert.equal(e._homeCloseArmed,true);
  assert.equal(core.manualReissueUntil,0);
  core.onTask({t:'TASK',d:{exe:true,o:100}});
  await new Promise(setImmediate);
  assert.equal(calls.length,2,'repeated native TASK must not create a new departure');
  // A missing/expired operator window or missing gate proof stays fail-closed.
  e._outbound = null;
  core.manualReissueUntil = time - 1;
  core.onTask({t:'TASK',d:{exe:true,o:100}});
  await new Promise(setImmediate);
  assert.equal(calls.length,2);
  core.manualReissueUntil = time + 300000;
  core._gateProof = () => false;
  core.onTask({t:'TASK',d:{exe:true,o:100}});
  await new Promise(setImmediate);
  assert.equal(calls.length,2);
  assert.ok(core.manualReissueUntil > time);
  e.isDoorOpenStable = () => false;
  assert.equal(await e.onManualReissueMowingDetected(),false,'gate not verified open');
  assert.equal(calls.length,2);
  console.log('PASS: native reissue restores outbound once; no auto-close; gate/expiry guards preserved');
})().catch(e => { console.error(e); process.exitCode = 1; });
