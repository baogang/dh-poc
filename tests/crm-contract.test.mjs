import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {OPERATIONS,BY_ID} from '../src/crm/contract.mjs';
import {OPENAPI} from '../src/crm/openapi.mjs';
import {validateInput,requestFor} from '../src/crm/validation.mjs';
import {RealCrmClient,inspectResponse} from '../src/crm/client.mjs';
const cases=(await readFile('datasets/balady-crm/tool-cases.jsonl','utf8')).trim().split('\n').map(JSON.parse);
test('all 36 service sections have unique OpenAPI operations and source references',()=>{
  const operations=Object.values(OPENAPI.paths).flatMap(Object.values);assert.equal(operations.length,36);assert.equal(new Set(operations.map(x=>x.operationId)).size,36);
  assert.deepEqual(OPERATIONS.map(x=>Number(x.section.slice(2))).sort((a,b)=>a-b),Array.from({length:35},(_,i)=>i+2));
  for(const op of operations){assert.ok(op['x-source'].printedPage>=15);assert.equal(op['x-source'].pdfPage,op['x-source'].printedPage+1);assert.ok(op.responses['200']);}
});
for(const c of cases.slice(0,35))test(c.id+' supplied documented positive parameters validate',()=>{
  const [operation,parameters]=Object.entries(c.expected.parameters)[0];const validation=validateInput(operation,parameters);assert.equal(validation.valid,true,JSON.stringify(validation));
  const request=requestFor(operation,parameters);assert.equal(request.valid,true);assert.ok(request.path.startsWith('/v1/crm-services/'));
});
test('path keys preserve spaces, Unicode and plus signs after exactly one encoding',()=>{
  const key='MOMRA-OPS-CS-WORK INC-1 + حي';const request=requestFor('crm_fetch_incident',{pzInsKey:key});assert.equal(new URL(request.path,'http://test').searchParams.get('pzInsKey'),key);
  const asset=requestFor('crm_get_asset_details',{id:'MA/one + two'});assert.ok(asset.path.endsWith('MA%2Fone%20%2B%20two'));
});
test('missing nested public contact fields are returned at exact paths',()=>{
  const result=validateInput('crm_create_form_request',{body:{CustomerInformation:{FirstName:'A'},subject:'s',Description:'d',Type:'T03',Attachments:[]}});
  assert.equal(result.valid,false);assert.ok(result.errors.some(x=>x.path==='/body/CustomerInformation/EmailAddress'));assert.ok(result.errors.some(x=>x.path==='/body/CustomerInformation/MobileNumber'));
});
test('CIS quantities and post-fix photos are conditional',()=>{
  const cis=structuredClone(cases[7].expected.parameters.crm_update_cis_incident);cis.body.IsPublicUtilityDamaged='True';const v=validateInput('crm_update_cis_incident',cis);assert.ok(v.errors.some(x=>x.path.endsWith('/IncidentQuantity')));assert.ok(v.errors.some(x=>x.path.endsWith('/UnitValue')));
  const external=structuredClone(cases[8].expected.parameters.crm_update_external_incident);external.body.IncidentStatusName='Resolved';assert.ok(validateInput('crm_update_external_incident',external).errors.some(x=>x.path.endsWith('/IncidentPhotosAfterFixing')));
});
test('Madinati/external date and attachment spelling remain distinct',()=>{
  assert.equal(BY_ID.get('crm_resolve_madinati_incident').input.properties.body.properties.ActionDate.pattern,'^\\d{2}/\\d{2}/\\d{4}$');
  const result=validateInput('crm_resolve_madinati_incident',{body:{MomraIncidentNo:'INC-1',IncidentStatusName:'Resolved',ActionDate:'2026-10-20',ClosureReasonName:'x',EmployeeName:'e',IsProcessed:false}});assert.equal(result.valid,false);
  assert.ok(BY_ID.get('crm_resolve_madinati_incident').body.properties.IncidentPhotosAfterFixing.items.properties.AttachmentURL);
  assert.ok(BY_ID.get('crm_update_external_incident').body.properties.IncidentPhotosAfterFixing.items.properties.AttachmentUrl);
});
test('wrong field case suggests correction and does not mutate input',()=>{
  const input={body:{IncidentID:'INC-1',status:1}};const before=structuredClone(input),v=validateInput('crm_update_vehicle_status',input);assert.equal(v.valid,false);assert.equal(v.errors.find(x=>x.suggested_field)?.suggested_field,'Status');assert.deepEqual(input,before);
});
test('types, enums and unknown model-supplied host fields are rejected',()=>{
  assert.equal(validateInput('crm_update_vehicle_status',{body:{IncidentID:'INC-1',Status:'1'}}).valid,false);
  assert.equal(validateInput('crm_update_vehicle_status',{body:{IncidentID:'INC-1',Status:7}}).valid,false);
  assert.equal(validateInput('crm_get_incidents',{user_id:'someone'}).valid,false);
  assert.equal(validateInput('crm_get_assets',{confirmed:true}).valid,false);
});
test('business error envelopes with HTTP 200 are failures',()=>{
  assert.equal(inspectResponse(200,{statusDetails:{code:200},data:{responseCode:'EEAPI_02',responseMessage:'already resolved'}}).ok,false);
  assert.equal(inspectResponse(200,{statusDetails:{code:400}}).ok,false);assert.equal(inspectResponse(200,{statusDetails:{code:200},data:{responseCode:'MMRH-00000'}}).ok,true);
  assert.equal(inspectResponse(200,{}).error.code,'MALFORMED_RESPONSE');
});
test('SSO JWT never falls back to consumer OAuth',async()=>{
  let calls=0;const client=new RealCrmClient({consumerKey:'test',consumerSecret:'test',fetchImpl:async()=>{calls++;throw Error('unexpected network');}});const result=await client.execute({},'crm_get_incidents',{});assert.equal(result.error.code,'SSO_NOT_CONFIGURED');assert.equal(calls,0);
});
test('conflicting real auth and body shapes require provider-confirmed policy',async()=>{
  let calls=0;const client=new RealCrmClient({fetchImpl:async()=>{calls++;throw Error('unexpected network');}});
  assert.equal((await client.execute({},'crm_reopen_incident',{body:{IncidentID:'INC-1'}})).error.code,'DOCUMENTATION_AMBIGUITY');
  assert.equal((await client.execute({},'crm_create_daem_ticket',cases[28].expected.parameters.crm_create_daem_ticket)).error.code,'DOCUMENTATION_AMBIGUITY');
  assert.equal((await client.execute({},'crm_create_form_request',cases[29].expected.parameters.crm_create_form_request)).error.code,'DOCUMENTATION_AMBIGUITY');assert.equal(calls,0);
});
test('real adapter caches OAuth and preserves a failed mutation as uncertain without retry',async()=>{
  const requests=[];const client=new RealCrmClient({consumerKey:'k',consumerSecret:'secret',fetchImpl:async(url,options)=>{requests.push({url,options});if(url.endsWith('/token'))return new Response(JSON.stringify({access_token:'private-token',expires_in:'3600'}));if(url.endsWith('/update-status'))throw Error('response lost');return new Response(JSON.stringify({statusDetails:{code:200},data:{responseCode:'1',result:[]}}));}});
  assert.equal((await client.execute({},'crm_get_assets',{})).ok,true);assert.equal((await client.execute({},'crm_get_assets',{})).ok,true);
  assert.equal((await client.execute({},'crm_update_vehicle_status',{body:{IncidentID:'INC-1',Status:1}})).error.code,'RESULT_UNCERTAIN');
  assert.equal(requests.filter(x=>x.url.endsWith('/token')).length,1);assert.equal(requests.filter(x=>x.url.endsWith('/update-status')).length,1);
  assert.equal(requests[0].options.body.get('grant_type'),'client_credentials');
});
test('new regression datasets preserve minimum counts, enabled status and hidden references',async()=>{
  const planning=(await readFile('datasets/balady-crm/planning-cases.jsonl','utf8')).trim().split('\n').map(JSON.parse);assert.ok(cases.length>=50);assert.ok(planning.length>=20);
  assert.equal(new Set([...cases,...planning].map(x=>x.id)).size,cases.length+planning.length);assert.ok([...cases,...planning].every(x=>x.enabled));
  assert.deepEqual(new Set(cases.slice(0,35).flatMap(x=>Object.keys(x.expected.parameters))),new Set(OPERATIONS.map(x=>x.id)));
});
