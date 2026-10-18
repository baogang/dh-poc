import { id,clone,digest,failure } from './store.mjs';
import {RoadAccounts,copyAccountToSession,recordChange} from './matters.mjs';

export const MOCK_API_NAMES=['login','create_ticket','query_tickets','close_ticket','complain_ticket','handoff_to_human'];
const terminal=new Set(['COMPLETED','RESOLVED','CLOSED','CANCELLED']);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function seedTickets(userId){
  return [
    {ticket_id:'T101',user_id:userId,topic:'ROAD_POTHOLE',description:'Pothole beside the school',address:{city:'Riyadh',street:'Test School Road',fullAddress:'Riyadh, Test School Road'},status:'IN_PROGRESS',created_at:'2026-09-29T09:00:00Z',decisionContext:{intentCode:'COMPLAINT_FOLLOW_UP',sentimentRisk:'FRUSTRATED',slaStatus:'EXCEEDED',repeatContact:true,decision:'HANDOFF_RECOMMENDED',reportedAgeDays:15,confidence:0.94,demoRule:true}},
    {ticket_id:'T102',user_id:userId,topic:'ROAD_POTHOLE',description:'Pothole outside the market',address:{city:'Riyadh',street:'Test Market Road',fullAddress:'Riyadh, Test Market Road'},status:'OPEN',created_at:'2026-10-12T09:00:00Z',decisionContext:{intentCode:'COMPLAINT_FOLLOW_UP',sentimentRisk:'NEUTRAL',slaStatus:'WITHIN_SLA',repeatContact:false,decision:'REVIEW_REQUIRED',reportedAgeDays:2,confidence:0.94,demoRule:true}},
    {ticket_id:'T103',user_id:userId,topic:'ROAD_POTHOLE',description:'Old road report',address:{city:'Riyadh',street:'Test Old Road',fullAddress:'Riyadh, Test Old Road'},status:'CLOSED',created_at:'2026-09-01T09:00:00Z',decisionContext:{decision:'NO_HANDOFF',demoRule:true}}
  ];
}

