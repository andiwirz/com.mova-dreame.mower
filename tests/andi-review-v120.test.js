'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(p,'utf8');

test('Andi review: manifest keeps Homey 12.3 compatibility and credits EvotecIT',()=>{
  const compose=JSON.parse(read('.homeycompose/app.json'));
  assert.equal(compose.compatibility,'>=12.3.0');
  assert.ok(compose.contributors?.developers?.some(x=>x.name==='EvotecIT'));
});

test('Andi review: upstream permanent slow-motion setting is preserved for upgrade safety',()=>{
  const driver=JSON.parse(read('drivers/mower/driver.compose.json'));
  const all=JSON.stringify(driver);
  assert.match(all,/slow_motion_enabled/);
  const src=read('drivers/mower/device.js');
  assert.match(src,/slow_motion_enabled/);
  assert.match(src,/permanentSlow \? 0/);
  assert.match(src,/permanentSlow \? 1439/);
});

test('Andi review: Turning Mode is conditional on real PRE[19] support',()=>{
  const driver=JSON.parse(read('drivers/mower/driver.compose.json'));
  assert.ok(!driver.capabilities.includes('turning_method'));
  const src=read('drivers/mower/device.js');
  assert.match(src,/_ensureTurningMethodCapabilitySupport/);
  assert.match(src,/pre\.length > 19/);
  assert.match(src,/addCapability\('turning_method'\)/);
  assert.match(src,/removeCapability\('turning_method'\)/);
});

test('Andi review: repository normalizes text files to LF',()=>{
  assert.equal(read('.gitattributes').trim(),'* text=auto eol=lf');
});

test('Safety regression: MQTT startup keeps the last known-good identity-before-subscription order',()=>{
  const src=read('drivers/mower/device.js');
  const start=src.indexOf('  async onInit()');
  const end=src.indexOf('  async onDeleted()',start);
  assert.ok(start>=0&&end>start);
  const init=src.slice(start,end);
  const api=init.indexOf('await this._initApi()');
  const cfg=init.indexOf('this._api.getCFG',api);
  const history=init.indexOf('this._api.getMowingHistory',api);
  const dock=init.indexOf('this._api.getDockPosition',api);
  const devInfo=init.indexOf('this._api.getDeviceStatus(did)',api);
  const mqtt=init.indexOf('this._connectMqtt()',api);
  const turning=init.indexOf('this._ensureTurningMethodCapabilitySupport()',api);
  assert.ok(api>=0&&cfg>api&&history>cfg&&dock>history&&devInfo>dock,'baseline startup hydration order remains intact');
  assert.ok(mqtt>devInfo,'MQTT starts only after the real mower owner/device identity has been hydrated');
  assert.ok(turning>mqtt,'optional PRE[19] picker detection cannot disturb the garage startup path');
  assert.equal((init.match(/this\._connectMqtt\(\)/g)||[]).length,1,'exactly one startup MQTT connection');
});
