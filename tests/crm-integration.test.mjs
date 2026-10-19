import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {createRoadServer} from '../src/road/server.mjs';
import {RoadStore} from '../src/road/store.mjs';
import {FeedbackRepository} from '../src/road/feedback.mjs';
import {RoadKnowledge} from '../src/road/knowledge.mjs';
import {RoadEmotion} from '../src/road/emotion.mjs';
import {controlledSession} from '../src/road/runtime.mjs';
import {CrmAgent} from '../src/crm/agent.mjs';
import {CrmResponseGuard} from '../src/crm/response-guard.mjs';
import {ensureCrm} from '../src/crm/simulation.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// The seam is the browser's public HTTP API. Scripted model decisions make host
// safety regressions repeatable; these are not claims about model accuracy.
const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
const step=(id,capability,depends_on=[])=>({id,title:capability,capability,depends_on});
const plan=steps=>call('propose_plan',{goal:'Fulfil the citizen request',summary:'I will check the requested information.',steps:[...steps,step('reply','respond',steps.map(x=>x.id))]});
function observations(context){return context.messages.filter(x=>x.role==='toolResult').flatMap(x=>x.content.filter(p=>p.type==='text').map(p=>{try{return JSON.parse(p.text);}catch{return null;}})).filter(Boolean);}
function promptState(context){for(const message of context.messages){if(message.role!=='user')continue;for(const part of message.content??[]){if(part.type!=='text')continue;try{const value=JSON.parse(part.text);if(value.event!==undefined)return value;}catch{}}}return {};}
const finish=(message='Here is the information returned by CRM.',extra={})=>context=>call('finish',{state:'completed',message,...extra,receipt_ids:[...new Set([...(promptState(context).receipts??[]),...observations(context).map(x=>x.receipt).filter(Boolean)].map(x=>x.id))]});
const complaint=()=>({CustomerInformation:{FirstName:'Lina',LastName:'Citizen',EmailAddress:'lina@example.test',MobileNumber:'0501234567'},subject:'Waste collection',Description:'The shared waste container has not been emptied.',Type:'T03',Attachments:[]});
const complaintMessage='I want to complain that the shared waste container has not been emptied. My name is Lina Citizen, my email is lina@example.test and my phone is 0501234567. Use the title “Waste collection”. I have no attachments.';
const apiCalls=state=>(state.events??[]).filter(x=>x.type==='api_start'&&x.call).map(x=>x.call);
const historyTurn=()=>[plan([step('history','crm_get_incidents')]),call('crm_get_incidents',{step_id:'history'}),finish()];

// Host-boundary fixtures deliberately isolate prose review. Dedicated guard
// tests below inject the real guard with a scripted external reviewer instead.
const identityResponseGuard={review:async({texts})=>({texts,issues:[]})};
async function fixture({sentiment='neutral',loseWriteResponse=false,store=new RoadStore(),feedback=new FeedbackRepository({connectionString:null}),responseGuard=identityResponseGuard,audience='beneficiary'}={}){
  const turns=[],emotionTurns=[],faqCalls=[],modelInputs=[];
  const knowledge=new RoadKnowledge({name:'Integration fixture FAQ',entries:[{id:'faq-fees',question:'Does this service have a fee?',answer:'This fixture has no documented fee.',source_scope:'balady-crm'}]},{runtimeFactory:options=>{faqCalls.push(options.system);return controlledSession({...options,fauxResponses:[call('select_faq',{entry_id:null,answerable:false,reason:'The citizen is requesting a business action.'})]});}});
  const emotion=new RoadEmotion({runtimeFactory:options=>controlledSession({...options,fauxResponses:[context=>{const input=JSON.parse(context.messages.find(x=>x.role==='user').content.find(x=>x.type==='text').text),message=input.messages.find(x=>x.id===input.current_message_id);const chosen=emotionTurns.shift()??sentiment;return call('record_sentiment',{sentiment:chosen,quote:chosen==='neutral'?'':message.content});}]})});
  const app=await createRoadServer({store,feedback,knowledge,config:{host:'127.0.0.1',port:10000,access:{}},agentFactory:options=>{
    const base=options.client;let lost=false;
    const client=loseWriteResponse?{mode:base.mode,execute:async(...args)=>{const value=await base.execute(...args);if(!lost&&value.ok&&args[1]==='crm_create_form_request'){lost=true;return {ok:false,error:{code:'RESULT_UNCERTAIN',message:'Injected loss after successful CRM dispatch.'}};}return value;}}:base;
    return new CrmAgent({...options,client,emotion,responseGuard,audience,runtimeFactory:options=>{assert.ok(turns.length,'A scripted model turn was not queued');const responses=turns.shift().map(response=>(context,...rest)=>{modelInputs.push(JSON.stringify(context));return typeof response==='function'?response(context,...rest):response;});return controlledSession({...options,fauxResponses:responses});}});
  }});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});await app.ready();
  const origin='http://127.0.0.1:'+app.server.address().port;
  const restoreConversation=(initial,cookie)=>{
    const get=async()=>{const response=await fetch(origin+'/api/state',{headers:{cookie}});assert.equal(response.status,200);return response.json();};
    const post=async(path,input,extra={})=>{const response=await fetch(origin+path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':initial.csrf,...extra},body:JSON.stringify(input)});return {status:response.status,body:await response.json()};};
    const settled=async()=>{for(let i=0;i<600;i++){const state=await get();if(!state.running)return state;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('HTTP turn did not settle');};
    const chat=async(message,responses)=>{if(responses)turns.push(responses);const response=await post('/api/chat',{message});assert.equal(response.status,202);return settled();};
    return {id:initial.id,initial,cookie,get,post,settled,chat,login:username=>post('/api/login',{username,password:'demo'})};
  };
  const newConversation=async()=>{const response=await fetch(origin+'/api/session',{method:'POST'});return restoreConversation(await response.json(),response.headers.get('set-cookie').split(';')[0]);};
  return {app,origin,turns,emotionTurns,faqCalls,modelInputs,newConversation,restoreConversation};
}

test('HTTP full routing calls FAQ and sentiment before a beneficiary history and uses returned keys for details',async()=>{
  const f=await fixture();try{const user=await f.newConversation();assert.equal((await user.login('demo')).status,200);
    f.app.store.get(user.id).crm.incidents=[
      {pyID:'INC-29-03-000041',pzInsKey:'MOMRA-OPS-CS-WORK INC-29-03-000041',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Open',Description:'Streetlight outage beside the school',history:[]},
      {pyID:'INC-29-03-000073',pzInsKey:'MOMRA-OPS-CS-WORK INC-29-03-000073',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'InProgress',Description:'Waste container has not been emptied',history:[]}
    ];
    const state=await user.chat('What happened to the waste container problem I reported?',[plan([step('history','crm_get_incidents'),step('detail','crm_fetch_incident',['history'])]),call('crm_get_incidents',{step_id:'history'}),context=>{const history=observations(context).find(x=>x.receipt?.operation==='crm_get_incidents').receipt.result.data.result,match=history.IncidentRequestList.find(x=>/waste container/i.test(x.Description));assert.ok(match,'The backend fixture contains the described report');return call('crm_fetch_incident',{step_id:'detail',pzInsKey:match.pzInsKey});},finish()]);
    assert.equal(state.status,'completed');assert.equal(state.receipts.length,2);assert.ok(f.faqCalls.length);assert.equal(state.emotion.status,'classified');
    assert.equal(state.receipts[1].parameters.pzInsKey,state.receipts[0].result.data.result.IncidentRequestList.find(x=>/waste container/i.test(x.Description)).pzInsKey);
    assert.ok(state.messages.at(-1).rateable);assert.ok(!JSON.stringify(state).includes('private-test-simulation-key'));
  }finally{await f.app.close();}
});

test('HTTP failed prose gates make the author retry plan and question while host read facts preserve the business target',async()=>{
  const reviewInputs=[],verdicts=[
    {kind:'plan',approved:false,issues:['Unsupported official tracking and email']},
    {kind:'plan',approved:true,issues:[]},{kind:'plan',approved:true,issues:[]},
    {kind:'missing_information',approved:true,issues:[]},{kind:'missing_information',approved:false,issues:['Unsupported official tracking and email']},
    {kind:'missing_information',approved:true,issues:[]},{kind:'missing_information',approved:true,issues:[]},
  ];
  const responseGuard=new CrmResponseGuard({runtimeFactory:options=>{
    assert.deepEqual(options.tools.map(x=>x.name),['review_message']);
    return controlledSession({...options,fauxResponses:[context=>{const input=JSON.parse(context.messages.find(x=>x.role==='user').content.find(x=>x.type==='text').text),verdict=verdicts.shift();reviewInputs.push(input);assert.ok(verdict,'No unplanned verification');assert.equal(input.context.kind,verdict.kind);return call('review_message',{approved:verdict.approved,issues:verdict.issues});}]});
  }});
  const safeQuestion='Was it the waste collection report or the streetlight report? These are local simulated records; there is no official-app tracking or email notification.';
  const steps=[{...step('history','crm_get_incidents'),title:'List your reports'},{...step('choose','input',['history']),title:'Choose your report'},{...step('detail','crm_fetch_incident',['choose']),title:'Read the selected report'},{...step('reply','respond',['detail']),title:'Explain its recorded status'}];
  const safePlan=()=>call('propose_plan',{goal:'Check my report',summary:'I will identify your report and check its status in this local simulation.',steps});
  const rejected=context=>assert.equal(observations(context).at(-1).error,'UNVERIFIED_CUSTOMER_CLAIMS','The author must receive the rejection before retrying');
  const f=await fixture({responseGuard});try{const user=await f.newConversation();await user.login('demo');f.app.store.get(user.id).crm.incidents=[
    {pyID:'INC-31-07-000087',pzInsKey:'MOMRA-OPS-CS-WORK INC-31-07-000087',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'InProgress',Description:'Streetlight outage',history:[]},
    {pyID:'INC-31-07-000192',pzInsKey:'MOMRA-OPS-CS-WORK INC-31-07-000192',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Open',Description:'Waste collection',history:[]},
  ];
    let state=await user.chat('Please help me check one of my reports; I do not have the reference to hand.',[
      call('propose_plan',{goal:'Check my report in the official app',summary:'I will check and email the result.',steps}),
      context=>{rejected(context);return safePlan();},
      call('crm_get_incidents',{step_id:'history'}),
      call('request_input',{step_id:'choose',kind:'text',operation:'crm_fetch_incident',fields:['pzInsKey'],question:'Was it the waste collection report or the streetlight report? You can track it in the official app and will receive an email.'}),
      context=>{rejected(context);return call('request_input',{step_id:'choose',kind:'text',operation:'crm_fetch_incident',fields:['pzInsKey'],question:safeQuestion});},
    ]);
    assert.equal(state.status,'input');assert.equal(state.pendingInput.question,safeQuestion);assert.equal(state.plans.length,1,'The rejected plan must never be published');
    const currentPlan=state.plans.at(-1);assert.equal(currentPlan.goal,'Check my report');assert.deepEqual(currentPlan.steps.map(x=>[x.id,x.capability,x.depends_on]),[['history','crm_get_incidents',[]],['choose','input',['history']],['detail','crm_fetch_incident',['choose']],['reply','respond',['detail']]]);
    const selected=state.receipts[0].result.data.result.IncidentRequestList.find(x=>x.pyID==='INC-31-07-000192');assert.ok(selected);
    f.turns.push([call('crm_fetch_incident',{step_id:'detail',pzInsKey:selected.pzInsKey}),finish('Waste collection report INC-31-07-000192 is Open, so work has not started. Track this record in the official app; an email is on the way.')]);
    assert.equal((await user.post('/api/input',{input_id:state.pendingInput.id,value:{text:'The waste collection report.'}})).status,202);state=await user.settled();
    assert.equal(state.status,'completed');assert.ok(state.messages.at(-1).text.includes('INC-31-07-000192'));assert.ok(state.messages.at(-1).text.includes('Waste collection'));assert.ok(!state.messages.at(-1).text.includes('work has not started'));assert.deepEqual(apiCalls(state).map(x=>x.operation),['crm_get_incidents','crm_fetch_incident']);assert.equal(state.receipts.length,2,'Verifier verdicts are not business receipts');assert.equal(state.receipts[1].parameters.pzInsKey,selected.pzInsKey);assert.equal(state.receipts[1].result.data.result.pyStatusWork,'Open');
    assert.equal(reviewInputs.find(x=>x.context.kind==='missing_information').actual_receipts.length,1);assert.ok(!reviewInputs.some(x=>x.context.kind==='answer'),'The host-owned read summary bypasses author prose verification');assert.equal(state.events.filter(x=>x.type==='response_guard_completed').length,2);assert.equal(verdicts.length,0);assert.equal(state.events.filter(x=>x.type==='tool_end'&&x.result?.error==='UNVERIFIED_CUSTOMER_CLAIMS').length,2);
    assert.ok(state.messages.filter(x=>x.role==='assistant').every(x=>!x.text.includes('email is on the way')&&!x.text.includes('I will check and email')),'Rejected author prose must never be displayed');
  }finally{await f.app.close();}
});

test('HTTP a malformed verification verdict cannot publish its plan or bypass confirmation',async()=>{
  let calls=0;const responseGuard=new CrmResponseGuard({runtimeFactory:options=>controlledSession({...options,fauxResponses:[()=>{calls++;return call('review_message',calls===1?{issues:[]}:{approved:true,issues:[]});}]})});
  const f=await fixture({responseGuard});try{const user=await f.newConversation();const state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('finish',{state:'blocked',message:'The response could not be verified. Please retry.',receipt_ids:[]})]);
    assert.ok(['answered','blocked'].includes(state.status));assert.equal(state.plans.length,0);assert.equal(state.pendingOperation,null);assert.equal(apiCalls(state).length,0);assert.equal(state.receipts.length,0);assert.ok(state.events.some(x=>x.type==='tool_end'&&x.name==='propose_plan'&&x.result?.error==='RESPONSE_GUARD_UNAVAILABLE'));
  }finally{await f.app.close();}
});

test('HTTP beneficiary history and details are isolated between different demo identities',async()=>{
  const f=await fixture();try{const demo=await f.newConversation(),sara=await f.newConversation();await demo.login('demo');await sara.login('sara');
    const d=await demo.chat('Show my current reports.',historyTurn()),s=await sara.chat('Show my current reports.',historyTurn());
    const demoKeys=d.receipts[0].result.data.result.IncidentRequestList.map(x=>x.pzInsKey),saraKeys=s.receipts[0].result.data.result.IncidentRequestList.map(x=>x.pzInsKey);
    assert.ok(demoKeys.length,'The demo fixture must contain an incident');assert.equal(saraKeys.some(key=>demoKeys.includes(key)),false,'SSO histories must not expose the same beneficiary cases to demo and sara');
    const denied=await sara.chat('What is the progress of this case? '+demoKeys[0],[plan([step('detail','crm_fetch_incident')]),call('crm_fetch_incident',{step_id:'detail',pzInsKey:demoKeys[0]}),call('finish',{state:'blocked',message:'This report is not available to your account.',receipt_ids:[]})]);
    assert.equal(denied.receipts.filter(x=>x.operation==='crm_fetch_incident').length,0,'A known foreign Pega key does not authorize beneficiary access');
  }finally{await f.app.close();}
});

test('HTTP a beneficiary cannot fetch another account case even when its full Pega key is known',async()=>{
  const f=await fixture();try{const demo=await f.newConversation(),sara=await f.newConversation();await demo.login('demo');await sara.login('sara');
    const own=await demo.chat('Show my reports.',historyTurn()),foreignKey=own.receipts[0].result.data.result.IncidentRequestList[0].pzInsKey;
    const state=await sara.chat('Please check this report: '+foreignKey,[plan([step('detail','crm_fetch_incident')]),call('crm_fetch_incident',{step_id:'detail',pzInsKey:foreignKey}),call('finish',{state:'blocked',message:'That report is not available to your account.',receipt_ids:[]})]);
    assert.equal(state.receipts.filter(x=>x.operation==='crm_fetch_incident').length,0,'Knowing a full identifier must not confer SSO beneficiary ownership');
  }finally{await f.app.close();}
});

test('HTTP a beneficiary incident key cannot be fetched as a municipal service or inquiry',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');const history=await user.chat('Show my reports.',historyTurn()),key=history.receipts[0].result.data.result.IncidentRequestList.find(x=>x.pyID.startsWith('INC-')).pzInsKey;
    for(const operation of ['crm_fetch_municipal_service','crm_fetch_inquiry']){const state=await user.chat('Check this request reference: '+key,[plan([step('detail',operation)]),call(operation,{step_id:'detail',pzInsKey:key}),call('finish',{state:'blocked',message:'That reference is not this kind of request.',receipt_ids:[]})]);assert.equal(state.receipts.filter(x=>x.operation===operation).length,0,'Case type must match the endpoint semantics');}
  }finally{await f.app.close();}
});

