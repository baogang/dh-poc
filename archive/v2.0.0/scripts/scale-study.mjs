import { runEvaluation } from '../src/evaluate.mjs';
import { writeJSON,now } from '../src/util.mjs';
const results=[];
// Paired development cases exercise all four adapters. No tuning from holdout.
for(const catalogCount of [16,32,64,128,256])for(const strategy of ['flat','layered']){
 const run=await runEvaluation({suite:'planning',mode:'live',split:'dev',caseIds:['PLAN-02-1','PLAN-07-1','PLAN-10-1','PLAN-18-1'],concurrency:2,model:'deepseek-flash',datasetVersion:'v1.1',strategy,catalogCount,maxRequests:100,maxTokens:1500000});
 results.push({catalog_count:catalogCount,strategy,report:run.dir+'/report.md',summary:run.summary});
 await writeJSON('reports/scale-study.json',{updated_at:now(),case_count_per_cell:4,note:'Small paired technical scaling study. Extra tools are fictional distinct product/actions. Four fixed business Skills; this is not a Skill-count study or statistical production accuracy estimate.',results});
}
