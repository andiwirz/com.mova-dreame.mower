'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const MovaApi = require('../lib/MovaApi');

async function captureHeaders(api, options = {}) {
  const original = https.request;
  let captured;
  https.request = (requestOptions, cb) => {
    captured = requestOptions.headers;
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = err => { if (err) req.emit('error', err); };
    req.end = () => {
      const res = new PassThrough();
      res.statusCode = 200;
      res.headers = {};
      cb(res);
      res.end(JSON.stringify({ code: 0, data: {} }));
    };
    return req;
  };
  try {
    await api._request('/test', { did: 'fixture' }, false, options);
    return captured;
  } finally {
    https.request = original;
  }
}

test('1.2.47 Dreame Meta/RLC transport adjustment is scoped only to authenticated TX-video requests', async () => {
  const api = new MovaApi({ brand: 'dreame', region: 'eu' });
  api._accessToken = 'synthetic-token';
  const normal = await captureHeaders(api);
  assert.equal(normal['Dreame-Auth'], 'synthetic-token');
  assert.equal(normal['Dreame-Meta'], undefined);
  assert.equal(normal['Dreame-Rlc'], undefined);
  assert.equal(normal.Authorization, undefined);

  const video = await captureHeaders(api, { videoProfile: true });
  assert.match(video.Authorization || '', /^Basic /);
  assert.equal(video['Dreame-Auth'], 'bearer synthetic-token');
  assert.equal(video['Dreame-Meta'], 'cv=a_102060400');
  assert.equal(typeof video['Dreame-Rlc'], 'string');
  assert.ok(video['Dreame-Rlc'].length > 10);
});

test('1.2.47 MOVA video transport does not receive Dreame-only Meta/RLC headers', async () => {
  const api = new MovaApi({ brand: 'mova', region: 'eu' });
  api._accessToken = 'synthetic-token';
  const video = await captureHeaders(api, { videoProfile: true });
  assert.match(video.Authorization || '', /^Basic /);
  assert.equal(video['Dreame-Auth'], 'bearer synthetic-token');
  assert.equal(video['Dreame-Meta'], undefined);
  assert.equal(video['Dreame-Rlc'], undefined);
});
