import { Type,InMemoryCredentialStore,InMemoryModelsStore,fauxProvider } from '@earendil-works/pi-ai';
import { ModelRuntime,SettingsManager,SessionManager,createAgentSession,createExtensionRuntime } from '@earendil-works/pi-coding-agent';
import { id,failure } from './store.mjs';

export { Type };
export const pack=value=>({content:[{type:'text',text:JSON.stringify(value)}],details:value});
const loader=system=>({getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),getSystemPrompt:()=>system,getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],extendResources:()=>{},reload:async()=>{}});

export async function controlledSession({system,tools,fauxResponses,apiKey=process.env.DEEPSEEK_API_KEY,modelId=process.env.DEEPSEEK_MODEL??'deepseek-flash',maxRequests=12,onEvent=()=>{}}){
  const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  let model;
  if(fauxResponses){const faux=fauxProvider({provider:id('faux'),api:id('api')});runtime.registerNativeProvider(faux.provider);faux.setResponses(fauxResponses);model=faux.getModel();}
  else{
    if(!apiKey)throw failure('MODEL_NOT_CONFIGURED','DeepSeek credential is not configured',503);
    await runtime.setRuntimeApiKey('deepseek',apiKey);model=runtime.getModel('deepseek',modelId);
    if(!model)throw failure('UNKNOWN_MODEL','Model is absent from the pinned PI catalog');
  }
  const {session}=await createAgentSession({cwd:process.cwd(),agentDir:'/tmp/road-pothole-controlled-agent',modelRuntime:runtime,model,thinkingLevel:'off',resourceLoader:loader(system),customTools:tools,tools:tools.map(t=>t.name),sessionManager:SessionManager.inMemory(process.cwd()),settingsManager:SettingsManager.inMemory({compaction:{enabled:false},cacheWarming:'off',retry:{enabled:false,provider:{maxRetries:0,timeoutMs:60000}}})});
  session.setActiveToolsByName(tools.map(t=>t.name));
  let requests=0;
  session.agent.onPayload=payload=>{
    if(++requests>maxRequests)throw failure('MODEL_BUDGET','Per-turn model request limit reached');
    onEvent({type:'model_request',request:requests});
    return fauxResponses?payload:{...payload,tool_choice:'required',thinking:{type:'disabled'},temperature:0,max_tokens:2400};
  };
  session.subscribe(event=>{
    if(event.type==='message_end'&&event.message?.role==='assistant')onEvent({type:'model_result',usage:event.message.usage,stop_reason:event.message.stopReason,tool_calls:event.message.content.filter(c=>c.type==='toolCall').map(c=>({name:c.name,arguments:c.arguments}))});
  });
  return {session,runtime,requests:()=>requests};
}
