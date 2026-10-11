import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore,InMemoryModelsStore } from '@earendil-works/pi-ai';
import { DatasetStore,MODULES,MODULE_INPUTS } from './web-data.mjs';
import { JobManager } from './web-jobs.mjs';
import { DEFAULT_REGISTRY } from './capability-registry.mjs';
import { redact } from './util.mjs';
import { createWebAccess,webConfigFromEnv } from './web-access.mjs';
const assets={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>11*1024*1024)throw Object.assign(new Error('请求超过 11 MB'),{status:413});chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('请求应为合法 JSON');}}
const bounded=(value,def,max)=>{const n=value===null?def:Number(value);return Number.isInteger(n)&&n>=0?Math.min(n,max):def;};
export async function createWebServer({store,models,jobs,access}={}){
 const gate=createWebAccess(access);
 if(!store){store=new DatasetStore();await store.initialize();}
 if(!models){const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});models={ids:runtime.getModels('deepseek').map(m=>m.id),defaultEmotion:process.env.EMOTION_MODEL??process.env.DEEPSEEK_MODEL??'deepseek-flash',defaultPlanner:process.env.PLANNER_MODEL??process.env.DEEPSEEK_MODEL??'deepseek-flash'};}
 if(!jobs){jobs=new JobManager(store,models);await jobs.initialize();}
 const csrf=randomBytes(24).toString('hex');
 const server=http.createServer(async(req,res)=>{
  const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(redact(value)));};
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  try{
   if(req.method==='GET'&&req.url==='/healthz'){json(200,{status:'ok'});return;}
   const port=server.address()?.port;
   const origin=gate.originFor(req,port);
   if(!gate.authenticated(req)){res.setHeader('WWW-Authenticate','Basic realm="SENTRA POC", charset="UTF-8"');json(401,{error:'请输入网站访问账号和密码'});return;}
   if(!req.url.startsWith('/')||req.url.startsWith('//'))throw Object.assign(new Error('无效请求路径'),{status:400});
   const url=new URL(req.url,origin),parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent),q=url.searchParams;
   if(req.method!=='GET'){
    if(req.headers['x-poc-csrf']!==csrf||req.headers['content-type']?.split(';')[0]!=='application/json'||(req.headers.origin&&req.headers.origin!==origin))throw Object.assign(new Error('请从网站页面提交操作'),{status:403});
   }
   if(req.method==='GET'&&assets[url.pathname]){const file=assets[url.pathname],data=await readFile(new URL('../web/'+file,import.meta.url));res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-cache'});res.end(data);return;}
   if(req.method==='GET'&&url.pathname==='/api/catalog'){
    const plugins=await Promise.all(DEFAULT_REGISTRY.plugins.map(async({skillPath,manifestPath,...p})=>({...p,skill:await readFile(skillPath,'utf8')})));
    json(200,{modules:MODULES.map(m=>({...m,input_schema:m.id==='engineering'?store.validateEngineering.schema:MODULE_INPUTS[m.id]})),plugins,registry_hash:DEFAULT_REGISTRY.hash,models:{...models,provider:'deepseek',credential_configured:!!process.env.DEEPSEEK_API_KEY,catalog_source:'pinned Pi SDK 1.1.0'},datasets:store.list(),csrf,knowledge_base:false});return;
   }
   if(req.method==='GET'&&url.pathname==='/api/datasets'){json(200,store.list());return;}
   if(req.method==='GET'&&parts[0]==='api'&&parts[1]==='datasets'&&parts.length===3){const d=store.get(parts[2]);json(200,{dataset:store.list().find(x=>x.id===d.id),...store.cases(d.id,{q:q.get('q')??'',split:q.get('split')??'all',language:q.get('language')??'all',offset:bounded(q.get('offset'),0,5000),limit:bounded(q.get('limit'),25,100)})});return;}
   if(req.method==='GET'&&url.pathname==='/api/template'){
    const module=q.get('module'),format=q.get('format')??'json',data=await store.template(module,q.get('gold')!=='false',format);res.writeHead(200,{'Content-Type':format==='jsonl'?'application/x-ndjson; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="${module}-${q.get('gold')==='false'?'input-only':'with-reference'}.${format==='jsonl'?'jsonl':'json'}"`});res.end(data);return;
   }
   if(req.method==='POST'&&url.pathname==='/api/import/preview'){const p=store.preview(await body(req));delete p.envelope;json(200,p);return;}
   if(req.method==='POST'&&url.pathname==='/api/import/commit'){json(201,await store.commit(await body(req)));return;}
   if(req.method==='POST'&&url.pathname==='/api/runs'){json(202,await jobs.start(await body(req)));return;}
   if(req.method==='GET'&&url.pathname==='/api/runs'){json(200,await jobs.history());return;}
   if(parts[0]==='api'&&parts[1]==='runs'&&parts[2]){
    if(req.method==='GET'&&parts.length===3){json(200,await jobs.detail(parts[2]));return;}
    if(req.method==='POST'&&parts.length===4&&parts[3]==='cancel'){json(200,await jobs.cancel(parts[2]));return;}
    if(req.method==='GET'&&parts.length===5&&parts[3]==='cases'){json(200,await jobs.case(parts[2],parts[4]));return;}
    if(req.method==='GET'&&parts.length===5&&parts[3]==='download'){
     const data=await jobs.download(parts[2],parts[4]);res.writeHead(200,{'Content-Type':parts[4].endsWith('.md')?'text/markdown; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="${parts[2]}-${parts[4]}"`});res.end(data);return;
    }
   }
   throw Object.assign(new Error('页面或记录不存在'),{status:404});
  }catch(error){json(error.status??(error.code==='ENOENT'?404:400),{error:error.message,details:error.details});}
 });
 server.requestTimeout=30000;server.headersTimeout=15000;
 return {server,store,jobs,models};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const {port,host,access}=webConfigFromEnv();
 const app=await createWebServer({access});app.server.listen(port,host,()=>console.log(`SENTRA Web: ${access.publicOrigin??`http://${host}:${port}`} · 数据、任务和报告保存在服务端文件系统`));
 app.server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'端口已占用，请设置 POC_WEB_PORT 后重试':error.message);process.exitCode=1;});
 let stopping=false;async function stop(){if(stopping)return;stopping=true;app.server.close();await app.jobs.shutdown();process.exit(0);}process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
