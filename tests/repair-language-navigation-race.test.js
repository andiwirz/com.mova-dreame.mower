'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const base=path.join(__dirname,'../drivers/mower/repair');
function openView(view,session){
  const elements=new Map();
  const elem=id=>{
    if(!elements.has(id))elements.set(id,{
      id,value:id==='point-select'?'1':'',textContent:'',disabled:false,className:'',attrs:{},listeners:{},children:[],
      getAttribute(k){return this.attrs[k]},setAttribute(k,v){this.attrs[k]=v},addEventListener(k,fn){this.listeners[k]=fn},
      replaceChildren(){this.children=[]},appendChild(child){this.children.push(child)},
    });
    return elements.get(id);
  };
  const html=fs.readFileSync(path.join(base,view+'.html'),'utf8');
  const dynamicElements=[...html.matchAll(/<(?:button|span|h1|h2|p|label|strong)[^>]*data-de="([^"]*)"[^>]*data-en="([^"]*)"[^>]*>/g)]
    .map(m=>({de:m[1],en:m[2],textContent:m[1],getAttribute(k){return k==='data-de'?this.de:this.en}}));
  const nav=[...html.matchAll(/data-repair-view="([^"]+)"/g)].map(m=>{const e=elem('nav-'+m[1]);e.attrs['data-repair-view']=m[1];return e});
  const Homey={ready(){},done(){},showView(v){session.navigations.push(v)},getLanguage(){return 'de'},emit(event,payload,callback){
    session.events.push(event);
    if(event==='set_repair_ui_language')return new Promise(resolve=>setTimeout(()=>{session.language=payload.language;callback?.(null,payload.language);resolve(payload.language)},45));
    if(event==='get_repair_ui_language')return new Promise(resolve=>setTimeout(()=>{callback?.(null,session.language);resolve(session.language)},10));
    if(event==='get_maintenance_settings'){queueMicrotask(()=>callback?.(null,{}));return}
    if(event==='get_repair_settings'){queueMicrotask(()=>callback?.(null,{}));return}
  }};
  const document={documentElement:{lang:'de'},getElementById:elem,querySelectorAll(selector){return selector==='[data-de]'?dynamicElements:selector==='[data-repair-view]'?nav:[]},createElement(){return {textContent:'',className:''}}};
  const storage={getItem(){return null},setItem(){}};
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script,{Homey,document,localStorage:storage,navigator:{language:'de'},setTimeout,clearTimeout,Promise,console,queueMicrotask});
  return {elem,document,dynamicElements};
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const destination of ['reauth','maintenance_settings']){
  test(`EN survives immediate navigation to ${destination} with delayed Homey set`,async()=>{
    const session={language:'de',events:[],navigations:[]};
    const start=openView('repair',session);
    start.elem('repair-lang-en').listeners.click();
    start.elem('nav-'+destination).listeners.click();
    assert.equal(session.navigations.length,0,'navigation must wait for language acknowledgement');
    await delay(70);
    assert.deepEqual(session.navigations,[destination]);
    assert.equal(session.language,'en');
    const next=openView(destination,session);
    await delay(40);
    assert.equal(next.document.documentElement.lang,'en');
    assert(next.dynamicElements.some(e=>e.textContent==='Connection'));
    assert(next.dynamicElements.some(e=>e.textContent==='Maintenance points'));
  });
}
