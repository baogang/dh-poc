import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {RoadEmotion,EMOTION_VERSION,EMOTION_PROMPT,SENTIMENTS} from '../src/road/emotion.mjs';
import {digest} from '../src/road/store.mjs';
const args=process.argv.slice(2),option=(key,value)=>{const i=args.indexOf(key);return i<0?value:args[i+1];};
const source=option('--source','road'),split=option('--split','all'),limit=Number(option('--limit','10000')),concurrency=Number(option('--concurrency','4'));
if(!['road','legacy'].includes(source)||!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw Error('Invalid source or concurrency');
const jsonl=async path=>(await readFile(new URL(path,import.meta.url),'utf8')).trim().split('\n').map(JSON.parse);
let all;
if(source==='legacy'){
 const [inputs,references,manifest]=await Promise.all(['inputs','references','manifest'].map(name=>jsonl(`../datasets/v3.0/emotion/${name}.jsonl`)));
 const gold=new Map(references.map(x=>[x.case_id,x.reference])),meta=new Map(manifest.map(x=>[x.case_id,x]));
 all=inputs.map(x=>({case_id:x.case_id,input:x.input,expected:gold.get(x.case_id),...meta.get(x.case_id)}));
}else all=await jsonl('../datasets/road-emotion-v1/cases.jsonl');
const cases=all.filter(x=>split==='all'||x.split===split).slice(0,limit),rows=[];if(!cases.length)throw Error('No cases');
const started=Date.now(),emotion=new RoadEmotion();let index=0;
async function worker(){while(index<cases.length){const c=cases[index++],events=[],begin=Date.now();let result,error;try{result=await emotion.assess(c.input,{signal:AbortSignal.timeout(60000),onEvent:e=>events.push(e)});}catch(e){error={code:e.code??'ERROR',message:e.message};}
 const expected=c.expected.sentiment,scored=SENTIMENTS.includes(expected),row={case_id:c.case_id,language:c.language,split:c.split,expected:expected??null,scored,predicted:result?.sentiment??null,correct:scored?result?.sentiment===expected:null,expected_route:source==='road'?c.expected.route:undefined,predicted_route:result?result.sentiment==='negative'?'human':'loop':null,protocol_valid:!!result&&SENTIMENTS.includes(result.sentiment),evidence:result?.evidence,error,latency_ms:Date.now()-begin,model_requests:events.filter(e=>e.type==='model_request').length,cost:events.filter(e=>e.type==='model_result').reduce((n,e)=>n+(e.usage?.cost?.total??0),0)};rows.push(row);
 if(rows.length%20===0||rows.length===cases.length)console.log(JSON.stringify({source,completed:rows.length,total:cases.length,failures:rows.filter(r=>r.scored&&!r.correct).length,errors:rows.filter(r=>r.error).length}));
}}
await Promise.all(Array.from({length:concurrency},worker));
const ratio=(a,b)=>b?a/b:null;
function metrics(list){const scored=list.filter(r=>r.scored),confusion=Object.fromEntries(SENTIMENTS.map(label=>[label,Object.fromEntries([...SENTIMENTS,'error'].map(p=>[p,0]))]));for(const r of scored)confusion[r.expected][r.predicted??'error']++;
 const per_class=Object.fromEntries(SENTIMENTS.map(label=>{const tp=scored.filter(r=>r.expected===label&&r.predicted===label).length,fp=scored.filter(r=>r.expected!==label&&r.predicted===label).length,fn=scored.filter(r=>r.expected===label&&r.predicted!==label).length;return [label,{support:tp+fn,tp,fp,fn,precision:ratio(tp,tp+fp),recall:ratio(tp,tp+fn),f1:ratio(2*tp,2*tp+fp+fn)}];}));
 return {total:list.length,scored:scored.length,unscored:list.length-scored.length,correct:scored.filter(r=>r.correct).length,accuracy:ratio(scored.filter(r=>r.correct).length,scored.length),protocol_valid:list.filter(r=>r.protocol_valid).length,errors:list.filter(r=>r.error).length,confusion,per_class,macro_f1:ratio(Object.values(per_class).reduce((n,c)=>n+(c.f1??0),0),3),routing_accuracy:ratio(scored.filter(r=>r.predicted_route===(r.expected==='negative'?'human':'loop')).length,scored.length)};}
const report={timestamp:new Date().toISOString(),source,split,model:process.env.DEEPSEEK_MODEL??'deepseek-flash',sdk:'1.1.0',version:EMOTION_VERSION,prompt_hash:digest(EMOTION_PROMPT),dataset_hash:digest(cases),provenance:'synthetic provisional gold; no native-language expert review',elapsed_ms:Date.now()-started,metrics:metrics(rows),by_language:Object.fromEntries([...new Set(rows.map(r=>r.language))].map(language=>[language,metrics(rows.filter(r=>r.language===language))])),by_split:Object.fromEntries([...new Set(rows.map(r=>r.split))].map(s=>[s,metrics(rows.filter(r=>r.split===s))])),model_requests:rows.reduce((n,r)=>n+r.model_requests,0),cost:rows.reduce((n,r)=>n+r.cost,0),rows:cases.map(c=>rows.find(r=>r.case_id===c.case_id))};
await mkdir('reports/road',{recursive:true});const path=`reports/road/emotion-${source}-${split}-${report.timestamp.replaceAll(':','-')}.json`;await writeFile(path,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,rows:undefined,path}));if(report.metrics.errors)process.exitCode=1;
