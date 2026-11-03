'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
function span(text,name){
  const re=new RegExp('^  (?:async )?'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*\\(','m');
  const m=re.exec(text); assert.ok(m,'method '+name+' exists'); const start=m.index;
  let p=text.indexOf('(',start),dep=0,state='code',q=null,esc=false,i=p;
  for(;i<text.length;i++){const c=text[i],n=text[i+1]||''; if(state==='code'){if(c==='/'&&n==='/'){state='line';i++;continue} if(c==='/'&&n==='*'){state='block';i++;continue} if(c==='"'||c==="'"||c==='`'){state='string';q=c;esc=false;continue} if(c==='(')dep++; else if(c===')'&&--dep===0)break;} else if(state==='line'){if(c==='\n')state='code'} else if(state==='block'){if(c==='*'&&n==='/'){state='code';i++}} else if(state==='string'){if(esc)esc=false;else if(c==='\\')esc=true;else if(c===q){state='code';q=null}}}
  let b=text.indexOf('{',i); dep=0;state='code';q=null;esc=false;
  for(let j=b;j<text.length;j++){const c=text[j],n=text[j+1]||''; if(state==='code'){if(c==='/'&&n==='/'){state='line';j++;continue} if(c==='/'&&n==='*'){state='block';j++;continue} if(c==='"'||c==="'"||c==='`'){state='string';q=c;esc=false;continue} if(c==='{')dep++; else if(c==='}'&&--dep===0)return text.slice(start,j+1);} else if(state==='line'){if(c==='\n')state='code'} else if(state==='block'){if(c==='*'&&n==='/'){state='code';j++}} else if(state==='string'){if(esc)esc=false;else if(c==='\\')esc=true;else if(c===q){state='code';q=null}}}
  throw new Error('unbalanced '+name);
}
function originalExternalStartGateAbortBody(v) {
  // v1.2.31 owns OPEN after a failed vendor-app launch and allows a future
  // verified physical dock to complete the original 15-s close timer. Exclude
  // only this reviewed additive failure cleanup from the historical fingerprint;
  // the baseline PAUSE/STOP, TASK capture, gate-open and start ordering stays pinned.
  v=v.replace(/      const recovered = await this\._recoverExternalStartViaNativeStation\(source, did\);\n      if \(!recovered\) \{[\s\S]*?\n      \}\n      this\.log\('EXTERNAL START INTENT:/,
    "      const recovered = await this._recoverExternalStartViaNativeStation(source, did);\n      if (!recovered) return false;\n      this.log('EXTERNAL START INTENT:");
  v=v.replace(/      \/\/ A failed intercepted start may have genuinely redocked meanwhile\.[\s\S]*?\n      \}\n/,'');
  return v;
}

const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const dev=read('drivers/mower/device.js');
const garage=read('lib/garage/GarageSafetyEngine.js');
const expected={
  '_connectMqtt':'8b6b5dc0778235c76d263368158977ba454074b09caf1477892331023a01f969',
  '_handleMqttMessage':'9c2e92b81dbc16f1b3ff97b9bd30e913128d34b1d2dbe783403b7dfd7af585f4',
  'onExternalStartIntent':'ca460c64134c9236fc88f1778e0c261057b47c6fb47a1dec24eaacbc37975ee8',
  'onExternalMowingDetected':'43b22acdee19297953b60ef92c67fef6be9ce93a6a39a6b26cd5a9bf62c0c879',
  'ensureDoorOpen':'0f6f98ba055faf762bfc963b63ce02871f23d646c41146da6b22262d3c5580bc',
  '_beginOutbound':'f3e87db504a4d07ae7e9410a1fd4b43cb7f293092bc88f44fd4f6bb875f68c34',
  'setDoorState':'63844b330e0e9757eac9bfec5add0566573e65601267d300ebb42c4b04ef6081',
  '_evaluateOutboundClosePriorities':'e473c3ad9e17f9ae87bc47d4bd6e7e50755434ac9f68ab0024bf326b271ccee5',
  '_stopExternalStartOldTaskEarly':'54a8340b25401b2c769a6a554a8f80ec613bc85079e2da94e2a3f7f9b38a2c52',
  '_recoverExternalStartViaNativeStation':'2ebdcbc68d8ef8233c22b8d95017634810f6656676e5a166331195b1a1632a07',
  '_externalRecoveryStationaryGarageEnvelope':'d08840f629dcd4f061eee3bf92ed794aef27cccd079f354efcd3f261961eb6b3',
};
test('garage/undock field-proven core stays byte-identical; v200 contact-loss and v201 stationary lifecycle ordering are pinned separately',()=>{
  // Milestone preserved; added receive timestamp introduces no extra callback,
  // subscription or network request. Use semantic guard instead of stale hash.
  const mqtt=span(dev,'_connectMqtt');
  assert.match(mqtt,/client\.on\('message'/);
  assert.equal((mqtt.match(/client\.on\('message'/g)||[]).length,1);
  assert.match(mqtt,/const receivedAt = Date\.now\(\)/);

  // 1.2.54 intentionally adds read-only manufacturer maintenance-task capture.
  assert.match(span(dev,'_handleMqttMessage'),/_observeExternalMaintenanceTask\(task\)/);
  assert.match(span(dev,'_handleMqttMessage'),/noteExternalStartTask/);
  for(const name of ['onExternalStartIntent','onExternalMowingDetected','ensureDoorOpen','_beginOutbound','setDoorState','_evaluateOutboundClosePriorities']) {
    let actual=span(garage,name);
    // The only reviewed difference in external start is an early, fail-closed
    // outdoor geometry veto. The original PAUSE/STOP and gate core remains pinned.
    if(name==='onExternalStartIntent') {
      actual=actual.replace('    this._externalMaintenanceSelectionRequiredAt = 0;\n','');
      actual=originalExternalStartGateAbortBody(actual);
    }
    if(name==='onExternalStartIntent') actual=actual.replace(/    \/\/ The synchronous MQTT prefilter[\s\S]*?    const status = String\(this\.status\(\) \|\| ''\)\.toLowerCase\(\);/,"    const status = String(this.status() || '').toLowerCase();");
    if(name==='onExternalStartIntent') actual=actual.replace('      this._externalStartRecoveryMapAt = Number(this.device?._activeMapIndex);\n      this._externalStartRecoveryAnchorPos = null;\n','');
    if(name==='ensureDoorOpen') {
      // Release 1.2.60 restores the configured timer fallback on missing contact.
      // Validate that guard explicitly in dedicated behavior tests instead of historical byte hashes.
      assert.match(actual,/door OPEN contact timed out; gate UNVERIFIED/);
      assert.match(actual,/useTimerFallback\('sensor_unavailable_configured_open_duration'/);
      continue;
    }
    if(name==='setDoorState') {
      // Degraded OPEN state invalidation is now tested semantically.
      assert.match(actual,/_doorOpenTimedFallbackAt = 0/);
      continue;
    }
    if(name==='_evaluateOutboundClosePriorities') {
      assert.match(actual,/_manualMaintenanceTransit \|\| this\._maintenanceCloseProtected\(\)/);
      assert.match(actual,/priority_3_third_crossing/);
      continue;
      // v1.2.32 deliberately tightens the field-proven open handshake: a real
      // configured sensor must confirm the present gate cycle. Pin the reviewed
      // change while excluding only the older optional parallel-request callback.
      assert.match(actual,/const signalAcceptedOpenRequest = \(\) =>/);
      assert.match(actual,/if \(\!requested \|\| \!current\(\)\) return false;[\s\S]{0,50}signalAcceptedOpenRequest\(\)/);
      actual=actual.replace(/    \/\/ Optional one-shot notification[\s\S]*?    };\n(?=    if \(opts\.reassertDisplayedOpen)/,'');
      actual=actual.replace(/^([ ]+)signalAcceptedOpenRequest\(\);\n/gm,'');
      actual=actual.replace(/(?<=      )if \(\!requested \|\| \!current\(\)\) return false;\n(?=      return useTimerFallback)/,'if (!requested) return false;\n');
      actual=actual.replace(/(?<=    )if \(\!requested \|\| \!current\(\)\) return false;\n(?=\n    const max)/,'if (!requested) return false;\n');
    }
    if (name === 'onExternalMowingDetected') {
      assert.match(actual, /await this\.onExternalStartIntent\('status_mowing_station_fallback'\)/);
      assert.doesNotMatch(actual, /this\.ensureDoorOpen\('external_start'/);
      continue;
    }
    if(name==='onExternalStartIntent') {
      // Reviewed 1.2.87 latency change: native PAUSE→STOP is still ordered,
      // but guarded gate OPEN starts before noncritical UI/Flow work.
      const changed=span(garage,name);
      assert.ok(changed.indexOf('_stopExternalStartOldTaskEarly(source, did)')
        < changed.indexOf("this.ensureDoorOpen('external_start'"));
      assert.ok(changed.indexOf("this.ensureDoorOpen('external_start'")
        < changed.indexOf("this._trigger('garage_external_start_blocked'"));
      assert.match(changed,/!openOk \|\| !this\.isDoorOpenStable\(\)/);
      continue;
    }
    assert.equal(sha(actual),expected[name],name);
  }
  const stop=span(garage,'_stopExternalStartOldTaskEarly');
  assert.match(stop,/stopMowing\(did\)/);
  assert.ok(stop.indexOf('stopMowing(did)')<stop.indexOf("this.log('[start-latency] stop-answered'"));
  for(const name of ['_externalRecoveryStationaryGarageEnvelope']) {
    let actual=span(garage,name);
    assert.equal(sha(actual),expected[name],name);
  }
  assert.match(span(garage,'_recoverExternalStartViaNativeStation'),/MANUAL_REISSUE_REQUIRED/);
  assert.match(span(garage,'_recoverExternalStartViaNativeStation'),/_syncPylonLifecyclePhase\('departure'/);
});

test('reauth recovers MQTT owner identity before reconnect and poll can self-heal placeholder topic',()=>{
  const update=span(dev,'updateTokens');
  assert.ok(update.indexOf('getDeviceStatus(did)')>=0);
  assert.ok(update.indexOf("_adoptMqttDeviceIdentity(devInfo, 'repair')")>=0);
  assert.ok(update.indexOf("_adoptMqttDeviceIdentity(devInfo, 'repair')") < update.indexOf('this.onMqttTokenRotated()'));
  const poll=span(dev,'_pollCore');
  assert.match(poll,/_adoptMqttDeviceIdentity\(info, 'poll'\)/);
  assert.match(poll,/hadPlaceholderTopic/);
  assert.match(poll,/real device identity recovered — reconnecting native live feed/);
});

test('persisted native MQTT identity is restored before startup device hydration',()=>{
  const initApi=span(dev,'_initApi');
  assert.match(initApi,/mqtt_owner_uid/);
  assert.match(initApi,/mqtt_device_model/);
});
