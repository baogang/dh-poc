import { uid,clone } from './util.mjs';
import { validateEmotion } from './contracts.mjs';
import { analyzeEmotion } from './analyzer.mjs';
import { EntryAgent } from './entry-agent.mjs';

export const DEFAULT_ROUTING_POLICY=Object.freeze({version:'negative-to-human-v2.0.0',
 routes:Object.freeze({positive:'agent',neutral:'agent',negative:'human',mixed:'clarify',undetermined:'clarify'}),analysis_failure:'human'});
export function decideRoute(analysis,state={},input={},policy=DEFAULT_ROUTING_POLICY){
 const valid=analysis?.valid===true;
 let action=valid?policy.routes[analysis.prediction.sentiment]:policy.analysis_failure;
 let reason=valid?'sentiment:'+analysis.prediction.sentiment:'emotion_analysis_failed';
 if(state.handoffActive&&!(input.resume===true&&valid&&action==='agent')){action='human';reason='handoff_session_owned';}
 if(!['agent','human','clarify'].includes(action))throw new Error('Invalid trusted routing configuration');
 return {id:uid('route'),action,reason,policy_version:policy.version};
}
export class MockHandoffConnector {
 constructor({scenario='queued'}={}){if(!['queued','connected','unavailable'].includes(scenario))throw new Error('Unsupported handoff fixture');this.scenario=scenario;this.records=[];}
 async request(bundle){const record={ticket_id:uid('handoff'),state:this.scenario==='unavailable'?'failed':this.scenario,source_type:'mock',handoff_simulated:true,handoff_transferred:false,bundle:clone(bundle)};this.records.push(record);return record;}
 async release(ticket){ticket.state='released';ticket.release_reason='trusted_self_service_resume';}
}
export class RoutedEntry {
 constructor({emotionClient,emotionAnalyzer=analyzeEmotion,plannerFactory,plannerOptions={},policy=DEFAULT_ROUTING_POLICY,handoff=new MockHandoffConnector()}={}){
  Object.assign(this,{emotionClient,emotionAnalyzer,plannerOptions,policy,handoff});this.plannerFactory=plannerFactory??(options=>new EntryAgent(options));this.conversation=[];this.turns=[];this.handoffActive=false;this.decision=null;
 }
 async handle(input,{signal}={}){
  signal?.throwIfAborted();
  const id='user-'+this.turns.length;this.conversation.push({id,role:'user',content:input.message});
  const source={messages:clone(this.conversation),current_message_id:id};let emotion;
  try{emotion=await this.emotionAnalyzer(this.emotionClient,source,{signal});if(emotion.valid&&!validateEmotion(emotion.prediction,source).ok)emotion={...emotion,valid:false,prediction:null,error:{code:'EMOTION_CONTRACT_INVALID'}};}
  catch(error){emotion={valid:false,prediction:null,version:'emotion-v2.0.0',error:{code:error.code??'EMOTION_ERROR',message:error.message}};}
  signal?.throwIfAborted();this.decision={...decideRoute(emotion,{handoffActive:this.handoffActive},input,this.policy),message_id:id};
  let result,handoff;
  if(this.decision.action==='agent'){
   if(this.activeHandoff)await this.handoff.release(this.activeHandoff);this.activeHandoff=null;
   this.handoffActive=false;
   this.planner??=this.plannerFactory({...this.plannerOptions,executionGuard:()=>this.decision?.action==='agent'&&!this.handoffActive});
   const turn=await this.planner.turn(input,{contextMessages:clone(this.conversation),signal});result=turn.result;
  }else if(this.decision.action==='human'){
   this.handoffActive=true;
   const snapshot=this.planner?.snapshot();
   this.planner?.session?.agent.abort();this.planner?.authorized.clear();this.planner?.proposals.clear();
   handoff=this.activeHandoff??await this.handoff.request({conversation:clone(this.conversation),emotion:emotion.prediction,route:clone(this.decision),task_snapshot:snapshot??null});this.activeHandoff=handoff;
   result={status:'handoff',answer:handoff.state==='failed'?'模拟人工渠道不可用，转接未成功；自动办理已暂停。':'已进入模拟人工交接，状态：'+handoff.state+'。这不表示真实人工已接通。',missing_fields:[],goals:[],receipt_ids:[],handoff_state:handoff.state,ticket_id:handoff.ticket_id,handoff_transferred:false,handoff_simulated:true,source_type:'mock'};
  }else result={status:'needs_input',answer:'情感倾向无法明确判定，请补充说明您的诉求；本轮未调用业务工具。',missing_fields:['clarification'],goals:[],receipt_ids:[],source_type:'mock'};
  const turn={emotion,route:clone(this.decision),result,...(handoff?{handoff}:{}),business_dispatches:this.planner?.trace.filter(t=>t.type==='business'&&t.backend_invoked).length??0};
  const saved=clone(turn);this.turns.push(saved);return clone(saved);
 }
 snapshot(){return {turns:clone(this.turns),conversation:clone(this.conversation),policy_version:this.policy.version,handoff_active:this.handoffActive,planner:this.planner?.snapshot()??null,handoff_records:clone(this.handoff.records??[])};}
 dispose(){this.planner?.dispose();}
}
