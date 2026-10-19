import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {RoadKnowledge} from '../src/road/knowledge.mjs';
import {controlledSession} from '../src/road/runtime.mjs';
import {RoadStore} from '../src/road/store.mjs';
import {CrmAgent} from '../src/crm/agent.mjs';
import {CrmSimulation} from '../src/crm/simulation.mjs';

// Host routing regressions, not live-model accuracy tests. The FAQ selector's
// decision is scripted so an overbroad regex cannot hide behind model variance.
// These inputs were authored independently from all holdout references.
const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
async function knowledgeFixture({entryId=null,needsClarification=false}={}){
  let selectorCalls=0;
  const knowledge=await RoadKnowledge.load({runtimeFactory:options=>{
    selectorCalls++;
    return controlledSession({...options,fauxResponses:[call('select_faq',{entry_id:entryId,answerable:entryId!==null,needs_clarification:needsClarification,reason:'Scripted independent routing boundary test'})]});
  }});
  return {knowledge,get selectorCalls(){return selectorCalls;}};
}

const statements=[
  'My whole neighborhood is dark.',
  'The whole street is covered in rubbish.',
  'The company is called Wholesale Market.',
  'The charge for last month’s service is wrong.',
  'There are documents attached to my report.',
  'This service is disappointing.',
  '这项服务的费用已经支付，收据在我这里。',
  'رسوم هذه الخدمة مدفوعة بالكامل.'
];
for(const message of statements)test('FAQ routing: a statement is not a generic service question: '+message,async()=>{
  const f=await knowledgeFixture({needsClarification:true});
  const result=await f.knowledge.answer(message);
  assert.equal(result,null,'A statement must reach the conversational/business route, even if a selector suggests service clarification');
});

const clearRequests=[
  'Can you help me apply for a business license through this service?',
  '这个服务能帮我办理营业许可证吗？',
  'أريد إصدار رخصة تجارية من هذه الخدمة، هل تستطيع إنهاء الطلب؟',
  'Who can help me report the whole street being dark?',
  'The charge is wrong. Please help me complain about it.'
];
for(const message of clearRequests)test('FAQ routing: an explicit target/action is not replaced by a service picker: '+message,async()=>{
  const f=await knowledgeFixture();
  const result=await f.knowledge.answer(message);
  assert.equal(result,null,'A clear requested action is a knowledge miss; CrmAgent must explain connected capability limits or continue the requested task');
});

for(const message of clearRequests.slice(0,3))test('BALADY routing: a clear unsupported license request reaches the assistant explanation: '+message,async()=>{
  const f=await knowledgeFixture(),store=new RoadStore(),session=store.create(),client=new CrmSimulation(store);let businessRuntimeCalls=0;
  const explanation='Permit applications are not connected here. You can continue on the official BALADY platform.';
  const agent=new CrmAgent({store,client,api:(...args)=>client.call(...args),responseGuard:{review:async({texts})=>({texts,issues:[]})},knowledge:f.knowledge,emotion:{assess:async input=>({status:'classified',sentiment:'neutral',message_id:input.current_message_id})},runtimeFactory:options=>{
    businessRuntimeCalls++;
    return controlledSession({...options,fauxResponses:[call('propose_plan',{goal:'Explain the requested service limit',summary:'Explain the available next step.',steps:[{id:'reply',title:'Explain the service limit',capability:'respond',depends_on:[]}]}),call('finish',{state:'answered',message:explanation,receipt_ids:[]})]});
  }});
  await agent.chat(session,message);
  assert.equal(businessRuntimeCalls,1,'A clear business goal must reach CrmAgent rather than stop at a four-service FAQ picker');
  assert.ok(['answered','completed'].includes(session.status),'A respond-only plan may complete while delivering an explanatory answer');assert.equal(session.pendingKnowledge,null);
  assert.equal(session.messages.at(-1).text,explanation);assert.equal(session.receipts.length,0);
  assert.ok(session.plans.length>0);assert.ok(session.plans.every(plan=>plan.steps.every(step=>step.capability==='respond')),'Explaining an unsupported service must not plan a business mutation');
  assert.ok(!session.messages.some(x=>x.kind==='knowledge_clarification'));
});

for(const message of [
  '民防费用发票和市政费用发票，是同一张吗？',
  'هل فاتورة رسوم الدفاع المدني هي نفسها فاتورة الرسوم البلدية؟',
  'Are Civil Defense and municipal fee invoices the same invoice?'
])test('FAQ routing: a genuine named-service fee question remains answerable: '+message,async()=>{
  const f=await knowledgeFixture({entryId:'FAQ-002'}),entry=f.knowledge.entries.find(x=>x.id==='FAQ-002');
  const result=await f.knowledge.answer(message);assert.equal(result?.status,'hit');assert.equal(result.entry.id,entry.id);assert.equal(result.answer,entry.answer);assert.equal(f.selectorCalls,1);
});

test('FAQ routing: exact trusted FAQ still returns its preserved source answer without a model selector',async()=>{
  const f=await knowledgeFixture(),entry=f.knowledge.entries.find(x=>x.id==='FAQ-004');
  const result=await f.knowledge.answer(entry.question);assert.equal(result?.status,'hit');assert.equal(result.answer,entry.answer);assert.equal(f.selectorCalls,0);
});

for(const message of ['Who can apply for this service?','这个服务需要哪些材料？','ما هي رسوم هذه الخدمة؟'])test('FAQ routing: genuinely unspecified service policy asks which service: '+message,async()=>{
  const f=await knowledgeFixture({needsClarification:true});const result=await f.knowledge.answer(message);
  assert.equal(result?.status,'clarify');assert.ok(result.candidate_scopes.includes('infrastructure-permit'));assert.equal(result.answer,undefined);
});

for(const message of [
  'What are the fees for renewing a restaurant license?',
  '营业许可证需要哪些材料？',
  'ما هي رسوم رخصة محل تجاري؟',
  '这个服务办理餐饮许可证需要什么材料？',
  'How much does this service charge for a restaurant license?',
  'ما هي رسوم هذه الخدمة لإصدار رخصة محل تجاري؟'
])test('FAQ routing: a named unsupported service is not an unspecified catalog choice: '+message,async()=>{
  const f=await knowledgeFixture();assert.equal(await f.knowledge.answer(message),null,'The service is named, so an unsupported FAQ is a miss rather than a request to choose an unrelated service');
});

for(const message of [
  'Can I apply for an infrastructure works permit as a service provider’s representative?',
  '我是服务提供商的代表，能申请新开发规划区基础设施施工许可吗？'
])test('FAQ routing: eligibility wording is not automatically an instruction to perform an application: '+message,async()=>{
  const f=await knowledgeFixture({entryId:'FAQ-005'}),entry=f.knowledge.entries.find(x=>x.id==='FAQ-005');
  const result=await f.knowledge.answer(message);assert.equal(result?.status,'hit');assert.equal(result.entry.id,entry.id);assert.equal(result.answer,entry.answer);
});
