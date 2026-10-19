import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoadServer} from '../src/road/server.mjs';
import {RoadStore} from '../src/road/store.mjs';
import {FeedbackRepository} from '../src/road/feedback.mjs';
import {CrmAgent} from '../src/crm/agent.mjs';
import {controlledSession} from '../src/road/runtime.mjs';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
async function fixture(){const key='private-test-simulation-key',queue=[];const app=await createRoadServer({store:new RoadStore(),feedback:new FeedbackRepository({connectionString:null}),mockKey:key,knowledge:{document:{name:'test'},entries:[],answer:async()=>null},config:{host:'127.0.0.1',port:10000,access:{}},agentFactory:options=>new CrmAgent({...options,emotion:{assess:async input=>({status:'classified',sentiment:'neutral',message_id:input.current_message_id})},runtimeFactory:o=>controlledSession({...o,fauxResponses:queue.shift()})})});await new Promise((r,j)=>{app.server.once('error',j);app.server.listen(0,'127.0.0.1',r);});await app.ready();const origin='http://127.0.0.1:'+app.server.address().port;const response=await fetch(origin+'/api/session',{method:'POST'}),state=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];return {app,origin,state,cookie,key,queue,session:app.store.get(state.id)};}
test('HTTP active service exposes CRM identity, 35 typed tools and validated OpenAPI, legacy APIs return Gone',async()=>{
  const f=await fixture();try{const health=await (await fetch(f.origin+'/healthz')).json();assert.equal(health.service,'balady-crm');assert.equal(health.tools,35);assert.equal(health.api_mode,'simulation');
  assert.equal((await fetch(f.origin+'/mock/query_tickets',{method:'POST'})).status,410);
  const spec=await (await fetch(f.origin+'/api/openapi')).json();assert.equal(spec.openapi,'3.0.3');
  const catalog=await (await fetch(f.origin+'/api/tools')).json();assert.equal(catalog.identity,'BALADY Assistant');assert.equal(catalog.operations.length,35);assert.ok(catalog.operations.every(x=>x.input.additionalProperties===false));
  for(const path of ['/markdown.js','/vendor/marked.js']){const asset=await fetch(f.origin+path);assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);assert.ok((await asset.text()).length>100);}
  const diagram=await fetch(f.origin+'/docs/balady-crm-flow.html');assert.equal(diagram.status,200);assert.match(await diagram.text(),/35 business tools/);assert.match(diagram.headers.get('content-security-policy'),/script-src 'none'/);
  assert.equal((await fetch(f.origin+'/v1/crm-services/asset-details')).status,403);
  const authorized=await fetch(f.origin+'/v1/crm-services/asset-details',{headers:{'x-crm-simulation-key':f.key,'x-road-session':f.state.id,'x-crm-epoch':'0'}});const value=await authorized.json();assert.equal(value.statusDetails.code,200);assert.equal(value.data.result[0].MainAssetsID,'MA-DEMO-1');assert.equal(value.ok,undefined);
  }finally{await f.app.close();}
});
test('HTTP authenticated-session actions enforce CSRF and show exact CRM confirmation before any write',async()=>{
  const f=await fixture();try{
    const post=(path,value,csrf=true)=>fetch(f.origin+path,{method:'POST',headers:{cookie:f.cookie,'content-type':'application/json',...(csrf?{'x-csrf-token':f.state.csrf}:{})},body:JSON.stringify(value)});
    assert.equal((await post('/api/chat',{message:'Record outcome'},false)).status,403);
    const steps=[{id:'write',title:'Record vehicle withdrawal',capability:'crm_update_vehicle_status',depends_on:[]},{id:'reply',title:'Show receipt',capability:'respond',depends_on:['write']}],args={step_id:'write',body:{IncidentID:'INC-26-10-000001',Status:1}};
    f.queue.push([call('propose_plan',{goal:'Record MOI outcome',summary:'Record the withdrawal result.',steps}),call('crm_update_vehicle_status',args)]);
    assert.equal((await post('/api/chat',{message:'Record MOI vehicle withdrawal status 1 for INC-26-10-000001'})).status,202);
    for(let i=0;i<200&&f.session.running;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.session.status,'confirmation');assert.equal(f.session.crm.calls.length,0);
    const proposal=f.session.pendingOperation.id;f.queue.push([call('crm_update_vehicle_status',args),()=>call('finish',{state:'completed',message:'Result recorded.',receipt_ids:f.session.receipts.map(x=>x.id)})]);assert.equal((await post('/api/approve-operation',{proposal_id:proposal})).status,202);
    for(let i=0;i<200&&f.session.running;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.session.status,'completed');assert.equal(f.session.crm.calls.length,1);assert.equal((await post('/api/approve-operation',{proposal_id:proposal})).status,409);
    const saved=await (await fetch(f.origin+'/api/state',{headers:{cookie:f.cookie}})).json();assert.equal(saved.api_mode,'simulation');assert.equal(saved.receipts[0].operation,'crm_update_vehicle_status');assert.ok(!JSON.stringify(saved).includes(f.key));
  }finally{await f.app.close();}
});
