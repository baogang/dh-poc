import { readJSON } from './util.mjs';
import { Type } from '@earendil-works/pi-ai';
import { DEFAULT_REGISTRY } from './capability-registry.mjs';
export const BASE_CATALOG=await readJSON(new URL('../poc_mocks/catalog.json',import.meta.url));
const criteria=Type.Object({city:Type.Optional(Type.String()),sector:Type.Optional(Type.String()),budget_sar:Type.Optional(Type.Number({exclusiveMinimum:0}))},{additionalProperties:false});
export function toolSchema(op){
 if(op.input_schema)return op.input_schema;
 const properties={};
 for(const p of op.path_parameters)properties[p]=Type.String({minLength:1});
 for(const [key,type] of Object.entries(op.properties)){
  if(['confirmation_ref','actor','idempotency_key'].includes(key))continue;
  let field=type==='object'?criteria:Type.String({minLength:1});
  properties[key]=op.required.includes(key)?field:Type.Optional(field);
 }
 return Type.Object(properties,{additionalProperties:false});
}
const extendedActions=['appointment_availability','document_requirements','fee_estimate','service_center_lookup','processing_stage_lookup','amendment_history','notification_preferences','attachment_status','renewal_conditions','appeal_status','delivery_status','accessibility_support','service_hours','inspection_status','geographic_service_area'];
export function buildCatalog(count=16,registry=DEFAULT_REGISTRY){
 if(![16,32,64,128,256].includes(count))throw new Error('Catalog count must be 16/32/64/128/256');
 const result=structuredClone([...registry.operations.values()]);
 const systems=[...registry.systems.keys()];
 // Extra tools model separate fictional municipal products/actions; baseline operations remain unchanged.
 for(let i=result.length;i<count;i++){
  const system=systems[(i-16)%4],action=extendedActions[Math.floor((i-16)/4)%extendedActions.length],product=Math.floor((i-16)/(4*extendedActions.length))+1;
  result.push({id:`scale_${system.toLowerCase()}_product${product}_${action}`,system,skill:'scale.simulation',effect:'read',synthetic:true,path_parameters:[],properties:{subject_id:'string'},required:['subject_id'],description:`Fictional ${system} product ${product}: ${action.replaceAll('_',' ')}. Use only when user explicitly asks for this product/action; cannot replace certificate, complaint, support or investment baseline operations.`});
 }
 return result;
}
export function discover(catalog,{systems=[],query='',limit=8}={}){
 let filtered=systems.length?catalog.filter(x=>systems.includes(x.system)):catalog;
 const words=query.toLowerCase().split(/\W+/).filter(x=>x.length>2);
 const ranked=filtered.map(op=>{const searchable=(op.id+' '+(op.keywords??op.id.replaceAll('_',' '))).toLowerCase();return {op,score:words.reduce((n,w)=>n+(searchable.includes(w)?3:0),0)};}).sort((a,b)=>b.score-a.score||a.op.id.localeCompare(b.op.id));
 return ranked.slice(0,Math.min(limit,16)).map(x=>x.op);
}