test('HTTP My matters cannot bypass the beneficiary ownership filter',async()=>{
  const f=await fixture();try{const demo=await f.newConversation(),sara=await f.newConversation();await demo.login('demo');await sara.login('sara');const history=await demo.chat('Show my reports.',historyTurn()),demoCase=history.receipts[0].result.data.result.IncidentRequestList[0].pyID;
    const matters=await sara.post('/api/matters',{action:'list'});assert.equal(matters.status,200);const result=matters.body.messages.at(-1);assert.ok(!result.text.includes(demoCase),'My matters must not display another beneficiary case through a UI-only path');
  }finally{await f.app.close();}
});

test('HTTP FAQ interruption keeps an exact pending CRM confirmation and feedback points to the original request',async()=>{
  const f=await fixture();try{const user=await f.newConversation(),body=complaint();
    let state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',body})]);const proposal=state.pendingOperation.id;
    state=await user.chat('Does this service have a fee?');assert.equal(state.pendingOperation.id,proposal);assert.equal(state.messages.at(-1).kind,'faq');assert.equal(apiCalls(state).length,0);
    f.turns.push([call('crm_create_form_request',{step_id:'write',body}),finish('Your complaint has been recorded.')]);assert.equal((await user.post('/api/approve-operation',{proposal_id:proposal})).status,202);state=await user.settled();
    assert.equal(state.status,'completed');assert.equal(apiCalls(state).length,1);assert.ok(state.messages.at(-1).rateable);
    const rejected=await user.post('/api/feedback',{answer_message_id:'not-from-this-session',rating:'satisfied',request_id:'foreign-answer',expected_version:0});assert.equal(rejected.status,404);
  }finally{await f.app.close();}
});

test('HTTP edits revoke old confirmation, validate the payload, and concurrent approval dispatches once',async()=>{
  const f=await fixture();try{const user=await f.newConversation(),original={body:complaint()};
    let state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',...original})]);const old=state.pendingOperation.id;
    assert.equal((await user.post('/api/edit-operation',{proposal_id:old,value:{text:JSON.stringify({body:{...complaint(),Type:'T99'}})}})).status,400);
    const changed={body:{...complaint(),Description:'The container beside the school has not been emptied for three days.'}};assert.equal((await user.post('/api/edit-operation',{proposal_id:old,value:{text:JSON.stringify(changed)}})).status,200);state=await user.get();const current=state.pendingOperation.id;assert.notEqual(current,old);
    assert.equal((await user.post('/api/approve-operation',{proposal_id:old})).status,409);assert.equal(apiCalls(state).length,0);
    f.turns.push([call('crm_create_form_request',{step_id:'write',...changed}),finish()]);const replies=await Promise.all([user.post('/api/approve-operation',{proposal_id:current}),user.post('/api/approve-operation',{proposal_id:current})]);assert.equal(replies.filter(x=>x.status===202).length,1);assert.ok(replies.some(x=>x.status===409));
    state=await user.settled();assert.equal(apiCalls(state).filter(x=>x.operation==='crm_create_form_request').length,1);assert.deepEqual(state.receipts.at(-1).parameters,changed);
  }finally{await f.app.close();}
});

test('HTTP native field editing accepts a structured payload and changes only the edited complaint field',async()=>{
  const f=await fixture();try{const user=await f.newConversation(),original={body:complaint()};let state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',...original})]);const old=state.pendingOperation.id;
    const changed=structuredClone(original);changed.body.subject='Waste collection beside the school';
    const edited=await user.post('/api/edit-operation',{proposal_id:old,value:{parameters:changed}});assert.equal(edited.status,200);state=await user.get();assert.notEqual(state.pendingOperation.id,old);assert.deepEqual(state.pendingOperation.parameters,changed);assert.deepEqual(state.pendingOperation.parameters.body.CustomerInformation,original.body.CustomerInformation);assert.equal(state.pendingOperation.parameters.body.Description,original.body.Description);assert.equal(apiCalls(state).length,0);
    assert.equal((await user.post('/api/approve-operation',{proposal_id:old})).status,409);f.turns.push([call('crm_create_form_request',{step_id:'write',...changed}),finish()]);assert.equal((await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id})).status,202);state=await user.settled();assert.deepEqual(state.receipts.at(-1).parameters,changed);assert.equal(apiCalls(state).filter(x=>x.operation==='crm_create_form_request').length,1);
  }finally{await f.app.close();}
});

test('HTTP a natural title correction reuses known submission facts and requires a fresh exact confirmation',async()=>{
  const f=await fixture();try{const user=await f.newConversation(),original={body:complaint()};let state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',...original})]);const old=state.pendingOperation.id;
    state=await user.chat('Change the title to “Waste collection beside the school”. Everything else stays the same.',[plan([step('write','crm_create_form_request')]),call('revise_submission',{step_id:'write',changes:[{path:'body.subject',value:'Waste collection beside the school'}]})]);
    const changed=structuredClone(original);changed.body.subject='Waste collection beside the school';assert.equal(state.status,'confirmation');assert.equal(state.pendingInput,null,'Known contact and attachment facts do not require another question');assert.notEqual(state.pendingOperation.id,old);assert.deepEqual(state.pendingOperation.parameters,changed);assert.equal(apiCalls(state).length,0,'Changing a draft is not authorization to submit it');
    assert.equal((await user.post('/api/approve-operation',{proposal_id:old})).status,409);f.turns.push([call('crm_create_form_request',{step_id:'write',...changed}),finish()]);assert.equal((await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id})).status,202);state=await user.settled();assert.deepEqual(state.receipts.at(-1).parameters,changed);assert.equal(apiCalls(state).filter(x=>x.operation==='crm_create_form_request').length,1);
  }finally{await f.app.close();}
});

test('HTTP a complete draft rejects redundant known-data and text-consent questions after an explicit correction',async()=>{
  const f=await fixture();try{const user=await f.newConversation(),original={body:complaint()};let state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',...original})]);const old=state.pendingOperation.id,after=state.events.at(-1).seq;
    state=await user.chat('Change the title to “Waste collection beside the school”. Everything else stays the same.',[
      plan([step('ask','input'),step('write','crm_create_form_request',['ask'])]),
      call('request_input',{step_id:'ask',kind:'text',operation:'crm_create_form_request',fields:['body.CustomerInformation'],question:'Please repeat your name, email and phone number.'}),
      call('request_input',{step_id:'ask',kind:'text',operation:'crm_create_form_request',fields:[],question:'Please say yes to confirm the unchanged details.'}),
      call('revise_submission',{step_id:'write',changes:[{path:'body.subject',value:'Waste collection beside the school'}]})
    ]);
    const changed=structuredClone(original);changed.body.subject='Waste collection beside the school';assert.equal(state.status,'confirmation');assert.equal(state.pendingInput,null);assert.equal(state.events.filter(x=>x.seq>after&&x.type==='input_required').length,0,'The user must not receive another known-data or consent form');assert.equal(state.events.filter(x=>x.seq>after&&x.type==='tool_end'&&x.name==='request_input'&&x.result?.error==='NO_MISSING_INFORMATION').length,1);assert.equal(state.events.filter(x=>x.seq>after&&x.type==='tool_end'&&x.name==='request_input'&&x.result?.error==='INVALID_INPUT_FIELDS').length,1);assert.deepEqual(state.pendingOperation.parameters,changed);assert.notEqual(state.pendingOperation.id,old);assert.equal(apiCalls(state).length,0);assert.equal((await user.post('/api/approve-operation',{proposal_id:old})).status,409);
  }finally{await f.app.close();}
});

