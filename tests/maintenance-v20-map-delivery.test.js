'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {MaintenancePointCoordinator} = require('../lib/garage/MaintenancePointCoordinator');

test('API register: stored P2 is returned on selected map without any prior widget cache', async () => {
  const register = {'0': {'2': {index:2,mapIndex:0,x:-5880,y:-7470,source:'operator_associated_native_task109_code75_stable',confirmedAt:Date.now(),mapHash:''}}};
  const device = {_activeMapIndex:0,_cachedMapData:{mowingAreas:[{id:1}]}, getStoreValue:async key => key==='native_additional_maintenance_points_v1' ? register : {}, getSetting:()=>false,
    _api:{getMAPI:async()=>null}, homey:{i18n:{getLanguage:()=> 'de'}}, hasCapability:()=>true, setCapabilityValue:async()=>{}, registerCapabilityListener:()=>{},setCapabilityOptions:async()=>{}};
  const c = new MaintenancePointCoordinator(device);
  const points=await c.visiblePoints();
  assert.equal(points.length,1);assert.equal(points[0].index,2);
  const map=await c.attachMap({boundary:{x1:-10000,y1:-10000,x2:1000,y2:1000},mowingAreas:[{id:1}]});
  assert.equal(map.maintenancePoints[0].x,-5880);
  assert.equal(map.mowingAreas[0].id,1);
});

test('Learned P2 marker stays visible after the native preflight proof has expired', async () => {
  const register={'0':{'2':{index:2,mapIndex:0,x:-5880,y:-7470,source:'operator_associated_native_task109_code75_stable',confirmedAt:Date.now()-40*60000,mapHash:''}}};
  const device={_activeMapIndex:0, _cachedMAPI:null, getStoreValue:async key => key==='native_additional_maintenance_points_v1'?register:{},
    _api:{getMAPI:async()=>null},getSetting:()=>false,hasCapability:()=>true,setCapabilityValue:async()=>{},registerCapabilityListener:()=>{},setCapabilityOptions:async()=>{},homey:{i18n:{getLanguage:()=> 'de'}}};
  const c=new MaintenancePointCoordinator(device);
  const points=await c.visiblePoints();
  assert.equal(points.length,1); assert.equal(points[0].confirmed,true);
  const repair=await c.repairPointState(2);
  assert.equal(repair.hasPosition,true); assert.equal(repair.confirmed,true);
});

test('Widget: P2-P5 are part of viewBox and remain visible independently of the garage overlay', () => {
  const code=fs.readFileSync(path.resolve(__dirname,'../widgets/map/public/index.html'),'utf8');
  assert.match(code,/if \(showMaintenancePoint && Array\.isArray\(data\.maintenancePoints\)\) \{[\s\S]*?featureMinX = Math\.min\(featureMinX, extraX/);
  assert.match(code,/if \(showMaintenancePoint && Array\.isArray\(data\.maintenancePoints\)\) \{[\s\S]*?var no = Number\(v\.index\)/);
  assert.match(code,/if \(!Array\.isArray\(incoming\.maintenancePoints\)\) merged\.maintenancePoints/);
});

test('Repair: verified learnedAt and complete language feedback follow successful original-app learning', () => {
  const html=fs.readFileSync(path.resolve(__dirname,'../drivers/mower/repair/maintenance_settings.html'),'utf8');
  assert.match(html,/state\?\.confirmed===true && state\.hasPosition===true/);
  assert.match(html,/Number\(state\.learnedAt\)>Number\(baselineAt\|\|0\)/);
  assert.match(html,/Sie können dieses Fenster jetzt schließen/);
  assert.match(html,/You can now close this window/);
});
