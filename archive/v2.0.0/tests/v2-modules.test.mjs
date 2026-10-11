import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEmotion } from '../src/analyzer.mjs';
import { validateEmotion } from '../src/contracts.mjs';
import { decideRoute,RoutedEntry,MockHandoffConnector } from '../src/routing.mjs';
import { EntryAgent,scriptedTool } from '../src/entry-agent.mjs';
import { DEFAULT_REGISTRY,makeRegistry } from '../src/capability-registry.mjs';
import { scoreToolSelection,emotionMetrics } from '../src/v2-metrics.mjs';

const prediction=(sentiment,source)=>({sentiment,emotions:[],indicators:[],evidence:['positive','negative','mixed'].includes(sentiment)?[{label:'sentiment:'+sentiment,message_id:source.current_message_id,quote:source.messages.at(-1).content}]:[]});
const analyzer=sentiment=>async(client,source)=>({valid:true,prediction:prediction(sentiment,source),version:'test-classifier'});
test('emotion output contract rejects business intents',async()=>{
 const source={messages:[{id:'m1',role:'user',content:'I am angry'}],current_message_id:'m1'},value=prediction('negative',source);
 assert.equal(validateEmotion({...value,intents:['complaint_status']},source).ok,false);
 const result=await analyzeEmotion({chat:async()=>({content:JSON.stringify(value)})},source);
 assert.equal(result.valid,true);assert.equal('intents' in result.prediction,false);
});
test('routing is deterministic and handoff ownership requires explicit resumption',()=>{
 const a={valid:true,prediction:{sentiment:'negative'}};assert.equal(decideRoute(a).action,'human');
 a.prediction.sentiment='neutral';assert.equal(decideRoute(a,{handoffActive:true}).action,'human');
 assert.equal(decideRoute(a,{handoffActive:true},{resume:true}).action,'agent');
 assert.equal(decideRoute({valid:false}).action,'human');
});
test('negative route never constructs the planner or business executor',async()=>{
 const entry=new RoutedEntry({emotionAnalyzer:analyzer('negative'),plannerFactory:()=>{throw new Error('Planner must not start');}});
 const turn=await entry.handle({message:'I am angry about this service'});
 assert.equal(turn.route.action,'human');assert.equal(turn.business_dispatches,0);assert.equal(entry.planner,undefined);assert.equal(turn.result.handoff_transferred,false);
});
test('unavailable handoff records failure instead of falling back to automatic work',async()=>{
 const entry=new RoutedEntry({emotionAnalyzer:analyzer('negative'),handoff:new MockHandoffConnector({scenario:'unavailable'}),plannerFactory:()=>{throw new Error('Blocked');}});
 const turn=await entry.handle({message:'Terrible service'});assert.equal(turn.result.handoff_state,'failed');assert.equal(turn.route.action,'human');assert.equal(turn.business_dispatches,0);
});
test('failed emotion analysis is not treated as neutral and cannot start planner',async()=>{
 const entry=new RoutedEntry({emotionAnalyzer:async()=>{throw new Error('Provider timeout');},plannerFactory:()=>{throw new Error('Blocked');}});
 const turn=await entry.handle({message:'Check status'});assert.equal(turn.emotion.valid,false);assert.equal(turn.emotion.prediction,null);assert.equal(turn.route.action,'human');
});
test('executor rechecks host route permission independently of the model',async()=>{
 const agent=new EntryAgent({executionGuard:()=>false});const result=await agent.executeBusiness(DEFAULT_REGISTRY.operations.get('balady_certificate_get'),{certificate_id:'CERT-MOCK-001'});assert.equal(result.error.code,'ROUTE_BLOCKED');assert.equal(agent.trace[0].backend_invoked,undefined);
});
test('a fifth system loads and completes via SDK without a central intent enum',async()=>{
 const op={id:'fees_invoice_get',system:'FEES',capability_id:'fees.invoice@1',effect:'read',adapter:'fixture_mock',subject_fields:['invoice_id'],fixture_key:'invoice_id',fixtures:{'INVOICE-MOCK-001':{invoice_id:'INVOICE-MOCK-001',payment_status:'paid'}},description:'Lookup invoice payment status',keywords:'invoice fee payment status',path_parameters:[],input_schema:{type:'object',properties:{invoice_id:{type:'string'}},required:['invoice_id'],additionalProperties:false}};
 const registry=makeRegistry([...DEFAULT_REGISTRY.plugins,{system:'FEES',plugin_version:'1',skillPath:DEFAULT_REGISTRY.plugins[0].skillPath,operations:[op],capabilities:[{id:'fees.invoice@1',operations:[op.id],resource_prefixes:['INVOICE'],completion:{inspect:{required_operations:[op.id]},execute:{required_operations:[op.id]}}}]}]);
 const result={status:'completed',answer:'paid',missing_fields:[],receipt_ids:[],goals:[],handoff_reason:''};
 const agent=new EntryAgent({registry,fauxResponses:[scriptedTool('skill_read',{system:'FEES'}),scriptedTool(op.id,{invoice_id:'INVOICE-MOCK-001'}),async()=>{const id=[...agent.receipts.keys()][0];return scriptedTool('submit_result',{...result,receipt_ids:[id],goals:[{goal:'Check invoice',capability_id:'fees.invoice@1',mode:'inspect',subject_ids:['INVOICE-MOCK-001'],status:'completed',operations:[op.id],receipt_ids:[id]}]});}]});
 try{await agent.turn({message:'Check INVOICE-MOCK-001 payment'});assert.equal(agent.result.status,'completed');assert.match(agent.result.answer,/paid/);assert.equal(agent.trace.filter(t=>t.type==='business').length,1);}finally{agent.dispose();}
});
test('tool precision counts unexpected choices, recall counts missed requirements',()=>{
 const reference={allowed_statuses:['failed'],required_tools:['balady_certificate_get','balady_planning_get'],allowed_tools:['balady_certificate_get','balady_planning_get'],required_order:[],assertions:[]};
 const row={result:{status:'failed',missing_fields:[],receipt_ids:[]},trace:[{type:'business',tool:'balady_certificate_get',arguments:{}},{type:'business',tool:'sakani_request_get',arguments:{}}]};
 const score=scoreToolSelection(row,reference);assert.equal(score.precision,.5);assert.equal(score.recall,.5);assert.deepEqual(score.disallowed_tools,['sakani_request_get']);
});
test('successful receipt for one resource cannot hide another explicit omitted resource',()=>{
 const agent=new EntryAgent({});agent.session={agent:{state:{messages:[{role:'assistant',content:[{type:'toolCall'}]}]}}};agent.conversation=[{content:'Check CERT-MOCK-001 and CERT-MOCK-002'}];agent.receipts.set('r',{ok:true,operation:'balady_certificate_get',arguments:{certificate_id:'CERT-MOCK-001'},data:{}});
 const errors=agent.validateResult({status:'completed',answer:'done',missing_fields:[],receipt_ids:['r'],handoff_reason:'',goals:[{goal:'Check',capability_id:DEFAULT_REGISTRY.operations.get('balady_certificate_get').capability_id,mode:'inspect',subject_ids:['CERT-MOCK-001'],status:'completed',operations:['balady_certificate_get'],receipt_ids:['r']}]});assert.ok(errors.some(e=>e.includes('Requested resource omitted CERT-MOCK-002')));
});
test('exact emotion match compares label values, not array object identity',()=>{
 const r={valid:true,initial_valid:true,prediction:{sentiment:'negative',emotions:['anger','frustration'],indicators:['SA02']},reference:{sentiment:'negative',emotions:['frustration','anger'],indicators:['SA02']}};
 assert.equal(emotionMetrics([r]).exact_match,1);
});
test('handoff stays on one ticket across additional user messages',async()=>{
 const entry=new RoutedEntry({emotionAnalyzer:analyzer('negative')});
 const a=await entry.handle({message:'Bad service'}),b=await entry.handle({message:'Still bad'});
 assert.equal(a.result.ticket_id,b.result.ticket_id);assert.equal(entry.handoff.records.length,1);
});
test('explicit cancelled task goal requires authoritative cancellation receipt',()=>{
 const agent=new EntryAgent({});agent.session={agent:{state:{messages:[{role:'assistant',content:[{type:'toolCall'}]}]}}};
 const errors=agent.validateResult({status:'cancelled',answer:'cancelled',receipt_ids:[],missing_fields:[],handoff_reason:'',goals:[{goal:'cancel task',capability_id:DEFAULT_REGISTRY.operations.get('furas_task_cancel').capability_id,mode:'execute',subject_ids:['FURAS-TASK-MOCK-001'],status:'cancelled',operations:['furas_task_cancel'],receipt_ids:[]}]});assert.ok(errors.some(e=>e.includes('required operation furas_task_cancel')));
});
test('releasing a handoff does not rewrite historical turn snapshots',async()=>{
 let sentiment='negative';const entry=new RoutedEntry({emotionAnalyzer:async(client,source)=>analyzer(sentiment)(client,source),plannerFactory:()=>({turn:async()=>({result:{status:'completed'}}),trace:[],snapshot:()=>({}),dispose(){}})});
 const first=await entry.handle({message:'Bad service'});sentiment='neutral';await entry.handle({message:'Check status',resume:true});
 assert.equal(first.handoff.state,'queued');assert.equal(entry.snapshot().turns[0].handoff.state,'queued');assert.equal(entry.handoff.records[0].state,'released');
 first.handoff.state='changed_by_caller';assert.equal(entry.snapshot().turns[0].handoff.state,'queued');
});
test('remote task completion uses terminal proof and preserves earlier pending history',()=>{
 const agent=new EntryAgent({});agent.session={agent:{state:{messages:[{role:'assistant',content:[{type:'toolCall'}]}]}}};
 const pending={ok:true,operation:'furas_task_get',arguments:{task_id:'FURAS-TASK-MOCK-001'},data:{task_id:'FURAS-TASK-MOCK-001',status:'pending'}};
 agent.receipts.set('pending',pending);
 const result={status:'completed',answer:'done',receipt_ids:['pending'],missing_fields:[],handoff_reason:'',goals:[{goal:'Find opportunities',capability_id:DEFAULT_REGISTRY.operations.get('furas_task_get').capability_id,mode:'inspect',subject_ids:['FURAS-TASK-MOCK-001'],status:'completed',operations:['furas_task_get'],receipt_ids:['pending']}]};
 assert.ok(agent.validateResult(result).some(e=>e.includes('task state mismatch')));
 agent.receipts.set('completed',{...pending,data:{...pending.data,status:'completed'}});result.receipt_ids.push('completed');result.goals[0].receipt_ids.push('completed');assert.deepEqual(agent.validateResult(result),[]);
 agent.receipts.set('cancelled',{...pending,operation:'furas_task_cancel',data:{...pending.data,status:'cancelled'}});assert.ok(agent.validateResult(result).some(e=>e.includes('task state mismatch')));
});
