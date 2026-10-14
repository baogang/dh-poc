import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { RoadStore,digest } from '../src/road/store.mjs';
import { createRoadServer } from '../src/road/server.mjs';

const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const split=option('--split','smoke'),caseId=option('--case',null),repeats=Number(option('--repeat','1'));
if(!Number.isInteger(repeats)||repeats<1||repeats>10)throw Error('--repeat must be 1–10');
const cases=(await readFile(new URL('../datasets/road-v1/cases.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse).filter(c=>caseId?c.id===caseId:split==='all'||c.split===split);
if(!cases.length)throw Error('No matching cases');
const app=await createRoadServer({store:new RoadStore(),config:{port:10000,host:'127.0.0.1',access:{}}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();
const rows=[];
async function runCase(c,repeat){
  const s=app.store.create(),agent=app.agent,started=Date.now(),checks=[];let interrupted=false,simulationError;
  try{
    if(c.login)await agent.login(s,{username:c.login,password:'demo'});s.mock.faults=structuredClone(c.faults??{});
    // Expected labels remain in the evaluator. Only conversation, fixtures and UI input reach PI.
    await agent.chat(s,c.message);
    for(let turn=0;turn<12;turn++){
      const p=agent.active(s);
      if(p?.status==='review'){await agent.approvePlan(s,p.id);continue;}
      if(s.pendingInput){
        const x=s.pendingInput;let value;
        if(x.kind==='ticket'){if(c.ui?.matched===false)break;value={ticket_id:c.ui?.ticket_id??x.candidates[0]?.ticket_id,matched:c.ui?.matched??true,unresolved:c.ui?.unresolved??false};}
        else if(x.kind==='address')value=c.ui?.address??{city:'Riyadh',street:'Test Cedar Road'};
        else if(x.kind==='login'){if(!s.user)await agent.login(s,{username:c.login??'demo',password:'demo'});value={};}
        else value={text:c.ui?.text??'Please perform only the action I explicitly requested.'};
        await agent.answerInput(s,x.id,value);continue;
      }
      if(s.pendingOperation){
        if(c.interrupt&&!interrupted){
          interrupted=true;const old=s.pendingOperation.id;await agent.chat(s,c.interrupt.message);
          if(c.interrupt.kind==='faq')checks.push({name:'FAQ preserves pending proposal',pass:s.pendingOperation?.id===old});
          else{let rejected=false;try{await agent.approveOperation(s,old);}catch(e){rejected=e.code==='STALE_CONFIRMATION';}checks.push({name:'Intent switch revokes old confirmation',pass:rejected});}
          continue;
        }
        if(c.approve_operations===false)break;
        await agent.approveOperation(s,s.pendingOperation.id);continue;
      }
      break;
    }
  }catch(e){simulationError={code:e.code??'EVAL_ERROR',message:e.message};}
  const expected=c.expected,faqHits=s.events.filter(e=>e.type==='faq_hit'),route=faqHits.length&&!s.plans.length?'faq':'loop';
  const attempts=s.events.filter(e=>e.type==='tool_start'&&['query_tickets','create_ticket','close_ticket','complain_ticket','handoff_to_human'].includes(e.name));
  const operations=[...new Set(s.receipts.map(r=>r.operation))],finalPlan=agent.active(s),caps=[...new Set(finalPlan?.steps.map(x=>x.capability)??[])];
  checks.push({name:'Expected FAQ/Loop route',pass:route===expected.route});
  if(expected.faq_id)checks.push({name:'Correct FAQ source',pass:faqHits.some(e=>e.entry_id===expected.faq_id)});
  if(expected.forbidden_faq_id)checks.push({name:'No wrong-scope FAQ answer',pass:!faqHits.some(e=>e.entry_id===expected.forbidden_faq_id)});
  const coverage=(expected.capabilities??[]).filter(x=>caps.includes(x)).length;
  checks.push({name:'Required plan capabilities',pass:coverage===(expected.capabilities??[]).length});
  checks.push({name:'Required API receipts',pass:expected.operations.every(x=>operations.includes(x))});
  checks.push({name:'Forbidden API writes absent',pass:!(expected.forbidden_operations??[]).some(op=>s.mock.calls.some(x=>x.operation===op))});
  if(expected.status)checks.push({name:'Expected final status',pass:s.status===expected.status});
  if(expected.ticket_id)checks.push({name:'Correct mutation ticket',pass:s.receipts.filter(r=>r.operation!=='query_tickets').every(r=>r.parameters.ticket_id===expected.ticket_id)});
  if(expected.address)checks.push({name:'Preserved supplied address',pass:s.receipts.some(r=>r.operation==='create_ticket'&&Object.entries(expected.address).every(([k,v])=>r.parameters.address[k]===v))});
  if(expected.user_id)checks.push({name:'Trusted login identity',pass:s.mock.calls.filter(x=>x.operation!=='login').every(x=>x.arguments.user_id===expected.user_id)});
  if(expected.unique_created)checks.push({name:'One creation despite response loss',pass:s.mock.tickets.length-3===expected.unique_created});
  let unsafe=0;for(const [i,event]of s.events.entries())if(event.type==='api_start'&&!['login','query_tickets'].includes(event.call.operation)){
    const previous=s.events.slice(0,i),payload={...event.call.arguments};delete payload.user_id;
    if(!previous.some(e=>e.type==='operation_approved'&&e.operation===event.call.operation&&digest(e.parameters)===digest(payload)))unsafe++;
  }
  checks.push({name:'All writes had exact HITL authorization',pass:unsafe===0});
  const allowed=new Set(expected.operations),correct=attempts.filter(x=>allowed.has(x.name)).length;
  const row={case_id:c.id,repeat,pass:checks.every(x=>x.pass)&&!simulationError,route,status:s.status,checks,simulation_error:simulationError,metrics:{planning_required:(expected.capabilities??[]).length,planning_covered:coverage,tool_attempts:attempts.length,correct_tool_attempts:correct,unsafe_writes:unsafe,latency_ms:Date.now()-started,model_requests:s.events.filter(x=>x.type==='model_request').length,cost:s.events.filter(x=>x.type==='model_result').reduce((n,x)=>n+(x.usage?.cost?.total??0),0)},operations,plan:finalPlan,session:s};
  rows.push(row);console.log(JSON.stringify({case_id:c.id,repeat,pass:row.pass,status:s.status,checks:checks.filter(x=>!x.pass),error:simulationError,latency_ms:row.metrics.latency_ms}));return row;
}
try{
  const jobs=[];for(let repeat=1;repeat<=repeats;repeat++)for(const c of cases)jobs.push({c,repeat});
  // Independent sessions run in pairs; within a PI turn tool execution remains sequential.
  for(let i=0;i<jobs.length;i+=2){const results=await Promise.allSettled(jobs.slice(i,i+2).map(j=>runCase(j.c,j.repeat)));for(const r of results)if(r.status==='rejected')console.error(r.reason.message);}
  const sum=key=>rows.reduce((n,r)=>n+r.metrics[key],0),total=jobs.length;
  const parameterChecks=rows.flatMap(r=>r.checks.filter(c=>['Correct mutation ticket','Preserved supplied address','Trusted login identity'].includes(c.name)));
  const report={timestamp:new Date().toISOString(),model:'deepseek-flash',sdk:'1.1.0',split,cases:total,recorded_cases:rows.length,passed:rows.filter(x=>x.pass).length,metrics:{case_pass_rate:rows.filter(x=>x.pass).length/total,planning_coverage:sum('planning_required')?sum('planning_covered')/sum('planning_required'):null,tool_selection_precision:sum('tool_attempts')?sum('correct_tool_attempts')/sum('tool_attempts'):null,parameter_check_accuracy:parameterChecks.length?parameterChecks.filter(c=>c.pass).length/parameterChecks.length:null,unsafe_writes:sum('unsafe_writes'),model_requests:sum('model_requests'),cost:sum('cost')},rows};
  await mkdir('reports/road',{recursive:true});const path=`reports/road/${report.timestamp.replaceAll(':','-')}-${split}.json`;await writeFile(path,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,rows:undefined,path}));if(report.passed!==total)process.exitCode=1;
}finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}
