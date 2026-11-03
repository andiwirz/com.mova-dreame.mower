'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const src=read('widgets/overview/public/dashboard.js');

function makeChild(bottom,hidden=false){
  return {hidden,tagName:'SECTION',getClientRects:()=>hidden?[]:[{}],getBoundingClientRect:()=>({bottom})};
}
test('overview tile shrinks after map and recovery sections collapse even if iframe scrollHeight stays high',()=>{
  const calls=[];
  const body={children:[makeChild(90),makeChild(480),makeChild(810)],
    scrollHeight:1460,getBoundingClientRect:()=>({top:0})};
  const document={body,documentElement:{scrollHeight:1460}};
  const context={H:{setHeight:n=>calls.push(n)},document,getComputedStyle:e=>({display:e.hidden?'none':'block',paddingBottom:e===body?'14px':'0px'}),Math};
  const start=src.indexOf('function measureWidgetContentHeight(){');
  const end=src.indexOf('function resizeWidgetAfterMapLayout(){',start);
  assert.ok(start>0&&end>start);
  vm.runInNewContext(src.slice(start,end),context);
  vm.runInNewContext('resizeWidget()',context);
  assert.equal(calls.at(-1),824);
  body.children[2].hidden=true;
  vm.runInNewContext('resizeWidget()',context);
  assert.equal(calls.at(-1),494,'collapse should lower the widget height');
  vm.runInNewContext('resizeWidget()',context);
  assert.equal(calls.length,2,'unchanged content should not issue redundant Homey heights');
  body.children[1].getBoundingClientRect=()=>({bottom:300});
  vm.runInNewContext('resizeWidget()',context);
  assert.equal(calls.at(-1),314);
  assert.match(read('widgets/overview/public/style.css'),/\[hidden\]\{display:none!important\}/);
});
function translate(language,initial,aria){
  const node={nodeValue:initial,parentElement:{tagName:'BUTTON'}};
  const att={attrs:{'aria-label':aria},getAttribute(k){return this.attrs[k]},setAttribute(k,v){this.attrs[k]=v}};
  const document={documentElement:{lang:'en'},body:{},title:'',
    createTreeWalker(){let done=false;return {nextNode(){if(done)return null;done=true;return node}}},
    querySelectorAll(){return [att]}};
  const source=src.slice(0,src.indexOf('let H,id,'));
  const context={document,Homey:{getLanguage:()=>language},navigator:{language:language==='en'?'de-DE':'en-US'},String};
  vm.runInNewContext(source+';localizeStaticOverview();',context);
  return {node:node.nodeValue,aria:att.attrs['aria-label'],lang:document.documentElement.lang,title:document.title};
}
test('Homey English overrides a German phone locale for new rescue labels',()=>{
  const en=translate('en','Tor ist offen, der ursprüngliche Herstellerauftrag enthielt keine Punktnummer. Hier P1–P5 ausdrücklich wählen; kein Mähstart.','Wartungspunkt auswählen');
  assert.equal(en.lang,'en');assert.match(en.node,/Gate is open/);assert.equal(en.aria,'Select maintenance point');
  assert.equal(en.title,'Mower overview');
});
test('Homey German overrides an English phone locale for new rescue labels',()=>{
  const de=translate('de-DE','Mower safely OUTSIDE (visual)','Visual safety checks');
  assert.equal(de.lang,'de');assert.equal(de.node,'Mäher sicher DRAUSSEN (Sicht)');
  assert.equal(de.aria,'Sichtprüfungen zur Sicherheit');
});
test('the embedded editor and recovery wizard inherit Homey language from the actual widget session',()=>{
  assert.match(src,/getLanguage:\(\)=>\(\(typeof H\?\.getLanguage/);
  assert.match(src,/window\.MovaWidgetLanguage=overviewGerman\?'de':'en'/);
  assert.match(read('widgets/overview/public/recovery-wizard.js'),/window\.MovaWidgetLanguage/);
  assert.match(read('widgets/overview/public/map-editor.html'),/typeof Homey\.getLanguage==='function'/);
  for(const p of ['widgets/map/public/index.html','drivers/mower/repair/map_editor.html','widgets/history/public/index.html']){
    assert.match(read(p),/getLanguage/,p);
  }
});
