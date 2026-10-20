import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRoadServer} from '../src/road/server.mjs';
import {RoadStore} from '../src/road/store.mjs';
import {FeedbackRepository} from '../src/road/feedback.mjs';
import {mobileStaticFiles,staticContentType} from '../src/road/mobile-static.mjs';

test('mobile presentation is served by the same authenticated app, with exact MIME types and unchanged CSP',async()=>{
  const password='mobile-static-test-only',app=await createRoadServer({store:new RoadStore(),feedback:new FeedbackRepository({connectionString:null}),config:{host:'127.0.0.1',port:10000,access:{password}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();
  const origin='http://127.0.0.1:'+app.server.address().port,headers={authorization:'Basic '+Buffer.from('admin:'+password).toString('base64')};
  try{
    assert.equal((await fetch(origin+'/mobile-client.js')).status,401);
    for(const [path,file]of Object.entries(mobileStaticFiles)){
      const r=await fetch(origin+path,{headers});assert.equal(r.status,200,path);assert.equal(r.headers.get('content-type'),staticContentType(path));
      assert.deepEqual(Buffer.from(await r.arrayBuffer()),await readFile(new URL('../web/road/'+file,import.meta.url)));
      assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.doesNotMatch(r.headers.get('content-security-policy'),/unsafe-inline/);
    }
    for(const path of ['/mobile-reference/not-listed.png','/mobile-reference/%2e%2e%2fapp.js','/mobile-reference/..%2f..%2f.env','/mobile-reference/fonts/unknown.woff2'])assert.equal((await fetch(origin+path,{headers})).status,404,path);
    assert.equal(app.store.sessions.size,0,'Viewing the mobile shell creates no separate session');
  }finally{await app.close();}
});

test('copied mobile styles resolve every image/font locally and contain no reference authentication code',async()=>{
  for(const path of ['mobile-ui.css','mobile-fonts.css']){
    const css=await readFile(new URL('../web/road/'+path,import.meta.url),'utf8');
    for(const m of css.matchAll(/url\(["']?([^)'"\s]+)/g))assert.ok(mobileStaticFiles[m[1]],'Missing local asset '+m[1]);
  }
  const template=await readFile(new URL('../web/road/mobile-template.js',import.meta.url),'utf8');
  assert.doesNotMatch(template,/<script|<iframe|https?:\/\/|access.token|conversation.id|MOI.GOV.SA|otpInput|videoA/i);
});
