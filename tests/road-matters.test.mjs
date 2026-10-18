import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoadStore,digest} from '../src/road/store.mjs';
import {RoadMocks} from '../src/road/mocks.mjs';
import {RoadAgent} from '../src/road/agent.mjs';
import {RoadMatters} from '../src/road/matters.mjs';
import {controlledSession} from '../src/road/runtime.mjs';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
const payload={address:{city:'Riyadh',street:'Test Draft Road'},description:'Synthetic pothole report'};
const call=(n,a)=>fauxAssistantMessage(fauxToolCall(n,a),{stopReason:'toolUse'});
async function fixture(store=new RoadStore()){
  await store.initialize();const s=store.create(),mocks=new RoadMocks(store),queue=[];
  const agent=new RoadAgent({store,knowledge:{answer:async()=>null},emotion:{assess:async()=>({status:'classified',sentiment:'neutral'})},api:(...x)=>mocks.call(...x),runtimeFactory:o=>controlledSession({...o,fauxResponses:queue.shift()})});
  await agent.login(s,{username:'demo',password:'demo'});return {s,mocks,agent,store,queue};
}
const finish=s=>()=>call('finish',{state:'completed',message:'actual result',receipt_ids:s.receipts.filter(r=>r.plan_id===s.activePlanId).map(r=>r.id)});
async function draft(f){const d=await f.agent.matters.draft(f.s,payload);await f.agent.prepareDraft(f.s,d);return d;}
function execute(f){f.queue.push([call('create_ticket',{step_id:'create',...f.s.pendingOperation.parameters}),finish(f.s)]);return f.agent.approveOperation(f.s,f.s.pendingOperation.id);}

