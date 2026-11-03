'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname,'..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');

function browserActions(){
  const mockButton = () => ({ dataset:{ action:'recovery_confirm_open' }, setAttribute(k,v){this[k]=v;} });
  const button = mockButton();
  const sandbox = {
    navigator:{language:'de'},
    document:{ addEventListener(){}, getElementById(){return null;}, querySelector(){return button;} },
    window:{ addEventListener(){}, IntersectionObserver:null, ResizeObserver:null },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('widgets/overview/public/dashboard.js')+'\nthis.__unit={actionOutcome,markButtonAction};',sandbox);
  return { ...sandbox.__unit, button };
}
test('recovery buttons confirm only fresh verified readback; undocked rearm never appears successful',()=>{
  const {actionOutcome}=browserActions();
  assert.equal(actionOutcome('recovery_confirm_open',{accepted:true},{recoveryGateConfirmed:true}).state,'confirmed');
  assert.throws(()=>actionOutcome('recovery_confirm_open',{accepted:true},{recoveryGateConfirmed:false}),/bestätigt/);
  assert.equal(actionOutcome('recovery_takeover',{accepted:true},{manualRecovery:true,garagePaused:true}).state,'confirmed');
  assert.throws(()=>actionOutcome('recovery_takeover',{accepted:true},{manualRecovery:true,garagePaused:false}),/bestätigt/);
  assert.equal(actionOutcome('recovery_rearm',{accepted:true},{manualRecovery:false,garagePaused:false}).state,'confirmed');
  assert.throws(()=>actionOutcome('recovery_rearm',{accepted:true},{manualRecovery:true,garagePaused:true}),/nicht bestätigt/);
  assert.throws(()=>actionOutcome('garage_pause',{garagePaused:true},{garagePaused:false}),/nicht bestätigt/);
  assert.throws(()=>actionOutcome('recovery_rearm',{accepted:true},null),/Statusprüfung fehlgeschlagen/);
});
test('gate motion request is never rendered as physically OPEN/CLOSED without matching true contact',()=>{
  const {actionOutcome}=browserActions();
  for(const [action,door] of [['gate_open','open'],['gate_close','closed']]){
    assert.equal(actionOutcome(action,{accepted:true},{door,sensorContact:'unknown',doorEstimated:false}).state,'requested');
    assert.equal(actionOutcome(action,{accepted:true},{door,sensorContact:door,doorEstimated:true}).state,'requested');
    assert.equal(actionOutcome(action,{accepted:true},{door,sensorContact:door,doorEstimated:false}).state,'confirmed');
  }
});
test('user can see pending, accepted, confirmed and failed states on buttons',()=>{
  const {markButtonAction,button}=browserActions();
  markButtonAction('recovery_confirm_open','pending');
  assert.equal(button.dataset.uiState,'pending');assert.equal(button['aria-busy'],'true');
  markButtonAction('recovery_confirm_open','failed');assert.equal(button['aria-busy'],'false');
  markButtonAction('recovery_confirm_open','confirmed');assert.equal(button.dataset.uiState,'confirmed');
  markButtonAction('recovery_confirm_open',null);assert.equal('uiState' in button.dataset,false);
  const css=read('widgets/overview/public/style.css');
  for(const state of ['pending','requested','confirmed','failed'])assert.match(css,new RegExp('data-ui-state="'+state+'"'));
});
test('all three full-size map surfaces display the same four mini-map info lines and preserve line breaks',()=>{
  const dashboard=read('widgets/overview/public/dashboard.js');
  const fields=['Map\'','View refreshed','Mower status','Mowing completed in Homey'];
  for(const field of fields)assert.match(dashboard,new RegExp(field));
  const files=['widgets/map/public/index.html','widgets/overview/public/map-editor.html','drivers/mower/repair/map_editor.html'];
  for(const file of files){
    const src=read(file);
    for(const field of fields)assert.match(src,new RegExp(field),file+' '+field);
    assert.match(src,/mapStatusItems\.join\('\\n'\)/,file);
    assert.match(src,/white-space:pre-wrap/,file);
  }
});
test('repair map reload distinguishes pending proof from completed native mutation and stays open',()=>{
  for(const file of ['widgets/map/public/index.html','widgets/overview/public/map-editor.html','drivers/mower/repair/map_editor.html']){
    const src=read(file);
    assert.match(src,/var nativeVerified =/);
    assert.match(src,/p\.rule\.nativeConfirmed === true/);
    assert.match(src,/if \(p\.rule && p\.rule\.pending\)/);
    assert.match(src,/_pylonReloadDone = false;\s*reloadBtn\.textContent = localizeUiText\('Erneut prüfen'\)/);
    assert.match(src,/if \(nativePending\) \{[\s\S]*?feedback\.dataset\.result = 'pending'/);
    assert.match(src,/if \(\s*[^)]*\s*\) \{\s*feedback\.dataset\.result = 'confirmed';\s*startPylonAutoClose/);
    assert.match(src,/Sperrzone gelöscht ✓/,'successful direct deletion gets explicit verification on native map absence');
    for(const m of [...src.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)])if(m[1].trim())assert.doesNotThrow(()=>new vm.Script(m[1],{filename:file}));
  }
});
