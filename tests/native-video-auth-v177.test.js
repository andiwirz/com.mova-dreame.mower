'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {videoTokenBody,videoIdentityBody,VIDEO_OS,VIDEO_TOKEN_OS}=require('../lib/video_identity_contract');

test('v180 native TX identity uses the original Android did+os contract without speculative body fields',()=>{
  assert.equal(VIDEO_OS,'android');
  assert.equal(VIDEO_TOKEN_OS,1, 'keep the already proven token endpoint contract');
  assert.deepEqual(videoTokenBody(),{os:1});
  assert.deepEqual(videoIdentityBody('did-1',{accessToken:'ignored',uid:'ignored',model:'ignored'}),{
    did:'did-1',os:'android'
  });
});

test('v177 release settings expose no NodeLab or manual identity import',()=>{
  const compose=fs.readFileSync(require.resolve('../drivers/mower/driver.compose.json'),'utf8');
  const app=fs.readFileSync(require.resolve('../app.json'),'utf8');
  for(const text of [compose,app]){
    assert.equal(text.includes('video_tx_identity_pair_url'),false);
    assert.equal(text.includes('video_tx_identity_import'),false);
    assert.equal(text.includes('NodeLab-Kamera einmalig übernehmen'),false);
  }
});

test('v177 productive camera startup does not consume stored NodeLab identity',()=>{
  const src=fs.readFileSync(require.resolve('../lib/video/DreameStandaloneVideo.js'),'utf8');
  const open=src.slice(src.indexOf('async openNative('),src.indexOf('async stopNative('));
  assert.equal(open.includes('video_tx_local_identity'),false);
  assert.equal(open.includes('verifiedIdentity'),false);
  assert.match(open,/getTxVideoRuntimeInputs\(this\.did\)/);
});
