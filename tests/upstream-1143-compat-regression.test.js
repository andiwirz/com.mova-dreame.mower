'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'drivers/mower/device.js'), 'utf8');
function method(name) {
  const start = source.indexOf(`  async ${name}(`);
  assert.ok(start > 0, `method ${name} exists`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let i=brace;i<source.length;i++) {
    if (source[i]==='{') depth++;
    else if (source[i]==='}' && --depth === 0) {
      return vm.runInNewContext('({'+source.slice(start,i+1)+'})')[name];
    }
  }
  throw new Error('Unbalanced method: '+name);
}
function device(getPRE) {
  const events = [];
  const d = {
    _activeMapIndex:2,
    _cachedPRE:Array.from({length:19},(_,i)=>i),
    _api:{getPRE,writePRE:async(_did,pre)=>{events.push([...pre]);}},
    _ensureCachedPRE(){},
    log(){},
    _readNativePRE:method('_readNativePRE'),
    _writePREFields:method('_writePREFields'),
  };
  return {d,events};
}
test('Andy 1.1.43: true PRE read-modify-write keeps additional fields and unrelated settings',async()=>{
  let readArgs;
  const native=Array.from({length:22},(_,i)=>i*10);
  const {d,events}=device(async(...args)=>{readArgs=args;return native;});
  const written=await d._writePREFields('id',{4:35,16:1},'test');
  assert.deepEqual(readArgs,['id',2,0]);
  assert.equal(events.length,1);
  assert.equal(events[0][3],30);
  assert.equal(events[0][4],35);
  assert.equal(events[0][16],1);
  assert.equal(events[0][19],190);
  assert.equal(events[0][21],210);
  assert.equal(written.length,22);
});
test('Andy 1.1.43: explicitly rejected native PRE uses fallback without repeated read attempts',async()=>{
  let count=0;
  const {d,events}=device(async()=>{count++;let e=new Error('r:3');e.preRejected=true;throw e;});
  await d._writePREFields('id',{4:44},'first');
  await d._writePREFields('id',{3:9},'second');
  assert.equal(count,1);
  assert.equal(events[0][4],44);
  assert.equal(events[1][4],44);
  assert.equal(events[1][3],9);
});
test('Andys PRE migration covers capability listener, settings, and Flow writes',()=>{
  for (const sourceName of ['cutting_height','mow_efficiency','flow cutting_height','flow mow_efficiency',"'settings'"]) {
    assert.ok(source.includes(`_writePREFields(`) && source.includes(sourceName),sourceName);
  }
});
test('Andys 1.1.43 error hint tokens are present in both locale layers and compiled manifest',()=>{
  for (const lang of ['de','en']) {
    for (const folder of ['locales','.homeycompose/locales']) {
      const loc=require(path.join(root,folder,lang+'.json'));
      assert.ok(loc.fault_hints.default);
      assert.ok(loc.fault_hints['23']);
    }
  }
  const manifest=require(path.join(root,'app.json'));
  const trigger=manifest.flow.triggers.find(t=>t.id==='mower_error');
  assert.ok(trigger.tokens.some(t=>t.name==='error_hint'));
  const compose=require(path.join(root,'.homeycompose/flow/triggers/mower_error.json'));
  assert.ok(compose.tokens.some(t=>t.name==='error_hint'));
  assert.ok(source.includes('error_hint: errorHint'));
});
test('Andys 1.1.43 stale device-id and touch changes remain present',()=>{
  const api=fs.readFileSync(path.join(root,'widgets/map/api.js'),'utf8');
  const hist=fs.readFileSync(path.join(root,'widgets/history/public/index.html'),'utf8');
  assert.match(api,/return requestedDeviceId \? null : firstDevice/);
  assert.match(hist,/touch-action: pan-y/);
  assert.match(hist,/touch-action: manipulation/);
});
