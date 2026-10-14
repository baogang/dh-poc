import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';

export const id=prefix=>`${prefix}-${randomUUID()}`;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))??'undefined').digest('hex');
export const clone=value=>structuredClone(value);
export const failure=(code,message,status=400)=>Object.assign(new Error(message),{code,status});

export class RoadStore {
  constructor(directory){this.directory=directory;this.sessions=new Map();this.listeners=new Map();this.writes=new Map();}
  async initialize(){
    if(!this.directory)return;
    await mkdir(this.directory,{recursive:true});
    const {readdir}=await import('node:fs/promises');
    for(const file of await readdir(this.directory)){
      if(!file.endsWith('.json'))continue;
      const s=JSON.parse(await readFile(join(this.directory,file),'utf8'));
      if(s.running){s.running=false;s.status='interrupted';s.epoch++;s.pendingOperation=null;s.authorizations={};}
      this.sessions.set(s.id,s);
    }
  }
  create(){
    const s={id:id('session'),createdAt:new Date().toISOString(),epoch:0,running:false,status:'idle',user:null,facts:{},messages:[],plans:[],activePlanId:null,pendingInput:null,pendingOperation:null,authorizations:{},receipts:[],events:[],mock:{tickets:[],complaints:[],handoffs:[],calls:[],idempotency:{},faults:{}}};
    this.sessions.set(s.id,s);return s;
  }
  get(sid){const s=this.sessions.get(sid);if(!s)throw failure('SESSION_NOT_FOUND','Session not found',404);return s;}
  async save(s){
    if(!this.directory)return;
    const data=JSON.stringify(s),path=join(this.directory,`${s.id}.json`);
    const next=(this.writes.get(s.id)??Promise.resolve()).catch(()=>{}).then(async()=>{const temp=`${path}.tmp`;await writeFile(temp,data,{mode:0o600});await rename(temp,path);});
    this.writes.set(s.id,next);await next;
  }
  emit(s,type,data={}){
    const event={seq:s.events.length+1,time:new Date().toISOString(),type,...clone(data)};s.events.push(event);
    for(const fn of this.listeners.get(s.id)??[])fn(event);
    return event;
  }
  subscribe(sid,listener){const set=this.listeners.get(sid)??new Set();set.add(listener);this.listeners.set(sid,set);return()=>{set.delete(listener);if(!set.size)this.listeners.delete(sid);};}
  message(s,role,text,extra={}){const m={id:id('message'),role,text,time:new Date().toISOString(),...extra};s.messages.push(m);this.emit(s,'message',{message:m});return m;}
  view(s){
    const {authorizations,mock,...rest}=s;
    return {...clone(rest),mock:{tickets:clone(mock.tickets),complaints:clone(mock.complaints),handoffs:clone(mock.handoffs),calls:clone(mock.calls)}};
  }
}