test('editing an address revokes the exact old confirmation and creates no business call',async()=>{
  const f=await fixture(),d=await draft(f),old=f.s.pendingOperation.id;
  await f.agent.editOperation(f.s,old,{...payload,address:{city:'الرياض',street:'شارع الاختبار'}});
  assert.notEqual(f.s.pendingOperation.id,old);assert.deepEqual(f.s.authorizations,{});assert.equal(f.s.mock.tickets.length,3);
  await assert.rejects(f.agent.approveOperation(f.s,old),{code:'STALE_CONFIRMATION'});await execute(f);
  assert.equal(f.s.receipts[0].parameters.address.street,'شارع الاختبار');const list=await f.agent.matters.list(f.s);assert.equal(list.drafts.find(x=>x.id===d.id).status,'submitted');assert.equal(list.timeline.length,1);assert.equal(list.notifications.length,1);
});
test('invalid edit keeps the original confirmation and draft intact',async()=>{
  const f=await fixture();await draft(f);const old=f.s.pendingOperation.id;await assert.rejects(f.agent.editOperation(f.s,old,{address:{city:'',street:'X'},description:'X'}),{code:'INVALID_EDIT'});assert.equal(f.s.pendingOperation.id,old);
});
test('save for later and a fresh login restore the payload without restoring any approval',async()=>{
  const f=await fixture(),d=await draft(f),old=f.s.pendingOperation.id;await f.agent.saveForLater(f.s,old);assert.equal(f.s.pendingOperation,null);
  const b=f.store.create();await f.agent.login(b,{username:'demo',password:'demo'});await f.agent.resumeDraft(b,d.id,d.version);assert.deepEqual(b.pendingOperation.parameters,payload);assert.deepEqual(b.authorizations,{});assert.notEqual(b.pendingOperation.id,old);assert.equal(b.mock.tickets.length,3);
  await assert.rejects(f.agent.resumeDraft(b,d.id,d.version),{code:'STALE_DRAFT'});
});
test('another session claiming a draft rejects approval from the original tab',async()=>{
  const f=await fixture(),d=await draft(f),old=f.s.pendingOperation.id,b=f.store.create();await f.agent.login(b,{username:'demo',password:'demo'});await f.agent.resumeDraft(b,d.id,d.version);
  await assert.rejects(f.agent.approveOperation(f.s,old),{code:'STALE_DRAFT'});assert.equal(f.s.mock.calls.filter(c=>c.operation==='create_ticket').length,0);
});
test('account boundaries apply to listing, resume, discard, status changes and notification reads',async()=>{
  const f=await fixture(),d=await draft(f);await execute(f);const ticket=f.s.receipts[0].result.ticket.ticket_id;
  const b=f.store.create();await f.agent.login(b,{username:'demo-other',password:'demo'});const list=await f.agent.matters.list(b);assert.equal(list.drafts.length,0);assert(!list.tickets.some(x=>x.ticket_id===ticket));
  await assert.rejects(f.agent.matters.getDraft(b,d.id,d.version),{code:'STALE_DRAFT'});await assert.rejects(f.agent.matters.remove(b,d.id,d.version),{code:'STALE_DRAFT'});await assert.rejects(f.agent.matters.simulate(b,ticket),{code:'TICKET_NOT_FOUND'});await f.agent.matters.markRead(b,[(await f.agent.matters.list(f.s)).notifications[0].id]);assert.equal((await f.agent.matters.list(f.s)).notifications[0].read,false);
});
test('discarding a draft prevents later resume or submission even through a stale session',async()=>{
  const f=await fixture(),d=await draft(f);await f.agent.matters.remove(f.s,d.id,d.version);await assert.rejects(f.agent.approveOperation(f.s,f.s.pendingOperation.id),{code:'STALE_DRAFT'});assert.equal((await f.agent.matters.list(f.s)).tickets.length,3);
});
test('repeat login retains submitted records instead of reseeding the account',async()=>{
  const f=await fixture();await draft(f);await execute(f);const b=f.store.create();await f.agent.login(b,{username:'demo',password:'demo'});assert.equal(b.mock.tickets.length,4);assert.equal((await f.agent.matters.list(b)).timeline.length,1);
});
test('lost response is reconciled from the durable operation ledger without a second mutation',async()=>{
  const f=await fixture();await draft(f);f.s.mock.faults.create_ticket={drop_response_after_commit:true};
  f.queue.push([call('create_ticket',{step_id:'create',...payload}),call('finish',{state:'blocked',message:'Check the result',receipt_ids:[]})]);await f.agent.approveOperation(f.s,f.s.pendingOperation.id);
  assert(f.s.uncertainOperation);assert.equal(f.s.receipts.length,0);assert.equal((await f.agent.matters.list(f.s)).tickets.length,4);
  await f.agent.reconcileOperation(f.s);assert.equal(f.s.uncertainOperation,null);assert.equal(f.s.receipts.length,1);assert.equal(f.s.receipts[0].reconciled,true);assert.equal(f.s.mock.calls.filter(c=>c.operation==='create_ticket').length,1);await f.agent.reconcileOperation(f.s);assert.equal(f.s.receipts.length,1);
});
test('definitive pre-commit failure is checked absent, then the same authorized operation can retry',async()=>{
  const f=await fixture();await draft(f);f.s.mock.faults.create_ticket={failures:1};f.queue.push([call('create_ticket',{step_id:'create',...payload}),call('finish',{state:'blocked',message:'Failed',receipt_ids:[]})]);await f.agent.approveOperation(f.s,f.s.pendingOperation.id);assert(f.s.uncertainOperation);await f.agent.reconcileOperation(f.s);assert.equal(f.s.messages.at(-1).reconcile_state,'absent');
  f.queue.push([call('create_ticket',{step_id:'create',...payload}),finish(f.s)]);await f.agent.retry(f.s);assert.equal(f.s.receipts.length,1);assert.equal((await f.agent.matters.list(f.s)).tickets.length,4);
});
test('operation uncertainty blocks new writes and draft restoration',async()=>{
  const f=await fixture(),d=await draft(f);f.s.uncertainOperation={key:'pending'};await assert.rejects(f.agent.resumeDraft(f.s,d.id,d.version),{code:'RECONCILE_REQUIRED'});await assert.rejects(f.agent.editOperation(f.s,f.s.pendingOperation.id,payload),{code:'RECONCILE_REQUIRED'});
});
test('timeline and unread reminders reflect actual unique mutations and preserve business status semantics',async()=>{
  const f=await fixture();await draft(f);await execute(f);const ticket=f.s.receipts[0].result.ticket.ticket_id;
  await f.agent.matters.simulate(f.s,ticket);await f.agent.matters.simulate(f.s,ticket);await assert.rejects(f.agent.matters.simulate(f.s,ticket),{code:'INVALID_STATUS_TRANSITION'});
  let list=await f.agent.matters.list(f.s);assert.deepEqual(list.timeline.map(x=>x.status),['OPEN','IN_PROGRESS','RESOLVED']);assert(list.timeline.every(x=>x.reference_id&&x.source_type==='mock'));assert.equal(list.notifications.length,3);
  await f.agent.matters.markRead(f.s,list.notifications.map(x=>x.id));list=await f.agent.matters.list(f.s);assert(list.notifications.every(x=>x.read));assert.equal(list.tickets.find(x=>x.ticket_id===ticket).status,'RESOLVED');
});
test('concurrent same-key writes across sessions commit once, different keys retain both changes',async()=>{
  const f=await fixture(),b=f.store.create();await f.agent.login(b,{username:'demo',password:'demo'});const body={...payload,user_id:'U001'};
  const results=await Promise.all([f.mocks.call(f.s.id,'create_ticket',body,{idempotency_key:'shared'}),f.mocks.call(b.id,'create_ticket',body,{idempotency_key:'shared'})]);assert.equal(results[0].ticket.ticket_id,results[1].ticket.ticket_id);
  await Promise.all([f.mocks.call(f.s.id,'create_ticket',body,{idempotency_key:'a'}),f.mocks.call(b.id,'create_ticket',body,{idempotency_key:'b'})]);const list=await f.agent.matters.list(f.s);assert.equal(list.tickets.length,6);assert.equal(list.timeline.length,3);
});
test('file-backed account data survives replacement stores and conversation cookie loss',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'road-account-'));try{const f=await fixture(new RoadStore(dir)),d=await draft(f);await f.agent.saveForLater(f.s,f.s.pendingOperation.id);await f.store.close();const b=await fixture(new RoadStore(dir));assert.equal((await b.agent.matters.list(b.s)).drafts[0].id,d.id);await b.agent.resumeDraft(b.s,d.id,d.version);assert.deepEqual(b.s.pendingOperation.parameters,payload);await b.store.close();}finally{await rm(dir,{recursive:true,force:true});}
});
test('reconciliation data mismatch cannot authorize or fabricate a receipt',async()=>{
  const f=await fixture();await f.mocks.call(f.s.id,'create_ticket',{...payload,user_id:'U001'},{idempotency_key:'key'});f.s.uncertainOperation={key:'key',operation:'create_ticket',parameters:{...payload,description:'different'}};await assert.rejects(f.agent.reconcileOperation(f.s),{code:'IDEMPOTENCY_CONFLICT'});assert(f.s.uncertainOperation);assert.equal(f.s.receipts.length,0);
});

