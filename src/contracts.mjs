import Ajv from 'ajv';
export const CONTRACT_VERSION='emotion-v3.0.0';
export const SENTIMENTS=['positive','neutral','negative'];
export const ASSESSMENT_STATUSES=['classified','needs_clarification'];
export const EMOTIONS=['satisfaction','gratitude','frustration','anger','worry','disappointment','confusion'];
export const STATUSES=['completed','needs_input','needs_confirmation','pending','failed','handoff','cancelled','partial'];
const list=values=>({type:'array',uniqueItems:true,items:{type:'string',enum:values}});
const evidence={type:'array',items:{type:'object',additionalProperties:false,required:['label','message_id','quote'],properties:{label:{type:'string'},message_id:{type:'string'},quote:{type:'string',minLength:1}}}};
const core={sentiment:{enum:[...SENTIMENTS,null]},assessment_status:{enum:ASSESSMENT_STATUSES}};
const pairing=[{if:{properties:{assessment_status:{const:'classified'}},required:['assessment_status']},then:{properties:{sentiment:{enum:SENTIMENTS}}},else:{properties:{sentiment:{type:'null'}}}}];
export const emotionSchema={type:'object',additionalProperties:false,required:['sentiment','assessment_status','emotions','evidence'],properties:{...core,emotions:list(EMOTIONS),evidence,ambiguities:{type:'array',items:{type:'string'}}},allOf:pairing};
// References evaluate the core pair. Optional diagnostic emotions still need legal structure.
export const emotionReferenceSchema={type:'object',additionalProperties:false,required:['sentiment','assessment_status'],properties:{...core,emotions:list(EMOTIONS),evidence,status:{enum:['provisional','reviewed']}},allOf:pairing};
const ajv=new Ajv({allErrors:true,strict:true});
const shapeValidators=new WeakMap();
export function validateShape(schema,value){let validate=shapeValidators.get(schema);if(!validate){validate=ajv.compile(schema);shapeValidators.set(schema,validate);}if(validate(value))return {ok:true};const e=validate.errors.find(e=>e.keyword==='additionalProperties')??validate.errors.find(e=>e.keyword==='enum'||e.keyword==='const')??validate.errors[0];return {ok:false,code:e.keyword==='additionalProperties'?'UNKNOWN_FIELD':e.keyword==='required'?'MISSING_FIELD':['enum','const'].includes(e.keyword)?'INVALID_LABEL':'INVALID_FIELD',errors:validate.errors};}
function checkEvidence(value,input,{reference=false}={}){
 const errors=[],assigned=new Set([...(value.emotions??[]).map(e=>'emotion:'+e),...(value.sentiment?['sentiment:'+value.sentiment]:[])]);
 for(const e of value.evidence??[]){const m=input?.messages?.find(m=>m.id===e.message_id);if(!m||m.role!=='user'||!m.content.includes(e.quote))errors.push('Evidence must be exact user span: '+e.label);if(!assigned.has(e.label))errors.push('Unregistered or unassigned evidence label: '+e.label);if(!reference&&e.message_id!==input.current_message_id)errors.push('Evidence must belong to current user message: '+e.label);}
 if(!reference){for(const label of assigned)if(label!=='sentiment:neutral'&&!value.evidence.some(e=>e.label===label))errors.push('Missing evidence: '+label);}
 return {ok:!errors.length,errors};
}
export function validateEmotion(value,input){const shape=validateShape(emotionSchema,value);return shape.ok?checkEvidence(value,input):shape;}
export function validateEmotionReference(value,input){const shape=validateShape(emotionReferenceSchema,value);return shape.ok?checkEvidence(value,input,{reference:true}):shape;}
// Names retained for callers of the engineering contract; both use the current contract.
export const analysisSchema=emotionSchema;
export const validateAnalysis=validateEmotion;
