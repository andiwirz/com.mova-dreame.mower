'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'drivers/mower/repair/garage_settings.html'),'utf8');
const repair=fs.readFileSync(path.join(root,'drivers/mower/repair/repair.html'),'utf8');
const points=fs.readFileSync(path.join(root,'drivers/mower/repair/maintenance_settings.html'),'utf8');
const engine=fs.readFileSync(path.join(root,'lib/garage/MaintenancePointResolver.js'),'utf8');
const device=fs.readFileSync(path.join(root,'drivers/mower/device.js'),'utf8');
const resolver=require('../lib/garage/MaintenancePointResolver');
const mock=(mode,names,confirmed,rotation='alternate')=>({
 getSetting:key=>key==='garage_mode_enabled'?mode:null,
 _garageMaintenanceConfig:{primary:1,rotation},
 _activeMapIndex:0,
 _cachedMapData:{nativeMaintenancePoints:[{index:1,x:100,y:200}, ...confirmed.map(i=>({index:i,x:i*100,y:i*150}))]},
 _getGarageManagedSetting:key=>names[key]||'',
});
function visible(mode,device){return mode===true&&resolver.availableGarageMaintenancePointIndexes(device).length>=2;}
test('Repair: independent maintenance menu always visible; garage entry conditional',()=>{
 assert.match(repair,/<button class="card" id="maintenance-config"/);
 assert.match(repair,/<button class="card" id="garage-config" hidden/);
 assert.match(points,/P1–P5/);
});
test('Rotation UI hidden until garage is on AND at least two confirmed named native points',()=>{
 assert.match(html,/id="garage-rotation-panel" hidden/);
 assert.match(html,/const canRotate=cfg.garageEnabled===true && choices.length>=2/);
 assert.match(html,/\$\('garage-rotation-panel'\).hidden=!canRotate/);
 assert.equal(visible(false,mock(false,{maintenance_point_2_name:'Lawn'},[2])),false);
 assert.equal(visible(true,mock(true,{maintenance_point_2_name:'Lawn'},[])),false);
 assert.equal(visible(true,mock(true,{},[2])),false);
 assert.equal(visible(true,mock(true,{maintenance_point_2_name:'Lawn'},[2])),true);
 assert.equal(visible(true,mock(true,{maintenance_point_2_name:'Lawn',maintenance_point_3_name:'Back'},[2,3])),true);
});
test('If P2 disappears, automatic rotation is suspended, even with a saved alternate preference',()=>{
 const d=mock(true,{maintenance_point_2_name:'Lawn'},[],'alternate');
 assert.deepEqual(resolver.availableGarageMaintenancePointIndexes(d),[1]);
 assert.equal(resolver.resolveMaintenancePointIndex(d),1);
 assert.equal(visible(true,d),false);
 assert.match(device,/availableGarageMaintenancePointIndexes\(this\)\.length < 2/);
 assert.match(device,/_maintenanceFlowRotationEnabled\(\)/);
});
