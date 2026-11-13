'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
const start = src.indexOf('  async additionalMaintenanceRequested(');
const end = src.indexOf('\n  async maintenanceRequested(',start);
assert.ok(start > 0 && end > start);
const fn = vm.runInNewContext('({' + src.slice(start,end).trim() + '}).additionalMaintenanceRequested');
const make = (gate=true, enabled=true) => {
  const calls=[];
  const c={
    _commandToken:1,_safeReturnInProgress:false,_returnGuardActive:false,_outbound:null,
    enabled:()=>enabled,isMowing:()=>false,isHomeStatus:()=>true,
    _beginOutbound:async (name,requiresMowing)=>{calls.push('outbound:'+requiresMowing);c._outbound={};},
    ensureDoorOpen:async()=>{calls.push('gate');return gate;},
    _markOutboundReleased:async()=>calls.push('released'),
    safetyWarning:async()=>calls.push('warning'),safetyBlock:async()=>calls.push('blocked'),
    log:()=>{},
  };
  return {c,calls};
};
(async()=>{
  let r=make();assert.equal(await fn.call(r.c,'flow_additional',2,async()=>{r.calls.push('native:P2');return true;}),true);
  assert.deepEqual(r.calls,['outbound:true','gate','native:P2','released']);
  r=make(false);assert.equal(await fn.call(r.c,'flow_additional',2,async()=>{r.calls.push('native');return true;}),false);
  assert.ok(!r.calls.includes('native'),'gate failure blocks the native opcode');
  r=make(true,false);assert.equal(await fn.call(r.c,'flow_additional',3,async()=>{r.calls.push('native:P3');return true;}),true);
  assert.deepEqual(r.calls,['native:P3']);
  r=make();r.c._outbound={};assert.equal(await fn.call(r.c,'flow_additional',2,async()=>{r.calls.push('native');return true;}),false);
  assert.ok(!r.calls.includes('native'));
  console.log('PASS: P2/P3 garage-safe dispatch preserves exact index and does not send with closed gate or busy state');
})().catch(e=>{console.error(e);process.exitCode=1;});
