import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emotionSchema,validateShape,validateEmotion,validateEmotionReference,EMOTIONS } from '../src/contracts.mjs';
import { emotionMetrics } from '../src/v2-metrics.mjs';
import { RoutedEntry,MockHandoffConnector,decideRoute } from '../src/routing.mjs';
import { hash,readJSON,readJSONL } from '../src/util.mjs';
const source={messages:[{id:'m1',role:'user',content:'I am disappointed and angry.'}],current_message_id:'m1'};
const output=(sentiment='neutral',status='classified')=>({sentiment,assessment_status:status,emotions:[],evidence:sentiment==='negative'?[{label:'sentiment:negative',message_id:'m1',quote:source.messages[0].content}]:[]});
test('output and reference contracts enforce the core pair and reject retired fields',()=>{
 assert(validateEmotion(output('negative'),source).ok);
 for(const value of [output(null,'classified'),output('neutral','needs_clarification'),output('mixed'),output('undetermined'),{...output(),indicators:[]}])assert(!validateEmotion(value,source).ok);
 assert(validateEmotion(output(null,'needs_clarification'),source).ok);
 assert(validateEmotionReference({sentiment:'negative',assessment_status:'classified'},source).ok);
 assert(!validateEmotion({...output(),emotions:['unknown']},source).ok);
 assert(!validateEmotionReference({sentiment:'neutral',assessment_status:'classified',emotions:'anger'},source).ok);
 assert(!validateEmotionReference({sentiment:'neutral',assessment_status:'classified',emotions:['unknown']},source).ok);
 assert(!validateShape(emotionSchema,{...output(),emotions:null}).ok);
 assert.equal(EMOTIONS.length,7);
});
test('clarification reference has no sentiment-class denominator; false negative classification still counts as FP',()=>{
 const rows=[{valid:true,prediction:output('negative'),reference:{sentiment:null,assessment_status:'needs_clarification'}},{valid:true,prediction:output(null,'needs_clarification'),reference:{sentiment:'neutral',assessment_status:'classified'}}];
 const m=emotionMetrics(rows);assert.equal(m.sentiment.classified_reference_cases,1);assert.equal(m.sentiment.accuracy,0);assert.equal(m.sentiment.per_label.negative.fp,1);assert.equal(m.sentiment.per_label.neutral.fn,1);assert.equal(m.core_match,0);assert.equal(m.assessment_status.per_label.needs_clarification.fp,1);assert.equal(m.assessment_status.per_label.needs_clarification.fn,1);
});
test('legal diagnostic-emotion changes cannot change route',()=>{
 for(const label of EMOTIONS)assert.equal(decideRoute({valid:true,prediction:{...output('negative'),emotions:[label]}}).action,'human');
 assert.equal(decideRoute({valid:true,prediction:output(null,'needs_clarification')}).action,'clarify');
 assert.equal(decideRoute({valid:true,prediction:output(null,'classified')}).action,'human');
});
test('one analysis per user turn; business identifiers continue one planner session',async()=>{
 let analyses=0,planners=0,steps=0;const history=[];
 const entry=new RoutedEntry({emotionAnalyzer:async(_client,input)=>{analyses++;return {valid:true,prediction:{...output(),evidence:[]}};},plannerFactory:()=>{planners++;return {trace:[],authorized:new Map(),proposals:new Map(),turn:async(input,{contextMessages})=>{steps++;history.push(contextMessages);return {result:{status:steps===1?'needs_input':'completed',answer:steps===1?'Please provide complaint ID.':'Status returned.'}};},snapshot:()=>({}),dispose(){}};}});
 const first=await entry.handle({message:'Check my complaint status.'});const second=await entry.handle({message:'CMP-MOCK-001'});
 assert.equal(first.result.status,'needs_input');assert.equal(second.result.status,'completed');assert.equal(analyses,2);assert.equal(planners,1);assert.equal(steps,2);assert(history[1].some(m=>m.role==='assistant'&&m.content.includes('complaint ID')));
});
test('clarification never constructs business planner and can recover on complete input',async()=>{
 let calls=0;const entry=new RoutedEntry({emotionAnalyzer:async()=>({valid:true,prediction:calls++===0?output(null,'needs_clarification'):output()}),plannerFactory:()=>({trace:[],turn:async()=>({result:{status:'completed',answer:'done'}}),dispose(){}})});
 const first=await entry.handle({message:'...'});assert.equal(first.route.action,'clarify');assert.equal(first.business_dispatches,0);assert.equal(entry.planner,undefined);
 const next=await entry.handle({message:'Check CMP-MOCK-001.'});assert.equal(next.route.action,'agent');
});
test('handoff exception stays failed and retry acceptance closes session before any later analysis',async()=>{
 let analyses=0,attempts=0;const entry=new RoutedEntry({emotionAnalyzer:async(_c,input)=>{analyses++;return {valid:true,prediction:{...output('negative'),evidence:[{label:'sentiment:negative',message_id:input.current_message_id,quote:input.messages.find(m=>m.id===input.current_message_id).content}]}};},handoff:{request:async()=>{if(++attempts===1)throw Error('Unavailable');return {state:'queued',accepted:true,ticket_id:'ticket',handoff_transferred:false};}},plannerFactory:()=>{throw Error('Cannot start');}});
 assert.equal((await entry.handle({message:'I am angry.'})).result.session_ended,false);
 assert.equal((await entry.handle({message:'Still angry.'})).result.session_ended,true);
 assert.equal((await entry.handle({message:'Now fine.',resume:true})).route.action,'session_closed');assert.equal(analyses,2);assert.equal(attempts,2);
});
test('queued and connected are receipt acceptance, unavailable never means session ended',async()=>{
 for(const scenario of ['queued','connected','unavailable']){const r=await new MockHandoffConnector({scenario}).request({});assert.equal(r.accepted,scenario!=='unavailable');assert.equal(r.handoff_transferred,false);}
});
test('frozen V3 validates, preserves 600 input bytes and all planning records; old V2 hashes stay intact',async()=>{
 for(const version of ['v2.0','v3.0']){const freeze=await readJSON(`datasets/${version}/freeze.json`);for(const [p,h] of Object.entries(freeze.files))assert.equal(hash(await readFile(p,'utf8')),h,p);}
 const old=await readFile('datasets/v2.0/emotion/inputs.jsonl','utf8'),current=await readFile('datasets/v3.0/emotion/inputs.jsonl','utf8');assert(current.startsWith(old));
 for(const name of ['inputs','references','manifest'])assert.equal(await readFile(`datasets/v3.0/planning/${name}.jsonl`,'utf8'),await readFile(`datasets/v2.0/planning/${name}.jsonl`,'utf8'));
 const inputs=await readJSONL('datasets/v3.0/emotion/inputs.jsonl'),refs=await readJSONL('datasets/v3.0/emotion/references.jsonl');assert.equal(inputs.length,620);
 for(let i=0;i<refs.length;i++){assert(validateEmotionReference(refs[i].reference,inputs[i].input).ok,refs[i].case_id);assert.equal('emotions' in refs[i].reference,false);assert.equal('indicators' in refs[i].reference,false);}
 const flows=await readJSONL('datasets/v3.0/integration/inputs.jsonl'),legacy=await readJSONL('datasets/v2.0/integration/inputs.jsonl');assert.deepEqual(flows.slice(0,32),legacy);
});
test('handoff and clarification counters exclude earlier permitted business dispatches',async()=>{
 for(const blocked of ['negative',null]){
  let analyses=0;const trace=[];const entry=new RoutedEntry({emotionAnalyzer:async(_c,input)=>{const sentiment=analyses++===0?'neutral':blocked;return {valid:true,prediction:{...output(sentiment,sentiment===null?'needs_clarification':'classified'),evidence:sentiment==='negative'?[{label:'sentiment:negative',message_id:input.current_message_id,quote:input.messages.find(m=>m.id===input.current_message_id).content}]:[]}};},plannerFactory:()=>({trace,authorized:new Map(),proposals:new Map(),turn:async()=>{trace.push({type:'business',tool:'crm940_complaint_get',backend_invoked:true});return {result:{status:'completed',answer:'Status.'}};},snapshot:()=>({}),dispose(){}})});
  assert.equal((await entry.handle({message:'Check complaint status.'})).business_dispatches,1);
  const turn=await entry.handle({message:blocked===null?'...':'I am angry.'});assert.equal(turn.business_dispatches,0);assert.equal(trace.length,1);
 }
});
