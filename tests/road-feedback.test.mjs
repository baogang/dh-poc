import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {RoadStore} from '../src/road/store.mjs';
import {RoadAgent} from '../src/road/agent.mjs';
import {RoadMocks} from '../src/road/mocks.mjs';
import {controlledSession} from '../src/road/runtime.mjs';
import {captureAnswer} from '../src/road/feedback-context.mjs';
import {createRoadServer} from '../src/road/server.mjs';
import {createFeedbackController} from '../web/road/feedback-ui.js';
import {feedbackStats,feedbackExport} from '../web/road/feedback-data.js';
import {FeedbackRepository} from '../src/road/feedback.mjs';
const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
const backup=()=>({rows:new Map(),async all(){return [...this.rows.values()];},async put(row){this.rows.set(row.feedback_id,row);}});
const record=(rating='satisfied',version=1)=>({feedback_id:'f1',answer_message_id:'a1',session_id:'s1',rating,version,created_at:'2026-10-16T00:00:00Z',updated_at:'2026-10-16T00:00:00Z',snapshot:{question:'Question',answer:'Answer'},review_status:'unreviewed'});
test('feedback cache is bounded, reloads evicted sessions and refreshes another instance revisions',async()=>{
 const repository=new FeedbackRepository({pool:{},cacheLimit:2,cacheTtlMs:0});let revision=1;
 repository.list=async()=>[{...record('satisfied',revision)}];
 await repository.load('one');await repository.load('two');await repository.load('three');assert.equal(repository.cache.size,2);assert.equal(repository.loadedAt.size,2);assert.equal(repository.loads.size,0);assert.deepEqual(repository.cached('one'),{});
 revision=2;await repository.load('one');assert.equal(repository.cached('one').a1.version,2);assert.equal(repository.cache.size,2);revision=1;repository.remember('one',record('satisfied',1));assert.equal(repository.cached('one').a1.version,2);
});

