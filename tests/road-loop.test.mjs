import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage,fauxToolCall } from '@earendil-works/pi-ai';
import { controlledSession } from '../src/road/runtime.mjs';
import { RoadStore } from '../src/road/store.mjs';
import { RoadMocks } from '../src/road/mocks.mjs';
import { RoadAgent,receiptAnswer } from '../src/road/agent.mjs';
import { RoadKnowledge } from '../src/road/knowledge.mjs';
import { createRoadServer,mockHttpClient } from '../src/road/server.mjs';

const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
const step=(id,capability,depends_on=[],parameters={})=>({id,title:capability,capability,depends_on,parameters});
const plan=steps=>call('propose_plan',{goal:'Help this citizen',summary:'Review the requested tasks.',steps});
async function fixture(){
  const store=new RoadStore(),s=store.create(),mocks=new RoadMocks(store),queue=[];
  const knowledge=await RoadKnowledge.load({runtimeFactory:options=>controlledSession({...options,fauxResponses:[call('select_faq',{entry_id:null,answerable:false,reason:'Business request'})]})});
  const agent=new RoadAgent({store,knowledge,api:(...args)=>mocks.call(...args),runtimeFactory:options=>{assert(queue.length,'Missing scripted PI turn');return controlledSession({...options,fauxResponses:queue.shift()});}});
  await agent.login(s,{username:'demo',password:'demo'});return {store,s,mocks,agent,queue};
}
const complete=(s,message='Operation receipt received.')=>()=>call('finish',{state:'completed',message,receipt_ids:s.receipts.filter(r=>r.plan_id===s.activePlanId).map(r=>r.id)});

