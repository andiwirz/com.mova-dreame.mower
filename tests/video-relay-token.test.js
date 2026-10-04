'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DreameStandaloneVideo = require('../lib/video/DreameStandaloneVideo');

function createVideo(logs) {
  const device = {
    homey: {},
    _api: {},
    getData: () => ({ id: 'TEST_ONLY' }),
    log: (line) => logs.push(String(line)),
  };
  const video = new DreameStandaloneVideo(device);
  video._resolveHost = async () => '192.0.2.69';
  video._selectRelayHost = () => '127.0.0.1';
  return video;
}

test('FLV relay access token is generated automatically and never written to logs', async () => {
  const logs = [];
  const video = createVideo(logs);
  const upstream = 'http://127.0.0.1:65530/app.xnet/ipc.p2p.com/ipc.flv?action=live&channel=0&quality=high&_crypto=on';
  const url1 = await video._startFlvRelay(upstream);
  const token1 = new URL(url1).pathname.match(/^\/dreame-xp2p\/([0-9a-f]{36})\.flv$/)?.[1];
  assert.ok(token1, 'first relay URL contains a cryptographically generated token');
  assert.ok(!logs.join('\n').includes(token1), 'raw token is not logged');
  await video._stopFlvRelay('unit_test');

  const url2 = await video._startFlvRelay(upstream);
  const token2 = new URL(url2).pathname.match(/^\/dreame-xp2p\/([0-9a-f]{36})\.flv$/)?.[1];
  assert.ok(token2);
  assert.notEqual(token2, token1, 'new relay session receives a fresh automatic token');
  assert.ok(!logs.join('\n').includes(token2), 'second raw token is not logged');
  await video._stopFlvRelay('unit_test');
});
