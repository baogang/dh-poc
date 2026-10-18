// Only synthetic demo data is submitted. Access credentials never enter reports.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const base=option('--url','https://road-pothole-pi-poc.onrender.com'),url=new URL(base);
if(url.origin!==base||!(base==='https://road-pothole-pi-poc.onrender.com'||url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw Error('Use the authorized POC or a local test server');
let password=process.env.POC_AUTH_PASSWORD;
if(option('--access-file',null)){const text=await readFile(option('--access-file'),'utf8');password=text.split('\n').find(line=>line.startsWith('Website password: '))?.slice(18).trim();}
if(!password&&url.protocol==='https:')throw Error('Provide the existing website access credential through environment or a protected file');
const authorization=password?'Basic '+Buffer.from((process.env.POC_AUTH_USERNAME??'admin')+':'+password).toString('base64'):null,checks=[];
const check=(name,pass)=>{checks.push({name,pass:!!pass});if(!pass)throw Error(name);};
const digest=text=>createHash('sha256').update(text).digest('hex'),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function request(path,{s,data,auth=true,csrf=true}={}){return fetch(base+path,{method:data?'POST':'GET',headers:{...(auth&&authorization?{authorization}:{}),...(s?{cookie:s.cookie}:{}),...(data?{'content-type':'application/json',...(s&&csrf?{'x-csrf-token':s.state.csrf}:{})}:{})},body:data?JSON.stringify(data):undefined,redirect:'error',signal:AbortSignal.timeout(45000)});}
async function refresh(s){const r=await request('/api/state',{s});if(!r.ok)throw Error('State request failed: '+r.status);s.state=await r.json();return s.state;}
async function action(s,path,data){
  for(let attempt=0;attempt<10;attempt++){
    const r=await request(path,{s,data}),value=await r.json();if(r.status===409&&value.error?.code==='BUSY'){await pause(400);continue;}
    if(!r.ok)throw Error(path+': '+r.status+' '+value.error?.code);s.state=value;
    for(let i=0;s.state.running&&i<180;i++){await pause(500);await refresh(s);}if(s.state.running)throw Error('Turn timed out');return;
  }throw Error('Session lease remained busy');
}
async function session(){const r=await request('/api/session',{data:{}});check('Create isolated synthetic conversation',r.status===201);return {cookie:r.headers.get('set-cookie').split(';')[0],state:await r.json()};}
let error;
try{
  const h=await request('/healthz',{auth:false}),health=await h.json();check('Live model and session service are ready',h.ok&&health.ok&&health.service==='road-pothole-pi-poc'&&health.model_configured);
  if(url.protocol==='https:'){check('Neon session storage remains enabled',health.session_storage==='neon');check('Website access protection remains enabled',(await request('/',{auth:false})).status===401);}
  for(const file of ['app.js','chat-ui.js','i18n.js','style.css']){const r=await request('/'+file);check('Published '+file+' matches tested source',r.ok&&digest(await r.text())===digest(await readFile(new URL('../web/road/'+file,import.meta.url),'utf8')));}
  const s=await session();check('Catalog distinguishes one mock transaction service and three consultation services',s.state.catalog.filter(x=>x.mode==='mock_transaction').length===1&&s.state.catalog.filter(x=>x.mode==='knowledge_only').length===3);
  check('Knowledge migration and policy proof remain separate',s.state.faq.entry_count===9&&s.state.faq.quality.missing_entries===17&&s.state.faq.quality.policy_status==='pending_official_verification');
  check('New help endpoint enforces CSRF',(await request('/api/help',{s,data:{action:'offer'},csrf:false})).status===403);
  await action(s,'/api/chat',{message:'Who can apply for this service?'});const choice=s.state.pendingKnowledge?.id,original=s.state.messages.findLast(m=>m.role==='user').id;
  check('First ambiguous question asks for service without business calls',!!choice&&s.state.mock.calls.length===0&&!s.state.events.some(e=>e.type==='emotion_started'));
  check('Stale service token is rejected',(await request('/api/service',{s,data:{scope:'infrastructure-permit',clarification_id:'not-current'}})).status===409);
  await action(s,'/api/service',{scope:'infrastructure-permit',clarification_id:choice});const answer=s.state.messages.at(-1);
  check('Service choice answers the original question without repetition',answer.source?.id==='FAQ-005'&&!s.state.pendingKnowledge&&answer.rateable);
  check('Answer exposes original source and pending policy review',answer.source.provenance.collection==='digital-human-faq'&&answer.source.original_question==='Who can apply for this service?'&&answer.source.provenance.policy_verified_at===null);
  await refresh(s);check('Refresh preserves selected service',s.state.serviceContext.scope==='infrastructure-permit');
  await action(s,'/api/chat',{message:'Are there any fees for issuing the permit?'});check('Follow-up uses the selected service',s.state.messages.at(-1).source?.id==='FAQ-008');
  await action(s,'/api/chat',{message:'Is the municipal fees invoice the same as the Civil Defense fees invoice?'});check('Explicit new service updates context',s.state.messages.at(-1).source?.id==='FAQ-002'&&s.state.serviceContext.scope==='civil-defense-fees');
  await action(s,'/api/help',{action:'offer'});const help=s.state.pendingHelp.id;check('Human help waits for user choice',s.state.mock.handoffs.length===0);
  check('Stale help token is rejected',(await request('/api/help',{s,data:{action:'queue',request_id:'not-current'}})).status===409);
  await action(s,'/api/help',{action:'queue',request_id:help});const handoff=s.state.activeHandoffId;
  check('Explicit help choice creates one simulated queue entry',s.state.mock.handoffs.length===1&&s.state.mock.handoffs[0].status==='WAITING'&&s.state.human_support.mode==='simulated');
  check('Handoff includes original dialogue and current service',s.state.mock.handoffs[0].conversation_summary.includes('Who can apply')&&s.state.mock.handoffs[0].conversation_summary.includes('civil-defense-fees'));
  check('Repeated queue click cannot create a second transfer',(await request('/api/help',{s,data:{action:'queue',request_id:help}})).status===409);
  await action(s,'/api/chat',{message:'Synthetic demo: please keep the service question in the handoff.'});check('Human-stage messages do not start business',s.state.messages.at(-1).kind==='human_reply'&&s.state.plans.length===0);
  await action(s,'/api/human',{handoff_id:handoff,action:'cancel'});check('User can cancel waiting and return to AI',!s.state.activeHandoffId&&s.state.mock.handoffs[0].status==='CANCELLED');
  if(s.state.feedback.enabled){const rating={answer_message_id:answer.id,rating:'satisfied',request_id:'p0-synthetic-regression',expected_version:0};const r=await request('/api/feedback',{s,data:rating}),saved=await r.json();check('Existing thumbs feedback persists with original-question attribution',r.ok&&saved.record.version===1&&saved.record.snapshot.question_message_id===original);}
  const business=await session();await action(business,'/api/login',{username:'demo',password:'demo'});const initialTickets=business.state.mock.tickets.length,initialHandoffs=business.state.mock.handoffs.length;
  await action(business,'/api/chat',{message:'Create a new deep pothole report at my registered home address. This is synthetic demo test data.'});const proposal=business.state.pendingOperation?.id;
  check('Existing creation still stops at exact HITL',!!proposal&&business.state.mock.tickets.length===initialTickets&&!business.state.mock.calls.some(c=>c.operation==='create_ticket'));
  await action(business,'/api/chat',{message:'Who can apply for this service?'});check('Clarification during HITL preserves the exact pending proposal',!!business.state.pendingKnowledge&&business.state.pendingOperation?.id===proposal);
  await action(business,'/api/service',{scope:'infrastructure-permit',clarification_id:business.state.pendingKnowledge.id});check('Answering side question preserves pending business approval',business.state.pendingOperation?.id===proposal);
  await action(business,'/api/approve-operation',{proposal_id:proposal});check('Confirmed mock submission completes once',business.state.status==='completed'&&business.state.mock.tickets.length===initialTickets+1);
  check('Duplicate old approval remains invalid',(await request('/api/approve-operation',{s:business,data:{proposal_id:proposal}})).status===409);
  check('Exactly one mock creation receipt remains',business.state.receipts.filter(r=>r.operation==='create_ticket').length===1);
  await action(business,'/api/chat',{message:'I am very disappointed with this service. Show my ticket history only; do not transfer me.'});
  check('Negative sentiment offers help without an automatic transfer',business.state.status==='human_offer'&&!!business.state.pendingHelp&&business.state.mock.handoffs.length===initialHandoffs);
  await action(business,'/api/help',{action:'continue',request_id:business.state.pendingHelp.id});
  check('Choosing AI resumes the original status-only request',business.state.status==='completed'&&business.state.receipts.some(r=>r.operation==='query_tickets')&&business.state.mock.handoffs.length===initialHandoffs&&business.state.mock.tickets.length===initialTickets+1);
  const draftSession=await session();
  await action(draftSession,'/api/matters',{action:'list'});check('Anonymous My matters asks for login inside chat',draftSession.state.messages.at(-1).kind==='matters_login');
  await action(draftSession,'/api/login',{username:'demo-no-address',password:'demo',show_matters:true});const originalCount=draftSession.state.mock.tickets.length;
  check('My matters exposes current account records',!!draftSession.state.mattersView&&draftSession.state.messages.at(-1).kind==='matters');
  check('Matters mutations enforce CSRF',(await request('/api/matters',{s:draftSession,data:{action:'read',ids:[]},csrf:false})).status===403);
  await action(draftSession,'/api/chat',{message:'Please report a deep pothole beside the synthetic library in Riyadh, Test Cedar Road.'});const oldDraftProposal=draftSession.state.pendingOperation?.id;
  check('New report automatically saves an unsubmitted draft',!!oldDraftProposal&&!!draftSession.state.currentDraft&&draftSession.state.mock.tickets.length===originalCount);
  await action(draftSession,'/api/edit-operation',{proposal_id:oldDraftProposal,value:{address:{city:'Riyadh',street:'Test Maple Road'},description:'Synthetic release regression pothole beside the test library.'}});
  check('Editing preserves no old approval',draftSession.state.pendingOperation?.id!==oldDraftProposal&&draftSession.state.pendingOperation?.parameters.address.street==='Test Maple Road');
  check('Old payload confirmation cannot be reused',(await request('/api/approve-operation',{s:draftSession,data:{proposal_id:oldDraftProposal}})).status===409);
  const saved=structuredClone(draftSession.state.currentDraft);await action(draftSession,'/api/save-draft',{proposal_id:draftSession.state.pendingOperation.id});check('Save for later pauses and revokes confirmation',!draftSession.state.pendingOperation&&draftSession.state.status==='paused');
  const restored=await session();await action(restored,'/api/login',{username:'demo-no-address',password:'demo',show_matters:true});check('New login restores the same account draft',restored.state.mattersView.drafts.some(d=>d.id===saved.id&&d.status==='draft'));
  const foreign=await session();await action(foreign,'/api/login',{username:'demo-other',password:'demo'});check('Another account cannot restore the draft',(await request('/api/matters',{s:foreign,data:{action:'resume',draft_id:saved.id,version:saved.version}})).status===409);
  await action(restored,'/api/matters',{action:'resume',draft_id:saved.id,version:saved.version});const current=restored.state.pendingOperation.id;
  check('Restored draft needs fresh exact confirmation',restored.state.currentDraft.version===saved.version+1&&restored.state.pendingOperation.parameters.address.street==='Test Maple Road'&&restored.state.mock.tickets.length===originalCount);
  check('Stale saved draft version is rejected',(await request('/api/matters',{s:draftSession,data:{action:'resume',draft_id:saved.id,version:saved.version}})).status===409);
  await action(restored,'/api/approve-operation',{proposal_id:current});const created=restored.state.receipts.find(r=>r.operation==='create_ticket')?.result.ticket;
  check('Restored draft creates one corrected report',restored.state.status==='completed'&&created?.address.street==='Test Maple Road'&&restored.state.mock.tickets.length===originalCount+1);
  await action(restored,'/api/matters',{action:'list'});check('Submitted draft cannot become a second submission',restored.state.mattersView.drafts.find(d=>d.id===saved.id)?.status==='submitted'&&(await request('/api/matters',{s:restored,data:{action:'resume',draft_id:saved.id,version:restored.state.currentDraft.version}})).status===409);
  for(const status of ['IN_PROGRESS','RESOLVED']){await action(restored,'/api/matters',{action:'simulate',ticket_id:created.ticket_id});check('Demo timeline advances to '+status,restored.state.mattersView.tickets.find(t=>t.ticket_id===created.ticket_id)?.status===status);}
  const timeline=restored.state.mattersView.timeline.filter(e=>e.ticket_id===created.ticket_id),notifications=restored.state.mattersView.notifications.filter(e=>e.ticket_id===created.ticket_id);
  check('One receipt reference and one reminder per actual mock change',timeline.length===3&&timeline.every(e=>e.reference_id&&e.source_type==='mock')&&notifications.length===3);
  await action(restored,'/api/matters',{action:'read',ids:notifications.map(n=>n.id)});await refresh(restored);check('Read markers survive refresh',restored.state.mattersView.notifications.filter(n=>n.ticket_id===created.ticket_id).every(n=>n.read));
  check('Private mock transport remains inaccessible',(await request('/mock/query_tickets',{data:{}})).status===403);
}catch(e){error=e.message;}
const report={timestamp:new Date().toISOString(),url:base,synthetic_data:true,passed:checks.filter(c=>c.pass).length,total:checks.length,error,checks};
if(option('--output',null))await writeFile(option('--output'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(error)process.exitCode=1;
