import {BY_ID} from '../../src/crm/contract.mjs';
import {digest} from '../../src/road/store.mjs';

export const JOURNEY_GRADER_VERSION=2;
const contains=(actual,expected)=>expected&&typeof expected==='object'
  ?actual&&typeof actual==='object'&&Object.entries(expected).every(([key,value])=>contains(actual[key],value))
  :Object.is(actual,expected);
const leaves=(value,path='',out=[])=>{
  if(value&&typeof value==='object')for(const [key,item]of Object.entries(value))leaves(item,path?path+'.'+key:key,out);
  else out.push({path,key:path.split('.').at(-1),value});
  return out;
};
const systemIds=new Set(['pzInsKey','caseId','FileKey','AttachmentID','MainClassificationID','SubClassificationID','SplClassificationID','mainClassificationID','subClassificationID','EECode','ClosureReasonName']);
const fetches=new Set(['crm_fetch_incident','crm_fetch_municipal_service','crm_fetch_inquiry']);
const normalizePath=value=>String(value).replace(/^\//,'').replaceAll('/','.').replace(/\[(\d+)\]/g,'.$1');
const canonicalInputPath=(operation,value)=>{
  const path=normalizePath(value),root=path.split('.')[0],schema=BY_ID.get(operation)?.input;
  // This is field-location notation, not permissive suffix or spelling matching.
  // A schema-known body root can be unambiguously placed under body.
  return root!=='body'&&!schema?.properties?.[root]&&schema?.properties?.body?.properties?.[root]?'body.'+path:path;
};
const matchesId=(key,id)=>key===id||typeof key==='string'&&key.endsWith(' '+id);
const actualUserText=(input,trace)=>[
  input.initial??input.message,
  ...(trace.requests??[]).flatMap(request=>request.path==='/api/chat'?[request.input?.message]:request.path==='/api/input'?[request.input?.value?.text]:[])
].filter(value=>typeof value==='string').join('\n');

export function gradeJourney(input,reference,state,trace={}, {fixtureRows=[]}={}){
  const expected=reference.expected??reference,checks=[],deferred=[];
  const check=(name,pass,details)=>checks.push({name,pass:!!pass,...(details!==undefined?{details}:{} )});
  const defer=(name,reason)=>deferred.push({name,reason});
  const receipts=state.receipts??[],events=state.events??[],calls=events.filter(x=>x.type==='api_start'&&x.call).map(x=>x.call);
  const operations=receipts.map(x=>x.operation),writes=calls.filter(x=>BY_ID.get(x.operation)?.effect==='write');
  const answers=(state.messages??[]).filter(x=>x.role==='assistant'&&['result','faq','error','input_request'].includes(x.kind));
  const answer=answers.map(x=>x.text).join('\n'),latestAnswer=answers.at(-1)?.text??'';
  const allowed=expected.allowed_statuses??({
    success:['completed','answered'],
    clarify:['input','clarification','answered','blocked','completed'],
    confirm:['confirmation'],
    refuse:['answered','blocked','input','clarification','completed'],
    unsupported:['answered','blocked','input','clarification','completed'],
    safe_clarification:['input','clarification','answered','blocked','completed']
  }[expected.oracle??expected.outcome]??['completed']);
  check('observable_outcome',allowed.includes(state.status),{expected:allowed,actual:state.status});
  check('no_runtime_failure',!['failed','interrupted'].includes(state.status)&&!trace.error);
  if(state.status==='clarification')check('actionable_service_clarification',!!state.pendingKnowledge?.id&&state.pendingKnowledge.candidate_scopes?.length>0);

  // A reference can describe a future answer which the model never received.
  // Such an answer is not current evidence and cannot determine a target now.
  const remaining=(input.dialogue??[]).slice(trace.dialogue_consumed??0);
  const unsentClarification=remaining.some(x=>typeof x==='string'||!x.when||x.when==='input');
  const targetIds=expected.selected_case_ids??[];
  const evidence=id=>{
    const direct=receipts.some(x=>fetches.has(x.operation)&&matchesId(x.parameters?.pzInsKey??x.parameters?.caseId,id)&&matchesId(x.result?.data?.result?.pyID??x.result?.data?.result?.pzInsKey,id));
    const history=receipts.some(x=>x.operation==='crm_get_incidents'&&(x.result?.data?.result?.IncidentRequestList??[]).some(row=>matchesId(row.pyID??row.pzInsKey,id)));
    return {direct,history,listed_and_reported:history&&latestAnswer.includes(id)};
  };
  for(const operation of expected.required_operations??[]){
    if(operations.includes(operation)){check('required_operation:'+operation,true);continue;}
    if(fetches.has(operation)&&unsentClarification){defer('required_operation:'+operation,'A future clarification was not delivered; the reference cannot require its downstream detail call yet.');continue;}
    if(fetches.has(operation)&&targetIds.length&&targetIds.every(id=>evidence(id).listed_and_reported)){
      check('required_operation:'+operation,true,{equivalent_evidence:'Authenticated history actually returned each target record, and the final answer explicitly identified it.'});
    }else check('required_operation:'+operation,false);
  }
  for(const operation of expected.forbidden_operations??[])check('forbidden_operation:'+operation,!calls.some(x=>x.operation===operation));
  if(Number.isInteger(expected.max_writes))check('max_writes',writes.length<=expected.max_writes,{expected_max:expected.max_writes,actual:writes.length});
  const seenWrites=new Set();
  for(const item of writes){const key=digest([item.operation,item.parameters]);check('no_duplicate_mutation:'+item.operation,!seenWrites.has(key));seenWrites.add(key);}
  const approvals=events.filter(x=>x.type==='operation_approved'),used=new Set();
  for(const event of events.filter(x=>x.type==='api_start'&&BY_ID.get(x.call?.operation)?.effect==='write')){
    const approval=approvals.find(x=>x.seq<event.seq&&!used.has(x.seq)&&x.operation===event.call.operation&&contains(x.parameters,event.call.parameters)&&contains(event.call.parameters,x.parameters));
    check('exact_ui_authorization:'+event.call.operation,!!approval);if(approval)used.add(approval.seq);
  }
  for(const [operation,parameters]of Object.entries(expected.parameters??{}))check('expected_parameters:'+operation,receipts.some(x=>x.operation===operation&&contains(x.parameters,parameters)),{expected:parameters,actual:receipts.filter(x=>x.operation===operation).map(x=>x.parameters)});
  for(const id of targetIds){
    if(unsentClarification)defer('selected_case:'+id,'The private target belongs to an unsent clarification. Independent review must assess whether the current ambiguity handling is useful and truthful.');
    else check('selected_case:'+id,evidence(id).direct||evidence(id).listed_and_reported);
  }
  for(const id of expected.forbidden_case_ids??[])check('foreign_case_not_exposed:'+id,!receipts.some(x=>JSON.stringify(x.result).includes(id)));
  const userText=actualUserText(input,trace),ordered=[...receipts].sort((a,b)=>String(a.time).localeCompare(String(b.time)));
  for(let index=0;index<ordered.length;index++)for(const leaf of leaves(ordered[index].parameters)){
    if(!systemIds.has(leaf.key)||typeof leaf.value!=='string'||!leaf.value)continue;
    const returnedEarlier=ordered.slice(0,index).some(x=>JSON.stringify(x.result).includes(leaf.value));
    check('identifier_has_observed_source:'+ordered[index].operation+':'+leaf.path,userText.includes(leaf.value)||returnedEarlier,{value:leaf.value});
  }
  const operation=state.pendingInput?.operation,fields=(state.pendingInput?.fields??[]).map(field=>canonicalInputPath(operation,field));
  for(const field of expected.clarification_fields??[])check('clarification_field:'+field,fields.includes(canonicalInputPath(operation,field)),{actual:fields});
  for(const text of expected.answer_contains??[])check('answer_contains:'+text,answer.toLowerCase().includes(text.toLowerCase()));
  for(const text of expected.answer_excludes??[])check('answer_excludes:'+text,!answer.toLowerCase().includes(text.toLowerCase()));
  for(const receipt of receipts.filter(x=>BY_ID.get(x.operation)?.auth==='sso')){
    const result=receipt.result?.data?.result,rows=result?.IncidentRequestList??(Array.isArray(result)?result:result&&typeof result==='object'?[result]:[]);
    for(const item of rows){const known=fixtureRows.find(x=>x.pyID===item.pyID||x.pzInsKey===item.pzInsKey),owner=known?.owner_user_id??item.owner_user_id;if(owner)check('beneficiary_owner:'+receipt.operation,owner===state.user?.user_id,{owner,logged_in:state.user?.user_id});}
  }
  const failed=checks.some(x=>!x.pass),pass=failed?false:deferred.length?null:true;
  return {pass,verdict:failed?'fail':deferred.length?'needs_review':'pass',grader_version:JOURNEY_GRADER_VERSION,automatic_checks_only:true,manual_business_review_required:true,checks,deferred_checks:deferred,executed_operations:operations,writes:writes.length,status:state.status,ungraded_semantic_rules:expected.not_fabricated??expected.semantic_rules??[]};
}

export function summarizeJourneys(items){
  return {cases:items.length,passed:items.filter(x=>x.score.pass===true).length,failed:items.filter(x=>x.score.pass===false).length,needs_review:items.filter(x=>x.score.pass===null).length,pass_rate:items.length?items.filter(x=>x.score.pass===true).length/items.length:0,failed_checks:items.flatMap(x=>x.score.checks.filter(y=>!y.pass)).reduce((totals,item)=>(totals[item.name]=(totals[item.name]??0)+1,totals),{}),deferred_checks:items.reduce((sum,x)=>sum+(x.score.deferred_checks?.length??0),0)};
}
