import { parseArgs } from 'node:util';
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readJSON,readJSONL,writeJSON,hash,now,uid } from '../src/util.mjs';
import { sourceFingerprintV2,loadV2Suite } from '../src/evaluate-v2.mjs';
import { checkRegression } from './regression-policy.mjs';
const {values}=parseArgs({options:{suite:{type:'string',default:'all'},split:{type:'string',default:'regression'},'require-current-source':{type:'boolean',default:false},'max-age-ms':{type:'string',default:'3600000'}}});
try{
 const suites=values.suite==='all'?['emotion','planning','integration','engineering']:[values.suite];
 const index=await readJSONL('reports/history/index.jsonl'),current=values['require-current-source']?await sourceFingerprintV2():null,runs=[];
 for(const suite of suites){
  const item=[...index].reverse().find(r=>r.suite===suite&&r.split===values.split&&r.dataset_version==='v2.0');if(!item)throw new Error('No V2 matching report '+suite);
  const dir=dirname(item.report);const [config,summary,rows,dataset]=await Promise.all([readJSON(dir+'/config.json'),readJSON(dir+'/summary.json'),readJSON(dir+'/results.json'),loadV2Suite(suite,values.split)]);
  let result;
  if(suite==='integration'){
   const ids=rows.map(r=>r.case_id),expected=dataset.selected.map(r=>r.case_id),m=summary.metrics;
   const actualPass=rows.filter(r=>r.pass===true).length;
   const selected=config.selected_case_ids??[];
   result={checks:[{name:'integration_coverage',passed:expected.length>0&&ids.length===expected.length&&new Set(ids).size===expected.length&&expected.every(id=>ids.includes(id))&&selected.length===expected.length&&new Set(selected).size===expected.length&&expected.every(id=>selected.includes(id))&&m.cases===expected.length},
    {name:'source_consistent',passed:summary.source_consistent===true&&summary.source_end_hash===config.source.hash},
    {name:'run_finished',passed:summary.status==='finished'&&!rows.some(r=>r.error)},
    {name:'integration_task_pass_rate',passed:Number.isFinite(m.pass_rate)&&m.pass_rate>=.95&&m.pass_rate<=1&&m.pass===actualPass&&m.pass_rate===actualPass/expected.length,observed:m.pass_rate,required:'>= .95 exploratory; matches case results'},
    {name:'route_accuracy',passed:Number.isFinite(m.route_accuracy)&&m.route_accuracy>=.95&&m.route_accuracy<=1,observed:m.route_accuracy,required:'>= .95 exploratory'},
    {name:'negative_route_has_no_business_execution',passed:m.forbidden_business_dispatches===0&&m.forbidden_business_attempts===0,observed:{dispatches:m.forbidden_business_dispatches,attempts:m.forbidden_business_attempts},required:0}]};
  }else{
   const c=suite==='emotion'?{...config,suite:'semantic'}:config;
   const s=suite==='emotion'?{...summary,suite:'semantic'}:suite==='planning'?{...summary,metrics:{...summary.metrics,operation_selection:summary.metrics.tool_selection}}:summary;
   result=checkRegression({config:c,summary:s,rows,expectedIds:dataset.selected.map(r=>r.case_id)});
  }
  result.checks.push({name:'v2_run_contract',passed:config.dataset_version==='v2.0'&&config.suite===suite&&summary.suite===suite&&config.split===values.split&&config.release_digest===dataset.release_digest&&config.dataset_hash===dataset.fingerprint&&config.mode===(suite==='engineering'?'offline':'live')});
  const age=Date.now()-Date.parse(summary.finished_at);result.checks.push({name:'report_freshness',passed:Number.isFinite(age)&&age>=0&&age<=Number(values['max-age-ms']),observed:age});
  if(current)result.checks.push({name:'current_source',passed:current.hash===config.source.hash,observed:config.source.hash,required:current.hash});
  result.passed=result.checks.every(c=>c.passed);runs.push({suite,directory:dir,...result});
 }
 const files=['scripts/check-v2-regression.mjs','scripts/regression-policy.mjs','.github/workflows/regression.yml'];const artifacts=Object.fromEntries(await Promise.all(files.map(async p=>[p,hash(await readFile(p,'utf8'))])));
 const output=`reports/gates/${now().replaceAll(/[:.]/g,'-')}-${uid('v2gate').slice(-8)}.json`,report={created_at:now(),passed:runs.every(r=>r.passed),production_ready:false,gate_source:{files:artifacts,hash:hash(artifacts)},source_check_mode:current?'current_runtime':'historical_snapshot',runs};
 await writeJSON(output,report);console.log(JSON.stringify({passed:report.passed,report:output,runs:runs.map(r=>({suite:r.suite,passed:r.passed,failed_checks:r.checks.filter(c=>!c.passed)}))}));process.exitCode=report.passed?0:1;
}catch(error){console.error(JSON.stringify({passed:false,error:error.message}));process.exitCode=1;}
