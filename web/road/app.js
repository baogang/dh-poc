import {createChatRenderer} from './chat-ui.js';
import {translator,resolveLocale,uiError} from './i18n.js';
let state={id:null,running:false,status:'idle',user:null,messages:[],plans:[],activePlanId:null,pendingInput:null,pendingOperation:null,events:[],receipts:[],mock:{handoffs:[],calls:[]}},stream,generation=0,pollTimer,refreshing,refreshAgain=false;
const $=id=>document.getElementById(id);
const client={busy:false,connecting:true,pendingMessage:null,error:null};
let preferredLocale;try{preferredLocale=localStorage.getItem('road:locale');}catch{}
let locale=resolveLocale(preferredLocale,globalThis.navigator?.language),t=translator(locale);
const labels={idle:'准备就绪',running:'正在处理',review:'等待你确认计划',input:'等待你补充信息',confirmation:'等待你确认提交',completed:'已完成',answered:'已回答',blocked:'需要调整任务',failed:'本轮未完成',interrupted:'已中断',paused:'已暂停',approved:'已确认计划',human_waiting:'等待人工受理',human_active:'模拟人工处理中',human_completed:'人工处理已结束'};
let showTasks=true;try{showTasks=localStorage.getItem('road:showTasks')!=='false';}catch{}
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const json=(parent,value)=>{const d=el('details');d.dataset.key=JSON.stringify(value);d.append(el('summary',t('查看数据')),el('pre',JSON.stringify(value,null,2)));parent.append(d);};
async function request(path,data){
  const response=await fetch(path,{method:data?'POST':'GET',headers:data?{'content-type':'application/json','x-csrf-token':state?.csrf??''}:{},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(20000)});
  const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error?.message??t('请求未能完成')),{code:value.error?.code});return value;
}
function accept(value,owner){
  if(owner!==generation)return;
  const current=state.events.at(-1)?.seq??0,next=value.events.at(-1)?.seq??0;
  if(state.id===value.id&&next<current)return;
  state=value;client.connecting=false;render();
}
async function refresh(){
  if(refreshing){refreshAgain=true;return refreshing;}
  const owner=generation;
  refreshing=request('/api/state').then(value=>accept(value,owner)).catch(e=>{if(owner===generation){client.error={key:'连接暂时中断，正在尝试恢复。',code:e.code,detail:e.message};render();}}).finally(()=>{refreshing=null;if(refreshAgain){refreshAgain=false;refresh();}});
  return refreshing;
}
async function act(path,data){
  if(client.busy)return;const owner=generation;
  client.busy=true;client.error=null;client.pendingMessage=path==='/api/chat'?data.message:null;render();
  try{accept(await request(path,data),owner);}
  catch(e){if(owner===generation){client.error={key:'这次请求没有完成：',code:e.code,detail:e.message};if(path==='/api/chat')$('chat-message').value=data.message;}}
  finally{if(owner===generation){client.busy=false;client.pendingMessage=null;render();refresh();}}
}
async function signIn(credentials,continuation){
  await act('/api/login',credentials);if(client.error||!state.user)return;
  if(continuation?.kind==='plan'&&state.activePlanId===continuation.id)await act('/api/approve-plan',{plan_id:continuation.id});
  if(continuation?.kind==='input'&&state.pendingInput?.id===continuation.id)await act('/api/input',{input_id:continuation.id,value:{}});
}
const chat=createChatRenderer(document,$('messages'),{action:act,login:signIn,example:text=>{$('chat-message').value=text;$('chat-message').focus();},reconnect:()=>{client.error=null;client.connecting=true;render();start();}});
function connect(){
  stream?.close();clearInterval(pollTimer);const owner=generation;
  stream=new EventSource('/api/events?after='+(state.events.at(-1)?.seq??0));
  stream.onmessage=()=>{if(owner===generation)refresh();};
  stream.onopen=()=>{if(owner===generation){client.error=null;refresh();}};
  stream.onerror=()=>{if(owner===generation){client.error={key:'连接暂时中断，正在重新连接。你已填写的内容会保留。'};render();}};
  pollTimer=setInterval(()=>{if(state.running||client.error)refresh();},3000);
}
async function start(){
  const owner=generation;client.connecting=true;render();
  try{const r=await fetch('/api/state',{signal:AbortSignal.timeout(20000)});if(r.status===401||r.status===404)accept(await request('/api/session',{}),owner);else{const v=await r.json();if(!r.ok)throw Object.assign(new Error(v.error?.message??t('连接失败')),{code:v.error?.code});accept(v,owner);}if(owner===generation)connect();}
  catch(e){if(owner===generation){client.connecting=false;client.error={key:'无法连接政务服务助手：',code:e.code,detail:e.message};render();}}
}
const shellCopy={'brand-title':'政务服务','brand-meta':'PI SDK · DeepSeek Flash · MOCK 测试','new-session':'新对话','app-title':'政务服务助手','locale-caption':'界面语言','show-tasks-label':'显示任务列表','toolbar-hint':'计划、情绪和确认都在聊天中','message-label':'消息','composer-hint':'Enter 发送 · Shift+Enter 换行 · 中文 / English / العربية','stop':'停止','send':'发送','test-tools-label':'测试工具与运行记录','test-tools-hint':'仅用于测试查看；工单处理所需的操作均在聊天中。','human-title':'模拟人工工作台','knowledge-title':'问答库','receipts-title':'实际 API 回执','events-title':'执行记录'};
function render(){
  t=translator(locale);document.documentElement.setAttribute('lang',locale==='en'?'en':'zh-CN');document.title=t('政务服务助手');
  for(const [id,key]of Object.entries(shellCopy))$(id).textContent=t(key);
  $('ui-language').value=locale;$('ui-language').setAttribute('aria-label',t('界面语言'));$('messages').setAttribute('aria-label',t('对话、任务计划与操作确认'));$('chat-message').placeholder=t('描述问题，或告诉我你想改变什么…');$('show-tasks-control').title=t('在聊天中显示任务计划');
  const p=state.plans.find(x=>x.id===state.activePlanId),busy=client.busy||client.connecting;
  $('status').textContent=t(client.connecting?'正在连接':state.running?'正在处理':labels[state.status]??state.status);
  const emotion=state.emotion,emotionNode=$('emotion-status');emotionNode.hidden=!showTasks;emotionNode.className='emotion-status '+(emotion?.sentiment??'');
  emotionNode.textContent=t('当前情绪：{value}',{value:t(emotion?.status==='classified'?({positive:'正向 · positive',negative:'负向 · negative',neutral:'中性 · neutral'}[emotion.sentiment]):emotion?.status==='pending_faq'?'等待 FAQ 判定':emotion?.status==='analyzing'?'识别中…':emotion?.status==='skipped'?'FAQ 直答，未分析':emotion?.status==='error'?'识别暂不可用':'尚未识别')});
  $('human-section').hidden=!showTasks;
  $('show-tasks').checked=showTasks;$('send').disabled=busy||state.running;$('new-session').disabled=busy;
  $('stop').disabled=busy||!state.running&&!state.pendingInput&&!state.pendingOperation&&(!p||['completed','superseded','paused'].includes(p.status));
  chat.render(state,{showTasks,busy,locale,pendingMessage:client.pendingMessage&&state.messages.at(-1)?.text!==client.pendingMessage?client.pendingMessage:null,error:uiError(client.error,locale),connecting:client.connecting});
  const panels=$('test-tools');if(!panels.open)return;
  const openKeys=new Set([...panels.querySelectorAll('details[open][data-key]')].map(d=>d.dataset.key));
  $('events').replaceChildren();for(const e of state.events.slice(-80).reverse()){const row=el('div',new Date(e.time).toLocaleTimeString(locale==='en'?'en-GB':'zh-CN')+' · '+e.type);json(row,e);$('events').append(row);}
  $('receipts').replaceChildren();for(const r of state.receipts)json($('receipts'),r);
  $('human').replaceChildren();for(const h of state.mock.handoffs){const row=el('div',`${h.ticket_id??t('当前会话')} · ${h.status}`),next={WAITING:['受理','accept'],ACCEPTED:['升级','escalate'],ESCALATED:['完成人工处理','complete']}[h.status];if(next){const b=el('button',t(next[0]));b.disabled=busy||state.running;b.addEventListener('click',()=>act('/api/human',{handoff_id:h.handoff_id,action:next[1]}));row.append(b);}$('human').append(row);}
  $('knowledge').replaceChildren(el('p',state.faq?t('{name} · 已加载 {count} 条核实的问答',{name:state.faq.name,count:state.faq.entry_count}):t('正在加载问答库信息')));
  for(const d of panels.querySelectorAll('details[data-key]'))if(openKeys.has(d.dataset.key))d.open=true;
}
$('chat-form').addEventListener('submit',e=>{e.preventDefault();if(client.busy||state.running)return;const message=$('chat-message').value.trim();if(!message)return;$('chat-message').value='';act('/api/chat',{message});});
$('chat-message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();if(!e.repeat&&!$('send').disabled)$('chat-form').requestSubmit();}});
$('ui-language').addEventListener('change',()=>{locale=resolveLocale($('ui-language').value);try{localStorage.setItem('road:locale',locale);}catch{}render();});
$('show-tasks').addEventListener('change',()=>{showTasks=$('show-tasks').checked;try{localStorage.setItem('road:showTasks',String(showTasks));}catch{}render();});
$('test-tools').addEventListener('toggle',()=>{if($('test-tools').open)render();});
$('stop').addEventListener('click',()=>act('/api/cancel',{}));
$('new-session').addEventListener('click',async()=>{if(client.busy)return;if(state.running)await act('/api/cancel',{});generation++;stream?.close();clearInterval(pollTimer);client.error=null;client.connecting=true;client.pendingMessage=null;render();try{accept(await request('/api/session',{}),generation);connect();}catch(e){client.connecting=false;client.error={key:'请求未能完成',code:e.code,detail:e.message};render();}});
start().catch(e=>{client.error={key:'请求未能完成',code:e.code,detail:e.message};client.connecting=false;render();});
