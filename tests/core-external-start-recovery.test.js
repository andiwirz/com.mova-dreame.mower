'use strict';
const assert = require('node:assert/strict');
const { CoreExternalStartRecovery } = require('../lib/garage/CoreExternalStartRecovery');
function frame(u, dock=0) { const a = Array(20).fill(0); a[0]=a[19]=206; a[14]=(u<<6)|(dock<<2); return a; }
function rig({ missingTask=false, loseDock=false, openProof=true, sensor=true, failStop=false, otherTask=false } = {}) {
  let t=100000;
  let core;
  const calls=[];const logs=[];
  const garage={
    _outbound:null,_missionOutside:false,_safeReturnInProgress:false,_lastSensorSignalAt:0,_lastSensorContactState:'closed',_lastGateOpenHandshakeAt:0,
    enabled:()=>true,sensorEnabled:()=>sensor,sensorHealthy:()=>sensor,
    isDoorOpenStable:()=>!!garage.open,
    _doorOpenReleaseVerified:()=>!!garage.open,
    ensureDoorOpen:async()=>{calls.push('open');garage.open=openProof;if(openProof){garage._lastSensorSignalAt=t;garage._lastSensorContactState='open';garage._lastGateOpenHandshakeAt=t;}return openProof;},
    safetyBlock:async()=>{calls.push('block');},
    _beginOutbound:async()=>{calls.push('outbound');garage._outbound={action:'RECOVERED'};},
    _markOutboundReleased:async()=>{calls.push('released');},
  };
  const device={
    getSetting:()=>true,getData:()=>({id:'mock'}),_activeMapIndex:0,
    _safeWrite:async(label,fn)=>{calls.push(label);const r=await fn();return r!==false;},
    _api:{
      pause:async()=>{calls.push('pause');return true;},
      stopMowing:async()=>{calls.push('stop');if(!loseDock)core.onNativeFrame(frame(0));else core.onNativeFrame(frame(0,1));return !failStop;},
      startMowing:async()=>{calls.push('start');core.onNativeFrame(frame(1));return true;},
      startEdgeMowing:async()=>true,startZoneMowing:async()=>true,startSpotMowing:async()=>true,
    },
  };
  core=new CoreExternalStartRecovery({device,garage,now:()=>t,sleep:async ms=>{t+=ms;},log:(...v)=>logs.push(v)});
  core.onNativeFrame(frame(0));t+=1;core.onNativeFrame(frame(1));
  if(!missingTask) core.onTask({t:'TASK',d:{o:otherTask?109:100,exe:true,status:true}});
  return {core,calls,logs,garage};
}
(async()=>{
  let r=rig();assert.equal(r.core.eligible(),true);
  assert.equal(await r.core.onUndockingEdge(),true);
  assert.deepEqual(r.calls.filter(x=>['pause','stop','open','outbound','start','released'].includes(x)),['pause','stop','open','outbound','start','released']);
  assert.equal(r.core.phase,'DONE');
  r=rig();r.garage.open=true;r.garage._lastSensorContactState='open';
  assert.equal(r.core.eligible(),false,'verified-open gate must not intercept the original-app command');
  r.garage.open=false;r.garage._lastSensorContactState='closed';
  assert.equal(r.core.eligible(),true,'closed-gate intercept remains active');
  r=rig({missingTask:true});assert.equal(await r.core.onUndockingEdge(),false);
  assert.equal(r.calls.includes('start'),false);assert.equal(r.core.phase,'OPERATOR_CHECK_REQUIRED');
  r=rig({otherTask:true});assert.equal(await r.core.onUndockingEdge(),false);
  assert.equal(r.calls.includes('start'),false,'109 must not be replaced with a mowing task');
  r=rig({loseDock:true});assert.equal(await r.core.onUndockingEdge(),false);
  assert.equal(r.calls.includes('open'),false,'no gate open after unverified stop');
  r=rig({openProof:false});assert.equal(await r.core.onUndockingEdge(),false);
  assert.equal(r.calls.includes('start'),false,'no start with unverified door');
  r=rig({sensor:false});assert.equal(r.core.eligible(),false);
  r=rig({failStop:true});assert.equal(await r.core.onUndockingEdge(),false);
  assert.equal(r.calls.includes('open'),false);
  console.log('PASS: seven external-start controller scenarios');
})().catch(e=>{console.error(e);process.exitCode=1});
