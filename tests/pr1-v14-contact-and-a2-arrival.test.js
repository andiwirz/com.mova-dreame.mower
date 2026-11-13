'use strict';
const assert = require('node:assert/strict');
const {hasLatchedOpenContact} = require('../lib/garage/DoorContactStateProof');
const valid={sensorEnabled:true,liveOpenAt:100,contactState:'open',stableOpen:true,sensorOnline:true,lastClosedAt:0,movementTimeoutAt:0};
assert.equal(hasLatchedOpenContact(valid),true,'open latch must persist without repeat events');
for(const [field,value] of Object.entries({sensorEnabled:false,liveOpenAt:0,contactState:'closed',stableOpen:false,sensorOnline:false,lastClosedAt:101,movementTimeoutAt:102}))
  assert.equal(hasLatchedOpenContact({...valid,[field]:value}),false,field);
const fs=require('fs');
const path=require('path');
const text=fs.readFileSync(path.join(__dirname,'../lib/garage/NativeAdditionalMaintenanceEvidence.js'),'utf8');
assert.match(text,/devStatusIsMoving\(this\.device\)/);
assert.match(text,/pending\.sawTransit = true/);
console.log('PASS: persistent two-state contact and observed native transit guards');