test('restored draft answer keeps a rateable question and immutable feedback evidence',async()=>{
  const f=await fixture(),d=await draft(f);const b=f.store.create();await f.agent.login(b,{username:'demo',password:'demo'});await f.agent.resumeDraft(b,d.id,d.version);
  f.queue.push([call('create_ticket',{step_id:'create',...payload}),()=>call('finish',{state:'completed',message:'Done',receipt_ids:b.receipts.map(r=>r.id)})]);await f.agent.approveOperation(b,b.pendingOperation.id);
  const answer=b.messages.at(-1),snapshot=b.answerSnapshots?.[answer.id];assert(snapshot);assert(snapshot.question.includes('Test Draft Road'));assert.equal(snapshot.tool_results[0].operation,'create_ticket');assert.equal(snapshot.route,'loop');
});

test('losing session persistence after the account commit remains uncertain and is recoverable',async()=>{
  const f=await fixture();await draft(f);const real=f.agent.api;f.agent.api=async(...x)=>{const result=await real(...x);if(x[1]==='create_ticket')throw Object.assign(Error('lease lost after commit'),{code:'SESSION_LEASE_LOST',status:409});return result;};
  f.queue.push([call('create_ticket',{step_id:'create',...payload}),call('finish',{state:'blocked',message:'Check result',receipt_ids:[]})]);await f.agent.approveOperation(f.s,f.s.pendingOperation.id);assert(f.s.uncertainOperation);await f.agent.reconcileOperation(f.s);assert.equal(f.s.receipts.length,1);assert.equal((await f.agent.matters.list(f.s)).tickets.length,4);
});

