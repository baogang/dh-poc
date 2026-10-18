import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {RoadStore,digest} from '../src/road/store.mjs';
import {createRoadServer} from '../src/road/server.mjs';
import {FeedbackRepository} from '../src/road/feedback.mjs';
const option=(name,otherwise)=>{const i=process.argv.indexOf(name);return i<0?otherwise:process.argv[i+1];};
const definitions=(await readFile(new URL('../datasets/road-v4/cases.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse).filter(c=>!option('--case',null)||c.id===option('--case',null));
if(!definitions.length)throw Error('No cases selected');
const rows=[];
async function evaluate(c){
  const app=await createRoadServer({store:new RoadStore(),feedback:new FeedbackRepository({connectionString:null}),config:{port:10000,host:'127.0.0.1',access:{}}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();
  const {agent,store}=app,sessions=[],checks=[];let s=store.create(),original,originalProposal,draft,createdId;
  const check=(name,pass)=>checks.push({name,pass:!!pass});
  const rejects=async(fn,code)=>{try{await fn();return false;}catch(e){return e.code===code;}};
  async function inputs(){for(let i=0;s.pendingInput&&i<5;i++){const x=s.pendingInput;if(x.kind==='login'){if(!s.user)await agent.login(s,{username:c.login,password:'demo'});await agent.answerInput(s,x.id,{});}else if(x.kind==='address')await agent.answerInput(s,x.id,{city:'Riyadh',street:'Test Cedar Road'});else if(x.kind==='ticket')await agent.answerInput(s,x.id,{ticket_id:x.candidates.find(t=>t.ticket_id==='T102')?.ticket_id??x.candidates[0].ticket_id,matched:true,unresolved:false});else await agent.answerInput(s,x.id,{text:'A deep pothole outside the test library. Please perform only the requested action.'});}}
  try{
    sessions.push(s);await agent.login(s,{username:c.login,password:'demo'});
    for(const [index,a]of c.actions.entries()){
      if(a.action==='chat'){await agent.chat(s,a.message);await inputs();if(s.pendingOperation?.operation==='create_ticket')draft=structuredClone(s.currentDraft);}
      else if(a.action==='edit'){const old=s.pendingOperation.id;await agent.editOperation(s,old,a.value);if(a.assert_old_rejected)check(`step ${index}: old payload rejected`,await rejects(()=>agent.approveOperation(s,old),'STALE_CONFIRMATION'));draft=structuredClone(s.currentDraft);}
      else if(a.action==='approve'){check(`step ${index}: exact confirmation exists`,s.pendingOperation);if(!s.pendingOperation)throw Error('No confirmation to approve');await agent.approveOperation(s,s.pendingOperation.id);createdId=s.receipts.findLast(r=>r.operation==='create_ticket')?.result.ticket.ticket_id??createdId;}
      else if(a.action==='save'){await agent.saveForLater(s,s.pendingOperation.id);check('Save revokes confirmation',!s.pendingOperation&&!Object.keys(s.authorizations).length);}
      else if(a.action==='remember'){original=s;originalProposal=s.pendingOperation.id;}
      else if(a.action==='fresh'){s=store.create();sessions.push(s);await agent.login(s,{username:a.login,password:'demo'});}
      else if(a.action==='resume'){await agent.resumeDraft(s,draft.id,draft.version);draft=structuredClone(s.currentDraft);check('Restoration requires fresh approval',s.pendingOperation&&!Object.keys(s.authorizations).length);}
      else if(a.action==='reject_original')check('Original tab cannot submit claimed draft',await rejects(()=>agent.approveOperation(original,originalProposal),'STALE_DRAFT'));
      else if(a.action==='reject_foreign'){check('Foreign account cannot restore draft',await rejects(()=>agent.resumeDraft(s,draft.id,draft.version),'STALE_DRAFT'));check('Foreign account has no draft',!(await agent.matters.list(s)).drafts.length);}
      else if(a.action==='discard')await agent.matters.remove(s,draft.id,draft.version);
      else if(a.action==='reject_discarded'){check('Discarded draft cannot resume',await rejects(()=>agent.resumeDraft(s,draft.id,draft.version),'STALE_DRAFT'));check('Discarded proposal cannot submit',await rejects(()=>agent.approveOperation(s,s.pendingOperation.id),'STALE_DRAFT'));}
      else if(a.action==='invalid_edit'){const old=s.pendingOperation.id;check('Invalid edit rejected',await rejects(()=>agent.editOperation(s,old,{address:{city:'',street:''},description:''}),'INVALID_EDIT'));check('Valid proposal survives invalid edit',s.pendingOperation.id===old);}
      else if(a.action==='fault')s.mock.faults[a.operation]=structuredClone(a.value);
      else if(a.action==='reconcile_absent'){check('Unknown result is visible',s.uncertainOperation);await agent.reconcileOperation(s);check('Authoritative absent result checked',s.messages.at(-1).reconcile_state==='absent');}
      else if(a.action==='retry')await agent.retry(s);
      else if(a.action==='advance')await agent.matters.simulate(s,createdId);
      else if(a.action==='read')await agent.matters.markRead(s,(await agent.matters.list(s)).notifications.map(n=>n.id));
      else if(a.action==='list')await agent.showMatters(s);
      else throw Error('Unknown action '+a.action);
    }
    const account=store.accountData.get(c.login==='demo-no-address'?'U003':'U001'),expected=c.expected,selected=new Set(sessions.flatMap(x=>x.events.filter(e=>e.type==='tool_start'&&['query_tickets','create_ticket','close_ticket','complain_ticket','handoff_to_human'].includes(e.name)).map(e=>e.name))),wanted=new Set(expected.tools);
    check('Expected unique created records',account.tickets.length-3===expected.created);
    if(expected.feedback_restore){const answer=s.messages.findLast(m=>m.kind==='result'),snapshot=s.answerSnapshots?.[answer?.id],question=s.messages.find(m=>m.id===snapshot?.question_message_id);check('Restored draft feedback uses its own request',question?.kind==='draft_restore'&&snapshot.question.includes('Test Cedar Road'));}
    if(expected.address)check('Exact corrected address',account.tickets.slice(3).some(t=>Object.entries(expected.address).every(([k,v])=>t.address[k]===v)));
    if(expected.pending_confirmation)check('Unsubmitted restored confirmation',!!s.pendingOperation&&s.receipts.length===0);
    if(expected.ticket_status)check('Actual current ticket status',account.tickets.find(t=>t.ticket_id===createdId)?.status===expected.ticket_status);
    if(expected.timeline_count!==undefined)check('Exact receipt-based timeline count',account.timeline.length===expected.timeline_count);
    if(expected.notification_count!==undefined)check('Exactly one notification per change',account.notifications.length===expected.notification_count);
    if(expected.unread!==undefined)check('Read markers survive login',account.notifications.filter(n=>!n.read).length===expected.unread);
    if(expected.complaint_reason)check('Corrected complaint reason',account.complaints.at(-1)?.reason===expected.complaint_reason);
    if(expected.closed_ticket)check('Closed status persisted',account.tickets.find(t=>t.ticket_id===expected.closed_ticket)?.status==='CLOSED');
    if(expected.original_address_unchanged)check('Submitted record was not silently amended',account.tickets.slice(3).every(t=>t.address.street==='Test Cedar Road'));
    check('Forbidden operations absent',!(expected.forbidden_tools??[]).some(t=>selected.has(t)));
    const tp=[...wanted].filter(t=>selected.has(t)).length,fp=[...selected].filter(t=>!wanted.has(t)).length,fn=[...wanted].filter(t=>!selected.has(t)).length;check('Tool precision and recall',fp===0&&fn===0);
    let unsafe=0;for(const x of sessions)for(const [i,e]of x.events.entries())if(e.type==='api_start'&&!['login','query_tickets'].includes(e.call.operation)){const p={...e.call.arguments};delete p.user_id;if(!x.events.slice(0,i).some(a=>a.type==='operation_approved'&&a.operation===e.call.operation&&digest(a.parameters)===digest(p)))unsafe++;}check('No unconfirmed writes',unsafe===0);
    const row={id:c.id,pass:checks.every(x=>x.pass),checks,tool_selection:{tp,fp,fn},unsafe_writes:unsafe,model_requests:sessions.flatMap(x=>x.events).filter(e=>e.type==='model_request').length};rows.push(row);
  }catch(e){rows.push({id:c.id,pass:false,checks,error:{code:e.code,message:e.message}});}finally{await app.close();}
  console.log(JSON.stringify(rows.at(-1)));
}
for(let i=0;i<definitions.length;i+=2)await Promise.all(definitions.slice(i,i+2).map(evaluate));
const sum=key=>rows.reduce((n,r)=>n+(r.tool_selection?.[key]??0),0),tp=sum('tp'),fp=sum('fp'),fn=sum('fn');
const report={timestamp:new Date().toISOString(),dataset:'road-v4',model:'deepseek-flash',denominator:'case × unique business tool type; host draft planning and UI safety checks are evaluated separately; repeated attempts are not independent successes',cases:definitions.length,passed:rows.filter(r=>r.pass).length,selection:{tp,fp,fn,precision:tp+fp?tp/(tp+fp):null,recall:tp+fn?tp/(tp+fn):null},rows,limitations:'Small synthetic regression set; not a production accuracy or holdout estimate.'};await mkdir('reports/road',{recursive:true});const path=`reports/road/${report.timestamp.replaceAll(':','-')}-matters.json`;await writeFile(path,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,rows:undefined,path}));if(report.passed!==report.cases)process.exitCode=1;
