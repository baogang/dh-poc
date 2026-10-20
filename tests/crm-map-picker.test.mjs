import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {createDocument} from './helpers/dom.mjs';
import {normalizeLocation,validMapMessage} from '../web/road/location-data.js';
const source=(await readFile(new URL('../web/road/map-picker.js',import.meta.url),'utf8')).replace("import {normalizeLocation,validMapMessage} from './location-data.js';",'').replace('export function','function');
function fixture(){
  const document=createDocument(),create=document.createElement,messages=[];let receive,frame,dialog,focused=0;
  document.body=create('body');document.activeElement={focus:()=>focused++};
  document.createElement=tag=>{const el=create(tag);if(tag==='dialog'){dialog=el;el.showModal=()=>el.open=true;el.close=()=>{el.open=false;queueMicrotask(()=>el.listeners.close());};}if(tag==='iframe'){frame=el;el.contentWindow={postMessage:(data,origin)=>messages.push({data,origin})};}return el;};
  const context={document,normalizeLocation,validMapMessage,crypto:{randomUUID},window:{addEventListener:(name,fn)=>{if(name==='message')receive=fn;}},location:{origin:'https://poc.example'},api:null};runInNewContext(source+';api=createMapPicker(document);',context);
  return {picker:context.api,messages,get dialog(){return dialog;},get frame(){return frame;},get focused(){return focused;},select:selection=>receive({source:frame.contentWindow,origin:'https://poc.example',data:{type:'balady:location-selected',channel:messages.at(-1).data.channel,selection}}),receive:event=>receive(event)};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('shared picker can select close and reopen for a different chat entry without a stale pending promise or another iframe load',async()=>{
  const f=fixture(),first=f.picker.open({locale:'en'}),frame=f.frame;assert.equal(f.dialog.open,true);f.frame.listeners.load();f.select({latitude:24.7,longitude:46.6});assert.equal((await first).latitude,24.7);await tick();assert.equal(f.dialog.open,false);
  const second=f.picker.open({locale:'zh',fields:['body.LocationInfo.Address','municipalityID']});assert.equal(f.frame,frame);assert.equal(f.dialog.open,true);assert.deepEqual([...f.messages.at(-1).data.required_fields],['address','city']);assert.equal(f.messages.at(-1).origin,'https://poc.example');f.dialog.close();assert.equal(await second,null);await tick();
  const third=f.picker.open({locale:'ar',initial:{latitude:25,longitude:47}});assert.equal(f.dialog.open,true);assert.equal(f.frame.title,'تحديد الموقع على خرائط Google');f.select({latitude:25,longitude:47});assert.equal((await third).longitude,47);await tick();assert.equal(f.focused,3);
});
test('forged iframe messages and malformed selections cannot resolve or close the picker',async()=>{
  const f=fixture(),pending=f.picker.open(),channel=f.messages.at(-1).data.channel,data={type:'balady:location-selected',channel,selection:{latitude:25,longitude:47}};
  for(const changed of [{origin:'https://evil.example'},{source:{}},{data:{...data,channel:'other'}},{data:{...data,selection:{latitude:91,longitude:47}}}]){f.receive({source:f.frame.contentWindow,origin:'https://poc.example',data,...changed});assert.equal(f.dialog.open,true);}
  f.select({latitude:0,longitude:0});assert.equal((await pending).latitude,0);await tick();
});
