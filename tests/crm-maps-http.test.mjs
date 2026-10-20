import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoadServer} from '../src/road/server.mjs';
import {RoadStore} from '../src/road/store.mjs';
import {FeedbackRepository} from '../src/road/feedback.mjs';
import {CrmAgent} from '../src/crm/agent.mjs';
import {controlledSession} from '../src/road/runtime.mjs';
import {mapsConfiguration} from '../src/road/maps.mjs';

async function fixture(){
  const seen=[],password='maps-http-test-password',authorization='Basic '+Buffer.from('admin:'+password).toString('base64');
  const app=await createRoadServer({store:new RoadStore(),feedback:new FeedbackRepository({connectionString:null}),maps:mapsConfiguration({GOOGLE_MAPS_BROWSER_KEY:'browser-test-value'}),knowledge:{document:{name:'test'},entries:[],answer:async()=>null},config:{host:'127.0.0.1',port:10000,access:{password}},agentFactory:options=>{const agent=new CrmAgent({...options,runtimeFactory:o=>controlledSession({...o,fauxResponses:[]})});agent.chat=async(s,message)=>{seen.push(message);};return agent;}});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});await app.ready();const origin='http://127.0.0.1:'+app.server.address().port;
  const response=await fetch(origin+'/api/session',{method:'POST',headers:{authorization}}),state=await response.json(),headers={authorization,cookie:response.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':state.csrf};
  return {app,origin,state,headers,seen,post:value=>fetch(origin+'/api/chat',{method:'POST',headers,body:JSON.stringify(value)})};
}
test('map browser config requires website authentication and a session, stays outside conversation state, and HTML has isolated CSP',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.origin+'/api/maps/config')).status,401);assert.equal((await fetch(f.origin+'/api/maps/config',{headers:{authorization:f.headers.authorization}})).status,401);
    const config=await fetch(f.origin+'/api/maps/config',{headers:f.headers});assert.equal(config.headers.get('cache-control'),'no-store');assert.equal((await config.json()).browser_key,'browser-test-value');
    const state=await (await fetch(f.origin+'/api/state',{headers:f.headers})).text();assert.ok(!state.includes('browser-test-value'));
    assert.equal((await fetch(f.origin+'/map-picker.html')).status,401);
    const page=await fetch(f.origin+'/map-picker.html',{headers:f.headers}),html=await page.text(),nonce=html.match(/nonce="([^"]+)"/)[1];assert.ok(page.headers.get('content-security-policy').includes("'nonce-"+nonce+"'"));assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'self'/);assert.equal(page.headers.get('referrer-policy'),'strict-origin-when-cross-origin');assert.doesNotMatch(html,/__MAP_NONCE__|browser-test-value/);
    const main=await fetch(f.origin+'/',{headers:f.headers});assert.match(main.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.doesNotMatch(main.headers.get('content-security-policy'),/google|nonce|unsafe-inline/);
  }finally{await f.app.close();}
});
test('chat validates location before agent dispatch and preserves CSRF and explicit send semantics',async()=>{
  const f=await fixture();try{
    for(const location of [{latitude:91,longitude:46},{latitude:'24',longitude:46},{latitude:24,longitude:46,MunicipalityID:'009'}]){const response=await f.post({message:'Issue here',location});assert.equal(response.status,400);assert.equal((await response.json()).error.code,'INVALID_LOCATION');}
    assert.equal(f.seen.length,0);
    const noCsrf={...f.headers};delete noCsrf['x-csrf-token'];assert.equal((await fetch(f.origin+'/api/chat',{method:'POST',headers:noCsrf,body:JSON.stringify({message:'',location:{latitude:0,longitude:0}})})).status,403);
    assert.equal((await f.post({message:'这里垃圾没清理',location:{latitude:24.75,longitude:46.65,address:'图书馆门口'},location_locale:'zh'})).status,202);assert.match(f.seen[0],/这里垃圾没清理\n\n已选择的问题位置\n纬度: 24.75\n经度: 46.65\n地址: 图书馆门口/);assert.doesNotMatch(f.seen[0],/browser-test-value|MunicipalityID/);
    assert.equal((await f.post({message:'',location:{latitude:0,longitude:0}})).status,202);assert.match(f.seen[1],/Latitude: 0\nLongitude: 0/);assert.equal((await f.post({message:''})).status,400);
  }finally{await f.app.close();}
});