test('HTTP first-time submission cannot request non-contract consent fields instead of the exact confirmation card',async()=>{
  const f=await fixture();try{const user=await f.newConversation();const state=await user.chat(complaintMessage,[
    plan([step('ask','input'),step('write','crm_create_form_request',['ask'])]),
    call('request_input',{step_id:'ask',kind:'text',operation:'crm_create_form_request',fields:['submission_approval'],question:'The details are complete. Please reply yes if the draft looks right.',purpose:'choice'}),
    call('request_input',{step_id:'ask',kind:'text',operation:'crm_create_form_request',fields:[],question:'Please say yes so I can submit the complaint.',purpose:'choice'}),
    plan([step('write','crm_create_form_request')]),
    call('crm_create_form_request',{step_id:'write',body:complaint()})
  ]);
    assert.equal(state.status,'confirmation','Submission consent belongs on the exact host confirmation card');assert.equal(state.pendingInput,null);assert.deepEqual(state.pendingOperation.parameters,{body:complaint()});assert.equal(state.events.filter(x=>x.type==='input_required').length,0,'A non-contract field or empty consent prompt must never become an input form');assert.equal(apiCalls(state).length,0);
  }finally{await f.app.close();}
});

test('HTTP complete known submission parameters go directly to the exact host card without text approval',async()=>{
  const f=await fixture();try{const user=await f.newConversation();const state=await user.chat(complaintMessage,[
    plan([step('ask','input'),step('write','crm_create_form_request',['ask'])]),
    call('request_input',{step_id:'ask',kind:'text',operation:'crm_create_form_request',fields:['body.subject'],question:'Please confirm the title and say yes to submit.',known_parameters:{body:complaint()},purpose:'choice'})
  ]);
    assert.equal(state.status,'confirmation');assert.equal(state.pendingInput,null);assert.deepEqual(state.pendingOperation.parameters,{body:complaint()});assert.equal(state.events.filter(x=>x.type==='input_required').length,0);assert.equal(apiCalls(state).length,0,'Complete facts never replace UI authorization');
  }finally{await f.app.close();}
});

test('HTTP a partial submission rejects questions about known data and asks only for the actual missing field',async()=>{
  const f=await fixture();try{const user=await f.newConversation(),partial={body:complaint()};delete partial.body.CustomerInformation.MobileNumber;const state=await user.chat(complaintMessage.replace(' and my phone is 0501234567',''),[
    plan([step('ask','input'),step('write','crm_create_form_request',['ask'])]),
    call('request_input',{step_id:'ask',kind:'text',operation:'crm_create_form_request',fields:['CustomerInformation.EmailAddress'],question:'Please repeat your email address.',known_parameters:partial}),
    call('request_input',{step_id:'ask',kind:'text',operation:'crm_create_form_request',fields:['CustomerInformation.MobileNumber'],question:'Which mobile number should we use?',known_parameters:partial})
  ]);
    assert.equal(state.status,'input');assert.deepEqual(state.pendingInput.fields,['body.CustomerInformation.MobileNumber']);assert.equal(state.events.filter(x=>x.type==='input_required').length,1);assert.ok(state.events.some(x=>x.type==='tool_end'&&x.name==='request_input'&&x.result?.error==='INPUT_FIELDS_NOT_MISSING'));assert.equal(apiCalls(state).length,0);
  }finally{await f.app.close();}
});

test('HTTP optional upload metadata cannot block collecting the genuinely missing file bytes',async()=>{
  const f=await fixture();try{const user=await f.newConversation();const partial={sourceSystem:'BALADY Assistant POC',body:{Category:'Initial',pxAttachName:'site-notes.txt',pyMemo:'Citizen evidence notes'}};const state=await user.chat('I want to attach my notes to a complaint. The file is on my computer.',[
    plan([step('choose','input'),step('upload','crm_upload_attachment',['choose'])]),
    call('request_input',{step_id:'choose',kind:'text',operation:'crm_upload_attachment',fields:['FileType'],question:'I need an optional file type before you can continue.',known_parameters:partial}),
    call('request_input',{step_id:'choose',kind:'file',operation:'crm_upload_attachment',fields:['body.AttachStream'],question:'Choose the notes you want to attach.'})
  ]);
    assert.equal(state.status,'input');assert.equal(state.pendingInput.kind,'file');assert.deepEqual(state.pendingInput.fields,['body.AttachStream']);assert.equal(state.events.filter(x=>x.type==='input_required').length,1);assert.ok(state.events.some(x=>x.type==='tool_end'&&x.name==='request_input'&&x.result?.error==='INPUT_FIELDS_NOT_MISSING'));assert.equal(apiCalls(state).length,0);
  }finally{await f.app.close();}
});

test('HTTP public write completion is grounded in its receipt and excludes invented official follow-up promises',async()=>{
  const f=await fixture();try{const user=await f.newConversation();let state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',body:complaint()})]);
    f.turns.push([call('crm_create_form_request',{step_id:'write',body:complaint()}),finish('Your complaint is officially submitted. Track NOT-REAL-42 in the official Balady app. We will email you updates and refund you tomorrow.')]);assert.equal((await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id})).status,202);state=await user.settled();assert.equal(state.status,'completed');const answer=state.messages.at(-1).text,receipt=state.receipts.at(-1);assert.ok(answer.includes(receipt.result.data.result.id),'The actual returned public-form number must be visible');assert.ok(answer.includes(complaint().subject),'The actual submitted subject must be visible');assert.match(answer,/local.{0,20}simulat|simulat.{0,20}local|本地.{0,10}(?:模拟|仿真)/i);assert.doesNotMatch(answer,/NOT-REAL-42|officially submitted|official Balady app|email you updates|refund you tomorrow/i);assert.equal(apiCalls(state).filter(x=>x.operation==='crm_create_form_request').length,1);
  }finally{await f.app.close();}
});

test('HTTP file selection keeps exact bytes on the host, requires separate confirmations, and cannot cross sessions',async()=>{
  const f=await fixture();try{const user=await f.newConversation(),base64=Buffer.from('The container beside the school is overflowing.\nRecorded by the citizen.').toString('base64');
    let state=await user.chat(complaintMessage.replace('I have no attachments.','I have written notes to attach.'),[
      plan([step('choose','input'),step('upload','crm_upload_attachment',['choose']),step('form','crm_create_form_request',['upload'])]),
      call('request_input',{step_id:'choose',kind:'file',operation:'crm_upload_attachment',fields:['body.AttachStream'],question:'Choose the evidence file you want to attach.'})
    ]);assert.equal(state.status,'input');const inputId=state.pendingInput.id;
    for(const file of [undefined,{name:'notes.txt',base64:''},{name:'notes.txt',base64:'%%%'},{name:'notes.txt',base64:Buffer.alloc(512*1024+1).toString('base64')}]){
      const rejected=await user.post('/api/input',{input_id:inputId,value:file?{file}:{text:'The file is on my computer.'}});assert.equal(rejected.status,400);state=await user.get();assert.equal(state.pendingInput.id,inputId,'Invalid file input must remain recoverable');assert.equal(apiCalls(state).length,0);
    }
    f.turns.push([context=>call('upload_selected_file',{step_id:'upload',file_id:promptState(context).facts.files.at(-1).id,memo:'Citizen evidence notes'})]);
    assert.equal((await user.post('/api/input',{input_id:inputId,value:{file:{name:'site-notes.txt',media_type:'text/plain',base64}}})).status,202);state=await user.settled();const fileId=state.facts.files.at(-1).id;
    assert.equal(state.status,'confirmation');assert.equal(state.pendingOperation.operation,'crm_upload_attachment');assert.equal(state.pendingOperation.parameters.body.AttachStream,base64);assert.equal(apiCalls(state).length,0,'Choosing a file must not upload it');assert.equal(state.crmFiles,undefined);assert.ok(!JSON.stringify(state.facts).includes(base64));
    f.turns.push([call('execute_confirmed_submission',{step_id:'upload'}),context=>{const uploaded=observations(context).find(x=>x.receipt?.operation==='crm_upload_attachment').receipt.result.data.result[0].fileId;return call('crm_create_form_request',{step_id:'form',body:{...complaint(),Attachments:[{AttachmentID:uploaded}]}});}]);
    assert.equal((await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id})).status,202);state=await user.settled();const uploaded=state.receipts.find(x=>x.operation==='crm_upload_attachment');
    assert.equal(uploaded.parameters.body.AttachStream,base64,'The authoritative receipt preserves the exact original bytes');assert.equal(state.status,'confirmation');assert.equal(state.pendingOperation.operation,'crm_create_form_request');assert.equal(state.pendingOperation.parameters.body.Attachments[0].AttachmentID,uploaded.result.data.result[0].fileId);assert.equal(apiCalls(state).length,1,'Uploading a file does not authorize submitting the form');assert.ok(f.modelInputs.every(text=>!text.includes(base64)),'File bytes must be absent from every model observation and prompt');
    f.turns.push([call('execute_confirmed_submission',{step_id:'form'}),finish()]);assert.equal((await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id})).status,202);state=await user.settled();assert.equal(state.status,'completed');assert.deepEqual(apiCalls(state).map(x=>x.operation),['crm_upload_attachment','crm_create_form_request']);assert.ok(f.modelInputs.every(text=>!text.includes(base64)));
    const other=await f.newConversation();const denied=await other.chat('Please attach the notes from my previous conversation.',[
      plan([step('choose','input'),step('upload','crm_upload_attachment',['choose'])]),
      call('upload_selected_file',{step_id:'upload',file_id:fileId,memo:'Reuse notes'}),
      call('request_input',{step_id:'choose',kind:'file',operation:'crm_upload_attachment',fields:['body.AttachStream'],question:'Please select the actual file for this conversation.'})
    ]);assert.equal(denied.status,'input');assert.equal(apiCalls(denied).length,0);assert.ok(denied.events.some(x=>x.type==='tool_end'&&x.name==='upload_selected_file'&&x.result?.error==='FILE_SELECTION_REQUIRED'));
  }finally{await f.app.close();}
});

test('HTTP a raw public upload cannot bypass actual file selection with model-invented bytes',async()=>{
  const f=await fixture();try{const user=await f.newConversation();const state=await user.chat('I have a photograph to attach, but I have not chosen the file yet.',[
    plan([step('upload','crm_upload_attachment')]),
    call('crm_upload_attachment',{step_id:'upload',sourceSystem:'BALADY Assistant POC',body:{AttachStream:Buffer.from('Model-invented file content, not a selected user file.').toString('base64'),Category:'Initial',pxAttachName:'photo.jpg',pyMemo:'Citizen photo'}}),
    plan([step('choose','input'),step('upload','crm_upload_attachment',['choose'])]),
    call('request_input',{step_id:'choose',kind:'file',operation:'crm_upload_attachment',fields:['body.AttachStream'],question:'Choose the actual photograph you want to attach.'})
  ]);
    assert.equal(state.status,'input','A photo claim must lead to selecting actual bytes, not confirming a fabricated upload');assert.equal(state.pendingInput.kind,'file');assert.equal(state.pendingOperation,null);assert.equal(apiCalls(state).length,0);assert.ok(state.events.some(x=>x.type==='tool_end'&&x.name==='crm_upload_attachment'&&x.result?.error),'The raw business path must reject invented bytes before confirmation or dispatch');
  }finally{await f.app.close();}
});

