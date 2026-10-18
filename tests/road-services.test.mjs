import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {RoadKnowledge} from '../src/road/knowledge.mjs';
import {RoadAgent} from '../src/road/agent.mjs';
import {RoadStore} from '../src/road/store.mjs';
import {RoadMocks} from '../src/road/mocks.mjs';
import {controlledSession} from '../src/road/runtime.mjs';
import {services} from '../src/road/services.mjs';
import {createRoadServer} from '../src/road/server.mjs';
import {FeedbackRepository} from '../src/road/feedback.mjs';
import {auditKnowledge} from '../scripts/road-knowledge-audit.mjs';
const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
async function fixture({gate,negative=false,humanSupport}={}){
  const store=new RoadStore(),s=store.create(),mocks=new RoadMocks(store),queue=[];
  const knowledge=await RoadKnowledge.load({runtimeFactory:o=>controlledSession({...o,fauxResponses:[gate??call('select_faq',{entry_id:null,answerable:false,reason:'No complete source answer'})]})});
  const agent=new RoadAgent({store,knowledge,api:(...args)=>mocks.call(...args),humanSupport,emotion:{assess:async input=>({status:'classified',sentiment:negative?'negative':'neutral',message_id:input.current_message_id})},runtimeFactory:o=>{assert(queue.length,'Unexpected business loop');return controlledSession({...o,fauxResponses:queue.shift()});}});
  return {store,s,mocks,knowledge,agent,queue};
}
test('a context-free source question asks for service; the selection answers the original question and captures its identity',async()=>{
  const {s,agent}=await fixture();await agent.chat(s,'Who can apply for this service?');const questionId=s.messages[0].id,choice=s.pendingKnowledge.id;
  assert.equal(s.status,'clarification');assert.equal(s.mock.calls.length,0);assert(!s.events.some(e=>e.type==='emotion_started'));
  await agent.selectService(s,'infrastructure-permit',choice);assert.equal(s.pendingKnowledge,null);assert.equal(s.messages.at(-1).source.id,'FAQ-005');assert.equal(s.answerSnapshots[s.messages.at(-1).id].question_message_id,questionId);assert.equal(s.serviceContext.scope,'infrastructure-permit');
  await assert.rejects(agent.selectService(s,'civil-defense-fees',choice),{code:'STALE_SERVICE_CHOICE'});
});
test('named service answers establish context, and a follow-up needs no repeated full question',async()=>{
  const {s,agent,knowledge}=await fixture();await agent.chat(s,knowledge.entries.find(e=>e.id==='FAQ-004').question);await agent.chat(s,'Who can apply for this service?');assert.equal(s.messages.at(-1).source.id,'FAQ-005');assert.equal(s.pendingKnowledge,null);assert.equal(s.mock.calls.length,0);
});
test('a typed service selection resumes the stored question rather than replacing it',async()=>{
  const {s,agent}=await fixture();await agent.chat(s,'Who can apply for this service?');await agent.chat(s,'Infrastructure permit');assert.equal(s.messages.at(-1).source.id,'FAQ-005');assert.equal(s.pendingKnowledge,null);
});
test('switching service cannot reuse another service fee or applicant answer',async()=>{
  const {knowledge}=await fixture({gate:call('select_faq',{entry_id:'FAQ-008',answerable:true,reason:'Wrong service selected by fixture'})});
  const result=await knowledge.answer('Are there fees for reporting a pothole?',{context:{service_scope:'infrastructure-permit'}});assert.equal(result,null);
  const vague=await knowledge.answer('Who can apply for this service?',{context:{service_scope:'road-pothole'}});assert.equal(vague.status,'clarify');
});
test('knowledge service errors remain distinguishable from a knowledge miss and do not start business',async()=>{
  const {agent,s,knowledge}=await fixture();knowledge.runtimeFactory=()=>{throw Error('offline');};await agent.chat(s,'A knowledge question with no exact match');assert.equal(s.messages.at(-1).knowledge_state,'unavailable');assert.equal(s.plans.length,0);assert.equal(s.mock.calls.length,0);assert(!s.events.some(e=>e.type==='faq_miss'));
});
test('clarifying a side question preserves an exact pending business proposal',async()=>{
  const {agent,s}=await fixture();s.pendingOperation={id:'proposal'};s.authorizations={existing:{epoch:s.epoch}};
  await agent.chat(s,'Who can apply for this service?');await agent.selectService(s,'infrastructure-permit',s.pendingKnowledge.id);assert.equal(s.pendingOperation.id,'proposal');assert(s.authorizations.existing);assert.equal(s.mock.calls.length,0);
});
test('a service with no relevant FAQ gives a knowledge gap and never guesses another department answer',async()=>{
  const {agent,s}=await fixture();await agent.chat(s,'Who can apply for this service?');await agent.selectService(s,'civil-defense-fees',s.pendingKnowledge.id);assert.equal(s.messages.at(-1).knowledge_state,'missing');assert.equal(s.pendingKnowledge,null);assert.equal(s.mock.calls.length,0);
});
test('knowledge audit preserves all original evidence and detects source edits, ambiguity and missing policy proof',async()=>{
  const read=name=>readFile(new URL('../src/knowledge/'+name,import.meta.url),'utf8').then(JSON.parse),original=await read('road-faq.original.json'),cleaned=await read('road-faq.json');const report=auditKnowledge(cleaned,original);
  assert.equal(report.structural_errors,0);assert.equal(report.entries,9);assert.equal(report.missing_source_entries,17);assert.equal(report.policy_verified_entries,0);
  cleaned.entries[0].original_answer='Invented';cleaned.entries[1].question='Who can apply for this service?';const broken=auditKnowledge(cleaned,original);assert(broken.rows[0].errors.includes('original_evidence_changed'));assert(broken.rows[0].errors.includes('source_hash_mismatch'));assert(broken.rows[1].errors.includes('canonical_question_depends_on_context'));
});
test('catalog entries expose consultation versus mock transactions without invoking any business tools',async()=>{
  const {agent,s}=await fixture();await agent.chat(s,'服务目录');assert.equal(s.messages.at(-1).kind,'service_catalog');await agent.selectService(s,'infrastructure-permit');assert.equal(s.messages.at(-1).kind,'service_overview');assert.equal(s.mock.calls.length,0);assert.equal(services.filter(e=>e.mode==='mock_transaction').length,1);
});
test('negative sentiment offers human help; declining can complete the original status-only request',async()=>{
  const {agent,s,queue}=await fixture({negative:true});await agent.login(s,{username:'demo',password:'demo'});await agent.chat(s,'I am angry. Show my ticket history only; do not transfer.');assert.equal(s.status,'human_offer');assert.equal(s.mock.handoffs.length,0);
  queue.push([call('propose_plan',{goal:'Show history',summary:'Query only.',steps:[{id:'q',capability:'query_tickets',title:'Query history',depends_on:[],parameters:{}},{id:'a',capability:'respond',title:'Answer',depends_on:['q'],parameters:{}}]}),call('query_tickets',{step_id:'q'}),()=>call('finish',{state:'completed',message:'Done',receipt_ids:s.receipts.map(r=>r.id)})]);
  const choice=s.pendingHelp.id;await agent.helpChoice(s,choice,'continue');assert.equal(s.status,'completed');assert.equal(s.receipts[0].operation,'query_tickets');assert.equal(s.mock.handoffs.length,0);await assert.rejects(agent.helpChoice(s,choice,'queue'),{code:'STALE_HELP'});
});
test('unavailable simulated support leaves a usable assistant exit and no fictitious queue receipt',async()=>{
  const {agent,s}=await fixture({humanSupport:{available:false,wait_limit_ms:1000}});await agent.offerHelp(s);await assert.rejects(agent.helpChoice(s,s.pendingHelp.id,'queue'),{code:'HUMAN_UNAVAILABLE'});assert.equal(s.mock.handoffs.length,0);assert.equal(s.receipts.length,0);await agent.helpChoice(s,s.pendingHelp.id,'continue');assert.equal(s.pendingHelp,null);assert.equal(s.status,'answered');
});
test('HTTP help is session-bound, cancellable, deadline-aware and preserves the handoff summary',async()=>{
  const app=await createRoadServer({store:new RoadStore(),feedback:new FeedbackRepository({connectionString:null}),humanSupport:{available:true,wait_limit_ms:1},config:{port:10000,host:'127.0.0.1',access:{}}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();const base='http://127.0.0.1:'+app.server.address().port;
  try{
    const initial=await fetch(base+'/api/session',{method:'POST'}),s=await initial.json(),cookie=initial.headers.get('set-cookie').split(';')[0];
    const post=(path,data)=>fetch(base+path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':s.csrf},body:JSON.stringify(data)});
    assert.equal((await fetch(base+'/api/help',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{"action":"offer"}'})).status,403);
    await post('/api/help',{action:'offer'});let state=await(await fetch(base+'/api/state',{headers:{cookie}})).json();assert.equal(state.status,'human_offer');const choice=state.pendingHelp.id;
    assert.equal((await post('/api/help',{action:'queue',request_id:'other-session-choice'})).status,409);
    assert.equal((await post('/api/help',{action:'queue',request_id:choice})).status,200);state=await(await fetch(base+'/api/state',{headers:{cookie}})).json();const h=state.mock.handoffs[0];assert(h.conversation_summary.includes('service_scope'));assert.equal(state.human_support.mode,'simulated');
    await new Promise(r=>setTimeout(r,5));state=await(await fetch(base+'/api/state',{headers:{cookie}})).json();assert.equal(state.human_support.wait_expired,true);assert.equal((await post('/api/human',{handoff_id:h.handoff_id,action:'accept'})).status,409);
    assert.equal((await post('/api/human',{handoff_id:h.handoff_id,action:'cancel'})).status,200);state=await(await fetch(base+'/api/state',{headers:{cookie}})).json();assert.equal(state.activeHandoffId,null);assert.equal(state.mock.handoffs[0].status,'CANCELLED');assert.equal(state.mock.tickets.length,0);
  }finally{await app.close();}
});

test('negative statements mentioning this service are not service clarification questions',async()=>{
 const {knowledge}=await fixture({gate:call('select_faq',{entry_id:null,answerable:false,needs_clarification:true,reason:'Incorrect suggestion from fixture'})});
 for(const text of ['我对这个服务非常失望，已经烦死了。','I am extremely disappointed with this service.','طفشت من هالخدمة، أنا محبط جداً.'])assert.equal(await knowledge.answer(text),null);
});

test('an explicit choice of road service produces a knowledge gap instead of another clarification loop',async()=>{
 const {agent,s}=await fixture();await agent.chat(s,'Who can apply for this service?');await agent.selectService(s,'road-pothole',s.pendingKnowledge.id);assert.equal(s.pendingKnowledge,null);assert.equal(s.messages.at(-1).knowledge_state,'missing');assert(s.answerSnapshots[s.messages.at(-1).id]);
});
