import { uid,clone } from './util.mjs';
import { validateEmotion } from './contracts.mjs';
import { analyzeEmotion,ANALYZER_VERSION } from './analyzer.mjs';
import { EntryAgent } from './entry-agent.mjs';
export const DEFAULT_ROUTING_POLICY=Object.freeze({version:'negative-to-human-v3.0.0',routes:Object.freeze({positive:'agent',neutral:'agent',negative:'human'}),clarification:'clarify',analysis_failure:'human'});
export function decideRoute(analysis,state={},input={},policy=DEFAULT_ROUTING_POLICY){
 if(state.sessionEnded)return {id:uid('route'),action:'session_closed',reason:'handoff_accepted_session_ended',policy_version:policy.version};
 const p=analysis?.prediction,valid=analysis?.valid===true&&((p?.assessment_status==='classified'&&['positive','neutral','negative'].includes(p.sentiment))||(p?.assessment_status==='needs_clarification'&&p.sentiment===null));
 let action=valid?(p.assessment_status==='needs_clarification'?policy.clarification:policy.routes[p.sentiment]):policy.analysis_failure;
 let reason=valid?(p.assessment_status==='needs_clarification'?'assessment:needs_clarification':'sentiment:'+p.sentiment):'emotion_analysis_failed';
 if(state.handoffActive){action='human';reason='handoff_pending_or_failed';}
 if(!['agent','human','clarify'].includes(action))throw new Error('Invalid trusted routing configuration');
 return {id:uid('route'),action,reason,policy_version:policy.version};
}
export class MockHandoffConnector {
 constructor({scenario='queued'}={}){if(!['queued','connected','unavailable'].includes(scenario))throw new Error('Unsupported handoff fixture');this.scenario=scenario;this.records=[];}
 async request(bundle,{signal}={}){signal?.throwIfAborted();const accepted=this.scenario!=='unavailable';const record={ticket_id:uid('handoff'),state:accepted?this.scenario:'failed',accepted,source_type:'mock',handoff_simulated:true,handoff_transferred:false,bundle:clone(bundle)};this.records.push(record);return record;}
}
export class RoutedEntry {
 constructor({emotionClient,emotionAnalyzer=analyzeEmotion,plannerFactory,plannerOptions={},policy=DEFAULT_ROUTING_POLICY,handoff=new MockHandoffConnector()}={}){
  Object.assign(this,{emotionClient,emotionAnalyzer,plannerOptions,policy,handoff});this.plannerFactory=plannerFactory??(options=>new EntryAgent(options));this.conversation=[];this.turns=[];this.handoffActive=false;this.sessionEnded=false;this.decision=null;
 }
 async handle(input,{signal}={}){
  signal?.throwIfAborted();
  // The conversation service receives subsequent messages. No analyzer, planner or new ticket.
  if(this.sessionEnded){const turn={emotion:{prediction:null,valid:false,skipped:true,reason:'session_ended'},route:decideRoute(null,{sessionEnded:true},input,this.policy),result:{status:'handoff',answer:'本次 Agent 会话已结束，后续消息由会话服务和人工渠道处理。',session_ended:true,handoff_state:this.activeHandoff.state,ticket_id:this.activeHandoff.ticket_id,missing_fields:[],goals:[],receipt_ids:[],handoff_transferred:false,handoff_simulated:true,source_type:'mock'},business_dispatches:0};this.turns.push(clone(turn));return clone(turn);}
  const dispatchesBefore=this.planner?.trace.filter(t=>t.type==='business'&&t.backend_invoked).length??0;
  const id='user-'+this.turns.length;this.conversation.push({id,role:'user',content:input.message});
  const source={messages:clone(this.conversation),current_message_id:id};let emotion;
  try{emotion=await this.emotionAnalyzer(this.emotionClient,source,{signal});if(emotion.valid&&!validateEmotion(emotion.prediction,source).ok)emotion={...emotion,valid:false,prediction:null,error:{code:'EMOTION_CONTRACT_INVALID'}};}
  catch(error){emotion={valid:false,prediction:null,version:ANALYZER_VERSION,error:{code:error.code??'EMOTION_ERROR',message:error.message}};}
  signal?.throwIfAborted();this.decision={...decideRoute(emotion,{handoffActive:this.handoffActive},input,this.policy),message_id:id};
  let result,handoff;
  if(this.decision.action==='agent'){
   this.planner??=this.plannerFactory({...this.plannerOptions,executionGuard:()=>this.decision?.action==='agent'&&!this.handoffActive&&!this.sessionEnded});
   const turn=await this.planner.turn(input,{contextMessages:clone(this.conversation),signal});result=turn.result;
  }else if(this.decision.action==='human'){
   this.handoffActive=true;const snapshot=this.planner?.snapshot();
   this.planner?.session?.agent.abort();this.planner?.authorized.clear();this.planner?.proposals.clear();
   try{handoff=await this.handoff.request({conversation:clone(this.conversation),emotion:emotion.prediction,route:clone(this.decision),task_snapshot:snapshot??null},{signal});}
   catch(error){signal?.throwIfAborted();handoff={ticket_id:null,state:'failed',accepted:false,error:{code:error.code??'HANDOFF_ERROR',message:error.message},handoff_transferred:false,handoff_simulated:true,source_type:'mock'};}
   signal?.throwIfAborted();this.activeHandoff=clone(handoff);this.sessionEnded=handoff.accepted===true;
   result={status:'handoff',answer:this.sessionEnded?'模拟人工系统已确认接收交接，本次 Agent 会话结束。':'模拟人工交接失败，自动办理已暂停，请联系人工。',missing_fields:[],goals:[],receipt_ids:[],handoff_state:handoff.state,ticket_id:handoff.ticket_id,session_ended:this.sessionEnded,handoff_transferred:false,handoff_simulated:true,source_type:'mock'};
  }else result={status:'needs_input',answer:'当前情感倾向无法确定，请补充完整信息。',missing_fields:['sentiment_clarification'],goals:[],receipt_ids:[],assessment_status:'needs_clarification',source_type:'mock'};
  const turn={emotion,route:clone(this.decision),result,...(handoff?{handoff}:{}),business_dispatches:(this.planner?.trace.filter(t=>t.type==='business'&&t.backend_invoked).length??0)-dispatchesBefore};
  this.conversation.push({id:'assistant-'+this.turns.length,role:'assistant',content:result.answer});const saved=clone(turn);this.turns.push(saved);return clone(saved);
 }
 snapshot(){return {turns:clone(this.turns),conversation:clone(this.conversation),policy_version:this.policy.version,handoff_active:this.handoffActive,session_ended:this.sessionEnded,planner:this.planner?.snapshot()??null,handoff_records:clone(this.handoff.records??[])};}
 dispose(){this.planner?.dispose();}
}