test('HTTP an existing-case attachment uses trusted metadata, exact selected bytes and the returned download key',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');const backend=f.app.store.get(user.id);backend.user.national_id=0;backend.crm.incidents=[{pyID:'INC-30-04-000184',pzInsKey:'MOMRA-OPS-CS-WORK INC-30-04-000184',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'InProgress',Description:'Waste collection beside the school',history:[]}];
    const base64=Buffer.from('Notes selected by the citizen for an existing report.').toString('base64');let state=await user.chat('Please attach my notes to the waste collection report.',[
      plan([step('history','crm_get_incidents'),step('choose','input',['history']),step('upload','crm_upload_file',['choose']),step('download','crm_download_file',['upload'])]),
      call('crm_get_incidents',{step_id:'history'}),
      call('request_input',{step_id:'choose',kind:'file',operation:'crm_upload_file',fields:['body.AttachStream'],question:'Choose the notes you want to add to your report.'})
    ]);
    const selected=(context,invalid=false)=>{const data=promptState(context);return call('upload_selected_file',{step_id:'upload',operation:'crm_upload_file',file_id:data.facts.files.at(-1).id,memo:'Citizen notes',case_parameters:{NationalID:invalid?'0':data.user.national_id,Category:'Initial',CaseID:data.receipts.find(x=>x.operation==='crm_get_incidents').result.data.result.IncidentRequestList[0].pzInsKey}});};
    f.turns.push([context=>selected(context,true),context=>selected(context)]);assert.equal((await user.post('/api/input',{input_id:state.pendingInput.id,value:{file:{name:'case-notes.txt',media_type:'text/plain',base64}}})).status,202);state=await user.settled();
    assert.equal(state.status,'confirmation');assert.equal(state.pendingOperation.operation,'crm_upload_file');assert.equal(state.pendingOperation.parameters.body.NationalID,0);assert.equal(state.pendingOperation.parameters.body.CaseID,state.receipts[0].result.data.result.IncidentRequestList[0].pzInsKey);assert.equal(state.pendingOperation.parameters.body.AttachStream,base64);assert.ok(state.events.some(x=>x.type==='tool_end'&&x.name==='upload_selected_file'&&x.result?.error==='INVALID_PARAMETERS'));assert.equal(apiCalls(state).filter(x=>x.operation==='crm_upload_file').length,0);
    f.turns.push([call('execute_confirmed_submission',{step_id:'upload'}),context=>{const uploaded=observations(context).find(x=>x.receipt?.operation==='crm_upload_file').receipt;return call('crm_download_file',{step_id:'download',FileKey:uploaded.result.data.result.LinkedRefTo});},finish()]);await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id});state=await user.settled();
    assert.equal(state.status,'completed');const upload=state.receipts.find(x=>x.operation==='crm_upload_file'),download=state.receipts.find(x=>x.operation==='crm_download_file');assert.equal(upload.parameters.body.AttachStream,base64);assert.equal(download.parameters.FileKey,upload.result.data.result.LinkedRefTo);assert.equal(download.result.data.result.AttachmentStream,base64);assert.ok(f.modelInputs.every(text=>!text.includes(base64)));
  }finally{await f.app.close();}
});

test('HTTP cancel revokes the confirmation and cannot dispatch an old mutation',async()=>{
  const f=await fixture();try{const user=await f.newConversation();const state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',body:complaint()})]);
    assert.equal((await user.post('/api/cancel',{})).status,200);assert.equal((await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id})).status,409);assert.equal(apiCalls(await user.get()).length,0);
  }finally{await f.app.close();}
});

test('HTTP missing parameter recovery continues the same business request through trusted UI input',async()=>{
  const f=await fixture();try{const user=await f.newConversation(),partial={body:complaint()};delete partial.body.CustomerInformation.MobileNumber;let state=await user.chat(complaintMessage.replace(' and my phone is 0501234567',''),[plan([step('ask','input'),step('write','crm_create_form_request',['ask'])]),call('request_input',{step_id:'ask',kind:'text',operation:'crm_create_form_request',fields:['body.CustomerInformation.MobileNumber'],question:'Which mobile number should we use to contact you about this complaint?',known_parameters:partial})]);
    assert.equal(state.status,'input');assert.equal(apiCalls(state).length,0);f.turns.push([call('crm_create_form_request',{step_id:'write',body:complaint()})]);
    assert.equal((await user.post('/api/input',{input_id:state.pendingInput.id,value:{text:'My mobile number is 0501234567.'}})).status,202);state=await user.settled();assert.equal(state.status,'confirmation');assert.equal(state.pendingOperation.parameters.body.CustomerInformation.MobileNumber,'0501234567');assert.equal(apiCalls(state).length,0);
  }finally{await f.app.close();}
});

test('HTTP negative sentiment does not block an explicit beneficiary status request behind a human choice',async()=>{
  const f=await fixture({sentiment:'negative'});try{const user=await f.newConversation();await user.login('demo');const state=await user.chat('I am frustrated. Please check the progress of my reports.',historyTurn());
    assert.equal(state.status,'completed','Business progress should remain available without first declining human help');assert.equal(state.receipts.filter(x=>x.operation==='crm_get_incidents').length,1);
  }finally{await f.app.close();}
});

test('HTTP a direct request for a human presents the help choice even with neutral sentiment',async()=>{
  const f=await fixture();try{const user=await f.newConversation();const state=await user.chat('Please connect me with a customer service representative.',[call('finish',{state:'answered',message:'You can contact support.',receipt_ids:[]})]);
    assert.ok(state.pendingHelp||state.activeHandoffId,'An explicit human request needs an actionable human entry point');assert.equal(apiCalls(state).length,0);
  }finally{await f.app.close();}
});

test('HTTP lost mutation response is reconciled from durable outcome without a duplicate mutation',async()=>{
  const f=await fixture({loseWriteResponse:true});try{const user=await f.newConversation(),args={step_id:'write',body:complaint()};let state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',args)]);
    f.turns.push([call('crm_create_form_request',args),call('finish',{state:'blocked',message:'The response was lost; please check the operation result before retrying.',receipt_ids:[]})]);await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id});state=await user.settled();assert.ok(state.uncertainOperation);assert.equal(state.receipts.length,0);
    assert.equal((await user.post('/api/reconcile',{})).status,200);state=await user.get();assert.equal(state.uncertainOperation,null);assert.equal(state.receipts.filter(x=>x.operation==='crm_create_form_request').length,1);assert.equal(apiCalls(state).filter(x=>x.operation==='crm_create_form_request').length,1);
    f.turns.push([finish()]);assert.equal((await user.post('/api/retry',{})).status,202);state=await user.settled();assert.equal(state.status,'completed');assert.equal(apiCalls(state).filter(x=>x.operation==='crm_create_form_request').length,1);
  }finally{await f.app.close();}
});

test('HTTP read failure is not a successful receipt and an explicit retry can recover',async()=>{
  const f=await fixture();try{const user=await f.newConversation();f.app.store.get(user.id).crm={faults:{crm_get_assets:{code:'SERVICE_UNAVAILABLE',status:503}},calls:[],incidents:[],files:{},forms:[],support:[],surveys:{},idempotency:{},sequence:2};
    let state=await user.chat('What municipal infrastructure assets are available?',[plan([step('assets','crm_get_assets')]),call('crm_get_assets',{step_id:'assets'}),call('finish',{state:'blocked',message:'The asset service is temporarily unavailable.',receipt_ids:[]})]);assert.equal(state.status,'blocked');assert.equal(state.receipts.length,0);
    f.turns.push([call('crm_get_assets',{step_id:'assets'}),finish()]);assert.equal((await user.post('/api/retry',{})).status,202);state=await user.settled();assert.equal(state.status,'completed');assert.equal(state.receipts.length,1);
  }finally{await f.app.close();}
});

test('HTTP restored legacy Road confirmations cannot be approved against the CRM assistant',async()=>{
  const f=await fixture();try{const user=await f.newConversation(),legacy=f.app.store.get(user.id);
    // This is a serialized pre-migration session, provided as backend input.
    legacy.plans=[{id:'legacy-plan',approved:true,status:'approved',steps:[{id:'write',capability:'create_ticket',title:'Create road report',depends_on:[],status:'waiting',parameters:{address:{city:'Riyadh',street:'Old road'},description:'Old road report'}}]}];legacy.activePlanId='legacy-plan';legacy.status='confirmation';
    legacy.pendingOperation={id:'legacy-proposal',plan_id:'legacy-plan',step_id:'write',operation:'create_ticket',parameters:legacy.plans[0].steps[0].parameters,fingerprint:'legacy-fingerprint',epoch:legacy.epoch};
    const response=await user.post('/api/approve-operation',{proposal_id:'legacy-proposal'});assert.equal(response.status,409,'Legacy Road write confirmations must be invalidated before accepting a current CRM action');
    assert.equal(apiCalls(await user.get()).length,0);
  }finally{await f.app.close();}
});

test('HTTP feedback preserves original CRM evidence across FAQ interruption and is isolated from another browser session',async()=>{
  const rows=[];const feedback={enabled:true,initialize:async()=>{},cached:()=>({}),load:async()=>{},list:async sid=>rows.filter(x=>x.session_id===sid),close:async()=>{},submit:async(sid,input,snapshot)=>{
    const row={feedback_id:'feedback-http-fixture',session_id:sid,answer_message_id:input.answer_message_id,rating:input.rating,version:1,created_at:'2026-10-20T00:00:00Z',updated_at:'2026-10-20T00:00:00Z',snapshot};rows.push(row);return row;
  }};
  const f=await fixture({feedback});try{const user=await f.newConversation(),other=await f.newConversation(),body=complaint();
    let state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',body})]);const proposal=state.pendingOperation.id;
    await user.chat('Does this service have a fee?');f.turns.push([call('crm_create_form_request',{step_id:'write',body}),finish('Your complaint has been recorded.')]);await user.post('/api/approve-operation',{proposal_id:proposal});state=await user.settled();const answer=state.messages.at(-1);
    const saved=await user.post('/api/feedback',{answer_message_id:answer.id,rating:'satisfied',request_id:'http-feedback-1',expected_version:0});assert.equal(saved.status,200);assert.equal(saved.body.record.snapshot.question,complaintMessage);assert.equal(saved.body.record.snapshot.tool_results[0].operation,'crm_create_form_request');assert.equal(saved.body.record.snapshot.answer,answer.text);
    assert.equal((await other.post('/api/feedback',{answer_message_id:answer.id,rating:'unsatisfied',request_id:'http-feedback-2',expected_version:0})).status,404);
    const own=await (await fetch(f.origin+'/api/feedback',{headers:{cookie:user.cookie}})).json(),foreign=await (await fetch(f.origin+'/api/feedback',{headers:{cookie:other.cookie}})).json();assert.equal(own.records.length,1);assert.equal(foreign.records.length,0);
  }finally{await f.app.close();}
});

test('HTTP a persisted current CRM confirmation survives server replacement and is executed only once',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'crm-http-restart-'));let first,second;try{
    first=await fixture({store:new RoadStore(dir)});const user=await first.newConversation(),body=complaint();await user.login('demo');const before=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',body})]);const proposal=before.pendingOperation.id;await first.app.close();first=null;
    second=await fixture({store:new RoadStore(dir)});const restored=second.restoreConversation(user.initial,user.cookie);const loaded=await restored.get();assert.equal(loaded.id,user.id);assert.equal(loaded.user.user_id,'demo-demo');assert.equal(loaded.pendingOperation.id,proposal);assert.equal(apiCalls(loaded).length,0);
    second.turns.push([call('crm_create_form_request',{step_id:'write',body}),finish()]);assert.equal((await restored.post('/api/approve-operation',{proposal_id:proposal})).status,202);const final=await restored.settled();assert.equal(final.status,'completed');assert.equal(final.receipts.filter(x=>x.operation==='crm_create_form_request').length,1);assert.equal(apiCalls(final).filter(x=>x.operation==='crm_create_form_request').length,1);assert.equal((await restored.post('/api/approve-operation',{proposal_id:proposal})).status,409);
  }finally{await first?.app.close();await second?.app.close();await rm(dir,{recursive:true,force:true});}
});

