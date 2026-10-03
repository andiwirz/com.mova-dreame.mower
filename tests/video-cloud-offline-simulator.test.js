'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSimulation } = require('../scripts/video-cloud-offline-simulator');

test('v8.58-shaped synthetic cloud errors cannot pair, move or leak credentials', async () => {
  const info = await runSimulation({ associated:true, identityCode:10000 });
  assert.equal(info.mode,'offline_synthetic_no_network');
  assert.equal(info.result,'identity_missing');
  assert.ok(info.requestPaths.some(path => path.endsWith('/getP2PInfo')));
  assert.equal(info.requestPaths.filter(path => path.endsWith('/getIdentity')).length,1, 'one canonical identity request without guessed retries');
  assert.equal(info.pairingAttempted,false);
  assert.equal(info.rawValuesLogged,false);
  assert.equal(info.cameraAction,false);
  assert.equal(info.mowerCommand,false);
});

test('missing association never triggers auto-pairing', async () => {
  const info = await runSimulation({ associated:false, identityCode:10000 });
  assert.equal(info.result,'association_missing');
  assert.equal(info.pairingAttempted,false);
  assert.equal(info.associated,false);
});

test('synthetic successful identity remains a read-only simulated result', async () => {
  const info = await runSimulation({ associated:true, identityCode:0 });
  assert.equal(info.result,'identity_available');
  assert.equal(info.sdkStarted,false);
  assert.equal(info.cameraAction,false);
  assert.equal(info.pairingAttempted,false);
});
