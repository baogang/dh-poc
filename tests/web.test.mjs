import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatasetStore } from '../src/web-data.mjs';
import { scoreV2Case,summarizeV2Cases } from '../src/evaluate-v2.mjs';
import { validateRunRequest } from '../src/web-jobs.mjs';
import { RoutedEntry } from '../src/routing.mjs';
import { EntryAgent,scriptedTool } from '../src/entry-agent.mjs';
const store=new DatasetStore(await mkdtemp(join(tmpdir(),'poc-web-tests-')));await store.initialize();
const models={ids:['deepseek-flash','deepseek-v4-pro'],defaultEmotion:'deepseek-flash',defaultPlanner:'deepseek-flash'};
const envelope=async(module,gold=true)=>JSON.parse(await store.template(module,gold));
function preview(e){return store.preview({content:JSON.stringify(e),format:'json'});}
test('all four download templates validate with and without gold',async()=>{for(const module of ['emotion','planning','integration','engineering'])for(const gold of [true,false])assert.equal(preview(await envelope(module,gold)).valid,true,module);});
test('import is immutable, survives restart, and cannot overwrite frozen data',async()=>{const e=await envelope('emotion');e.name='验证导入';const payload={content:JSON.stringify(e),format:'json'};const p=store.preview(payload);const d=await store.commit({...payload,digest:p.digest});assert.equal(d.builtin,false);assert.equal(store.get('builtin-emotion').selected.length,620);const next=new DatasetStore(store.root);await next.initialize();assert.equal(next.get(d.id).fingerprint,d.hash);assert.equal(next.cases(d.id).items[0].input.messages[0].content,e.cases[0].input.messages[0].content);const second=await store.commit({...payload,digest:p.digest});assert.notEqual(second.id,d.id);});
test('duplicate IDs, labels, missing message association and paths have precise errors',async()=>{const e=await envelope('emotion');e.cases.push(structuredClone(e.cases[0]));e.cases[0].reference.sentiment='bad-label';e.cases[1].input.current_message_id='absent';e.cases[1].case_id='../case';const p=preview(e);assert.equal(p.valid,false);assert(p.errors.some(e=>e.location.endsWith('/reference/sentiment')));assert(p.errors.some(e=>e.location.endsWith('/current_message_id')));assert(p.errors.some(e=>e.location.endsWith('/case_id')));const duplicate=await envelope('emotion');duplicate.cases.push(structuredClone(duplicate.cases[0]));assert(preview(duplicate).errors.some(e=>e.message==='重复 ID'));});
test('JSONL reports actual blank-aware line numbers and syntax errors',async()=>{const e=await envelope('emotion');e.cases[0].input.messages=[];const p=store.preview({module:'emotion',name:'JSONL',version:'1',format:'jsonl',content:'\n'+JSON.stringify(e.cases[0])+'\nno-json'});assert.equal(p.valid,false);assert(p.errors.some(e=>e.line===3));assert(p.errors.some(e=>e.line===2&&e.location.includes('/input/messages')));});
test('import preview hash must still match content at commit',async()=>{const e=await envelope('emotion',false),payload={format:'json',content:JSON.stringify(e)},p=store.preview(payload);e.name='changed';await assert.rejects(store.commit({...payload,content:JSON.stringify(e),digest:p.digest}),/重新预览/);});
test('integration gold must have the exact input turn count',async()=>{const e=await envelope('integration');e.cases[0].reference.expected_routes=[];assert(preview(e).errors.some(e=>e.location.endsWith('/expected_routes')));});
test('tool-only reference produces P/R but no full task pass',()=>{const row=scoreV2Case('planning',{case_id:'T',execution_status:'completed',trace:[{type:'business',tool:'balady_certificate_get'}],result:{status:'failed'}},{required_tools:['balady_certificate_get'],allowed_tools:['balady_certificate_get']},{builtin:false});assert.equal(row.grading,'tools_only');assert.equal(row.tool_score.precision,1);assert.equal(row.score,null);const s=summarizeV2Cases('planning',[row]);assert.equal(s.metrics.task_graded,0);assert.equal(s.metrics.task_pass_rate,null);});
test('an alternative tool-only path cannot accidentally acquire full task scoring',()=>{
 const row=scoreV2Case('planning',{case_id:'ALT',execution_status:'completed',trace:[{type:'business',tool:'balady_certificate_get',result:{ok:true}}],result:{status:'completed',missing_fields:[],receipt_ids:[]}},
 {required_tools:['balady_certificate_get'],allowed_tools:['balady_certificate_get'],acceptable_paths:[{allowed_statuses:['completed']}]},{builtin:false});
 assert.equal(row.grading,'tools_only');assert.equal(row.score,null);assert.equal(row.tool_score.precision,1);assert.equal(summarizeV2Cases('planning',[row]).metrics.task_pass_rate,null);
});
test('input-only runs have null quality metrics; cancellation is outside scored denominator',()=>{const rows=[{execution_status:'completed',grading:'unscored',prediction:{sentiment:'neutral'}},{execution_status:'cancelled'},{execution_status:'unexecuted'}];const s=summarizeV2Cases('emotion',rows);assert.equal(s.metrics,null);assert.deepEqual(s.coverage,{selected:3,completed:1,graded:0,unscored:1,task_graded:0,cancelled:1,unexecuted:1,errors:0});assert.equal(s.metric_scope,'partial_completed_cases');});
test('module mismatch, unknown IDs and invalid budgets cannot launch work',()=>{const base={suite:'emotion',datasetId:'builtin-emotion',requestId:'test-1'};assert.equal(validateRunRequest(base,store,models).dataset.selected.length,620);for(const patch of [{suite:'planning'},{caseIds:['UNKNOWN']},{concurrency:0},{maxRequests:0},{plannerModel:'unknown'},{key:'secret'}])assert.throws(()=>validateRunRequest({...base,...patch},store,models));});
test('emotion cancellation cannot fall through to human or planner',async()=>{const controller=new AbortController();let humanCalls=0,plannerCalls=0;const entry=new RoutedEntry({emotionAnalyzer:async(_client,_input,{signal})=>{controller.abort();signal.throwIfAborted();},handoff:{request:async()=>humanCalls++},plannerFactory:()=>plannerCalls++});await assert.rejects(entry.handle({message:'hello'},{signal:controller.signal}),{name:'AbortError'});assert.equal(humanCalls,0);assert.equal(plannerCalls,0);});
test('external cancellation stops the actual Pi SDK before a late model tool call dispatches',async()=>{
 let entered,dispatches=0;const modelStarted=new Promise(r=>entered=r),controller=new AbortController();
 const mock={business:async()=>{dispatches++;return {ok:true,data:{}};}};
 const agent=new EntryAgent({mock,case_id:'cancel-fixture',fauxResponses:[async()=>{entered();await new Promise(r=>setTimeout(r,150));return scriptedTool('balady_certificate_get',{certificate_id:'CERT-MOCK-001'});} ]});
 agent.loaded.add('BALADY');
 try{const turn=agent.turn({message:'Read my certificate'},{signal:controller.signal});await modelStarted;controller.abort();await assert.rejects(turn,{name:'AbortError'});assert.equal(dispatches,0);assert.equal(agent.trace.filter(t=>t.type==='business').length,0);}finally{agent.dispose();}
});
test.after(async()=>rm(store.root,{recursive:true,force:true}));
test('V3 templates omit retired fields and emotion references can omit diagnostics',async()=>{
 const e=await envelope('emotion');assert.equal('indicators' in e.cases[0].reference,false);assert.equal('emotions' in e.cases[0].reference,false);assert(preview(e).valid);
 e.cases[0].reference.emotions=['anger'];assert(preview(e).valid);e.cases[0].reference.emotions=['unknown'];assert(!preview(e).valid);
 delete e.cases[0].reference.emotions;e.cases[0].reference.indicators=[];assert(!preview(e).valid);
});
test('legacy imported data stays browsable but cannot run under a different core contract',()=>{
 const d=store.fromEnvelope({id:'import-legacy-test',name:'Historical five-class reference',version:'1',module:'emotion',cases:[{case_id:'OLD',input:{messages:[{id:'m1',role:'user',content:'hello'}],current_message_id:'m1'},reference:{sentiment:'undetermined',emotions:[],indicators:[]}}]});store.cache.set(d.id,d);
 assert.equal(store.cases(d.id).items[0].reference.sentiment,'undetermined');assert.equal(store.list().find(x=>x.id===d.id).compatible,false);assert.throws(()=>store.select(d.id,{suite:'emotion'}),/旧版导入集/);store.cache.delete(d.id);
});
