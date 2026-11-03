'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Engine = require('../lib/garage/GarageSafetyEngine');

test('PR 1.2.0 zone 102 phase rules are independent of Garage Mode; native edits still require safe checkpoints',()=>{
  const text=fs.readFileSync(path.join(__dirname,'../drivers/mower/device.js'),'utf8');
  const first=text.indexOf('  _pylonLifecycleDesiredActive(');
  const last=text.indexOf('  async _nativeMapEditTaskIdleBeforeWrite(',first);
  assert.ok(first>=0 && last>first);
  const fn=Function("const PYLON_TIMED_LIFECYCLE_DAYS={};return ({"+text.slice(first,last).trim()+"})._pylonLifecycleDesiredActive")();
  const d = {_normalizePylonLifecycle:s=>s,getSetting:null};
  d._pylonLifecycleDesiredActive=(rule,phase)=>fn.call(d,rule,phase);
  d.getSetting = k => k === 'garage_mode_enabled' ? false : null;
  const p = {lifecycle:'departure_mowing',mapIndex:0,nativeId:102};
  for (const phase of ['departure_ready','departure','mowing']) {
    assert.equal(d._pylonLifecycleDesiredActive(p,phase),true,phase);
  }
  for (const phase of ['return','idle']) {
    assert.equal(d._pylonLifecycleDesiredActive(p,phase),false,phase);
  }
  d.getSetting = k => k === 'garage_mode_enabled';
  for (const phase of ['departure_ready','departure','mowing'])
    assert.equal(d._pylonLifecycleDesiredActive(p,phase),true,phase);
  assert.equal(d._pylonLifecycleDesiredActive(p,'return'),false);
});

test('three exit closing priorities and hard A-B clearance still exist',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
  for(const phrase of ['exit close priority 1: ETA sufficient','priority_2_line_dwell',
    'exit close priority 3: third crossing pause fallback','_pauseCloseResumeAfterExit',
    'SAFETY_LINE_DWELL_MIN_CLEARANCE_MM']) assert.ok(src.includes(phrase),phrase);
});

test('return variants retain maintenance, long ETA parallel gate and short ETA stop before gate',async()=>{
  const src=fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
  for(const phrase of ['garage half is advisory only','garage_side_of_safety_line_use_maintenance',
    'position_stale_use_maintenance','lawn_side_eta_sufficient_direct',
    'lawn_side_eta_short_line_wait','_waitAtCurrentPositionUntilDoorOpenThenDock',
    'return_far_lawn_side_stop_then_parallel','return_zone_task_ended_checkpoint',
    'return_safety_line_checkpoint']) assert.ok(src.includes(phrase),phrase);
});

test('single reversal, native pause and physical contact required before emergency P1 evacuation',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../lib/garage/GarageSafetyEngine.js'),'utf8');
  assert.ok(src.includes('context.reverseIssued = true'));
  assert.ok(src.includes('maintenance evacuation WITHHELD'));
  assert.ok(src.includes('emergency_closed_gate_maintenance_requires_supervision'));
});
