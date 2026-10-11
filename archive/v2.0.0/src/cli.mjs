import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin,stdout } from 'node:process';
import { DeepSeekClient } from './model.mjs';
import { analyze } from './analyzer.mjs';
import { EntryAgent } from './entry-agent.mjs';
import { MockClient } from './mock-client.mjs';
import { Budget,writeJSON } from './util.mjs';
import { runEvaluation } from './evaluate.mjs';
const {values,positionals}=parseArgs({allowPositionals:true,options:{suite:{type:'string',default:'semantic'},mode:{type:'string',default:'live'},split:{type:'string',default:'all'},limit:{type:'string'},concurrency:{type:'string',default:'6'},model:{type:'string',default:process.env.DEEPSEEK_MODEL??'deepseek-flash'},strategy:{type:'string',default:'flat'},'catalog-count':{type:'string',default:'16'},'dataset-version':{type:'string',default:'v1.2'},'case-ids':{type:'string'},'max-requests':{type:'string',default:'1800'},'max-tokens':{type:'string',default:'3000000'},output:{type:'string'}}});
const command=positionals[0]??'help';
try{
 if(command==='eval'){
  for(const suite of values.suite==='all'?['semantic','planning','engineering']:[values.suite])await runEvaluation({suite,mode:suite==='engineering'?'offline':values.mode,split:values.split,limit:values.limit?Number(values.limit):undefined,concurrency:Number(values.concurrency),model:values.model,strategy:values.strategy,catalogCount:Number(values['catalog-count']),datasetVersion:values['dataset-version'],caseIds:values['case-ids']?.split(','),maxRequests:Number(values['max-requests']),maxTokens:Number(values['max-tokens'])});
 }else if(command==='probe'){const result=await new DeepSeekClient({model:values.model,budget:new Budget({maxRequests:3})}).probe();await writeJSON('reports/probe/connection.json',result);console.log(JSON.stringify({connected:true,models:result.models,selected_model:result.selected_model,returned_model:result.chat.returned_model}));}
 else if(command==='chat'){
  const mock=await MockClient.start(),budget=new Budget({maxRequests:100,maxTokens:200000}),case_id=await mock.createCase(),agent=new EntryAgent({mock,case_id,budget,model:values.model,strategy:values.strategy,catalogCount:Number(values['catalog-count'])});const rl=createInterface({input:stdin,output:stdout}),client=new DeepSeekClient({model:values.model,budget});
  try{let message=positionals.slice(1).join(' ');while(true){if(!message)message=await rl.question('User (exit to stop, /confirm to approve exact pending proposal): ');if(message==='exit')break;const confirm=message==='/confirm';if(confirm)message='I confirm the exact proposal shown in the previous response.';const a=await analyze(client,{messages:[...agent.conversation,{id:`user-${agent.turns.length}`,role:'user',content:message}],current_message_id:`user-${agent.turns.length}`});if(!a.valid)throw new Error('Semantic contract invalid');const turn=await agent.turn({message,confirm},{analysis:a.prediction});console.log(JSON.stringify({analysis:a.prediction,...turn.result},null,2));if(values.output)await writeJSON(values.output,agent.snapshot());if(positionals.length>1)break;message='';}}finally{rl.close();agent.dispose();mock.stop();}
 }else console.log('Commands: probe | chat [message] | eval --suite semantic|planning|engineering|all --mode live|offline --split all|dev|regression|holdout --limit N --concurrency N --model deepseek-flash --strategy flat|layered --catalog-count 16|32|64|128|256');
}catch(error){console.error(JSON.stringify({error:error.code??'ERROR',message:error.message}));process.exitCode=1;}
