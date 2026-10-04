'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const originalLoad = Module._load;
let Device;
try {
  Module._load = function(id, parent, main) {
    if (id === 'homey') return { Device: class {} };
    if (id === 'mqtt') return {};
    return originalLoad.call(this, id, parent, main);
  };
  Device = require('../drivers/mower/device');
} finally { Module._load = originalLoad; }

const read = p => fs.readFileSync(p, 'utf8');

test('1.2.19 Total Overview editor has direct parent close callback after Save/Reload', () => {
  const parent = read('widgets/overview/public/dashboard.js');
  const child = read('widgets/overview/public/map-editor.html');
  assert.match(parent, /finishEditor:\(\)=>closeEditor\(\{refresh:true,notifyChild:false\}\)/);
  assert.match(parent, /function closeEditor\(\{refresh=true,notifyChild=true\}=\{\}\)/);
  assert.match(child, /typeof _homey\.finishEditor === 'function'/);
  assert.match(child, /setTimeout\(finishOverviewEditor, 0\)/);
});

test('map edit uses live TASK opcode acknowledgement without reusing TASK as a garage-start trigger', () => {
  const device = read('drivers/mower/device.js');
  const api = read('lib/MovaApi.js');
  const garage = read('lib/garage/GarageSafetyEngine.js');
  assert.match(device, /_waitForMapEditTask/);
  assert.match(api, /waitForTask/);
  assert.match(garage, /_noteMapEditTask/);
});

test('1.2.19 obstacle reads are suppressed while a native map edit transaction is active', async () => {
  const d = Object.create(Device.prototype);
  let calls = 0;
  d._pylonNativeWriteBusy = true;
  d._obsFetchInFlight = false;
  d._api = {
    getAIOBS: async () => { calls++; return {}; },
    getOBS: async () => { calls++; return {}; },
  };
  const result = await d._refreshObstacleTelemetry('mower', 'test');
  assert.equal(result, false);
  assert.equal(calls, 0);
});

test('confirmed Homey lawn-care write mirrors native state into the realtime picker only', async () => {
  const d = Object.create(Device.prototype);
  const settingWrites = [];
  const capWrites = [];
  let preReads = 0;
  d._activeMapIndex = 0;
  d.log = () => {}; d.error = () => {}; d.getData = () => ({ id: 'mower' });
  d.setSettings = async value => { settingWrites.push(value); };
  d.hasCapability = cap => cap === 'turning_method';
  d._setCap = async (cap, value) => { capWrites.push([cap, value]); };
  d.setStoreValue = async () => {};
  d._safeWrite = async (_label, fn) => { await fn(); return true; };
  const base = [0,0,0,1,40,1,0,1,1,1,1,1,1,15,15,7,1,1,5,0,88];
  d._api = {
    getPRE: async () => { preReads++; const out=[...base]; if(preReads>1) out[19]=1; return out; },
    writePRE: async () => ({ result:{ out:[{ status:true,r:0 }] } }),
    writeSETTINGSField: async () => ({ code:0 }),
    getSETTINGSBlob: async () => [{ settings:{ '0':{ steeringMode:1 } } }],
  };
  await d._writeTurningMethod(1,'test');
  assert.equal(settingWrites.length, 0);
  assert.deepEqual(capWrites.at(-1), ['turning_method', 'lawn_care']);
});

test('manifest exposes one realtime Wendemodus picker and removes the duplicate Advanced Settings option', () => {
  const compose = JSON.parse(read('drivers/mower/driver.compose.json'));
  const cap = JSON.parse(read('.homeycompose/capabilities/turning_method.json'));
  assert.ok(compose.capabilities.includes('turning_method'));
  assert.ok(!compose.capabilities.includes('lawn_care_mode'));
  assert.equal(cap.type, 'enum');
  assert.equal(cap.uiComponent, 'picker');
  assert.equal(cap.setable, true);
  assert.equal(cap.title.de, 'Wendemodus');
  const raw = read('drivers/mower/driver.compose.json');
  assert.doesNotMatch(raw, /"id": "map_safe_turning"/);
});
