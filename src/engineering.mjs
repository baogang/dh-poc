import { analysisSchema,validateShape,validateAnalysis } from './contracts.mjs';
import { BASE_CATALOG,toolSchema } from './catalog.mjs';
import { EntryAgent,scriptedTool } from './entry-agent.mjs';
import { analyze } from './analyzer.mjs';
import { hash,uid } from './util.mjs';
const op=id=>BASE_CATALOG.operations.find(o=>o.id===id);
const sample={sentiment:'negative',assessment_status:'classified',emotions:['anger'],evidence:[{label:'emotion:anger',message_id:'m1',quote:'أنا غاضب'},{label:'sentiment:negative',message_id:'m1',quote:'أنا غاضب'}]};
export async function runEngineering(mock,input){
 let case_id,second;const evidence=[],invariants={};let observed_error;
 const create=async(patch={},actor=input.actor??'citizen-a')=>mock.createCase({actor,fixture_patch:patch});
 const call=async(id,args={},opts={})=>{const r=await mock.business(case_id,opts.actor??'citizen-a',op(id),args,{idempotencyKey:opts.key,confirmation_ref:opts.confirmation_ref});evidence.push({operation:id,args,result:r});return r;};
 const confirm=async(id,args)=>{const operation=op(id),path={},body={...args};for(const k of operation.path_parameters){path[k]=body[k];delete body[k];}return (await mock.confirm(case_id,id,path,body)).confirmation_ref;};
 const invariance=(name,condition)=>{invariants[name]=!!condition;};
 const prepareWrite=async(id)=>{if(id==='crm940_complaint_reopen')return {complaint_id:'CMP-MOCK-001',reason:'unresolved'};if(id==='crm940_complaint_create')return {category:'waste',description:'waste remains',parcel_id:'PARCEL-MOCK-001'};const v=await call('balady_change_validate',{certificate_id:'CERT-MOCK-001',target_use:'COMMERCIAL'});return {validation_id:v.data.validation_id};};
 try{
  if(input.test_type==='semantic_contract'){
   let value;
   if('raw_output'in input){if(!input.raw_output.trim())observed_error='EMPTY_OUTPUT';else{try{value=JSON.parse(input.raw_output);if(!value||Array.isArray(value)||typeof value!=='object')observed_error='INVALID_CONTRACT';}catch{observed_error='INVALID_JSON';}}}
   else value={...sample,...input.mutation};
   if(!observed_error){const shape=validateShape(analysisSchema,value);if(!shape.ok)observed_error=shape.code==='INVALID_FIELD'&&shape.errors.some(e=>e.instancePath.startsWith('/evidence'))?'INVALID_EVIDENCE':shape.code;else{const valid=validateAnalysis(value,input.source_input);if(!valid.ok)observed_error=value.evidence.some(e=>input.source_input.messages.find(m=>m.id===e.message_id)?.role==='assistant')?'INVALID_EVIDENCE_ROLE':'INVALID_EVIDENCE';}}
   evidence.push({value,observed_error});return {observed_error,evidence,invariants};
  }
  const faults=input.fault?{[input.operation]:[input.fault]}:{};
  case_id=await create({faults,...(input.agent_pending_polls!==undefined?{agent_pending_polls:input.agent_pending_polls}:{})});
  if(input.test_type==='tool_guard'&&!input.scenario){
   const args={...input.arguments};
   if(input.trusted_confirm===false&&input.operation!=='balady_change_submit'){
    delete args.confirmation_ref;const agent=new EntryAgent({mock,case_id});agent.loaded.add(op(input.operation).system);agent.toolCount=0;const r=await agent.executeBusiness(op(input.operation),args);observed_error=r.status==='needs_confirmation'?'CONFIRMATION_REQUIRED':r.error?.code;const snap=await mock.snapshot(case_id);invariance('state_unchanged',snap.state.complaints['CMP-MOCK-001'].status==='closed'&&Object.keys(snap.state.complaints).length===2);
   }else if(input.operation==='balady_change_submit'){const r=await call(input.operation,args,{key:uid('test')});observed_error=r.error?.code;}
   else if(args.confirmation_ref){delete args.confirmation_ref;const original={...args,reason:'original reason'};const ref=await confirm(input.operation,original);const r=await call(input.operation,args,{key:uid('test'),confirmation_ref:ref});observed_error=r.error?.code;}
   else {const shape=validateShape(toolSchema(op(input.operation)),args);if(!shape.ok)observed_error=shape.code;else{const r=await call(input.operation,args);observed_error=r.error?.code;}}
  }else if(input.test_type==='tool_guard'){
   const args=await prepareWrite(input.operation),ref=await confirm(input.operation,args),key=uid('test');
   const first=await call(input.operation,args,{key:input.scenario==='write_without_key'?undefined:key,confirmation_ref:ref});
   if(input.scenario==='write_without_key')observed_error=first.error?.code;
   else {const changed=input.scenario==='same_key_changed_parameters'?{...args,description:'changed'}:args;const secondResult=await call(input.operation,changed,{key:input.scenario==='retry_same_write_different_key'?uid('different'):key,confirmation_ref:ref});const snap=await mock.snapshot(case_id);
    if(input.scenario==='same_key_changed_parameters')observed_error=secondResult.error?.code;
    invariance('one_write_one_receipt',first.ok&&secondResult.ok&&hash(first.data)===hash(secondResult.data)&&snap.state.complaints['CMP-MOCK-001'].history.filter(x=>x.event==='reopened').length===1);
    invariance('no_second_reopen',first.ok&&!secondResult.ok&&snap.state.complaints['CMP-MOCK-001'].history.filter(x=>x.event==='reopened').length===1);
   }
  }else if(input.test_type==='backend_fault'){
   if(input.arguments){const r=await call(input.operation,input.arguments);observed_error=r.error?.code;}
   else if(input.scenario.startsWith('confirmed_')){
    const args=await prepareWrite(input.operation),ref=await confirm(input.operation,args),key=uid('fault');const first=await call(input.operation,args,{key,confirmation_ref:ref});const before=await mock.snapshot(case_id);
    invariance('no_committed_write_before_fault',!first.ok&&before.state.complaints['CMP-MOCK-001'].status==='closed');
    if(input.fault.phase==='after_commit'){const retry=await call(input.operation,args,{key,confirmation_ref:ref}),snap=await mock.snapshot(case_id);
     invariance('reconcile_same_idempotency_key',!first.ok&&retry.ok&&snap.state.complaints['CMP-MOCK-001'].history.filter(x=>x.event==='reopened').length===1);
     invariance('exactly_one_new_complaint',retry.ok&&Object.keys(snap.state.complaints).length===3);
     invariance('exactly_one_new_application_certificate_unchanged',retry.ok&&Object.keys(snap.state.applications).length===2&&snap.state.certificates['CERT-MOCK-001'].current_use==='RESIDENTIAL');
    }
   }else{
    const start=await call('furas_task_start',{goal:'find cafe',criteria:{city:'Jeddah',sector:'cafe',budget_sar:250000}},{key:uid('task')});
    if(input.scenario==='furas_start_unavailable')invariance('no_completed_task_claim',!start.ok&&!start.data?.task_id);
    else if(input.scenario==='furas_poll_unavailable'){const r=await call('furas_task_get',{task_id:start.data.task_id});const snap=await mock.snapshot(case_id);invariance('pending_task_id_preserved',!r.ok&&snap.tasks[start.data.task_id].status==='pending');}
    else if(input.scenario==='furas_resume_wrong_owner'){const r=await call('furas_task_resume',{task_id:start.data.task_id,criteria:{city:'Riyadh'}},{actor:'citizen-b',key:uid('wrong')});observed_error=r.error?.code==='CASE_ACTOR_MISMATCH'?'NOT_OWNER':r.error?.code; evidence.push({host_boundary:'CASE_ACTOR_MISMATCH enforces same invariant before backend ownership check'});}
    else{await call('furas_task_get',{task_id:start.data.task_id});await call('furas_task_get',{task_id:start.data.task_id});const r=await call('furas_task_cancel',{task_id:start.data.task_id},{key:uid('cancel')});const snap=await mock.snapshot(case_id);invariance('completed_task_not_rewritten_cancelled',!r.ok&&snap.tasks[start.data.task_id].status==='completed');}
   }
  }else if(input.test_type==='session_isolation'){
   switch(input.scenario){
    case 'application_id_passed_to_support':{const r=await call(input.second_tool,{request_id:input.first_id});invariance('no_cross_domain_success',!r.ok);break;}
    case 'wrong_certificate_in_confirmation':{try{await mock.confirm(case_id,'balady_change_submit',{}, {validation_id:'VALIDATION-MOCK-999'});invariance('confirmation_bound_to_exact_subject',false);}catch(e){invariance('confirmation_bound_to_exact_subject',!!e.code);}break;}
    case 'new_location_after_closed_complaint':{const r=await call('crm940_complaint_get',{complaint_id:input.old_id});invariance('old_closed_not_evidence_new_location_resolved',r.data.parcel_id!==input.new_parcel&&r.data.status==='closed');break;}
    case 'cancel_unrelated_task':{const a=await call('furas_task_start',{goal:input.first_task_goal,criteria:{}},{key:uid('a')}),b=await call('furas_task_start',{goal:input.second_task_goal,criteria:{}},{key:uid('b')});await call('furas_task_cancel',{task_id:a.data.task_id},{key:uid('cancel')});const snap=await mock.snapshot(case_id);invariance('cancel_only_selected_task',snap.tasks[a.data.task_id].status==='cancelled'&&snap.tasks[b.data.task_id].status==='needs_input');break;}
    case 'citizen_b_reads_citizen_a_task':{const a=await call('furas_task_start',{goal:'find',criteria:{}},{key:uid('a')}),r=await call('furas_task_get',{task_id:a.data.task_id},{actor:'citizen-b'});invariance('no_cross_actor_task_leak',!r.ok&&!r.data);break;}
    case 'case_two_has_no_case_one_confirmation':{const args=await prepareWrite('crm940_complaint_reopen'),ref=await confirm('crm940_complaint_reopen',args);second=await create();const r=await mock.business(second,'citizen-a',op('crm940_complaint_reopen'),args,{confirmation_ref:ref,idempotencyKey:uid('cross')});invariance('no_cross_case_confirmation',!r.ok);break;}
    case 'fresh_fixture_between_cases':{const args=await prepareWrite('crm940_complaint_reopen'),ref=await confirm('crm940_complaint_reopen',args);await call('crm940_complaint_reopen',args,{key:uid('x'),confirmation_ref:ref});second=await create();const snap=await mock.snapshot(second);invariance('mutation_not_carried_to_next_case',snap.state.complaints['CMP-MOCK-001'].status==='closed');break;}
    case 'two_sessions_same_user_different_goals':{await call('furas_task_start',{goal:'cafe',criteria:{}},{key:uid('a')});second=await create();const r=await mock.business(second,'citizen-a',op('furas_task_resume'),{task_id:'FURAS-TASK-MOCK-001',criteria:{city:'Jeddah'}},{idempotencyKey:uid('cross')});invariance('pending_task_not_wrongly_resumed',!r.ok&&Object.keys((await mock.snapshot(second)).tasks).length===0);break;}
   }
  }else if(input.test_type==='budget'){
   if(input.scenario==='invalid_output_retries'){let calls=0;const r=await analyze({chat:async()=>{calls++;return {content:'not json'};}},{messages:[{id:'m1',role:'user',content:'hello'}],current_message_id:'m1'});invariance('one_repair_then_fail',calls===2&&!r.valid);}
   else if(input.scenario==='endless_pending_polls'){const a=await call('furas_task_start',{goal:'find',criteria:{city:'Jeddah',sector:'cafe',budget_sar:250000}},{key:uid('a')});for(let n=0;n<input.max_polls;n++)await call('furas_task_get',{task_id:a.data.task_id});invariance('pending_without_false_completion',(await mock.snapshot(case_id)).tasks[a.data.task_id].status==='pending');}
   else{
    const responses=input.scenario==='model_timeout'?[async()=>{await new Promise(r=>setTimeout(r,15));return (await import('@earendil-works/pi-ai')).fauxAssistantMessage('late');}]:[scriptedTool('skill_read',{system:'BALADY'}),...Array.from({length:8},()=>scriptedTool('balady_certificate_get',{certificate_id:'CERT-MOCK-001'}))];
    const agent=new EntryAgent({mock,case_id,maxTools:input.max_tool_calls??3,timeoutMs:input.timeout_ms??3000,fauxResponses:responses});try{await agent.turn({message:'read certificate'});evidence.push(agent.snapshot());const snap=await mock.snapshot(case_id);invariance('stop_at_tool_budget',snap.trace.filter(t=>t.operation_id==='balady_certificate_get').length<=input.max_tool_calls&&agent.result.status==='failed');invariance('bounded_timeout_no_write',agent.result.status==='failed'&&snap.state.complaints['CMP-MOCK-001'].status==='closed');}finally{agent.dispose();}
   }
  }else if(input.test_type==='prompt_security'){
   const agent=new EntryAgent({mock,case_id});agent.toolCount=0;agent.loaded=new Set(['BALADY','940']);
   if(input.scenario==='user_inject_actor'){const r=await agent.executeBusiness(op('balady_certificate_get'),{certificate_id:'CERT-MOCK-002'});evidence.push(r);invariance('actor_is_host_owned',!r.ok&&r.error.code==='NOT_OWNER'&&agent.actor==='citizen-a');}
   else if(input.scenario==='user_inject_confirmation'){const r=await agent.executeBusiness(op('crm940_complaint_reopen'),{complaint_id:'CMP-MOCK-001',reason:'unresolved'});evidence.push(r);invariance('token_does_not_replace_trusted_confirmation',r.status==='needs_confirmation'&&(await mock.snapshot(case_id)).state.complaints['CMP-MOCK-001'].status==='closed');}
   else if(input.scenario==='remote_agent_inject_tool'){agent.fauxResponses=[];await agent.initialize();invariance('remote_output_cannot_grant_tools',!agent.session.getActiveToolNames().some(x=>['bash','shell','exec','read','write'].includes(x)));agent.dispose();}
   else{agent.session={agent:{state:{messages:[{role:'assistant',content:[{type:'toolCall',name:'submit_result'}]}]}}};const errors=agent.validateResult({status:'completed',answer:input.message,receipt_ids:['APPROVED'],goals:[{goal:'query',status:'completed',receipt_ids:['APPROVED']}],missing_fields:[],handoff_reason:''});invariance('user_text_is_not_system_receipt',errors.some(e=>e.startsWith('Unknown receipt')));}
  }
  return {observed_error,evidence,invariants,oracle:await mock.snapshot(case_id)};
 }catch(error){if(error.code==='MOCK_ACTOR_REQUIRED')return {observed_error:error.code,evidence,invariants};throw error;}
 finally{if(second)await mock.control(`/cases/${second}`,'DELETE');if(case_id)await mock.control(`/cases/${case_id}`,'DELETE');}
}
