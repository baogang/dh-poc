import { readdir,readFile,realpath } from 'node:fs/promises';
import { join,resolve,dirname,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash,canonical } from './util.mjs';
export async function loadRegistry(directory=new URL('../plugins',import.meta.url)){
 const root=await realpath(directory instanceof URL?fileURLToPath(directory):directory),plugins=[];
 for(const entry of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(!entry.isDirectory())continue;
  const path=join(root,entry.name,'manifest.json');let manifest;
  try{manifest=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const skillPath=await realpath(resolve(dirname(path),manifest.skill_file));if(!skillPath.startsWith(root+sep))throw new Error('Skill outside approved plugin root');
  plugins.push({...manifest,skillPath,manifestPath:path});
 }
 return makeRegistry(plugins);
}
export function makeRegistry(plugins){
 const systems=new Map(),operations=new Map(),capabilities=new Map();
 for(const source of plugins){
  const plugin=structuredClone(source);if(!plugin.system||systems.has(plugin.system)||!plugin.plugin_version)throw new Error('Duplicate/invalid system');systems.set(plugin.system,plugin);
  for(const cap of plugin.capabilities??[]){if(!cap.id||capabilities.has(cap.id)||!cap.operations?.length||!cap.completion)throw new Error('Invalid capability '+cap.id);if((cap.resource_prefixes??[]).some(p=>!/^[A-Za-z][A-Za-z0-9]*$/.test(p)))throw new Error('Invalid resource prefix');capabilities.set(cap.id,{...cap,system:plugin.system});}
  for(const original of plugin.operations??[]){
   const op={...original,adapter:original.adapter??'http_mock',subject_fields:original.subject_fields??original.resource_fields??[],keywords:original.keywords??original.search_keywords,
    subject_dependencies:original.subject_dependencies??original.proof_dependencies?.map(d=>({operation:d.operation,argument:d.argument_field,output_match:d.receipt_field,subject_argument:d.subject_field}))??[]};
   if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(op.id)||operations.has(op.id)||op.system!==plugin.system||!op.input_schema||op.input_schema.additionalProperties!==false||!['read','write','task'].includes(op.effect)||!['http_mock','fixture_mock'].includes(op.adapter))throw new Error('Invalid operation '+op.id);
   if(['actor','confirmation_ref','idempotency_key'].some(k=>k in (op.input_schema.properties??{})))throw new Error('Host field exposed');operations.set(op.id,op);
  }
 }
 for(const cap of capabilities.values()){
  for(const id of cap.operations)if(!operations.has(id)||operations.get(id).system!==cap.system||operations.get(id).capability_id!==cap.id)throw new Error('Invalid capability operation '+id);
  for(const spec of Object.values(cap.completion))if(!spec.required_operations?.length||spec.required_operations.some(id=>!cap.operations.includes(id)))throw new Error('Invalid completion '+cap.id);
 }
 for(const op of operations.values())if(!capabilities.has(op.capability_id))throw new Error('Unregistered capability');
 const content=plugins.map(({skillPath,manifestPath,...data})=>data);
 return {systems,operations,capabilities,plugins,version:'registry-v2.0.0',hash:hash(canonical(content))};
}
export const DEFAULT_REGISTRY=await loadRegistry();
