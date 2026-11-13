'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../lib/garage/GarageSafetyEngine.js'),'utf8');
const start = source.indexOf('  async _sendMaintenanceWithRetry(');
const end = source.indexOf('\n  _sensorWatchdogMinutes()', start);
const fn = vm.runInNewContext('({' + source.slice(start, end).trim() + '})._sendMaintenanceWithRetry');
(async () => {
  let sends=0, prepares=0;
  const context = {
    _commandToken: 3, status:()=> 'returning',
    _prepareMowerForReturnPath:async()=>{prepares++; return true;},
  };
  assert.equal(await fn.call(context, async () => { sends++;return true; }, 3, 'external_status_returning'),true);
  assert.equal(sends,1,'accepted opcode 109 sent only once');
  assert.equal(prepares,1);
  assert.equal(await fn.call(context, async () => { sends++;return true; }, 2),false);
  assert.equal(sends,1,'superseded return cannot send 109');
  context._prepareMowerForReturnPath = async()=>false;
  assert.equal(await fn.call(context, async () => { sends++;return true; }, 3),false);
  assert.equal(sends,1,'failed pause cannot send 109');
  console.log('PASS: CORE return avoids duplicate native 109, honours generation and pause');
})().catch(e=>{console.error(e);process.exitCode=1;});