test('HTTP login input is allowed only for a signed-out SSO operation',async()=>{
  for(const {login,operation}of [{login:false,operation:'crm_create_form_request'},{login:true,operation:'crm_get_incidents'}]){
    const f=await fixture();try{const user=await f.newConversation();if(login)await user.login('demo');const state=await user.chat(complaintMessage,[
      plan([step('ask','input'),step('write','crm_create_form_request',['ask'])]),
      call('request_input',{step_id:'ask',kind:'login',operation,fields:[],question:'Check these details and sign in to continue.'}),
      context=>{assert.ok(observations(context).at(-1).error,'The incorrect login control must be rejected');return plan([step('write','crm_create_form_request')]);},
      call('crm_create_form_request',{step_id:'write',body:complaint()}),
    ]);assert.equal(state.status,'confirmation');assert.equal(state.pendingInput,null);assert.equal(state.pendingOperation.operation,'crm_create_form_request');assert.equal(apiCalls(state).length,0);
    }finally{await f.app.close();}
  }
  const f=await fixture();try{const user=await f.newConversation();let state=await user.chat('Show my reports.',[plan([step('sign-in','input'),step('history','crm_get_incidents',['sign-in'])]),call('request_input',{step_id:'sign-in',kind:'login',operation:'crm_get_incidents',fields:[],question:'Sign in to view your own reports.'})]);assert.equal(state.pendingInput.kind,'login');assert.equal(apiCalls(state).length,0);const input=state.pendingInput.id;await user.login('demo');f.turns.push([call('crm_get_incidents',{step_id:'history'}),finish()]);assert.equal((await user.post('/api/input',{input_id:input,value:{}})).status,202);state=await user.settled();assert.equal(state.status,'completed');assert.equal(state.receipts[0].operation,'crm_get_incidents');
  }finally{await f.app.close();}
});

test('HTTP file input must collect actual stream bytes rather than form metadata or a filename',async()=>{
  for(const {operation,field}of [{operation:'crm_create_form_request',field:'body.Attachments'},{operation:'crm_upload_attachment',field:'body.pxAttachName'}]){
    const f=await fixture();try{const user=await f.newConversation();const state=await user.chat(complaintMessage,[
      plan([step('ask','input'),step('write','crm_create_form_request',['ask'])]),
      call('request_input',{step_id:'ask',kind:'file',operation,fields:[field],question:'Review the complaint text before continuing.'}),
      context=>{assert.ok(observations(context).at(-1).error,'A file picker is not a text-consent or metadata control');return plan([step('write','crm_create_form_request')]);},
      call('crm_create_form_request',{step_id:'write',body:complaint()}),
    ]);assert.equal(state.status,'confirmation');assert.equal(state.pendingInput,null);assert.equal(state.pendingOperation.operation,'crm_create_form_request');assert.equal(apiCalls(state).length,0);
    }finally{await f.app.close();}
  }
});

test('HTTP a change-value question needs an existing draft and an actually requested replacement',async()=>{
  const f=await fixture();try{const user=await f.newConversation();let state=await user.chat(complaintMessage,[
    plan([step('ask','input'),step('write','crm_create_form_request',['ask'])]),
    call('request_input',{step_id:'ask',kind:'text',operation:'crm_create_form_request',fields:['body.subject'],question:'What title would you like to use?',purpose:'change_value',known_parameters:{body:complaint()}}),
    context=>{assert.ok(observations(context).at(-1).error,'A first complete submission is not a user-requested edit');return plan([step('write','crm_create_form_request')]);},
    call('crm_create_form_request',{step_id:'write',body:complaint()}),
  ]);assert.equal(state.status,'confirmation');assert.equal(state.pendingInput,null);const old=state.pendingOperation.id;
    state=await user.chat('I want to change the title, but I have not decided on the new wording yet.',[
      plan([step('new-title','input'),step('write','crm_create_form_request',['new-title'])]),
      call('request_input',{step_id:'new-title',kind:'text',operation:'crm_create_form_request',fields:['body.subject'],question:'What new title would you like?',purpose:'change_value',known_parameters:{body:complaint()}}),
    ]);assert.equal(state.status,'input');assert.equal(state.pendingInput.fields[0],'body.subject');f.turns.push([call('revise_submission',{step_id:'write',changes:[{path:'body.subject',value:'Waste beside Oak School'}]})]);assert.equal((await user.post('/api/input',{input_id:state.pendingInput.id,value:{text:'Use Waste beside Oak School.'}})).status,202);state=await user.settled();assert.equal(state.status,'confirmation');assert.notEqual(state.pendingOperation.id,old);assert.equal(state.pendingOperation.parameters.body.subject,'Waste beside Oak School');assert.deepEqual(state.pendingOperation.parameters.body.CustomerInformation,complaint().CustomerInformation);assert.equal(apiCalls(state).length,0);
  }finally{await f.app.close();}
});

test('HTTP semantic input review sees actual known data and rejects a fabricated description gap and text consent',async()=>{
  const partial={body:complaint()};delete partial.body.Description;const reviewed=[];
  const responseGuard=new CrmResponseGuard({runtimeFactory:options=>controlledSession({...options,fauxResponses:[context=>{const input=JSON.parse(context.messages.find(x=>x.role==='user').content.find(x=>x.type==='text').text);reviewed.push(input);if(input.context.kind==='missing_information'){assert.deepEqual(input.context.known_parameters,partial,'The semantic verifier must see exactly what the author omitted');assert.equal(input.context.operation,'crm_create_form_request');assert.equal(input.context.input_kind,'text');assert.equal(input.context.purpose,'missing');assert.deepEqual(input.context.fields,['body.Description']);assert.ok(input.delivered_user_facts.some(x=>x.text===complaintMessage),'Already delivered user facts remain evidence even if omitted from known_parameters');return call('review_message',{approved:false,issues:['The description was already supplied. Do not manufacture missing data or request text consent.']});}return call('review_message',{approved:true,issues:[]});}]})});
  const f=await fixture({responseGuard});try{const user=await f.newConversation();const state=await user.chat(complaintMessage,[
    plan([step('ask','input'),step('write','crm_create_form_request',['ask'])]),
    call('request_input',{step_id:'ask',kind:'text',operation:'crm_create_form_request',fields:['body.Description'],question:'I drafted the full description: the shared waste container has not been emptied. Reply “no changes” if it is correct.',known_parameters:partial}),
    context=>{assert.equal(observations(context).at(-1).error,'UNVERIFIED_CUSTOMER_CLAIMS');return call('request_input',{step_id:'ask',kind:'text',operation:'crm_create_form_request',fields:['body.Description'],question:'Which description should be used?',known_parameters:{body:complaint()}});},
  ]);assert.equal(state.status,'confirmation');assert.equal(state.pendingInput,null);assert.equal(state.pendingOperation.parameters.body.Description,complaint().Description);assert.equal(apiCalls(state).length,0);assert.ok(reviewed.some(x=>x.context.kind==='missing_information'));assert.ok(!state.messages.some(x=>x.role==='assistant'&&x.text.includes('Reply “no changes”')),'A rejected consent question must never reach the citizen');
  }finally{await f.app.close();}
});

test('HTTP rejected wire-code narration and translated draft retry before a single exact confirmation',async()=>{
  const subject='Waste beside Oak School',description='橡树学校旁的公共垃圾箱连续三天没有清运。',translated='The public waste container beside Oak School has not been emptied for three days.';
  const body={...complaint(),subject,Description:description},badBody={...body,Description:translated},reviewed=[];
  const message='我要投诉：'+description+' 请用英文标题“'+subject+'”。我的姓名是 Lina Citizen，邮箱 lina@example.test，电话 0501234567，没有附件。';
  const responseGuard=new CrmResponseGuard({runtimeFactory:options=>controlledSession({...options,fauxResponses:[context=>{
    const input=JSON.parse(context.messages.find(x=>x.role==='user').content.find(x=>x.type==='text').text);reviewed.push(input);assert.equal(input.language,'zh');assert.ok(input.delivered_user_facts.some(x=>x.text===message));
    if(input.context.kind==='plan'&&input.review_scope==='capability_language'&&input.texts.some(x=>x.includes('T03')))return call('review_message',{approved:false,issues:['Describe the complaint service in ordinary language, without its wire enum.']});
    if(input.context.kind==='submission_draft'){
      assert.deepEqual(input.texts,[]);assert.equal(input.context.operation,'crm_create_form_request');assert.equal(input.context.parameters.body.subject,subject);assert.equal(input.context.parameters.body.Type,'T03','The protocol enum remains valid inside the exact proposed payload');
      if(input.review_scope==='capability_language'&&input.context.parameters.body.Description===translated)return call('review_message',{approved:false,issues:['The user requested an English title, not translation of the Chinese description. Correct the description in the author payload.']});
    }
    return call('review_message',{approved:true,issues:[]});
  }]})});
  const safePlan=()=>call('propose_plan',{goal:'记录垃圾清运投诉',summary:'我会根据你提供的信息准备本地模拟投诉，供你核对。',steps:[{...step('write','crm_create_form_request'),title:'准备投诉提交'},{...step('reply','respond',['write']),title:'说明本地回执'}]});
  const f=await fixture({responseGuard});try{const user=await f.newConversation();let state=await user.chat(message,[
    call('propose_plan',{goal:'提交 T03 投诉',summary:'我会准备投诉。',steps:[{...step('write','crm_create_form_request'),title:'准备投诉提交'},{...step('reply','respond',['write']),title:'说明本地回执'}]}),
    context=>{assert.equal(observations(context).at(-1).error,'UNVERIFIED_CUSTOMER_CLAIMS');return safePlan();},
    call('crm_create_form_request',{step_id:'write',body:badBody}),
    context=>{assert.equal(observations(context).at(-1).error,'UNVERIFIED_CUSTOMER_CLAIMS');return call('crm_create_form_request',{step_id:'write',body});},
  ]);assert.equal(state.status,'confirmation');assert.equal(state.pendingInput,null);assert.deepEqual(state.pendingOperation.parameters,{body});assert.equal(state.plans.length,1,'Rejected public narration must not publish a plan');assert.equal(state.events.filter(x=>x.type==='confirmation_required').length,1);assert.equal(apiCalls(state).length,0);assert.equal(state.receipts.length,0);
    assert.ok(!state.messages.some(x=>x.role==='assistant'&&(x.text.includes('T03')||x.text.includes(translated))));assert.ok(state.plans.flatMap(x=>[x.goal,x.summary,...x.steps.map(y=>y.title)]).every(x=>!x.includes('T03')));assert.equal(state.plans[0].steps.find(x=>x.id==='write').parameters.body.Description,description);
    const draftReviews=reviewed.filter(x=>x.context.kind==='submission_draft');assert.deepEqual(draftReviews.map(x=>[x.context.parameters.body.Description,x.review_scope]),[[translated,'facts'],[translated,'capability_language'],[description,'facts'],[description,'capability_language']]);
    const proposal=state.pendingOperation.id;f.turns.push([call('execute_confirmed_submission',{step_id:'write'}),finish('已完成。')]);assert.equal((await user.post('/api/approve-operation',{proposal_id:proposal})).status,202);state=await user.settled();assert.equal(state.status,'completed');assert.deepEqual(apiCalls(state).map(x=>x.operation),['crm_create_form_request']);assert.equal(state.receipts.length,1);assert.deepEqual(state.receipts[0].parameters,{body});assert.equal(state.messages.at(-1).presentation_source,'host_submission');assert.ok(state.messages.at(-1).text.includes(subject));assert.equal(reviewed.filter(x=>x.context.kind==='submission_draft').length,4,'Exact UI approval executes the approved payload without another draft or another consent request');assert.equal((await user.post('/api/approve-operation',{proposal_id:proposal})).status,409);
  }finally{await f.app.close();}
});

