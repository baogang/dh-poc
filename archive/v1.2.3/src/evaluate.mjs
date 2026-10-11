import { mkdir,appendFile,readFile,readdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { analyze } from './analyzer.mjs';
import { DeepSeekClient } from './model.mjs';
import { EntryAgent } from './entry-agent.mjs';
import { MockClient } from './mock-client.mjs';
import { Budget,readJSONL,writeJSON,hash,mapLimit,now,uid } from './util.mjs';
import { scorePlanning,summarize } from './scoring.mjs';
export async function sourceFingerprint(){const files=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else files.push(p);}}for(const dir of ['src','plugins','poc_mocks'])await walk(dir);files.push('package-lock.json');const items=await Promise.all(files.filter(p=>!p.includes('__pycache__')).sort().map(async p=>[p,hash(await readFile(p,'utf8'))]));return {hash:hash(items),files:Object.fromEntries(items)};}
export async function loadSuite(suite,split='all',limit,datasetVersion='v1.2',caseIds){
 if(!['v1','v1.1','v1.2'].includes(datasetVersion))throw new Error('Dataset version must be v1 / v1.1 / v1.2');
 const dir=`datasets/${datasetVersion}/${suite}`;const [inputs,refs,manifests]=await Promise.all([readJSONL(dir+'/inputs.jsonl'),readJSONL(dir+'/references.jsonl'),readJSONL(dir+'/manifest.jsonl')]);
 const metadata=new Map(manifests.map(x=>[x.case_id,x])),references=new Map(refs.map(x=>[x.case_id,x.reference]));
 const selected=inputs.filter(x=>(split==='all'||split.split(',').includes(metadata.get(x.case_id).split))&&(!caseIds||caseIds.includes(x.case_id))).slice(0,limit??inputs.length);
 return {selected,metadata,references,fingerprint:hash([inputs,refs,manifests])};
}
export async function runEvaluation({suite='semantic',mode='live',split='all',limit,concurrency=6,model=process.env.DEEPSEEK_MODEL??'deepseek-flash',strategy='flat',catalogCount=16,maxRequests=1800,maxTokens=3000000,datasetVersion='v1.2',caseIds}={}){
 if(mode!=='live'&&suite!=='engineering')throw new Error('Offline mode is for engineering contracts only; no fabricated model quality results');
 const run_id=now().replaceAll(/[:.]/g,'-')+'-'+uid('run').slice(-8),dir=`reports/history/${run_id}`;
 const dataset=await loadSuite(suite,split,limit,datasetVersion,caseIds),budget=new Budget({maxRequests,maxTokens,deadlineMs:3600000});
 await mkdir(dir+'/cases',{recursive:true});
 const config={run_id,started_at:now(),suite,mode,split,limit:limit??null,concurrency,model,strategy,catalog_count:catalogCount,dataset_version:datasetVersion,dataset_hash:dataset.fingerprint,source:await sourceFingerprint(),budget:budget.snapshot(),selected_case_ids:dataset.selected.map(x=>x.case_id),synthetic_data:true,knowledge_base:false};await writeJSON(dir+'/config.json',config);
 let mock;if(suite!=='semantic')mock=await MockClient.start();
 const client=mode==='live'?new DeepSeekClient({model,budget}):null;
 console.log(JSON.stringify({run_id,directory:dir,cases:dataset.selected.length,suite,mode}));
 let last=0;
 const rows=await mapLimit(dataset.selected,concurrency,async item=>{
  const started=performance.now();let row={case_id:item.case_id,manifest:dataset.metadata.get(item.case_id)};
  try{
   if(suite==='semantic')row={...row,...await analyze(client,item.input)};
   else if(suite==='planning'){
    const case_id=await mock.createCase(item.input);const agent=new EntryAgent({mock,case_id,actor:item.input.actor,budget,model,strategy,catalogCount});
    const semantic=[];try{
     for(const turn of item.input.turns){const source={messages:[...agent.conversation,{id:`user-${agent.turns.length}`,role:'user',content:turn.message}],current_message_id:`user-${agent.turns.length}`};const a=await analyze(client,source);semantic.push(a);if(!a.valid)throw new Error('Ingress semantic contract failed');await agent.turn(turn,{analysis:a.prediction});}
     row={...row,...agent.snapshot(),semantic,oracle:await mock.snapshot(case_id)};
    }catch(error){row={...row,...agent.snapshot(),semantic,oracle:await mock.snapshot(case_id),error:{code:error.code??'RUN_ERROR',message:error.message}};
    }finally{agent.dispose();await mock.control(`/cases/${case_id}`,'DELETE');}
   }else{const {runEngineering}=await import('./engineering.mjs');row={...row,...await runEngineering(mock,item.input)};}
  }catch(error){row.error={code:error.code??'RUN_ERROR',message:error.message};row.pass=false;}
  row.duration_ms=Math.round(performance.now()-started);
  // References enter only after executor is finished. The model/agent never receives this object.
  const reference=dataset.references.get(item.case_id);if(suite==='semantic')row.reference=reference;
  if(suite==='planning'){row.score=scorePlanning(row,reference);const found=new Set(row.trace?.filter(t=>t.type==='discovery').flatMap(t=>t.candidates)??[]);row.discovery_recall=strategy==='layered'&&reference.required_tools.length?reference.required_tools.filter(t=>found.has(t)).length/reference.required_tools.length:null;}
  if(suite==='engineering')row.pass=!row.error&&(!reference.expected_error||row.observed_error===reference.expected_error)&&(!reference.expected_invariant||row.invariants?.[reference.expected_invariant]===true);
  await writeJSON(`${dir}/cases/${item.case_id}.json`,row);return row;
 },progress=>{if(Date.now()-last>15000||progress.finished===progress.total){last=Date.now();console.log(JSON.stringify({run_id,finished:progress.finished,total:progress.total,budget:budget.snapshot()}));}});
 mock?.stop();
 const source_end=await sourceFingerprint();const summary={run_id,finished_at:now(),...summarize(rows,suite),budget:budget.snapshot(),source_consistent:source_end.hash===config.source.hash,source_end_hash:source_end.hash,status:rows.length===dataset.selected.length?'finished':'incomplete'};
 await writeJSON(dir+'/results.json',rows);await writeJSON(dir+'/summary.json',summary);
 await writeFile(dir+'/report.md',renderReport(summary,config));
 await appendFile('reports/history/index.jsonl',JSON.stringify({run_id,suite,mode,split,model,source_hash:config.source.hash,dataset_hash:config.dataset_hash,report:dir+'/report.md',summary:summary.metrics})+'\n');
 console.log(JSON.stringify({done:true,run_id,report:dir+'/report.md',metrics:summary.metrics,budget:summary.budget}));return {dir,summary};
}
const pct=x=>x==null?'N/A':(100*x).toFixed(2)+'%';
function renderReport(summary,config){
 const m=summary.metrics;
 const stats=summary.suite==='semantic'?`| Metric | Result |\n|---|---:|\n| Initial schema/evidence validity | ${pct(m.initial_valid_rate)} |\n| Final validity after bounded repair | ${pct(m.valid_rate)} |\n| Sentiment macro F1 | ${pct(m.sentiment.macro_f1)} |\n| Emotion micro / macro F1 | ${pct(m.emotions.micro.f1)} / ${pct(m.emotions.macro_f1)} |\n| SA01–05 micro / macro F1 | ${pct(m.indicators.micro.f1)} / ${pct(m.indicators.macro_f1)} |\n| Intent micro / macro F1 | ${pct(m.intents.micro.f1)} / ${pct(m.intents.macro_f1)} |\n| All fields exact agreement | ${pct(m.all_fields_exact_match)} |`:summary.suite==='planning'?`Task pass: ${m.task_pass}/${m.cases} (${pct(m.task_pass_rate)}). Operation selection P/R/F1: ${pct(m.operation_selection.precision)} / ${pct(m.operation_selection.recall)} / ${pct(m.operation_selection.f1)}.`:`Engineering contracts passed: ${m.pass}/${m.cases} (${pct(m.pass_rate)}). This is deterministic contract testing, not model accuracy.`;
 return `# POC V1 ${summary.suite} evaluation\n\nRun: ${summary.run_id}. Requested model: ${config.model}. Mode: ${config.mode}. Split: ${config.split}. Cases: ${m.cases}.\n\n${stats}\n\nLatency P50/P95: ${summary.latency_ms.p50}/${summary.latency_ms.p95} ms. Requests: ${summary.budget.requests}; tokens: ${summary.budget.tokens}.\n\nSource SHA256: ${config.source.hash}. Dataset SHA256: ${config.dataset_hash}. Detailed case traces and actual backend oracle snapshots are preserved beside this report.\n\n## Interpretation\n\nSemantic and planning references are synthetic provisional labels authored for this POC. These numbers measure agreement with that reference, not validated production accuracy. Exact evidence quotes only verify span existence; their semantic support still needs independent language review. Operation selection aggregates required/forbidden operation presence; task completion additionally checks arguments, dependencies, multi-turn state and backend assertions. Free-text business claims require independent review. FURAS is a scripted protocol mock. Idempotency and conversation state are in memory. No actual human transfer occurs.\n\nThe model has no access to reference files, oracle state, fixture patches or host credentials. Candidate-family splits do not guarantee template-independent generalization. Holdout results must not be used to tune subsequent versions; an inspected holdout becomes an evaluation set and new independent cases are needed for future production decisions.\n\n## Split details\n\n\`\`\`json\n${JSON.stringify(summary.by_split,null,2)}\n\`\`\`\n`;
}
