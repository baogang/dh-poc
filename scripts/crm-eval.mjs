import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRoadServer} from '../src/road/server.mjs';
import {RoadStore} from '../src/road/store.mjs';
import {FeedbackRepository} from '../src/road/feedback.mjs';
import {scoreCrm,summarizeCrm} from '../src/crm/metrics.mjs';
import {CrmAgent} from '../src/crm/agent.mjs';
import {ensureCrm} from '../src/crm/simulation.mjs';
const args=process.argv.slice(2),option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const suite=option('--suite','all'),caseIds=option('--case','').split(',').filter(Boolean),limit=Number(option('--limit','1000')),concurrency=Number(option('--concurrency','3'));
if(!['tool','planning','all'].includes(suite)||!Number.isInteger(concurrency)||concurrency<1||concurrency>6)throw Error('Invalid suite or concurrency');
if(!process.env.DEEPSEEK_API_KEY)throw Error('Configure DEEPSEEK_API_KEY outside source code');
const cases=(await Promise.all(['tool','planning'].map(async name=>(await readFile(`datasets/balady-crm/${name}-cases.jsonl`,'utf8')).trim().split('\n').map(JSON.parse)))).flat().filter(c=>c.enabled&&(suite==='all'||suite===c.suite)&&(!caseIds.length||caseIds.includes(c.id))).slice(0,limit);
if(!cases.length)throw Error('No matching active CRM cases');
const started=new Date().toISOString(),runId=started.replaceAll(':','-'),directory=`reports/crm/${runId}`;await mkdir(directory,{recursive:true});
const runtimeFiles=(await Promise.all(['src/crm','src/road'].map(async directory=>(await readdir(directory)).filter(name=>name.endsWith('.mjs')).map(name=>directory+'/'+name)))).flat();
const sourceFiles=[...runtimeFiles,'scripts/crm-eval.mjs','src/web-access.mjs','package-lock.json','datasets/balady-crm/tool-cases.jsonl','datasets/balady-crm/planning-cases.jsonl'];
const hashes=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));
const config={run_id:runId,started_at:started,kind:'live-model-regression',fingerprint_scope_version:2,is_blind:false,provider:'deepseek',model:process.env.DEEPSEEK_MODEL??'deepseek-flash',api_backend:'local CRM simulation over documented HTTP paths',routing:'integration-test contract harness; isolated planner; emotion/FAQ and citizen policy evaluated separately',case_ids:cases.map(x=>x.id),concurrency,git_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),source_sha256:hashes};await writeFile(directory+'/config.json',JSON.stringify(config,null,2));
const app=await createRoadServer({agentFactory:options=>new CrmAgent({...options,audience:'integration-test'}),store:new RoadStore(),feedback:new FeedbackRepository({connectionString:null}),knowledge:{document:{name:'isolated planner evaluation'},entries:[]},config:{host:'127.0.0.1',port:10000,access:{}}});
await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});await app.ready();
const rows=[];let next=0;
async function runCase(reference){
  const session=app.store.create(),start=Date.now();ensureCrm(session);
  // Only synthetic backend state enters the test environment; references stay in
  // this evaluator and never enter the model prompt.
  session.crm.files['FILE-DEMO-SEED']={AttachName:'seed.txt',AttachmentStream:'SGVsbG8=',CaseID:'INC-26-10-000001'};
  session.crm.incidents.push({pyID:'REQ-26-10-000001',pzInsKey:'MOMRA-OPS-CS-WORK-MUNICIPALSERVICEREQUEST REQ-26-10-000001',pyStatusWork:'Open',MunicipalityID:'004',hasAttachments:false,history:[]},{pyID:'INQ-26-10-000001',pzInsKey:'MOMRA-OPS-CS-WORK INQ-26-10-000001',pyStatusWork:'Open',MunicipalityID:'004',hasAttachments:false,history:[]});
  let error,dialogueIndex=0;
  try{
    if(reference.login)await app.agent.login(session,{username:'demo',password:'demo'});
    await app.agent.chat(session,reference.message,{skipRouting:true});
    for(let turn=0;turn<16;turn++){
      if(session.pendingOperation&&reference.ui.approve_operations){await app.agent.approveOperation(session,session.pendingOperation.id);continue;}
      if(session.pendingInput?.kind==='login'&&reference.ui.login){await app.agent.login(session,{username:'demo',password:'demo'});await app.agent.answerInput(session,session.pendingInput.id,{});continue;}
      if(session.pendingInput&&reference.dialogue?.[dialogueIndex]){await app.agent.answerInput(session,session.pendingInput.id,{text:reference.dialogue[dialogueIndex++].text});continue;}
      break;
    }
  }catch(e){error={code:e.code??'EVAL_ERROR',message:e.message};}
  const score=scoreCrm(reference,session),modelRequests=session.events.filter(e=>e.type==='model_request').length;
  if(error)score.pass=false;
  const row={id:reference.id,suite:reference.suite,title:reference.title,score,error,duration_ms:Date.now()-start,model_requests:modelRequests,model_cost:session.events.filter(e=>e.type==='model_result').reduce((sum,e)=>sum+(e.usage?.cost?.total??0),0)};
  rows.push(row);await writeFile(directory+'/'+reference.id+'.json',JSON.stringify({reference,row,session},null,2));
  console.log(JSON.stringify({id:row.id,pass:score.pass,status:session.status,selection:score.selection,plan:score.plan,parameters:score.parameter_checks.filter(x=>!x.pass),dependencies:score.dependency_checks.filter(x=>!x.pass),clarifications:score.clarification_checks.filter(x=>!x.pass),error,duration_ms:row.duration_ms}));
  await writeFile(directory+'/partial.json',JSON.stringify({config,metrics:summarizeCrm(rows),rows},null,2));
}
try{await Promise.all(Array.from({length:Math.min(concurrency,cases.length)},async()=>{while(next<cases.length){const reference=cases[next++];await runCase(reference);}}));}
finally{await app.close();}
const endingHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')]))),sourceChanged=sourceFiles.filter(path=>endingHashes[path]!==hashes[path]);
const report={...config,source_changed_during_run:sourceChanged,completed_at:new Date().toISOString(),planned_cases:cases.length,metrics:summarizeCrm(rows),by_suite:Object.fromEntries(['tool','planning'].map(name=>[name,summarizeCrm(rows.filter(x=>x.suite===name))])),model_requests:rows.reduce((sum,r)=>sum+r.model_requests,0),model_cost:rows.reduce((sum,r)=>sum+r.model_cost,0),rows};
await writeFile(directory+'/summary.json',JSON.stringify(report,null,2));console.log(JSON.stringify({report:directory+'/summary.json',source_changed_during_run:sourceChanged,...report.metrics}));if(sourceChanged.length||rows.length!==cases.length||rows.some(r=>!r.score.pass))process.exitCode=1;
