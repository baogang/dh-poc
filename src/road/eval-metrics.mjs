// Scoring unit: one (case, dialogue phase, business tool type). Repeated HITL
// proposals, confirmations and retries do not create additional requirements.
export const BUSINESS_TOOLS=new Set(['query_tickets','create_ticket','close_ticket','complain_ticket','handoff_to_human']);
const ratio=(a,b)=>b?a/b:null;
const counts=(tp,fp,fn)=>({tp,fp,fn,precision:ratio(tp,tp+fp),recall:ratio(tp,tp+fn),f1:ratio(2*tp,2*tp+fp+fn)});

export function scoreRoadTools(reference,row,{includeHostPolicy=false}={}){
  const expected=reference.expected.operations;
  const explicit=reference.expected.tool_phases;
  const events=row?.session?.events??[];
  let phases;
  if(explicit){
    if(!reference.interrupt?.message||explicit.length!==2||explicit[0].phase!=='before_interrupt'||explicit[1].phase!=='after_interrupt')throw Error('Tool phases need explicit before/after interrupt references');
    const boundary=events.findIndex(e=>e.type==='message'&&e.message?.role==='user'&&e.message.text===reference.interrupt.message);
    phases=[{...explicit[0],events:boundary<0?events:events.slice(0,boundary)},{...explicit[1],events:boundary<0?[]:events.slice(boundary)}];
  }else phases=[{phase:'whole_case',operations:expected,events}];
  let tp=0,fp=0,fn=0,attempts=0,correctAttempts=0;
  const details=phases.map(p=>{
    const required=new Set(p.operations);
    if([...required].some(t=>!BUSINESS_TOOLS.has(t)))throw Error('Unknown required business tool');
    const calls=p.events.flatMap(e=>e.type==='tool_start'&&BUSINESS_TOOLS.has(e.name)?[e]:includeHostPolicy&&['policy_handoff_authorized','user_handoff_authorized'].includes(e.type)?[{name:'handoff_to_human',source:e.type==='user_handoff_authorized'?'user_choice':'host_policy'}]:[]);
    const seen=new Set(calls.map(e=>e.name));
    const matched=[...required].filter(t=>seen.has(t)),missing=[...required].filter(t=>!seen.has(t)),unexpected=[...seen].filter(t=>!required.has(t));
    tp+=matched.length;fp+=unexpected.length;fn+=missing.length;attempts+=calls.length;correctAttempts+=calls.filter(e=>required.has(e.name)).length;
    return {phase:p.phase,required:[...required],observed:[...seen],matched,missing,unexpected};
  });
  const actual=new Set(row?.operations??[]),required=new Set(expected);
  const execution=counts([...required].filter(t=>actual.has(t)).length,[...actual].filter(t=>!required.has(t)).length,[...required].filter(t=>!actual.has(t)).length);
  return {unit:'case + dialogue phase + business tool type',selection:counts(tp,fp,fn),attempts:{total:attempts,correct:correctAttempts,precision:ratio(correctAttempts,attempts)},execution:{unit:'case + final required business tool type with successful receipt',...execution},phases:details};
}

export function summarizeRoadTools(scores){
  const sum=fn=>scores.reduce((n,s)=>n+fn(s),0);
  return {unit:'case + dialogue phase + business tool type',selection:counts(sum(s=>s.selection.tp),sum(s=>s.selection.fp),sum(s=>s.selection.fn)),attempts:{total:sum(s=>s.attempts.total),correct:sum(s=>s.attempts.correct),precision:ratio(sum(s=>s.attempts.correct),sum(s=>s.attempts.total))},execution:{unit:'case + final required business tool type with successful receipt',...counts(sum(s=>s.execution.tp),sum(s=>s.execution.fp),sum(s=>s.execution.fn))}};
}
