import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const registry=JSON.parse(await readFile('datasets/registry.json','utf8'));
const disabled=new Set(registry.disabled_test_files);
const files=(await readdir('tests')).filter(name=>name.endsWith('.test.mjs')&&!disabled.has('tests/'+name)).sort().map(name=>'tests/'+name);
if(!files.some(path=>path.includes('/crm-')))throw Error('No active CRM tests');
console.log(JSON.stringify({active_test_files:files,disabled_legacy_files:disabled.size,reason:registry.legacy_reason}));
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});process.exitCode=result.status??1;