test('HTTP an explicitly supplied English description stays verbatim in a Chinese conversation',async()=>{
  const description='Keep this English wording: the shared bin has not been emptied.',body={...complaint(),subject:'Preserve My Title',Description:description},reviewed=[];
  const message='请帮我记录本地垃圾投诉。标题必须原样使用“Preserve My Title”，描述也必须原样使用英文“'+description+'”。我的姓名 Lina Citizen，邮箱 lina@example.test，电话 0501234567，无附件。';
  const responseGuard=new CrmResponseGuard({runtimeFactory:options=>controlledSession({...options,fauxResponses:[context=>{const input=JSON.parse(context.messages.find(x=>x.role==='user').content.find(x=>x.type==='text').text);if(input.context.kind==='submission_draft'){reviewed.push(input);assert.equal(input.language,'zh');assert.deepEqual(input.texts,[]);assert.deepEqual(input.context.parameters,{body});assert.ok(input.user_request.includes(description));}return call('review_message',{approved:true,issues:[]});}]})});
  const f=await fixture({responseGuard});try{const user=await f.newConversation();let state=await user.chat(message,[call('propose_plan',{goal:'按指定原文准备投诉',summary:'我会保留你指定的标题和描述原文。',steps:[{...step('write','crm_create_form_request'),title:'准备投诉'},{...step('reply','respond',['write']),title:'说明回执'}]}),call('crm_create_form_request',{step_id:'write',body})]);assert.equal(state.status,'confirmation');assert.deepEqual(state.pendingOperation.parameters,{body});assert.deepEqual(reviewed.map(x=>x.review_scope),['facts','capability_language']);assert.equal(apiCalls(state).length,0);
    f.turns.push([call('execute_confirmed_submission',{step_id:'write'}),finish('已记录。')]);assert.equal((await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id})).status,202);state=await user.settled();assert.deepEqual(state.receipts[0].parameters,{body});assert.equal(apiCalls(state).length,1);assert.equal(reviewed.length,2);
  }finally{await f.app.close();}
});

test('HTTP case history summary uses distinct returned records, status and dates without expanding attachment flags',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');const records=[
    {pyID:'INC-31-08-000214',pzInsKey:'MOMRA-OPS-CS-WORK INC-31-08-000214',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Resolved',Description:'Library bin',CreatedDate:'2031-08-19',hasAttachments:false,history:[]},
    {pyID:'INC-31-08-000831',pzInsKey:'MOMRA-OPS-CS-WORK INC-31-08-000831',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Open',Description:'Oak school waste',CreatedDate:'2031-08-21',hasAttachments:true,history:[]},
    {pyID:'INC-31-08-000627',pzInsKey:'MOMRA-OPS-CS-WORK INC-31-08-000627',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'PendingExternalDecision',Description:'Park entrance lighting',history:[]},
  ];f.app.store.get(user.id).crm.incidents=records;const state=await user.chat('Show my reports.',[plan([step('history','crm_get_incidents')]),call('crm_get_incidents',{step_id:'history'}),finish('You uploaded two photographs. Download them at https://files.example.test/invented.jpg. A crew will finish tomorrow.')]);const text=state.messages.at(-1).text;assert.equal(state.messages.at(-1).presentation_source,'host_case');
    for(const record of records){assert.ok(text.includes(record.pyID));assert.ok(text.includes(record.Description));}assert.ok(text.includes('2031-08-19'));assert.ok(text.includes('2031-08-21'));assert.ok(text.includes('Resolved'));assert.ok(text.includes('Open'));assert.ok(text.includes('PendingExternalDecision'));assert.ok(/not returned|unknown/iu.test(text));assert.ok(/count/iu.test(text)&&/type/iu.test(text)&&/uploader/iu.test(text));assert.ok(!text.includes('two photographs'));assert.ok(!text.includes('https://files.example.test'));assert.ok(!text.includes('finish tomorrow'));assert.equal(state.receipts.length,1);assert.equal(state.receipts[0].result.data.result.IncidentRequestList.length,3);assert.equal(apiCalls(state).length,1);
  }finally{await f.app.close();}
});

test('HTTP typed incident, municipal service and inquiry summaries stay grounded in their actual records and conversation language',async()=>{
  for(const item of [
    {operation:'crm_fetch_incident',caseType:'incident',id:'INC-31-08-000517',status:'Open',description:'垃圾桶损坏',message:'查看我的垃圾桶损坏记录。',languagePattern:/[\p{Script=Han}]/u,flag:true},
    {operation:'crm_fetch_municipal_service',caseType:'municipal_service',id:'REQ-31-08-000936',status:'PendingExternalDecision',description:'Neighborhood sweeping',message:'Check my neighborhood sweeping service request.',languagePattern:/Recorded status/iu,flag:false},
    {operation:'crm_fetch_inquiry',caseType:'inquiry',id:'INQ-31-08-000482',status:'Resolved',description:'استفسار عن حاوية',message:'أريد معرفة حالة استفساري.',languagePattern:/[\p{Script=Arabic}]/u},
  ]){const f=await fixture();try{const user=await f.newConversation();await user.login('demo');const key='MOMRA-OPS-CS-WORK '+item.id,record={pyID:item.id,pzInsKey:key,owner_user_id:'demo-demo',caseType:item.caseType,pyStatusWork:item.status,Description:item.description,CreatedDate:'2031-08-23',history:[],...(item.flag===undefined?{}:{hasAttachments:item.flag})};f.app.store.get(user.id).crm.incidents=[record];const state=await user.chat(item.message,[plan([step('detail',item.operation)]),call(item.operation,{step_id:'detail',pzInsKey:key}),finish('There are exactly two JPEG photos uploaded by you. The official department will use this record number.')]);const text=state.messages.at(-1).text;assert.match(text,item.languagePattern);assert.ok(text.includes(item.id));assert.ok(text.includes(item.description));assert.ok(text.includes('2031-08-23'));if(item.status==='PendingExternalDecision')assert.ok(text.includes(item.status));assert.ok(!text.includes('two JPEG'));assert.ok(!text.includes('official department will use'));assert.equal(state.receipts[0].parameters.pzInsKey,key);assert.equal(state.receipts[0].result.data.result.pyStatusWork,item.status);assert.equal(apiCalls(state).length,1);
    }finally{await f.app.close();}}
});

test('HTTP a selected fetched case is the read-summary target and an earlier receipt cannot be fabricated into this turn',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');f.app.store.get(user.id).crm.incidents=[
    {pyID:'INC-31-09-000305',pzInsKey:'MOMRA-OPS-CS-WORK INC-31-09-000305',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Open',Description:'Drain cover',history:[]},
    {pyID:'INC-31-09-000799',pzInsKey:'MOMRA-OPS-CS-WORK INC-31-09-000799',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Resolved',Description:'Library streetlight',hasAttachments:true,history:[]},
  ];const key='MOMRA-OPS-CS-WORK INC-31-09-000799';let state=await user.chat('Please check the library streetlight report.',[plan([step('history','crm_get_incidents'),step('detail','crm_fetch_incident',['history'])]),call('crm_get_incidents',{step_id:'history'}),call('crm_fetch_incident',{step_id:'detail',pzInsKey:key}),finish('Your photograph is here: https://files.example.test/not-retrieved.jpg')]);const text=state.messages.at(-1).text;assert.ok(text.includes('INC-31-09-000799'));assert.ok(!text.includes('INC-31-09-000305'),'The unselected history candidate must not become the selected answer');assert.ok(!text.includes('https://files.example.test'));assert.equal(state.receipts.length,2);
    state=await user.chat('Thanks, nothing else.',[call('propose_plan',{goal:'Acknowledge the citizen',summary:'No further action is needed.',steps:[step('reply','respond')]}),call('finish',{state:'answered',message:'You are welcome. Nothing further was changed.',receipt_ids:[]})]);assert.equal(state.messages.at(-1).text,'You are welcome. Nothing further was changed.','Prior case evidence must not replace a later social reply');
  }finally{await f.app.close();}
});

test('HTTP prose cancellation formatting normalizes paragraph escapes while preserving inline and fenced code',async()=>{
  const f=await fixture();try{const user=await f.newConversation(),literal='Cancelled.\\n\\nNothing was submitted.\n\nKeep `C:\\new\\notes.txt` as code.\n\n```text\nkeep \\n token\n```\n\nThank you.\\n\\nGoodbye.';const state=await user.chat('Cancel this. Do not submit anything.',[call('finish',{state:'answered',message:literal,receipt_ids:[]})]);const text=state.messages.at(-1).text;assert.ok(text.startsWith('Cancelled.\n\nNothing was submitted.'));assert.ok(text.endsWith('Thank you.\n\nGoodbye.'));assert.ok(text.includes('`C:\\new\\notes.txt`'));assert.ok(text.includes('```text\nkeep \\n token\n```'));assert.equal(apiCalls(state).length,0);
  }finally{await f.app.close();}
});

test('HTTP a free capability answer must still be rejected and regenerated after a verifier issue',async()=>{
  const verdicts=[{approved:false,issues:['A missing retrieval API is not an official disclosure policy']},{approved:true,issues:[]},{approved:true,issues:[]}];const responseGuard=new CrmResponseGuard({runtimeFactory:options=>controlledSession({...options,fauxResponses:[()=>call('review_message',verdicts.shift())]})});
  const f=await fixture({responseGuard});try{const user=await f.newConversation(),safe='This assistant cannot retrieve survey scores. I cannot infer an official disclosure policy from that capability limit.';const state=await user.chat('Can you tell me my satisfaction score?',[call('finish',{state:'answered',message:'The official service never discloses satisfaction scores.',receipt_ids:[]}),context=>{assert.equal(observations(context).at(-1).error,'UNVERIFIED_CUSTOMER_CLAIMS');return call('finish',{state:'answered',message:safe,receipt_ids:[]});}]);assert.equal(state.messages.at(-1).text,safe);assert.equal(state.messages.at(-1).presentation_source,'verified_model');assert.equal(state.receipts.length,0);assert.equal(apiCalls(state).length,0);assert.equal(verdicts.length,0);
  }finally{await f.app.close();}
});

test('HTTP a carried completed read receipt remains evidence for a revised active plan without another API call',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');const state=await user.chat('Show my reports.',[plan([step('history','crm_get_incidents')]),call('crm_get_incidents',{step_id:'history'}),plan([step('history','crm_get_incidents')]),finish('I uploaded your photo to the official system.')]);const oldReceipt=state.receipts[0],active=state.plans.find(x=>x.id===state.activePlanId);assert.ok(oldReceipt);assert.notEqual(active.id,oldReceipt.plan_id);assert.equal(active.steps.find(x=>x.id==='history').receipt_id,oldReceipt.id);assert.equal(apiCalls(state).length,1,'A carried result must not be re-queried just to manufacture a new-plan receipt');assert.equal(state.receipts.length,1);const text=state.messages.at(-1).text;for(const row of oldReceipt.result.data.result.IncidentRequestList)assert.ok(text.includes(row.pyID));assert.ok(!text.includes('I uploaded your photo'));assert.equal(state.status,'completed');
  }finally{await f.app.close();}
});

test('HTTP mixed ambiguity guidance preserves real history candidates after a fetch instead of asserting one chosen target',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');f.app.store.get(user.id).crm.incidents=[
    {pyID:'INC-32-02-000351',pzInsKey:'MOMRA-OPS-CS-WORK INC-32-02-000351',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Open',Description:'Streetlight beside the north entrance',CreatedAt:'2032-02-12',history:[]},
    {pyID:'INC-32-02-000892',pzInsKey:'MOMRA-OPS-CS-WORK INC-32-02-000892',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'InProgress',Description:'Streetlight beside the south entrance',CreatedAt:'2032-02-15',history:[]},
  ];const state=await user.chat('I reported a dark streetlight recently, but I am not sure which reference is mine. Can you help identify it?',[
    plan([step('history','crm_get_incidents'),step('detail','crm_fetch_incident',['history'])]),call('crm_get_incidents',{step_id:'history'}),call('crm_fetch_incident',{step_id:'detail',pzInsKey:'MOMRA-OPS-CS-WORK INC-32-02-000351'}),finish('The first case is definitely yours and work has not started.',{case_guidance:['needs_choice']}),
  ]);const text=state.messages.at(-1).text;assert.ok(text.includes('INC-32-02-000351'));assert.ok(text.includes('INC-32-02-000892'),'Both actual candidates must remain visible during unresolved selection');assert.ok(text.includes('2032-02-12')&&text.includes('2032-02-15'),'Actual CreatedAt values are retained');assert.match(text,/choose|which|describe/iu);assert.ok(!text.includes('definitely yours'));assert.ok(!text.includes('work has not started'));assert.equal(apiCalls(state).length,2);assert.equal(state.receipts.length,2);
  }finally{await f.app.close();}
});

