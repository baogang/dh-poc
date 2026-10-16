import { createServer } from 'node:http';
import { createHash,randomBytes,timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { webConfigFromEnv,createWebAccess } from '../web-access.mjs';
import { RoadStore,failure,id } from './store.mjs';
import { RoadMocks,MOCK_API_NAMES } from './mocks.mjs';
import { RoadKnowledge } from './knowledge.mjs';
import { RoadAgent } from './agent.mjs';
import {parseHighRiskReads} from './policy.mjs';
import {humanNotice} from './human.mjs';
import {FeedbackRepository,feedbackRecord} from './feedback.mjs';
import {feedbackExport} from '../../web/road/feedback-data.js';

const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function body(req){
  if(!req.headers['content-type']?.startsWith('application/json'))throw failure('JSON_REQUIRED','Use application/json',415);
  let data='';for await(const part of req){data+=part;if(Buffer.byteLength(data)>12000)throw failure('BODY_TOO_LARGE','JSON body too large',413);}
  try{return JSON.parse(data||'{}');}catch{throw failure('INVALID_JSON','Invalid JSON');}
}
export function mockHttpClient({origin,key}){
  return async(sid,operation,parameters,context={})=>{
    const {signal,...headersContext}=context;let attempt=0;
    while(true){
      signal?.throwIfAborted();
      const response=await fetch(`${origin}/mock/${operation}`,{method:'POST',headers:{'content-type':'application/json','x-road-mock-key':key,'x-road-session':sid},body:JSON.stringify({parameters,context:headersContext}),signal});
      const result=await response.json();
      if(response.ok)return result;
      // Same key and payload on retry; covers committed-but-response-lost writes.
      if(response.status===503&&attempt++===0)continue;
      throw failure(result.error?.code??'MOCK_HTTP_ERROR',result.error?.message??'Mock API failed',response.status);
    }
  };
}

export async function createRoadServer({store=new RoadStore(process.env.ROAD_STATE_DIR??'.road-state'),knowledge,agentFactory,feedback=new FeedbackRepository(),config=webConfigFromEnv(),mockKey=randomBytes(32).toString('hex'),demoUI=process.env.ROAD_DEMO_UI!=='false',highRiskReads=parseHighRiskReads(process.env.ROAD_HIGH_RISK_READS??'')}={}){
  await store.initialize();await feedback.initialize().catch(()=>console.warn('Feedback database is temporarily unavailable'));knowledge??=await RoadKnowledge.load();const mocks=new RoadMocks(store);const access=createWebAccess(config.access);let agent;
  const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const getSession=req=>{const cookie=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('road_session='));if(!cookie)throw failure('SESSION_REQUIRED','Start a conversation',401);return store.get(cookie.slice(13));};
  const view=s=>({...store.view(s),demo_ui:demoUI===true,feedback:{enabled:feedback.enabled,items:feedback.cached(s.id)},faq:{name:knowledge.document.name,entry_count:knowledge.entries.length,source_displayed_count:knowledge.document.source_displayed_count,migration_status:knowledge.document.migration_status},model:'deepseek-flash',runtime:'PI SDK 1.1.0'});
  const server=createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/healthz'&&req.method==='GET')return send(res,200,{ok:true,service:'road-pothole-pi-poc',model_configured:!!process.env.DEEPSEEK_API_KEY});
      if(url.pathname.startsWith('/mock/')){
        if(req.method!=='POST'||!equal(req.headers['x-road-mock-key'],mockKey))throw failure('MOCK_FORBIDDEN','Mock APIs require the private harness credential',403);
        const operation=url.pathname.slice(6);if(!MOCK_API_NAMES.includes(operation))throw failure('UNKNOWN_API','Unknown mock API',404);
        const input=await body(req);return send(res,200,await mocks.call(req.headers['x-road-session'],operation,input.parameters,input.context));
      }
      const port=server.address()?.port??config.port;
      const origin=access.originFor(req,port);
      if(!access.authenticated(req)){res.setHeader('www-authenticate','Basic realm="Road Pothole PI PoC", charset="UTF-8"');return send(res,401,{error:{code:'AUTH_REQUIRED',message:'Test service credentials required'}});}
      if(req.method!=='GET'){
        if(req.headers.origin&&req.headers.origin!==origin)throw failure('ORIGIN_FORBIDDEN','Cross-origin request rejected',403);
        if(req.headers['sec-fetch-site']==='cross-site')throw failure('ORIGIN_FORBIDDEN','Cross-site request rejected',403);
      }
      if(req.method==='POST'&&url.pathname==='/api/session'){
        if(store.sessions.size>=100)throw failure('SESSION_LIMIT','Test session limit reached',429);
        const s=store.create();s.csrf=id('csrf');await store.save(s);res.setHeader('set-cookie',`road_session=${s.id}; HttpOnly; SameSite=Strict; Path=/${access.origin?'; Secure':''}`);return send(res,201,view(s));
      }
      if(url.pathname.startsWith('/api/')){
        const s=getSession(req);
        if(req.method==='GET'&&url.pathname==='/api/state'){feedback.load(s.id).catch(()=>{});return send(res,200,view(s));}
        if(req.method==='GET'&&url.pathname==='/api/feedback'){
          if(!feedback.enabled)return send(res,200,{records:[]});
          try{return send(res,200,{records:(await feedback.list(s.id)).map(feedbackRecord)});}catch{throw failure('FEEDBACK_UNAVAILABLE','Feedback storage is temporarily unavailable',503);}
        }
        if(req.method==='GET'&&url.pathname==='/api/feedback/export'){
          const format=url.searchParams.get('format')??'jsonl';if(!['csv','jsonl'].includes(format))throw failure('INVALID_FEEDBACK','Use csv or jsonl');
          let rows;try{rows=(await feedback.list(s.id)).map(feedbackRecord);}catch{throw failure('FEEDBACK_UNAVAILABLE','Feedback export is temporarily unavailable',503);}
          res.writeHead(200,{'content-type':format==='csv'?'text/csv; charset=utf-8':'application/x-ndjson; charset=utf-8','content-disposition':`attachment; filename="answer-feedback.${format}"`,'cache-control':'no-store'});return res.end(feedbackExport(rows,format));
        }
        if(req.method==='GET'&&url.pathname==='/api/events'){
          const after=Number(req.headers['last-event-id']??url.searchParams.get('after')??0);
          res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','x-accel-buffering':'no'});
          const event=e=>res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
          const unsubscribe=store.subscribe(s.id,event);for(const e of s.events)if(e.seq>after)event(e);
          const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),20000);req.on('close',()=>{clearInterval(heartbeat);unsubscribe();});return;
        }
        if(req.method!=='POST')throw failure('METHOD_NOT_ALLOWED','Method not allowed',405);
        if(!equal(req.headers['x-csrf-token'],s.csrf))throw failure('CSRF_REQUIRED','Missing session confirmation token',403);
        const input=await body(req);
        if(url.pathname==='/api/feedback'){
          const message=s.messages.find(m=>m.id===input.answer_message_id&&m.role==='assistant');
          const snapshot=s.answerSnapshots?.[input.answer_message_id];
          if(!message||!snapshot||!['faq','result','error'].includes(message.kind))throw failure('FEEDBACK_TARGET_NOT_FOUND','Select an answer in this conversation',404);
          return send(res,200,{record:await feedback.submit(s.id,input,snapshot)});
        }
        if(url.pathname==='/api/cancel'){await agent.cancel(s);return send(res,200,view(s));}
        if(s.running)throw failure('BUSY','Stop the current turn before another action',409);
        if(url.pathname==='/api/login'){await agent.login(s,input);return send(res,200,view(s));}
        if(url.pathname==='/api/human'){
          const h=s.mock.handoffs.find(x=>x.handoff_id===input.handoff_id);if(!h||!['accept','escalate','complete','resume'].includes(input.action))throw failure('INVALID_HUMAN_ACTION','Select a mock handoff and valid action');
          if(input.action==='resume'){
            if(h.scope!=='conversation'||h.status!=='COMPLETED'||s.activeHandoffId!==h.handoff_id)throw failure('HUMAN_NOT_COMPLETED','Complete this human conversation before returning to the assistant',409);
            s.activeHandoffId=null;s.status='answered';store.emit(s,'human_resumed',{handoff_id:h.handoff_id});store.message(s,'assistant',humanNotice(s,'resumed'),{kind:'human_notice',notice:'human.resumed'});await store.save(s);return send(res,200,view(s));
          }
          const result=await agent.api(s.id,'handoff_to_human',{...(s.user?{user_id:s.user.user_id}:{}),...(h.scope==='conversation'?{scope:'conversation'}:{ticket_id:h.ticket_id}),handoff_id:h.handoff_id,action:input.action},{epoch:s.epoch,idempotency_key:`human:${h.handoff_id}:${input.action}`,authorization:'human_simulator'});
          if(h.scope==='conversation'&&s.activeHandoffId===h.handoff_id){s.status=h.status==='WAITING'?'human_waiting':h.status==='COMPLETED'?'human_completed':'human_active';store.message(s,'assistant',humanNotice(s,{accept:'accepted',escalate:'escalated',complete:'completed'}[input.action]),{kind:'human_notice',handoff_id:h.handoff_id,notice:'human.'+{accept:'accepted',escalate:'escalated',complete:'completed'}[input.action]});}

          store.emit(s,'human_status',{handoff:result.handoff});await store.save(s);return send(res,200,view(s));
        }
        let run;
        if(url.pathname==='/api/chat'){
          if(typeof input.message!=='string'||!input.message.trim()||input.message.length>4000)throw failure('INVALID_MESSAGE','Message must be 1–4000 characters');run=agent.chat(s,input.message);
        }else if(url.pathname==='/api/approve-plan'){
          const p=agent.active(s);if(!p||p.id!==input.plan_id||p.status!=='review')throw failure('STALE_PLAN','Plan is no longer awaiting review',409);run=agent.approvePlan(s,input.plan_id);
        }else if(url.pathname==='/api/input'){
          if(!s.pendingInput||s.pendingInput.id!==input.input_id)throw failure('STALE_INPUT','Input is no longer current',409);
          // Validation occurs before running: await a non-running rejection, otherwise return 202.
          run=agent.answerInput(s,input.input_id,input.value??{});
        }else if(url.pathname==='/api/approve-operation'){
          if(!s.pendingOperation||s.pendingOperation.id!==input.proposal_id)throw failure('STALE_CONFIRMATION','Operation is no longer current',409);run=agent.approveOperation(s,input.proposal_id);
        }else if(url.pathname==='/api/retry'){run=agent.retry(s);}
        else throw failure('NOT_FOUND','Unknown endpoint',404);
        // All handlers set running synchronously before their first run await, or reject validation.
        await Promise.race([run,new Promise(r=>setImmediate(r))]);run.catch(()=>{});return send(res,202,view(s));
      }
      if(req.method==='GET'&&url.pathname==='/docs/road-agent-flow.html'){
        const html=await readFile(new URL('../../docs/road-agent-flow.html',import.meta.url),'utf8');
        const styleHashes=[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match=>"'sha256-"+createHash('sha256').update(match[1]).digest('base64')+"'");
        res.setHeader('content-security-policy',"default-src 'none'; script-src 'none'; style-src "+styleHashes.join(' ')+" https://fonts.googleapis.com; style-src-attr 'none'; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(html);
      }
      if(req.method!=='GET')throw failure('NOT_FOUND','Not found',404);
      const files={'/':'index.html','/app.js':'app.js','/chat-ui.js':'chat-ui.js','/i18n.js':'i18n.js','/feedback-ui.js':'feedback-ui.js','/feedback-data.js':'feedback-data.js','/style.css':'style.css'};
      if(!files[url.pathname])throw failure('NOT_FOUND','Not found',404);
      const data=await readFile(new URL(`../../web/road/${files[url.pathname]}`,import.meta.url));res.writeHead(200,{'content-type':url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':url.pathname.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store'});res.end(data);
    }catch(error){if(!res.headersSent)send(res,error.status??500,{error:{code:error.code??'SERVER_ERROR',message:error.status?error.message:'Internal server error',...(error.current?{current:error.current}:{})}});else res.end();}
  });
  const ready=async()=>{
    const addr=server.address(),api=mockHttpClient({origin:`http://127.0.0.1:${addr.port}`,key:mockKey});
    agent=agentFactory?await agentFactory({store,api,knowledge,highRiskReads}):new RoadAgent({store,api,knowledge,highRiskReads});
  };
  return {server,store,mocks,feedback,get agent(){return agent;},ready,view};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const config=webConfigFromEnv();const app=await createRoadServer({config});
  app.server.listen(config.port,config.host,async()=>{await app.ready();console.log(`Road PoC listening on ${config.host}:${config.port}`);});
  const stop=()=>{for(const s of app.store.sessions.values())if(s.running)app.agent.interrupt(s,'server_shutdown');app.server.close(()=>app.feedback.close().finally(()=>process.exit(0)));setTimeout(()=>process.exit(0),10000).unref();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
