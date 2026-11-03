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
