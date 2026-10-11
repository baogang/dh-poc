export const SCORER_VERSION='scorer-v3.0.0';
const divide=(a,b)=>b?a/b:null;
export function prf(tp,fp,fn){const precision=divide(tp,tp+fp),recall=divide(tp,tp+fn);return {tp,fp,fn,precision,recall,f1:tp+fp+fn?2*tp/(2*tp+fp+fn):null};}
export function multilabel(rows,key,labels){
 const per_label={};
 for(const label of labels){let tp=0,fp=0,fn=0;for(const r of rows){const actual=new Set(r.prediction?.[key]??[]),expected=new Set(r.reference[key]);if(actual.has(label)&&expected.has(label))tp++;else if(actual.has(label))fp++;else if(expected.has(label))fn++;}per_label[label]={...prf(tp,fp,fn),support:rows.filter(r=>r.reference[key].includes(label)).length};}
 const entries=Object.values(per_label),sum=field=>entries.reduce((s,x)=>s+x[field],0);
 const f1s=entries.map(x=>x.f1).filter(x=>x!==null);
 return {micro:prf(sum('tp'),sum('fp'),sum('fn')),macro_f1:f1s.length?f1s.reduce((s,x)=>s+x,0)/f1s.length:null,per_label};
}
function at(root,path){return path.split('.').reduce((v,k)=>v?.[k],root);}
export function contains(actual,expected){if(expected&&typeof expected==='object')return Object.entries(expected).every(([k,v])=>contains(actual?.[k],v));return actual===expected;}
export function scorePlanning(row,reference){
 const alternative=reference.acceptable_paths?.find(p=>p.allowed_statuses?.includes(row.result?.status));if(alternative)reference={...reference,...alternative};
 const calls=row.trace?.filter(t=>t.type==='business')??[],tools=[...new Set(calls.map(c=>c.tool))];
 const required=reference.required_tools??[],allowed=reference.allowed_tools??required;
 const missing=required.filter(t=>!tools.includes(t)),forbidden=tools.filter(t=>!allowed.includes(t));
 const failures=[...missing.map(t=>'missing tool '+t),...forbidden.map(t=>'disallowed tool '+t)];
 let groupTP=0,groupFN=0;for(const group of reference.required_tool_groups??[]){if(group.some(t=>tools.includes(t)))groupTP++;else{groupFN++;failures.push('missing alternative path '+group.join('|'));}}
 const final=row.result;
 if(!reference.allowed_statuses.includes(final?.status))failures.push('status '+final?.status);
 for(const field of reference.required_clarification_fields??[])if(!final?.missing_fields.includes(field))failures.push('missing clarification '+field);
 for(const arg of reference.tool_arguments??[])if(!calls.some(c=>c.tool===arg.tool&&contains(c.arguments,arg.contains)))failures.push('wrong arguments '+arg.tool);
 for(const [before,after] of reference.required_order??[]){const a=calls.findIndex(c=>c.tool===before),b=calls.findIndex(c=>c.tool===after);if(a<0||b<0||a>=b)failures.push(`dependency ${before} before ${after}`);}
 for(const assertion of reference.assertions??[]){const v=at(row,assertion.path),length=Array.isArray(v)?v.length:v&&typeof v==='object'?Object.keys(v).length:undefined;const pass=assertion.operator==='eq'?contains(v,assertion.value):assertion.operator==='length'?length===assertion.value:false;if(!pass)failures.push('oracle assertion '+assertion.path);}
 if(reference.tasks_count!==undefined&&Object.keys(row.oracle?.tasks??{}).length!==reference.tasks_count)failures.push('duplicate or missing remote task');
 for(const [status,n] of Object.entries(reference.task_status_counts??{}))if(Object.values(row.oracle?.tasks??{}).filter(t=>t.status===status).length!==n)failures.push('task status count '+status);
 for(let i=0;i<(reference.turn_expectations??[]).length;i++){
  const expected=reference.turn_expectations[i],turn=row.turns?.[i];
  if(expected.status&&turn?.result.status!==expected.status)failures.push(`turn ${i+1} status`);
  for(const t of expected.required_tools??[])if(!calls.some(c=>c.turn===i&&c.tool===t))failures.push(`turn ${i+1} missing ${t}`);
  for(const field of expected.required_clarification_fields??[])if(!turn?.result.missing_fields.includes(field))failures.push(`turn ${i+1} clarification ${field}`);
 }
 const unsupported=(final?.receipt_ids??[]).filter(id=>!row.receipts?.[id]);
 if(unsupported.length)failures.push('fabricated receipt');
 const signature=c=>JSON.stringify([c.tool,c.arguments]);const uniqueArgs=new Set(calls.map(signature));
 const initialRejected=row.trace?.filter(t=>t.type==='final_validation'&&t.errors.length)??[];
 if(final?.status==='completed')for(const requiredTool of required){const relevant=calls.filter(c=>c.tool===requiredTool);if(!relevant.some(c=>c.result?.ok))failures.push('completed but no successful '+requiredTool);}
 return {pass:failures.length===0,failures,selection:prf(required.length-missing.length+groupTP,forbidden.length,missing.length+groupFN),tools,attempts:calls.length,proposals:calls.filter(c=>c.phase==='proposal'||c.result?.status==='needs_confirmation').length,backend_dispatches:calls.filter(c=>c.backend_invoked||Number.isFinite(c.result?.http_status)).length,host_guards:calls.filter(c=>c.phase==='host_guard').length,repeated_identical_calls:calls.length-uniqueArgs.size,initial_final_rejections:initialRejected.length,initial_completion_rejections:initialRejected.filter(t=>t.errors.some(e=>/Completed|completed|unresolved|unconfirmed|Goal intent|Goal resource/.test(e))).length,forbidden_claims_require_independent_review:reference.forbidden_claims??[],receipt_integrity:!unsupported.length};
}
export function aggregatePlanning(rows){let tp=0,fp=0,fn=0;for(const r of rows){const s=r.score?.selection;if(s){tp+=s.tp;fp+=s.fp;fn+=s.fn;}}return {cases:rows.length,task_pass:rows.filter(r=>r.score?.pass).length,task_pass_rate:divide(rows.filter(r=>r.score?.pass).length,rows.length),operation_selection:prf(tp,fp,fn),cases_with_rejected_completion_candidate:rows.filter(r=>r.score?.initial_completion_rejections>0).length,completion_response_path:'Host renders observable receipt facts; model draft kept only for review',note:'Operation presence and allowlist P/R; task pass also checks arguments, dependencies, multi-turn statuses and backend oracle. Free-text draft forbidden claims need independent review.',errors:rows.filter(r=>r.error).length};}
export function wilson(success,total){if(!total)return null;const z=1.96,p=success/total,d=1+z*z/total,c=(p+z*z/(2*total))/d,h=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d;return [c-h,c+h];}
