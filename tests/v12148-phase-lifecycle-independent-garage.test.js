 'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
let Device;
const orig=Module._load;
try {Module._load=function(id,parent,main){if(id==='homey') return {Device:class{}};if(id==='mqtt')return {};return orig.call(this,id,parent,main)};Device=require('../drivers/mower/device');}finally{Module._load=orig;}
const sample=(garageEnabled)=>{const d=Object.create(Device.prototype);d.getSetting=k=>k==='garage_mode_enabled'?garageEnabled:null;d.getCapabilityValue=()=>d._nativeMowerStatus;d._nativeMowerStatus='mowing';return d;};
test('all 9 mission/time lifecycle modes behave consistently with gate on and off',()=>{
  const phases=['departure_ready','departure','mowing','return'];
  for(const mode of ['permanent','days_3','days_7','days_14','departure','departure_mowing','mowing','mowing_return','return']){
   const a=sample(true),b=sample(false);const rule={lifecycle:mode,lifecycleExpiresAt:Date.now()+86400000};
   for(const phase of phases)assert.equal(a._pylonLifecycleDesiredActive(rule,phase),b._pylonLifecycleDesiredActive(rule,phase),`${mode}/${phase}`);
  }
});
test('garage disabled: return-only zone is inactive while mowing and requested on return',()=>{
 const d=sample(false);d._activeMapIndex=0;d._cachedMapData={forbiddenAreas:[]};d._nativeZonePoliciesCache={};d._obstacleRulesCache={};
 assert.equal(d._pylonLifecycleDesiredActive({lifecycle:'return'},'mowing'),false);
 assert.equal(d._pylonLifecycleDesiredActive({lifecycle:'return'},'return'),true);
 assert.equal(d._pylonLifecycleDesiredActive({lifecycle:'mowing'},'return'),false);
});
test('garage disabled: a moving mower cannot trigger a native map write just because phase changed',async()=>{
 const d=sample(false);d._activeMapIndex=0;d._cachedMapData={forbiddenAreas:[]};d._nativeZonePoliciesCache={};d._obstacleRulesCache={p1:{lifecycle:'mowing',mapIndex:0,nativeId:123,hidden:false}};
 d._api={};d.log=()=>{};d._logPylonLifecycleAudit=()=>{};d._nativeZoneLifecycleLog=()=>{};d._pylonLifecycleNativeActive=()=>true;
 d._automaticNativeZoneMapWriteSafe=()=>true;
 assert.equal(d._mapEditStationary(),false);
 const result=await d._syncPylonLifecyclePhase('return',{reason:'standalone-native-return'});
 assert.equal(result.ok,false);assert.equal(result.reason,'mower_moving');
});
test('all three editors show phase options without a Garage Mode prerequisite and explain task-free preconditions',()=>{
 const root=path.resolve(__dirname,'..');for(const rel of ['drivers/mower/repair/map_editor.html','widgets/map/public/index.html','widgets/overview/public/map-editor.html']){
  const s=fs.readFileSync(path.join(root,rel),'utf8');
  for(const option of ['departure','departure_mowing','mowing','mowing_return','return'])assert.ok(s.includes(`value="${option}"`),rel+'/'+option);
  assert.ok(s.includes('Phase rules work without Garage Mode too.'),rel);
  assert.ok(s.includes('Fahrphasenregeln funktionieren auch ohne Garagenmodus.'),rel);
 }
});
