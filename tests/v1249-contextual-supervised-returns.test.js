'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const widget=require('../lib/widgets/MowerDashboard');
const visibility=require('../widgets/overview/public/recovery-visibility');
function makeDevice(extra={}) {
  const commands=[];
  const rescue={
    enabled:()=>true,paused:false,_manualRecoveryActive:false,
    _manualGateStopped:false,_emergencyGateContext:null,_emergencyHoldActive:()=>false,
    _confirmedStationLockActive:()=>false,_commandToken:7,
    _returnRecoveryHold:{terminal:true,stopped:true,reason:'return_release_not_verified'},
    doorState:()=> 'open',status:()=> 'mowing',
    isMissionOutside:()=>true,
    isReturnCycleActive:()=>true,
    markers:{rawDangerState:async()=>({known:true,inside:false,distance:4800,radius:900})},
    _readNativeStationaryPositionForGarage:async(token,baseline)=>({...baseline,ts:Date.now()}),
  };
  Object.assign(rescue,extra.rescue||{});
  const device={
    getId:()=> 'unit',getData:()=>({id:'unit'}),getSetting:()=>true,
    _api:{getMowerPosition:async()=>({x:-3000,y:-4600})},
    _garageSafety:rescue,
    triggerCapabilityListener:async(cap)=>{commands.push(cap);},
  };
  Object.assign(device,extra.device||{});
  const homey={i18n:{getLanguage:()=> 'en'},drivers:{getDriver:()=>({getDevices:()=>[device]})}};
  return {device,rescue,commands,homey};
}
const issue=async(s,action,supervised=true)=>widget.command({homey:s.homey,query:{deviceId:'unit'},body:{action,supervised}});

test('normal automatic mowing shows no contextual recovery panel',()=>{
  assert.equal(visibility.forOverview({garageEnabled:true,status:'mowing',mission:'mowing'}).contextualReturn,false);
  assert.equal(visibility.forOverview({garageEnabled:true,status:'returning',mission:'return'}).contextualReturn,false);
  assert.equal(visibility.forOverview({garageEnabled:true,returnHoldTerminal:true,status:'mowing'}).contextualReturn,true);
  assert.equal(visibility.forOverview({garageEnabled:true,returnHoldStopped:true,status:'mowing'}).contextualReturn,true);
  assert.equal(visibility.forOverview({garageEnabled:true,manualRecovery:true,status:'paused',garagePaused:true}).contextualReturn,true);
  assert.equal(visibility.forOverview({garageEnabled:true,garagePaused:true,status:'paused',mission:'return'}).contextualReturn,true);
});

test('verified-position return requires operator confirmation; a rejected check moves nothing',async()=>{
  const s=makeDevice();
  await assert.rejects(issue(s,'context_return_checked',false),/Check the mower position/);
  assert.deepEqual(s.commands,[]);
  s.rescue._readNativeStationaryPositionForGarage=async()=>null;
  await assert.rejects(issue(s,'context_return_checked'),/Position check failed/);
  assert.deepEqual(s.commands,[]);
});

test('terminal return hold dispatches existing guarded dock capability only after native stationary proof',async()=>{
  const s=makeDevice();
  const r=await issue(s,'context_return_checked');
  assert.equal(r.positionVerified,true);
  assert.deepEqual(s.commands,['cmd_dock']);
  assert.equal(s.rescue._commandToken,7,'read-only precheck must not alter movement owner token');
  assert.equal(r.requested,true,'command queued but not claimed as physical movement');
});

test('maintenance recovery uses existing guarded maintenance capability',async()=>{
  const s=makeDevice();
  const r=await issue(s,'context_maintenance_checked');
  assert.equal(r.positionVerified,true);
  assert.deepEqual(s.commands,['cmd_maintenance_point']);
});

test('unsafe gates, physical clearance, paused automation and active navigation each deny motor commands',async()=>{
  for (const config of [
    {doorState:()=> 'opening'},
    {_manualGateStopped:true},
    {paused:true},
    {_emergencyGateContext:{}},
    {_maintenanceJourneyOwnsNavigation:()=>true},
    {markers:{rawDangerState:async()=>({known:true,inside:true,distance:20,radius:900})}},
    {markers:{rawDangerState:async()=>({known:false,inside:false})}},
  ]) {
    const s=makeDevice({rescue:config});
    await assert.rejects(issue(s,'context_return_checked'));
    assert.deepEqual(s.commands,[],JSON.stringify(Object.keys(config)));
  }
});

test('terminal stop not acknowledged and stale mowing status cannot be used as stationary proof',async()=>{
  const s=makeDevice({rescue:{_returnRecoveryHold:{terminal:true,stopped:false},status:()=> 'mowing'}});
  await assert.rejects(issue(s,'context_return_checked'),/standstill not confirmed/);
  assert.deepEqual(s.commands,[]);
});

test('fresh native dock contact prevents a redundant departure/return command',async()=>{
  const s=makeDevice({device:{_mowerBinaryDiag:{dockingState:'IN_STATION',undocking:0},_mowerBinaryDiagAt:Date.now()}});
  await assert.rejects(issue(s,'context_return_checked'),/Position check failed/);
  assert.deepEqual(s.commands,[]);
});

test('active normal mission does not create competing return command',async()=>{
  const s=makeDevice({rescue:{_returnRecoveryHold:null,status:()=> 'mowing',isReturnCycleActive:()=>true}});
  await assert.rejects(issue(s,'context_return_checked'),/No stationary return problem/);
  assert.deepEqual(s.commands,[]);
});

test('emergency contextual action uses EXISTING emergency return proof (no ordinary capability bypass)',async()=>{
  const s=makeDevice({rescue:{_manualRecoveryActive:true,paused:true,manualRecoveryReturnToDock:async()=>false}});
  await assert.rejects(issue(s,'context_return_checked'),/Recovery held/);
  assert.deepEqual(s.commands,[]);
  s.rescue.manualRecoveryReturnToDock=async()=>true;
  const r=await issue(s,'context_return_checked');
  assert.equal(r.mode,'supervised_emergency');
  assert.deepEqual(s.commands,[]);
});

test('bilingual buttons live inside garage panel; no duplicate emergency confirmation action',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../widgets/overview/public/index.html'),'utf8');
  const js=fs.readFileSync(path.join(__dirname,'../widgets/overview/public/dashboard.js'),'utf8');
  assert.match(html,/id="contextualReturnActions"/);
  assert.equal((html.match(/data-action="context_return_checked"/g)||[]).length,1);
  assert.equal((html.match(/data-action="context_maintenance_checked"/g)||[]).length,1);
  assert.equal((html.match(/data-action="recovery_confirm_open"/g)||[]).length,1);
  assert.match(js,/Position prüfen & Rückkehr veranlassen/);
  assert.match(js,/Check position & request return/);
  assert.match(js,/Erst das vollständig OFFENE Tor/);
});