test('business feedback keeps the original question through a FAQ interruption and exact HITL resume',async()=>{
 const store=new RoadStore(),s=store.create(),mocks=new RoadMocks(store),queue=[];
 const knowledge={document:{version:'test'},answer:async text=>text==='FAQ question'?{answer:'Verified FAQ answer',entry:{id:'FAQ-002',question:'FAQ question'}}:null};
 const agent=new RoadAgent({store,knowledge,automaticPlans:false,emotion:{assess:async i=>({status:'classified',sentiment:'neutral',message_id:i.current_message_id})},api:(...args)=>mocks.call(...args),runtimeFactory:o=>controlledSession({...o,fauxResponses:queue.shift()})});
 await agent.login(s,{username:'demo',password:'demo'});
 const steps=[{id:'create',title:'Create',capability:'create_ticket',depends_on:[],parameters:{}},{id:'reply',title:'Reply',capability:'respond',depends_on:['create'],parameters:{}}];
 queue.push([call('propose_plan',{goal:'Create report',summary:'Create then answer',steps})]);await agent.chat(s,'Original business question');const questionId=s.messages.findLast(m=>m.role==='user').id;
 const args={step_id:'create',address:s.user.registeredAddress,description:'Mock pothole'};
 queue.push([call('create_ticket',args)]);await agent.approvePlan(s,s.activePlanId);const pending=s.pendingOperation.id;
 await agent.chat(s,'FAQ question');const faqAnswer=s.messages.at(-1),faqSnapshot=s.answerSnapshots[faqAnswer.id];assert.equal(faqSnapshot.question,'FAQ question');assert.equal(faqSnapshot.route,'faq');assert.equal(faqSnapshot.plan,null);
 queue.push([call('create_ticket',args),()=>call('finish',{state:'completed',message:'Done',receipt_ids:s.receipts.map(r=>r.id)})]);await agent.approveOperation(s,pending);
 const answer=s.messages.at(-1),snapshot=s.answerSnapshots[answer.id];assert.equal(snapshot.question_message_id,questionId);assert.equal(snapshot.question,'Original business question');assert.equal(snapshot.plan.id,s.activePlanId);assert.equal(snapshot.trigger_message_id,s.messages.findLast(m=>m.kind==='decision').id);assert.equal(snapshot.tool_results[0].operation,'create_ticket');
 const frozen=JSON.stringify(snapshot);s.emotion={status:'classified',sentiment:'negative'};s.plans[0].goal='Changed later';assert.equal(JSON.stringify(snapshot),frozen);assert.equal(faqSnapshot.answer,'Verified FAQ answer');assert(store.view(s).messages.find(m=>m.id===answer.id).rateable);assert(!JSON.stringify(store.view(s)).includes('answerSnapshots'));
});
test('answer snapshots whitelist evidence, redact credential text and omit login/authorization internals',()=>{
 const store=new RoadStore(),s=store.create();s.csrf='csrf-value';s.authorizations={secret:'private'};s.user={password:'never-capture'};
 const q=store.message(s,'user','password=hidden postgresql://u:p@example.invalid/db');const a=store.message(s,'assistant','Safe answer',{kind:'result'});const snap=captureAnswer(s,a,{questionId:q.id});const text=JSON.stringify(snap);
 assert(!text.includes('csrf-value'));assert(!text.includes('never-capture'));assert(!text.includes('u:p@'));assert(!text.includes('password=hidden'));assert.equal(snap.review_status,'unreviewed');
});
test('rating retries reuse request identity, changing a vote updates one record, and backup failure does not undo cloud success',async()=>{
 const memory=backup(),calls=[],s={id:'s1',messages:[{id:'a1',rateable:true}],feedback:{enabled:true,items:{}}};let fail=true,change=0;
 const controller=createFeedbackController({backup:memory,request:async(path,input)=>{calls.push({path,input});if(fail){fail=false;throw Object.assign(Error('offline'),{code:'FEEDBACK_UNAVAILABLE'});}return {record:record(input.rating,++change)};}});
 await controller.choose(s,'a1','satisfied');assert.equal(controller.view(s).items.a1.error,'FEEDBACK_UNAVAILABLE');assert.equal(controller.summary().total,0);
 await controller.choose(s,'a1','satisfied');assert.equal(calls[0].input.request_id,calls[1].input.request_id);assert.equal(controller.summary().total,1);assert.equal(controller.view(s).items.a1.error,null);
 await controller.choose(s,'a1','satisfied');assert.equal(calls.length,2);
 await controller.choose(s,'a1','unsatisfied');assert.equal(calls[2].input.expected_version,1);assert.notEqual(calls[2].input.request_id,calls[1].input.request_id);assert.deepEqual({...controller.summary(),backupWarning:undefined,cloudWarning:undefined,exportError:undefined},{total:1,satisfied:0,unsatisfied:1,rate:0,backupWarning:undefined,cloudWarning:undefined,exportError:undefined});assert.equal(memory.rows.size,1);assert(calls.every(c=>c.path==='/api/feedback'));
 const unavailable=createFeedbackController({backup:{all:async()=>[],put:async()=>{throw Error('quota');}},request:async()=>({record:record()})});await unavailable.choose(s,'a1','satisfied');assert.equal(unavailable.view(s).items.a1.error,null);assert(unavailable.summary().backupWarning);assert.equal(unavailable.summary().total,1);
});
test('duplicate clicks during a pending vote do not send another request or block another answer',async()=>{
 const s={id:'s1',messages:[{id:'a1'},{id:'a2'}],feedback:{enabled:true,items:{}}},pending=[];
 const controller=createFeedbackController({backup:backup(),request:(path,input)=>new Promise(resolve=>pending.push(()=>resolve({record:{...record(input.rating),feedback_id:input.answer_message_id,answer_message_id:input.answer_message_id}})))});
 const a=controller.choose(s,'a1','satisfied');await controller.choose(s,'a1','unsatisfied');const b=controller.choose(s,'a2','unsatisfied');assert.equal(pending.length,2);pending.forEach(fn=>fn());await Promise.all([a,b]);assert.equal(controller.summary().total,2);
});
test('CSV and JSONL exports keep latest opinions, preserve multilingual evidence and neutralize spreadsheet formulas',()=>{
 const old=record(),latest={...record('unsatisfied',2),snapshot:{question:'=IMPORTDATA("example")',answer:'中文\nالعربية "quoted"'}};
 assert.deepEqual(feedbackStats([latest,old]),{total:1,satisfied:0,unsatisfied:1,rate:0});assert.equal(feedbackStats([]).rate,null);
 const jsonl=feedbackExport([old,latest]);assert.equal(jsonl.trim().split('\n').length,1);assert.equal(JSON.parse(jsonl).snapshot.answer,latest.snapshot.answer);const csv=feedbackExport([latest],'csv');assert(csv.startsWith('\ufeff'));assert(csv.includes("'=IMPORTDATA"));assert(csv.includes('""quoted""'));assert(csv.includes('العربية'));
});
test('HTTP ratings enforce CSRF and session ownership, and are allowed while business is running without changing HITL',async()=>{
 let submissions=0;const feedback={enabled:true,initialize:async()=>{},cached:()=>({}),load:async()=>{},list:async()=>[],submit:async(sid,input,snapshot)=>{submissions++;assert.equal(snapshot.answer,'Answer');return record(input.rating);}};
 const app=await createRoadServer({store:new RoadStore(),feedback,config:{port:10000,host:'127.0.0.1',access:{}}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();const origin='http://127.0.0.1:'+app.server.address().port;
 try{const create=async()=>{const r=await fetch(origin+'/api/session',{method:'POST'});return {state:await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};};const owner=await create(),other=await create(),s=app.store.get(owner.state.id);const q=app.store.message(s,'user','Question'),a=app.store.message(s,'assistant','Answer',{kind:'result'});captureAnswer(s,a,{questionId:q.id});s.running=true;s.pendingOperation={id:'preserve'};s.authorizations={exact:'preserve'};const before=JSON.stringify({epoch:s.epoch,pending:s.pendingOperation,auth:s.authorizations,calls:s.mock.calls,messages:s.messages});
 const post=(session,csrf)=>fetch(origin+'/api/feedback',{method:'POST',headers:{cookie:session.cookie,'content-type':'application/json',...(csrf?{'x-csrf-token':session.state.csrf}:{})},body:JSON.stringify({answer_message_id:a.id,rating:'satisfied',request_id:'request-123',expected_version:0})});
 assert.equal((await post(owner,false)).status,403);assert.equal((await post(other,true)).status,404);assert.equal(submissions,0);assert.equal((await post(owner,true)).status,200);assert.equal(submissions,1);assert.equal(JSON.stringify({epoch:s.epoch,pending:s.pendingOperation,auth:s.authorizations,calls:s.mock.calls,messages:s.messages}),before);
 for(const path of ['/feedback-ui.js','/feedback-data.js']){const r=await fetch(origin+path);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/javascript/);}
 }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}
});
