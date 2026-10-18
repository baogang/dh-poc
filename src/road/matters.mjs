import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {id,clone,failure,digest} from './store.mjs';

// A short account transaction holds only JSON work, never a model/network call.
// Mock login is the identity boundary for this demo, not production authentication.
export class RoadAccounts {
  constructor(store){this.store=store;store.accountData??=new Map();store.accountWrites??=new Map();this.table=`"${store.schema??'public'}".road_accounts`;}
  async initialize(){
    if(this.store.pool){this.store.accountReady??=this.store.query(`CREATE TABLE IF NOT EXISTS ${this.table}(user_id text PRIMARY KEY,payload jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`).catch(e=>{this.store.accountReady=null;throw e;});await this.store.accountReady;}
  }
  async update(userId,fn){
    if(!['U001','U002','U003'].includes(userId))throw failure('LOGIN_REQUIRED','Use the mock login first',401);
    await this.initialize();
    if(this.store.pool){
      let client;try{client=await this.store.pool.connect();}catch{throw failure('MATTERS_UNAVAILABLE','Saved matters are temporarily unavailable',503);}
      try{await client.query('BEGIN');await client.query(`INSERT INTO ${this.table}(user_id,payload) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING`,[userId,JSON.stringify(emptyAccount())]);const row=await client.query(`SELECT payload FROM ${this.table} WHERE user_id=$1 FOR UPDATE`,[userId]);const account=row.rows[0].payload,result=fn(account);await client.query(`UPDATE ${this.table} SET payload=$2::jsonb,updated_at=clock_timestamp() WHERE user_id=$1`,[userId,JSON.stringify(account)]);await client.query('COMMIT');return clone(result);}
      catch(e){await client.query('ROLLBACK').catch(()=>{});if(e.status)throw e;throw failure('MATTERS_UNAVAILABLE','Saved matters are temporarily unavailable',503);}finally{client.release();}
    }
    const next=(this.store.accountWrites.get(userId)??Promise.resolve()).catch(()=>{}).then(async()=>{
      let account=this.store.accountData.get(userId);
      if(!account&&this.store.directory){try{account=JSON.parse(await readFile(join(this.store.directory,'accounts',`${userId}.json`),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
      account=clone(account??emptyAccount());const result=fn(account);
      if(this.store.directory){const dir=join(this.store.directory,'accounts');await mkdir(dir,{recursive:true});const path=join(dir,`${userId}.json`);await writeFile(path+'.tmp',JSON.stringify(account),{mode:0o600});await rename(path+'.tmp',path);}
      this.store.accountData.set(userId,account);return clone(result);
    });this.store.accountWrites.set(userId,next);return next;
  }
}
export const emptyAccount=()=>({initialized:false,tickets:[],complaints:[],handoffs:[],idempotency:{},drafts:[],timeline:[],notifications:[]});
export function recordChange(account,{ticket_id,kind,status,reference_id,time=new Date().toISOString()}){
  const event={id:id('change'),ticket_id,kind,status,reference_id,time,source_type:'mock'};account.timeline.push(event);account.notifications.push({...event,read:false});return event;
}
export function copyAccountToSession(s,a){const merge=(old,items,key)=>items.map(x=>{const current=old.find(y=>y[key]===x[key]);return current?Object.assign(current,clone(x)):clone(x);});s.mock.tickets=merge(s.mock.tickets,a.tickets,'ticket_id');s.mock.complaints=merge(s.mock.complaints,a.complaints,'complaint_id');s.mock.handoffs=[...s.mock.handoffs.filter(h=>h.scope==='conversation'),...merge(s.mock.handoffs,a.handoffs,'handoff_id')];}
export class RoadMatters {
  constructor(store){this.store=store;this.accounts=new RoadAccounts(store);}
  owner(s){if(!s.user)throw failure('LOGIN_REQUIRED','Sign in to see your saved matters',401);return s.user.user_id;}
  async list(s){return this.accounts.update(this.owner(s),a=>{if(!a.initialized&&s.mock.tickets.length){a.initialized=true;a.tickets=clone(s.mock.tickets);a.complaints=clone(s.mock.complaints);a.handoffs=clone(s.mock.handoffs.filter(h=>h.scope!=='conversation'));}return {drafts:clone(a.drafts),tickets:clone(a.tickets),timeline:clone(a.timeline),notifications:clone(a.notifications)};});}
  async draft(s,parameters,{draftId,version}={}){
    const userId=this.owner(s);return this.accounts.update(userId,a=>{
      let d=draftId?a.drafts.find(d=>d.id===draftId):null;
      if(draftId&&(!d||d.version!==version||d.status!=='draft'))throw failure('STALE_DRAFT','This draft has changed. Reload My matters.',409);
      if(!d){d={id:id('draft'),version:0,status:'draft',created_at:new Date().toISOString(),service:'road-pothole'};a.drafts.push(d);}
      d.version++;d.parameters=clone(parameters);d.updated_at=new Date().toISOString();return d;
    });
  }
  async getDraft(s,draftId,version){return this.accounts.update(this.owner(s),a=>{const d=a.drafts.find(d=>d.id===draftId);if(!d||d.version!==version||d.status!=='draft')throw failure('STALE_DRAFT','This draft has changed. Reload My matters.',409);return d;});}
  async remove(s,draftId,version){return this.accounts.update(this.owner(s),a=>{const d=a.drafts.find(d=>d.id===draftId);if(!d||d.version!==version||d.status!=='draft')throw failure('STALE_DRAFT','This draft has changed',409);d.status='discarded';d.version++;return d;});}
  async markRead(s,ids){if(!Array.isArray(ids)||ids.length>200||ids.some(x=>typeof x!=='string'))throw failure('INVALID_NOTIFICATIONS','Select notification IDs');return this.accounts.update(this.owner(s),a=>{for(const n of a.notifications)if(ids.includes(n.id))n.read=true;return {success:true};});}
  async reconcile(s,operation){return this.accounts.update(this.owner(s),a=>{const entry=a.idempotency[operation.key];if(!entry)return {state:'absent',source_type:'mock_operation_ledger'};if(entry.fingerprint!==digest([operation.operation,{...operation.parameters,user_id:s.user.user_id}]))throw failure('IDEMPOTENCY_CONFLICT','Receipt parameters differ',409);copyAccountToSession(s,a);return {state:'committed',result:entry.result,source_type:'mock_operation_ledger'};});}
  async simulate(s,ticketId){return this.accounts.update(this.owner(s),a=>{const t=a.tickets.find(t=>t.ticket_id===ticketId);if(!t)throw failure('TICKET_NOT_FOUND','No owned ticket',404);const status={OPEN:'IN_PROGRESS',IN_PROGRESS:'RESOLVED'}[t.status];if(!status)throw failure('INVALID_STATUS_TRANSITION','No simulated next status',409);t.status=status;const event=recordChange(a,{ticket_id:ticketId,kind:'demo_status',status,reference_id:id('mock-update')});copyAccountToSession(s,a);return event;});}
}
