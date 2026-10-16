const latest=records=>{const map=new Map();for(const row of records){if(!['satisfied','unsatisfied'].includes(row.rating))continue;const previous=map.get(row.feedback_id);if(!previous||row.version>=previous.version)map.set(row.feedback_id,row);}return [...map.values()];};
export function feedbackStats(records){const rows=latest(records);const satisfied=rows.filter(r=>r.rating==='satisfied').length;return {total:rows.length,satisfied,unsatisfied:rows.length-satisfied,rate:rows.length?Math.round(satisfied/rows.length*100):null};}
export function feedbackExport(records,format='jsonl'){
  const rows=latest(records).sort((a,b)=>a.created_at.localeCompare(b.created_at));
  if(format==='jsonl')return rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':'');
  if(format!=='csv')throw Error('Unsupported feedback export format');
  const columns=['feedback_id','version','rating','created_at','updated_at','session_id','answer_message_id','question','answer','route','faq_id','plan_id','model','app_revision','review_status'];
  const cell=value=>{let text=String(value??'');if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  return '\ufeff'+[columns,...rows.map(r=>{const s=r.snapshot??{};return [r.feedback_id,r.version,r.rating,r.created_at,r.updated_at,r.session_id,r.answer_message_id,s.question,s.answer,s.route,s.source?.id,s.plan?.id,s.model,s.app_revision,r.review_status??'unreviewed'];})].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
