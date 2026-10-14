import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {RoadStore} from '../src/road/store.mjs';
import {RoadAgent} from '../src/road/agent.mjs';
import {controlledSession} from '../src/road/runtime.mjs';
import {RoadMocks} from '../src/road/mocks.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
const plan=()=>call('propose_plan',{goal:'Report the pothole',summary:'Collect the address, then create the report.',steps:[{id:'address',title:'Collect pothole location',capability:'input',depends_on:[],parameters:{}},{id:'create',title:'Create report',capability:'create_ticket',depends_on:['address'],parameters:{}}]});
test('an agent awaiting plan review writes an actionable assistant message into chat history',async()=>{
  const store=new RoadStore(),s=store.create();
  const agent=new RoadAgent({store,knowledge:{answer:async()=>null},api:async()=>{throw Error('No API expected');},runtimeFactory:o=>controlledSession({...o,fauxResponses:[plan()]})});
  await agent.chat(s,'There is a big pothole in the road in front of my house');
  assert.equal(s.status,'review');assert(s.messages.some(m=>m.role==='assistant'&&m.kind==='plan'&&m.plan_id===s.activePlanId&&/continue|review|确认/i.test(m.text)));
});
async function fixture(){const store=new RoadStore(),s=store.create(),mocks=new RoadMocks(store),queue=[];const agent=new RoadAgent({store,knowledge:{answer:async()=>null},api:(...a)=>mocks.call(...a),runtimeFactory:o=>controlledSession({...o,fauxResponses:queue.shift()})});await agent.login(s,{username:'demo',password:'demo'});return {store,s,agent,queue};}
const stepsPlan=steps=>call('propose_plan',{goal:'Handle request',summary:'Follow these steps.',steps:steps.map(([id,capability,depends_on])=>({id,title:capability,capability,depends_on,parameters:{}}))});
test('a mutation waiting for HITL writes a chat confirmation without executing the API',async()=>{
  const {s,agent,queue}=await fixture();queue.push([stepsPlan([['create','create_ticket',[]],['respond','respond',['create']]])]);await agent.chat(s,'请报修家门口的坑洞');queue.push([call('create_ticket',{step_id:'create',address:s.user.registeredAddress,description:'Pothole'})]);await agent.approvePlan(s,s.activePlanId);
  assert(s.messages.some(m=>m.role==='assistant'&&m.kind==='operation_confirmation'&&m.proposal_id===s.pendingOperation.id&&m.text.includes('确认')));assert.equal(s.mock.tickets.length,3);
});
test('ticket input requires explicit unresolved true/false and records a human-readable reply',async()=>{
  const {s,agent,queue}=await fixture();queue.push([stepsPlan([['query','query_tickets',[]],['match','input',['query']],['respond','respond',['match']]])]);await agent.chat(s,'查询历史工单');queue.push([call('query_tickets',{step_id:'query'}),call('request_input',{step_id:'match',kind:'ticket',question:'Which ticket?'})]);await agent.approvePlan(s,s.activePlanId);
  const input=s.pendingInput.id;await assert.rejects(agent.answerInput(s,input,{ticket_id:'T101',matched:true}),{code:'UNRESOLVED_ANSWER_REQUIRED'});assert.equal(s.pendingInput.id,input);
  queue.push([call('finish',{state:'answered',message:'The selected issue has been resolved.',receipt_ids:[]})]);await agent.answerInput(s,input,{ticket_id:'T101',matched:true,unresolved:false});
  const reply=s.messages.find(m=>m.role==='user'&&m.kind==='input');assert(reply.text.includes('T101'));assert(!reply.text.startsWith('{'));assert.equal(reply.value.unresolved,false);assert.equal(agent.active(s).steps.at(-1).status,'completed');
});
test('already registered address can satisfy an input step without asking again',async()=>{
  const {s,agent,queue}=await fixture();queue.push([stepsPlan([['address','input',[]],['respond','respond',['address']]])]);await agent.chat(s,'Use my registered address');queue.push([call('request_input',{step_id:'address',kind:'address',question:'Address?'}),call('finish',{state:'completed',message:'Confirmed.',receipt_ids:[]})]);await agent.approvePlan(s,s.activePlanId);
  assert.equal(s.pendingInput,null);assert.equal(agent.active(s).steps[0].status,'completed');assert(s.events.some(e=>e.type==='input_available'));
});
test('stored answered conversations recover the finished response task without replaying operations',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'road-chat-history-'));try{
    const store=new RoadStore(dir);await store.initialize();const s=store.create();s.status='answered';s.activePlanId='old-plan';s.plans=[{id:'old-plan',approved:true,status:'approved',steps:[{capability:'query_tickets',status:'completed'},{capability:'respond',status:'pending'}]}];await store.save(s);
    const restored=new RoadStore(dir);await restored.initialize();assert.equal(restored.get(s.id).plans[0].status,'completed');assert.equal(restored.get(s.id).plans[0].steps[1].status,'completed');assert.equal(restored.get(s.id).mock.calls.length,0);
  }finally{await rm(dir,{recursive:true});}
});
