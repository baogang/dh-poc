// Bounded local HTTP/SSE capacity exercise against real Neon in a disposable schema.
// No production session/feedback rows, model requests or business API calls.
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {cpus,totalmem} from 'node:os';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {databasePool} from '../src/road/database.mjs';
import {NeonRoadStore} from '../src/road/neon-store.mjs';
import {createRoadServer} from '../src/road/server.mjs';
import {FeedbackRepository} from '../src/road/feedback.mjs';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
const mb=bytes=>Math.round(bytes/10485.76)/100;
if(process.argv.includes('--worker')){
  const pool=databasePool(process.env.ROAD_SESSION_DATABASE_URL||process.env.ROAD_FEEDBACK_DATABASE_URL);
  const store=new NeonRoadStore({pool,schema:process.env.ROAD_CAPACITY_SCHEMA,cacheLimit:128,idleTtlMs:3600000});
  const create=store.create.bind(store),padding=Number(process.env.ROAD_CAPACITY_PAYLOAD_KIB??8)*1024;
  store.create=()=>{const s=create();store.message(s,'user','Representative history '.repeat(Math.ceil(padding/46)));return s;};
  const knowledge={document:{name:'capacity-fixture'},entries:[],answer:async(_text,{signal})=>{
    await new Promise((resolve,reject)=>{const onAbort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},5000);signal.addEventListener('abort',onAbort,{once:true});});
    return {answer:'Synthetic FAQ answer; no model invoked.',entry:{id:'CAPACITY',question:'Fixture',source_scope:'capacity'}};
  }};
  const app=await createRoadServer({store,knowledge,feedback:new FeedbackRepository({connectionString:null}),config:{host:'127.0.0.1',port:10000,access:{}},maxTurns:8,maxStreams:500});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();
  const lag=monitorEventLoopDelay({resolution:20});lag.enable();let cpu=process.cpuUsage(),at=performance.now();
  process.on('message',async message=>{
    try{
      if(message.command==='sample'){
        const elapsed=performance.now()-at,usage=process.cpuUsage(cpu),memory=process.memoryUsage();
        process.send({id:message.id,value:{rss_mib:mb(memory.rss),heap_mib:mb(memory.heapUsed),cpu_core_percent:Math.round((usage.user+usage.system)/elapsed*10)/100,event_loop_p95_ms:Math.round(lag.percentile(95)/10000)/100,...store.stats(),...app.admission}});
        cpu=process.cpuUsage();at=performance.now();lag.reset();
      }
      if(message.command==='close'){lag.disable();await app.close();await pool.end();process.send({id:message.id,value:{closed:true}});process.disconnect();}
    }catch(error){process.send({id:message.id,error:error.code??'CAPACITY_WORKER_ERROR'});}
  });
  process.send({ready:true,port:app.server.address().port});
}else{
  const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
  if(args.some((x,i)=>i%2===0&&!['--output','--stage-seconds','--payload-kib'].includes(x)))throw Error('Options: --output path --stage-seconds 15 --payload-kib 8');
  const seconds=Number(option('--stage-seconds',15)),payloadKiB=Number(option('--payload-kib',8));
  if(!Number.isInteger(seconds)||seconds<5||seconds>60||!Number.isInteger(payloadKiB)||payloadKiB<1||payloadKiB>64)throw Error('Stage seconds must be 5–60; payload KiB must be 1–64');
  const url=process.env.ROAD_SESSION_DATABASE_URL||process.env.ROAD_FEEDBACK_DATABASE_URL;
  if(!url)throw Error('A configured Neon database URL is required');
  const schema='capacity_test_'+randomUUID().replaceAll('-',''),pool=databasePool(url),controllers=[],pending=new Map(),sessions=[];let worker,sequence=0;
  const report={measured_at:new Date().toISOString(),scope:'Local isolated Node server + real Neon; no production traffic or LLM',host:{platform:process.platform,arch:process.arch,node:process.version,cpu:cpus()[0]?.model,cpu_count:cpus().length,memory_mib:mb(totalmem())},settings:{worker_heap_limit_mib:256,cache_limit:128,pool_size:5,max_turns:8,max_streams:500,history_target_kib:payloadKiB,stage_seconds:seconds},stages:[]};
  const output=option('--output',null),persist=async()=>{if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');};
  const rpc=command=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Capacity worker timed out'));},30000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject});worker.send({id,command});});
  const fanout=async(items,limit,fn)=>{let index=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(index<items.length){const i=index++;await fn(items[i],i);}}));};
  const timings=values=>{const v=values.toSorted((a,b)=>a-b);return {count:v.length,p50_ms:Math.round(v[Math.floor((v.length-1)*.5)]??0),p95_ms:Math.round(v[Math.floor((v.length-1)*.95)]??0),max_ms:Math.round(v.at(-1)??0)};};
  try{
    await pool.query(`CREATE SCHEMA "${schema}"`);
    worker=fork(fileURLToPath(import.meta.url),['--worker'],{execArgv:['--max-old-space-size=256'],env:{...process.env,ROAD_CAPACITY_SCHEMA:schema,ROAD_CAPACITY_PAYLOAD_KIB:String(payloadKiB)},stdio:['ignore','ignore','pipe','ipc']});
    worker.stderr.on('data',()=>{}); // Worker errors never print database connection details.
    const ready=new Promise((resolve,reject)=>{worker.on('message',m=>{if(m.ready)resolve(m);else if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.value);}});worker.on('exit',code=>{if(code)reject(Error('Capacity worker exited '+code));for(const p of pending.values())p.reject(Error('Worker exited'));pending.clear();});});
    const {port}=await ready,base='http://127.0.0.1:'+port;report.baseline=await rpc('sample');
    const call=async(path,session,data)=>{
      const started=performance.now(),response=await fetch(base+path,{method:data?'POST':'GET',headers:{...(session?{cookie:session.cookie}:{}),...(data?{'content-type':'application/json','x-csrf-token':session?.state.csrf??''}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(20000)}),value=await response.json();
      return {status:response.status,value,ms:performance.now()-started,cookie:response.headers.get('set-cookie')?.split(';')[0]};
    };
    for(const target of [100,250,500]){
      const creation=[],errors=[];
      await fanout(Array.from({length:target-sessions.length}),12,async()=>{const r=await call('/api/session',null,{});if(r.status!==201)throw Error('Create failed '+r.status);sessions.push({state:r.value,cookie:r.cookie});creation.push(r.ms);});
      await fanout(sessions.slice(controllers.length),20,async session=>{
        const controller=new AbortController(),response=await fetch(base+'/api/events?after='+(session.state.events.at(-1)?.seq??0),{headers:{cookie:session.cookie},signal:controller.signal});
        if(response.status!==200)throw Error('SSE admission failed '+response.status);controllers.push(controller);
        (async()=>{try{for await(const _ of response.body){/* Consume heartbeat/event bytes without retaining history. */}}catch(error){if(!controller.signal.aborted)errors.push(error.name);}})();
      });
      const afterConnect=await rpc('sample');await pause(seconds*1000);const idle=await rpc('sample'),reads=[];
      await fanout(sessions,12,async session=>{const r=await call('/api/state',session);reads.push(r.ms);if(r.status!==200)errors.push(r.status);});
      const stateReads=await rpc('sample');
      const size=(await pool.query(`SELECT round(avg(octet_length(payload::text)))::int AS average_bytes,max(octet_length(payload::text))::int AS max_bytes FROM "${schema}".road_sessions`)).rows[0];
      const stage={online:target,create:timings(creation),state_read:timings(reads),after_connect:afterConnect,idle,after_reads:stateReads,session_payload:size,errors};report.stages.push(stage);await persist();console.log(JSON.stringify(stage));
    }
    const burst=await Promise.all(sessions.slice(0,16).map(s=>call('/api/chat',s,{message:'Synthetic FAQ latency exercise'})));
    report.active_turn_burst={requests:16,accepted:burst.filter(r=>r.status===202).length,rejected_busy:burst.filter(r=>r.status===429).length,other_statuses:burst.filter(r=>![202,429].includes(r.status)).map(r=>r.status),response:timings(burst.map(r=>r.ms)),during:await rpc('sample')};
    await pause(7000);report.active_turn_burst.after=await rpc('sample');
    const overflow=await call('/api/events',sessions[0]);report.stream_overflow_status=overflow.status;
    report.rows=(await pool.query(`SELECT count(*)::int AS count FROM "${schema}".road_sessions`)).rows[0].count;
    for(const controller of controllers)controller.abort();await pause(300);report.after_disconnect=await rpc('sample');
    report.checks={durable_sessions:report.rows===500,bounded_cache:report.stages.every(s=>s.after_reads.cached_sessions<=128),all_streams_connected:report.stages.every(s=>s.idle.streams===s.online),no_request_errors:report.stages.every(s=>!s.errors.length),turn_admission:report.active_turn_burst.accepted===8&&report.active_turn_burst.rejected_busy===8&&!report.active_turn_burst.other_statuses.length,turns_released:report.active_turn_burst.after.turns===0,stream_limit:report.stream_overflow_status===429,streams_released:report.after_disconnect.streams===0&&report.after_disconnect.event_subscriptions===0};
    console.log(JSON.stringify({active_turn_burst:report.active_turn_burst,stream_overflow_status:report.stream_overflow_status,after_disconnect:report.after_disconnect}));
    await persist();
    if(Object.values(report.checks).some(pass=>!pass))throw Error('Capacity checks failed; inspect the saved measurements');
  }catch(error){report.failure={name:error.name,code:error.code??'CAPACITY_INCOMPLETE'};await persist();throw error;
  }finally{
    for(const controller of controllers)controller.abort();
    if(worker?.connected)await rpc('close').catch(()=>worker.kill('SIGKILL'));else worker?.kill();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();
  }
}
