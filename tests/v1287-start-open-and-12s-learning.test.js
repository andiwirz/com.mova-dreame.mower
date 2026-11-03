'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Garage=require('../lib/garage/GarageSafetyEngine');
const source=require('node:fs').readFileSync(require.resolve('../lib/garage/GarageSafetyEngine'),'utf8');
function bare(){const e=Object.create(Garage.prototype);e._doorOpenDurationSeconds=()=>20;e._doorDelaySeconds=()=>18;return e;}
test('v1.2.87 reset defaults to eighteen only for proven zone STOP',async()=>{
 const e=bare();assert.equal(e._shortReturnGateOverlapMs(6,true),1000);
 assert.equal(e._shortReturnGateOverlapMs(6,false),19000);
 assert.equal(e._shortReturnGateOverlapMs(9,true),0);
 assert.equal(e._shortReturnGateOverlapMs(9,false),16000);
 const saved={garage_return_startup_learning_v1:{learnedCreditSeconds:3,samples:[3,3,3]}};
 e.device={getStoreValue:async k=>saved[k]||null};
 await e._loadReturnStartupLearning();
 assert.equal(e._returnStartupCreditSeconds(),18);
});
test('three reliable observations may adapt above twelve while staying bounded',async()=>{
 const e=bare();e.log=()=>{};e.device={setStoreValue:async()=>{}};
 for(let i=0;i<3;i++) await e._recordReturnStartupSample(14);
 assert.equal(e._returnStartupCreditSeconds(),14);
 assert.equal(e._shortReturnGateOverlapMs(6,true),5000);
 assert.equal(await e._recordReturnStartupSample(25),false);
});
test('external starts still PAUSE then STOP; start OPEN handshake before user-facing work; physical open proof required',()=>{
 const main=source.slice(source.indexOf('  async onExternalStartIntent('),source.indexOf('  async onExternalMowingDetected('));
 const pause=main.indexOf("_safeWrite('garage_external_start_intent_pause'");
 const stop=main.indexOf('_stopExternalStartOldTaskEarly(source, did)');
 const open=main.indexOf("this.ensureDoorOpen('external_start'");
 const flow=main.indexOf("this._trigger('garage_external_start_blocked'");
 assert.ok(pause>0&&stop>pause&&open>stop&&flow>open);
 assert.match(main,/const liveDoorContact = typeof this\.device\?\.getSetting === 'function' && this\.sensorEnabled\?\.\(\) === true\s*&& this\.sensorDoorMonitoringEnabled\?\.\(\) === true && this\.sensorHealthy\?\.\(\) === true/);
 assert.match(main,/const openOk = await gateOpening/);
 assert.match(main,/!openOk \|\| !this\.isDoorOpenStable\(\)/);
});
