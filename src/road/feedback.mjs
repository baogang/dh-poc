import pg from 'pg';
import {digest,failure} from './store.mjs';

export const feedbackSummary=row=>({feedback_id:row.feedback_id,answer_message_id:row.answer_message_id,rating:row.rating,version:row.version,created_at:new Date(row.created_at).toISOString(),updated_at:new Date(row.updated_at).toISOString()});
export const feedbackRecord=row=>({...feedbackSummary(row),schema_version:1,session_id:row.session_id,snapshot:row.snapshot,review_status:'unreviewed'});
export function feedbackPool(connectionString){
  const url=new URL(connectionString);if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('PostgreSQL URL required');
  // Avoid connection-string options replacing certificate verification in pg.
  for(const key of ['sslmode','channel_binding','sslcert','sslkey','sslrootcert'])url.searchParams.delete(key);
  const pool=new pg.Pool({connectionString:url.toString(),ssl:{rejectUnauthorized:true},enableChannelBinding:true,max:3,idleTimeoutMillis:10000,connectionTimeoutMillis:12000,statement_timeout:12000,application_name:'government-answer-feedback'});
  pool.on('error',()=>console.warn('Feedback database connection interrupted'));
  return pool;
}
export class FeedbackRepository{
  constructor({connectionString=process.env.ROAD_FEEDBACK_DATABASE_URL,pool,schema='public'}={}){
    if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema))throw Error('Invalid feedback schema');
    this.pool=pool??(connectionString?feedbackPool(connectionString):null);this.schema=schema;this.enabled=!!this.pool&&process.env.ROAD_FEEDBACK_ENABLED!=='false';this.cache=new Map();this.loads=new Map();
    this.answers=`"${schema}".road_answer_feedback`;this.events=`"${schema}".road_answer_feedback_events`;
  }
  async initialize(){
    if(!this.enabled)return;
    if(this.ready)return this.ready;
    this.ready=this.pool.query(`CREATE TABLE IF NOT EXISTS ${this.answers} (
      feedback_id text PRIMARY KEY, session_id text NOT NULL, answer_message_id text NOT NULL,
      rating text CHECK (rating IN ('satisfied','unsatisfied')), version integer NOT NULL DEFAULT 0 CHECK(version>=0),
      snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(session_id,answer_message_id));
      CREATE TABLE IF NOT EXISTS ${this.events} (
      feedback_id text NOT NULL REFERENCES ${this.answers}(feedback_id),request_id text NOT NULL,
      rating text NOT NULL CHECK(rating IN ('satisfied','unsatisfied')), version integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(feedback_id,request_id),UNIQUE(feedback_id,version));`).catch(()=>{this.ready=null;throw failure('FEEDBACK_UNAVAILABLE','Feedback storage is temporarily unavailable',503);});
    return this.ready;
  }
  cached(sessionId){return this.cache.get(sessionId)??{};}
  remember(sessionId,row){const next={...this.cached(sessionId),[row.answer_message_id]:feedbackSummary(row)};this.cache.set(sessionId,next);}
  async load(sessionId){
    if(!this.enabled)return;
    if(this.loads.has(sessionId))return this.loads.get(sessionId);
    const promise=this.list(sessionId).then(rows=>{for(const row of rows){const old=this.cached(sessionId)[row.answer_message_id];if(!old||old.version<=row.version)this.remember(sessionId,row);}}).catch(e=>{this.loads.delete(sessionId);throw e;});this.loads.set(sessionId,promise);return promise;
  }
  async list(sessionId){await this.initialize();if(!this.enabled)return [];const r=await this.pool.query(`SELECT * FROM ${this.answers} WHERE version>0 ${sessionId?'AND session_id=$1':''} ORDER BY created_at,feedback_id`,sessionId?[sessionId]:[]);return r.rows;}
  async submit(sessionId,input,snapshot){
    if(!this.enabled)throw failure('FEEDBACK_DISABLED','Feedback is not enabled',503);
    const {answer_message_id:answerId,rating,request_id:requestId,expected_version:expected}=input;
    if(!['satisfied','unsatisfied'].includes(rating)||typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)||!Number.isInteger(expected)||expected<0)throw failure('INVALID_FEEDBACK','Invalid feedback request');
    await this.initialize();const feedbackId='feedback-'+digest([sessionId,answerId]);let client;
    try{
      client=await this.pool.connect();await client.query('BEGIN');
      await client.query(`INSERT INTO ${this.answers}(feedback_id,session_id,answer_message_id,snapshot) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(session_id,answer_message_id) DO NOTHING`,[feedbackId,sessionId,answerId,JSON.stringify(snapshot)]);
      let row=(await client.query(`SELECT * FROM ${this.answers} WHERE feedback_id=$1 FOR UPDATE`,[feedbackId])).rows[0];
      const replay=(await client.query(`SELECT rating FROM ${this.events} WHERE feedback_id=$1 AND request_id=$2`,[feedbackId,requestId])).rows[0];
      if(replay&&replay.rating!==rating)throw failure('FEEDBACK_REQUEST_REUSED','Request ID already used for another rating',409);
      if(!replay){
        if(row.version!==expected)throw Object.assign(failure('FEEDBACK_CONFLICT','Feedback changed; use its latest version',409),{current:feedbackSummary(row)});
        if(row.rating!==rating){
          row=(await client.query(`UPDATE ${this.answers} SET rating=$2,version=version+1,updated_at=clock_timestamp() WHERE feedback_id=$1 RETURNING *`,[feedbackId,rating])).rows[0];
          await client.query(`INSERT INTO ${this.events}(feedback_id,request_id,rating,version) VALUES($1,$2,$3,$4)`,[feedbackId,requestId,rating,row.version]);
        }
      }
      await client.query('COMMIT');this.remember(sessionId,row);return feedbackRecord(row);
    }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});if(e.code?.startsWith('FEEDBACK_')||e.code==='INVALID_FEEDBACK')throw e;throw failure('FEEDBACK_UNAVAILABLE','Feedback could not be saved. Please retry.',503);}
    finally{client?.release();}
  }
  async close(){await this.pool?.end();}
}
