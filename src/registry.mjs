import { readdir,readFile,realpath } from 'node:fs/promises';
import { join,resolve,dirname,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash,canonical } from './util.mjs';

export async function loadRegistry(directory=new URL('../plugins',import.meta.url)){
 const root=await realpath(directory instanceof URL?fileURLToPath(directory):directory),plugins=[];
 for(const entry of (await readdir(root,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(!entry.isDirectory())continue;
  const path=join(root,entry.name,'manifest.json');
  let manifest;try{manifest=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const skillPath=await realpath(resolve(dirname(path),manifest.skill_file));
  if(!skillPath.startsWith(root+sep))throw new Error('Skill file must remain within approved plugin root');
  plugins.push({...manifest,skillPath,manifestPath:path});
 }
 return makeRegistry(plugins);
}
export function makeRegistry(plugins){
 const systems=new Map(),operations=new Map(),capabilities=new Map();
 for(const plugin of plugins){
  if(!plugin.system||systems.has(plugin.system)||!plugin.plugin_version)throw new Error('Duplicate/invalid system manifest');
  systems.set(plugin.system,plugin);
  for(const cap of plugin.capabilities??[]){if(!cap.id||capabilities.has(cap.id)||!cap.completion||!cap.operations?.length)throw new Error('Invalid capability contract');capabilities.set(cap.id,{...cap,system:plugin.system});}
  for(const op of plugin.operations??[]){
   if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(op.id)||operations.has(op.id)||!op.input_schema||op.input_schema.additionalProperties!==false||op.system!==plugin.system||!['read','write','task'].includes(op.effect)||!['http_mock','fixture_mock'].includes(op.adapter))throw new Error('Invalid operation contract '+op.id);
   if(['actor','confirmation_ref','idempotency_key'].some(k=>k in (op.input_schema.properties??{})))throw new Error('Host-only field exposed by '+op.id);
   operations.set(op.id,op);
  }
 }
 for(const cap of capabilities.values()){
  for(const name of cap.operations)if(!operations.has(name)||operations.get(name).system!==cap.system||operations.get(name).capability_id!==cap.id)throw new Error('Invalid capability operation '+name);
  for(const spec of Object.values(cap.completion))if(!spec.required_operations?.length||spec.required_operations.some(name=>!cap.operations.includes(name)))throw new Error('Invalid completion contract '+cap.id);
 }
 for(const op of operations.values())if(!capabilities.has(op.capability_id))throw new Error('Unknown capability '+op.capability_id);
 const content=plugins.map(({skillPath,manifestPath,...data})=>data);
 return {systems,operations,capabilities,version:'registry-v2.0.0',hash:hash(canonical(content)),plugins};
}
export const DEFAULT_REGISTRY=await loadRegistry();
