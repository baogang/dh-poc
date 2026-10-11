import { readdir,readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files=[];async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const path=dir+'/'+e.name;if(e.isDirectory()){if(!['node_modules','.npm-cache','__pycache__','.git'].includes(e.name))await walk(path);}else files.push(path);}}
for(const dir of ['src','web','scripts','plugins','datasets','docs','reports'])await walk(dir);
for(const path of files){const data=await readFile(path);if(/sk-[a-zA-Z0-9_-]{24,}/.test(data.toString()))throw new Error('Credential-like material in '+path);if((path.endsWith('.mjs')||path.endsWith('.js'))){const r=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});if(r.status)throw new Error(r.stderr);}}
console.log(JSON.stringify({source_checks:'passed',credential_scan:'passed',files:files.length}));
