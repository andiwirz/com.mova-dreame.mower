'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const MovaApi=require('../lib/MovaApi');

const root=path.join(__dirname,'..');

test('v180 TX identity path uses Android body + video transport profile and never auto-pairs',()=>{
  const src=fs.readFileSync(path.join(root,'lib/MovaApi.js'),'utf8');
  assert.match(src,/body=did\+os\(android\)/);
  assert.match(src,/videoProfile:true/);
  assert.match(src,/Dreame-Meta/);
  assert.match(src,/Dreame-Rlc/);
  assert.match(src,/association preflight/);
  assert.doesNotMatch(src,/await this\._request\(['\"]\/dreame-third-video\/tx\/dev\/pair/);
});

test('v180 video transport profile adds non-secret Android app context without logging values',()=>{
  const api=new MovaApi({brand:'dreame',region:'eu'});
  api._accessToken='synthetic-token';
  const rlc=api._makeDreameRlc();
  assert.equal(typeof rlc,'string');
  assert.ok(rlc.length>10);
  const src=fs.readFileSync(path.join(root,'lib/MovaApi.js'),'utf8');
  assert.match(src,/transport=android-dio-parity-v180/);
  assert.match(src,/values=redacted/);
});

test('completed mowing routes use final lane consolidation while live routes retain measured geometry',()=>{
  const html=fs.readFileSync(path.join(root,'widgets/map/public/index.html'),'utf8');
  const script=html.match(/<script>\s*([\s\S]*?)<\/script>/i)?.[1];
  assert.ok(script);
  const ctx={navigator:{language:'de-DE'}}; vm.createContext(ctx); vm.runInContext(script,ctx);
  const route=[
    [0,0],[800,15],[1600,-12],[2400,8],
    [2400,300],[1600,315],[800,285],[0,305],
    [0,600],[700,590],[1400,610],[2400,595],
    // retrace/jitter over an already mown pass
    [2300,620],[1500,580],[900,615],[100,598],
  ];
  const live=ctx.buildMowingPatternPaths(route,x=>x,y=>y,5000,40,false);
  const final=ctx.buildMowingPatternPaths(route,x=>x,y=>y,5000,40,true);
  const liveCount=(live.match(/M/g)||[]).length;
  const finalCount=(final.match(/M/g)||[]).length;
  assert.ok(liveCount>0 && finalCount>0);
  assert.ok(finalCount<liveCount,'final render should collapse retraced/jittered segments');
  assert.match(final,/stroke-linecap="butt"/);
  assert.match(final,/mowing-pattern-light/);
  assert.match(final,/mowing-pattern-dark/);
});

test('device map payload switches a frozen mowing route to final mode before docking completes',()=>{
  const src=fs.readFileSync(path.join(root,'drivers/mower/device.js'),'utf8');
  assert.match(src,/routeRenderMode: finalCompletedRoute \? 'final' : 'live'/);
  assert.match(src,/completedRoute\.visualFinal === true/);
  assert.match(src,/visualFinalRoute \|\| legacyCompletedRoute/);
  assert.match(src,/if \(visualFinalRoute\) effectiveLivePath = completedRoute\.path/);
  assert.match(src,/returning_transition/);
});

test('overview keeps mobile scroll fix and command status text',()=>{
  const html=fs.readFileSync(path.join(root,'widgets/overview/public/index.html'),'utf8');
  const js=fs.readFileSync(path.join(root,'widgets/overview/public/dashboard.js'),'utf8');
  const css=fs.readFileSync(path.join(root,'widgets/overview/public/style.css'),'utf8');
  assert.doesNotMatch(html,/<iframe\b/i);
  assert.match(css,/overflow:hidden;touch-action:auto/);
  for(const text of ['Mähen gestartet','Mähen pausiert','Zurück zur Ladestation']) assert.ok(js.includes(text));
});
