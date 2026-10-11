import Ajv from 'ajv';
import { mkdir,readdir,readFile,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { loadV2Suite } from './evaluate-v2.mjs';
import { hash,canonical,readJSON,readJSONL,writeJSON,uid } from './util.mjs';
import { SENTIMENTS,ASSESSMENT_STATUSES,STATUSES,emotionReferenceSchema,validateEmotionReference } from './contracts.mjs';
import { buildCatalog } from './catalog.mjs';
import { fullTaskContract } from './v2-metrics.mjs';
export { fullTaskContract };
export const SUITES=['emotion','planning','integration','engineering'];
export const MODULES=[
 {id:'emotion',name:'情绪分析',version:'emotion-v3.0.0',description:'识别正面、中性、负面及独立的待补充信息状态。保留七类情绪供调试，不参与评分。',metrics:'三类 Sentiment Accuracy / Macro F1；负面 Precision / Recall；澄清识别；核心匹配率',mode:'live'},
 {id:'planning',name:'动态规划',version:'pi-government-v2.0.0',description:'Pi Agent 按自然语言目标选择 Skill 和工具，支持多轮、确认、API 与远程 Agent；独立测试时不调用情绪模块。',metrics:'工具选择 Precision / Recall / F1；参数、依赖、状态及回执的任务契约通过率',mode:'live'},
 {id:'integration',name:'完整流程',version:'negative-to-human-v3.0.0',description:'先分析情绪再路由：正面/中性进入规划，负面转模拟人工，待补充信息请求澄清。接收交接后会话结束。',metrics:'路由准确率、人工选择 P/R/F1；非 Agent 路由业务调用违规数',mode:'live'},
 {id:'engineering',name:'工程回归',version:'contract-v3.0.0',description:'离线验证契约、宿主保护、故障、幂等、会话隔离、预算及注入防护。',metrics:'工程契约通过率、错误数；不衡量真实模型能力',mode:'offline'}
];
const ajv=new Ajv({allErrors:true,strict:true,allowUnionTypes:true});
const object=properties=>({type:'object',additionalProperties:false,properties});
const text={type:'string',minLength:1,maxLength:100000};
const array=items=>({type:'array',items,maxItems:1000});
const labels=values=>({type:'array',items:{type:'string',enum:values},uniqueItems:true});
const message={...object({id:text,role:{enum:['user','assistant','system']},content:text}),required:['id','role','content']};
const emotionInput={...object({messages:{...array(message),minItems:1},current_message_id:text,transcription_quality:{type:['string','number','object','null']}}),required:['messages','current_message_id']};
const turn={...object({message:text,confirm:{type:'boolean'},resume:{type:'boolean'}}),required:['message']};
const businessInput={...object({actor:{enum:['citizen-a','citizen-b']},turns:{...array(turn),minItems:1},fixture_patch:{type:'object'},handoff_scenario:{enum:['queued','connected','unavailable']}}),required:['actor','turns']};
const tools=labels(buildCatalog(256).map(x=>x.id));
const paths=array({type:'array',items:{type:'string'},minItems:2,maxItems:2});
const assertion={...object({path:text,operator:{enum:['eq','length']},value:{}}),required:['path','operator','value']};
const planningProps={required_tools:tools,allowed_tools:tools,forbidden_tools:tools,required_tool_groups:array(tools),allowed_statuses:labels(STATUSES),required_clarification_fields:array(text),required_order:paths,tool_arguments:array({...object({tool:{type:'string'},contains:{type:'object'}}),required:['tool','contains']}),assertions:array(assertion),forbidden_claims:array(text),turn_expectations:array({...object({status:{enum:STATUSES},required_tools:tools,required_clarification_fields:array(text)})}),tasks_count:{type:'integer',minimum:0},task_status_counts:{type:'object',additionalProperties:{type:'integer',minimum:0}},status:{enum:['provisional','reviewed','contract_specification']}};
const planningRef={...object({...planningProps,acceptable_paths:array(object(planningProps))}),required:['required_tools','allowed_tools']};
const emotionRef=emotionReferenceSchema;
const integrationRef={...object({expected_routes:array({enum:['agent','human','clarify','session_closed']}),expected_sentiments:array({enum:[...SENTIMENTS,null]}),expected_assessment_statuses:array({enum:[...ASSESSMENT_STATUSES,'skipped']}),business_tools_by_turn:array(tools),expected_session_ended:array({type:'boolean'}),handoff_state:{enum:['queued','connected','failed']},status:{enum:['provisional','reviewed']}}),required:['expected_routes','expected_sentiments','expected_assessment_statuses','expected_session_ended','business_tools_by_turn','handoff_state']};
const engineeringRef={...object({expected_error:text,expected_invariant:text,status:{enum:['provisional','reviewed','contract_specification']}}),anyOf:[{properties:{expected_error:text},required:['expected_error']},{properties:{expected_invariant:text},required:['expected_invariant']}]};
export const MODULE_INPUTS={emotion:emotionInput,planning:businessInput,integration:businessInput};
const inputValidators={emotion:ajv.compile(emotionInput),planning:ajv.compile(businessInput),integration:ajv.compile(businessInput)};
const refValidators=Object.fromEntries(Object.entries({emotion:emotionRef,planning:planningRef,integration:integrationRef,engineering:engineeringRef}).map(([k,v])=>[k,ajv.compile(v)]));
const metadataSchema=object({split:{enum:['dev','regression','holdout']},language:{type:'string',maxLength:80},family_id:{type:'string',maxLength:120},tags:array({type:'string',maxLength:120}),provenance:{type:['string','object']}});
const validateMeta=ajv.compile(metadataSchema);
function located(errors,prefix,line){return errors.map(e=>({location:prefix+e.instancePath+(e.keyword==='required'?'/'+e.params.missingProperty:e.keyword==='additionalProperties'?'/'+e.params.additionalProperty:''),line:line??null,message:e.message}));}
function engineValidator(rows){
 const keys=[...new Set(rows.flatMap(x=>Object.keys(x.input)))];
 const field=k=>{
  if(k==='test_type')return {enum:[...new Set(rows.map(x=>x.input.test_type))]};
  if(k==='source_input')return emotionInput;
  if(['operation','second_tool'].includes(k))return {enum:buildCatalog(16).map(x=>x.id)};
  if(k==='actor')return {enum:['citizen-a','citizen-b']};
  if(k==='scenario')return {enum:[...new Set(rows.map(x=>x.input.scenario).filter(Boolean))]};
  const sample=rows.find(x=>k in x.input).input[k];
  if(typeof sample==='boolean')return {type:'boolean'};
  if(typeof sample==='number')return {type:'integer',minimum:0,maximum:k==='timeout_ms'?120000:1000};
  return {type:typeof sample==='object'?'object':'string'};
 };
 return ajv.compile({...object(Object.fromEntries(keys.map(k=>[k,field(k)]))),required:['test_type']});
}
export class DatasetStore {
 constructor(root='artifacts/web/datasets'){this.root=root;this.cache=new Map();}
 async initialize(){
  await mkdir(this.root,{recursive:true});
  for(const suite of SUITES){const d=await loadV2Suite(suite);this.cache.set('builtin-'+suite,{...d,id:'builtin-'+suite,name:'V3 冻结集 · '+MODULES.find(m=>m.id===suite).name,version:'v3.0',suite,builtin:true,read_only:true,reference_status:suite==='engineering'?'contract_specification':'provisional_synthetic'});}
  this.validateEngineering=engineValidator(this.cache.get('builtin-engineering').selected);
  for(const e of await readdir(this.root,{withFileTypes:true})){if(e.isFile()&&/^import-[a-f0-9]+\.json$/.test(e.name)){const envelope=await readJSON(join(this.root,e.name));this.cache.set(envelope.id,this.fromEnvelope(envelope));}}
 }
 fromEnvelope(e){return {contract_version:e.contract_version??'legacy',id:e.id,name:e.name,version:e.version,suite:e.module,builtin:false,read_only:true,reference_status:'user_supplied',created_at:e.created_at,selected:e.cases.map(c=>({case_id:c.case_id,input:c.input})),metadata:new Map(e.cases.map(c=>[c.case_id,{case_id:c.case_id,split:'regression',...c.metadata}])),references:new Map(e.cases.filter(c=>c.reference).map(c=>[c.case_id,c.reference])),fingerprint:hash(canonical(e)),release_digest:null};}
 list(){return [...this.cache.values()].map(d=>({id:d.id,name:d.name,version:d.version,module:d.suite,builtin:d.builtin,read_only:true,cases:d.selected.length,scored:d.references.size,hash:d.fingerprint,compatible:d.builtin||d.contract_version==='v3.0',reference_status:d.reference_status,created_at:d.created_at,splits:[...new Set([...d.metadata.values()].map(x=>x.split))],languages:[...new Set([...d.metadata.values()].map(x=>x.language??'unknown'))]}));}
 get(id){const d=this.cache.get(id);if(!d)throw Object.assign(new Error('数据集不存在'),{status:404});return d;}
 select(id,{suite,split='all',limit,caseIds}={}){const d=this.get(id);if(!d.builtin&&d.contract_version!=='v3.0')throw new Error('旧版导入集仅供浏览，请迁移后按 V3 模板重新导入');if(d.suite!==suite)throw new Error('模块与数据集不兼容');if(caseIds?.some(id=>!d.metadata.has(id)))throw new Error('案例 ID 不属于此版本');const selected=d.selected.filter(c=>(split==='all'||d.metadata.get(c.case_id).split===split)&&(!caseIds||caseIds.includes(c.case_id))).slice(0,limit??d.selected.length);if(!selected.length)throw new Error('筛选后没有案例');return {...d,selected};}
 cases(id,{q='',split='all',language='all',offset=0,limit=25}={}){const d=this.get(id);const matches=d.selected.filter(c=>(split==='all'||d.metadata.get(c.case_id).split===split)&&(language==='all'||(d.metadata.get(c.case_id).language??'unknown')===language)&&(!q||JSON.stringify([c,d.metadata.get(c.case_id)]).toLowerCase().includes(q.toLowerCase())));return {total:matches.length,offset,items:matches.slice(offset,offset+limit).map(c=>({...c,metadata:d.metadata.get(c.case_id),reference:d.references.get(c.case_id)??null,grading:d.references.has(c.case_id)?(d.suite==='planning'&&!fullTaskContract(d.references.get(c.case_id))?'tools_only':'reference'):'unscored'}))};}
 async template(module,gold=true,format='json'){
  if(!SUITES.includes(module))throw new Error('无效模块');const d=this.get('builtin-'+module),c=d.selected[0];const row={case_id:'CUSTOM-001',input:c.input,...(gold?{reference:d.references.get(c.case_id)}:{}),metadata:{split:'regression',language:'ar'}};
  return format==='jsonl'?JSON.stringify(row)+'\n':JSON.stringify({name:MODULES.find(m=>m.id===module).name+' 自定义集',version:'1.0',module,cases:[row]},null,2)+'\n';
 }
 preview({content,format='json',module,name,version='1.0'}){
  const errors=[],warnings=[];let e,lines=[];
  try{if(typeof content!=='string'||Buffer.byteLength(content)>10*1024*1024)throw new Error('内容应为不超过 10 MB 的文本');
   if(format==='jsonl'){const cases=[];for(const [i,s] of content.split(/\r?\n/).entries()){if(!s.trim())continue;try{cases.push(JSON.parse(s));lines.push(i+1);}catch{errors.push({location:'JSONL',line:i+1,message:'此行不是合法 JSON'});}}e={module,name,version,cases};}
   else if(format==='json')e=JSON.parse(content);else throw new Error('仅支持 JSON / JSONL');
  }catch(error){return {valid:false,errors:[{location:'文件',message:error.message}],warnings};}
  if(!e||Array.isArray(e)||typeof e!=='object')return {valid:false,errors:[{location:'文件',message:'JSON 应为数据集对象'}],warnings};
  for(const k of Object.keys(e))if(!['module','name','version','cases'].includes(k))errors.push({location:'/'+k,message:'未知数据集字段'});
  if(!SUITES.includes(e.module))errors.push({location:'/module',message:'应为 emotion / planning / integration / engineering'});
  for(const k of ['name','version'])if(typeof e[k]!=='string'||!e[k].trim()||e[k].length>120)errors.push({location:'/'+k,message:'需要 1–120 字符的文本'});
  if(!Array.isArray(e.cases)||!e.cases.length||e.cases.length>5000)errors.push({location:'/cases',message:'案例数需要 1–5000'});
  const seen=new Set();let scored=0,toolOnly=0;
  if(Array.isArray(e.cases)&&SUITES.includes(e.module))for(const [i,c] of e.cases.entries()){
   const prefix='/cases/'+i,line=lines[i];const add=(p,message)=>errors.push({location:prefix+p,line:line??null,message});
   if(!c||typeof c!=='object'||Array.isArray(c)){add('','案例应为对象');continue;}
   for(const k of Object.keys(c))if(!['case_id','input','reference','metadata'].includes(k))add('/'+k,'未知案例字段');
   if(typeof c.case_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(c.case_id))add('/case_id','ID 仅允许字母、数字、下划线或连字符，最多 120 字符');
   if(seen.has(c.case_id))add('/case_id','重复 ID');seen.add(c.case_id);
   const validator=e.module==='engineering'?this.validateEngineering:inputValidators[e.module];
   if(!validator(c.input))errors.push(...located(validator.errors,prefix+'/input',line));
   else if(e.module==='emotion'){
    const ids=c.input.messages.map(m=>m.id);if(new Set(ids).size!==ids.length)add('/input/messages','消息 ID 重复');
    if(!c.input.messages.some(m=>m.id===c.input.current_message_id&&m.role==='user'))add('/input/current_message_id','必须关联已有 user 消息');
   }else if(e.module==='engineering'){
    const candidates=this.get('builtin-engineering').selected.map(x=>x.input).filter(x=>x.test_type===c.input.test_type);
    if(c.input.scenario&&!candidates.some(x=>x.scenario===c.input.scenario))add('/input/scenario','该测试类型不支持此场景');
    const exemplar=candidates.find(x=>x.scenario===c.input.scenario&&x.operation===c.input.operation)??candidates.find(x=>x.scenario===c.input.scenario);
    if(!exemplar)add('/input','请选择模板中已支持的故障契约');
    else for(const key of Object.keys(exemplar))if(!(key in c.input))add('/input/'+key,'该故障契约缺少必需字段');
   }
   if(c.metadata&&!validateMeta(c.metadata))errors.push(...located(validateMeta.errors,prefix+'/metadata',line));
   if(c.reference!==undefined&&c.reference!==null){scored++;const validate=refValidators[e.module];if(!validate(c.reference))errors.push(...located(validate.errors,prefix+'/reference',line));
    else if(e.module==='emotion'&&validator(c.input)){const valid=validateEmotionReference(c.reference,c.input);if(!valid.ok)add('/reference/evidence','参考证据必须为合法标签及用户原话片段：'+JSON.stringify(valid.errors));}
    else if(e.module==='planning'){
     if(!fullTaskContract(c.reference))toolOnly++;
     if(c.reference.required_tools.some(t=>!c.reference.allowed_tools.includes(t)))add('/reference/allowed_tools','必须包含所有 required_tools');
     if(c.reference.required_tool_groups?.some(g=>!g.length||g.some(t=>!c.reference.allowed_tools.includes(t))))add('/reference/required_tool_groups','替代组不能为空，且应包含在允许工具中');
    }else if(e.module==='integration'){
     for(const k of ['expected_routes','expected_sentiments','expected_assessment_statuses','expected_session_ended','business_tools_by_turn'])if(c.reference[k].length!==c.input?.turns?.length)add('/reference/'+k,'参考轮数必须与输入轮数一致');
     for(const [j,assessment_status] of c.reference.expected_assessment_statuses.entries()){
      const sentiment=c.reference.expected_sentiments[j],route=c.reference.expected_routes[j];
      if(assessment_status==='skipped'){if(sentiment!==null||route!=='session_closed'||c.reference.expected_session_ended[j]!==true)add('/reference/expected_assessment_statuses/'+j,'跳过分析只适用于已结束会话');}
      else if(!validateEmotionReference({sentiment,assessment_status},{}).ok)add('/reference/expected_assessment_statuses/'+j,'情感与判定状态不匹配');
      if(route!=='agent'&&c.reference.business_tools_by_turn[j]?.length)add('/reference/business_tools_by_turn/'+j,'禁止路径不能包含业务工具');
     }
    }
   }
  }
  if(scored<(e.cases?.length??0))warnings.push('部分或全部案例只有输入：显示预测及 Trace，不计算这些案例的 Accuracy / P / R / F1。');
  if(toolOnly)warnings.push(`${toolOnly} 条只有工具选择参考：可计算工具 P/R/F1，不计完整任务通过率。`);
  warnings.push('导入参考为用户提供的标签；请经业务专家审核后用于验收。');
  if(/sk-[A-Za-z0-9_-]{16,}/.test(content))errors.push({location:'文件',message:'请勿在测试数据中包含 API key'});
  const digest=hash(canonical(e));return {valid:errors.length===0,errors:errors.slice(0,200),error_count:errors.length,warnings,digest,name:e.name,version:e.version,module:e.module,total:e.cases?.length??0,scored,tool_only:toolOnly,preview:e.cases?.slice(0,3),...(errors.length?{}:{envelope:e})};
 }
 async commit(payload){const p=this.preview(payload);if(!p.valid)throw Object.assign(new Error('导入校验失败'),{status:400,details:p});if(p.digest!==payload.digest)throw new Error('内容已变化，请重新预览');const id='import-'+uid('data').split('-').slice(1).join('');const e={...p.envelope,id,contract_version:'v3.0',created_at:new Date().toISOString()};const target=join(this.root,id+'.json');await writeJSON(target+'.tmp',e);await rename(target+'.tmp',target);this.cache.set(id,this.fromEnvelope(e));return this.list().find(d=>d.id===id);}
}
