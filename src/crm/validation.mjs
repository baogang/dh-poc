import Ajv from 'ajv';
import {BY_ID} from './contract.mjs';
const ajv=new Ajv({allErrors:true,strict:false,coerceTypes:false});
const validators=new Map([...BY_ID].map(([name,op])=>[name,ajv.compile(op.input)]));
export function inputFieldPath(operation,field){
  const op=BY_ID.get(operation);if(!op||typeof field!=='string')return null;
  const path=field.replace(/^\//u,'').replaceAll('/','.').split('.');
  const resolve=parts=>{let shape=op.input;for(const key of parts){shape=shape?.type==='array'&&/^\d+$|^\*$/u.test(key)?shape.items:shape?.properties?.[key];if(!shape)return null;}return parts.join('.');};
  return resolve(path)??(op.body?.properties?.[path[0]]?resolve(['body',...path]):null);
}
export function validateInput(operation,parameters){
  const op=BY_ID.get(operation);if(!op)return {valid:false,errors:[{path:'operation',code:'UNKNOWN_OPERATION',message:'Choose an operation from the connected CRM catalog.'}]};
  const validate=validators.get(operation),errors=[];
  if(!validate(parameters))for(const e of validate.errors){const field=e.params.missingProperty??e.params.additionalProperty;const path=(e.instancePath+(field?'/'+field:''))||'/';const issue={path,code:e.keyword,message:e.message,...e.params};
    if(e.keyword==='additionalProperties'){const parent=e.instancePath.split('/').filter(Boolean).reduce((x,k)=>x?.properties?.[k]??x?.items,op.input);const suggestion=Object.keys(parent?.properties??{}).find(k=>k.toLowerCase()===field.toLowerCase());if(suggestion)issue.suggested_field=suggestion;}
    errors.push(issue);
  }
  const body=parameters?.body??{};
  const required=names=>{for(const key of names)if(body[key]===undefined)errors.push({path:'/body/'+key,code:'conditional_required',message:'Required by this operation and current values.'});};
  if(operation==='crm_update_cis_incident'&&['True','true','Yes'].includes(body.IsPublicUtilityDamaged))required(['IncidentQuantity','UnitValue']);
  if(operation==='crm_update_external_incident'&&body.IncidentStatusName==='Resolved')required(['IncidentPhotosAfterFixing']);
  if(operation==='crm_update_incident_status_v2'&&body.CaseStatusID===4)required(['EECode','EENotesFromMUN','EEName']);
  // Whitespace-only required strings are rejected locally; explicitly blank-permitted
  // fields in create schemas retain their documented behavior.
  function nonblank(shape,value,path=''){
    if(shape.type==='object'&&value&&typeof value==='object')for(const [k,child]of Object.entries(shape.properties)){const v=value[k];if(typeof v==='string'&&(shape.required??[]).includes(k)&&!v.trim()&&!['Priority','ResponseTime','SCBusinessTypeID','ParkID'].includes(k))errors.push({path:path+'/'+k,code:'blank',message:'Required value is blank (local validation policy).'});nonblank(child,v,path+'/'+k);}
    if(shape.type==='array'&&Array.isArray(value))value.forEach((v,i)=>nonblank(shape.items,v,path+'/'+i));
  }
  nonblank(op.input,parameters);
  return {valid:!errors.length,errors,source:{section:op.section,printed_page:op.page},...(errors.length?{repair:'Read the listed paths and allowed values; ask the user for missing facts. Do not invent IDs, dates, consent, identity or file content.'}:{})};
}
export function requestFor(operation,parameters){
  const op=BY_ID.get(operation);const check=validateInput(operation,parameters);if(!check.valid)return check;
  let path=op.path;for(const name of Object.keys(op.pathParams.properties))path=path.replace('{'+name+'}',encodeURIComponent(parameters[name]));
  const query=new URLSearchParams();for(const key of Object.keys(op.query.properties))if(parameters[key]!==undefined)query.set(key,String(parameters[key]));
  return {valid:true,method:op.method,path:path+(query.size?'?'+query:''),...(op.body?{body:structuredClone(parameters.body)}:{}),auth:op.auth};
}
