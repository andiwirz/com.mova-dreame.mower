'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../drivers/mower/repair/maintenance_settings.html'),'utf8');

test('maintenance loads independently when locale request never resolves; local DE/EN works on open menu',async()=>{
 const elements=new Map();
 function el(id){if(!elements.has(id))elements.set(id,{
   id,textContent:'',value:id==='point-select'?'1':'',disabled:false,style:{},attrs:{},listeners:{},children:[],
   setAttribute(k,v){this.attrs[k]=v},getAttribute(k){return this.attrs[k]},removeAttribute(k){delete this.attrs[k]},
   addEventListener(k,fn){this.listeners[k]=fn},replaceChildren(){this.children=[]},appendChild(c){this.children.push(c)}
 });return elements.get(id)}
 const translated=[...html.matchAll(/<[^>]+data-de="([^"]*)"\s+data-en="([^"]*)"[^>]*>/g)].map(m=>({de:m[1],en:m[2],textContent:m[1],getAttribute(k){return k==='data-de'?this.de:this.en}}));
 const nav=[...html.matchAll(/data-repair-view="([^"]+)"/g)].map(m=>{const e=el(m[1]);e.attrs['data-repair-view']=m[1];return e});
 let getPointsCalled=0;
 const Homey={ready(){},done(){},showView(){},getLanguage(){return 'de'},emit(name,payload,cb){
  if(name==='get_repair_ui_language')return new Promise(()=>{});
  if(name==='get_maintenance_settings'){getPointsCalled++;const data={maintenance_point_2_name:'Rasenende'};queueMicrotask(()=>cb?.(null,data));return Promise.resolve(data)}
  if(name==='set_repair_ui_language')return new Promise(()=>{});
 }};
 const document={documentElement:{lang:'de'},getElementById:el,querySelectorAll(q){return q==='[data-de]'?translated:q==='[data-repair-view]'?nav:[]},createElement(){return {textContent:'',className:''}}};
 vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{Homey,document,localStorage:{getItem(){return 'de'},setItem(){}},navigator:{language:'de'},Promise,queueMicrotask,setTimeout,clearTimeout,console});
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(getPointsCalled,1,'point load must not wait for language sync');
 assert.equal(el('msg').textContent,'');
 el('maintenance_settings-lang-en').listeners.click({preventDefault(){}});
 assert.equal(document.documentElement.lang,'en');
 assert.equal(el('maintenance_settings-lang-en').attrs['aria-pressed'],'true');
 assert(translated.some(x=>x.textContent==='Maintenance points'));
 el('maintenance_settings-lang-de').listeners.click({preventDefault(){}});
 assert.equal(document.documentElement.lang,'de');
 assert(translated.some(x=>x.textContent==='Wartungspunkte'));
});