test('FAQ exact answer bypasses PI loop; disabled entries are excluded; source answer is preserved',async()=>{
  const original=await RoadKnowledge.load();let invoked=0;
  const knowledge=new RoadKnowledge({...original.document,entries:[original.entries[0],{...original.entries[1],enabled:false}]},{runtimeFactory:()=>{invoked++;throw Error('Unexpected model call');}});
  const result=await knowledge.answer(original.entries[0].question);assert.equal(result.answer,original.entries[0].answer);assert.equal(invoked,0);assert.equal(knowledge.entries.length,1);
});
test('semantic FAQ lookup accepts only existing answerable entry, never freeform generated answers',async()=>{
  const k=await RoadKnowledge.load({runtimeFactory:o=>controlledSession({...o,fauxResponses:[call('select_faq',{entry_id:'UNKNOWN',answerable:true,reason:'invented'})]})});
  assert.equal(await k.answer('Different wording'),null);
  k.runtimeFactory=o=>controlledSession({...o,fauxResponses:[call('select_faq',{entry_id:'FAQ-002',answerable:true,reason:'Same Civil Defense invoice question'})]});
  const answer=await k.answer('Are the two Civil Defense and municipal invoices identical?');assert.equal(answer.answer,k.entries.find(x=>x.id==='FAQ-002').answer);
});
test('J-01 PI SDK plan review → exact operation confirmation → one real mock creation with receipt',async()=>{
  const {s,agent,queue}=await fixture();const args={step_id:'create',address:s.user.registeredAddress,description:'Deep pothole beside my home'};
  queue.push([plan([step('create','create_ticket',[],{address:args.address,description:args.description}),step('answer','respond',['create'])])]);
  await agent.chat(s,'Report this pothole');assert.equal(s.status,'review');assert.equal(s.mock.calls.filter(c=>c.operation==='create_ticket').length,0);
  queue.push([call('create_ticket',args)]);await agent.approvePlan(s,s.activePlanId);assert.equal(s.status,'confirmation');assert.equal(s.mock.tickets.length,3);
  const proposal=s.pendingOperation.id;queue.push([call('create_ticket',args),complete(s)]);await agent.approveOperation(s,proposal);
  assert.equal(s.status,'completed');assert.equal(s.mock.tickets.length,4);assert.equal(s.receipts.length,1);assert.equal(s.receipts[0].result.ticket.status,'OPEN');
  await assert.rejects(agent.approveOperation(s,proposal),{code:'STALE_CONFIRMATION'});assert.equal(s.mock.tickets.length,4);
  assert(s.events.some(e=>e.type==='model_result'));assert(s.events.some(e=>e.type==='tool_end'&&e.name==='create_ticket'));
  assert(!JSON.stringify(s).includes('"password"'));
});
test('J-08 queries history before match/unresolved confirmation; handoff remains WAITING',async()=>{
  const {s,agent,queue,mocks}=await fixture();queue.push([plan([step('query','query_tickets'),step('match','input',['query']),step('handoff','handoff_to_human',['match']),step('answer','respond',['handoff'])])]);
  await agent.chat(s,'School pothole is still not fixed. Please follow up.');
  queue.push([call('query_tickets',{step_id:'query'}),call('request_input',{step_id:'match',kind:'ticket',question:'Select the report and confirm it is still unresolved.'})]);await agent.approvePlan(s,s.activePlanId);
  assert.equal(s.pendingInput.candidates.length,3);assert.equal(s.receipts[0].operation,'query_tickets');
  const args={step_id:'handoff',ticket_id:'T101',reason:'Still unresolved after repeat contact',conversation_summary:'Citizen confirms school pothole report is still unresolved. SLA exceeded per mock context.'};
  queue.push([call('handoff_to_human',args)]);await agent.answerInput(s,s.pendingInput.id,{ticket_id:'T101',matched:true,unresolved:true});assert.equal(s.status,'confirmation');
  queue.push([call('handoff_to_human',args),complete(s)]);await agent.approveOperation(s,s.pendingOperation.id);
  assert.equal(s.status,'completed');const h=s.mock.handoffs[0];assert.equal(h.status,'WAITING');assert.equal(h.decisionContext.demoRule,true);assert.equal(s.mock.tickets[0].status,'IN_PROGRESS');
  for(const action of ['accept','escalate','complete'])await mocks.call(s.id,'handoff_to_human',{user_id:s.user.user_id,ticket_id:'T101',handoff_id:h.handoff_id,action},{epoch:s.epoch,idempotency_key:action});
  assert.equal(h.status,'COMPLETED');assert.equal(s.mock.tickets[0].status,'IN_PROGRESS');
});
test('handoff cannot bypass unresolved confirmation or treat terminal report as unresolved',async()=>{
  const {s,agent,queue}=await fixture();queue.push([plan([step('q','query_tickets'),step('h','handoff_to_human',['q'])])]);await agent.chat(s,'Follow up');
  queue.push([call('query_tickets',{step_id:'q'}),call('handoff_to_human',{step_id:'h',ticket_id:'T101',reason:'Need help',conversation_summary:'User requests follow-up'}),call('finish',{state:'blocked',message:'Ticket confirmation required.',receipt_ids:[]})]);await agent.approvePlan(s,s.activePlanId);
  assert.equal(s.mock.handoffs.length,0);assert.equal(s.pendingOperation,null);assert(s.events.some(e=>e.result?.error==='TICKET_CONFIRMATION_REQUIRED'));
  s.facts.ticketConfirmation={ticket_id:'T103',matched:true,unresolved:true,query_receipt_id:s.receipts[0].id};
  queue.push([call('handoff_to_human',{step_id:'h',ticket_id:'T103',reason:'Still unresolved',conversation_summary:'Confirmed'}),call('finish',{state:'blocked',message:'Closed report is not eligible.',receipt_ids:[]})]);await agent.retry(s);assert(s.events.some(e=>e.result?.error==='INELIGIBLE_TICKET'));
});
test('FAQ during HITL preserves draft; business intent switch revokes old proposal',async()=>{
  const {s,agent,queue}=await fixture();const args={step_id:'c',address:s.user.registeredAddress,description:'Pothole'};
  queue.push([plan([step('c','create_ticket')])]);await agent.chat(s,'Create');queue.push([call('create_ticket',args)]);await agent.approvePlan(s,s.activePlanId);
  const proposal=s.pendingOperation.id,oldPlan=s.activePlanId;await agent.chat(s,'Is the municipal fees invoice the same as the Civil Defense fees invoice?');
  assert.equal(s.pendingOperation.id,proposal);assert.equal(s.activePlanId,oldPlan);assert.equal(s.messages.at(-1).kind,'faq');assert.equal(s.mock.tickets.length,3);
  queue.push([plan([step('q','query_tickets'),step('a','respond',['q'])])]);await agent.chat(s,'Instead, show my previous reports');
  assert.notEqual(s.activePlanId,oldPlan);assert.equal(s.pendingOperation,null);await assert.rejects(agent.approveOperation(s,proposal),{code:'STALE_CONFIRMATION'});assert.equal(s.mock.tickets.length,3);
});
test('reviewed known parameters and step dependency cannot silently change',async()=>{
  const {s,agent,queue}=await fixture();queue.push([plan([step('q','query_tickets',[],{ticket_id:'T101'}),step('close','close_ticket',['q'],{ticket_id:'T101'})])]);await agent.chat(s,'Close school report');
  queue.push([call('close_ticket',{step_id:'close',ticket_id:'T101'}),call('query_tickets',{step_id:'q',ticket_id:'T102'}),call('finish',{state:'blocked',message:'Cannot change reviewed target.',receipt_ids:[]})]);await agent.approvePlan(s,s.activePlanId);
  assert(s.events.some(e=>e.result?.error==='DEPENDENCY_PENDING'));assert(s.events.some(e=>e.result?.error==='PLAN_PARAMETERS_CHANGED'));assert.equal(s.mock.calls.length,1);
});
test('closure and complaint use same generic registry with exact approval and owned lookup',async()=>{
  for(const operation of ['close_ticket','complain_ticket']){
    const {s,agent,queue}=await fixture(),args={step_id:'act',ticket_id:'T101',...(operation==='complain_ticket'?{reason:'Repeated delay'}:{})};
    queue.push([plan([step('q','query_tickets'),step('act',operation,['q']),step('a','respond',['act'])])]);await agent.chat(s,'Please '+operation);
    queue.push([call('query_tickets',{step_id:'q'}),call(operation,args)]);await agent.approvePlan(s,s.activePlanId);assert(s.pendingOperation);
    queue.push([call(operation,args),complete(s)]);await agent.approveOperation(s,s.pendingOperation.id);assert.equal(s.status,'completed');assert.equal(s.receipts.at(-1).operation,operation);
  }
});
test('unknown receipt cannot complete a business plan',async()=>{
  const {s,agent,queue}=await fixture();queue.push([plan([step('q','query_tickets')])]);await agent.chat(s,'History');
  queue.push([call('finish',{state:'completed',message:'Done',receipt_ids:['forged']}),call('finish',{state:'completed',message:'Done',receipt_ids:[]}),call('finish',{state:'blocked',message:'No completed query.',receipt_ids:[]})]);await agent.approvePlan(s,s.activePlanId);assert.equal(s.status,'blocked');assert(s.events.some(e=>e.result?.error==='UNKNOWN_RECEIPT'));assert(s.events.some(e=>e.result?.error==='UNFINISHED_PLAN'));
});
test('public completed result is rendered only from receipts, including empty history',()=>{
  const answer=receiptAnswer([{operation:'query_tickets',result:{tickets:[]}}]);assert.equal(answer,'Mock operation results:\nTicket history: 0');
  const created=receiptAnswer([{operation:'create_ticket',result:{ticket:{ticket_id:'T-REAL',status:'OPEN',address:{city:'Riyadh',street:'Test Road'}}}}],'zh');assert(created.includes('T-REAL · OPEN'));assert(!created.includes('repaired'));
});
test('mock mutation rejects wrong identity and late interrupted turn; response loss replays once',async()=>{
  const {s,mocks}=await fixture();const data={user_id:s.user.user_id,address:{city:'الرياض',street:'طريق الاختبار'},description:'حفرة'};
  await assert.rejects(mocks.call(s.id,'create_ticket',{...data,user_id:'U002'},{epoch:s.epoch,idempotency_key:'x'}),{code:'IDENTITY_MISMATCH'});
  s.mock.faults.create_ticket={delay_before_commit_ms:30};const late=mocks.call(s.id,'create_ticket',data,{epoch:s.epoch,idempotency_key:'late'});s.epoch++;await assert.rejects(late,{code:'STALE_TURN'});assert.equal(s.mock.tickets.length,3);
  s.mock.faults.create_ticket={drop_response_after_commit:true};await assert.rejects(mocks.call(s.id,'create_ticket',data,{epoch:s.epoch,idempotency_key:'lost'}),{code:'RESPONSE_LOST'});
  const replay=await mocks.call(s.id,'create_ticket',data,{epoch:s.epoch,idempotency_key:'lost'});assert.equal(s.mock.tickets.length,4);assert.equal(replay.ticket.address.street,'طريق الاختبار');
  await assert.rejects(mocks.call(s.id,'create_ticket',{...data,description:'changed'},{epoch:s.epoch,idempotency_key:'lost'}),{code:'IDEMPOTENCY_CONFLICT'});
});
test('persisted running session restarts interrupted without replaying mutations or approvals',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'road-store-'));try{const store=new RoadStore(dir);await store.initialize();const s=store.create();s.running=true;s.authorizations={foo:{epoch:0}};s.pendingOperation={id:'old'};await store.save(s);const restored=new RoadStore(dir);await restored.initialize();const next=restored.get(s.id);assert.equal(next.status,'interrupted');assert.equal(next.running,false);assert.deepEqual(next.authorizations,{});assert.equal(next.pendingOperation,null);assert.equal(next.mock.tickets.length,0);}finally{await rm(dir,{recursive:true});}
});
test('HTTP server binds cookies/CSRF, restricts mock APIs, and retries identical committed request',async()=>{
  const app=await createRoadServer({store:new RoadStore(),config:{port:10000,host:'127.0.0.1',access:{}},mockKey:'private-test-key'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();const origin=`http://127.0.0.1:${app.server.address().port}`;
  try{
    let r=await fetch(origin+'/api/session',{method:'POST'});const s=await r.json(),cookie=r.headers.get('set-cookie').split(';')[0];
    r=await fetch(origin+'/api/login',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({username:'demo',password:'demo'})});assert.equal(r.status,403);
    r=await fetch(origin+'/api/login',{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':s.csrf,origin:'https://evil.example'},body:'{}'});assert.equal(r.status,403);
    r=await fetch(origin+'/mock/query_tickets',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,403);
    const api=mockHttpClient({origin,key:'private-test-key'});await api(s.id,'login',{username:'demo',password:'demo'});const session=app.store.get(s.id);session.mock.faults.create_ticket={drop_response_after_commit:true};
    const result=await api(s.id,'create_ticket',{user_id:'U001',address:{city:'Riyadh',street:'Mock Street'},description:'Test'},{epoch:0,idempotency_key:'one'});assert(result.ticket.ticket_id);assert.equal(session.mock.tickets.length,4);assert.equal(session.mock.calls.filter(x=>x.operation==='create_ticket').length,2);assert.equal(session.mock.calls.at(-1).replayed,true);
    r=await fetch(origin+'/api/state',{headers:{cookie}});assert.equal(r.status,200);assert.equal((await r.json()).mock.tickets.length,4);
    r=await fetch(origin+'/api/state');assert.equal(r.status,401);
    r=await fetch(origin+'/');assert.equal(r.status,200);assert((await r.text()).includes('任务计划'));
  }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}
});
