'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../drivers/mower/repair/maintenance_settings.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function setup(){
 const els=new Map(); const calls=[]; let position=true; let learning=false; let name='Garage hinten';
 const el=(id)=>{if(!els.has(id))els.set(id,{id,value:id==='point-select'?'1':'',textContent:'',disabled:false,style:{display:''},className:'',listeners:{},attrs:{},children:[],addEventListener(k,fn){this.listeners[k]=fn},setAttribute(k,v){this.attrs[k]=v},getAttribute(k){return this.attrs[k]},replaceChildren(){this.children=[]},appendChild(c){this.children.push(c)}});return els.get(id)};
 const Homey={ready(){},done(){},showView(){},getLanguage(){return 'de'},emit(ev,payload,cb){
   calls.push([ev,payload]);let result;
   if(ev==='get_repair_ui_language')result='de';
   else if(ev==='set_repair_ui_language')result=payload.language;
   else if(ev==='get_maintenance_settings')result={maintenance_point_2_name:name};
   else if(ev==='save_maintenance_settings'){name=payload.maintenance_point_2_name;result={maintenance_point_2_name:name}}
   else if(ev==='get_maintenance_point_state')result={index:payload.index,hasPosition:position,x:0,y:260};
   else if(ev==='delete_maintenance_point_position'){position=false;result={ok:true,index:payload.index}}
   else if(ev==='learn_maintenance_point'){learning=true;result=true;}
   else result=null;
   queueMicrotask(()=>cb?.(null,result));return Promise.resolve(result)
 }};
 const document={documentElement:{lang:'de'},getElementById:el,querySelectorAll(){return []},createElement(){return {textContent:'',className:''}}};
 vm.runInNewContext(script,{document,Homey,navigator:{language:'de'},localStorage:{getItem(){return 'de'},setItem(){}},Promise,setTimeout,clearTimeout,queueMicrotask,console});
 return {el,calls,isPosition:()=>position,isLearning:()=>learning};
}
test('Repair delete buttons: real event, inline confirm, backend handler, verify, feedback',async()=>{
 const v=setup();await sleep(20);v.el('point-select').value='2';v.el('point-select').listeners.change();await sleep(15);
 assert.equal(v.el('delete-point').disabled,false);
 v.el('delete-point').listeners.click();assert.equal(v.el('delete-confirm').style.display,'block');
 assert.equal(v.isPosition(),true);assert.equal(v.calls.filter(x=>x[0]==='delete_maintenance_point_position').length,0);
 v.el('confirm-delete').listeners.click();await sleep(25);
 assert.equal(v.isPosition(),false);assert.equal(v.el('delete-confirm').style.display,'none');
 assert.match(v.el('msg').textContent,/Position und Marker gelöscht/);
 assert.equal(v.el('learn-point').textContent,'Anlernen');
 assert(v.calls.some(([ev,p])=>ev==='get_maintenance_point_state'&&p.index===2));
});
test('Repair learn button: save name, invoke learning handler, prompt MOVA',async()=>{
 const v=setup();await sleep(20);v.el('point-select').value='2';v.el('point-select').listeners.change();await sleep(15);
 v.el('point-name').value='Mein P2';v.el('point-name').listeners.input();
 v.el('learn-point').listeners.click();await sleep(25);
 assert.equal(v.isLearning(),true);
 const save=v.calls.findIndex(x=>x[0]==='save_maintenance_settings');
 const learn=v.calls.findIndex(x=>x[0]==='learn_maintenance_point');
 assert(save!==-1 && learn>save);assert.match(v.el('msg').textContent,/Original-MOVA-App/);
});
test('Repair delete: cancel prevents backend deletion, cross point switch clears confirmation',async()=>{
 const v=setup();await sleep(20);v.el('point-select').value='2';v.el('point-select').listeners.change();await sleep(15);
 v.el('delete-point').listeners.click();v.el('cancel-delete').listeners.click();
 v.el('confirm-delete').listeners.click();await sleep(5);assert.equal(v.isPosition(),true);
 v.el('delete-point').listeners.click();v.el('point-select').value='3';v.el('point-select').listeners.change();
 assert.equal(v.el('delete-confirm').style.display,'none');
});
