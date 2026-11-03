'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Module=require('node:module');
const root=path.join(__dirname,'..');
const { CATALOG,FIELDS,STORE_KEY,defaults,validate }=require('../lib/garage/GarageRepairSettings');
const { availableGarageMaintenancePointIndexes }=require('../lib/garage/MaintenancePointResolver');
let MowerDevice;
const load=Module._load;
try {
 Module._load=function(id,parent,isMain){if(id==='homey')return {Device:class{}};if(id==='mqtt')return {};return load.call(this,id,parent,isMain)};
 MowerDevice=require('../drivers/mower/device');
} finally {Module._load=load;}
function fixture(legacy={},mode=true){
 const d=Object.create(MowerDevice.prototype),store=new Map(),writes=[],hooks=[];
 d.getSettings=()=>({...legacy});
 d.getSetting=k=>k==='garage_mode_enabled'?mode:legacy[k];
 d.getStoreValue=async k=>store.get(k)??null;
 d.setStoreValue=async(k,v)=>{store.set(k,v);writes.push({k,v})};
 d.setSettings=async()=>{throw Error('Removed native Advanced Settings keys must NEVER be written')};
 d.log=()=>{};d.homey={i18n:{getLanguage:()=> 'de'}};
 d._garageSafety={isReturnCycleActive:()=>false, doorState:()=> 'closed',_emergencyHoldActive:()=>false,
  onSettings:async(a,b)=>hooks.push({a,b})};
 d._scheduleMapCameraImageUpdate=()=>{};
 d._syncAdditionalMaintenancePointCapabilities=async()=>{};
 d._syncPrimaryMaintenancePointCapability=async()=>{};
 return {d,store,writes,hooks};
}
test('Garage Advanced Settings contain ONLY main switch and link to Repair, camera consent remains native',()=>{
 const manifest=require('../drivers/mower/driver.compose.json');
 const group=manifest.settings.find(x=>x.label?.en==='Garage Safety');
 assert.deepEqual(group.children.map(c=>c.id),['garage_mode_enabled']);
 assert.match(group.children[0].hint.en,/Repair/);
 assert.match(group.children[0].hint.de,/Reparieren/);
 const native=manifest.settings.flatMap(x=>x.children||[]).map(x=>x.id);
 for(const k of Object.keys(FIELDS))assert.ok(!native.includes(k),'moved field '+k);
 for(const k of ['garage_primary_point','garage_point_rotation','garage_reset_markers','garage_marker_diagnosis'])assert.ok(!native.includes(k),k);
 const video=manifest.settings.find(x=>x.label?.en==='Live Video');
 if(video)assert.deepEqual(video.children.map(c=>c.id),['video_enabled','video_privacy_acknowledged']);
 else assert.equal(native.includes('video_enabled'),false);
 assert.deepEqual(require('../app.json').drivers[0].settings,manifest.settings);
 assert.deepEqual(require('../app.json').drivers[0].repair,manifest.repair);
});
test('All Repair field labels, hint/option labels and group headings are translated in both languages',()=>{
 for(const g of CATALOG.groups){assert.ok(g.label.en&&g.label.de);for(const key of g.keys){
  const f=FIELDS[key]; assert.ok(f,key);assert.ok(f.label.en&&f.label.de,key);
  if(f.hint)assert.ok(f.hint.en&&f.hint.de,key);
  for(const option of f.values||[])assert.ok(option.label.en&&option.label.de,key);
 }}
});
test('Repair numeric/dropdown fields reject out-of-range, incorrect and fractional-step values',()=>{
 assert.deepEqual(validate(defaults()),defaults());
 assert.throws(()=>validate({garage_danger_radius_mm:750}),/Invalid number/);
 assert.throws(()=>validate({garage_danger_radius_mm:10001}),/Invalid number/);
 assert.throws(()=>validate({garage_mower_speed_value:1.24}),/Invalid number/);
 assert.throws(()=>validate({garage_sensor_enabled:'yes'}),/Expected boolean/);
 assert.throws(()=>validate({garage_speed_source:'unapproved'}),/Invalid option/);
 assert.throws(()=>validate({fake_setting:1}),/Unknown garage setting/);
});
test('First boot migrates existing 1.2.3 values and names instead of silently resetting to defaults',async()=>{
 const {d,store}=fixture({garage_sensor_enabled:true,garage_open_duration_seconds:25,garage_danger_radius_mm:2000,maintenance_point_2_name:'Back lawn'});
 await d._initGarageRepairSettings();
 assert.equal(d._getGarageManagedSetting('garage_sensor_enabled'),true);
 assert.equal(d._getGarageManagedSetting('garage_open_duration_seconds'),25);
 assert.equal(d._getGarageManagedSetting('garage_danger_radius_mm'),2000);
 assert.equal(d._getGarageManagedSetting('maintenance_point_2_name'),'Back lawn');
 assert.equal(store.get(STORE_KEY).version,1);
 assert.equal(store.get(STORE_KEY).values.garage_open_duration_seconds,25);
});
test('Restart preserves authoritative Repair Store despite stale legacy Advanced Settings values',async()=>{
 const {d,store,writes}=fixture({garage_open_duration_seconds:10});
 store.set(STORE_KEY,{version:1,values:{garage_open_duration_seconds:37}});
 await d._initGarageRepairSettings();
 assert.equal(d._getGarageManagedSetting('garage_open_duration_seconds'),37);
 assert.ok(writes.length>0,'Partial Repair Store is completed using preserved old fields');
 assert.equal(store.get(STORE_KEY).values.garage_open_duration_seconds,37);
});
test('Invalid legacy values are migrated conservatively to defaults',async()=>{
 const {d}=fixture({garage_danger_radius_mm:-123,garage_sensor_enabled:'not-a-boolean'});
 await d._initGarageRepairSettings();
 assert.equal(d._getGarageManagedSetting('garage_danger_radius_mm'),FIELDS.garage_danger_radius_mm.value);
 assert.equal(d._getGarageManagedSetting('garage_sensor_enabled'),false);
});
test('Repair save persists atomically in Store without writing removed Advanced keys',async()=>{
 const {d,store}=fixture();await d._initGarageRepairSettings();
 const result=await d.saveGarageRepairConfiguration({garage_sensor_enabled:true,garage_open_duration_seconds:25});
 assert.equal(result.ok,true);
 assert.equal(store.get(STORE_KEY).values.garage_sensor_enabled,true);
 assert.equal(store.get(STORE_KEY).values.garage_open_duration_seconds,25);
});
test('Sensor mode change triggers existing Garage Safety hook',async()=>{
 const {d,hooks}=fixture();await d._initGarageRepairSettings();
 await d.saveGarageRepairConfiguration({garage_sensor_enabled:true});
 assert.equal(hooks.length,1);
 assert.deepEqual(hooks[0].b,['garage_sensor_enabled']);
 assert.equal(hooks[0].a.garage_sensor_enabled,true);
});
test('Disabling garage logging also disables verbose logging to respect dependency',async()=>{
 const {d}=fixture({garage_logging_enabled:true,garage_debug_verbose:true});
 await d._initGarageRepairSettings();
 await d.saveGarageRepairConfiguration({garage_logging_enabled:false});
 assert.equal(d._getGarageManagedSetting('garage_logging_enabled'),false);
 assert.equal(d._getGarageManagedSetting('garage_debug_verbose'),false);
});
test('Repair edits are blocked with Garage Mode disabled, on return or during Emergency',async()=>{
 const off=fixture({},false);await off.d._initGarageRepairSettings();
 await assert.rejects(off.d.saveGarageRepairConfiguration({garage_sensor_enabled:true}),/Garage Mode is disabled/);
 const busy=fixture();await busy.d._initGarageRepairSettings();
 busy.d._garageSafety.isReturnCycleActive=()=>true;
 await assert.rejects(busy.d.saveGarageRepairConfiguration({garage_sensor_enabled:true}),/mission active/);
 busy.d._garageSafety.isReturnCycleActive=()=>false;busy.d._garageSafety._emergencyHoldActive=()=>true;
 await assert.rejects(busy.d.saveGarageRepairConfiguration({garage_sensor_enabled:true}),/mission active/);
 busy.d._garageSafety._emergencyHoldActive=()=>false;busy.d._garageSafety.doorState=()=> 'closing';
 await assert.rejects(busy.d.saveGarageRepairConfiguration({garage_sensor_enabled:true}),/mission active/);
});
test('Removing Garage Mode while gate is moving or Emergency is active is rejected BEFORE state changes',async()=>{
 const {d}=fixture();d._garageSafety.doorState=()=> 'opening';
 await assert.rejects(d.onSettings({changedKeys:['garage_mode_enabled'],newSettings:{garage_mode_enabled:false},oldSettings:{garage_mode_enabled:true}}),/Garagenmodus/);
});
test('Primary waypoint resolver sees point names migrated into Repair Store',async()=>{
 const {d}=fixture();await d._initGarageRepairSettings();
 d._activeMapIndex=0;d._cachedMapData={nativeMaintenancePoints:[{index:1,x:0,y:0},{index:2,x:500,y:500}]};
 d._storedAdditionalMaintenancePoints={};
 assert.deepEqual(availableGarageMaintenancePointIndexes(d),[1,2]);
 await d.saveGarageRepairConfiguration({maintenance_point_2_name:''});
 assert.deepEqual(availableGarageMaintenancePointIndexes(d),[1]);
 await d.saveGarageRepairConfiguration({maintenance_point_2_name:'Garden north'});
 assert.deepEqual(availableGarageMaintenancePointIndexes(d),[1,2]);
});
test('Current main waypoint is always displayed in Garage Mode; visibility toggles do not disable safety geometry',()=>{
 const src=fs.readFileSync(path.join(root,'drivers/mower/device.js'),'utf8');
 assert.match(src,/const showMaintenancePoint = true;/);
 assert.match(src,/_getGarageManagedSetting\('garage_show_safety_line'\)===false/);
 assert.match(src,/_getGarageManagedSetting\('garage_show_danger_area'\)===false/);
 const engine=fs.readFileSync(path.join(root,'lib/garage/GarageMarkerEngine.js'),'utf8');
 assert.match(engine,/_garageOption\('garage_danger_radius_mm'\)/);
});
test('Conditional garage Repair view exists, is parsable, has safe input dependencies and no camera controls',()=>{
 const manifest=require('../drivers/mower/driver.compose.json');
 assert.ok(manifest.repair.some(x=>x.id==='garage_settings'));
 const ui=fs.readFileSync(path.join(root,'drivers/mower/repair/garage_settings.html'),'utf8');
 const js=ui.match(/<script>([\s\S]*?)<\/script>/)[1];
 assert.doesNotThrow(()=>new vm.Script(js));
 for(const x of ['garage_sensor_min_battery','garage_mower_speed_value','garage_debug_verbose','point-rotation','point-save'])assert.ok(ui.includes(x),x);
 assert.ok(!ui.includes('garage_sensor_watchdog_minutes'), 'obsolete watchdog must not be rendered as an active option');
 for(const x of ['get_garage_repair_configuration','save_garage_repair_configuration','reset_garage_markers','save_maintenance_point_config'])assert.ok(ui.includes(x),x);
 assert.doesNotMatch(ui,/video_enabled|video_privacy_acknowledged/);
 const main=fs.readFileSync(path.join(root,'drivers/mower/repair/repair.html'),'utf8');
 assert.match(main,/Homey.showView\('garage_settings'\)/);
 assert.match(main,/id="maintenance-config" onclick="Homey.showView\('maintenance_settings'\)"/);
 const points=fs.readFileSync(path.join(root,'drivers/mower/repair/maintenance_settings.html'),'utf8');
 for(const x of ['id="name"','id="primary"','get_maintenance_point_config','save_maintenance_point_name'])assert.ok(points.includes(x),x);
});
test('Sensor activation failure rolls back Store and active configuration',async()=>{
 const {d,store}=fixture();await d._initGarageRepairSettings();
 let attempts=0;
 d._garageSafety.onSettings=async()=>{attempts++;if(attempts===1)throw Error('sensor hook failed');};
 await assert.rejects(d.saveGarageRepairConfiguration({garage_sensor_enabled:true}),/sensor hook failed/);
 assert.equal(d._getGarageManagedSetting('garage_sensor_enabled'),false);
 assert.equal(store.get(STORE_KEY).values.garage_sensor_enabled,false);
 assert.equal(attempts,2,'best-effort hardware rollback was attempted');
});
test('Safety marker reset requires physical dock proof, not idle outside',async()=>{
 const {d}=fixture();let cleared=0;
 d._garageSafety.isDockedHomeStatus=()=>true;
 d._garageSafety._freshNativeDockState=()=>({dockingState:'OUT_OF_STATION'});
 d._garageSafety.resetMarkers=async()=>{cleared++};
 await assert.rejects(d.resetGarageMarkersFromRepair(),/physical docking/);
 assert.equal(cleared,0);
 d._garageSafety._freshNativeDockState=()=>({dockingState:'IN_STATION'});
 await d.resetGarageMarkersFromRepair();
 assert.equal(cleared,1);
});
