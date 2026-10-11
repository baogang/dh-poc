import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin,stdout } from 'node:process';
import { analyzeEmotion } from './analyzer.mjs';
import { DeepSeekClient } from './model.mjs';
import { EntryAgent } from './entry-agent.mjs';
import { MockClient } from './mock-client.mjs';
import { RoutedEntry,MockHandoffConnector } from './routing.mjs';
import { loadRegistry } from './capability-registry.mjs';
import { runV2Evaluation } from './evaluate-v2.mjs';
import { Budget,writeJSON,now,uid } from './util.mjs';
const {values,positionals}=parseArgs({allowPositionals:true,options:{suite:{type:'string',default:'emotion'},mode:{type:'string',default:'live'},split:{type:'string',default:'all'},limit:{type:'string'},concurrency:{type:'string',default:'6'},model:{type:'string'},'emotion-model':{type:'string'},'planner-model':{type:'string'},'planner-provider':{type:'string',default:'deepseek'},strategy:{type:'string',default:'flat'},'catalog-count':{type:'string',default:'16'},'case-ids':{type:'string'},'max-requests':{type:'string',default:'1800'},'max-tokens':{type:'string',default:'3000000'},output:{type:'string'},actor:{type:'string',default:'citizen-a'},'plugins-dir':{type:'string'},'handoff-scenario':{type:'string',default:'queued'}}});
const emotionModel=values['emotion-model']??values.model??process.env.EMOTION_MODEL??process.env.DEEPSEEK_MODEL??'deepseek-flash';
const plannerModel=values['planner-model']??values.model??process.env.PLANNER_MODEL??process.env.DEEPSEEK_MODEL??'deepseek-flash';
const command=positionals[0]??'help';
try{
 if(command==='eval'){
  for(const suite of values.suite==='all'?['emotion','planning','integration','engineering']:[values.suite])await runV2Evaluation({suite,mode:suite==='engineering'?'offline':values.mode,split:values.split,limit:values.limit?Number(values.limit):undefined,caseIds:values['case-ids']?.split(','),concurrency:Number(values.concurrency),emotionModel,plannerModel,plannerProvider:values['planner-provider'],strategy:values.strategy,catalogCount:Number(values['catalog-count']),maxRequests:Number(values['max-requests']),maxTokens:Number(values['max-tokens'])});
 }else if(command==='probe'){
  const result=await new DeepSeekClient({model:emotionModel,budget:new Budget({maxRequests:3})}).probe();await writeJSON('reports/probe/v2-connection.json',result);console.log(JSON.stringify({connected:result.chat.parsed.ok===true,model:result.chat.returned_model,models:result.models}));
 }else if(command==='emotion'){
  const message=positionals.slice(1).join(' ');if(!message)throw new Error('Provide a user message');const result=await analyzeEmotion(new DeepSeekClient({model:emotionModel,budget:new Budget({maxRequests:3,maxTokens:20000})}),{messages:[{id:'m1',role:'user',content:message}],current_message_id:'m1'});
  const path=values.output??`reports/manual/${now().replaceAll(/[:.]/g,'-')}-${uid('emotion').slice(-8)}.json`;await writeJSON(path,result);console.log(JSON.stringify({...result,report:path},null,2));
 }else if(command==='chat'||command==='plan'){
  const mock=await MockClient.start(),budget=new Budget({maxRequests:150,maxTokens:600000}),case_id=await mock.createCase({actor:values.actor});
  const registry=values['plugins-dir']?await loadRegistry(values['plugins-dir']):undefined;
  const options={mock,case_id,actor:values.actor,budget,model:plannerModel,provider:values['planner-provider'],apiKey:process.env[values['planner-provider'].toUpperCase().replaceAll('-','_')+'_API_KEY'],strategy:values.strategy,catalogCount:Number(values['catalog-count']),...(registry?{registry}:{})};
  const agent=command==='plan'?new EntryAgent(options):new RoutedEntry({emotionClient:new DeepSeekClient({model:emotionModel,budget}),plannerOptions:options,handoff:new MockHandoffConnector({scenario:values['handoff-scenario']})});
  const path=values.output??`reports/manual/${now().replaceAll(/[:.]/g,'-')}-${uid('session').slice(-8)}/session.json`;
  const rl=createInterface({input:stdin,output:stdout});console.log(JSON.stringify({mode:command==='plan'?'planning module only; emotion routing intentionally absent':'emotion -> host routing -> planner or simulated handoff',emotion_model:command==='plan'?null:emotionModel,planner_model:plannerModel,report:path}));
  try{let message=positionals.slice(1).join(' ');while(true){if(!message)message=await rl.question('User (exit, /confirm, /resume [request]): ');if(message==='exit')break;const confirm=message==='/confirm',resume=message==='/resume'||message.startsWith('/resume ');if(confirm)message='I confirm the exact proposal shown in the previous response.';if(resume)message=message.slice(7).trim()||'I want to resume self-service.';const input={message,confirm,resume};
   const turn=command==='plan'?await agent.turn(input):await agent.handle(input);const snapshot=agent.snapshot();await writeJSON(path,{...snapshot,oracle:await mock.snapshot(case_id),budget:budget.snapshot()});
   console.log(JSON.stringify(command==='plan'?turn.result:{emotion:turn.emotion.prediction,emotion_valid:turn.emotion.valid,route:turn.route,result:turn.result},null,2));
   console.log(JSON.stringify({report:path}));if(positionals.length>1)break;message='';}
  }finally{rl.close();agent.dispose();mock.stop();}
 }else console.log('Commands: emotion <message> | plan [message] | chat [message] | probe | eval --suite emotion|planning|integration|engineering|all --split all|dev|regression|holdout. Models: --emotion-model NAME --planner-model NAME. Interactive: /confirm, /resume [request], exit.');
}catch(error){console.error(JSON.stringify({error:error.code??'ERROR',message:error.message}));process.exitCode=1;}
