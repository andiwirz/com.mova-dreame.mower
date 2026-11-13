'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'../drivers/mower/repair');
function view(name){
  const html=fs.readFileSync(path.join(root,name+'.html'),'utf8');
  const map=new Map();
  function el(id){
    if(!map.has(id))map.set(id,{
      id,textContent:'',value:id==='point-select'?'1':'',disabled:false,className:'',attrs:{},listeners:{},children:[],
      setAttribute(k,v){this.attrs[k]=v},getAttribute(k){return this.attrs[k]},removeAttribute(k){delete this.attrs[k]},
      addEventListener(k,fn){this.listeners[k]=fn},replaceChildren(){this.children=[]},appendChild(c){this.children.push(c)}
    });
    return map.get(id);
  }
  const translated=[...html.matchAll(/<[^>]+data-de="([^"]*)"\s+data-en="([^"]*)"[^>]*>/g)].map(m=>({de:m[1],en:m[2],textContent:m[1],getAttribute(k){return k==='data-de'?this.de:this.en}}));
  // maintenance message element has a bilingual initial fallback and will be independently tracked by element id
  const nav=[...html.matchAll(/data-repair-view="([^"]+)"/g)].map(m=>{const x=el('nav-'+m[1]);x.attrs['data-repair-view']=m[1];return x});
  const session={language:'de',store:{maintenance_point_2_name:'Rasenende'}};
  const Homey={ready(){},done(){},showView(){},getLanguage(){return 'de'},emit(event,payload,cb){
    let result;
    if(event==='get_repair_ui_language')result=session.language;
    if(event==='set_repair_ui_language')result=session.language=payload.language;
    if(event==='get_maintenance_settings')result=session.store;
    if(event==='get_repair_settings')result={};
    if(event==='save_maintenance_settings')result=session.store={...payload};
    queueMicrotask(()=>cb?.(null,result));return Promise.resolve(result);
  }};
  const document={documentElement:{lang:'de'},getElementById:el,querySelectorAll(q){return q==='[data-de]'?translated:q==='[data-repair-view]'?nav:[]},createElement(){return {textContent:'',className:''}}};
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{Homey,document,localStorage:{getItem(){return 'de'},setItem(){}},navigator:{language:'de'},Promise,queueMicrotask,setTimeout,clearTimeout,console});
  return {el,document,translated,session};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(const page of ['reauth','maintenance_settings']){
  test(`${page}: DE -> EN -> DE while staying inside the menu`,async()=>{
    const v=view(page);await sleep(25);
    assert.equal(v.document.documentElement.lang,'de');
    v.el(page+'-lang-en').listeners.click();
    assert.equal(v.document.documentElement.lang,'en');
    assert.equal(v.el(page+'-lang-en').attrs['aria-pressed'],'true');
    assert(v.translated.some(e=>e.textContent==='Connection'));
    assert(v.translated.some(e=>e.textContent==='Maintenance points'));
    v.el(page+'-lang-de').listeners.click();
    assert.equal(v.document.documentElement.lang,'de');
    assert.equal(v.el(page+'-lang-de').attrs['aria-pressed'],'true');
    assert(v.translated.some(e=>e.textContent==='Verbindung'));
    assert(v.translated.some(e=>e.textContent==='Wartungspunkte'));
    await sleep(15);
    assert.equal(v.session.language,'de');
  });
}
test('Maintenance: live switching preserves active P2 text input and translates status',async()=>{
  const v=view('maintenance_settings');await sleep(25);
  v.el('point-select').value='2';v.el('point-select').listeners.change();
  v.el('point-name').value='Mein unbearbeiteter Name';v.el('point-name').listeners.input();
  v.el('maintenance_settings-lang-en').listeners.click();
  assert.equal(v.el('point-name').value,'Mein unbearbeiteter Name');
  assert.match(v.el('hint').textContent,/Name and position/);
  v.el('maintenance_settings-lang-de').listeners.click();
  assert.equal(v.el('point-name').value,'Mein unbearbeiteter Name');
  assert.match(v.el('hint').textContent,/Name und Position/);
});
