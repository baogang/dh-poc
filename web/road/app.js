import {createChatRenderer} from './chat-ui.js';
let state={id:null,running:false,status:'idle',user:null,messages:[],plans:[],activePlanId:null,pendingInput:null,pendingOperation:null,events:[],receipts:[],mock:{handoffs:[],calls:[]}},stream,generation=0,pollTimer,refreshing,refreshAgain=false;
const $=id=>document.getElementById(id);
const client={busy:false,connecting:true,pendingMessage:null,error:null};
const labels={idle:'准备就绪',running:'正在处理',review:'等待你确认计划',input:'等待你补充信息',confirmation:'等待你确认提交',completed:'已完成',answered:'已回答',blocked:'需要调整任务',failed:'本轮未完成',interrupted:'已中断',paused:'已暂停',approved:'已确认计划'};
let showTasks=true;try{showTasks=localStorage.getItem('road:showTasks')!=='false';}catch{}
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const json=(parent,value)=>{const d=el('details');d.dataset.key=JSON.stringify(value);d.append(el('summary','查看数据'),el('pre',JSON.stringify(value,null,2)));parent.append(d);};
async function request(path,data){
  const response=await fetch(path,{method:data?'POST':'GET',headers:data?{'content-type':'application/json','x-csrf-token':state?.csrf??''}:{},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(20000)});
  const value=await response.json();if(!response.ok)throw new Error(value.error?.message??'请求未能完成');return value;
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
  refreshing=request('/api/state').then(value=>accept(value,owner)).catch(e=>{if(owner===generation){client.error='连接暂时中断，正在尝试恢复。'+e.message;render();}}).finally(()=>{refreshing=null;if(refreshAgain){refreshAgain=false;refresh();}});
  return refreshing;
}
async function act(path,data){
  if(client.busy)return;const owner=generation;
  client.busy=true;client.error=null;client.pendingMessage=path==='/api/chat'?data.message:null;render();
  try{accept(await request(path,data),owner);}
  catch(e){if(owner===generation){client.error='这次请求没有完成：'+e.message;if(path==='/api/chat')$('chat-message').value=data.message;}}
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
  stream.onerror=()=>{if(owner===generation){client.error='连接暂时中断，正在重新连接。你已填写的内容会保留。';render();}};
  pollTimer=setInterval(()=>{if(state.running||client.error)refresh();},3000);
}
async function start(){
  const owner=generation;client.connecting=true;render();
  try{const r=await fetch('/api/state',{signal:AbortSignal.timeout(20000)});if(r.status===401||r.status===404)accept(await request('/api/session',{}),owner);else{const v=await r.json();if(!r.ok)throw new Error(v.error?.message??'连接失败');accept(v,owner);}if(owner===generation)connect();}
  catch(e){if(owner===generation){client.connecting=false;client.error='无法连接工单助手：'+e.message;render();}}
}
function render(){
  const p=state.plans.find(x=>x.id===state.activePlanId),busy=client.busy||client.connecting;
  $('status').textContent=client.connecting?'正在连接':state.running?'正在处理':labels[state.status]??state.status;
  $('show-tasks').checked=showTasks;$('send').disabled=busy||state.running;$('new-session').disabled=busy;
  $('stop').disabled=busy||!state.running&&!state.pendingInput&&!state.pendingOperation&&(!p||['completed','superseded','paused'].includes(p.status));
  chat.render(state,{showTasks,busy,pendingMessage:client.pendingMessage&&state.messages.at(-1)?.text!==client.pendingMessage?client.pendingMessage:null,error:client.error,connecting:client.connecting});
  const panels=$('test-tools');if(!panels.open)return;
  const openKeys=new Set([...panels.querySelectorAll('details[open][data-key]')].map(d=>d.dataset.key));
  $('events').replaceChildren();for(const e of state.events.slice(-80).reverse()){const row=el('div',new Date(e.time).toLocaleTimeString()+' · '+e.type);json(row,e);$('events').append(row);}
  $('receipts').replaceChildren();for(const r of state.receipts)json($('receipts'),r);
  $('human').replaceChildren();for(const h of state.mock.handoffs){const row=el('div',`${h.ticket_id} · ${h.status}`),next={WAITING:['受理','accept'],ACCEPTED:['升级','escalate'],ESCALATED:['完成人工处理','complete']}[h.status];if(next){const b=el('button',next[0]);b.disabled=busy||state.running;b.addEventListener('click',()=>act('/api/human',{handoff_id:h.handoff_id,action:next[1]}));row.append(b);}$('human').append(row);}
  $('knowledge').replaceChildren(el('p',state.faq?`${state.faq.name} · 已加载 ${state.faq.entry_count} 条核实的问答`:'正在加载问答库信息'));
  for(const d of panels.querySelectorAll('details[data-key]'))if(openKeys.has(d.dataset.key))d.open=true;
}
$('chat-form').addEventListener('submit',e=>{e.preventDefault();if(client.busy||state.running)return;const message=$('chat-message').value.trim();if(!message)return;$('chat-message').value='';act('/api/chat',{message});});
$('chat-message').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))$('chat-form').requestSubmit();});
$('show-tasks').addEventListener('change',()=>{showTasks=$('show-tasks').checked;try{localStorage.setItem('road:showTasks',String(showTasks));}catch{}render();});
$('test-tools').addEventListener('toggle',()=>{if($('test-tools').open)render();});
$('stop').addEventListener('click',()=>act('/api/cancel',{}));
$('new-session').addEventListener('click',async()=>{if(client.busy)return;if(state.running)await act('/api/cancel',{});generation++;stream?.close();clearInterval(pollTimer);client.error=null;client.connecting=true;client.pendingMessage=null;render();try{accept(await request('/api/session',{}),generation);connect();}catch(e){client.connecting=false;client.error=e.message;render();}});
start().catch(e=>{client.error=e.message;client.connecting=false;render();});
