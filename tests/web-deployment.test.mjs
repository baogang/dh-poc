import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWebServer } from '../src/web-server.mjs';
import { webConfigFromEnv } from '../src/web-access.mjs';

const origin='https://poc-example.onrender.com';
const password='test-only-password-123456';
const authorization='Basic '+Buffer.from('admin:'+password).toString('base64');
const store={validateEngineering:{schema:{}},list:()=>[],preview:payload=>({valid:true,name:payload.name})};
const models={ids:['deepseek-flash'],defaultEmotion:'deepseek-flash',defaultPlanner:'deepseek-flash'};
let app,port,csrf;
function request(path,{method='GET',headers={},payload}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request({host:'127.0.0.1',port,path,method,headers:{Host:new URL(origin).host,Connection:'close',...headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));
  });req.on('error',reject);req.end(payload===undefined?undefined:JSON.stringify(payload));
 });
}
test.before(async()=>{
 app=await createWebServer({store,models,jobs:{},access:{publicOrigin:origin,password}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));port=app.server.address().port;
 csrf=JSON.parse((await request('/api/catalog',{headers:{Authorization:authorization}})).text).csrf;
});
test.after(async()=>{await new Promise(resolve=>app.server.close(resolve));});

test('deployment config uses Render port and origin while keeping local defaults',()=>{
 const local=webConfigFromEnv({});assert.equal(local.host,'127.0.0.1');assert.equal(local.port,8787);assert.equal(local.access.publicOrigin,null);
 const render=webConfigFromEnv({PORT:'10000',POC_WEB_PORT:'8788',RENDER_EXTERNAL_URL:origin,POC_AUTH_PASSWORD:password});
 assert.equal(render.port,10000);assert.equal(render.host,'0.0.0.0');assert.equal(render.access.publicOrigin,origin);
 const custom=webConfigFromEnv({RENDER_EXTERNAL_URL:origin,POC_PUBLIC_ORIGIN:'https://demo.example.com',POC_AUTH_PASSWORD:password});assert.equal(custom.access.publicOrigin,'https://demo.example.com');
});
test('public deployment fails before startup for missing protection or invalid settings',()=>{
 for(const env of [
  {POC_WEB_HOST:'0.0.0.0'},
  {RENDER_EXTERNAL_URL:origin},
  {RENDER_EXTERNAL_URL:origin,POC_AUTH_PASSWORD:'short'},
  {RENDER_EXTERNAL_URL:origin,POC_AUTH_PASSWORD:password,POC_AUTH_USERNAME:'admin:other'},
  {POC_PUBLIC_ORIGIN:'http://demo.example.com',POC_AUTH_PASSWORD:password},
  {POC_PUBLIC_ORIGIN:'https://demo.example.com/path',POC_AUTH_PASSWORD:password},
  {POC_PUBLIC_ORIGIN:'https://user:pass@demo.example.com',POC_AUTH_PASSWORD:password},
  {POC_PUBLIC_ORIGIN:'https://demo.example.com?x=1',POC_AUTH_PASSWORD:password},
  {PORT:'80'},{PORT:'65536'},{PORT:'abc'},{POC_WEB_HOST:'bad-host'}
 ])assert.throws(()=>webConfigFromEnv(env));
});
test('public UI, catalog and write endpoints require the website password',async()=>{
 for(const path of ['/','/app.js','/api/catalog','/api/datasets','/api/runs']){
  const r=await request(path);assert.equal(r.status,401);assert.match(r.headers['www-authenticate'],/^Basic /);assert.equal(r.headers['cache-control'],'no-store');assert(!r.text.includes(password));
 }
 for(const value of ['Basic invalid!','Bearer something','Basic '+Buffer.from('other:'+password).toString('base64'),'Basic '+Buffer.from('admin:wrong-password').toString('base64')]){
  assert.equal((await request('/api/catalog',{headers:{Authorization:value}})).status,401);
 }
 assert.equal((await request('/api/import/preview',{method:'POST',payload:{},headers:{'Content-Type':'application/json','X-POC-CSRF':csrf,Origin:origin}})).status,401);
 const catalog=await request('/api/catalog',{headers:{Authorization:authorization}});assert.equal(catalog.status,200);assert(!catalog.text.includes(password));assert(!catalog.text.includes(authorization));
 assert.equal((await request('/',{headers:{Authorization:authorization}})).status,200);
});
test('health check is unauthenticated and contains only readiness',async()=>{
 const r=await request('/healthz',{headers:{Host:'internal-render-probe'}});assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.text),{status:'ok'});
 assert.equal((await request('/healthz/api/catalog')).status,401);
});
test('public POST accepts the configured HTTPS origin behind a proxy and keeps CSRF',async()=>{
 const headers={Authorization:authorization,'Content-Type':'application/json','X-POC-CSRF':csrf,Origin:origin,'X-Forwarded-Proto':'https'};
 const r=await request('/api/import/preview',{method:'POST',headers,payload:{name:'proxy-test'}});assert.equal(r.status,200);assert.equal(JSON.parse(r.text).name,'proxy-test');
 for(const replacement of [{Origin:'https://evil.example'},{Origin:'http://poc-example.onrender.com'},{'X-POC-CSRF':'wrong'},{'Content-Type':'text/plain'}]){
  assert.equal((await request('/api/import/preview',{method:'POST',headers:{...headers,...replacement},payload:{}})).status,403);
 }
});
test('untrusted Host, forwarded headers and absolute request URLs cannot bypass origin checks',async()=>{
 assert.equal((await request('/api/catalog',{headers:{Authorization:authorization,Host:'evil.example','X-Forwarded-Host':new URL(origin).host}})).status,403);
 assert.equal((await request('/api/import/preview',{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json','X-POC-CSRF':csrf,Origin:'https://evil.example','X-Forwarded-Host':'evil.example','X-Forwarded-Proto':'https'},payload:{}})).status,403);
 assert.equal((await request('https://evil.example/api/catalog',{headers:{Authorization:authorization}})).status,400);
 assert.equal((await request('//evil.example/api/catalog',{headers:{Authorization:authorization}})).status,400);
});
