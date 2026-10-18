import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from '../src/road/store.mjs';
import {createHash} from 'node:crypto';
import {serviceById} from '../src/road/services.mjs';

export function auditKnowledge(document,original){
  const seen=new Set(),rows=document.entries.map(e=>{
    const raw=original.entries.find(x=>x.id===e.id),errors=[],warnings=[];
    if(seen.has(e.id))errors.push('duplicate_id');seen.add(e.id);
    if(!e.question?.trim()||!e.answer?.trim())errors.push('empty_content');
    if(!serviceById(e.source_scope))errors.push('unknown_service');
    if(/this service|this change|这个服务|该服务|هذه الخدمة/iu.test(e.question))errors.push('canonical_question_depends_on_context');
    if(!raw||raw.question!==e.original_question||raw.answer!==e.original_answer)errors.push('original_evidence_changed');
    const hash=createHash('sha256').update((e.original_question??'')+'\n'+(e.original_answer??'')).digest('hex');
    if(e.provenance?.raw_sha256!==hash)errors.push('source_hash_mismatch');
    if(!e.provenance?.official_url||!e.provenance?.policy_verified_at)warnings.push('official_policy_verification_pending');
    if(/currently|目前|حالياً/iu.test(e.answer)&&!e.provenance?.policy_verified_at)warnings.push('time_sensitive_answer_without_policy_date');
    if(document.entries.some(x=>x.id!==e.id&&x.question.toLowerCase()===e.question.toLowerCase()))errors.push('duplicate_canonical_question');
    return {id:e.id,service:e.source_scope,question:e.question,errors,warnings,changes:e.provenance?.changes??[]};
  });
  return {version:document.quality?.version,timestamp:new Date().toISOString(),source_hash:digest(original),cleaned_hash:digest(document),entries:rows.length,source_displayed_count:document.source_displayed_count,missing_source_entries:Math.max(0,document.source_displayed_count-rows.length),structural_errors:rows.reduce((n,r)=>n+r.errors.length,0),policy_verified_entries:rows.filter(r=>!r.warnings.includes('official_policy_verification_pending')).length,policy_status:'pending_official_verification',publication_scope:'poc_only',rows};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const read=name=>readFile(new URL('../src/knowledge/'+name,import.meta.url),'utf8').then(JSON.parse);
  const report=auditKnowledge(await read('road-faq.json'),await read('road-faq.original.json'));
  const i=process.argv.indexOf('--output');if(i>=0){await mkdir(dirname(process.argv[i+1]),{recursive:true});await writeFile(process.argv[i+1],JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report));if(report.structural_errors)process.exitCode=1;
}
