'use strict';
/**
 * Offline cloud contract simulator. NOT an Android emulator and NOT a camera.
 * No real credentials, HTTP requests, SDK, mower, Homey or pairing.
 * Exercises the current Homey TX-video discovery code against synthetic
 * responses modeled on the sanitized NodeLab v8.58 result.
 */
const MovaApi = require('../lib/MovaApi');

async function runSimulation({ associated = true, identityCode = 10000 } = {}) {
  const calls = [];
  const logs = [];
  const api = new MovaApi({ brand: 'dreame', region: 'eu', log: message => logs.push(String(message)) });
  api._ensureAuth = async () => {};
  api.getDevices = async () => [{ did: 'SYNTHETIC_DID', model: 'synthetic.mower.device', uid: 'SYNTHETIC_UID' }];
  api._request = async (endpoint, body) => {
    calls.push({ endpoint, keys: Object.keys(body).sort() });
    if (endpoint.endsWith('/user/accesstoken')) {
      return { code: 0, data: { accesstoken: 'SYNTHETIC_TOKEN_PRIVATE' } };
    }
    if (endpoint.endsWith('/mgr/dev/getIdentity')) {
      return identityCode === 0
        ? { code: 0, data: { productId: 'syntheticProduct', deviceName: 'syntheticDevice' } }
        : { code: identityCode, success: false, message: 'SYNTHETIC_PRIVATE_VENDOR_MESSAGE' };
    }
    if (endpoint.endsWith('/dev/isDevUser')) {
      return { code: 0, data: { isDevUser: associated }, message: 'SYNTHETIC_PRIVATE_VENDOR_MESSAGE' };
    }
    if (endpoint.endsWith('/dev/getP2PInfo')) {
      return { code: 0, data: { p2pInfo: 'SYNTHETIC_PRIVATE_P2PINFO' }, message: 'SYNTHETIC_PRIVATE_VENDOR_MESSAGE' };
    }
    throw new Error('Unexpected endpoint in read-only simulator');
  };
  let result = 'unexpected_success';
  try {
    await api.getTxVideoRuntimeInputs('SYNTHETIC_DID');
    result = 'identity_available';
  } catch (err) {
    result = /(Zuordnung nicht bestätigt|nicht mit dem Gerät verknüpft)/.test(String(err.message))
      ? 'association_missing'
      : (/Geräteidentität nicht bereitgestellt/.test(String(err.message))
        ? 'identity_missing' : 'other_error');
  }
  if (calls.some(call => /\/pair(?:$|\/)/.test(call.endpoint))) {
    throw new Error('Safety invariant: simulator observed an automatic pair request');
  }
  if (/SYNTHETIC_PRIVATE/.test(logs.join('\n'))) {
    throw new Error('Privacy invariant: private vendor data appeared in logs');
  }
  return {
    mode: 'offline_synthetic_no_network', result, associated,
    requestPaths: calls.map(c => c.endpoint),
    rawValuesLogged: false, pairingAttempted: false,
    cameraAction: false, sdkStarted: false, mowerCommand: false,
  };
}
module.exports = { runSimulation };
if (require.main === module) {
  runSimulation().then(out => console.log(JSON.stringify(out,null,2)))
    .catch(() => { console.error('Offline simulation failed (details redacted)'); process.exitCode = 1; });
}
