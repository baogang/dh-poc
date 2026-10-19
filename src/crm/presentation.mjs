import {BY_ID} from './contract.mjs';
import {isDeepStrictEqual} from 'node:util';

// Old answers appended an exact host-generated JSON suffix. Hide only that
// verified suffix in the public view; preserve stored history and evidence.
export function presentCrmMessage(message,receipts){
  if(message.role!=='assistant'||message.kind!=='result'||!message.receipt_ids?.length)return message;
  const supporting=message.receipt_ids.map(id=>receipts.find(r=>r.id===id));
  if(supporting.some(r=>!r||!BY_ID.has(r.operation)||!r.result?.data))return message;
  const start=message.text.lastIndexOf('\n\n'+BY_ID.get(supporting[0].operation).summary+': ');
  if(start<0)return message;
  const lines=message.text.slice(start+2).split('\n');if(lines.length!==supporting.length)return message;
  // JSONB does not preserve object key order. Compare parsed evidence, not its
  // serialization, while requiring every known operation prefix and response.
  try{
    if(!supporting.every((r,i)=>{const prefix=BY_ID.get(r.operation).summary+': ';return lines[i].startsWith(prefix)&&isDeepStrictEqual(JSON.parse(lines[i].slice(prefix.length)),r.result.data);}))return message;
  }catch{return message;}
  return {...message,text:message.text.slice(0,start)};
}
