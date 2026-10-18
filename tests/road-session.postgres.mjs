import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {databasePool} from '../src/road/database.mjs';
import {NeonRoadStore} from '../src/road/neon-store.mjs';
import {RoadStore} from '../src/road/store.mjs';
import {createRoadServer} from '../src/road/server.mjs';
import {FeedbackRepository} from '../src/road/feedback.mjs';
import {RoadAgent} from '../src/road/agent.mjs';
import {controlledSession} from '../src/road/runtime.mjs';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';

const url=process.env.ROAD_SESSION_DATABASE_URL||process.env.ROAD_FEEDBACK_DATABASE_URL;
test('Neon session persistence, ownership, recovery, lifecycle and real HTTP commands',{skip:!url},async t=>{
  const schema='sessions_test_'+randomUUID().replaceAll('-',''),pool=databasePool(url),stores=[],apps=[];
  const make=options=>{const store=new NeonRoadStore({pool,schema,cacheLimit:4,...options});stores.push(store);return store;};
  let a,b,first;
  try{
    await pool.query(`CREATE SCHEMA "${schema}"`);a=make();b=make();await a.initialize();await b.initialize();
    await t.test('more than 100 durable sessions do not accumulate in the working cache',async()=>{
      for(let batch=0;batch<11;batch++)await Promise.all(Array.from({length:10},async()=>{const s=a.create();s.csrf='csrf-'+randomUUID();await a.save(s);first??=s.id;}));
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".road_sessions`)).rows[0].n,110);
      assert(a.sessions.size<=4);assert.equal(b.sessions.size,0);assert.equal((await b.load(first)).id,first);
    });
    await t.test('messages, identity, plans, receipts, answer snapshots and exact proposals survive a new store',async()=>{
      const {session:s,release}=await a.acquire(first);
      s.user={user_id:'U001'};s.facts={address:{city:'Riyadh',street:'Test'}};s.activePlanId='plan-1';s.plans=[{id:'plan-1',approved:true,status:'approved',steps:[]}];
      s.pendingOperation={id:'proposal-1',epoch:s.epoch,plan_id:'plan-1'};s.receipts=[{id:'receipt-1',result:{success:true}}];s.answerSnapshots={'answer-1':{question:'Question',answer:'Answer'}};
      a.message(s,'user','Keep this history');await a.save(s);await release();
      const c=make();await c.initialize();assert.equal(c.sessions.size,0);const restored=await c.load(first);
      assert.equal(restored.user.user_id,'U001');assert.equal(restored.messages.at(-1).text,'Keep this history');assert.equal(restored.pendingOperation.id,'proposal-1');assert.equal(restored.answerSnapshots['answer-1'].answer,'Answer');assert.equal(restored.receipts[0].id,'receipt-1');
    });
    await t.test('one row lease permits only one writer and rejects unleased stale state',async()=>{
      const stale=await b.load(first),lease=await a.acquire(first);await assert.rejects(b.acquire(first),{code:'BUSY'});
      stale.facts.address.city='Wrong';await assert.rejects(b.save(stale),{code:'SESSION_LEASE_LOST'});
      lease.session.facts.address.city='Correct';await a.save(lease.session);await lease.release();assert.equal((await b.load(first)).facts.address.city,'Correct');
    });
    await t.test('events become visible only after commit and replay across stores',async()=>{
      await b.load(first);const received=[],unsubscribe=b.subscribe(first,event=>received.push(event));
      const lease=await a.acquire(first);const e=a.message(lease.session,'assistant','Committed event');assert.equal(received.length,0);await b.syncEvents();assert.equal(received.length,0);
      await a.save(lease.session);await lease.release();await b.syncEvents();assert(received.some(x=>x.message?.id===e.id));const n=received.length;await b.syncEvents();assert.equal(received.length,n);unsubscribe();
    });
    await t.test('renewal keeps a long-running owner exclusive beyond its original lease TTL',async()=>{
      const owner=make({leaseMs:1500}),other=make();await owner.initialize();await other.initialize();const s=owner.create();await owner.save(s);const lease=await owner.acquire(s.id);
      await new Promise(r=>setTimeout(r,2300));await assert.rejects(other.acquire(s.id),{code:'BUSY'});assert.equal(owner.owns(s.id),true);
      owner.message(lease.session,'user','Still the same owner');await owner.save(lease.session);await lease.release();assert.equal((await other.load(s.id)).messages.at(-1).text,'Still the same owner');
    });
    await t.test('an expired owner recovers interrupted turns and cannot overwrite the new epoch',async()=>{
      const s=a.create();await a.save(s);const old=await a.acquire(s.id);old.session.running=true;old.session.status='running';old.session.authorizations={old:{epoch:0}};old.session.pendingOperation={id:'old'};
      old.session.plans=[{id:'p',approved:true,status:'approved',steps:[{id:'c',status:'running'}]}];old.session.activePlanId='p';await a.save(old.session);clearInterval(a.owned.get(s.id).timer);
      await pool.query(`UPDATE "${schema}".road_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE session_id=$1`,[s.id]);
      const recovered=await b.load(s.id);assert.equal(recovered.running,false);assert.equal(recovered.status,'interrupted');assert.equal(recovered.epoch,1);assert.deepEqual(recovered.authorizations,{});assert.equal(recovered.pendingOperation,null);assert.equal(recovered.plans[0].approved,false);
      old.session.facts.overwrite='forbidden';await assert.rejects(a.save(old.session),{code:'SESSION_CONFLICT'});await old.release().catch(()=>{});assert.equal((await b.load(s.id)).facts.overwrite,undefined);
    });
    await t.test('polling never refreshes idle expiry; expiry archives history and revokes proposals',async()=>{
      const before=(await pool.query(`SELECT last_activity_at,expires_at FROM "${schema}".road_sessions WHERE session_id=$1`,[first])).rows[0];await b.load(first);
      const after=(await pool.query(`SELECT last_activity_at,expires_at FROM "${schema}".road_sessions WHERE session_id=$1`,[first])).rows[0];assert.equal(+before.last_activity_at,+after.last_activity_at);assert.equal(+before.expires_at,+after.expires_at);
      await pool.query(`UPDATE "${schema}".road_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1`,[first]);await assert.rejects(b.load(first),{code:'SESSION_EXPIRED'});
      const row=(await pool.query(`SELECT payload,archived_at FROM "${schema}".road_sessions WHERE session_id=$1`,[first])).rows[0];assert(row.archived_at);assert.equal(row.payload.pendingOperation,null);assert.deepEqual(row.payload.authorizations,{});assert(row.payload.messages.length>0);await assert.rejects(a.acquire(first),{code:'SESSION_EXPIRED'});
    });
    await t.test('waiting and accepted human conversations are protected from idle archival',async()=>{
      const s=a.create();s.activeHandoffId='human-1';s.mock.handoffs=[{handoff_id:'human-1',scope:'conversation',status:'WAITING',messages:[{text:'Keep this handoff'}]}];await a.save(s);
      await pool.query(`UPDATE "${schema}".road_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1`,[s.id]);await b.maintain();assert.equal((await b.load(s.id)).mock.handoffs[0].messages[0].text,'Keep this handoff');
    });
    await t.test('legacy JSON migration preserves IDs and history, is repeatable and revokes old approvals',async()=>{
      const dir=await mkdtemp(join(tmpdir(),'road-session-import-'));
      try{const old=new RoadStore(dir);await old.initialize();const s=old.create();s.csrf='original-csrf';s.pendingOperation={id:'untrusted-old-approval'};s.authorizations={old:{epoch:0}};old.message(s,'user','Legacy history');await old.save(s);
        assert.deepEqual(await a.importDirectory(dir),{imported:1,existing:0});assert.deepEqual(await a.importDirectory(dir),{imported:0,existing:1});const next=await b.load(s.id);assert.equal(next.csrf,s.csrf);assert.equal(next.messages[0].text,'Legacy history');assert.equal(next.pendingOperation,null);assert.deepEqual(next.authorizations,{});
      }finally{await rm(dir,{recursive:true,force:true});}
    });
    await t.test('database failure is explicit and never falls back to a new empty session',async()=>{
      const broken=new NeonRoadStore({pool:{query:async()=>{throw Error('offline');}},schema});await assert.rejects(broken.load('session-missing'),{code:'SESSION_STORAGE_UNAVAILABLE'});assert.equal(broken.sessions.size,0);
      const s=broken.create();await assert.rejects(broken.save(s),{code:'SESSION_STORAGE_UNAVAILABLE'});assert.equal(broken.sessions.size,0);assert.equal(broken.records.size,0);assert.equal(broken.writes.size,0);
    });
    await t.test('HTTP refresh and a replacement server recover the same cookie, login and answers',async()=>{
      const knowledge={document:{name:'test'},entries:[],answer:async()=>({answer:'Persisted FAQ answer',entry:{id:'FAQ-TEST',question:'Test',source_scope:'test'}})};
      const create=async()=>{const app=await createRoadServer({store:make(),knowledge,feedback:new FeedbackRepository({connectionString:null}),config:{port:10000,host:'127.0.0.1',access:{}},maxTurns:1,maxStreams:1});apps.push(app);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();return app;};
      let app=await create(),origin='http://127.0.0.1:'+app.server.address().port;
      const response=await fetch(origin+'/api/session',{method:'POST'}),initial=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];assert.equal(response.status,201);
      const post=(base,path,data)=>fetch(base+path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':initial.csrf},body:JSON.stringify(data)});
      assert.equal((await post(origin,'/api/login',{username:'demo',password:'demo'})).status,200);
      assert.equal((await post(origin,'/api/chat',{message:'An exact FAQ question'})).status,202);
      for(let i=0;app.admission.turns&&i<100;i++)await new Promise(r=>setTimeout(r,50));assert.equal(app.admission.turns,0);
      await app.close();apps.splice(apps.indexOf(app),1);app=await create();origin='http://127.0.0.1:'+app.server.address().port;
      const restored=await(await fetch(origin+'/api/state',{headers:{cookie}})).json();assert.equal(restored.id,initial.id);assert.equal(restored.user.user_id,'U001');assert.equal(restored.messages.at(-1).text,'Persisted FAQ answer');assert.equal(restored.session.storage,'neon');assert(restored.messages.at(-1).rateable);
      const controller=new AbortController(),stream=await fetch(origin+'/api/events',{headers:{cookie},signal:controller.signal});assert.equal(stream.status,200);const excess=await fetch(origin+'/api/events',{headers:{cookie}});assert.equal(excess.status,429);
      await pool.query(`UPDATE "${schema}".road_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1`,[initial.id]);assert.equal((await fetch(origin+'/api/state',{headers:{cookie}})).status,410);
      const timeout=setTimeout(()=>controller.abort(),5000);try{assert.match(await stream.text(),/session_expired/);}finally{clearTimeout(timeout);controller.abort();}
    });
    await t.test('HTTP admission limits simultaneous turns without limiting saved sessions',async()=>{
      let releaseWork,started;const began=new Promise(r=>started=r),work=new Promise(r=>releaseWork=r);
      const knowledge={document:{name:'test'},entries:[],answer:async()=>{started();await work;return {answer:'Done',entry:{id:'FAQ-TEST',question:'Test',source_scope:'test'}};}};
      const app=await createRoadServer({store:make(),knowledge,feedback:new FeedbackRepository({connectionString:null}),config:{port:10000,host:'127.0.0.1',access:{}},maxTurns:1});apps.push(app);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();const base='http://127.0.0.1:'+app.server.address().port;
      const sessions=await Promise.all([1,2].map(async()=>{const r=await fetch(base+'/api/session',{method:'POST'});return {state:await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};}));
      const post=s=>fetch(base+'/api/chat',{method:'POST',headers:{cookie:s.cookie,'content-type':'application/json','x-csrf-token':s.state.csrf},body:JSON.stringify({message:'Test'})});
      assert.equal((await post(sessions[0])).status,202);await began;const duplicate=await post(sessions[0]);assert.equal(duplicate.status,409);const crowded=await post(sessions[1]);assert.equal(crowded.status,429);assert.equal(crowded.headers.get('retry-after'),'2');releaseWork();
      for(let i=0;app.admission.turns&&i<100;i++)await new Promise(r=>setTimeout(r,50));assert.equal(app.admission.turns,0);assert.equal((await post(sessions[1])).status,202);
    });
    await t.test('an exact HITL proposal resumes on a replacement server and commits only one mock write',async()=>{
      const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'}),queue=[];
      const knowledge={document:{name:'test'},entries:[],answer:async()=>null};let sid;
      const create=async()=>{const app=await createRoadServer({store:make(),knowledge,feedback:new FeedbackRepository({connectionString:null}),config:{port:10000,host:'127.0.0.1',access:{}},agentFactory:({store,api})=>new RoadAgent({store,api,knowledge,emotion:{assess:async input=>({status:'classified',sentiment:'neutral',message_id:input.current_message_id})},runtimeFactory:options=>controlledSession({...options,fauxResponses:queue.shift()})})});apps.push(app);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.ready();return app;};
      let app=await create(),origin='http://127.0.0.1:'+app.server.address().port;
      const initial=await fetch(origin+'/api/session',{method:'POST'}),state=await initial.json(),cookie=initial.headers.get('set-cookie').split(';')[0];sid=state.id;
      const post=(path,data)=>fetch(origin+path,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':state.csrf},body:JSON.stringify(data)});
      const idle=async()=>{for(let i=0;app.admission.turns&&i<200;i++)await new Promise(r=>setTimeout(r,50));assert.equal(app.admission.turns,0);return app.store.load(sid);};
      assert.equal((await post('/api/login',{username:'demo',password:'demo'})).status,200);const loggedIn=await app.store.load(sid),args={step_id:'create',address:loggedIn.user.registeredAddress,description:'Neon integration pothole'};
      queue.push([call('propose_plan',{goal:'Report pothole',summary:'Create and respond',steps:[{id:'create',title:'Create',capability:'create_ticket',depends_on:[],parameters:{}},{id:'respond',title:'Respond',capability:'respond',depends_on:['create'],parameters:{}}]}),call('create_ticket',args)]);
      assert.equal((await post('/api/chat',{message:'Please report a pothole at my registered address.'})).status,202);const proposal=(await idle()).pendingOperation;assert(proposal);assert.equal((await app.store.load(sid)).mock.tickets.length,3);
      await app.close();apps.splice(apps.indexOf(app),1);app=await create();origin='http://127.0.0.1:'+app.server.address().port;
      queue.push([call('create_ticket',args),()=>call('finish',{state:'completed',message:'Done',receipt_ids:app.store.get(sid).receipts.map(r=>r.id)})]);
      assert.equal((await post('/api/approve-operation',{proposal_id:proposal.id})).status,202);const final=await idle();assert.equal(final.status,'completed');assert.equal(final.mock.tickets.length,4);assert.equal(final.receipts.filter(r=>r.operation==='create_ticket').length,1);assert.equal(final.pendingOperation,null);
      const duplicate=await post('/api/approve-operation',{proposal_id:proposal.id});assert.equal(duplicate.status,409);assert.equal((await app.store.load(sid)).mock.tickets.length,4);
    });
  }finally{
    await Promise.allSettled(apps.map(app=>app.close()));await Promise.allSettled(stores.map(store=>store.close()));await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await pool.end();
  }
});
