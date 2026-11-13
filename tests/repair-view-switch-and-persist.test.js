const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const dir=path.join(__dirname,'../drivers/mower/repair');
const script=(name)=>fs.readFileSync(path.join(dir,name+'.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function setup(promiseOnly=false){
 const elements = new Map();
 const el = (id)=> {if(!elements.has(id)) elements.set(id,{
   id,value:id==='point-select'?'1':'',textContent:'',disabled:false,style:{},dataset:{},className:'',
   attrs:{},listeners:{},children:[],setAttribute(k,v){this.attrs[k]=v},
   addEventListener(k,fn){this.listeners[k]=fn},replaceChildren(){this.children=[]},appendChild(e){this.children.push(e)},
 });return elements.get(id)};
 const store={};const emissions=[];let closed=0;
 const Homey={getLanguage:()=> 'de',ready(){},done(){closed++},showView(){},emit(name,payload,cb){
  emissions.push({name,payload:JSON.parse(JSON.stringify(payload))});
  if(promiseOnly){
    if(name==='get_maintenance_settings')return Promise.resolve(Object.assign({},store));
    if(name==='save_maintenance_settings'){Object.assign(store,payload);return Promise.resolve(Object.assign({},store))}
    if(name==='get_repair_settings')return Promise.resolve({brand:'mova',region:'eu'});
    if(name==='get_repair_ui_language')return Promise.resolve('en');
    if(name==='set_repair_ui_language')return Promise.resolve(payload.language);
    return Promise.resolve(true);
  }
  queueMicrotask(()=>{
   if(name==='get_maintenance_settings')cb(null,Object.assign({},store));
   else if(name==='save_maintenance_settings'){Object.assign(store,payload);cb(null,Object.assign({},store))}
   else if(name==='get_repair_settings')cb(null,{brand:'mova',region:'eu'});
   else cb(null,true);
  });
 }};
 const document={documentElement:{lang:'de'},getElementById:el,querySelectorAll:()=>[],createElement:()=>({className:'',textContent:''})};
 const context=vm.createContext({document,Homey,window:{},navigator:{language:'de'},localStorage:{getItem:()=>null,setItem(){}},setTimeout,clearTimeout,Promise,console});
 return {context,el,store,emissions,get closed(){return closed}};
}
const flush=()=>new Promise(resolve=>setTimeout(resolve,20));
test('repair, connection and maintenance views execute sequentially without global lexical collisions',async()=>{
 const state=setup();
 for(const name of ['repair','reauth','maintenance_settings']) vm.runInContext(script(name),state.context,{filename:name+'.html'});
 await flush();
 assert.equal(state.el('save').disabled,false);
 assert.equal(state.el('maintenance_settings-lang-de').attrs['aria-pressed'],'true');
 assert.equal(state.el('points').children.length,5);
});
test('P2 name is persisted and verified before close, and restored when reopened',async()=>{
 const state=setup();
 vm.runInContext(script('repair'),state.context);
 vm.runInContext(script('maintenance_settings'),state.context);
 await flush();
 state.el('point-select').value='2';state.el('point-select').listeners.change();
 state.el('point-name').value='Hinter dem Haus';state.el('point-name').listeners.input();
 await state.el('save').listeners.click();await flush();
 assert.equal(state.store.maintenance_point_2_name,'Hinter dem Haus');
 assert.equal(state.closed,1);
 assert(state.emissions.some(x=>x.name==='save_maintenance_settings'));
 const state2=setup();Object.assign(state2.store,state.store);
 vm.runInContext(script('maintenance_settings'),state2.context);await flush();
 state2.el('point-select').value='2';state2.el('point-select').listeners.change();
 assert.equal(state2.el('point-name').value,'Hinter dem Haus');
});
test('no Homey-generated next-button navigation',()=>{
 const compose=JSON.parse(fs.readFileSync(path.join(dir,'../driver.compose.json'),'utf8'));
 assert(compose.repair.every(v=>!v.navigation?.next));
});

test('Promise-only Homey bridge loads maintenance points, translates view and saves P2',async()=>{
 const state=setup(true);
 vm.runInContext(script('maintenance_settings'),state.context);
 await flush();
 assert.equal(state.el('save').disabled,false,'Loading must finish using Promise response');
 assert.equal(state.context.document.documentElement.lang,'en');
 state.el('point-select').value='2';state.el('point-select').listeners.change();
 state.el('point-name').value='Rasenende';state.el('point-name').listeners.input();
 state.el('save').listeners.click();await flush();
 assert.equal(state.store.maintenance_point_2_name,'Rasenende');
 assert.equal(state.closed,1);
});
