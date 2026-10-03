'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Garage = require('../lib/garage/GarageSafetyEngine');
const MovaApi = require('../lib/MovaApi');
const { HomeyCamera } = require('../lib/video/HomeyCamera');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const header = Buffer.from([70,76,86,1,1,0,0,0,9,0,0,0,0]);
function tag(type, body, time=0){const b=Buffer.alloc(15+body.length);b[0]=type;b.writeUIntBE(body.length,1,3);b.writeUIntBE(time&0xffffff,4,3);b[7]=time>>>24;body.copy(b,11);b.writeUInt32BE(body.length+11,b.length-4);return b;}
const vcfg=tag(9,Buffer.from([0x17,0,0,0,0,1,0x64,0,0x1f,255,225,0]));
const vkey=tag(9,Buffer.from([0x17,1,0,0,0,0,0,0,2,0x65,0x88]),100);

function bareGarage() {
  const e = Object.create(Garage.prototype);
  Object.assign(e, {
    _commandToken: 1,
    _manualGateStopped: false,
    _manualMaintenanceReached: false,
    _manualMaintenanceTransit: false,
    _manualMaintenancePhase: 'idle',
    _returnContext: 'IDLE',
    enabled: () => true,
    isHomeStatus: () => false,
    isMowing: () => true,
    status: () => 'mowing',
    pos: () => ({x: 1000, y: 1000, ts: Date.now()}),
    log: () => {}, error: () => {}, _trigger: () => {},
    refreshTileStatus: async () => {}, safetyWarning: async () => {}, returnOperationalHold: async () => {},
    _clearManualMaintenanceStatusTimers: () => {},
    _watchMaintenanceReached: () => {},
    _clearOutboundStatusTimers: () => {},
    device: { _nativeMaintenanceCommandAt: 0, _pendingNativeMaintenanceArrival: null, _nativeMaintenanceStableArrival: null,
      _maintenancePointIndex: () => 1 },
  });
  return e;
}

test('v1230 outside maintenance bypasses gate/outbound and pauses active mowing before opcode 109 callback', async () => {
  const e = bareGarage();
  const order=[];
  e._prepareMowerForReturnPath = async reason => { order.push('prepare:'+reason); };
  e._beginOutbound = async () => { throw new Error('outside maintenance must not begin garage outbound'); };
  e.ensureDoorOpen = async () => { throw new Error('outside maintenance must not touch gate'); };
  const ok = await e.maintenanceRequested('button_maintenance', async () => { order.push('109'); return true; });
  assert.equal(ok, true);
  assert.deepEqual(order, ['prepare:manual_maintenance_outside','109']);
  assert.equal(e._manualMaintenancePhase, 'transit');
  assert.equal(e._manualMaintenanceTransit, true);
  assert.equal(e._missionOutside, true);
});

test('v1230 MQTT caches restorable task intent independent of TASK.status and external recovery consumes it', () => {
  const device = read('drivers/mower/device.js');
  const garage = read('lib/garage/GarageSafetyEngine.js');
  assert.match(device, /restorable task intent candidate opcode=\$\{taskOpcode\} status=/);
  assert.match(device, /\[100, 101, 102, 103, 109\]\.includes\(taskOpcode\)/);
  assert.match(garage, /_mqttTaskIntentCandidateAt/);
  assert.match(garage, /original_task_intent_capture/);
  assert.match(garage, /Number\(this\._externalStartTask\?\.o\) === 109/);
});



