import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scoreRoadTools,summarizeRoadTools} from '../src/road/eval-metrics.mjs';

const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: node scripts/road-rescore.mjs original-report.json rescored-report.json');
const raw=JSON.parse(await readFile(input,'utf8'));
if(raw.rows.length!==raw.cases)throw Error('Incomplete original report: cannot silently exclude missing cases');
const identities=raw.rows.map(r=>`${r.case_id}:${r.repeat??1}`);
if(new Set(identities).size!==identities.length)throw Error('Duplicate original case/repeat');
const source=await readFile(new URL('../datasets/road-v1/cases.jsonl',import.meta.url),'utf8');
const refs=source.trim().split('\n').map(JSON.parse);
const cases=raw.rows.map(row=>{
  const ref=refs.find(c=>c.id===row.case_id);if(!ref)throw Error('Missing reference: '+row.case_id);
  return {case_id:row.case_id,repeat:row.repeat??1,reference:ref,metrics:scoreRoadTools(ref,row),original_case_pass:row.pass};
});
const metrics=summarizeRoadTools(cases.map(c=>c.metrics));
const perTool={};for(const c of cases)for(const phase of c.metrics.phases)for(const tool of new Set([...phase.required,...phase.observed])){
  const item=perTool[tool]??={required:0,matched:0,unexpected:0,missed:0};
  item.required+=Number(phase.required.includes(tool));item.matched+=Number(phase.matched.includes(tool));item.unexpected+=Number(phase.unexpected.includes(tool));item.missed+=Number(phase.missing.includes(tool));
}
for(const item of Object.values(perTool)){item.precision=item.matched+item.unexpected?item.matched/(item.matched+item.unexpected):null;item.recall=item.required?item.matched/item.required:null;}
const report={rescored_at:new Date().toISOString(),original_model_run_at:raw.timestamp,source:input,rescoring_only:true,new_model_requests:0,reference_revision:'Intent-switch case now separates legitimate creation proposal before interruption from query-only intent afterward.',reference_sha256:createHash('sha256').update(source).digest('hex'),legacy_metrics:raw.metrics,tool_metrics:metrics,per_tool:perTool,cases,limitations:['Synthetic developer regression set, not unseen holdout.','Business tool-type selection, parameter correctness and successful execution are separate metrics.','Type-level recall does not separately score multiple resources using the same tool.']};
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,tool_metrics:metrics,per_tool:perTool},null,2));
