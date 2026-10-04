'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('v197 keeps all three independent outbound close decisions',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  assert.match(src,/priority_1_eta_safe/);
  assert.match(src,/priority_2_line_dwell/);
  assert.match(src,/priority_3_third_crossing/);
  assert.match(src,/SAFETY_LINE_DWELL_MIN_CLEARANCE_MM = SAFETY_LINE_CLEARANCE_MM/);
  assert.match(src,/close_blocked_adjusting_active/);
  assert.match(src,/_rawDangerExitConfirmed\(\)/);
});

test('v198 keeps all three return/open routes and their hard interlocks',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  // Direct/early route.
  assert.match(src,/lawn_side_eta_sufficient_direct/);
  assert.match(src,/external_direct_return_parallel_open/);
  // Safety-line route.
  assert.match(src,/_waitAtSafetyLineUntilDoorOpenThenDock/);
  assert.match(src,/return_safety_line_wait/);
  // Maintenance route.
  assert.match(src,/lawn_side_eta_short_line_wait/);
  assert.match(src,/position_unclear_use_maintenance/);
  assert.match(src,/return_from_maintenance/);
  assert.match(src,/maintenance_point_timeout_position_unconfirmed/);
});

test('v197 departure proof cannot weaken gate-close clearance',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  assert.match(src,/SAFETY_LINE_CROSS_CONFIRM_MM = 500/);
  assert.match(src,/SAFETY_LINE_CLEARANCE_MM = 800/);
  assert.match(src,/departureLineConfirmed/);
  assert.match(src,/if \(this\._outboundPhaseProtected\(\)\) return false/);
  assert.match(src,/if \(this\.status\(\) !== 'mowing'\) return false/);
  assert.match(src,/lawnDwellMs >= SAFETY_LINE_DWELL_FALLBACK_MS/);
});

test('v197 maintenance departure handshake from v195 remains intact',()=>{
  const src=read('lib/garage/GarageSafetyEngine.js');
  assert.match(src,/MAINTENANCE_DEPARTURE_GRACE_MS = 45000/);
  assert.match(src,/MAINTENANCE_DEPARTURE_RETRY_GRACE_MS = 45000/);
  assert.match(src,/MAINTENANCE_DEPARTURE_CONFIRM_HITS = 2/);
  assert.match(src,/MAINTENANCE_MOVEMENT_START_MM = 180/);
  assert.match(src,/Wartungspunktfahrt angefordert/);
  assert.match(src,/Wartungspunktfahrt nicht gestartet/);
});

test('v197 fullscreen popup remains removed and automatic garage camera remains absent',()=>{
  for(const rel of ['widgets/camera/public/index.html','widgets/overview/public/index.html','widgets/camera/public/dashboard.js','widgets/overview/public/dashboard.js']){
    const src=read(rel);
    assert.doesNotMatch(src,/Homey\.popup|H\?\.popup|requestFullscreen|fullscreenToggle|maximizeCamera|cameraPopup=1/);
  }
  const garage=read('lib/garage/GarageSafetyEngine.js');
  assert.doesNotMatch(garage,/startVideo|camera.*departure|camera.*return/i);
});
