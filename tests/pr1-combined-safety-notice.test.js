'use strict';
const assert = require('node:assert/strict');
const { MaintenanceLearningNotice } = require('../lib/garage/MaintenanceLearningNotice');
const { allowTimedOpenRelease } = require('../lib/garage/GarageSensorReleasePolicy');
const GarageSafetyEngine = require('../lib/garage/GarageSafetyEngine');
const {returnRouteEvidence} = require('../lib/garage/ReturnDecisionEvidence');

(async () => {
  const now=Date.now();
  const lawn={known:true,side:1,distance:2800,direction:{lawnSide:1},positionTs:now};
  const clear={known:true,inside:false};
  assert.equal(returnRouteEvidence({x:1,y:2,ts:now,source:'mqtt'},lawn,clear).directEligible,true);
  assert.equal(returnRouteEvidence({x:1,y:2,ts:now-40000,source:'mqtt'},lawn,clear).directEligible,false);
  assert.equal(returnRouteEvidence({x:1,y:2,ts:now,source:'map'},lawn,clear).directEligible,false);
  assert.equal(returnRouteEvidence({x:1,y:2,ts:now,source:'mqtt'},lawn,{known:false,inside:false}).directEligible,false);
  assert.equal(allowTimedOpenRelease(true,false),false);
  assert.equal(allowTimedOpenRelease(true,true),true);
  assert.equal(allowTimedOpenRelease(false,false),true);

  let lang='de',cap=false,events=[];
  const dev={homey:{i18n:{getLanguage:()=>lang}},
    hasCapability:()=>cap,addCapability:async()=>{cap=true},
    setCapabilityValue:async(k,v)=>events.push([k,v])};
  const n=new MaintenanceLearningNotice(dev);
  assert.equal(await n.show('prepared',2),true);
  assert.match(events[0][1],/innerhalb von 15 Minuten/);
  lang='en';
  assert.equal(await n.show('observed',2),true);
  assert.match(events[1][1],/Waiting for verified arrival/);
  assert.equal(await n.show('uncertain',2),true);
  assert.match(events[2][1],/remains blocked/);
  assert.equal(await n.show('confirmed',5),true);
  assert.match(events[3][1],/verified/);
  assert.equal(await n.show('prepared',1),false);

  // Physical sensor enabled, offline: a command may open the door but may NOT
  // mark it open merely because the configured opening time has elapsed.
  const engine=Object.create(GarageSafetyEngine.prototype);
  engine.log=()=>{};
  engine._doorOpenDurationSeconds=()=>0;
  engine.device={getSetting:k=>k==='garage_sensor_enabled'};
  engine.sensorEnabled=()=>true;
  engine.sensorDoorReliable=()=>false;
  engine.requestOpen=async()=>true;
  engine.safetyWarning=async()=>true;
  engine.setDoorState=async()=>{throw Error('sensor-only mode must never set open')};
  engine._restoreSensorOnlineIfRecent=async()=>{};
  assert.equal(await engine.ensureDoorOpen('return_test'),false);

  // Configured sensor absent: legacy time-only mode remains, explicitly distinct.
  engine.sensorEnabled=()=>false;
  engine.sensorDoorReliable=()=>false;
  engine.setDoorState=async()=>{};
  engine.clearSafety=async()=>{};
  engine._trigger=()=>{};
  assert.equal(await engine.ensureDoorOpen('legacy_no_sensor_test'),true);
  console.log('PASS: independent DE/EN learning display, P1 guard, sensor fail-closed, legacy mode');
})().catch(e=>{console.error(e);process.exitCode=1});
