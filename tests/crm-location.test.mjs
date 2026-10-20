import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLocation,locationText,locationInput,validMapMessage} from '../web/road/location-data.js';
import {mapsConfiguration,mapsPage} from '../src/road/maps.mjs';
import {createChatRenderer} from '../web/road/chat-ui.js';
import {createDocument} from './helpers/dom.mjs';

test('location facts accept zero and boundary coordinates but reject invalid types ranges and administrative IDs',()=>{
  assert.deepEqual(normalizeLocation({latitude:0,longitude:0,address:'  Museum gate  '}),{latitude:0,longitude:0,address:'Museum gate',source:'manual'});
  for(const [latitude,longitude] of [[-90,-180],[90,180]])assert.equal(normalizeLocation({latitude,longitude}).latitude,latitude);
  for(const value of [null,[],{latitude:'24',longitude:46},{latitude:NaN,longitude:46},{latitude:24,longitude:Infinity},{latitude:91,longitude:46},{latitude:24,longitude:-181},{latitude:24,longitude:46,MunicipalityID:'009'},{latitude:24,longitude:46,source:'government'},{latitude:24,longitude:46,accuracy:-1},{latitude:24,longitude:46,address:{}},{latitude:24,longitude:46,city:'x'.repeat(201)}])assert.throws(()=>normalizeLocation(value));
});
test('location projection is readable in three languages and preserves actual coordinates without inventing IDs',()=>{
  for(const locale of ['en','zh','ar']){const text=locationText({latitude:24.75,longitude:46.65,city:'Riyadh',address:'Library entrance',accuracy:12,source:'device'},locale);assert.ok(text.includes('24.75'));assert.ok(text.includes('46.65'));assert.ok(text.includes('Library entrance'));assert.doesNotMatch(text,/MunicipalityID|SubMunicipalityID|browser_key|source/);}
});
test('map messages require the exact origin frame and channel',()=>{
  const frame={contentWindow:{}},event={origin:'https://poc.example',source:frame.contentWindow,data:{type:'balady:location-selected',channel:'private-channel'}};
  assert.equal(validMapMessage(event,frame,'private-channel',event.origin),true);
  for(const changed of [{origin:'https://evil.example'},{source:{}},{data:{...event.data,channel:'other'}},{data:{type:'other',channel:'private-channel'}},{data:null}])assert.equal(validMapMessage({...event,...changed},frame,'private-channel',event.origin),false);
});
test('map configuration makes geocoding opt-in and excludes server secrets; map CSP uses a unique nonce',()=>{
  assert.equal(mapsConfiguration({}).enabled,false);
  const config=mapsConfiguration({GOOGLE_MAPS_BROWSER_KEY:' browser-test-value ',GOOGLE_MAPS_GEOCODING_ENABLED:'true',SECRET_SERVER_KEY:'hidden'});assert.equal(config.browser_key,'browser-test-value');assert.equal(config.geocoding,true);assert.equal(config.SECRET_SERVER_KEY,undefined);
  assert.equal(mapsConfiguration({GOOGLE_MAPS_BROWSER_KEY:'demo-value',GOOGLE_MAPS_KEY_MODE:'demo',GOOGLE_MAPS_GEOCODING_ENABLED:'true'}).geocoding,false);
  const first=mapsPage('<style nonce="__MAP_NONCE__"></style>'),second=mapsPage('<style nonce="__MAP_NONCE__"></style>');assert.notEqual(first.html,second.html);const nonce=first.html.match(/nonce="([^"]+)"/)[1];assert.ok(first.csp.includes("'nonce-"+nonce+"'"));assert.match(first.csp,/frame-ancestors 'self'/);assert.doesNotMatch(first.csp,/unsafe-inline|unsafe-eval|https:\s/);
});
function inputFixture(fields,kind='text'){
  const document=createDocument(),container=document.createElement('div'),requests=[],selections=[];
  const value={user:{name:'demo'},status:'input',running:false,messages:[],plans:[],events:[],receipts:[],mock:{handoffs:[]},pendingInput:{id:'location-input',kind,fields,question:'Where did the issue happen?'}};
  const renderer=createChatRenderer(document,container,{action:(...args)=>requests.push(args),pickLocation:async options=>{requests.push({picker:options});return selections.shift();}});renderer.render(value,{locale:'en'});
  const form=()=>container.querySelector('form'),pick=()=>form().querySelectorAll('button').find(n=>n.textContent==='Choose issue location on map');
  return {value,renderer,container,requests,selections,form,pick};
}
test('location picker is offered only for geographic fields; city input receives a name and never coordinates or an ID',async()=>{
  assert.equal(locationInput({fields:['body.CustomerInformation.MobileNumber']}),false);assert.equal(locationInput({fields:['body.LocationInfo.Latitude']}),true);
  const f=inputFixture(['municipalityID']);f.form().isConnected=true;f.selections.push({latitude:24.7,longitude:46.6,city:'Riyadh'});await f.pick().listeners.click();assert.equal(f.form().querySelector('textarea').value,'Riyadh');assert.equal(f.requests.filter(Array.isArray).length,0,'Selecting a point does not submit the input or approve a write');
  assert.equal(inputFixture(['body.subject']).pick(),undefined);
});
test('reselecting a native location after a render replaces the previous projection while retaining typed facts',async()=>{
  const f=inputFixture(['body.LocationInfo.Latitude','body.LocationInfo.Longitude']);f.form().isConnected=true;f.form().querySelector('textarea').value='Next to the library';f.selections.push({latitude:24.71,longitude:46.61});await f.pick().listeners.click();f.renderer.render(f.value,{locale:'en',busy:true});f.renderer.render(f.value,{locale:'en',busy:false});f.form().isConnected=true;f.selections.push({latitude:24.72,longitude:46.62});await f.pick().listeners.click();const text=f.form().querySelector('textarea').value;assert.match(text,/Next to the library/);assert.match(text,/24.72/);assert.doesNotMatch(text,/24.71|46.61/);assert.equal(text.split('Selected issue location').length-1,1);
});
test('cancelled and stale native location cards retain their original information',async()=>{
  const f=inputFixture(['body.LocationInfo.Address']);f.form().isConnected=true;f.form().querySelector('textarea').value='Original location';f.selections.push(null);await f.pick().listeners.click();assert.equal(f.form().querySelector('textarea').value,'Original location');f.form().isConnected=false;f.selections.push({latitude:25,longitude:47});await f.pick().listeners.click();assert.equal(f.form().querySelector('textarea').value,'Original location');
});
