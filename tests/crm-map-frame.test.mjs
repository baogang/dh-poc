import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {normalizeLocation} from '../web/road/location-data.js';

// Execute the shipped browser module with stubbed DOM/GPS/Google SDK boundaries.
// These tests verify our adapter, not live Google availability or billing.
const source=(await readFile(new URL('../web/road/map-frame.js',import.meta.url),'utf8')).replace("import {normalizeLocation} from './location-data.js';",'').replace(/initialize\(\);\s*$/,'await initialize();');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture({enabled=false,geocoding=false,configFailure=false,sdkFailure=false}={}){
  const nodes=new Map(),messages=[],mapListeners={},markerListeners={},geocodeCalls=[],scripts=[],gps=[];let messageHandler,mapOptions,marker;
  function element(id){if(nodes.has(id))return nodes.get(id);const classes=new Set(),n={value:'',textContent:'',hidden:['search-form','lookup','retry','accuracy'].includes(id),required:false,disabled:false,listeners:{},classList:{add:x=>classes.add(x),contains:x=>classes.has(x)},addEventListener:(type,fn)=>n.listeners[type]=fn,replaceChildren:(...children)=>n.textContent=children.map(x=>x.textContent).join('')};nodes.set(id,n);return n;}
  const parent={postMessage:(value,origin)=>messages.push({value:JSON.parse(JSON.stringify(value)),origin})};
  const window={parent,addEventListener:(type,fn)=>{if(type==='message')messageHandler=fn;}};
  const google={maps:{importLibrary:async name=>name==='maps'?{Map:class{constructor(_node,options){mapOptions=options;}addListener(type,fn){mapListeners[type]=fn;}panTo(){}setZoom(){}}}:name==='marker'?{AdvancedMarkerElement:class{constructor(){marker=this;}addListener(type,fn){markerListeners[type]=fn;}}}:{Geocoder:class{geocode(request){return new Promise((resolve,reject)=>geocodeCalls.push({request,resolve,reject}));}}}}};
  const document={documentElement:{},getElementById:element,createTextNode:text=>({textContent:text}),querySelector:()=>({nonce:'test-nonce'}),createElement:()=>({}),head:{append:script=>{scripts.push(script);if(sdkFailure)script.onerror();else window.__baladyMapsReady();}}};
  await runInNewContext('(async()=>{'+source+'})()',{normalizeLocation,URLSearchParams,URL,document,window,google,navigator:{geolocation:{getCurrentPosition:(success,error,options)=>gps.push({success,error,options})}},location:{search:'?channel=test-channel&lang=en',origin:'https://poc.example',reload(){}},AbortSignal,setTimeout:()=>1,clearTimeout(){},fetch:async()=>{if(configFailure)throw Error('offline');return {ok:true,json:async()=>({enabled,geocoding,browser_key:'stub-browser-value',map_id:'DEMO_MAP_ID'})};}});
  return {nodes,element,messages,gps,scripts,mapListeners,markerListeners,geocodeCalls,get marker(){return marker;},get mapOptions(){return mapOptions;},click:id=>element(id).listeners.click(),input:(id,value)=>{element(id).value=value;element(id).listeners.input?.();},submit:()=>element('location-form').listeners.submit({preventDefault(){}}),open:(extra={})=>messageHandler({source:parent,origin:'https://poc.example',data:{type:'balady:map-open',channel:'test-channel',...extra}})};
}
test('unconfigured map does not load Google or request GPS; empty coordinates cannot become an invented default pin',async()=>{
  const f=await fixture();assert.equal(f.scripts.length,0);assert.equal(f.gps.length,0);assert.equal(f.element('latitude').value,'');f.submit();assert.equal(f.messages.length,0);assert.match(f.element('error').textContent,/valid coordinates/);
  f.input('latitude','0');f.input('longitude','0');f.input('address','Synthetic test location');f.submit();assert.deepEqual(f.messages[0].value.selection,{latitude:0,longitude:0,address:'Synthetic test location',source:'manual'});assert.equal(f.messages[0].origin,'https://poc.example');
});
test('GPS denial is recoverable and reopening clears old selection and required-field context',async()=>{
  const f=await fixture();f.click('current');assert.equal(f.gps.length,1);assert.equal(f.element('current').disabled,true);f.gps[0].error({code:1});assert.equal(f.element('current').disabled,false);assert.match(f.element('status').textContent,/permission/);
  f.open({locale:'zh',required_fields:['city'],initial:{latitude:24,longitude:46,city:'Riyadh'}});assert.equal(f.element('latitude').value,'24');assert.equal(f.element('city').required,true);f.input('city','  ');f.submit();assert.equal(f.messages.length,0);assert.match(f.element('error').textContent,/有效经纬度/);
  f.open({locale:'ar'});assert.equal(f.element('latitude').value,'');assert.equal(f.element('city').required,false);assert.match(f.element('map').textContent,/لم تُهيأ/);
});
test('GPS success retains accuracy; stale GPS cannot overwrite a manually chosen location',async()=>{
  const f=await fixture();f.click('current');f.gps[0].success({coords:{latitude:24.7,longitude:46.6,accuracy:18}});f.submit();assert.equal(f.messages[0].value.selection.source,'device');assert.equal(f.messages[0].value.selection.accuracy,18);
  f.click('current');f.input('latitude','25');f.input('longitude','47');f.gps[1].success({coords:{latitude:26,longitude:48,accuracy:1}});f.submit();assert.deepEqual(f.messages[1].value.selection,{latitude:25,longitude:47,source:'manual'});
});
test('Google adapter starts without a selected pin; click and drag retain actual SDK coordinates with no automatic geocoding',async()=>{
  const f=await fixture({enabled:true,geocoding:true});assert.equal(f.element('latitude').value,'');assert.equal(f.marker.position,undefined);assert.equal(f.mapOptions.mapId,'DEMO_MAP_ID');assert.equal(f.geocodeCalls.length,0);
  f.mapListeners.click({latLng:{lat:()=>24.8,lng:()=>46.8}});f.submit();assert.equal(f.messages[0].value.selection.latitude,24.8);assert.equal(f.geocodeCalls.length,0);
  f.marker.position={lat:24.9,lng:46.9};f.markerListeners.dragend();f.submit();assert.equal(f.messages[1].value.selection.longitude,46.9);assert.equal(f.geocodeCalls.length,0);assert.equal(f.scripts[0].nonce,'test-nonce');
});
test('explicit geocoding ignores stale responses and moving the pin clears the previously resolved address',async()=>{
  const f=await fixture({enabled:true,geocoding:true});const result=(lat=24.8)=>({formatted_address:'Library, Riyadh',address_components:[{long_name:'Riyadh',types:['locality']}],geometry:{location:{lat:()=>lat,lng:()=>46.8}}});
  f.input('search','Library');f.element('search-form').listeners.submit({preventDefault(){}});assert.equal(f.geocodeCalls.length,1);f.input('latitude','25');f.input('longitude','47');f.geocodeCalls[0].resolve({results:[result()]});await flush();assert.equal(f.element('latitude').value,'25');assert.equal(f.element('address').value,'');
  f.element('search-form').listeners.submit({preventDefault(){}});f.geocodeCalls[1].resolve({results:[result()]});await flush();assert.equal(f.element('address').value,'Library, Riyadh');assert.equal(f.element('city').value,'Riyadh');f.input('latitude','26');assert.equal(f.element('address').value,'');assert.equal(f.element('city').value,'');
});
test('SDK or configuration failure keeps manual location entry usable and does not expose key data in messages',async()=>{
  for(const options of [{enabled:true,sdkFailure:true},{configFailure:true}]){const f=await fixture(options);assert.match(f.element('status').textContent,/unavailable/);f.input('latitude','24.8');f.input('longitude','46.8');f.submit();assert.equal(f.messages.length,1);assert.ok(!JSON.stringify(f.messages).includes('stub-browser-value'));}
});
