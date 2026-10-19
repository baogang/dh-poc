import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createRoadServer} from '../src/road/server.mjs';
import {RoadStore} from '../src/road/store.mjs';
import {FeedbackRepository} from '../src/road/feedback.mjs';

// Exercise public HTTP boundaries with ephemeral credentials. No .env, model,
// database, or direct business-state mutation is involved in this smoke suite.
async function fixture(){
  const password=randomBytes(24).toString('hex');
  const authorization='Basic '+Buffer.from('smoke:'+password).toString('base64');
  const app=await createRoadServer({store:new RoadStore(),feedback:new FeedbackRepository({connectionString:null}),knowledge:{document:{name:'Smoke fixture'},entries:[],answer:async()=>null},config:{host:'127.0.0.1',port:10000,access:{username:'smoke',password}}});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});await app.ready();
  const origin='http://127.0.0.1:'+app.server.address().port;
  const request=(path,options={})=>fetch(origin+path,{...options,headers:{authorization,...options.headers}});
  const start=async()=>{const response=await request('/api/session',{method:'POST'});assert.equal(response.status,201);return {state:await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]};};
  const post=(session,path,payload,headers={})=>request(path,{method:'POST',headers:{cookie:session.cookie,'x-csrf-token':session.state.csrf,'content-type':'application/json',...headers},body:typeof payload==='string'?payload:JSON.stringify(payload)});
  return {app,origin,request,start,post};
}

test('smoke: public health and authenticated HTML/assets/OpenAPI are reachable; unauthenticated content stays protected',async()=>{
  const f=await fixture();try{
    const health=await fetch(f.origin+'/healthz');assert.equal(health.status,200);assert.equal((await health.json()).service,'balady-crm');
    for(const path of ['/','/app.js','/api/openapi','/api/tools']){
      const response=await fetch(f.origin+path);assert.equal(response.status,401,path);assert.match(response.headers.get('www-authenticate'),/realm="BALADY Assistant"/);
    }
    for(const path of ['/','/app.js','/chat-ui.js','/markdown.js','/crm-review.js','/vendor/marked.js','/i18n.js','/feedback-ui.js','/feedback-data.js','/style.css']){
      const response=await f.request(path);assert.equal(response.status,200,path);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.ok((await response.text()).length>100,path);
    }
    const catalog=await (await f.request('/api/tools')).json();assert.equal(catalog.identity,'BALADY Assistant');assert.equal(catalog.operations.length,35);assert.equal(catalog.operations.filter(x=>x.available_in_public_assistant).length,20);
    const spec=await (await f.request('/api/openapi')).json();assert.equal(spec.openapi,'3.0.3');assert.equal(Object.keys(spec.paths).length,35);
    assert.equal((await f.request('/v1/crm-services/asset-details')).status,403);
    assert.equal((await f.request('/mock/query_tickets',{method:'POST'})).status,410);
  }finally{await f.app.close();}
});

test('smoke: new browser sessions are isolated; login failure is recoverable; secrets never enter public state',async()=>{
  const f=await fixture();try{
    const a=await f.start(),b=await f.start();assert.notEqual(a.state.id,b.state.id);assert.notEqual(a.state.csrf,b.state.csrf);assert.equal(a.state.tool_count,20);assert.equal(a.state.contract_operation_count,35);
    assert.equal((await f.post(a,'/api/login',{username:'not-an-account',password:'wrong'})).status,401);
    const response=await f.post(a,'/api/login',{username:'demo',password:'demo'});assert.equal(response.status,200);const logged=await response.json();assert.equal(logged.user.name,'demo');assert.equal(logged.running,false);
    const other=await (await f.request('/api/state',{headers:{cookie:b.cookie}})).json();assert.equal(other.user,null);
    assert.equal((await f.post(a,'/api/login',{username:'sara',password:'demo'})).status,409);
    assert.doesNotMatch(JSON.stringify(logged),/"password"|"access_token"|"consumerSecret"/);
    assert.equal((await f.request('/api/state')).status,401);
    assert.equal((await f.request('/api/state',{headers:{cookie:'road_session=missing'}})).status,404);
  }finally{await f.app.close();}
});

test('smoke: CSRF/origin failures and malformed transport do not break the next valid request',async()=>{
  const f=await fixture();try{
    const s=await f.start();
    assert.equal((await f.post(s,'/api/catalog',{}, {'x-csrf-token':'wrong'})).status,403);
    assert.equal((await f.post(s,'/api/catalog',{}, {origin:'https://evil.example.test'})).status,403);
    assert.equal((await f.post(s,'/api/catalog','{invalid')).status,400);
    assert.equal((await f.post(s,'/api/catalog',{}, {'content-type':'text/plain'})).status,415);
    assert.equal((await f.post(s,'/api/chat',{message:''})).status,400);
    assert.equal((await f.post(s,'/api/chat',{message:'x'.repeat(12001)})).status,400);
    assert.equal((await f.post(s,'/api/catalog',{})).status,200);
    const state=await (await f.request('/api/state',{headers:{cookie:s.cookie}})).json();assert.equal(state.running,false);assert.equal(state.receipts.length,0);
  }finally{await f.app.close();}
});

test('smoke: stale actions, unknown routes, invalid cursors and wrong methods return controlled errors',async()=>{
  const f=await fixture();try{
    const s=await f.start();
    for(const [path,payload] of [['/api/approve-operation',{proposal_id:'missing'}],['/api/approve-plan',{plan_id:'missing'}],['/api/input',{input_id:'missing'}]])assert.equal((await f.post(s,path,payload)).status,409,path);
    assert.equal((await f.post(s,'/api/does-not-exist',{})).status,404);
    assert.equal((await f.request('/does-not-exist')).status,404);
    assert.equal((await f.request('/api/chat',{headers:{cookie:s.cookie}})).status,405);
    assert.equal((await f.request('/api/events?after=not-a-number',{headers:{cookie:s.cookie}})).status,400);
  }finally{await f.app.close();}
});

test('smoke: a JSON null payload is rejected as a client error rather than an internal failure',async()=>{
  const f=await fixture();try{
    const s=await f.start();
    for(const path of ['/api/chat','/api/login','/api/input','/api/approve-operation']){
      for(const payload of ['null','[]','42','"text"']){
        const response=await f.post(s,path,payload);assert.equal(response.status,400,path+' must reject a non-object JSON body');assert.equal((await response.json()).error.code,'JSON_OBJECT_REQUIRED');
      }
    }
    assert.equal((await f.post(s,'/api/catalog',{})).status,200);
  }finally{await f.app.close();}
});
