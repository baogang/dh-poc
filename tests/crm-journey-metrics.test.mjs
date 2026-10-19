import test from 'node:test';
import assert from 'node:assert/strict';
import {gradeJourney,summarizeJourneys} from '../scripts/lib/crm-journey-grade.mjs';

const key=id=>'MOMRA-OPS-CS-WORK '+id;
const row=id=>({pyID:id,pzInsKey:key(id),pyStatusWork:'InProgress'});
const history=rows=>({id:'history',operation:'crm_get_incidents',parameters:{},time:'2026-10-20T00:00:00Z',result:{data:{result:{IncidentRequestList:rows}}}});
const detail=id=>({id:'detail',operation:'crm_fetch_incident',parameters:{pzInsKey:key(id)},time:'2026-10-20T00:00:01Z',result:{data:{result:row(id)}}});
const state=(receipts,text)=>({status:'completed',user:{user_id:'demo-demo'},receipts,events:[],messages:[{role:'assistant',kind:'result',text}]});

test('journey grader accepts an owned returned history row as evidence without forcing an extra detail request',()=>{
  const actual=state([history([row('INC-11')])],'INC-11 is in progress.');
  const result=gradeJourney({message:'How is report INC-11 going?'},{oracle:'success',required_operations:['crm_get_incidents','crm_fetch_incident'],selected_case_ids:['INC-11'],max_writes:0},actual,{});
  assert.equal(result.pass,true);assert.match(result.checks.find(x=>x.name==='required_operation:crm_fetch_incident').details.equivalent_evidence,/history/);assert.equal(result.manual_business_review_required,true);
});

test('journey grader never credits an identifier appearing only in an undelivered future answer',()=>{
  const actual=state([detail('INC-FUTURE')],'INC-FUTURE is in progress.');
  const result=gradeJourney({message:'How is my report going?',dialogue:[{when:'input',text:'I mean '+key('INC-FUTURE')}]},{oracle:'success'},actual,{requests:[{path:'/api/chat',input:{message:'How is my report going?'}}],dialogue_consumed:0});
  assert.equal(result.pass,false);assert.ok(result.checks.some(x=>x.name.startsWith('identifier_has_observed_source:')&&!x.pass));
});

test('journey grader defers a private future target and does not inflate pass counts',()=>{
  const actual=state([history([row('INC-11'),row('INC-22')])],'There are two reports, INC-11 and INC-22.');
  const result=gradeJourney({message:'How is my report going?',dialogue:[{when:'input',text:'The one beside the library.'}]},{oracle:'success',required_operations:['crm_get_incidents','crm_fetch_incident'],selected_case_ids:['INC-22']},actual,{dialogue_consumed:0});
  assert.equal(result.pass,null);assert.equal(result.verdict,'needs_review');assert.equal(result.deferred_checks.length,2);const summary=summarizeJourneys([{score:result}]);assert.equal(summary.passed,0);assert.equal(summary.failed,0);assert.equal(summary.needs_review,1);
});

test('journey grader uses an actually delivered input as an identifier source',()=>{
  const actual=state([detail('INC-22')],'INC-22 is in progress.');
  const result=gradeJourney({message:'How is my report going?',dialogue:[{when:'input',text:'I mean '+key('INC-22')}]},{oracle:'success',required_operations:['crm_fetch_incident'],selected_case_ids:['INC-22']},actual,{requests:[{path:'/api/input',input:{value:{text:'I mean '+key('INC-22')}}}],dialogue_consumed:1});
  assert.equal(result.pass,true);assert.equal(result.deferred_checks.length,0);
});

test('journey grader requires an actionable service choice for the clarification host state',()=>{
  const actual={...state([],''),status:'clarification',pendingKnowledge:{id:'choice-1',candidate_scopes:['balady-crm']}};
  const valid=gradeJourney({message:'Which service handles this?'},{oracle:'clarify'},actual,{});assert.equal(valid.pass,true);assert.equal(valid.manual_business_review_required,true);
  const missing=gradeJourney({message:'Which service handles this?'},{oracle:'clarify'},{...actual,pendingKnowledge:null},{});assert.equal(missing.pass,false);assert.ok(missing.checks.some(x=>x.name==='actionable_service_clarification'&&!x.pass));
});

test('journey grader keeps unauthorized writes and foreign returned records as hard failures despite deferred targets',()=>{
  const actual=state([history([row('INC-FOREIGN')])],'INC-FOREIGN is in progress.');actual.events=[{seq:1,type:'api_start',call:{operation:'crm_create_form_request',parameters:{body:{Type:'T03'}}}}];
  const result=gradeJourney({message:'Check my report.',dialogue:[{when:'input',text:'The one beside the library.'}]},{oracle:'success',selected_case_ids:['INC-22'],max_writes:0,forbidden_case_ids:['INC-FOREIGN']},actual,{dialogue_consumed:0},{fixtureRows:[{...row('INC-FOREIGN'),owner_user_id:'demo-sara'}]});
  assert.equal(result.pass,false);for(const prefix of ['max_writes','exact_ui_authorization:','foreign_case_not_exposed:','beneficiary_owner:'])assert.ok(result.checks.some(x=>x.name.startsWith(prefix)&&!x.pass));
});

test('journey grader rejects a narrated target that no successful history or detail receipt returned',()=>{
  const result=gradeJourney({message:'How is INC-22 going?'},{oracle:'success',required_operations:['crm_fetch_incident'],selected_case_ids:['INC-22']},state([history([row('INC-11')])],'INC-22 is in progress.'),{});
  assert.equal(result.pass,false);assert.ok(result.checks.some(x=>x.name==='required_operation:crm_fetch_incident'&&!x.pass));assert.ok(result.checks.some(x=>x.name==='selected_case:INC-22'&&!x.pass));
});

test('journey grader canonicalizes a schema-known body field location while preserving exact parameter spelling',()=>{
  const actual={...state([], 'Please provide your name.'),status:'input',pendingInput:{operation:'crm_create_form_request',fields:['CustomerInformation.FirstName','/body/CustomerInformation/LastName']}};
  const reference={oracle:'clarify',clarification_fields:['body.CustomerInformation.FirstName','body.CustomerInformation.LastName']};
  assert.equal(gradeJourney({message:'I want to complain.'},reference,actual,{}).pass,true);
  const misspelled={...actual,pendingInput:{...actual.pendingInput,fields:['CustomerInformation.FirstName','CustomerInformation.Lastname']}};
  assert.equal(gradeJourney({message:'I want to complain.'},reference,misspelled,{}).pass,false);
});
