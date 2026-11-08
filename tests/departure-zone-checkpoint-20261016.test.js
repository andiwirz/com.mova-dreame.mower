'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const old=Module._load;
let Device;
try {
  Module._load=function(name,parent,main){if(name==='homey')return {Device:class{}};if(name==='mqtt')return {};return old.call(this,name,parent,main);};
  Device=require('../drivers/mower/device.js');
} finally {Module._load=old;}
const Garage=require('../lib/garage/GarageSafetyEngine.js');
function mockDevice(mode='return',exists=true){
  const d=Object.create(Device.prototype);
  d._activeMapIndex=0;d._cachedMapData={forbiddenAreas:exists?[[102,{points:[[0,0],[1,0],[1,1]],type:2}]]:[],directMapdGeometryVerified:true};
  d._nativeZonePoliciesCache={p:{mapIndex:0,nativeId:102,lifecycle:mode,lifecycleSuspended:!exists}};
  d._obstacleRulesCache={};d._nativeZonePolicyCurrentEntry=(p,map)=>map?.forbiddenAreas?.length?{id:102,area:map.forbiddenAreas[0][1]}:null;
  d._nativeZonePolicyGeometry=()=>({pointsMm:[[0,0],[1000,0],[1000,1000]]});
  d.log=()=>{};return d;
}
function mockGarage(d){
  const g=Object.create(Garage.prototype);const log=[];
  g.device=d;g._commandToken=7;g._manualGateStopped=false;g._outbound=null;
  g.isDockedHomeStatus=()=>true;g.refreshTileStatus=async reason=>log.push('TILE '+reason);
  g._timeline=(msg,key)=>log.push('TIMELINE '+key);
  g._text=de=>de;g.log=(...a)=>log.push(a.join(' '));
  return {g,log};
}
test('mowing-only zones are already required while docked and throughout departure, not after undock',()=>{
 const d=mockDevice('mowing',false);const p=d._nativeZonePoliciesCache.p;
 assert.equal(d._pylonLifecycleDesiredActive(p,'departure_ready'),true);
 assert.equal(d._pylonLifecycleDesiredActive(p,'departure'),true);
 assert.equal(d._pylonLifecycleDesiredActive(p,'mowing'),true);
 assert.equal(d._pylonLifecycleDesiredActive(p,'return'),false);
 assert.ok(d._departureProtectionUnresolved('departure').length);
});
test('mowing+return protections are also armed at home and do not get removed for departure',()=>{
 const d=mockDevice('mowing_return');const p=d._nativeZonePoliciesCache.p;
 for(const phase of ['departure_ready','departure','mowing','return'])
  assert.equal(d._pylonLifecycleDesiredActive(p,phase),true);
 assert.deepEqual(d._departureZoneRemovalCandidates(),[]);
});
test('permanent zones never cause a departure edit or waiting', async()=>{
 const d=mockDevice('permanent'); const {g,log}=mockGarage(d);
 d._syncPylonLifecyclePhase=async()=>{throw Error('must not write');};
 assert.deepEqual(d._departureZoneRemovalCandidates(),[]);
 assert.deepEqual(await g._prepareDepartureZoneCheckpoint(7),{needed:false,verified:true});
 assert.deepEqual(log,[]);
});
test('departure-only deletion is attempted while still docked and verified by direct map readback',async()=>{
 const d=mockDevice('return');const {g,log}=mockGarage(d);let verified=false;
 d._syncPylonLifecyclePhase=async(phase,opts)=>{assert.equal(phase,'departure');assert.equal(opts.requireRequestedPhase,true);assert.ok(opts.returnDeadlineAt>Date.now());assert.equal(g.isDockedHomeStatus(),true);log.push('DELETE');return {ok:true,unverified:true};};
 d._verifyReturnZoneRemoval=async()=>{verified=true;log.push('MAPD');return true;};
 const result=await g._prepareDepartureZoneCheckpoint(7);
 assert.equal(result.verified,true);assert.equal(verified,true);
 assert.ok(log.indexOf('DELETE')<log.indexOf('MAPD'));
 assert.ok(log.some(x=>x.includes('Sperrzonen ausblenden')));
 assert.equal(g._zoneSyncUiPhase,null);
});
test('unconfirmed delete falls back after bounded checkpoint but never claims zone removed',async()=>{
 const d=mockDevice('return');const {g,log}=mockGarage(d);
 d._syncPylonLifecyclePhase=async()=>({ok:true,unverified:true});
 d._verifyReturnZoneRemoval=async()=>false;
 const result=await g._prepareDepartureZoneCheckpoint(7);
 assert.equal(result.verified,false);
 assert.equal(d._cachedMapData.forbiddenAreas.length,1);
 assert.ok(log.some(x=>x.includes('departure:zone:mapd_unverified_fallback')));
});
test('still-missing mandatory mowing protection is never waived by deletion fallback',()=>{
 const d=mockDevice('mowing',false);
 assert.deepEqual(d._departureZoneRemovalCandidates(),[]);
 assert.ok(d._departureProtectionUnresolved('departure').includes('native:p'));
});
test('zone status overrides Home tile only while the checkpoint is active',()=>{
 const d=mockDevice();const {g}=mockGarage(d);
 g.enabled=()=>true;g._confirmedStationLockActive=()=>true;
 g._zoneSyncUiPhase='removing';assert.equal(g.getTileStatus('charging'),'garage_zone_removing');
 g._zoneSyncUiPhase='restoring';assert.equal(g.getTileStatus('charging'),'garage_zone_restoring');
 g._zoneSyncUiPhase=null;assert.equal(g.getTileStatus('charging'),'garage_home');
});

test('15-second deadline releases a failed deletion checkpoint without hanging in the station',async()=>{
 const d=mockDevice('return');const {g,log}=mockGarage(d);
 const seen=[];
 d._syncPylonLifecyclePhase=()=>new Promise(()=>{}); // manufacturer never responds
 d._verifyReturnZoneRemoval=async()=>false;
 const realSetTimeout=global.setTimeout;
 global.setTimeout=(fn,ms,...args)=>{seen.push(ms);return realSetTimeout(fn,ms>14000?0:ms,...args);};
 try {
   const result=await g._prepareDepartureZoneCheckpoint(7);
   assert.equal(result.needed,true);
   assert.equal(result.verified,false);
   assert.ok(seen.some(x=>x>14000 && x<=15000));
   assert.ok(log.some(x=>x.includes('unverified_fallback')));
 } finally {global.setTimeout=realSetTimeout;}
});
