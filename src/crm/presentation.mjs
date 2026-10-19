import {BY_ID} from './contract.mjs';

// Old answers appended an exact host-generated JSON suffix. Hide only that
// verified suffix in the public view; preserve stored history and evidence.
export function presentCrmMessage(message,receipts){
  if(message.role!=='assistant'||message.kind!=='result'||!message.receipt_ids?.length)return message;
  const supporting=message.receipt_ids.map(id=>receipts.find(r=>r.id===id));
  if(supporting.some(r=>!r||!BY_ID.has(r.operation)||!r.result?.data))return message;
  const suffix='\n\n'+supporting.map(r=>BY_ID.get(r.operation).summary+': '+JSON.stringify(r.result.data)).join('\n');
  return message.text.endsWith(suffix)?{...message,text:message.text.slice(0,-suffix.length)}:message;
}