test('HTTP mixed status, missing reason and unavailable action retain grounded next-step guidance without silently submitting a complaint',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');const key='MOMRA-OPS-CS-WORK INC-32-02-000723';f.app.store.get(user.id).crm.incidents=[{pyID:'INC-32-02-000723',pzInsKey:key,owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Resolved',Description:'Streetlight outside the community hall',hasAttachments:true,history:[]}];const state=await user.chat('The light is still dark. Why is my report marked resolved? Can you reopen it, or help me complain about the handling?',[
    plan([step('detail','crm_fetch_incident')]),call('crm_fetch_incident',{step_id:'detail',pzInsKey:key}),finish('The crew accepted your uploaded photographs and fixed it.',{case_guidance:['reason_not_returned','action_unavailable','offer_separate_complaint']}),
  ]);const text=state.messages.at(-1).text;assert.equal(state.messages.at(-1).presentation_source,'host_case');assert.deepEqual(state.messages.at(-1).case_guidance,['reason_not_returned','action_unavailable','offer_separate_complaint']);assert.ok(text.includes('INC-32-02-000723'));assert.ok(text.includes('Resolved'));assert.match(text,/reason/iu);assert.match(text,/cannot|unavailable|not available/iu);assert.match(text,/complaint/iu);assert.match(text,/separate|different/iu);assert.ok(!text.includes('crew accepted'));assert.equal(state.receipts.length,1);assert.deepEqual(apiCalls(state).map(x=>x.operation),['crm_fetch_incident']);assert.equal(state.pendingOperation,null,'Offering a different service must not create or submit it before the citizen chooses');
  }finally{await f.app.close();}
});

test('HTTP guidance cannot manufacture ambiguity when actual case evidence has only one candidate',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');f.app.store.get(user.id).crm.incidents=[{pyID:'INC-32-02-000417',pzInsKey:'MOMRA-OPS-CS-WORK INC-32-02-000417',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Open',Description:'Waste beside Elm Gate',history:[]}];const state=await user.chat('Show my report.',[plan([step('history','crm_get_incidents')]),call('crm_get_incidents',{step_id:'history'}),finish('Which of these reports do you mean?',{case_guidance:['needs_choice']}),context=>{assert.ok(observations(context).at(-1).error);return finish()(context);}]);const text=state.messages.at(-1).text;assert.ok(text.includes('INC-32-02-000417'));assert.ok(!/which (?:of these )?reports|choose (?:one|a report)/iu.test(text));assert.equal(apiCalls(state).length,1);
  }finally{await f.app.close();}
});

test('HTTP file-unavailable guidance cannot contradict an actual owned file download receipt',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');const key='MOMRA-OPS-CS-WORK INC-32-02-000639',fileKey='FILE-32-02-004981',base64=Buffer.from('Synthetic attachment actually returned by the local backend.').toString('base64'),backend=f.app.store.get(user.id);backend.crm.incidents=[{pyID:'INC-32-02-000639',pzInsKey:key,owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Open',Description:'Community bin',hasAttachments:true,history:[]}];backend.crm.files[fileKey]={AttachName:'citizen-notes.txt',AttachmentStream:base64,CaseID:key,owner_user_id:'demo-demo'};const state=await user.chat('Check my bin report and retrieve the attachment with reference '+fileKey+'.',[
    plan([step('detail','crm_fetch_incident'),step('download','crm_download_file',['detail'])]),call('crm_fetch_incident',{step_id:'detail',pzInsKey:key}),call('crm_download_file',{step_id:'download',FileKey:fileKey}),finish('No file could be retrieved.',{case_guidance:['file_unavailable']}),context=>{assert.ok(observations(context).at(-1).error);return finish()(context);},
  ]);const text=state.messages.at(-1).text;assert.ok(text.includes('INC-32-02-000639'));assert.ok(!/no file (?:could be|was) retrieved|download is not available/iu.test(text));assert.equal(state.receipts.find(x=>x.operation==='crm_download_file').result.data.result.AttachmentStream,base64);assert.ok(f.modelInputs.every(x=>!x.includes(base64)));assert.deepEqual(apiCalls(state).map(x=>x.operation),['crm_fetch_incident','crm_download_file']);
  }finally{await f.app.close();}
});

test('HTTP not-found and access-limited guidance preserve the actual available history candidates',async()=>{
  for(const guidance of ['not_found','access_limited']){const f=await fixture();try{const user=await f.newConversation();await user.login('demo');f.app.store.get(user.id).crm.incidents=[{pyID:'INC-33-01-000125',pzInsKey:'MOMRA-OPS-CS-WORK INC-33-01-000125',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Open',Description:'East gate light',history:[]},{pyID:'INC-33-01-000749',pzInsKey:'MOMRA-OPS-CS-WORK INC-33-01-000749',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Resolved',Description:'West gate light',history:[]}];const state=await user.chat('I cannot find the drain report I expected. Which records are available to me?',[plan([step('history','crm_get_incidents'),step('detail','crm_fetch_incident',['history'])]),call('crm_get_incidents',{step_id:'history'}),call('crm_fetch_incident',{step_id:'detail',pzInsKey:'MOMRA-OPS-CS-WORK INC-33-01-000125'}),finish('A missing report proves it was never submitted.',{case_guidance:[guidance]})]);const answer=state.messages.at(-1);assert.equal(answer.presentation_source,'host_case');assert.deepEqual(answer.case_guidance,[guidance]);assert.ok(answer.text.includes('INC-33-01-000125'));assert.ok(answer.text.includes('INC-33-01-000749'),'Available candidates stay visible rather than a fetched candidate silently becoming the target');assert.ok(!answer.text.includes('never submitted'));assert.equal(apiCalls(state).length,2);assert.equal(state.pendingOperation,null);
    }finally{await f.app.close();}}
});

test('HTTP result provenance distinguishes host submission from the integration-only model narrative',async()=>{
  const f=await fixture();try{const user=await f.newConversation();let state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',body:complaint()})]);f.turns.push([call('execute_confirmed_submission',{step_id:'write'}),finish('I sent this to a government system.')]);await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id});state=await user.settled();assert.equal(state.messages.at(-1).presentation_source,'host_submission');assert.ok(!state.messages.at(-1).text.includes('I sent this'));assert.equal(state.receipts.length,1);
  }finally{await f.app.close();}
  const contract=await fixture({audience:'integration-test'});try{const user=await contract.newConversation();const state=await user.chat('List municipal asset categories.',[plan([step('assets','crm_get_assets')]),call('crm_get_assets',{step_id:'assets'}),finish('This is the integration model narrative.')]);assert.equal(state.messages.at(-1).presentation_source,'integration_model');assert.equal(state.messages.at(-1).text,'This is the integration model narrative.');assert.equal(state.receipts.length,1);
  }finally{await contract.app.close();}
});

test('HTTP the first signed-out SSO history call opens one host login control and resumes the same intended lookup',async()=>{
  const f=await fixture();try{const user=await f.newConversation();ensureCrm(f.app.store.get(user.id)).incidents=[{pyID:'INC-34-03-000281',pzInsKey:'MOMRA-OPS-CS-WORK INC-34-03-000281',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Open',Description:'Streetlight outside Pine Clinic',history:[]},{pyID:'INC-34-03-000906',pzInsKey:'MOMRA-OPS-CS-WORK INC-34-03-000906',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Resolved',Description:'Waste beside Pine Clinic',history:[]}];let state=await user.chat('Please check what happened to the waste I reported beside Pine Clinic.',[plan([step('history','crm_get_incidents'),step('detail','crm_fetch_incident',['history'])]),call('crm_get_incidents',{step_id:'history'})]);
    assert.equal(state.status,'input');assert.equal(state.pendingInput.kind,'login');assert.equal(state.pendingInput.operation,'crm_get_incidents');assert.equal(state.plans.length,1,'An authentication prerequisite must not make the model republish the business plan');assert.equal(apiCalls(state).length,0);assert.equal(state.receipts.length,0);const originalPlan=state.activePlanId,input=state.pendingInput.id;assert.equal(state.plans[0].steps.filter(x=>x.capability==='input').length,1);
    await user.login('demo');f.turns.push([call('crm_get_incidents',{step_id:'history'}),context=>{const target=observations(context).find(x=>x.receipt?.operation==='crm_get_incidents').receipt.result.data.result.IncidentRequestList.find(x=>x.Description==='Waste beside Pine Clinic');assert.ok(target);return call('crm_fetch_incident',{step_id:'detail',pzInsKey:target.pzInsKey});},finish()]);assert.equal((await user.post('/api/input',{input_id:input,value:{}})).status,202);state=await user.settled();assert.equal(state.status,'completed');assert.equal(state.activePlanId,originalPlan);assert.equal(state.plans.length,1);assert.deepEqual(apiCalls(state).map(x=>x.operation),['crm_get_incidents','crm_fetch_incident']);assert.equal(state.receipts.at(-1).parameters.pzInsKey,'MOMRA-OPS-CS-WORK INC-34-03-000906');assert.ok(state.messages.at(-1).text.includes('INC-34-03-000906'));
  }finally{await f.app.close();}
});

test('HTTP a host login prerequisite preserves the exact signed-out fetch target and executes it only after sign-in',async()=>{
  const f=await fixture();try{const user=await f.newConversation(),key='MOMRA-OPS-CS-WORK INC-34-03-000714';ensureCrm(f.app.store.get(user.id)).incidents=[{pyID:'INC-34-03-000714',pzInsKey:key,owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'InProgress',Description:'Town hall light',history:[]}];let state=await user.chat('Please check report INC-34-03-000714.',[plan([step('detail','crm_fetch_incident')]),call('crm_fetch_incident',{step_id:'detail',pzInsKey:key})]);assert.equal(state.status,'input');assert.equal(state.pendingInput.kind,'login');assert.equal(state.pendingInput.operation,'crm_fetch_incident');assert.equal(state.plans.length,1);assert.equal(apiCalls(state).length,0);const originalPlan=state.activePlanId,input=state.pendingInput.id;assert.equal(state.plans[0].steps.find(x=>x.id==='detail').parameters.pzInsKey,key,'The host must retain the exact requested target while authentication is pending');
    await user.login('demo');f.turns.push([call('crm_fetch_incident',{step_id:'detail',pzInsKey:key}),finish()]);assert.equal((await user.post('/api/input',{input_id:input,value:{}})).status,202);state=await user.settled();assert.equal(state.status,'completed');assert.equal(state.activePlanId,originalPlan);assert.equal(apiCalls(state).length,1);assert.equal(state.receipts.length,1);assert.equal(state.receipts[0].parameters.pzInsKey,key);assert.ok(state.messages.at(-1).text.includes('INC-34-03-000714'));
  }finally{await f.app.close();}
});

test('HTTP a respond-only replan within the same request still renders its actual cited case facts',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');f.app.store.get(user.id).crm.incidents=[{pyID:'INC-35-04-000681',pzInsKey:'MOMRA-OPS-CS-WORK INC-35-04-000681',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Open',Description:'Waste outside the sports centre',hasAttachments:true,history:[]}];const state=await user.chat('Check my report and explain what information is available.',[plan([step('history','crm_get_incidents')]),call('crm_get_incidents',{step_id:'history'}),call('propose_plan',{goal:'Explain the information available',summary:'The available records have been checked.',steps:[step('reply','respond')]}),finish('You uploaded three JPEG photos and the department assigned a crew.')]);const answer=state.messages.at(-1),receipt=state.receipts[0],oldPlan=state.plans.find(x=>x.id===receipt.plan_id),active=state.plans.find(x=>x.id===state.activePlanId);assert.equal(oldPlan.origin_message_id,active.origin_message_id);assert.ok(active.steps.every(x=>x.capability==='respond'));assert.equal(answer.presentation_source,'host_case');assert.ok(answer.text.includes('INC-35-04-000681'));assert.ok(!answer.text.includes('three JPEG'));assert.ok(!answer.text.includes('assigned a crew'));assert.equal(apiCalls(state).length,1);
  }finally{await f.app.close();}
});

