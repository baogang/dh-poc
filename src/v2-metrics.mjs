import { SENTIMENTS,ASSESSMENT_STATUSES } from './contracts.mjs';
import { multilabel,scorePlanning } from './scoring.mjs';
import { canonical } from './util.mjs';
const ratio=(n,d)=>d?n/d:null;
const harmonic=(p,r)=>p===null||r===null?null:p+r?2*p*r/(p+r):0;

export const fullTaskContract=ref=>!!ref&&['allowed_statuses','required_clarification_fields','required_order','tool_arguments','assertions','turn_expectations'].every(k=>Array.isArray(ref[k]));
export function emotionMetrics(rows){
 const prediction=r=>r.valid===true?r.prediction:null;
 const expanded=rows.map(r=>({...r,prediction:{sentiment_array:prediction(r)?.assessment_status==='classified'?[prediction(r).sentiment]:[],status_array:prediction(r)?[prediction(r).assessment_status]:[]},reference:{sentiment_array:r.reference.assessment_status==='classified'?[r.reference.sentiment]:[],status_array:[r.reference.assessment_status]}}));
 const classified=rows.filter(r=>r.reference.assessment_status==='classified');
 const correct=classified.filter(r=>prediction(r)?.assessment_status==='classified'&&prediction(r).sentiment===r.reference.sentiment).length;
 const coreMatches=rows.filter(r=>prediction(r)&&prediction(r).sentiment===r.reference.sentiment&&prediction(r).assessment_status===r.reference.assessment_status).length;
 return {cases:rows.length,valid_rate:ratio(rows.filter(r=>r.valid).length,rows.length),initial_valid_rate:ratio(rows.filter(r=>r.initial_valid).length,rows.length),core_match:ratio(coreMatches,rows.length),core_matches:coreMatches,
 sentiment:{...multilabel(expanded,'sentiment_array',SENTIMENTS),accuracy:ratio(correct,classified.length),correct,classified_reference_cases:classified.length},
 assessment_status:multilabel(expanded,'status_array',ASSESSMENT_STATUSES),errors:rows.filter(r=>r.error).length,
 definition:'Core match=(sentiment + assessment_status correct)/all referenced cases. Sentiment Accuracy=correct classified pair/gold-classified cases; abstention or invalid output on gold-classified cases is a miss. Three-label Macro-F1 averages label F1 across all referenced cases, including false classification on gold clarification. Assessment-status metrics use all referenced cases. Diagnostic emotions and evidence semantic agreement are not scored.'};
}
export function scoreToolSelection(row,reference){
 const alternative=reference.acceptable_paths?.find(p=>p.allowed_statuses?.includes(row.result?.status));if(alternative)reference={...reference,...alternative};
 const required=reference.required_tools??[],allowed=new Set(reference.allowed_tools??required);
 const calls=row.trace?.filter(t=>t.type==='business')??[];
 const selected=[...new Set(calls.map(t=>t.tool))];
 const unexpected=[...new Set((row.trace??[]).filter(t=>t.type==='model').flatMap(t=>t.tool_calls??[]).map(t=>t.name).filter(n=>!['skill_read','catalog_search','submit_result'].includes(n)&&!selected.includes(n)))];
 const actual=[...selected,...unexpected];
 const groups=reference.required_tool_groups??[];
 const correct=actual.filter(t=>allowed.has(t)).length;
 const hit=required.filter(t=>selected.includes(t)).length+groups.filter(g=>g.some(t=>selected.includes(t))).length;
 const expected=required.length+groups.length;
 const precision=ratio(correct,actual.length),recall=ratio(hit,expected);
 return {correct_selected:correct,selected:actual.length,required_hit:hit,required:expected,precision,recall,f1:harmonic(precision,recall),
   actual_tools:actual,disallowed_tools:actual.filter(t=>!allowed.has(t)),missing_tools:required.filter(t=>!selected.includes(t)),
   task:reference.allowed_statuses?scorePlanning(row,reference):null,definition:'Per-case distinct tool-name selection: precision=allowed selected/all selected; recall=required selected/all required, including alternative groups. Arguments/resources/dependencies checked separately by task contract.'};
}
export function planningMetrics(rows){
 const sum=k=>rows.reduce((n,r)=>n+(r.tool_score?.[k]??0),0);
 const precision=ratio(sum('correct_selected'),sum('selected')),recall=ratio(sum('required_hit'),sum('required'));
 return {cases:rows.length,task_pass:rows.filter(r=>r.score?.pass).length,task_graded:rows.filter(r=>r.score).length,task_pass_rate:ratio(rows.filter(r=>r.score?.pass).length,rows.filter(r=>r.score).length),
 tool_selection:{correct_selected:sum('correct_selected'),selected:sum('selected'),required_hit:sum('required_hit'),required:sum('required'),precision,recall,f1:harmonic(precision,recall)},
 errors:rows.filter(r=>r.error).length,note:'Includes proposals and blocked attempts as selected tools; backend dispatch counts are separate. Planning-only uses no emotion module or routing decision.'};
}
