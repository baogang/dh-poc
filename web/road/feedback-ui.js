import {feedbackStats,feedbackExport} from './feedback-data.js';

export class BrowserFeedbackBackup{
  constructor(){this.connection=null;}
  async open(){
    if(typeof indexedDB==='undefined')throw Error('Browser backup unavailable');
    if(!this.connection)this.connection=new Promise((resolve,reject)=>{const request=indexedDB.open('government-answer-feedback',1);request.onupgradeneeded=()=>request.result.createObjectStore('records',{keyPath:'feedback_id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('Browser backup unavailable'));});
    return this.connection;
  }
  async all(){const db=await this.open();return new Promise((resolve,reject)=>{const transaction=db.transaction('records','readonly'),request=transaction.objectStore('records').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('Browser backup read failed'));});}
  async put(record){const db=await this.open();return new Promise((resolve,reject)=>{const transaction=db.transaction('records','readwrite');const store=transaction.objectStore('records'),existing=store.get(record.feedback_id);existing.onsuccess=()=>{if(!existing.result||existing.result.version<=record.version)store.put(record);};transaction.oncomplete=()=>resolve();transaction.onerror=transaction.onabort=()=>reject(Error('Browser backup save failed'));});}
}
const requestId=()=>globalThis.crypto?.randomUUID?.()??'rating-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
export function createFeedbackController({request,onChange=()=>{},backup=new BrowserFeedbackBackup()}={}){
  const entries=new Map(),records=new Map(),loads=new Map();let backupWarning=false,cloudWarning=false,exportError=false;
  const remember=record=>{const old=records.get(record.feedback_id);if(!old||old.version<=record.version)records.set(record.feedback_id,record);};
  const backupReady=backup.all().then(rows=>{rows.forEach(remember);onChange();}).catch(()=>{});
  const key=(s,id)=>s.id+':'+id;
  const savedFor=(s,id)=>{const a=s.feedback?.items?.[id],b=entries.get(key(s,id))?.saved;return a&&(!b||a.version>b.version)?a:b??a;};
  const view=s=>{
    const items={};for(const m of s.messages??[]){const e=entries.get(key(s,m.id)),saved=savedFor(s,m.id);items[m.id]={...(saved??{}),rating:e&&(e.pending||e.error)?e.requested:saved?.rating,pending:!!e?.pending,error:e?.error??null,requested:e?.requested};}
    return {enabled:s.feedback?.enabled===true,items};
  };
  async function sync(s){
    if(!s.id||!s.feedback?.enabled||loads.has(s.id))return;
    const promise=request('/api/feedback').then(async data=>{for(const record of data.records??[]){remember(record);const k=key(s,record.answer_message_id),old=entries.get(k);if(!old?.saved||old.saved.version<=record.version)entries.set(k,{...old,saved:record});await backup.put(record).catch(()=>{backupWarning=true;});}cloudWarning=false;onChange();}).catch(()=>{loads.delete(s.id);cloudWarning=true;onChange();});loads.set(s.id,promise);return promise;
  }
  async function choose(s,id,rating){
    if(!s.feedback?.enabled||!['satisfied','unsatisfied'].includes(rating))return;
    const k=key(s,id),old=entries.get(k),saved=savedFor(s,id);if(old?.pending||saved?.rating===rating&&!old?.error)return;
    const expected=saved?.version??0,retry=old?.error&&old.requested===rating&&old.expected===expected&&old.error!=='FEEDBACK_CONFLICT';
    const entry={saved,requested:rating,pending:true,error:null,expected,requestId:retry?old.requestId:requestId()};entries.set(k,entry);onChange();
    try{
      const {record}=await request('/api/feedback',{answer_message_id:id,rating,request_id:entry.requestId,expected_version:expected});
      if(!record?.feedback_id)throw Error('Invalid feedback acknowledgement');
      entry.saved=record;remember(record);cloudWarning=false;
      await backup.put(record).catch(()=>{backupWarning=true;});
    }catch(e){entry.error=e.code??'FEEDBACK_UNAVAILABLE';if(e.current)entry.saved=e.current;}
    finally{entry.pending=false;onChange();}
  }
  async function exportData(s,format){
    exportError=false;await backupReady;await sync(s);const data=[...records.values()];
    if(!data.length){exportError=true;onChange();return null;}return {text:feedbackExport(data,format),count:data.length};
  }
  return {view,choose,sync,exportData,summary:()=>({...feedbackStats([...records.values()]),backupWarning,cloudWarning,exportError})};
}
export function downloadFeedback(text,format){
  const blob=new Blob([text],{type:format==='csv'?'text/csv;charset=utf-8':'application/x-ndjson;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='answer-feedback-'+new Date().toISOString().slice(0,10)+'.'+format;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
