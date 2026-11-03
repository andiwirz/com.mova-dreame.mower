'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let Device, Driver;
try {
  Module._load = function(id, parent, isMain) {
    if (id === 'homey') return {Device:class{}, Driver:class{}};
    if (id === 'mqtt') return {};
    return originalLoad.call(this,id,parent,isMain);
  };
  Device = require('../drivers/mower/device');
  Driver = require('../drivers/mower/driver');
} finally { Module._load=originalLoad; }
const {STORE_KEY} = require('../lib/garage/GarageRepairSettings');
const fresh = (initial={}) => {
  const d=Object.create(Device.prototype);
  const store=new Map(Object.entries(initial));
  d.getStoreValue=k=>store.get(k)??null; // Homey returns synchronous values, including null!
  d.setStoreValue=async(k,v)=>{store.set(k,v);};
  d.getSettings=()=>({garage_open_duration_seconds:28,garage_sensor_enabled:true});
  d.getSetting=k=>k==='garage_mode_enabled'?true:d.getSettings()[k];
  d.log=()=>{};d.error=()=>{};d.homey={};
  return {d,store};
};
test('startup migration accepts native synchronous null; saves previous settings without resetting device',async()=>{
  const {d,store}=fresh();
  await assert.doesNotReject(d._initGarageRepairSettings());
  assert.equal(d._garageRepairSettings.garage_open_duration_seconds,28);
  assert.equal(d._garageRepairSettings.garage_sensor_enabled,true);
  assert.equal(store.get(STORE_KEY).version,1);
});
test('migration completes partial synchronous Store using existing values, legacy fields and readback',async()=>{
  const saved={version:1,values:{garage_open_duration_seconds:40}};
  const {d,store}=fresh({[STORE_KEY]:saved});
  let writes=0;const setter=d.setStoreValue;
  d.setStoreValue=async(k,v)=>{writes++;await setter(k,v);};
  await d._initGarageRepairSettings();
  assert.ok(writes>=2);
  assert.equal(d._garageRepairSettings.garage_open_duration_seconds,40);
  assert.equal(d._garageRepairSettings.garage_sensor_enabled,true);
  assert.equal(store.get(STORE_KEY).values.garage_open_duration_seconds,40);
});
test('onInit reaches migration stage with sync-null getStoreValue instead of throwing null.catch',async()=>{
  const {d,store}=fresh();
  d.getCapabilityValue=()=> 'idle';
  d._migrate=async()=>{throw Error('EXPECTED_MIGRATION_SENTINEL')};
  // This sentinel terminates before networking, capability registration and
  // timers. Only check the precise startup phase which previously crashed.
  await assert.rejects(d.onInit(),/EXPECTED_MIGRATION_SENTINEL/);
  assert.ok(store.has(STORE_KEY));
  assert.deepEqual(d._garageMaintenanceConfig,{primary:1,rotation:'fixed'});
});
test('Repair configuration handles native synchronous null marker diagnosis',async()=>{
  const {d}=fresh();
  await d._initGarageRepairSettings();
  d._garageMaintenanceConfig={primary:1,rotation:'fixed'};
  d._activeMapIndex=0;
  d._cachedMapData={nativeMaintenancePoints:[{index:1,x:100,y:200}]};
  d._storedAdditionalMaintenancePoints={};
  const driver=Object.create(Driver.prototype);
  const handlers=new Map(); driver.log=()=>{};driver.error=()=>{};
  const session={setHandler:(key,fn)=>handlers.set(key,fn)};
  await driver.onRepair(session,d);
  const result=await handlers.get('get_garage_repair_configuration')();
  assert.equal(result.markerDiagnosis,'');
  assert.equal(result.garageEnabled,true);
});
test('Store read failure must NEVER masquerade as missing saved data or write defaults',async()=>{
  for(const bad of [()=>{throw Error('read failed')},()=>Promise.reject(Error('read failed'))]){
    const {d}=fresh();let writes=0;
    d.getStoreValue=bad;d.setStoreValue=async()=>{writes++;};
    await assert.rejects(d._initGarageRepairSettings(),/read failed/);
    assert.equal(writes,0);
  }
});
