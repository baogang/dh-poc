import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {controlledSession} from '../src/road/runtime.mjs';
import {CrmResponseGuard} from '../src/crm/response-guard.mjs';

// The agreed seam is review(): independent verifier verdicts are external input.
// Only two clean approvals may release the author's original prose. Reviewers
// have no authority to rewrite business text or perform business operations.
const call=args=>fauxAssistantMessage(fauxToolCall('review_message',args),{stopReason:'toolUse'});
const inputOf=context=>JSON.parse(context.messages.find(x=>x.role==='user').content.find(x=>x.type==='text').text);
const session=()=>({messages:[{role:'user',text:'Check report INC-31-07-000192 for Test User.'}],receipts:[{id:'real-read',operation:'crm_fetch_incident',parameters:{pzInsKey:'MOMRA-OPS-CS-WORK INC-31-07-000192'},result:{data:{result:{pyID:'INC-31-07-000192',pyStatusWork:'Open'}}}}],facts:{files:[]}});
const denied=error=>['UNVERIFIED_CUSTOMER_CLAIMS','RESPONSE_GUARD_UNAVAILABLE'].includes(error.code);

function reviewers(verdicts,inspect=()=>{}){
  const prompts=[],runtimes=[];
  const guard=new CrmResponseGuard({runtimeFactory:async options=>{
    assert.deepEqual(options.tools.map(x=>x.name),['review_message'],'Verifiers cannot receive business tools');
    const index=runtimes.length;assert.ok(index<verdicts.length,'No unplanned verification pass');
    const runtime=await controlledSession({...options,fauxResponses:[context=>{const input=inputOf(context);prompts.push(input);inspect(input,context,index);return call(verdicts[index]);}]});runtimes.push(runtime);return runtime;
  }});
  return {guard,prompts,runtimes};
}

test('response verification requires two fresh clean approvals and returns the original text without changing facts',async()=>{
  const events=[],snapshot=session(),before=structuredClone(snapshot),texts=['Waste collection: local simulated report INC-31-07-000192 is Open. Which part would you like to check?'];
  const verifier=reviewers([{approved:true,issues:[]},{approved:true,issues:[]}],(input,context,index)=>{
    assert.equal(input.review_scope,['facts','capability_language'][index]);assert.equal(input.mode,'simulation');assert.deepEqual(input.texts,texts);assert.equal(input.actual_receipts[0].result.data.result.pyStatusWork,'Open');assert.equal(input.actual_receipts[0].parameters.pzInsKey,'MOMRA-OPS-CS-WORK INC-31-07-000192');assert.equal(input.capabilities.official_sync,false);assert.equal(input.capabilities.notifications,false);assert.equal(input.capabilities.department_handoff,false);assert.equal(input.capabilities.external_processing,false);assert.equal(context.messages.filter(x=>x.role==='user').length,1);assert.ok(!context.messages.some(x=>x.role==='toolResult'),'Each verifier must see fresh evidence, not the previous verdict');
  });
  const result=await verifier.guard.review({texts,session:snapshot,mode:'simulation',language:'en',context:{kind:'missing_information'},onEvent:event=>events.push(event)});
  assert.deepEqual(result.texts,texts);assert.deepEqual(snapshot,before);assert.equal(verifier.runtimes.length,2);assert.notEqual(verifier.runtimes[0].session,verifier.runtimes[1].session);assert.equal(events.filter(x=>x.type==='response_guard_completed').length,1);
});

test('a verifier rejection cannot be used to publish the claimed repaired answer',async()=>{
  const snapshot=session(),before=structuredClone(snapshot),verifier=reviewers([{issues:['Unsupported official tracking'],texts:['A reviewer-authored replacement.']}]);
  await assert.rejects(()=>verifier.guard.review({texts:['Track local report INC-31-07-000192 in the official app.'],session:snapshot,mode:'simulation',language:'en'}),denied);assert.deepEqual(snapshot,before);
});

test('approved true accompanied by factual issues must be rejected rather than displayed',async()=>{
  const verifier=reviewers([{approved:true,issues:['Attachment boolean does not prove a photo count or uploader']}]);
  await assert.rejects(()=>verifier.guard.review({texts:['You uploaded two photos.'],session:session(),mode:'simulation',language:'en'}),error=>error.code==='UNVERIFIED_CUSTOMER_CLAIMS');
});

test('a clean factual verdict does not bypass a failed second capability or language verdict',async()=>{
  const verifier=reviewers([{approved:true,issues:[]},{approved:false,issues:['Unsupported official privacy policy']}]);
  await assert.rejects(()=>verifier.guard.review({texts:['The official service never discloses survey scores.'],session:session(),mode:'simulation',language:'en'}),error=>error.code==='UNVERIFIED_CUSTOMER_CLAIMS');assert.equal(verifier.runtimes.length,2);
});

