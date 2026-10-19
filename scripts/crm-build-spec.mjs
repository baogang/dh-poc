import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {OPENAPI} from '../src/crm/openapi.mjs';
import {OPERATIONS} from '../src/crm/contract.mjs';
await mkdir('specs',{recursive:true});
const text=JSON.stringify(OPENAPI,null,2)+'\n';
if(process.argv.includes('--check')){if(await readFile('specs/balady-crm.openapi.json','utf8')!==text)throw Error('OpenAPI output is stale; run npm run crm:spec');}
else await writeFile('specs/balady-crm.openapi.json',text);
console.log(JSON.stringify({services:OPERATIONS.length+1,business_tools:OPERATIONS.length,openapi:'3.0.3',sha256:createHash('sha256').update(text).digest('hex')}));
