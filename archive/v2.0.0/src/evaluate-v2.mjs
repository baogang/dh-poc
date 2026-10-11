import { mkdir,appendFile,readFile,readdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { analyzeEmotion,ANALYZER_VERSION } from './analyzer.mjs';
import { DeepSeekClient } from './model.mjs';
import { EntryAgent,PLANNER_VERSION } from './entry-agent.mjs';
import { MockClient } from './mock-client.mjs';
import { RoutedEntry,MockHandoffConnector,DEFAULT_ROUTING_POLICY } from './routing.mjs';
import { DEFAULT_REGISTRY } from './capability-registry.mjs';
import { Budget,readJSON,readJSONL,writeJSON,hash,now,uid } from './util.mjs';
import { emotionMetrics,planningMetrics,scoreToolSelection,fullTaskContract } from './v2-metrics.mjs';
import { prf } from './scoring.mjs';

export async function sourceFingerprintV2(){
 const files=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory()&&!p.includes('__pycache__'))await walk(p);else if(e.isFile())files.push(p);}}
 for(const dir of ['src','web','plugins','poc_mocks'])await walk(dir);files.push('package.json','package-lock.json');
 const items=await Promise.all(files.sort().map(async p=>[p,hash(await readFile(p,'utf8'))]));return {hash:hash(items),files:Object.fromEntries(items)};
}
export async function loadV2Suite(suite,split='all',limit,caseIds){
 if(!['emotion','planning','integration','engineering'].includes(suite))throw new Error('Unsupported V2 suite');
 const freeze=await readJSON('datasets/v2.0/freeze.json');
 for(const [path,expected] of Object.entries(freeze.files))if(hash(await readFile(path,'utf8'))!==expected)throw new Error('Frozen dataset hash mismatch '+path);
 const dir=`datasets/v2.0/${suite}`;
 const [inputs,refs,manifests]=await Promise.all(['inputs','references','manifest'].map(name=>readJSONL(`${dir}/${name}.jsonl`)));
 const ids=inputs.map(r=>r.case_id);if(new Set(ids).size!==ids.length||refs.length!==ids.length||manifests.length!==ids.length||new Set(refs.map(r=>r.case_id)).size!==ids.length||new Set(manifests.map(r=>r.case_id)).size!==ids.length)throw new Error('Dataset join/uniqueness invalid');
 const metadata=new Map(manifests.map(r=>[r.case_id,r])),references=new Map(refs.map(r=>[r.case_id,r.reference]));if(ids.some(id=>!metadata.has(id)||!references.has(id)))throw new Error('Dataset join missing');
 const selected=inputs.filter(r=>(split==='all'||metadata.get(r.case_id).split===split)&&(!caseIds||caseIds.includes(r.case_id))).slice(0,limit??inputs.length);
 if(!selected.length)throw new Error('No selected cases');
 return {selected,metadata,references,fingerprint:hash([inputs,refs,manifests]),release_digest:freeze.release_digest};
}
function integrationMetrics(rows){
 const turns=rows.flatMap(r=>r.route_scores??[]);let tp=0,fp=0,fn=0;
 for(const t of turns){if(t.actual==='human'&&t.expected==='human')tp++;else if(t.actual==='human')fp++;else if(t.expected==='human')fn++;}
 return {cases:rows.length,pass:rows.filter(r=>r.pass).length,pass_rate:rows.filter(r=>r.pass).length/rows.length,turns:turns.length,
 route_accuracy:turns.length?turns.filter(t=>t.actual===t.expected).length/turns.length:null,handoff_selection:prf(tp,fp,fn),
 forbidden_business_dispatches:turns.filter(t=>t.expected!=='agent').reduce((n,t)=>n+t.dispatches,0),
 forbidden_business_attempts:turns.filter(t=>t.expected!=='agent').reduce((n,t)=>n+t.attempts,0),errors:rows.filter(r=>r.error).length};
}
export function scoreV2Case(suite,row,ref,{builtin=true}={}){
 if(!ref||['cancelled','unexecuted'].includes(row.execution_status))return {...row,grading:'unscored'};
 row.reference=ref;row.grading='reference';
 if(suite==='planning'){
  const taskGraded=builtin||fullTaskContract(ref);
  row.tool_score=scoreToolSelection(row,taskGraded?ref:{...ref,allowed_statuses:undefined});if(!taskGraded)row.tool_score.task=null;row.score=row.tool_score.task;
  if(!taskGraded)row.grading='tools_only';
 }else if(suite==='integration'){
  row.route_scores=(row.turns??[]).map((turn,i)=>({actual:turn.route.action,expected:ref.expected_routes[i],emotion_match:turn.emotion.prediction?.sentiment===ref.expected_sentiments[i],dispatches:turn.business?.filter(t=>t.backend_invoked).length??0,attempts:turn.business?.length??0,tools_match:JSON.stringify([...new Set(turn.business?.map(t=>t.tool)??[])].sort())===JSON.stringify([...(ref.business_tools_by_turn[i]??[])].sort()),handoff_match:turn.route.action!=='human'||turn.handoff?.state===ref.handoff_state}));
  row.pass=!row.error&&row.route_scores.length===ref.expected_routes.length&&row.route_scores.every(t=>t.actual===t.expected&&t.tools_match&&t.handoff_match&&(t.expected==='agent'||t.dispatches===0));
 }else if(suite==='engineering')row.pass=!row.error&&(!ref.expected_error||row.observed_error===ref.expected_error)&&(!ref.expected_invariant||row.invariants?.[ref.expected_invariant]===true);
 return row;
}
export function summarizeV2Cases(suite,rows){
 const completed=rows.filter(r=>!['cancelled','unexecuted'].includes(r.execution_status));
 const graded=completed.filter(r=>r.reference);
 const metrics=graded.length?(suite==='emotion'?emotionMetrics(graded):suite==='planning'?planningMetrics(graded):suite==='integration'?integrationMetrics(graded):{cases:graded.length,pass:graded.filter(r=>r.pass).length,pass_rate:graded.filter(r=>r.pass).length/graded.length,errors:graded.filter(r=>r.error).length}):null;
 return {metrics,coverage:{selected:rows.length,completed:completed.length,graded:graded.length,unscored:completed.length-graded.length,task_graded:graded.filter(r=>r.score||typeof r.pass==='boolean'||suite==='emotion').length,cancelled:rows.filter(r=>r.execution_status==='cancelled').length,unexecuted:rows.filter(r=>r.execution_status==='unexecuted').length,errors:completed.filter(r=>r.error).length},metric_scope:completed.length<rows.length?'partial_completed_cases':graded.length<completed.length?'referenced_cases_only':'selected_cases'};
}
// Execution only sees input. References enter the scorer after the real call has settled.
export async function runV2Evaluation({suite='emotion',mode='live',split='all',limit,caseIds,concurrency=6,emotionModel=process.env.EMOTION_MODEL??process.env.DEEPSEEK_MODEL??'deepseek-flash',plannerModel=process.env.PLANNER_MODEL??process.env.DEEPSEEK_MODEL??'deepseek-flash',plannerProvider='deepseek',strategy='flat',catalogCount=16,maxRequests=1800,maxTokens=3000000,dataset:provided,runId,signal,onStart=async()=>{},onProgress=async()=>{},onCase=async()=>{},quiet=false}={}){
 if(mode!=='live'&&suite!=='engineering')throw new Error('Emotion/planning/integration require real live model calls');
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>16)throw new Error('Invalid concurrency');
 const dataset=provided??await loadV2Suite(suite,split,limit,caseIds),source=await sourceFingerprintV2(),budget=new Budget({maxRequests,maxTokens,deadlineMs:3600000});
 const run_id=runId??now().replaceAll(/[:.]/g,'-')+'-'+uid('v2').slice(-8);
 if(!/^[A-Za-z0-9_-]+$/.test(run_id))throw new Error('Invalid run ID');const dir=`reports/history/${run_id}`;
 const config={run_id,started_at:now(),suite,mode,split,limit:limit??null,concurrency,dataset_id:dataset.id??'builtin-'+suite,dataset_name:dataset.name??'V2 frozen '+suite,dataset_version:dataset.builtin===false?'import:'+dataset.id+'@'+dataset.version:dataset.version??'v2.0',dataset_hash:dataset.fingerprint,release_digest:dataset.release_digest,emotion_model:emotionModel,planner_model:plannerModel,planner_provider:plannerProvider,model:suite==='emotion'?emotionModel:plannerModel,max_requests:maxRequests,max_tokens:maxTokens,analyzer_version:ANALYZER_VERSION,planner_version:PLANNER_VERSION,policy_version:DEFAULT_ROUTING_POLICY.version,registry_hash:DEFAULT_REGISTRY.hash,strategy,catalog_count:catalogCount,source,selected_case_ids:dataset.selected.map(r=>r.case_id),module_isolation:suite==='emotion'?'no planner/tools':suite==='planning'?'no emotion analyzer or routing':'integrated or engineering',knowledge_base:false};
 await mkdir(dir+'/cases',{recursive:true});await writeJSON(dir+'/config.json',config);await onStart({dir,config});
 let mock,ticker,next=0,finished=0;const active=new Set(),rows=new Array(dataset.selected.length);
 const progress=()=>({finished,total:dataset.selected.length,active_case_ids:[...active],budget:budget.snapshot()});
 const notify=async()=>{await onProgress(progress());};
 try{
  signal?.throwIfAborted();
  const client=mode==='live'&&suite!=='planning'?new DeepSeekClient({model:emotionModel,budget}):null;
  if(suite!=='emotion'){mock=await MockClient.start();mock.signal=signal;signal?.throwIfAborted();}
  if(!quiet)console.log(JSON.stringify({run_id,suite,cases:dataset.selected.length,directory:dir}));
  ticker=setInterval(()=>{notify().catch(()=>{});},2000);ticker.unref();
  async function worker(){while(next<dataset.selected.length&&!signal?.aborted){
   const index=next++,item=dataset.selected[index],start=performance.now();active.add(item.case_id);await notify();
   let row={case_id:item.case_id,input:item.input,manifest:dataset.metadata.get(item.case_id)},case_id,agent,entry;
   try{
    signal?.throwIfAborted();
    if(suite==='emotion')row={...row,...await analyzeEmotion(client,item.input,{signal})};
    else if(suite==='planning'){
     case_id=await mock.createCase(item.input);agent=new EntryAgent({mock,case_id,actor:item.input.actor,budget,model:plannerModel,provider:plannerProvider,strategy,catalogCount});
     for(const turn of item.input.turns){signal?.throwIfAborted();await agent.turn(turn,{signal});}
     row={...row,...agent.snapshot(),oracle:await mock.snapshot(case_id)};
    }else if(suite==='integration'){
     case_id=await mock.createCase(item.input);entry=new RoutedEntry({emotionClient:client,plannerOptions:{mock,case_id,actor:item.input.actor,budget,model:plannerModel,provider:plannerProvider,strategy,catalogCount},handoff:new MockHandoffConnector({scenario:item.input.handoff_scenario})});
     const turns=[];for(const input of item.input.turns){signal?.throwIfAborted();const before=entry.planner?.trace.filter(t=>t.type==='business').length??0;const turn=await entry.handle(input,{signal});const business=(entry.planner?.trace.filter(t=>t.type==='business')??[]).slice(before);turns.push({...turn,business});}
     row={...row,...entry.snapshot(),turns,oracle:await mock.snapshot(case_id)};
    }else{const {runEngineering}=await import('./engineering.mjs');row={...row,...await runEngineering(mock,item.input)};}
    signal?.throwIfAborted();row.execution_status=row.error?'error':'completed';
   }catch(error){
    let oracle;if(case_id)try{oracle=await mock.control(`/cases/${case_id}/snapshot`,'GET',undefined,{ignoreAbort:true});}catch{}
    row={...row,...(agent?.snapshot()??{}),...(entry?.snapshot()??{}),execution_status:signal?.aborted?'cancelled':'error',error:{code:signal?.aborted?'CANCELLED':error.code??'RUN_ERROR',message:signal?.aborted?'Run cancelled; in-flight request aborted':error.message},...(oracle?{oracle}:{})};
   }finally{agent?.dispose();entry?.dispose();if(case_id)try{await mock.control(`/cases/${case_id}`,'DELETE',undefined,{ignoreAbort:true});}catch{}}
   row=scoreV2Case(suite,row,dataset.references.get(item.case_id),{builtin:provided?dataset.builtin:true});
   row.duration_ms=Math.round(performance.now()-start);await writeJSON(`${dir}/cases/${item.case_id}.json`,row);rows[index]=row;
   active.delete(item.case_id);finished++;await onCase(row);await notify();
   if(!quiet&&(finished%10===0||finished===rows.length))console.log(JSON.stringify({run_id,...progress()}));
  }}
  await Promise.all(Array.from({length:Math.min(concurrency,dataset.selected.length)},worker));
 }finally{clearInterval(ticker);mock?.stop();}
 for(let i=0;i<rows.length;i++)if(!rows[i]){const item=dataset.selected[i];rows[i]={case_id:item.case_id,input:item.input,manifest:dataset.metadata.get(item.case_id),execution_status:'unexecuted',grading:'unscored',duration_ms:0};await writeJSON(`${dir}/cases/${item.case_id}.json`,rows[i]);await onCase(rows[i]);}
 const end=await sourceFingerprintV2();const aggregate=summarizeV2Cases(suite,rows);
 const summary={run_id,suite,status:signal?.aborted?'cancelled':'finished',finished_at:now(),...aggregate,source_consistent:end.hash===source.hash,source_end_hash:end.hash,budget:budget.snapshot(),reference_status:dataset.reference_status??'provisional_synthetic'};
 await writeJSON(dir+'/results.json',rows);await writeJSON(dir+'/summary.json',summary);
 await writeFile(dir+'/report.md',`# V2 ${suite} evaluation\n\nRun: ${run_id}. Status: ${summary.status}. Selected cases: ${rows.length}. Dataset: ${config.dataset_name} (${config.dataset_version}). Emotion: ${emotionModel}. Planner: ${plannerProvider}/${plannerModel}.\n\n\`\`\`json\n${JSON.stringify({metrics:summary.metrics,coverage:summary.coverage,metric_scope:summary.metric_scope},null,2)}\n\`\`\`\n\nSource SHA256 ${source.hash}; consistent: ${summary.source_consistent}. Data SHA256 ${dataset.fingerprint}. Metrics only cover referenced, settled cases. Cancelled/unexecuted cases are not a complete regression pass. Input-only cases are unscored. Tool-only references do not establish full task correctness. Inputs, outputs, references and actual traces are retained in cases/ and results.json. Synthetic references require expert review; this is not validated production accuracy. Backend services and handoff are simulated.\n`);
 await appendFile('reports/history/index.jsonl',JSON.stringify({run_id,suite,mode,split,model:config.model,status:summary.status,dataset_version:config.dataset_version,source_hash:source.hash,report:dir+'/report.md',summary:summary.metrics})+'\n');
 if(!quiet)console.log(JSON.stringify({done:true,run_id,report:dir+'/report.md',metrics:summary.metrics,budget:summary.budget}));return {dir,summary,config};
}
