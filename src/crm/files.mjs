import {failure,id} from '../road/store.mjs';

export const MAX_FILE_BYTES=512*1024;
export function receiveFile(session,file){
  if(!file||typeof file.name!=='string'||!file.name.trim()||file.name.length>255||/[\x00-\x1f\\/]/u.test(file.name)||typeof file.base64!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.base64))throw failure('INVALID_FILE','Choose a valid file to attach');
  const bytes=Buffer.from(file.base64,'base64');
  if(!bytes.length||bytes.length>MAX_FILE_BYTES)throw failure('FILE_SIZE_LIMIT','Choose a nonempty file up to 512 KiB');
  const metadata={id:id('file'),name:file.name,media_type:typeof file.media_type==='string'?file.media_type.slice(0,100):'',size:bytes.length};
  session.crmFiles??={};session.crmFiles[metadata.id]={...metadata,base64:bytes.toString('base64')};
  session.facts.files??=[];session.facts.files.push(metadata);return metadata;
}
// File bytes stay in the trusted host. Schemas remain visible to the model;
// only string values are omitted, never properties describing the API schema.
export function modelSafe(value){return JSON.parse(JSON.stringify(value,(key,item)=>typeof item==='string'&&['base64','AttachStream','AttachmentStream'].includes(key)?'[file bytes retained by host]':item));}
