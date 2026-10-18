import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {RoadStore,clone,id,failure,interruptSession} from './store.mjs';
import {databasePool} from './database.mjs';

const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value);
const protectedSession=s=>!!s.activeHandoffId&&s.mock.handoffs.some(h=>h.handoff_id===s.activeHandoffId&&!['COMPLETED','CANCELLED'].includes(h.status));
const positive=(value,fallback,min=1,max=86400000)=>{const n=value===undefined?fallback:Number(value);if(!Number.isInteger(n)||n<min||n>max)throw Error(`Session setting must be an integer between ${min} and ${max}`);return n;};
const unavailable=()=>failure('SESSION_STORAGE_UNAVAILABLE','Conversation storage is temporarily unavailable. Please retry.',503);

// PostgreSQL is authoritative; sessions is a bounded, disposable working cache.
// A renewable row lease spans a command/agent turn, never a long SQL transaction.
export class NeonRoadStore extends RoadStore{
  constructor({connectionString=process.env.ROAD_SESSION_DATABASE_URL||process.env.ROAD_FEEDBACK_DATABASE_URL,pool,schema='public',poolSize=5,cacheLimit=128,cacheIdleMs=300000,idleTtlMs=1800000,leaseMs=30000,eventPollMs=2000,maintenanceMs=60000,instanceId=id('instance')}={}){
    super();
    if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema))throw Error('Invalid session database schema');
    if(!pool&&!connectionString)throw Error('Configure ROAD_SESSION_DATABASE_URL or ROAD_FEEDBACK_DATABASE_URL; session storage requires PostgreSQL');
    this.storage='neon';this.pool=pool??databasePool(connectionString,{max:poolSize});this.ownsPool=!pool;this.schema=schema;this.table=`"${schema}".road_sessions`;
    Object.assign(this,{cacheLimit:positive(cacheLimit,128,1,10000),cacheIdleMs:positive(cacheIdleMs,300000),idleTtlMs:positive(idleTtlMs,1800000),leaseMs:positive(leaseMs,30000,300),eventPollMs:positive(eventPollMs,2000,50),maintenanceMs:positive(maintenanceMs,60000,100),instanceId});
    this.records=new Map();this.owned=new Map();this.acquiring=new Set();this.pendingWrites=new Map();this.cursors=new Map();this.closed=false;
  }
  static fromEnv(env=process.env){
    return new NeonRoadStore({connectionString:env.ROAD_SESSION_DATABASE_URL||env.ROAD_FEEDBACK_DATABASE_URL,schema:env.ROAD_SESSION_SCHEMA??'public',poolSize:positive(env.ROAD_SESSION_POOL_SIZE,5,1,50),cacheLimit:env.ROAD_SESSION_CACHE_LIMIT,cacheIdleMs:env.ROAD_SESSION_CACHE_IDLE_MS,idleTtlMs:env.ROAD_SESSION_IDLE_TTL_MS,leaseMs:env.ROAD_SESSION_LEASE_MS,eventPollMs:env.ROAD_SESSION_EVENT_POLL_MS});
  }
  async query(sql,parameters=[]){try{return await this.pool.query(sql,parameters);}catch(error){this.lastErrorCode=error.code??'DATABASE_ERROR';throw unavailable();}}
  async initialize(){
    if(this.ready)return this.ready;
    this.ready=this.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      session_id text PRIMARY KEY,payload jsonb NOT NULL CHECK(payload->>'id'=session_id),version bigint NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_activity_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL,archived_at timestamptz,protected boolean NOT NULL DEFAULT false,
      lease_token text,lease_owner text,lease_until timestamptz);
      CREATE INDEX IF NOT EXISTS road_sessions_expiry_idx ON ${this.table}(expires_at) WHERE archived_at IS NULL AND NOT protected;
      CREATE INDEX IF NOT EXISTS road_sessions_lease_idx ON ${this.table}(lease_until) WHERE lease_token IS NOT NULL;`).then(()=>{
        this.maintenance=setInterval(()=>this.maintain().catch(()=>{}),this.maintenanceMs);this.maintenance.unref();
      }).catch(error=>{this.ready=null;throw error;});
    return this.ready;
  }
  create(){const s=super.create();this.records.set(s.id,{version:0,lastAccess:Date.now(),savedSeq:0});return s;}
  remember(row){
    const s=clone(row.payload),meta={version:Number(row.version),lastAccess:Date.now(),savedSeq:s.events.at(-1)?.seq??0,expiresAt:new Date(row.expires_at).toISOString()};
    this.sessions.delete(s.id);this.sessions.set(s.id,s);this.records.set(s.id,meta);this.evict();return s;
  }
  evict(){
    for(const [sid]of this.sessions){const meta=this.records.get(sid);if(this.owned.has(sid)||this.acquiring.has(sid)||this.pendingWrites.has(sid)||!meta?.version)continue;
      if(this.sessions.size<=this.cacheLimit&&Date.now()-meta.lastAccess<this.cacheIdleMs)continue;
      this.sessions.delete(sid);this.records.delete(sid);this.writes.delete(sid);
    }
  }
  async row(sid){
    if(!validId(sid))throw failure('SESSION_NOT_FOUND','Session not found',404);
    const r=await this.query(`SELECT *,expires_at<=clock_timestamp() AS expired,lease_until>clock_timestamp() AS leased FROM ${this.table} WHERE session_id=$1`,[sid]);
    if(!r.rows[0])throw failure('SESSION_NOT_FOUND','Session not found',404);return r.rows[0];
  }
  async archiveRow(row){
    if(!row.expired||row.protected||row.leased||row.archived_at)return false;
    const s=interruptSession(clone(row.payload));s.status='archived';s.pendingInput=null;const event=this.emit(s,'session_expired',{reason:'idle_timeout'});
    const r=await this.query(`UPDATE ${this.table} SET payload=$3::jsonb,version=version+1,archived_at=clock_timestamp(),lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE session_id=$1 AND version=$2 AND archived_at IS NULL AND NOT protected AND expires_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING session_id`,[s.id,row.version,JSON.stringify(s)]);
    if(r.rowCount){this.broadcast(s.id,[event],Number(row.version)+1);this.sessions.delete(s.id);this.records.delete(s.id);return true;}return false;
  }
  async load(sid){
    const local=this.owned.get(sid),meta=this.records.get(sid);
    if(local&&!local.lost&&meta?.committed)return clone(meta.committed);
    const row=await this.row(sid);
    if(row.archived_at||await this.archiveRow(row))throw failure('SESSION_EXPIRED','This conversation has expired. Start a new conversation.',410);
    if(this.owned.has(sid)){const current=this.records.get(sid);return clone(current.committed??row.payload);}
    if(row.payload.running&&!row.leased){
      try{const lease=await this.acquire(sid,{touch:false});const recovered=clone(lease.session);await lease.release();return recovered;}catch(error){if(error.code!=='BUSY')throw error;return clone((await this.row(sid)).payload);}
    }
    if(row.expired&&!row.protected&&!row.leased)return this.load(sid);
    return this.remember(row);
  }
  owns(sid){const lease=this.owned.get(sid);return !!lease&&!lease.lost;}
  async acquire(sid,{touch=true}={}){
    if(this.owned.has(sid)||this.acquiring.has(sid))throw failure('BUSY','Stop the current turn before another action',409);
    if(!validId(sid))throw failure('SESSION_NOT_FOUND','Session not found',404);
    this.acquiring.add(sid);const token=id('lease');
    try{
      const result=await this.query(`UPDATE ${this.table} SET lease_token=$2,lease_owner=$3,lease_until=clock_timestamp()+$4*interval '1 millisecond' WHERE session_id=$1 AND archived_at IS NULL AND (expires_at>clock_timestamp() OR protected) AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING *`,[sid,token,this.instanceId,this.leaseMs]);
      if(!result.rowCount){const row=await this.row(sid);if(row.archived_at||await this.archiveRow(row))throw failure('SESSION_EXPIRED','This conversation has expired. Start a new conversation.',410);throw failure('BUSY','This conversation is being processed. Please retry shortly.',409);}
      const s=this.remember(result.rows[0]),lease={token,touch,lost:false};this.owned.set(sid,lease);
      lease.timer=setInterval(()=>this.renew(sid).catch(()=>{}),Math.max(100,Math.floor(this.leaseMs/3)));lease.timer.unref();
      if(s.running){interruptSession(s);await this.save(s);}
      return {session:s,release:()=>this.release(sid,token)};
    }catch(error){
      // A failed recovery save must not leave a hidden local owner/timer behind.
      if(this.owned.get(sid)?.token===token)await this.release(sid,token).catch(()=>{});
      throw error;
    }finally{this.acquiring.delete(sid);}
  }
  async renew(sid){
    const lease=this.owned.get(sid);if(!lease||lease.renewing||lease.lost)return;
    lease.renewing=true;
    try{const r=await this.query(`UPDATE ${this.table} SET lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE session_id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() RETURNING session_id`,[sid,lease.token,this.leaseMs]);if(!r.rowCount)throw failure('SESSION_LEASE_LOST','Conversation ownership changed',409);}
    catch{if(this.owned.get(sid)===lease){lease.lost=true;clearInterval(lease.timer);this.onLeaseLost?.(this.sessions.get(sid));}}
    finally{lease.renewing=false;}
  }
  async release(sid,token){
    const lease=this.owned.get(sid);if(!lease||lease.token!==token)return;
    try{await this.flush(sid);}
    finally{
      try{await this.query(`UPDATE ${this.table} SET lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE session_id=$1 AND lease_token=$2`,[sid,token]);}
      finally{clearInterval(lease.timer);this.owned.delete(sid);const meta=this.records.get(sid);if(meta)delete meta.committed;if(lease.lost){this.sessions.delete(sid);this.records.delete(sid);}this.evict();}
    }
  }
  emit(s,type,data={}){const event={seq:s.events.length+1,time:new Date().toISOString(),type,...clone(data)};s.events.push(event);return event;}
  broadcast(sid,events,version){
    for(const event of events)for(const listener of this.listeners.get(sid)??[])try{listener(event);}catch{}
    if(this.listeners.has(sid)){const cursor=this.cursors.get(sid);this.cursors.set(sid,{id:sid,version:Math.max(version,cursor?.version??0),after:Math.max(events.at(-1)?.seq??0,cursor?.after??0)});}
  }
  async save(s){
    const snapshot=clone(s);this.pendingWrites.set(s.id,(this.pendingWrites.get(s.id)??0)+1);
    const next=(this.writes.get(s.id)??Promise.resolve()).catch(()=>{}).then(async()=>{
      const meta=this.records.get(s.id);if(!meta)throw failure('SESSION_CONFLICT','Reload the conversation before changing it',409);
      const lease=this.owned.get(s.id);let r;
      if(meta.version===0){
        r=await this.query(`INSERT INTO ${this.table}(session_id,payload,expires_at,protected) VALUES($1,$2::jsonb,clock_timestamp()+$3*interval '1 millisecond',$4) ON CONFLICT DO NOTHING RETURNING version,expires_at`,[s.id,JSON.stringify(snapshot),this.idleTtlMs,protectedSession(snapshot)]);
      }else{
        if(!lease||lease.lost)throw failure('SESSION_LEASE_LOST','Reload the conversation before changing it',409);
        r=await this.query(`UPDATE ${this.table} SET payload=$4::jsonb,version=version+1,protected=$5,last_activity_at=CASE WHEN $6 THEN clock_timestamp() ELSE last_activity_at END,expires_at=CASE WHEN $6 THEN clock_timestamp()+$7*interval '1 millisecond' ELSE expires_at END WHERE session_id=$1 AND version=$2 AND lease_token=$3 AND lease_until>clock_timestamp() AND archived_at IS NULL RETURNING version,expires_at`,[s.id,meta.version,lease.token,JSON.stringify(snapshot),protectedSession(snapshot),lease.touch,this.idleTtlMs]);
      }
      if(!r.rowCount){if(lease){lease.lost=true;clearInterval(lease.timer);this.onLeaseLost?.(this.sessions.get(s.id));}throw failure('SESSION_CONFLICT','Conversation state changed. Reload before continuing.',409);}
      const events=snapshot.events.filter(e=>e.seq>meta.savedSeq);meta.version=Number(r.rows[0].version);meta.expiresAt=new Date(r.rows[0].expires_at).toISOString();meta.savedSeq=snapshot.events.at(-1)?.seq??0;meta.lastAccess=Date.now();if(lease)meta.committed=snapshot;
      this.broadcast(s.id,events,meta.version);
    }).catch(error=>{
      // A failed first INSERT is not a saved session and must not pin a cache slot.
      if(this.records.get(s.id)?.version===0){this.sessions.delete(s.id);this.records.delete(s.id);}
      throw error;
    }).finally(()=>{const n=this.pendingWrites.get(s.id)-1;if(n)this.pendingWrites.set(s.id,n);else{this.pendingWrites.delete(s.id);if(!this.records.has(s.id))this.writes.delete(s.id);}this.evict();});
    this.writes.set(s.id,next);return next;
  }
  subscribe(sid,listener){
    const unsubscribe=super.subscribe(sid,listener),meta=this.records.get(sid);
    if(!this.cursors.has(sid))this.cursors.set(sid,{id:sid,version:meta?.version??0,after:meta?.savedSeq??0});
    if(!this.eventPoll){this.eventPoll=setInterval(()=>this.syncEvents().catch(()=>{}),this.eventPollMs);this.eventPoll.unref();}
    return()=>{unsubscribe();if(!this.listeners.has(sid))this.cursors.delete(sid);if(!this.listeners.size){clearInterval(this.eventPoll);this.eventPoll=null;}};
  }
  async syncEvents(){
    if(this.polling||!this.cursors.size)return;this.polling=true;
    try{
      const rows=await this.query(`SELECT s.session_id,s.version,COALESCE((SELECT jsonb_agg(e ORDER BY (e->>'seq')::bigint) FROM jsonb_array_elements(s.payload->'events') e WHERE (e->>'seq')::bigint>w.after),'[]'::jsonb) AS events FROM ${this.table} s JOIN jsonb_to_recordset($1::jsonb) AS w(id text,version bigint,after bigint) ON s.session_id=w.id WHERE s.version>w.version`,[JSON.stringify([...this.cursors.values()])]);
      for(const row of rows.rows)this.broadcast(row.session_id,row.events,Number(row.version));
    }finally{this.polling=false;}
  }
  view(s){const meta=this.records.get(s.id);return {...super.view(s),session:{storage:'neon',version:meta?.version??null,expires_at:meta?.expiresAt??null}};}
  async maintain(){
    if(this.maintaining||this.closed)return;this.maintaining=true;
    try{const r=await this.query(`SELECT session_id FROM ${this.table} WHERE archived_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND ((expires_at<=clock_timestamp() AND NOT protected) OR payload->>'running'='true') ORDER BY expires_at LIMIT 100`);for(const {session_id}of r.rows)await this.load(session_id).catch(error=>{if(error.code!=='SESSION_EXPIRED'&&error.code!=='BUSY')throw error;});this.evict();}finally{this.maintaining=false;}
  }
  async importDirectory(directory){
    let files;try{files=await readdir(directory);}catch(error){if(error.code==='ENOENT')return {imported:0,existing:0};throw error;}
    let imported=0,existing=0;
    for(const file of files){
      if(!file.endsWith('.json'))continue;
      const s=JSON.parse(await readFile(join(directory,file),'utf8'));if(!validId(s.id)||file!==`${s.id}.json`||!Array.isArray(s.messages)||!Array.isArray(s.events)||!Array.isArray(s.plans)||!s.mock)throw Error('Invalid legacy session file');
      // Migration never resurrects old submissions or an interrupted agent turn.
      if(s.running||s.pendingOperation||Object.keys(s.authorizations??{}).length)interruptSession(s);
      const r=await this.query(`INSERT INTO ${this.table}(session_id,payload,expires_at,protected,created_at) VALUES($1,$2::jsonb,clock_timestamp()+$3*interval '1 millisecond',$4,$5) ON CONFLICT DO NOTHING RETURNING session_id`,[s.id,JSON.stringify(s),this.idleTtlMs,protectedSession(s),s.createdAt]);
      if(r.rowCount)imported++;else existing++;
    }
    return {imported,existing};
  }
  stats(){return {storage:this.storage,cached_sessions:this.sessions.size,owned_sessions:this.owned.size,event_subscriptions:[...this.listeners.values()].reduce((n,s)=>n+s.size,0),pool_total:this.pool.totalCount,pool_idle:this.pool.idleCount,pool_waiting:this.pool.waitingCount};}
  async close(){
    this.closed=true;clearInterval(this.maintenance);clearInterval(this.eventPoll);
    await Promise.allSettled([...this.owned].map(([sid,l])=>this.release(sid,l.token)));await super.close();if(this.ownsPool)await this.pool.end();
  }
}
