'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Garage = require('../lib/garage/GarageSafetyEngine');

async function checkDockCleanup(armed) {
  const e = Object.create(Garage.prototype);
  const logs=[];
  e._homeCloseArmed=armed;
  e._returnContext='HOME_CONFIRMED';
  e._outboundHardLockUntil=Date.now()+180000;
  e._startCycleIgnoreReturnUntil=Date.now()+180000;
  e.status=()=> 'charging';
  e._setLineState=()=>{}; e._setReturnContext=()=>{};
  e.clearSafety=async()=>{}; e.refreshTileStatus=async()=>{};
  e.log=(...args)=>logs.push(args.join(' '));
  await e._enterDockedIdle('native_docked_or_charging_safe_space');
  assert.equal(e._homeState,'home');
  if (armed) {
    assert.equal(e._outboundHardLockUntil,0,'verified active return must release obsolete departure guard');
    assert.equal(e._startCycleIgnoreReturnUntil,0);
    assert.ok(logs.some(x=>x.includes('stale outbound locks released')));
  } else {
    assert.ok(e._outboundHardLockUntil>Date.now(),'startup/unarmed home must not release outbound guard');
  }
}
(async()=>{
  await checkDockCleanup(true);
  await checkDockCleanup(false);
  const src=fs.readFileSync(require.resolve('../lib/garage/GarageSafetyEngine'),'utf8');
  assert.doesNotMatch(src,/inbound safety-line emergency PAUSE/);
  assert.doesNotMatch(src,/inbound_line_closed_gate/);
  assert.match(src,/if \(garageDoorMoving && inside\)/);
  assert.match(src,/if \(this.isReturning\(\) \|\| this._safeReturnInProgress \|\| this._returnGuardActive\)/);
  console.log('PASS: verified-home guard cleanup + no unarmed cleanup + gate-motion-only guard');
})().catch(e=>{console.error(e); process.exitCode=1});
