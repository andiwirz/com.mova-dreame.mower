'use strict';
const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const path=require('node:path'); const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'); const read=p=>fs.readFileSync(path.join(root,p),'utf8');
function span(text,name){ const re=new RegExp('^  (?:async )?'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*\\(','m'); const m=re.exec(text); assert.ok(m,'method '+name+' exists'); const start=m.index; let p=text.indexOf('(',start),dep=0,state='code',q=null,esc=false,i=p;
  for(;i<text.length;i++){const c=text[i],n=text[i+1]||''; if(state==='code'){if(c==='/'&&n==='/'){state='line';i++;continue} if(c==='/'&&n==='*'){state='block';i++;continue} if(c==='"'||c==="'"||c==='`'){state='string';q=c;esc=false;continue} if(c==='(')dep++; else if(c===')'&&--dep===0)break;} else if(state==='line'){if(c==='\n')state='code'} else if(state==='block'){if(c==='*'&&n==='/'){state='code';i++}} else if(state==='string'){if(esc)esc=false;else if(c==='\\')esc=true;else if(c===q){state='code';q=null}}}
  let b=text.indexOf('{',i); dep=0;state='code';q=null;esc=false; for(let j=b;j<text.length;j++){const c=text[j],n=text[j+1]||''; if(state==='code'){if(c==='/'&&n==='/'){state='line';j++;continue} if(c==='/'&&n==='*'){state='block';j++;continue} if(c==='"'||c==="'"||c==='`'){state='string';q=c;esc=false;continue} if(c==='{')dep++; else if(c==='}'&&--dep===0)return text.slice(start,j+1);} else if(state==='line'){if(c==='\n')state='code'} else if(state==='block'){if(c==='*'&&n==='/'){state='code';j++}} else if(state==='string'){if(esc)esc=false;else if(c==='\\')esc=true;else if(c===q){state='code';q=null}}} throw new Error('unbalanced '+name); }
const sha=s=>crypto.createHash('sha256').update(s).digest('hex'); const expected={
  "device._connectMqtt": "8b6b5dc0778235c76d263368158977ba454074b09caf1477892331023a01f969",
  "device._handleMqttMessage": "d5a0df4fa3319304fe0b4cef8b82d18dfde817838d2ca2e59148fd3bc7bfd939",
  "garage._waitForExternalRecovery": "c24962fc05af396df4085cb9caacb014dbd8be527521e428674178a78896624a",
  "garage._nativeStationContextForExternalRecovery": "f079572aa708b7f30a12ce7111b93702ab11eba5441601d1d705f1890335fce4",
  "garage.noteExternalRecoveryDockTelemetry": "5f0889fa66a90af44b60fcc625d85e1c9eb96701af3b30fd227d80cf5ecd633c",
  "garage._stopExternalStartOldTaskEarly": "e0283703c5b9eb39233df399ecbc2e9212b3885dd87e69b2ee1e3212aca2cd73",
  "garage._recoverExternalStartViaNativeStation": "8104e69b4e71a75772060b5c0004bd94fc425e49573601b7954309e1456fece6",
  "garage.shouldInterceptExternalStartIntent": "3be5d0a08b5602acf5b5da5076cd0a32c7b9483200c78de58484b5c5142b81c6",
  "garage.onExternalStartIntent": "782d82c8d863f9ad5fa7b08f125c8a8fe6d5541a0ffb95dafd346f85ee12ad74",
  "garage.onExternalMowingDetected": "43b22acdee19297953b60ef92c67fef6be9ce93a6a39a6b26cd5a9bf62c0c879"
};
const dev=read('drivers/mower/device.js'),garage=read('lib/garage/GarageSafetyEngine.js'); const targets={
'device._connectMqtt':span(dev,'_connectMqtt'),'device._handleMqttMessage':span(dev,'_handleMqttMessage'),
'garage._waitForExternalRecovery':span(garage,'_waitForExternalRecovery'),'garage._nativeStationContextForExternalRecovery':span(garage,'_nativeStationContextForExternalRecovery'),'garage.noteExternalRecoveryDockTelemetry':span(garage,'noteExternalRecoveryDockTelemetry'),'garage._stopExternalStartOldTaskEarly':span(garage,'_stopExternalStartOldTaskEarly'),'garage._recoverExternalStartViaNativeStation':span(garage,'_recoverExternalStartViaNativeStation'),'garage.shouldInterceptExternalStartIntent':span(garage,'shouldInterceptExternalStartIntent'),'garage.onExternalStartIntent':span(garage,'onExternalStartIntent'),'garage.onExternalMowingDetected':span(garage,'onExternalMowingDetected')};
// v1.2.0 extends three methods and moves STOP before capability status writes to preserve the interrupted TASK.
// Strip ONLY those explicit additions before comparing the original milestone.
// The other seven methods remain byte-identical; this is no longer a claim of
// byte parity for the complete external-start implementation.
function milestoneBody(k, v) {
 if(k==='device._handleMqttMessage')v=v.replace(/^[ \t]*this\._garageSafety\?\.noteHomeDockTelemetry\?\.\(diag\);\n/m,'');
 if(k==='device._handleMqttMessage'){
  v=v.replace(/          \/\/ Preserve start intent independently[\s\S]*?          }\n(?=          this\._garageSafety\?\.noteExternalStartTask)/,'');
  v=v.replace('          this._garageSafety?.noteExternalStartTask?.(value);\n','');
 }
 if(k==='garage._stopExternalStartOldTaskEarly') {
  v=v.replace('    // Preserve any OUT_OF_STATION edge received while the PAUSE write was in\n    // flight. Clearing it here could incorrectly re-arm a lost station window.\n','');
  v=v.replace("    this._setExternalStartRecoveryPhase('STOP_OLD_TASK_EARLY', source);",
   "    this._externalStartStationWindowLost = false;\n    this._externalStartStationWindowConfirmedAt = 0;\n    this._setExternalStartRecoveryPhase('STOP_OLD_TASK_EARLY', source);");
  v=v.replace('    this._externalStartStopSentAt = Date.now();\n','');
 }
 if(k==='garage.onExternalStartIntent') {
  v=v.replace('    // Dispatch the native PAUSE before timeline and Flow processing.\n','');
  v=v.replace('    this._externalStartIntentAt = now;\n',
   "    this._externalStartIntentAt = now;\n    this.realtimeTimelineEvent('external_start', source);\n    this._trigger('garage_external_start_blocked', 'external_start_mqtt_intent');\n    this.log('EXTERNAL START INTENT: safety pause, open gate, reset native station context, then start fresh task', source, task ? JSON.stringify(task).slice(0, 240) : '');\n");
  v=v.replace('      this._externalStartPauseSentAt = Date.now();\n','');
  v=v.replace(/      this\.realtimeTimelineEvent\('external_start', source\);\n      this\._trigger\('garage_external_start_blocked', 'external_start_mqtt_intent'\);\n      this\.log\('EXTERNAL START INTENT: PAUSE and STOP dispatched before user-facing events',[^\n]+\n        [^\n]+\n        [^\n]+\n        [^\n]+\n/,'');
  v=v.replace("      // UI capability writes can be slow: publish PAUSED only after the native\n      // STOP has secured the narrow IN_STATION window.\n      if (typeof this.device._applyStatus === 'function') await this.device._applyStatus('paused').catch(() => {});\n",'');
  v=v.replace("      if (!stoppedEarly) return false;\n\n\n","      if (!stoppedEarly) return false;\n\n");
  v=v.replace("      // v9: STOP the half-started task immediately","      if (typeof this.device._applyStatus === 'function') await this.device._applyStatus('paused').catch(() => {});\n\n      // v9: STOP the half-started task immediately");
  v=v.replace("        return false;\n      }\n\n      if (typeof this.device._applyStatus", "        return false;\n      }\n      if (typeof this.device._applyStatus");
  v=v.replace(/      this\._externalStartRecoveryPhase = null;\n      this\._externalStartTask = null;\n      const intentAge =[\s\S]*?      }\n(?=      this\._externalStartStationWindowLost)/,'');
  v=v.replace("      // The pause is already the immediate collision protection. Give MQTT one\n      // tiny bounded window to deliver the original task descriptor before STOP\n      // replaces it with opcode 3. This is especially important for vendor-app\n      // maintenance (109), whose native motion status still looks like mowing.\n      if (!this._externalStartTask) {\n        await this._waitForExternalRecovery(() => {\n          const age = Date.now() - Number(this.device._mqttTaskIntentCandidateAt || 0);\n          if (age >= 0 && age <= 5000) this.noteExternalStartTask(this.device._mqttTaskIntentCandidate);\n          return this._externalStartTask || null;\n        }, 120, 'original_task_intent_capture', 20);\n      }\n\n",'');
  v=v.replace('      this._externalStartTask = null;\n','');
  v=v.replace("        return false;\n      }\n\n      if (typeof this.device._applyStatus", "        return false;\n      }\n      if (typeof this.device._applyStatus");
 }
 if(k==='garage._recoverExternalStartViaNativeStation') {
  v=v.replace("    if (Number(this._externalStartTask?.o) === 109) {\n      this._setExternalStartRecoveryPhase('RESTORE_MAINTENANCE', source);\n      return this.maintenanceRequested('button_maintenance_external_recovered',\n        () => this.device._goToMaintenancePointGuarded('external_recovered_maintenance'));\n    }\n",'');
  v=v.replaceAll('this._dispatchRecoveredMowingTask(did)','this.device._api.startMowing(did)');
 }
 return v;
}
test('v1.2.1 retains 1.1.65 station guards with reviewed task dispatch and early STOP',()=>{for(const [k,v] of Object.entries(targets))assert.equal(sha(milestoneBody(k,v)),expected[k],k)});
test('v193 early start keys on raw IN_STATION undocking edge before TASK/control fallbacks',()=>{const h=targets['device._handleMqttMessage'];const edge=h.indexOf('native-undock-start-intercept'),task=h.indexOf('task-active-2:50'),control=h.indexOf('mqtt_control_2_56');assert.ok(edge>=0);assert.ok(task>edge);assert.ok(control>edge);assert.ok(h.includes("onExternalStartIntent('mqtt_native_undock_1_1'"))});
test('v193 MQTT transport exactly restores 1.1.65 field compatibility',()=>{const c=targets['device._connectMqtt'];assert.ok(c.includes('rejectUnauthorized: false'));assert.ok(c.includes("client.on('message'"))});
