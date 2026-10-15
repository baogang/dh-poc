import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRoadServer } from '../src/road/server.mjs';
import { RoadStore } from '../src/road/store.mjs';

test('diagram URL serves both figures after website login with valid scoped styles and no chat session',async()=>{
  const password='diagram-test-only-password';
  const app=await createRoadServer({store:new RoadStore(),config:{port:10000,host:'127.0.0.1',access:{password}}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));await app.ready();
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const headers={authorization:'Basic '+Buffer.from('admin:'+password).toString('base64')};
  try{
    let response=await fetch(origin+'/docs/road-agent-flow.html');assert.equal(response.status,401);
    response=await fetch(origin+'/docs/road-agent-flow.html',{headers});assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/^text\/html; charset=utf-8$/);
    const html=await response.text(),policy=response.headers.get('content-security-policy');
    assert.equal([...html.matchAll(/<svg\b/g)].length,2);
    assert.match(html,/id="overview"/);assert.match(html,/id="execution"/);
    assert.equal(/\sstyle\s*=/.test(html),false);assert.equal(/<script\b/i.test(html),false);
    const styles=[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];assert(styles.length>0);
    for(const match of styles){const hash=createHash('sha256').update(match[1]).digest('base64');assert(policy.includes("'sha256-"+hash+"'"));}
    assert(policy.includes('https://fonts.googleapis.com'));assert(policy.includes('font-src https://fonts.gstatic.com'));
    assert(policy.includes("script-src 'none'"));assert(policy.includes("style-src-attr 'none'"));assert(!policy.includes("'unsafe-inline'"));
    assert.equal(app.store.sessions.size,0);
    response=await fetch(origin+'/',{headers});assert.equal(response.status,200);assert(response.headers.get('content-security-policy').includes("style-src 'self'"));
    response=await fetch(origin+'/docs/road-pothole-pi-poc.md',{headers});assert.equal(response.status,404);
  }finally{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}
});
