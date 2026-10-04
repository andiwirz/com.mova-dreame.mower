'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const MovaApi = require('../lib/MovaApi');

const read = p => fs.readFileSync(p, 'utf8');

test('map edit transaction waits for each matching mower TASK opcode before sending the next edit leg', async () => {
  const api = new MovaApi({ log: () => {} });
  const events = [];
  api.sendAction = async (_did,_s,_a,input) => { events.push('send:'+input[0].o); return { result:{ out:[{ r:0 }] } }; };
  const waitForTask = async (opcode) => { events.push('task:'+opcode); return {t:'TASK',d:{o:opcode,exe:true,status:false}}; };
  const result = await api.runMapEditTransaction('d',0,{m:'a',p:0,o:215,d:{id:-1,type:2,points:[[0,0],[1,0],[1,1],[0,1]],radius:0}}, { waitForTask });
  assert.equal(result.ok,true);
  assert.deepEqual(events,['send:200','task:200','send:204','task:204','send:215','task:215','send:201','task:201']);
  assert.ok(result.legs.every(leg => leg.taskAck === true));
});

test('map edit TASK waiter is isolated from the protected MQTT/garage start classifier', () => {
  const api = read('lib/MovaApi.js');
  const device = read('drivers/mower/device.js');
  const garage = read('lib/garage/GarageSafetyEngine.js');
  assert.match(api, /waitForTask/);
  assert.match(device, /_waitForMapEditTask/);
  assert.match(garage, /this\.device\?\._noteMapEditTask\?\.\(value\)/);
});

test('current pylon Reload gets the cancellable countdown; explicit Save closes immediately after backend acceptance', () => {
  for (const file of ['drivers/mower/repair/map_editor.html','widgets/map/public/index.html','widgets/overview/public/map-editor.html']) {
    const s = read(file);
    const reloadStart = s.indexOf('function reloadSelectedPylon()');
    const saveStart = s.indexOf('function savePylonRule(mode)', reloadStart);
    const reload = s.slice(reloadStart, saveStart);
    const save = s.slice(saveStart, s.indexOf('// ── Entry point', saveStart) >= 0 ? s.indexOf('// ── Entry point', saveStart) : s.length);
    assert.match(reload,/startPylonAutoClose\(feedback\.textContent\)/,file);
    assert.match(reload,/_pylonReloadDone = true/,file);
    assert.match(save,/finishPylonEditorAfterSave\(\)/,file);
    assert.doesNotMatch(save,/startPylonAutoClose\(/,file);
  }
  const device = read('drivers/mower/device.js');
  assert.match(device,/const deadlines = \[2000, 5000, 15000, 35000, 75000, 120000, 150000, 180000,[\s\S]{0,80}210000, 240000, 270000, 300000, 330000, 360000, 420000, PYLON_PENDING_TIMEOUT_MS\]/);
});

test('native turning sync keeps laggy SETTINGS diagnostic-only and does not mirror into Advanced Settings', () => {
  const s = read('drivers/mower/device.js');
  const start = s.indexOf("if (s.steeringMode != null");
  const end = s.indexOf("if (Object.keys(update).length", start);
  const block = s.slice(start,end);
  assert.match(block,/_lastSettingsSteeringMode/);
  assert.doesNotMatch(block,/_setCap\('turning_method'/);
  assert.doesNotMatch(block,/setSettings\(\{ map_safe_turning/);
  assert.doesNotMatch(block,/writePRE|writeSETTINGSField/);
});

test('1.2.18 pending ring is present in both SVG editor and static overview renderer', () => {
  const png = read('lib/widgets/MapPngRenderer.js');
  assert.match(png,/ob\?\.rule\?\.pending/);
  assert.match(png,/#42a5f5/);
  for (const file of ['drivers/mower/repair/map_editor.html','widgets/map/public/index.html','widgets/overview/public/map-editor.html']) {
    const s = read(file);
    assert.match(s,/livePylon\.rule = result\.rule/,file);
    assert.match(s,/pylon-pending-ring/,file);
  }
});
