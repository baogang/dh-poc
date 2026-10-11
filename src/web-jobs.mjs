import { mkdir,readdir,rename,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uid,now,readJSON,writeJSON } from './util.mjs';
import { runV2Evaluation,summarizeV2Cases } from './evaluate-v2.mjs';
import { SUITES } from './web-data.mjs';
const safe=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(id);
export async function atomicJSON(path,value){await writeJSON(path+'.tmp',value);await rename(path+'.tmp',path);}
export function validateRunRequest(request,store,models){
 const allowed=['suite','datasetId','split','caseIds','limit','concurrency','emotionModel','plannerModel','strategy','catalogCount','maxRequests','maxTokens','requestId'];
 if(!request||typeof request!=='object'||Array.isArray(request))throw new Error('运行配置需要对象');
 if(Object.keys(request).some(k=>!allowed.includes(k)))throw new Error('运行配置含未知字段');
 const r={split:'all',concurrency:2,strategy:'flat',catalogCount:16,maxRequests:1800,maxTokens:3000000,emotionModel:models.defaultEmotion,plannerModel:models.defaultPlanner,...request};
 if(!SUITES.includes(r.suite))throw new Error('无效模块');
 if(!['all','dev','regression','holdout'].includes(r.split))throw new Error('无效 split');
 for(const [k,min,max] of [['concurrency',1,8],['catalogCount',16,256],['maxRequests',1,10000],['maxTokens',10000,20000000]])if(!Number.isInteger(r[k])||r[k]<min||r[k]>max)throw new Error(k+' 超出范围');
 if(![16,32,64,128,256].includes(r.catalogCount)||!['flat','layered'].includes(r.strategy))throw new Error('无效目录规模 / 发现策略');
 if(!models.ids.includes(r.emotionModel)||!models.ids.includes(r.plannerModel))throw new Error('请选择当前 Pi 目录支持的 DeepSeek 模型');
 if(r.limit!==undefined&&(!Number.isInteger(r.limit)||r.limit<1||r.limit>5000))throw new Error('limit 需要 1–5000 整数');
 if(r.caseIds!==undefined&&(!Array.isArray(r.caseIds)||!r.caseIds.length||r.caseIds.some(id=>!safe(id))||new Set(r.caseIds).size!==r.caseIds.length))throw new Error('案例 ID 应唯一、非空');
 if(!safe(r.requestId))throw new Error('缺少有效 requestId');
 const dataset=store.select(r.datasetId,{suite:r.suite,split:r.split,limit:r.limit,caseIds:r.caseIds});
 return {request:r,dataset};
}
export class JobManager {
 constructor(store,models,{root='artifacts/web/jobs',runner=runV2Evaluation}={}){this.store=store;this.models=models;this.root=root;this.runner=runner;this.jobs=new Map();this.controllers=new Map();this.writes=new Map();this.closed=false;}
 async initialize(){await mkdir(this.root,{recursive:true});for(const e of await readdir(this.root)){if(!safe(e.replace(/\.json$/,''))||!e.endsWith('.json'))continue;const job=await readJSON(join(this.root,e));this.jobs.set(job.run_id,job);if(['queued','running','cancelling'].includes(job.status)){job.status='interrupted';job.progress.active_case_ids=[];job.finished_at=now();job.error={code:'SERVER_RESTART',message:'本地服务停止，原执行已中断；已保存案例保留，重新运行会创建新记录。'};await this.recover(job);await this.persist(job);}}}
 async recover(job,status=job.status){
  const dir=`reports/history/${job.run_id}`;try{
   const config=await readJSON(dir+'/config.json'),rows=[];for(const id of config.selected_case_ids){try{rows.push(await readJSON(dir+'/cases/'+id+'.json'));}catch{rows.push({case_id:id,execution_status:'unexecuted',grading:'unscored'});}}
   const summarize=config.analyzer_version==='emotion-v3.0.0'?summarizeV2Cases:(await import('../archive/v2.0.0/src/evaluate-v2.mjs')).summarizeV2Cases;
   const summary={run_id:job.run_id,suite:job.request.suite,status,finished_at:now(),...summarize(job.request.suite,rows),source_consistent:null,budget:job.progress?.budget??{},error:job.error};
   await writeJSON(dir+'/summary.json',summary);await writeJSON(dir+'/results.json',rows);await writeFile(dir+'/report.md',`# Interrupted / failed evaluation\n\nRun: ${job.run_id}. Status: ${status}. Partial results only; no complete regression conclusion.\n\n${JSON.stringify(summary,null,2)}\n`);job.summary=summary;
  }catch{}
 }
 persist(job){const path=join(this.root,job.run_id+'.json'),snapshot=structuredClone(job);const pending=(this.writes.get(job.run_id)??Promise.resolve()).then(()=>atomicJSON(path,snapshot));this.writes.set(job.run_id,pending.catch(()=>{}));return pending;}
 async start(payload){
  if(this.closed)throw new Error('服务正在停止');
  const {request,dataset}=validateRunRequest(payload,this.store,this.models);
  const duplicate=[...this.jobs.values()].find(j=>j.request.requestId===request.requestId);if(duplicate)return duplicate;
  if([...this.jobs.values()].some(j=>['queued','running','cancelling'].includes(j.status)))throw Object.assign(new Error('已有测试在运行，请等待完成或取消后再开始'),{status:409});
  if(request.suite!=='engineering'&&!process.env.DEEPSEEK_API_KEY)throw new Error('服务端 .env 尚未配置 DEEPSEEK_API_KEY');
  const run_id=now().replaceAll(/[:.]/g,'-')+'-web-'+uid('job').slice(-8);
  const job={run_id,status:'queued',created_at:now(),request,dataset:{id:dataset.id,name:dataset.name,version:dataset.version,hash:dataset.fingerprint},progress:{finished:0,total:dataset.selected.length,active_case_ids:[],budget:{}},case_ids:[]};this.jobs.set(run_id,job);await this.persist(job);
  const controller=new AbortController();this.controllers.set(run_id,controller);
  this.execute(job,dataset,controller).catch(error=>{console.error('Job persistence error:',error.code??'WRITE_FAILED');});return job;
 }
 async execute(job,dataset,controller){
  let terminal;
  try{
   job.status='running';await this.persist(job);
   const r=job.request;
   const result=await this.runner({...r,mode:r.suite==='engineering'?'offline':'live',dataset,runId:job.run_id,signal:controller.signal,quiet:true,
    onStart:async({config})=>{job.config=config;await this.persist(job);},
    onProgress:async p=>{job.progress=p;await this.persist(job);},
    onCase:async row=>{job.case_ids.push(row.case_id);await this.persist(job);}
   });
   job.summary=result.summary;terminal=result.summary.status==='cancelled'?'cancelled':'completed';
  }catch(error){terminal=controller.signal.aborted?'cancelled':'failed';job.error={code:error.code??'RUN_ERROR',message:error.message};await this.recover(job,terminal);}
  finally{const settled={...job,status:terminal,finished_at:now(),progress:{...job.progress,active_case_ids:[]}};await this.persist(settled);Object.assign(job,settled);this.controllers.delete(job.run_id);}
 }
 get(id){if(!safe(id))throw new Error('无效运行 ID');const job=this.jobs.get(id);if(!job)throw Object.assign(new Error('Web 任务不存在'),{status:404});return job;}
 async cancel(id){const job=this.get(id);if(!['queued','running','cancelling'].includes(job.status))return job;job.status='cancelling';job.cancel_requested_at=now();this.controllers.get(id)?.abort(Object.assign(new Error('用户取消'),{code:'CANCELLED'}));await this.persist(job);return job;}
 async shutdown(){this.closed=true;for(const [id,c] of this.controllers){c.abort(new Error('服务停止'));const job=this.jobs.get(id);job.status='cancelling';await this.persist(job);}const deadline=Date.now()+10000;while(this.controllers.size&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));}
 async history(){
  const items=[];for(const e of await readdir('reports/history',{withFileTypes:true})){if(!e.isDirectory()||!safe(e.name))continue;try{const config=await readJSON(`reports/history/${e.name}/config.json`);let summary;try{summary=await readJSON(`reports/history/${e.name}/summary.json`);}catch{}const job=this.jobs.get(e.name);items.push({run_id:e.name,status:job?.status??summary?.status??'interrupted',created_at:job?.created_at??config.started_at,finished_at:job?.finished_at??summary?.finished_at,suite:config.suite,model:config.model,dataset_version:config.dataset_version??'legacy-unspecified',dataset_name:config.dataset_name??config.dataset_version??'旧版数据',dataset_hash:config.dataset_hash,source_hash:config.source?.hash,selected:config.selected_case_ids?.length??config.limit??summary?.metrics?.cases,metrics:summary?.metrics??null,coverage:summary?.coverage,progress:job?.progress,legacy:config.analyzer_version!=='emotion-v3.0.0',error:job?.error});}catch{}}
  for(const job of this.jobs.values())if(!items.some(x=>x.run_id===job.run_id))items.push({run_id:job.run_id,status:job.status,created_at:job.created_at,suite:job.request.suite,model:job.request.suite==='emotion'?job.request.emotionModel:job.request.plannerModel,dataset_name:job.dataset.name,progress:job.progress,error:job.error});
  return items.sort((a,b)=>(b.created_at??b.run_id).localeCompare(a.created_at??a.run_id));
 }
 async detail(id){if(!safe(id))throw new Error('无效运行 ID');const job=this.jobs.get(id);let config,summary;try{config=await readJSON(`reports/history/${id}/config.json`);}catch{}try{summary=await readJSON(`reports/history/${id}/summary.json`);}catch{}if(!config&&!job)throw Object.assign(new Error('运行不存在'),{status:404});const ids=config?.selected_case_ids??job?.case_ids??[];const cases=[];for(const caseId of ids){if(!safe(caseId))continue;try{const row=await readJSON(`reports/history/${id}/cases/${caseId}.json`);cases.push({case_id:caseId,execution_status:row.execution_status??(row.error?'error':'completed'),grading:row.grading??(row.reference||row.score||row.pass!==undefined?'reference':'legacy'),pass:row.score?.pass??row.pass??null,duration_ms:row.duration_ms,error:row.error,prediction:row.prediction?{sentiment:row.prediction.sentiment,assessment_status:row.prediction.assessment_status}:null,result_status:row.result?.status??row.turns?.at(-1)?.result?.status});}catch{cases.push({case_id:caseId,execution_status:job?.progress?.active_case_ids?.includes(caseId)?'running':'unexecuted',grading:'unscored',pass:null});}}
  return {run_id:id,status:job?.status??summary?.status??'interrupted',request:job?.request,dataset:job?.dataset,config,summary,progress:job?.progress,error:job?.error,cases,can_rerun:!!(config?.analyzer_version==='emotion-v3.0.0'&&config?.dataset_id&&this.store.cache.has(config.dataset_id)&&(this.store.get(config.dataset_id).builtin||this.store.get(config.dataset_id).contract_version==='v3.0'))};
 }
 async case(id,caseId){if(!safe(id)||!safe(caseId))throw new Error('无效 ID');return readJSON(`reports/history/${id}/cases/${caseId}.json`);}
 async download(id,kind){if(!safe(id)||!['config.json','summary.json','results.json','report.md'].includes(kind))throw new Error('无效报告');return readFile(`reports/history/${id}/${kind}`);}
}