test('v1230 vendor-app maintenance opcode 109 is preserved even after PAUSE marks TASK status=false and restores maintenance, not mowing', async () => {
  const e = Object.create(Garage.prototype);
  let restored = null;
  Object.assign(e, {
    _externalStartRecoveryActive: true,
    _externalStartRecoveryPhase: null,
    _externalStartRecoveryStartedAt: Date.now() - 100,
    _externalStartStationWindowLost: false,
    _externalStartTask: null,
    _outbound: null,
    _missionOutside: false,
    _lineToLawnConfirmed: false,
    _closeAfterExitRequested: false,
    _dangerReleasedAfterExit: false,
    _returnGuardActive: false,
    _safeReturnInProgress: false,
    _externalReturnHandling: false,
    _spatialReturnHandling: false,
    _homeCloseArmed: false,
    _homeState: 'home',
    _returnContext: 'IDLE',
    log: () => {}, error: () => {}, safetyBlock: async () => {},
    _clearOutboundStatusTimers: () => {},
    _setExternalStartRecoveryPhase: Garage.prototype._setExternalStartRecoveryPhase,
    _nativeStationContextForExternalRecovery: () => ({ dockingState:'IN_STATION', undocking:0, locationState:0, chargingLive:true }),
    _waitForExternalRecovery: async () => ({ dockingState:'IN_STATION', undocking:0, locationState:0, chargingLive:true }),
    maintenanceRequested: async (source, fn) => { restored = source; await fn(); return true; },
    device: {
      _noteMapEditTask: () => {},
      _goToMaintenancePointGuarded: async source => { restored += ':' + source; return true; },
      _pauseButtonHoldMode: 'resume', _pauseButtonHoldUntil: Date.now()+1000, _resumeSemanticUntil: Date.now()+1000,
      _api: { startMowing: async () => { throw new Error('generic mowing must not be restored for opcode 109'); } },
    },
  });
  e.noteExternalStartTask({t:'TASK',d:{exe:true,status:false,o:109}});
  assert.equal(e._externalStartTask.o,109);
  const ok=await e._recoverExternalStartViaNativeStation('vendor_maintenance','did-1');
  assert.equal(ok,true);
  assert.equal(restored,'button_maintenance_external_recovered:external_recovered_maintenance');
});

test('v1230 mower-side map refresh uses forced I-frame request action 6:1', async () => {
  const api = Object.create(MovaApi.prototype);
  let call;
  api.sendAction = async (...args) => { call=args; return {ok:true}; };
  await api.requestMapFrame('did-1');
  assert.equal(call[0], 'did-1');
  assert.equal(call[1], 6);
  assert.equal(call[2], 1);
  assert.deepEqual(call[3], [{piid:2,value:'{"req_type":1,"frame_type":"I","force_type":1}'}]);
  const device = read('drivers/mower/device.js');
  assert.match(device, /pylon-create-accepted/);
  assert.match(device, /pylon-delete-accepted/);
  assert.match(device, /manual-hard-refresh/);
});

function cameraDevice(){return{getSetting:k=>k==='video_enabled',getData:()=>({id:'fixture'}),_mowerBinaryDiag:{dockingState:'OUT_OF_STATION'},_mowerBinaryDiagAt:Date.now(),log:()=>{},error:()=>{},getCapabilityValue:()=>null};}

test('v1230 FLV diagnostic URL keeps a dedicated VLC lease without device_camera lease', async t => {
  const source=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'video/x-flv'});res.write(Buffer.concat([header,vcfg,vkey]));});
  await new Promise(r=>source.listen(0,'127.0.0.1',r));
  const d=cameraDevice();
  const camera=new HomeyCamera(d,{openNative:async()=>`http://127.0.0.1:${source.address().port}/app.xnet/ipc.flv?action=live&channel=0&quality=high&_crypto=on`,stopNative:async()=>{},_selectRelayHost:()=> '127.0.0.1'});
  t.after(async()=>{await camera.stop().catch(()=>{});source.closeAllConnections();await new Promise(r=>source.close(r));});
  const out=await camera.diagnosticUrl(30000);
  await camera.control('stop','device_camera');
  assert.equal(camera.session.leases.has('flv_diag'),true);
  const response=await fetch(out.url);
  assert.equal(response.status,200);
  const reader=response.body.getReader(); const first=await reader.read();
  assert.equal(Buffer.from(first.value).subarray(0,3).toString(),'FLV');
  await reader.cancel().catch(()=>{});
  assert.equal(out.expiresInSeconds,30);
});

test('v1230 all three pylon editors share dark card, square buttons and high-contrast active delete', () => {
  for (const file of ['widgets/map/public/index.html','widgets/overview/public/map-editor.html','drivers/mower/repair/map_editor.html']) {
    const html=read(file);
    assert.match(html, /background:#202124; color:#f5f5f5/);
    assert.match(html, /border-radius:4px/);
    assert.match(html, /#pylon-delete-zone:not\(:disabled\) \{ background:#ff6b61; color:#171717; font-weight:700; \}/);
    assert.match(html, /button:disabled \{ opacity:1; background:#36383a !important; color:#76797c !important/);
  }
});
