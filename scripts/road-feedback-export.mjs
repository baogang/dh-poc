import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {FeedbackRepository,feedbackRecord} from '../src/road/feedback.mjs';
import {feedbackExport} from '../web/road/feedback-data.js';
const args=process.argv.slice(2),option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const format=option('--format','jsonl'),output=resolve(option('--output',`reports/road/feedback-${new Date().toISOString().replaceAll(':','-')}.${format}`));
if(!['jsonl','csv'].includes(format))throw Error('Use --format jsonl or csv');
const repository=new FeedbackRepository();
try{if(!repository.enabled)throw Error('Configure ROAD_FEEDBACK_DATABASE_URL');const rows=(await repository.list(option('--session',null))).map(feedbackRecord);await mkdir(dirname(output),{recursive:true});await writeFile(output,feedbackExport(rows,format),{mode:0o600});console.log(JSON.stringify({exported:rows.length,format,path:output}));}
catch{console.error('Feedback export failed. Check the backend database configuration and permissions.');process.exitCode=1;}
finally{await repository.close();}
