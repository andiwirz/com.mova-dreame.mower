'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../drivers/mower/device.js'), 'utf8');
const {checkMaintenancePoint} = require('../lib/garage/MaintenancePointPreflight');
const method = source.match(/  async cmdGoToMaintenancePoint\(requestedPoint = null\) \{[\s\S]*?\n  \}\n\n  async cmdSetEfficiencyMode/);
assert(method, 'maintenance device command exists');
const body = method[0].replace(/\n\n  async cmdSetEfficiencyMode$/, '');
const handler = new Function('checkMaintenancePoint', 'ADDITIONAL_POINT_STORE', `return class {${body}}`)(checkMaintenancePoint,'native_additional_maintenance_points_v1');
(async()=>{
 const commands=[];
 const app = new handler();
 app._garageSafety={enabled:()=>false};
 app.getSetting=(k)=>k==='garage_mode_enabled'?false:null;
 app.getStoreValue=async()=>({});
 app._api={getMAPI:async()=>({d:{maintenancePoints:[{index:1,x:100,y:200},{index:2,x:300,y:400}]}})};
 app._activeMapIndex=0;
 app.getData=()=>({id:'test'});
 app.homey={__:(key)=>key};
 app.log=()=>{};
 app._emitMowerNotice=()=>{};
 app._goToMaintenancePointGuarded=async (_origin,point)=>{commands.push(point);return true};
 assert.equal(await app.cmdGoToMaintenancePoint(2),true,'confirmed native P2 is available without garage');
 await assert.rejects(()=>app.cmdGoToMaintenancePoint(4),/maintenance_point_preflight_not_configured/,
   'missing P4 is rejected before a movement command, even with garage off');
 await assert.rejects(()=>app.cmdGoToMaintenancePoint(3),/maintenance_point_preflight_not_configured/);
 assert.equal(await app.cmdGoToMaintenancePoint(null),true,'omitted point remains P1');
 assert.deepEqual(commands,[2,1]);
 app._api.getMAPI=async()=>{throw Error('offline')};
 await assert.rejects(()=>app.cmdGoToMaintenancePoint(2),/maintenance_point_preflight_unverifiable/,
   'unverifiable point cannot be sent to the mower');
 assert.deepEqual(commands,[2,1]);
 console.log('PASS: Garage OFF confirms P2-P5 before motion; missing and unverifiable targets fail closed');
})().catch(e=>{console.error(e);process.exitCode=1});