export class RoadMocks {
  constructor(store){this.store=store;this.accounts=new RoadAccounts(store);}
  async call(sid,operation,body,context={}){
    const s=this.store.get(sid);
    const conversation=operation==='handoff_to_human'&&body.scope==='conversation';
    if(!MOCK_API_NAMES.includes(operation))throw failure('UNKNOWN_API','Unknown mock API',404);
    // Credentials never enter the audit log or the model context.
    const safeBody=operation==='login'?{username:body.username}:clone(body);
    const call={id:id('call'),operation,arguments:safeBody,started_at:new Date().toISOString(),outcome:'running',epoch:context.epoch};s.mock.calls.push(call);
    this.store.emit(s,'api_start',{call:clone(call)});
    try{
      const fault=s.mock.faults[operation];
      if(fault?.delay_before_commit_ms)await wait(fault.delay_before_commit_ms);
      if(operation!=='login'){
        if((!conversation&&!s.user)||body.user_id!==s.user?.user_id)throw failure('IDENTITY_MISMATCH','Mock user identity mismatch',403);
        if(context.epoch!==undefined&&context.epoch!==s.epoch)throw failure('STALE_TURN','The request belongs to an interrupted turn',409);
      }
      if(fault?.failures>0){fault.failures--;throw failure('MOCK_UNAVAILABLE','Injected mock API failure',503);}
      const write=operation!=='login'&&operation!=='query_tickets';
      const key=context.idempotency_key;
      const fingerprint=digest([operation,body]);
      if(write&&!key)throw failure('IDEMPOTENCY_REQUIRED','A mutation needs an idempotency key');
      if(key&&s.mock.idempotency[key]){
        const previous=s.mock.idempotency[key];
        if(previous.fingerprint!==fingerprint)throw failure('IDEMPOTENCY_CONFLICT','Parameters changed for an existing idempotency key',409);
        call.replayed=true;return this.finish(s,call,previous.result);
      }
      let result;
      if(operation==='login'){
        if(!['demo','demo-no-address','demo-other'].includes(body.username)||body.password!=='demo')throw failure('INVALID_LOGIN','Use a fictional demo account',401);
        const user_id=body.username==='demo-other'?'U002':body.username==='demo-no-address'?'U003':'U001';
        const user={user_id,username:body.username,name:'Demo citizen',registeredAddress:body.username==='demo-no-address'?null:{city:'Riyadh',street:'Test Citizen Road',fullAddress:'Riyadh, Test Citizen Road'},source_type:'mock'};
        await this.accounts.update(user_id,a=>{if(!a.initialized){a.initialized=true;a.tickets=seedTickets(user_id);}copyAccountToSession(s,a);});s.user=user;s.facts.address=clone(user.registeredAddress);
        result={success:true,user:clone(s.user)};
      }else if(operation==='query_tickets'){
        await this.accounts.update(body.user_id,a=>{if(!a.initialized){a.initialized=true;a.tickets=clone(s.mock.tickets.length?s.mock.tickets:seedTickets(body.user_id));a.complaints=clone(s.mock.complaints);a.handoffs=clone(s.mock.handoffs.filter(h=>h.scope!=='conversation'));}copyAccountToSession(s,a);});
        const tickets=s.mock.tickets.filter(t=>t.user_id===body.user_id&&(!body.ticket_id||t.ticket_id===body.ticket_id));
        result={success:true,tickets:clone(tickets),handoffs:clone(s.mock.handoffs.filter(h=>tickets.some(t=>t.ticket_id===h.ticket_id))),complaints:clone(s.mock.complaints.filter(h=>tickets.some(t=>t.ticket_id===h.ticket_id))),source_type:'mock'};
      }else if(conversation){
        const action=body.action??'create';
        if(action==='create'){
          if(context.authorization!=='user_help_choice'||!s.pendingHelp||body.request_id!==s.pendingHelp.id)throw failure('POLICY_HANDOFF_REQUIRED','Conversation handoff requires a current trusted user choice',403);
          const previous=s.mock.handoffs.find(h=>h.scope==='conversation'&&!['COMPLETED','CANCELLED'].includes(h.status));
          const handoff=previous??{handoff_id:id('H'),scope:'conversation',conversation_id:s.id,status:'WAITING',reason:'user_requested_help',emotion:clone(s.emotion),conversation_summary:body.conversation_summary,queue_position:1,messages:[],created_at:new Date().toISOString()};
          if(!previous)s.mock.handoffs.push(handoff);s.activeHandoffId=handoff.handoff_id;result={success:true,handoff:clone(handoff),reused:!!previous,source_type:'mock'};
        }else{
          if(context.authorization!==(action==='cancel'?'user_help_choice':'human_simulator'))throw failure('HUMAN_SIMULATOR_REQUIRED','Use the mock human desk controls',403);
          const h=s.mock.handoffs.find(h=>h.handoff_id===body.handoff_id&&h.scope==='conversation');if(!h)throw failure('HANDOFF_NOT_FOUND','Conversation handoff not found',404);
          const next={accept:{from:['WAITING'],to:'ACCEPTED'},escalate:{from:['ACCEPTED'],to:'ESCALATED'},complete:{from:['ACCEPTED','ESCALATED'],to:'COMPLETED'},cancel:{from:['WAITING','ACCEPTED','ESCALATED'],to:'CANCELLED'}}[action];
          if(action==='accept'&&h.wait_deadline&&Date.parse(h.wait_deadline)<=Date.now())throw failure('HUMAN_WAIT_EXPIRED','The simulated queue wait limit elapsed',409);
          if(!next||!next.from.includes(h.status))throw failure('INVALID_HANDOFF_TRANSITION','Invalid simulated human transition',409);
          h.status=next.to;h.updated_at=new Date().toISOString();if(action==='accept')h.agent_name='Mock roads agent';result={success:true,handoff:clone(h),source_type:'mock'};
        }
      }else{
        result=await this.accounts.update(body.user_id,a=>{
          if(context.epoch!==undefined&&context.epoch!==s.epoch)throw failure('STALE_TURN','Turn interrupted before account commit',409);
          if(!a.initialized){a.initialized=true;a.tickets=clone(s.mock.tickets.length?s.mock.tickets:seedTickets(body.user_id));}
          const replay=a.idempotency[key];if(replay){if(replay.fingerprint!==fingerprint)throw failure('IDEMPOTENCY_CONFLICT','Parameters changed',409);call.replayed=true;copyAccountToSession(s,a);return replay.result;}
          if(context.draft_id){const d=a.drafts.find(d=>d.id===context.draft_id);if(!d||d.status!=='draft'||d.version!==context.draft_version||digest(d.parameters)!==digest({address:body.address,description:body.description}))throw failure('STALE_DRAFT','Draft changed or already submitted',409);}
          copyAccountToSession(s,a);let result;
          if(operation==='create_ticket'){
        if(!body.address?.city?.trim()||!body.address?.street?.trim()||!body.description?.trim())throw failure('MISSING_FIELDS','City, street and description are required');
        const ticket={ticket_id:id('T'),user_id:body.user_id,topic:'ROAD_POTHOLE',address:clone(body.address),description:body.description,status:'OPEN',created_at:new Date().toISOString(),decisionContext:{intentCode:'COMPLAINT_FOLLOW_UP',slaStatus:'WITHIN_SLA',repeatContact:false,decision:'REVIEW_REQUIRED',reportedAgeDays:0,confidence:0.94,demoRule:true}};
        s.mock.tickets.push(ticket);result={success:true,ticket:clone(ticket),source_type:'mock'};
      }else{
        const ticket=s.mock.tickets.find(t=>t.ticket_id===body.ticket_id&&t.user_id===body.user_id);
        if(!ticket)throw failure('TICKET_NOT_FOUND','No owned ticket with this ID',404);
        if(operation==='close_ticket'){
          const alreadyClosed=ticket.status==='CLOSED';ticket.status='CLOSED';result={success:true,ticket:clone(ticket),already_closed:alreadyClosed,source_type:'mock'};
        }else if(operation==='complain_ticket'){
          if(!body.reason?.trim())throw failure('MISSING_REASON','A complaint reason is required');
          const complaint={complaint_id:id('C'),ticket_id:ticket.ticket_id,reason:body.reason,status:'SUBMITTED',created_at:new Date().toISOString()};
          s.mock.complaints.push(complaint);result={success:true,complaint:clone(complaint),source_type:'mock'};
        }else{
          const action=body.action??'create';
          if(action==='create'){
            if(terminal.has(ticket.status))throw failure('INELIGIBLE_TICKET','A terminal ticket cannot be treated as unresolved',409);
            if(!body.reason?.trim()||!body.conversation_summary?.trim())throw failure('MISSING_HANDOFF_CONTEXT','Handoff reason and summary are required');
            const handoff={handoff_id:id('H'),ticket_id:ticket.ticket_id,status:'WAITING',reason:body.reason,conversation_summary:body.conversation_summary,decisionContext:clone(ticket.decisionContext),created_at:new Date().toISOString()};
            s.mock.handoffs.push(handoff);result={success:true,handoff:clone(handoff),source_type:'mock'};
          }else{
            const handoff=s.mock.handoffs.find(h=>h.handoff_id===body.handoff_id&&h.ticket_id===ticket.ticket_id);
            if(!handoff)throw failure('HANDOFF_NOT_FOUND','Handoff not found',404);
            const next={accept:['WAITING','ACCEPTED'],escalate:['ACCEPTED','ESCALATED'],complete:['ESCALATED','COMPLETED']}[action];
            if(!next||handoff.status!==next[0])throw failure('INVALID_HANDOFF_TRANSITION','Invalid simulated human transition',409);
            handoff.status=next[1];if(action==='accept')handoff.agent_name='Mock roads agent';result={success:true,handoff:clone(handoff),source_type:'mock'};
          }
        }
        }
          const ticketId=result.ticket?.ticket_id??result.complaint?.ticket_id??result.handoff?.ticket_id;
          const referenceId=result.ticket?.ticket_id??result.complaint?.complaint_id??result.handoff?.handoff_id;
          a.tickets=clone(s.mock.tickets);a.complaints=clone(s.mock.complaints);a.handoffs=clone(s.mock.handoffs.filter(h=>h.scope!=='conversation'));
          a.idempotency[key]={fingerprint,result:clone(result)};
          if(!result.already_closed)recordChange(a,{ticket_id:ticketId,kind:operation,status:result.ticket?.status??result.complaint?.status??result.handoff?.status,reference_id:referenceId});
          if(context.draft_id){const d=a.drafts.find(d=>d.id===context.draft_id);if(d){d.status='submitted';d.ticket_id=ticketId;d.updated_at=new Date().toISOString();}}
          return result;
        });
      }
      if(write)s.mock.idempotency[key]={fingerprint,result:clone(result)};
      if(fault?.drop_response_after_commit){fault.drop_response_after_commit=false;throw failure('RESPONSE_LOST','Mock committed, then dropped its response',503);}
      return this.finish(s,call,result);
    }catch(error){call.outcome='failed';call.error={code:error.code??'MOCK_ERROR',message:error.message};call.finished_at=new Date().toISOString();this.store.emit(s,'api_end',{call:clone(call)});await this.store.save(s);throw error;}
  }
  async finish(s,call,result){call.outcome='succeeded';call.result=clone(result);call.finished_at=new Date().toISOString();this.store.emit(s,'api_end',{call:clone(call)});await this.store.save(s);return clone(result);}
}