test('HTTP matters require login and CSRF and hide simulator mutations when demo is disabled',async()=>{
  const {createRoadServer}=await import('../src/road/server.mjs');const {FeedbackRepository}=await import('../src/road/feedback.mjs');
  const app=await createRoadServer({store:new RoadStore(),knowledge:{document:{name:'test'},entries:[]},feedback:new FeedbackRepository({connectionString:null}),demoUI:false,config:{port:10000,host:'127.0.0.1',access:{}}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();
  try{const origin='http://127.0.0.1:'+app.server.address().port,initial=await fetch(origin+'/api/session',{method:'POST'}),state=await initial.json(),cookie=initial.headers.get('set-cookie').split(';')[0];const post=(path,value,csrf=true)=>fetch(origin+path,{method:'POST',headers:{cookie,'content-type':'application/json',...(csrf?{'x-csrf-token':state.csrf}:{})},body:JSON.stringify(value)});
    assert.equal((await post('/api/matters',{action:'list'})).status,200);assert.equal((await post('/api/matters',{action:'read',ids:[]})).status,401);assert.equal((await post('/api/login',{username:'demo',password:'demo'})).status,200);
    assert.equal((await post('/api/matters',{action:'simulate',ticket_id:'T102'})).status,403);assert.equal((await post('/api/matters',{action:'read',ids:[]},false)).status,403);assert.equal((await post('/api/matters',{action:'resume',draft_id:'foreign',version:1})).status,409);
    const latest=await(await fetch(origin+'/api/state',{headers:{cookie}})).json();assert.equal(latest.mock.tickets.find(t=>t.ticket_id==='T102').status,'OPEN');
  }finally{await app.close();}
});

test('restoring a saved draft after an unrelated plan gets its own feedback question',async()=>{
  const f=await fixture(),d=await draft(f);const unrelated=f.store.message(f.s,'user','Show my history only');f.s.plans.push({id:'other',status:'completed',approved:true,origin_message_id:unrelated.id,steps:[]});f.s.activePlanId='other';await f.agent.resumeDraft(f.s,d.id,d.version);
  const origin=f.s.messages.find(m=>m.id===f.agent.active(f.s).origin_message_id);assert.equal(origin.kind,'draft_restore');assert.notEqual(origin.id,unrelated.id);assert(origin.text.includes('Test Draft Road'));
});

test('HTTP approval waits for async draft validation before acknowledging a persisted running turn',async()=>{
  const {createRoadServer}=await import('../src/road/server.mjs');const {FeedbackRepository}=await import('../src/road/feedback.mjs');const store=new RoadStore(),queue=[];
  const app=await createRoadServer({store,knowledge:{document:{name:'test'},entries:[]},feedback:new FeedbackRepository({connectionString:null}),config:{port:10000,host:'127.0.0.1',access:{}},agentFactory:({store,api})=>new RoadAgent({store,api,knowledge:{},runtimeFactory:o=>controlledSession({...o,fauxResponses:queue.shift()})})});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();
  try{const s=store.create();s.csrf='test-csrf';await app.agent.login(s,{username:'demo',password:'demo'});const d=await app.agent.matters.draft(s,payload);await app.agent.prepareDraft(s,d);const original=s.pendingOperation.id;
    let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),get=app.agent.matters.getDraft.bind(app.agent.matters);app.agent.matters.getDraft=async(...args)=>{enter();await gate;return get(...args);};
    queue.push([call('create_ticket',{step_id:'create',...payload}),()=>call('finish',{state:'completed',message:'Done',receipt_ids:s.receipts.map(r=>r.id)})]);
    const origin='http://127.0.0.1:'+app.server.address().port,headers={cookie:'road_session='+s.id,'content-type':'application/json','x-csrf-token':s.csrf};let acknowledged=false;
    const response=fetch(origin+'/api/approve-operation',{method:'POST',headers,body:JSON.stringify({proposal_id:original})}).then(r=>{acknowledged=true;return r;});await entered;await new Promise(r=>setTimeout(r,30));assert.equal(acknowledged,false,'202 must not report the pre-validation idle snapshot');release();
    const r=await response,value=await r.json();assert.equal(r.status,202);assert(!value.pendingOperation);assert(value.running||value.status==='completed');for(let i=0;app.admission.turns&&i<100;i++)await new Promise(r=>setTimeout(r,10));assert.equal(s.receipts.length,1);
    const other=await app.agent.matters.draft(s,payload);await app.agent.prepareDraft(s,other);const stale=s.pendingOperation.id;await app.agent.matters.draft(s,payload,{draftId:other.id,version:other.version});const denied=await fetch(origin+'/api/approve-operation',{method:'POST',headers,body:JSON.stringify({proposal_id:stale})});assert.equal(denied.status,409);assert.equal((await denied.json()).error.code,'STALE_DRAFT');assert.equal(s.receipts.length,1);
  }finally{await app.close();}
});

test('cancel during asynchronous confirmation validation cannot authorize the old payload',async()=>{
  const f=await fixture();await draft(f);const old=f.s.pendingOperation.id;let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r),get=f.agent.matters.getDraft.bind(f.agent.matters);
  f.agent.matters.getDraft=async(...x)=>{enter();await gate;return get(...x);};const pending=f.agent.authorizeOperation(f.s,old);await entered;await f.agent.cancel(f.s);release();await assert.rejects(pending,{code:'STALE_CONFIRMATION'});assert.deepEqual(f.s.authorizations,{});assert.equal(f.s.pendingOperation,null);assert(!f.s.mock.calls.some(c=>c.operation==='create_ticket'));
});