test('HTTP a blocked partial request keeps successful read facts and clearly leaves the failed target unfinished',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');f.app.store.get(user.id).crm.incidents=[{pyID:'INC-35-04-000258',pzInsKey:'MOMRA-OPS-CS-WORK INC-35-04-000258',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Resolved',Description:'Neighbourhood bin',history:[]}];const state=await user.chat('Show what I can access and check the other reference INC-35-04-999999.',[plan([step('history','crm_get_incidents'),step('detail','crm_fetch_incident',['history'])]),call('crm_get_incidents',{step_id:'history'}),call('crm_fetch_incident',{step_id:'detail',pzInsKey:'MOMRA-OPS-CS-WORK INC-35-04-999999'}),context=>{const receipts=[...(promptState(context).receipts??[]),...observations(context).map(x=>x.receipt).filter(Boolean)];return call('finish',{state:'blocked',message:'Everything completed and your photo was downloaded.',receipt_ids:[...new Set(receipts.map(x=>x.id))],case_guidance:['access_limited']});}]);const answer=state.messages.at(-1);assert.equal(state.status,'blocked');assert.equal(answer.presentation_source,'host_case');assert.ok(answer.text.includes('INC-35-04-000258'));assert.match(answer.text,/partial|not complete(?:d)?|could not complete|incomplete|not finished|unfinished/iu);assert.ok(!answer.text.includes('Everything completed'));assert.ok(!answer.text.includes('photo was downloaded'));assert.equal(state.receipts.length,1);assert.equal(state.receipts[0].operation,'crm_get_incidents');assert.equal(apiCalls(state).length,2);
  }finally{await f.app.close();}
});

test('HTTP a prior question write receipt cannot turn a new respond-only answer into a new host submission',async()=>{
  const f=await fixture();try{const user=await f.newConversation();let state=await user.chat(complaintMessage,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',body:complaint()})]);f.turns.push([call('execute_confirmed_submission',{step_id:'write'}),finish()]);await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id});state=await user.settled();const oldReceipt=state.receipts[0],oldOrigin=state.plans.find(x=>x.id===oldReceipt.plan_id).origin_message_id;const response='No additional request has been submitted.';state=await user.chat('I only wanted to say thanks. Do not send anything else.',[call('propose_plan',{goal:'Acknowledge the citizen without a new submission',summary:'No further action is needed.',steps:[step('reply','respond')]}),call('finish',{state:'answered',message:response,receipt_ids:[oldReceipt.id]})]);const active=state.plans.find(x=>x.id===state.activePlanId),answer=state.messages.at(-1);assert.notEqual(active.origin_message_id,oldOrigin);assert.equal(answer.presentation_source,'verified_model');assert.equal(answer.text,response);assert.equal(state.receipts.length,1);assert.equal(apiCalls(state).filter(x=>x.operation==='crm_create_form_request').length,1);assert.ok(!answer.text.includes('PUB-DEMO'));
  }finally{await f.app.close();}
});

test('HTTP a follow-up can cite an actual earlier case read without a new query or ungrounded free-form facts',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');const key='MOMRA-OPS-CS-WORK INC-36-05-000864';f.app.store.get(user.id).crm.incidents=[{pyID:'INC-36-05-000864',pzInsKey:key,owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Resolved',Description:'Waste at Juniper Gate',CreatedAt:'2036-05-11',hasAttachments:true,history:[]}];let state=await user.chat('Check my waste report.',[plan([step('detail','crm_fetch_incident')]),call('crm_fetch_incident',{step_id:'detail',pzInsKey:key}),finish()]);const receipt=state.receipts[0],oldOrigin=state.plans.find(x=>x.id===receipt.plan_id).origin_message_id;
    state=await user.chat('Why was it resolved, and can you reopen that report?',[
      call('propose_plan',{goal:'Explain the known case status and connected action limit',summary:'I will use the actual record already retrieved.',steps:[step('reply','respond')]}),
      call('finish',{state:'answered',message:'Your two JPEG photographs were accepted and a crew repaired it.',receipt_ids:[receipt.id],case_guidance:['reason_not_returned','action_unavailable']}),
    ]);const answer=state.messages.at(-1),active=state.plans.find(x=>x.id===state.activePlanId);assert.notEqual(active.origin_message_id,oldOrigin);assert.equal(answer.presentation_source,'host_case');assert.ok(answer.text.includes('INC-36-05-000864'));assert.ok(answer.text.includes('Waste at Juniper Gate'));assert.ok(answer.text.includes('2036-05-11'));assert.match(answer.text,/reason/iu);assert.match(answer.text,/cannot|unavailable|not available/iu);assert.ok(!answer.text.includes('two JPEG'));assert.ok(!/this turn.*retrieved|this query returned/iu.test(answer.text),'Citing prior evidence must not claim a fresh query');assert.equal(apiCalls(state).length,1);assert.equal(state.receipts.length,1);
  }finally{await f.app.close();}
});

test('HTTP receipt-free typed capability guidance cannot promise external handling or create an unchosen complaint',async()=>{
  for(const message of ['Please refund the fee that was charged twice.','Can you send a priority escalation for the park issue?']){const f=await fixture();try{const user=await f.newConversation();const state=await user.chat(message,[call('propose_plan',{goal:'Explain the connected capability limit and optional local alternative',summary:'I will explain the available choices.',steps:[step('reply','respond')]}),call('finish',{state:'answered',message:'Your local complaint will be sent to the department and they will investigate it.',receipt_ids:[],case_guidance:['action_unavailable','offer_separate_complaint']})]);const answer=state.messages.at(-1);assert.equal(answer.presentation_source,'host_guidance');assert.deepEqual(answer.presentation_parts,['host_guidance']);assert.deepEqual(answer.case_guidance,['action_unavailable','offer_separate_complaint']);assert.ok(!answer.text.includes('will be sent to the department'));assert.ok(!answer.text.includes('they will investigate'));assert.match(answer.text,/local|simulat/iu);assert.match(answer.text,/(?:not|never|no).*(?:external|department|government)/isu);assert.equal(state.receipts.length,0);assert.equal(apiCalls(state).length,0);assert.equal(state.pendingOperation,null);
    }finally{await f.app.close();}}
});

test('HTTP typed case-choice or not-found claims require an actual query before any candidate facts can be shown',async()=>{
  const f=await fixture();try{const user=await f.newConversation();await user.login('demo');f.app.store.get(user.id).crm.incidents=[{pyID:'INC-37-06-000142',pzInsKey:'MOMRA-OPS-CS-WORK INC-37-06-000142',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Open',Description:'Market gate light',history:[]},{pyID:'INC-37-06-000875',pzInsKey:'MOMRA-OPS-CS-WORK INC-37-06-000875',owner_user_id:'demo-demo',caseType:'incident',pyStatusWork:'Resolved',Description:'School gate waste',history:[]}];const state=await user.chat('Help me identify my existing report.',[
    call('propose_plan',{goal:'Help identify the citizen report',summary:'I will check which records are available.',steps:[step('reply','respond')]}),
    call('finish',{state:'answered',message:'I found CASE-MADE-UP-41 and CASE-MADE-UP-52. Which do you mean?',receipt_ids:[],case_guidance:['needs_choice','not_found']}),
    context=>{assert.ok(observations(context).at(-1).error,'A fact-bearing guidance tag cannot bypass its query prerequisite');return plan([step('history','crm_get_incidents')]);},
    call('crm_get_incidents',{step_id:'history'}),finish('The first report must be the one you wanted.',{case_guidance:['needs_choice']}),
  ]);const answer=state.messages.at(-1);assert.equal(answer.presentation_source,'host_case');assert.ok(answer.text.includes('INC-37-06-000142'));assert.ok(answer.text.includes('INC-37-06-000875'));assert.ok(!answer.text.includes('CASE-MADE-UP'));assert.equal(state.receipts.length,1);assert.equal(apiCalls(state).length,1);assert.ok(!state.messages.some(x=>x.role==='assistant'&&x.text.includes('CASE-MADE-UP')));
  }finally{await f.app.close();}
});

test('HTTP a confirmed local form write and an unavailable extra action both appear without inventing a refund or external handling',async()=>{
  for(const {subject,description,extraGoal}of [{subject:'Duplicate fee charge',description:'The same fee was charged twice.',extraGoal:'I also want the duplicate fee refunded.'},{subject:'Park issue handling',description:'The park gate has remained broken.',extraGoal:'I also want a priority escalation.'}]){const f=await fixture();try{const user=await f.newConversation(),body={...complaint(),subject,Description:description};let state=await user.chat('Please record a complaint: '+description+' Use title “'+subject+'”. My name is Lina Citizen, my email is lina@example.test, my phone is 0501234567, and I have no attachments. '+extraGoal,[plan([step('write','crm_create_form_request')]),call('crm_create_form_request',{step_id:'write',body})]);assert.equal(state.status,'confirmation');assert.equal(apiCalls(state).length,0);const proposal=state.pendingOperation.id;f.turns.push([call('execute_confirmed_submission',{step_id:'write'}),finish('The refund or escalation was completed and the department will investigate your local complaint.',{case_guidance:['action_unavailable']})]);assert.equal((await user.post('/api/approve-operation',{proposal_id:proposal})).status,202);state=await user.settled();const answer=state.messages.at(-1),receipt=state.receipts[0],number=receipt.result.data.result.id;assert.equal(answer.presentation_source,'host_submission');assert.deepEqual(answer.presentation_parts,['host_submission','host_guidance']);assert.ok(answer.text.includes(number));assert.ok(answer.text.includes(subject));assert.match(answer.text,/not connected|not available|unavailable|not performed|cannot/iu);assert.ok(!answer.text.includes('department will investigate'));assert.ok(!answer.text.includes('refund or escalation was completed'));assert.ok(!/nothing (?:was |has been )?submitted|no (?:write|submission) (?:was|has)/iu.test(answer.text),'A missing extra capability must not deny the write that actually succeeded');assert.equal(state.receipts.length,1);assert.deepEqual(apiCalls(state).map(x=>x.operation),['crm_create_form_request']);assert.deepEqual(receipt.parameters.body,body);assert.equal(state.events.filter(x=>x.type==='confirmation_required').length,1);assert.equal(state.pendingOperation,null);
    }finally{await f.app.close();}}
});

test('HTTP a blocked request with one successful form reports that exact receipt and the unfinished remainder',async()=>{
  const f=await fixture();try{const user=await f.newConversation();ensureCrm(f.app.store.get(user.id)).faults={crm_get_assets:{code:'SERVICE_UNAVAILABLE',status:503}};let state=await user.chat(complaintMessage+' After recording the complaint, show the municipal asset categories.',[plan([step('write','crm_create_form_request'),step('assets','crm_get_assets',['write'])]),call('crm_create_form_request',{step_id:'write',body:complaint()})]);assert.equal(state.status,'confirmation');f.turns.push([call('execute_confirmed_submission',{step_id:'write'}),call('crm_get_assets',{step_id:'assets'}),context=>{const receipts=[...(promptState(context).receipts??[]),...observations(context).map(x=>x.receipt).filter(Boolean)];return call('finish',{state:'blocked',message:'Everything succeeded and no further action is needed.',receipt_ids:[...new Set(receipts.map(x=>x.id))]});}]);await user.post('/api/approve-operation',{proposal_id:state.pendingOperation.id});state=await user.settled();const answer=state.messages.at(-1),number=state.receipts[0].result.data.result.id;assert.equal(state.status,'blocked');assert.equal(answer.presentation_source,'host_submission');assert.ok(answer.text.includes(number));assert.match(answer.text,/partial|not complete(?:d)?|could not complete|incomplete|not finished|unfinished/iu);assert.ok(!answer.text.includes('Everything succeeded'));assert.equal(state.receipts.length,1);assert.deepEqual(apiCalls(state).map(x=>x.operation),['crm_create_form_request','crm_get_assets']);assert.equal(state.events.filter(x=>x.type==='confirmation_required').length,1);
  }finally{await f.app.close();}
});
