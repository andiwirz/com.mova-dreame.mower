'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const compose = JSON.parse(fs.readFileSync(path.join(root,'drivers/mower/driver.compose.json'),'utf8'));
const generated = JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'));
const driver = generated.drivers.find(x=>x.id==='mower');
for(const settings of [compose.settings,driver.settings]){
 assert(!settings.some(g=>g.label?.en==='Maintenance points'), 'no duplicate visible maintenance settings group');
 const ids=settings.flatMap(g=>g.children||[]).map(c=>c.id);
 for(let i=2;i<=5;i++) assert(!ids.includes(`maintenance_point_${i}_name`), 'P2-P5 not exposed in device settings');
}
const src=fs.readFileSync(path.join(root,'drivers/mower/driver.js'),'utf8');
const Base=class{};
const MowerDriver=vm.runInNewContext(src.replace("module.exports = MowerDriver;",'MowerDriver;'),{require:(p)=>p==='homey'?{Driver:Base}:class{},module:{exports:{}},console});
(async()=>{
 const instance=new MowerDriver(),handlers={},changes=[],store={},sync=[];
 const device={
   getStoreValue:async(key)=>store[key]||null,
   setStoreValue:async(key,value)=>{changes.push([key,value]);store[key]=value;},
   _additionalMaintenanceEvidence:{reloadNames:async()=>sync.push('reload')},
 };
 await instance.onRepair({setHandler:(key,fn)=>{handlers[key]=fn;}},device);
 assert.equal(typeof handlers.login,'function','old reauth handler intact');
 assert.equal(typeof handlers.repair_credentials,'function','old repair credentials handler intact');
 assert.equal((await handlers.get_maintenance_settings()).maintenance_point_2_name,'');
 await handlers.save_maintenance_settings({maintenance_point_2_name:'  Neu  ',maintenance_point_4_name:'Vier',garage_mode_enabled:false});
 assert.equal(changes.length,1,'persist only one names object');
 assert.equal(changes[0][0],'maintenance_point_names_v1');
 assert.equal(changes[0][1].maintenance_point_2_name,'Neu');
 assert.equal(changes[0][1].maintenance_point_3_name,'','unset names empty');
 assert.equal(changes[0][1].maintenance_point_4_name,'Vier');
 assert.equal((await handlers.get_maintenance_settings()).maintenance_point_2_name,'Neu');
 assert.deepEqual(sync,['reload'],'buttons refreshed after store update');
 await assert.rejects(handlers.save_maintenance_settings({maintenance_point_2_name:42}),/Invalid name/);
 await assert.rejects(handlers.save_maintenance_settings({maintenance_point_2_name:'x'.repeat(81)}),/Invalid name/);
 assert.equal(changes.length,1,'rejected edits do not alter store');
 const repairViews=compose.repair.map(x=>x.id);
 assert.deepEqual(repairViews,['repair','reauth','maintenance_settings']);
 assert.deepEqual(driver.repair.map(x=>x.id),repairViews,'generated manifest matches compose');
 const home=fs.readFileSync(path.join(root,'drivers/mower/repair/repair.html'),'utf8');
 const maintenance=fs.readFileSync(path.join(root,'drivers/mower/repair/maintenance_settings.html'),'utf8');
 const reauth=fs.readFileSync(path.join(root,'drivers/mower/repair/reauth.html'),'utf8');
 assert(home.includes('data-repair-view="reauth"') && home.includes('data-repair-view="maintenance_settings"'));
 for(const html of [home,maintenance,reauth]){
   assert(html.includes('lang-de')&&html.includes('lang-en'),'DE/EN toggle in all views');
   const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
   assert(script,'view JavaScript exists'); new vm.Script(script);
 }
 assert(maintenance.includes('point-select')&&maintenance.includes('id="points"'),'CORE-like P1-P5 overview');
 assert(maintenance.includes('id="back"')&&maintenance.includes('id="save"'),'back and save-and-close controls');
 assert(maintenance.includes('data-repair-view="repair"'),'back to repair landing');
 assert(maintenance.includes("emitReply('save_maintenance_settings',names)"),'save uses callback acknowledgement');
 assert(maintenance.includes("emitReply('get_maintenance_settings',{})"),'save verifies persisted state');
 assert(!maintenance.includes('id="primary"') && !maintenance.includes('id="map-select"'),'no rotation or multi-map editor');
 assert(reauth.includes("emitReply('repair_credentials',{})"),'authentication repair remains available');
 console.log('PASS: separate repair views, callback save verification, store, authentication and bilingual UI');
})().catch(e=>{console.error(e);process.exitCode=1;});
