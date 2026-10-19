import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {controlledSession} from '../src/road/runtime.mjs';
import {RoadStore} from '../src/road/store.mjs';
import {CrmAgent,CRM_SYSTEM} from '../src/crm/agent.mjs';
import {CrmSimulation,ensureCrm,INCIDENT,KEY} from '../src/crm/simulation.mjs';
import {scoreCrm,summarizeCrm} from '../src/crm/metrics.mjs';
const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
const step=(id,capability,depends_on=[])=>({id,title:capability,capability,depends_on});
const plan=steps=>call('propose_plan',{goal:'Requested CRM task',summary:'Perform the requested actions.',steps:[...steps,step('reply','respond',steps.map(x=>x.id))]});
async function fixture(){const store=new RoadStore(),session=store.create(),client=new CrmSimulation(store),queue=[],toolsets=[];ensureCrm(session);const agent=new CrmAgent({store,client,api:(...args)=>client.call(...args),knowledge:{document:{name:'test'},answer:async()=>null},runtimeFactory:options=>{toolsets.push(options.tools.map(x=>x.name));assert.ok(queue.length,'Scripted model turn missing');return controlledSession({...options,fauxResponses:queue.shift()});}});return {store,session,client,queue,toolsets,agent};}
const finish=session=>()=>call('finish',{state:'completed',message:'Operation complete.',receipt_ids:session.receipts.map(x=>x.id)});
test('active identity is BALADY and tools contain all CRM operations, no old business APIs or credentials',async()=>{
  const f=await fixture();f.queue.push([call('finish',{state:'answered',message:'I am the BALADY Assistant.',receipt_ids:[]})]);await f.agent.chat(f.session,'Introduce yourself',{skipRouting:true});
  assert.match(CRM_SYSTEM,/BALADY Assistant/);assert.equal(f.toolsets[0].filter(x=>x.startsWith('crm_')).length,35);assert.ok(!f.toolsets[0].includes('query_tickets'));assert.ok(!f.toolsets[0].includes('create_ticket'));assert.ok(!f.toolsets[0].includes('handoff_to_human'));assert.ok(!f.toolsets[0].includes('crm_authenticate'));
});
test('exact write authorization precedes API dispatch; stale confirmations cannot replay',async()=>{
  const f=await fixture(),args={step_id:'write',body:{IncidentID:INCIDENT,Status:1}};
  f.queue.push([plan([step('write','crm_update_vehicle_status')]),call('crm_update_vehicle_status',args)]);await f.agent.chat(f.session,'Record vehicle withdrawn',{skipRouting:true});
  assert.equal(f.session.status,'confirmation');assert.equal(f.session.crm.calls.length,0);const proposal=f.session.pendingOperation.id;
  f.queue.push([call('crm_update_vehicle_status',args),finish(f.session)]);await f.agent.approveOperation(f.session,proposal);assert.equal(f.session.status,'completed');assert.equal(f.session.crm.calls.length,1);assert.equal(f.session.crm.incidents[0].vehicleStatus,1);
  await assert.rejects(f.agent.approveOperation(f.session,proposal),{code:'STALE_CONFIRMATION'});assert.equal(f.session.crm.calls.length,1);
  assert.ok(f.session.events.find(x=>x.type==='operation_approved').seq<f.session.events.find(x=>x.type==='api_start').seq);
});
test('normal reads run without confirmation and plans use concrete returned identifiers',async()=>{
  const f=await fixture();await f.agent.login(f.session,{username:'demo',password:'demo'});
  f.queue.push([plan([step('history','crm_get_incidents'),step('detail','crm_fetch_incident',['history'])]),call('crm_get_incidents',{step_id:'history'}),call('crm_fetch_incident',{step_id:'detail',pzInsKey:KEY}),finish(f.session)]);
  await f.agent.chat(f.session,'History then details',{skipRouting:true});assert.equal(f.session.status,'completed');assert.equal(f.session.receipts.length,2);assert.equal(f.session.pendingOperation,null);assert.equal(f.session.events.filter(x=>x.type==='confirmation_required').length,0);
});
test('dependency guard blocks an early API and finish rejects incomplete plans',async()=>{
  const f=await fixture();f.queue.push([plan([step('assets','crm_get_assets'),step('detail','crm_get_asset_details',['assets']),step('input','input')]),call('crm_get_asset_details',{step_id:'detail',id:'MA-DEMO-1'}),call('finish',{state:'completed',message:'Done',receipt_ids:[]}),call('request_input',{step_id:'input',kind:'text',operation:'crm_get_asset_details',fields:['id'],question:'Which asset do you want?'})]);
  await f.agent.chat(f.session,'Assets then detail',{skipRouting:true});assert.equal(f.session.status,'input');assert.equal(f.session.crm.calls.length,0);assert.ok(f.session.events.some(x=>x.result?.error==='DEPENDENCY_PENDING'));assert.ok(f.session.events.some(x=>x.result?.error==='UNFINISHED_PLAN'));
});
test('new goal revokes old authorization and never runs the old pending write',async()=>{
  const f=await fixture();f.queue.push([plan([step('write','crm_update_vehicle_status')]),call('crm_update_vehicle_status',{step_id:'write',body:{IncidentID:INCIDENT,Status:1}})]);await f.agent.chat(f.session,'Record withdrawal',{skipRouting:true});const proposal=f.session.pendingOperation.id;
  f.queue.push([plan([step('assets','crm_get_assets')]),call('crm_get_assets',{step_id:'assets'}),finish(f.session)]);await f.agent.chat(f.session,'Instead list assets',{skipRouting:true});assert.equal(f.session.status,'completed');assert.equal(f.session.pendingOperation,null);await assert.rejects(f.agent.approveOperation(f.session,proposal),{code:'STALE_CONFIRMATION'});assert.deepEqual(f.session.crm.calls.map(x=>x.operation),['crm_get_assets']);
});
test('edited CRM payload requires a fresh exact confirmation',async()=>{
  const f=await fixture();f.queue.push([plan([step('write','crm_update_vehicle_status')]),call('crm_update_vehicle_status',{step_id:'write',body:{IncidentID:INCIDENT,Status:1}})]);await f.agent.chat(f.session,'Record outcome',{skipRouting:true});const old=f.session.pendingOperation.id;
  await f.agent.editOperation(f.session,old,{text:JSON.stringify({body:{IncidentID:INCIDENT,Status:2}})});assert.notEqual(f.session.pendingOperation.id,old);assert.equal(f.session.crm.calls.length,0);await assert.rejects(f.agent.approveOperation(f.session,old),{code:'STALE_CONFIRMATION'});
  f.queue.push([call('crm_update_vehicle_status',{step_id:'write',body:{IncidentID:INCIDENT,Status:2}}),finish(f.session)]);await f.agent.approveOperation(f.session,f.session.pendingOperation.id);assert.equal(f.session.crm.incidents[0].vehicleStatus,2);
});
test('API simulation persists idempotent results and rejects key/payload conflicts',async()=>{
  const f=await fixture(),params={body:{IncidentID:INCIDENT,Status:1}},context={idempotency_key:'same',epoch:0};const first=await f.client.execute(f.session,'crm_update_vehicle_status',params,context);assert.equal(first.ok,true);
  const second=await f.client.execute(f.session,'crm_update_vehicle_status',params,context);assert.equal(second.replayed,true);assert.equal(f.session.crm.calls.length,1);
  assert.equal((await f.client.execute(f.session,'crm_update_vehicle_status',{body:{IncidentID:INCIDENT,Status:2}},context)).error.code,'IDEMPOTENCY_CONFLICT');
});
test('Madinati closure cannot bypass a matching lookup or attachment condition',async()=>{
  const f=await fixture(),body={MomraIncidentNo:INCIDENT,IncidentStatusName:'Resolved',ActionDate:'20/10/2026',ClosureReasonName:'Processed in simulation',EmployeeName:'Operator',IsProcessed:true};
  assert.equal((await f.client.execute(f.session,'crm_resolve_madinati_incident',{body},{idempotency_key:'a'})).error.code,'CLOSURE_LOOKUP_REQUIRED');
  const p={MomraIncidentNo:INCIDENT,IsProcessed:true},lookup=await f.client.execute(f.session,'crm_get_closure_reasons',p);f.session.receipts.push({id:'lookup',operation:'crm_get_closure_reasons',parameters:p,result:lookup.response});f.session.crm.incidents[0].hasAttachments=true;
  assert.equal((await f.client.execute(f.session,'crm_resolve_madinati_incident',{body},{idempotency_key:'b'})).error.code,'CONDITIONAL_PARAMETER_MISSING');
  body.IncidentPhotosAfterFixing=[{AttachmentName:'after.jpg',AttachmentType:'jpeg',AttachmentURL:'DMS-DEMO',FileKey:'DMS-DEMO'}];assert.equal((await f.client.execute(f.session,'crm_resolve_madinati_incident',{body},{idempotency_key:'c'})).ok,true);
});
test('scoring penalizes wrong tools, duplicate execution, missing dependencies and absent parameters',()=>{
  const s={status:'completed',receipts:[{operation:'crm_get_assets',parameters:{}},{operation:'crm_get_assets',parameters:{}}],events:[{type:'model_result',tool_calls:[{name:'crm_get_assets',arguments:{step_id:'x'}},{name:'crm_get_incidents',arguments:{step_id:'y'}}]}],plans:[{id:'p',steps:[step('x','crm_get_assets'),step('y','crm_get_asset_details')]}],activePlanId:'p'};
  const result=scoreCrm({expected:{operations:['crm_get_assets','crm_get_asset_details'],status:'completed',dependencies:[['crm_get_assets','crm_get_asset_details']],parameters:{crm_get_asset_details:{id:'MA-DEMO-1'}}}},s);assert.equal(result.pass,false);assert.equal(result.selection.fp,1);assert.equal(result.selection.fn,1);assert.equal(result.execution.fp,1);assert.equal(result.execution.fn,1);assert.equal(result.plan_exact,false);assert.equal(summarizeCrm([{score:result}]).case_pass_rate,0);
});
test('CRM feedback evidence keeps original business question across FAQ and exact confirmation',async()=>{
  const f=await fixture(),args={step_id:'write',body:{IncidentID:INCIDENT,Status:1}};
  f.agent.knowledge.answer=async message=>message==='FAQ question'?{answer:'Verified FAQ answer',entry:{id:'FAQ-2',question:'FAQ question'}}:null;
  f.queue.push([plan([step('write','crm_update_vehicle_status')]),call('crm_update_vehicle_status',args)]);await f.agent.chat(f.session,'Original CRM request',{skipRouting:true});const questionId=f.session.messages.findLast(x=>x.role==='user').id,proposal=f.session.pendingOperation.id;
  await f.agent.chat(f.session,'FAQ question');assert.equal(f.session.pendingOperation.id,proposal);assert.equal(f.session.answerSnapshots[f.session.messages.at(-1).id].question,'FAQ question');
  f.queue.push([call('crm_update_vehicle_status',args),finish(f.session)]);await f.agent.approveOperation(f.session,proposal);
  const answer=f.session.messages.at(-1),snapshot=f.session.answerSnapshots[answer.id];assert.equal(snapshot.question_message_id,questionId);assert.equal(snapshot.question,'Original CRM request');assert.equal(snapshot.tool_results[0].operation,'crm_update_vehicle_status');assert.equal(snapshot.tool_calls[0].name,'crm_update_vehicle_status');assert.ok(f.store.view(f.session).messages.find(x=>x.id===answer.id).rateable);
});
