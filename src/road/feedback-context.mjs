import {clone,digest} from './store.mjs';

// Capture only answer evidence, never credentials, transport headers or authorizations.
const clean=text=>String(text??'').replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi,'[database credential redacted]').replace(/\bBearer\s+[\w.\-]+/gi,'Bearer [redacted]').replace(/((?:password|api[_-]?key|token|secret|密码)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]');
const publicMessage=m=>({id:m.id,role:m.role,kind:m.kind??'chat',text:clean(m.text),time:m.time});
export function captureAnswer(s,answer,{questionId,turnSeq,planId=null,promptHash,faqVersion,model=process.env.DEEPSEEK_MODEL??'deepseek-flash'}={}){
  const question=s.messages.find(m=>m.id===questionId&&m.role==='user');
  if(!question||!['faq','result','error'].includes(answer.kind))return;
  const plan=answer.kind!=='faq'?s.plans.find(p=>p.id===planId):null;
  const before=s.messages.slice(0,s.messages.findIndex(m=>m.id===answer.id));
  const context=before.filter(m=>['user','assistant'].includes(m.role)&&(!m.kind||['faq','result','input','decision'].includes(m.kind)));
  const receipts=s.receipts.filter(r=>r.operation!=='login'&&(answer.receipt_ids??[]).includes(r.id));
  const snapshot={schema_version:1,session_id:s.id,answer_message_id:answer.id,question_message_id:question.id,trigger_message_id:before.findLast(m=>m.role==='user')?.id??question.id,turn_start_seq:turnSeq??null,question:clean(question.text),answer:clean(answer.text),answer_kind:answer.kind,answer_created_at:answer.time,route:answer.kind==='faq'?'faq':answer.kind==='error'?'error':'loop',status:s.status,context:context.slice(-20).map(publicMessage),context_truncated:context.length>20,source:answer.source?clone(answer.source):null,plan:plan?{id:plan.id,version:plan.version,goal:clean(plan.goal),steps:plan.steps.map(x=>({id:x.id,capability:x.capability,title:clean(x.title),status:x.status,error_code:x.error?.code??null}))}:null,tool_results:receipts.map(r=>({receipt_id:r.id,operation:r.operation,success:r.result?.success!==false,ticket_id:r.result?.ticket?.ticket_id??null,status:r.result?.ticket?.status??r.result?.handoff?.status??r.result?.complaint?.status??null})),emotion:s.emotion?{status:s.emotion.status,sentiment:s.emotion.sentiment??null,message_id:s.emotion.message_id??null}:null,model,pi_sdk_version:'1.1.0',prompt_hash:promptHash??null,faq_version:faqVersion??null,app_revision:process.env.RENDER_GIT_COMMIT??process.env.ROAD_APP_REVISION??'local',review_status:'unreviewed'};
  const turnEvents=s.events.slice(Math.max(0,(turnSeq??1)-1));
  snapshot.tool_calls=turnEvents.filter(e=>e.type==='tool_end'&&['query_tickets','create_ticket','close_ticket','complain_ticket','handoff_to_human'].includes(e.name)).map(e=>({call_id:e.call_id,name:e.name,error_code:e.result?.error??null}));
  snapshot.model_calls=turnEvents.filter(e=>e.type==='model_result').map(e=>({usage:clone(e.usage??{}),stop_reason:e.stop_reason}));
  snapshot.content_hash=digest(snapshot);
  (s.answerSnapshots??={})[answer.id]=snapshot;
  return snapshot;
}
