import {digest} from '../road/store.mjs';
import {caseStatusLabel} from './presentation.mjs';

export const CASE_FETCH_OPERATIONS=new Set(['crm_fetch_incident','crm_fetch_municipal_service','crm_fetch_inquiry']);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const caseFingerprint=record=>digest(canonical(record));
const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu,' ').trim();
function containsIdentifier(text,value){
  const key=normalize(value);if(!key)return false;
  const continues=character=>/[\p{Script=Latin}\p{N}_-]/u.test(character??'');
  for(let index=text.indexOf(key);index!==-1;index=text.indexOf(key,index+1))if(!continues(text[index-1])&&!continues(text[index+key.length]))return true;
  return false;
}

export function caseSource(session){
  const owner=session.user?.user_id??null;
  const receipt=session.receipts.findLast(receipt=>receipt.operation==='crm_get_incidents'&&receipt.beneficiary_id===owner);
  const rows=[...new Map((receipt?.result?.data?.result?.IncidentRequestList??[]).filter(row=>typeof row?.pzInsKey==='string'&&row.pzInsKey).map(row=>[row.pzInsKey,row])).values()];
  return {owner,receipt,rows};
}

// Evidence returned by a query is never a substitute for the user's reference.
// A complete actual description can identify a unique record, as can its real
// display number/key. Broad topic similarity and record recency cannot.
export function caseTarget(session,origin,requestedKey){
  const source=caseSource(session),selected=session.facts.caseSelections?.[origin];
  const start=session.messages.findIndex(message=>message.id===origin),delivered=session.messages.slice(Math.max(0,start)).filter(message=>message.role==='user').map(message=>normalize(message.text));
  if(!source.receipt)return {status:delivered.some(text=>containsIdentifier(text,requestedKey))?'explicit_reference':'history_required',source};
  const direct=source.rows.find(row=>row.pzInsKey===requestedKey&&[row.pyID,row.pzInsKey].filter(value=>typeof value==='string'&&value.trim()).some(value=>delivered.some(text=>containsIdentifier(text,value))));
  if(direct)return {status:'explicit_reference',source};
  if(selected){
    const row=source.rows.find(row=>row.pzInsKey===selected.record_key);
    if(selected.owner!==source.owner||(selected.none?caseFingerprint(source.rows)!==selected.history_fingerprint:!row||caseFingerprint(row)!==selected.record_fingerprint))return {status:'stale',source};
    if(selected.none)return {status:'none',source};
    return {status:selected.record_key===requestedKey?'selected':'mismatch',source,selection:selected};
  }
  if(source.rows.length<2)return {status:'unambiguous',source};
  const referenced=source.rows.filter(row=>[row.Description??row.IncidentInformation?.IssueDescription].filter(value=>typeof value==='string'&&value.trim()).some(value=>delivered.some(text=>text.includes(normalize(value)))));
  if(referenced.length===1&&referenced[0].pzInsKey===requestedKey)return {status:'explicit_reference',source};
  return {status:'ambiguous',source};
}

export function caseChoice(source,language){
  const words={
    zh:{question:'尚未确定你指的是哪一件。请从本次可见记录的问题描述或记录日期选择；这些都不符合时可以选择“都不是”。选择只确定查询目标，不会修改或提交事项。',missing:'问题描述未返回',date:'记录日期',status:'记录状态',none:'这些都不是我要查询的事项'},
    en:{question:'The target has not been identified. Select an issue description or recorded date from the visible records, or choose “None of these”. This only selects a query target; it does not change or submit a case.',missing:'Issue description not returned',date:'Recorded date',status:'Recorded status',none:'None of these is the matter I mean'},
    ar:{question:'لم يتحدد الطلب المقصود. اختر وصف المشكلة أو تاريخها المسجل من السجلات الظاهرة، أو اختر «لا شيء منها». الاختيار يحدد هدف الاستعلام فقط ولا يعدل أي طلب أو يرسله.',missing:'لم يُرجع وصف المشكلة',date:'التاريخ المسجل',status:'الحالة المسجلة',none:'لا شيء منها هو الطلب الذي أقصده'}
  }[language];
  const choices=source.rows.map((row,index)=>{const date=row.pxCreateDateTime??row.CreatedAt??row.CreatedDate??row.CreateDateTime??row.ReportedDate??row.CreatedOn;return {id:'case_'+index,label:String(row.Description??row.IncidentInformation?.IssueDescription??row.pyID??words.missing),description:[date?words.date+': '+date:null,row.pyStatusWork?words.status+': '+caseStatusLabel(row.pyStatusWork,language):null].filter(Boolean).join(' · '),record_key:row.pzInsKey,record_id:row.pyID,record_fingerprint:caseFingerprint(row)};});
  choices.push({id:'none',label:words.none,none:true});
  return {question:words.question,choices,case_owner:source.owner,case_history_receipt_id:source.receipt.id};
}

export function selectedCase(session,input,choice){
  const source=caseSource(session);
  if(input.case_owner!==source.owner||input.case_history_receipt_id!==source.receipt?.id)return null;
  if(choice.none)return {owner:source.owner,history_receipt_id:source.receipt.id,history_fingerprint:caseFingerprint(source.rows),none:true};
  const record=source.rows.find(row=>row.pzInsKey===choice.record_key);
  if(!record||caseFingerprint(record)!==choice.record_fingerprint)return null;
  return {owner:source.owner,history_receipt_id:source.receipt.id,record_key:record.pzInsKey,record_id:record.pyID,record_fingerprint:caseFingerprint(record)};
}
