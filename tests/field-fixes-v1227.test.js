'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const editors=[
  'widgets/map/public/index.html',
  'widgets/overview/public/map-editor.html',
  'drivers/mower/repair/map_editor.html',
];

test('1.2.27 create pending projects a blue square immediately in all map editors',()=>{
  for(const file of editors){
    const s=fs.readFileSync(path.join(root,file),'utf8');
    assert.match(s,/pendingRule === 'create'/,file);
    assert.match(s,/class="pylon-pending-zone"/,file);
    assert.match(s,/pendingHalf\*2/,file);
  }
});

test('1.2.27 pending ring is visibly non-scaling and has inline SVG animation',()=>{
  for(const file of editors){
    const s=fs.readFileSync(path.join(root,file),'utf8');
    assert.match(s,/pylon-pending-ring[^}]*vector-effect:non-scaling-stroke/,file);
    assert.match(s,/attributeName="stroke-dashoffset"[^>]*repeatCount="indefinite"/,file);
    assert.match(s,/attributeName="opacity"[^>]*repeatCount="indefinite"/,file);
  }
});

test('1.2.27 overview static map styles the pending projection too',()=>{
  const s=fs.readFileSync(path.join(root,'widgets/overview/public/style.css'),'utf8');
  assert.match(s,/\.map-static \.pylon-pending-zone\{[^}]*fill:rgba\(66,165,245,.14\)[^}]*vector-effect:non-scaling-stroke/);
});
