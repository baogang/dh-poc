import Ajv from 'ajv';
export const EMOTIONS = ['satisfaction','gratitude','frustration','anger','worry','disappointment','confusion'];
export const INDICATORS = ['SA01','SA02','SA03','SA04','SA05'];
export const INTENTS = ['complaint_status','complaint_reopen','complaint_create','contact_history','application_status','certificate_query','land_use_change','planning_query','support_requirements','support_eligibility','support_status','investment_advice','investment_status','investment_cancel','clarify','other'];
export const STATUSES = ['completed','needs_input','needs_confirmation','pending','failed','handoff','cancelled','partial'];
const list = values => ({type:'array',uniqueItems:true,items:{type:'string',enum:values}});
export const emotionSchema = {type:'object',additionalProperties:false,required:['sentiment','emotions','indicators','evidence'],properties:{
  sentiment:{type:'string',enum:['positive','negative','neutral','mixed','undetermined']},emotions:list(EMOTIONS),indicators:list(INDICATORS),
  evidence:{type:'array',items:{type:'object',additionalProperties:false,required:['label','message_id','quote'],properties:{label:{type:'string'},message_id:{type:'string'},quote:{type:'string',minLength:1}}}},
  ambiguities:{type:'array',items:{type:'string'}},
}};
export function validateEmotion(value,input){
 const shape=validateShape(emotionSchema,value);if(!shape.ok)return shape;
 const labels=[...value.indicators,...value.emotions.map(e=>'emotion:'+e)];
 if(!['neutral','undetermined'].includes(value.sentiment))labels.push('sentiment:'+value.sentiment);
 const allowed=new Set([...INDICATORS,...EMOTIONS.map(e=>'emotion:'+e),...['positive','negative','neutral','mixed','undetermined'].map(s=>'sentiment:'+s)]);
 const errors=[];for(const e of value.evidence){const m=input.messages.find(m=>m.id===e.message_id);if(!m||m.role!=='user'||!m.content.includes(e.quote))errors.push('Evidence must be exact user span: '+e.label);if(!allowed.has(e.label))errors.push('Unregistered emotion evidence label: '+e.label);}
 for(const label of labels)if(!value.evidence.some(e=>e.label===label))errors.push('Missing evidence: '+label);
 return {ok:errors.length===0,errors};
}
export const analysisSchema = {type:'object',additionalProperties:false,required:['sentiment','emotions','indicators','intents','evidence'],properties:{
  sentiment:{type:'string',enum:['positive','negative','neutral','mixed','undetermined']},emotions:list(EMOTIONS),indicators:list(INDICATORS),intents:list(INTENTS),
  evidence:{type:'array',items:{type:'object',additionalProperties:false,required:['label','message_id','quote'],properties:{label:{type:'string'},message_id:{type:'string'},quote:{type:'string',minLength:1}}}},
  ambiguities:{type:'array',items:{type:'string'}},
}};
const validator = new Ajv({allErrors:true,strict:true}).compile(analysisSchema);
const ajv=new Ajv({allErrors:true,strict:true});
const shapeValidators=new WeakMap();
export function validateShape(schema,value){let validate=shapeValidators.get(schema);if(!validate){validate=ajv.compile(schema);shapeValidators.set(schema,validate);}if(validate(value))return {ok:true};const e=validate.errors[0];return {ok:false,code:e.keyword==='additionalProperties'?'UNKNOWN_FIELD':e.keyword==='required'?'MISSING_FIELD':e.keyword==='enum'?'INVALID_LABEL':'INVALID_FIELD',errors:validate.errors};}
export function validateAnalysis(value,input) {
  if(!validator(value)) return {ok:false,errors:validator.errors};
  const required = [...value.indicators,...value.emotions.map(e=>'emotion:'+e),...value.intents.map(i=>'intent:'+i)];
  if(!['neutral','undetermined'].includes(value.sentiment)) required.push('sentiment:'+value.sentiment);
  const evidenceErrors = value.evidence.flatMap(e=>{
    const m=input.messages.find(m=>m.id===e.message_id);
    return !m || m.role!=='user' || !m.content.includes(e.quote) ? [`Evidence quote is not an exact user span: ${e.label}`] : [];
  });
  for(const label of required) if(!value.evidence.some(e=>e.label===label)) evidenceErrors.push('Missing evidence: '+label);
  return {ok:evidenceErrors.length===0,errors:evidenceErrors};
}
