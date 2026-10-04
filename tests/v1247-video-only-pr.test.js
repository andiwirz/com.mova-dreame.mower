'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { HomeyCamera } = require('../lib/video/HomeyCamera');
const { FlvH264 } = require('../lib/video/FlvH264');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

function deviceFixture(logs = []) {
  return {
    getSetting: k => k === 'video_enabled',
    getData: () => ({ id: 'fixture' }),
    _mowerBinaryDiag: { dockingState: 'OUT_OF_STATION' },
    _mowerBinaryDiagAt: Date.now(),
    log: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
    getCapabilityValue: () => null,
  };
}

function flvTag(type, body, time = 0) {
  const b = Buffer.alloc(15 + body.length);
  b[0] = type;
  b.writeUIntBE(body.length, 1, 3);
  b.writeUIntBE(time & 0xffffff, 4, 3);
  b[7] = time >>> 24;
  body.copy(b, 11);
  b.writeUInt32BE(body.length + 11, b.length - 4);
  return b;
}

test('1.2.47 local XP2P/FLV camera path reaches live state and returns H.264 widget frames', async t => {
  const header = Buffer.from([70,76,86,1,1,0,0,0,9,0,0,0,0]);
  const config = flvTag(9, Buffer.from([0x17,0,0,0,0,1,0x64,0,0x1f,255,225,0]), 0);
  const key = flvTag(9, Buffer.from([0x17,1,0,0,0,0,0,0,2,0x65,0x88]), 100);
  const source = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/x-flv' });
    res.write(Buffer.concat([header, config, key]));
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  const camera = new HomeyCamera(deviceFixture(), {
    openNative: async () => `http://127.0.0.1:${source.address().port}/app.xnet/ipc.flv?action=live&channel=0&quality=high&_crypto=on`,
    stopNative: async () => {},
    _selectRelayHost: () => '127.0.0.1',
  });
  t.after(async () => {
    await camera.stop().catch(() => {});
    source.closeAllConnections();
    await new Promise(resolve => source.close(resolve));
  });
  await camera.control('start', 'widget_video');
  if (camera.session.starting) await camera.session.starting;
  assert.equal(camera.session.state, 'live');
  const snap = await camera.control('snapshot', 'widget_video', { cursor: 0 });
  assert.ok(snap.config);
  assert.ok(Array.isArray(snap.frames));
  assert.ok(snap.frames.length >= 1);
  assert.equal(Object.hasOwn(snap, 'audio'), false);
});

test('1.2.47 tokenized FLV diagnostic accepts HEAD/query only while a camera lease is active', async t => {
  const logs = [];
  const camera = new HomeyCamera(deviceFixture(logs), {
    stopNative: async () => {},
    _selectRelayHost: () => '127.0.0.1',
  });
  camera.session.state = 'live';
  camera.session.leases.set('flv_diag', Date.now());
  camera.demux = { initial: () => Buffer.from('FLV') };
  await camera._ensureRelayServer();
  t.after(async () => { await camera.stop().catch(() => {}); });
  const port = camera.server.address().port;
  const url = `http://127.0.0.1:${port}/t/${camera.token}/camera.flv?probe=1`;
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('content-type') || '', /video\/x-flv/);
  camera.session.leases.clear();
  const rejected = await fetch(url, { method: 'HEAD' });
  assert.equal(rejected.status, 403);
  assert.ok(logs.some(x => x.includes('relay rejected route=flv reason=no_active_lease method=HEAD')));
});

test('1.2.47 diagnostic lease heartbeat keeps the advertised FLV URL alive for the requested TTL', () => {
  const src = read('lib/video/HomeyCamera.js');
  assert.match(src, /diagnosticHeartbeat=setInterval\(\(\)=>\{if\(this\.session\.leases\.has\('flv_diag'\)\)this\.session\.touch\('flv_diag'\);\},10000\)/);
  assert.match(src, /expiresInSeconds:Math\.round\(ttl\/1000\)/);
  assert.match(src, /diagnosticUrl\(ttlMs=120000\)/);
});

test('1.2.47 FLV demux is explicitly video-only even if upstream announces/sends audio', () => {
  const header = Buffer.from([70,76,86,1,5,0,0,0,9,0,0,0,0]);
  const audio = flvTag(8, Buffer.from([0xaf,0,0x12,0x10]), 0);
  const config = flvTag(9, Buffer.from([0x17,0,0,0,0,1,0x64,0,0x1f,255,225,0]), 0);
  const frame = flvTag(9, Buffer.from([0x17,1,0,0,0,0,0,0,2,0x65,0x88]), 100);
  const demux = new FlvH264();
  demux.push(Buffer.concat([header, audio, config, frame]));
  const initial = demux.initial();
  const snap = demux.snapshot(0);
  assert.equal(initial[4] & 0x04, 0);
  assert.equal(initial.includes(audio), false);
  assert.ok(snap.frames.length >= 1);
  assert.equal(Object.hasOwn(snap, 'audio'), false);
});

test('1.2.47 camera and overview widgets contain no live-camera audio UI or decoder path', () => {
  const backend = read('lib/widgets/MowerDashboard.js');
  assert.match(backend, /action === 'flv_url'/);
  assert.doesNotMatch(backend, /audio_diagnostic|audio_probe|audio_enable|audio_stream_url|aac_url/);
  for (const rel of ['widgets/camera/public/index.html','widgets/overview/public/index.html']) {
    const html = read(rel);
    assert.doesNotMatch(html, /audioToggle|audioTestBtn|aacDiagBtn|Audio-Test|AAC-Test/);
  }
  for (const rel of ['widgets/camera/public/dashboard.js','widgets/overview/public/dashboard.js']) {
    const js = read(rel);
    assert.match(js, /VideoDecoder/);
    assert.doesNotMatch(js, /AudioDecoder|AudioContext|webkitAudioContext|audioCursor|aac_url|audio_enable|g711|mp3-webaudio/);
  }
});

test('1.2.47 mower API retains ordinary speaker/voice settings but has no camera-audio service implementation', () => {
  const api = read('lib/MovaApi.js');
  assert.match(api, /setVolume\(did, volume\)/);
  assert.match(api, /setVoiceModes\(did,/);
  assert.doesNotMatch(api, /setVideoAudioEnabled|getVideoStreamStatus|_parseVideoStreamStatusValue|10001\s*,\s*2/);
  const standalone = read('lib/video/DreameStandaloneVideo.js');
  assert.doesNotMatch(standalone, /setMonitorAudioEnabled/);
});