test('an English conversation cannot receive an entirely Arabic paragraph even if model verifiers approve it',async()=>{
  const verifier=reviewers([{approved:true,issues:[]},{approved:true,issues:[]}]);
  await assert.rejects(()=>verifier.guard.review({texts:['تم العثور على البلاغ وحالته مفتوح في هذه البيئة التجريبية المحلية، ولا توجد معلومات إضافية عن وقت بدء العمل أو موعد الإصلاح.'],session:session(),mode:'simulation',language:'en'}),error=>error.code==='UNVERIFIED_CUSTOMER_CLAIMS');
});

test('both fresh verifiers receive file metadata but no selected bytes from any receipt',async()=>{
  const snapshot=session(),base64=Buffer.from('Private selected citizen document, never model text.').toString('base64');snapshot.crmFiles={'file-private':{name:'Citizen Notes.txt',base64}};snapshot.facts.files=[{id:'file-private',name:'Citizen Notes.txt',media_type:'text/plain',size:51}];snapshot.receipts.push({operation:'crm_upload_attachment',parameters:{body:{AttachStream:base64,pxAttachName:'Citizen Notes.txt'}},result:{data:{result:[{fileId:'F-guard-real'}]}}},{operation:'crm_download_file',parameters:{FileKey:'F-guard-real'},result:{data:{result:{AttachmentStream:base64}}}});
  const verifier=reviewers([{approved:true,issues:[]},{approved:true,issues:[]}],(input,context)=>{assert.ok(!JSON.stringify(context).includes(base64));assert.equal(input.selected_files[0].name,'Citizen Notes.txt');assert.equal(input.actual_receipts[1].parameters.body.AttachStream,'[file bytes retained by host]');assert.equal(input.actual_receipts[2].result.data.result.AttachmentStream,'[file bytes retained by host]');assert.equal(input.context.known_parameters.body.AttachStream,'[file bytes retained by host]');assert.equal(input.context.previous_draft.parameters.body.AttachStream,'[file bytes retained by host]');assert.equal(input.crmFiles,undefined);});
  const result=await verifier.guard.review({texts:['Which report should receive Citizen Notes.txt?'],session:snapshot,mode:'simulation',language:'en',context:{kind:'missing_information',known_parameters:{body:{AttachStream:base64}},previous_draft:{operation:'crm_upload_attachment',parameters:{body:{AttachStream:base64}}}}});assert.equal(result.texts[0],'Which report should receive Citizen Notes.txt?');assert.equal(snapshot.receipts[1].parameters.body.AttachStream,base64);assert.equal(verifier.prompts.length,2);
});

test('fresh verifiers receive trusted sign-in state and the actual SSO authentication requirement without identity secrets',async()=>{
  for(const signedIn of [false,true]){const snapshot=session();if(signedIn)snapshot.user={user_id:'demo-demo',display_name:'Synthetic Demo User',password:'private-fixture-password'};const verifier=reviewers([{approved:true,issues:[]},{approved:true,issues:[]}],input=>{assert.equal(input.beneficiary_signed_in,signedIn);assert.equal(input.context.operation_auth,'sso');assert.equal(input.context.signed_in,signedIn);assert.equal(input.user,undefined);assert.ok(!JSON.stringify(input).includes('private-fixture-password'));});const texts=[signedIn?'Your demo sign-in is complete.':'Sign in to view your own reports.'];const result=await verifier.guard.review({texts,session:snapshot,mode:'simulation',language:'en',context:{kind:'missing_information',operation:'crm_get_incidents',input_kind:'login',fields:[],operation_auth:'sso',signed_in:signedIn}});assert.deepEqual(result.texts,texts);assert.equal(verifier.prompts.length,2);}
});

test('empty-prose submission review verifies exact payload metadata while retaining upload bytes only on the host',async()=>{
  const snapshot=session(),base64=Buffer.from('Exact file content belongs only to the upload adapter.').toString('base64'),parameters={sourceSystem:'BALADY Assistant POC',body:{AttachStream:base64,pxAttachName:'Citizen Memo.txt',pyMemo:'My exact note',Category:'Initial'}};
  snapshot.crmFiles={'file-private':{name:'Citizen Memo.txt',base64}};snapshot.facts.files=[{id:'file-private',name:'Citizen Memo.txt',media_type:'text/plain',size:52}];
  const verifier=reviewers([{approved:true,issues:[]},{approved:true,issues:[]}],(input,context)=>{assert.deepEqual(input.texts,[]);assert.equal(input.context.kind,'submission_draft');assert.equal(input.context.parameters.body.pxAttachName,parameters.body.pxAttachName);assert.equal(input.context.parameters.body.pyMemo,parameters.body.pyMemo);assert.equal(input.context.parameters.body.AttachStream,'[file bytes retained by host]');assert.equal(input.context.previous_draft.parameters.body.AttachStream,'[file bytes retained by host]');assert.ok(!JSON.stringify(context).includes(base64));});
  const result=await verifier.guard.review({texts:[],session:snapshot,mode:'simulation',language:'en',context:{kind:'submission_draft',operation:'crm_upload_attachment',parameters,previous_draft:{operation:'crm_upload_attachment',parameters}}});assert.deepEqual(result,{texts:[],issues:[]});assert.equal(parameters.body.AttachStream,base64);assert.equal(verifier.prompts.length,2);
});
