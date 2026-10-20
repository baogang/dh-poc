import { createServer } from 'node:http';
import {mobileStaticFiles,staticContentType} from './mobile-static.mjs';
import {mapsConfiguration,mapsPage} from './maps.mjs';
import {normalizeLocation,locationText} from '../../web/road/location-data.js';
import { createHash,randomBytes,timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { webConfigFromEnv,createWebAccess } from '../web-access.mjs';
import { failure,id } from './store.mjs';
import {NeonRoadStore} from './neon-store.mjs';
import { CrmSimulation } from '../crm/simulation.mjs';
import { SimulationHttpClient,RealCrmClient } from '../crm/client.mjs';
import { OPENAPI } from '../crm/openapi.mjs';
import { OPERATIONS } from '../crm/contract.mjs';
import {allowedOperation} from '../crm/policy.mjs';
import {presentCrmMessage} from '../crm/presentation.mjs';
import { RoadKnowledge } from './knowledge.mjs';
import { CrmAgent } from '../crm/agent.mjs';
import {parseHighRiskReads} from './policy.mjs';
import {humanNotice,humanWaitExpired} from './human.mjs';
import {services} from './services.mjs';
import {FeedbackRepository,feedbackRecord} from './feedback.mjs';
import {feedbackExport} from '../../web/road/feedback-data.js';

const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function body(req){
  if(!req.headers['content-type']?.startsWith('application/json'))throw failure('JSON_REQUIRED','Use application/json',415);
  let data='';for await(const part of req){data+=part;if(Buffer.byteLength(data)>2000000)throw failure('BODY_TOO_LARGE','JSON body too large',413);}
  let value;try{value=JSON.parse(data||'{}');}catch{throw failure('INVALID_JSON','Invalid JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw failure('JSON_OBJECT_REQUIRED','Use a JSON object request body');
  return value;
}
export async function createRoadServer({store,knowledge,agentFactory,feedback=new FeedbackRepository(),maps=mapsConfiguration(),config=webConfigFromEnv(),mockKey=randomBytes(32).toString('hex'),demoUI=process.env.ROAD_DEMO_UI!=='false',highRiskReads=parseHighRiskReads(process.env.ROAD_HIGH_RISK_READS??''),humanSupport={available:process.env.ROAD_HUMAN_AVAILABLE!=='false',wait_limit_ms:Number(process.env.ROAD_HUMAN_WAIT_LIMIT_MS??180000)},maxTurns=Number(process.env.ROAD_MAX_INFLIGHT_TURNS??8),maxStreams=Number(process.env.ROAD_MAX_EVENT_STREAMS??500)}={}){
  if(typeof humanSupport.available!=='boolean'||!Number.isInteger(humanSupport.wait_limit_ms)||humanSupport.wait_limit_ms<1)throw Error('Invalid simulated human support configuration');
  if(!Number.isInteger(maxTurns)||maxTurns<1||!Number.isInteger(maxStreams)||maxStreams<1)throw Error('Road concurrency limits must be positive integers');
  const injectedStore=!!store;store??=NeonRoadStore.fromEnv();await store.initialize();
  const migration=!injectedStore?await store.importDirectory(process.env.ROAD_STATE_DIR??'.road-state'):null;
  await feedback.initialize().catch(()=>console.warn('Feedback database is temporarily unavailable'));knowledge??=await RoadKnowledge.load();
  const mocks=new CrmSimulation(store),access=createWebAccess(config.access),runs=new Set(),streams=new Set(),admission={turns:0,streams:0,maxTurns,maxStreams};let agent;
  const permit=kind=>{const max=kind==='turns'?maxTurns:maxStreams;if(admission[kind]>=max)throw failure('SERVER_BUSY','The service is busy. Please retry shortly.',429);admission[kind]++;let released=false;return()=>{if(!released){released=true;admission[kind]--;}};};
  const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const sessionId=req=>{const cookie=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('road_session='));if(!cookie)throw failure('SESSION_REQUIRED','Start a conversation',401);return cookie.slice(13);};
  const view=s=>{const saved=store.view(s);return {...saved,messages:saved.messages.map(m=>presentCrmMessage(m,s.receipts)),crm:s.crm?{version:s.crm.version,calls:s.crm.calls}:null,api_mode:agent?.client?.mode??'simulation',tool_count:agent?.operations?.length??0,contract_operation_count:OPERATIONS.length,catalog:services,human_support:{...humanSupport,mode:'simulated',hours_configured:false,official_url:'https://balady.gov.sa/en',wait_expired:humanWaitExpired(s.mock.handoffs.find(h=>h.handoff_id===s.activeHandoffId))},demo_ui:demoUI===true,feedback:{enabled:feedback.enabled,items:feedback.cached(s.id)},faq:{name:knowledge.document.name,entry_count:knowledge.entries.length,source_displayed_count:knowledge.document.source_displayed_count,migration_status:knowledge.document.migration_status,quality:knowledge.document.quality},model:process.env.DEEPSEEK_MODEL??'deepseek-flash',runtime:'PI SDK 1.1.0'};};
  const server=createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let release,turnPermit;
    const unlock=async()=>{if(release){const done=release;release=null;await done();}};
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/healthz'&&req.method==='GET')return send(res,200,{ok:true,service:'balady-crm',contract_version:'1.13.0',tools:OPERATIONS.length,api_mode:agent?.client?.mode??'simulation',release:process.env.RENDER_GIT_COMMIT??null,session_storage:store.storage,model_configured:!!process.env.DEEPSEEK_API_KEY});
      if(url.pathname.startsWith('/mock/'))return send(res,410,{error:{code:'LEGACY_DISABLED',message:'Previous mock APIs are disabled; use the documented CRM toolset.'}});
      if(url.pathname.startsWith('/v1/crm-services/')){
        if(!equal(req.headers['x-crm-simulation-key'],mockKey))throw failure('SIMULATION_FORBIDDEN','CRM simulation requires the private harness credential',403);
        const s=store.get(req.headers['x-road-session']);
        const input=['POST','PUT'].includes(req.method)?await body(req):undefined;
        const result=await mocks.http(s,req.method,url,input,{epoch:Number(req.headers['x-crm-epoch']),idempotency_key:req.headers['x-crm-idempotency-key']});
        if(result.ok)return send(res,200,result.response);
        const status=result.error.http_status??(result.error.code==='NOT_FOUND'?404:400);
        return send(res,status,{statusDetails:{code:status,message:result.error.message},data:{responseCode:result.error.code,responseMessage:result.error.message,...(result.error.validation?{validation:result.error.validation}:{})}});
      }
      const port=server.address()?.port??config.port,origin=access.originFor(req,port);
      if(!access.authenticated(req)){res.setHeader('www-authenticate','Basic realm="BALADY Assistant", charset="UTF-8"');return send(res,401,{error:{code:'AUTH_REQUIRED',message:'Test service credentials required'}});}
      if(url.pathname==='/api/openapi'&&req.method==='GET')return send(res,200,OPENAPI);
      if(url.pathname==='/api/tools'&&req.method==='GET')return send(res,200,{identity:'BALADY Assistant',mode:agent?.client?.mode??'simulation',operations:OPERATIONS.map(({id,summary,description,auth,effect,input,conditions,notes,section,page})=>({id,summary,description,auth,effect,input,conditions,notes,available_in_public_assistant:allowedOperation(id),source:{section,page}}))});
      if(req.method!=='GET'){
        if(req.headers.origin&&req.headers.origin!==origin)throw failure('ORIGIN_FORBIDDEN','Cross-origin request rejected',403);
        if(req.headers['sec-fetch-site']==='cross-site')throw failure('ORIGIN_FORBIDDEN','Cross-site request rejected',403);
      }
      if(req.method==='POST'&&url.pathname==='/api/session'){
        const s=store.create();s.csrf=id('csrf');await store.save(s);res.setHeader('set-cookie',`road_session=${s.id}; HttpOnly; SameSite=Strict; Path=/${access.origin?'; Secure':''}`);return send(res,201,view(s));
      }
      if(url.pathname.startsWith('/api/')){
        const sid=sessionId(req);let s=await store.load(sid);
        if(req.method==='GET'&&url.pathname==='/api/maps/config')return send(res,200,maps);
        if(req.method==='GET'&&url.pathname==='/api/state'){if(s.user&&s.mattersView)s.mattersView=await agent.matters.list(s);feedback.load(s.id).catch(()=>{});return send(res,200,view(s));}
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
          let after=Number(req.headers['last-event-id']??url.searchParams.get('after')??0);
          if(!Number.isSafeInteger(after)||after<0)throw failure('INVALID_EVENT_CURSOR','Use a valid event cursor');
          const free=permit('streams');
          res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','x-accel-buffering':'no'});
          const event=e=>{if(e.seq<=after||res.writableEnded||res.destroyed)return;if(res.writableLength>262144){res.end();return;}res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);after=e.seq;if(e.type==='session_expired')res.end();};
          const unsubscribe=store.subscribe(s.id,event);streams.add(res);
          const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),20000);heartbeat.unref();
          res.on('close',()=>{clearInterval(heartbeat);unsubscribe();streams.delete(res);free();});
          for(const e of s.events)event(e);res.write(': connected\n\n');return;
        }
        if(req.method!=='POST')throw failure('METHOD_NOT_ALLOWED','Method not allowed',405);
        if(!equal(req.headers['x-csrf-token'],s.csrf))throw failure('CSRF_REQUIRED','Missing session confirmation token',403);
        const input=await body(req);
        if(url.pathname==='/api/feedback'){
          const message=s.messages.find(m=>m.id===input.answer_message_id&&m.role==='assistant'),snapshot=s.answerSnapshots?.[input.answer_message_id];
          if(!message||!snapshot||!['faq','result','error'].includes(message.kind))throw failure('FEEDBACK_TARGET_NOT_FOUND','Select an answer in this conversation',404);
          return send(res,200,{record:await feedback.submit(s.id,input,snapshot)});
        }
        // A stop on the owning process shares its existing turn lease. A different
        // process must never mutate that turn's stale in-memory snapshot.
        if(url.pathname==='/api/cancel'&&store.owns(sid)){s=store.get(sid);await agent.cancel(s);return send(res,200,view(s));}
        const lease=await store.acquire(sid);s=lease.session;release=lease.release;
        if(!equal(req.headers['x-csrf-token'],s.csrf))throw failure('CSRF_REQUIRED','Missing session confirmation token',403);
        if(url.pathname==='/api/cancel'){await agent.cancel(s);await unlock();return send(res,200,view(s));}
        if(s.running)throw failure('BUSY','Stop the current turn before another action',409);
        if(url.pathname==='/api/login'){await agent.login(s,input);if(input.show_matters)await agent.showMatters(s);await unlock();return send(res,200,view(s));}
        if(url.pathname==='/api/matters'){
          if(input.action==='resume')await agent.resumeDraft(s,input.draft_id,input.version);
          else if(input.action==='discard'){await agent.matters.remove(s,input.draft_id,input.version);if(s.currentDraft?.id===input.draft_id)agent.interrupt(s,'draft_discarded');}
          else if(input.action==='read')await agent.matters.markRead(s,input.ids);
          else if(input.action==='simulate'){if(!demoUI)throw failure('DEMO_DISABLED','Demo tools disabled',403);await agent.matters.simulate(s,input.ticket_id);}
          else if(input.action!=='list')throw failure('INVALID_MATTERS_ACTION','Choose a matters action');
          await agent.showMatters(s);await unlock();return send(res,200,view(s));
        }
        if(url.pathname==='/api/edit-operation'){await agent.editOperation(s,input.proposal_id,input.value??{});await unlock();return send(res,200,view(s));}
        if(url.pathname==='/api/save-draft'){await agent.saveForLater(s,input.proposal_id);await unlock();return send(res,200,view(s));}
        if(url.pathname==='/api/reconcile'){await agent.reconcileOperation(s);await agent.showMatters(s);await unlock();return send(res,200,view(s));}
        if(url.pathname==='/api/catalog'){await agent.catalog(s);await unlock();return send(res,200,view(s));}
        if(url.pathname==='/api/help'&&input.action!=='continue'){
          if(input.action==='offer')await agent.offerHelp(s);
          else if(input.action==='queue')await agent.helpChoice(s,input.request_id,'queue');
          else throw failure('INVALID_HELP_ACTION','Choose offer, queue or continue');
          await unlock();return send(res,200,view(s));
        }
        if(url.pathname==='/api/human'){
          const h=s.mock.handoffs.find(x=>x.handoff_id===input.handoff_id);if(!h||!['accept','escalate','complete','resume','cancel'].includes(input.action))throw failure('INVALID_HUMAN_ACTION','Select a mock handoff and valid action');
          if(input.action==='cancel'){
            if(h.scope!=='conversation'||s.activeHandoffId!==h.handoff_id||!['WAITING','ACCEPTED','ESCALATED'].includes(h.status))throw failure('INVALID_HUMAN_ACTION','Select the active conversation',409);
            await agent.api(s.id,'handoff_to_human',{...(s.user?{user_id:s.user.user_id}:{}),scope:'conversation',handoff_id:h.handoff_id,action:'cancel'},{epoch:s.epoch,idempotency_key:`human:${h.handoff_id}:cancel`,authorization:'user_help_choice'});
            s.activeHandoffId=null;s.pendingHelp=null;s.status='answered';store.emit(s,'human_cancelled',{handoff_id:h.handoff_id});store.message(s,'assistant',humanNotice(s,'resumed'),{kind:'human_notice',notice:'human.resumed'});await store.save(s);await unlock();return send(res,200,view(s));
          }
          if(input.action==='resume'){
            if(h.scope!=='conversation'||h.status!=='COMPLETED'||s.activeHandoffId!==h.handoff_id)throw failure('HUMAN_NOT_COMPLETED','Complete this human conversation before returning to the assistant',409);
            s.activeHandoffId=null;s.status='answered';store.emit(s,'human_resumed',{handoff_id:h.handoff_id});store.message(s,'assistant',humanNotice(s,'resumed'),{kind:'human_notice',notice:'human.resumed'});await store.save(s);await unlock();return send(res,200,view(s));
          }
          const result=await agent.api(s.id,'handoff_to_human',{...(s.user?{user_id:s.user.user_id}:{}),...(h.scope==='conversation'?{scope:'conversation'}:{ticket_id:h.ticket_id}),handoff_id:h.handoff_id,action:input.action},{epoch:s.epoch,idempotency_key:`human:${h.handoff_id}:${input.action}`,authorization:'human_simulator'});
          if(h.scope==='conversation'&&s.activeHandoffId===h.handoff_id){s.status=h.status==='WAITING'?'human_waiting':h.status==='COMPLETED'?'human_completed':'human_active';store.message(s,'assistant',humanNotice(s,{accept:'accepted',escalate:'escalated',complete:'completed'}[input.action]),{kind:'human_notice',handoff_id:h.handoff_id,notice:'human.'+{accept:'accepted',escalate:'escalated',complete:'completed'}[input.action]});}
          store.emit(s,'human_status',{handoff:result.handoff});await store.save(s);await unlock();return send(res,200,view(s));
        }
        let run;turnPermit=permit('turns');
        if(url.pathname==='/api/service')run=agent.selectService(s,input.scope,input.clarification_id);
        else if(url.pathname==='/api/help')run=agent.helpChoice(s,input.request_id,'continue');
        else if(url.pathname==='/api/chat'){
          let selected;
          if(input.location!==undefined){try{selected=normalizeLocation(input.location);}catch{throw failure('INVALID_LOCATION','Choose valid geographic coordinates and address fields. Internal administrative IDs cannot be supplied through the map.');}}
          if(typeof input.message!=='string'||(!input.message.trim()&&!selected)||input.message.length>12000)throw failure('INVALID_MESSAGE','Message must be 1–12000 characters');
          const language=['zh','en','ar'].includes(input.location_locale)?input.location_locale:/\p{Script=Arabic}/u.test(input.message)?'ar':/\p{Script=Han}/u.test(input.message)?'zh':'en';
          const message=[input.message.trim(),selected?locationText(selected,language):''].filter(Boolean).join('\n\n');
          if(message.length>12000)throw failure('INVALID_MESSAGE','Message and selected location must fit within 12000 characters');run=agent.chat(s,message);
        }else if(url.pathname==='/api/approve-plan'){
          const p=agent.active(s);if(!p||p.id!==input.plan_id||p.status!=='review')throw failure('STALE_PLAN','Plan is no longer awaiting review',409);run=agent.approvePlan(s,input.plan_id);
        }else if(url.pathname==='/api/input'){
          if(!s.pendingInput||s.pendingInput.id!==input.input_id)throw failure('STALE_INPUT','Input is no longer current',409);run=agent.answerInput(s,input.input_id,input.value??{});
        }else if(url.pathname==='/api/approve-operation'){
          if(!s.pendingOperation||s.pendingOperation.id!==input.proposal_id)throw failure('STALE_CONFIRMATION','Operation is no longer current',409);const operation=await agent.authorizeOperation(s,input.proposal_id);run=agent.continueAuthorizedOperation(s,operation);
        }else if(url.pathname==='/api/retry'){await agent.prepareRetry(s);run=agent.continueRetry(s);}
        else throw failure('NOT_FOUND','Unknown endpoint',404);
        const freeTurn=turnPermit,freeLease=release;turnPermit=null;release=null;
        const done=run.finally(async()=>{try{await freeLease();}finally{freeTurn();runs.delete(done);}});runs.add(done);done.catch(()=>{});
        // A 202 acknowledges a persisted turn, not only an in-memory mutation.
        await store.flush(s.id);await Promise.race([run,new Promise(r=>setImmediate(r))]);return send(res,202,view(await store.load(s.id)));
      }
      if(req.method==='GET'&&['/docs/road-agent-flow.html','/docs/balady-crm-flow.html'].includes(url.pathname)){
        const html=await readFile(new URL('../../docs/balady-crm-flow.html',import.meta.url),'utf8');
        const styleHashes=[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match=>"'sha256-"+createHash('sha256').update(match[1]).digest('base64')+"'");
        res.setHeader('content-security-policy',"default-src 'none'; script-src 'none'; style-src "+styleHashes.join(' ')+" https://fonts.googleapis.com; style-src-attr 'none'; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(html);
      }
      if(req.method!=='GET')throw failure('NOT_FOUND','Not found',404);
      if(url.pathname==='/map-picker.html'){
        const page=mapsPage(await readFile(new URL('../../web/road/map-picker.html',import.meta.url),'utf8'));
        res.setHeader('content-security-policy',page.csp);res.setHeader('referrer-policy','strict-origin-when-cross-origin');
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(page.html);
      }
      const files={...mobileStaticFiles,'/':'index.html','/app.js':'app.js','/chat-ui.js':'chat-ui.js','/markdown.js':'markdown.js','/crm-review.js':'crm-review.js','/vendor/marked.js':'vendor/marked.js','/i18n.js':'i18n.js','/feedback-ui.js':'feedback-ui.js','/feedback-data.js':'feedback-data.js','/style.css':'style.css'};
      if(!files[url.pathname])throw failure('NOT_FOUND','Not found',404);
      const data=await readFile(new URL(`../../web/road/${files[url.pathname]}`,import.meta.url));res.writeHead(200,{'content-type':staticContentType(url.pathname),'cache-control':'no-store'});res.end(data);
    }catch(error){if(error.status===429)res.setHeader('retry-after','2');if(!res.headersSent)send(res,error.status??500,{error:{code:error.code??'SERVER_ERROR',message:error.status?error.message:'Internal server error',...(error.current?{current:error.current}:{})}});else res.end();}
    finally{turnPermit?.();await unlock().catch(()=>{});}
  });
  const ready=async()=>{
    const addr=server.address(),api=(sid,operation,parameters,context)=>mocks.call(sid,operation,parameters,context);
    const client=process.env.CRM_BACKEND==='real'?new RealCrmClient():new SimulationHttpClient({origin:`http://127.0.0.1:${addr.port}`,key:mockKey});
    agent=agentFactory?await agentFactory({store,api,client,knowledge,highRiskReads,humanSupport}):new CrmAgent({store,api,client,knowledge,highRiskReads,humanSupport});agent.humanSupport=humanSupport;
    store.onLeaseLost=s=>{if(s?.running)agent.interrupt(s,'ownership_lost');};
  };
  const close=async()=>{
    for(const s of store.sessions.values())if(s.running)agent?.interrupt(s,'server_shutdown');
    for(const res of streams)res.end();
    const closed=new Promise(resolve=>server.close(resolve));await Promise.allSettled([...runs]);server.closeAllConnections();await closed;
    await store.close();await feedback.close();
  };
  return {server,store,mocks,feedback,migration,admission,get agent(){return agent;},ready,view,close};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const config=webConfigFromEnv();const app=await createRoadServer({config});
  app.server.listen(config.port,config.host,async()=>{await app.ready();console.log(`Road PoC listening on ${config.host}:${config.port}`);});
  let stopping=false;const stop=()=>{if(stopping)return;stopping=true;app.close().finally(()=>process.exit(0));setTimeout(()=>process.exit(1),15000).unref();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
