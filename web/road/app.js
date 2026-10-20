import {createChatRenderer} from './chat-ui.js';
import {createMobileClient} from './mobile-client.js';
import {createMapPicker} from './map-picker.js';
import {locationText} from './location-data.js';
import {translator,resolveLocale,uiError} from './i18n.js';
import {createFeedbackController,downloadFeedback} from './feedback-ui.js';
let state={id:null,running:false,status:'idle',user:null,messages:[],plans:[],activePlanId:null,pendingInput:null,pendingOperation:null,events:[],receipts:[],mock:{handoffs:[],calls:[]}},stream,generation=0,pollTimer,refreshing,refreshAgain=false;
const $=id=>document.getElementById(id);
const client={busy:false,connecting:true,pendingMessage:null,error:null,expired:false};
const ratings=createFeedbackController({request,onChange:()=>render()});
const mapPicker=createMapPicker(document);let selectedLocation=null;
let preferredLocale;try{preferredLocale=localStorage.getItem('road:locale');}catch{}
let locale=resolveLocale(preferredLocale,globalThis.navigator?.language),t=translator(locale);
const labels={clarification:'请选择服务',human_offer:'请选择帮助方式',idle:'准备就绪',expired:'会话已过期',running:'正在处理',review:'等待你确认计划',input:'等待你补充信息',confirmation:'等待你确认提交',completed:'本轮已答复',answered:'已回答',blocked:'需要调整任务',failed:'本轮未完成',interrupted:'已中断',paused:'已暂停',approved:'已确认计划',human_waiting:'等待人工受理',human_active:'模拟人工处理中',human_completed:'人工处理已结束'};
let showTasks=true;try{showTasks=localStorage.getItem('road:showTasks')!=='false';}catch{}
const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const json=(parent,value)=>{const d=el('details');d.dataset.key=JSON.stringify(value);d.append(el('summary',t('查看数据')),el('pre',JSON.stringify(value,null,2)));parent.append(d);};
async function request(path,data){
  const response=await fetch(path,{method:data?'POST':'GET',headers:data?{'content-type':'application/json','x-csrf-token':state?.csrf??''}:{},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(20000)});
  const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error?.message??t('请求未能完成')),{code:value.error?.code,current:value.error?.current});return value;
}
function accept(value,owner){
  if(owner!==generation)return;
  const current=state.events.at(-1)?.seq??0,next=value.events.at(-1)?.seq??0;
  if(state.id===value.id&&next<current)return;
  state=value;client.connecting=false;client.expired=false;render();ratings.sync(state);
}
function expired(error){
  if(error.code!=='SESSION_EXPIRED')return false;
  client.expired=true;client.connecting=false;state.running=false;state.status='expired';state.pendingInput=null;state.pendingOperation=null;
  const plan=state.plans.find(p=>p.id===state.activePlanId);if(plan&&plan.status!=='completed'){plan.approved=false;plan.status='paused';}
  if(state.feedback)state.feedback.enabled=false;stream?.close();clearInterval(pollTimer);
  client.error={key:'会话已过期，请开始新对话。'};return true;
}
async function refresh(){
  if(refreshing){refreshAgain=true;return refreshing;}
  const owner=generation;
  refreshing=request('/api/state').then(value=>accept(value,owner)).catch(e=>{if(owner===generation){if(!expired(e))client.error={key:'连接暂时中断，正在尝试恢复。',code:e.code,detail:e.message};render();}}).finally(()=>{refreshing=null;if(refreshAgain){refreshAgain=false;if(!client.expired)refresh();}});
  return refreshing;
}
async function act(path,data){
  if(client.busy||client.expired)return;const owner=generation;
  client.busy=true;client.error=null;client.pendingMessage=path==='/api/chat'?data.message:null;render();
  try{accept(await request(path,data),owner);}
  catch(e){if(owner===generation){if(!expired(e))client.error={key:'这次请求没有完成：',code:e.code,detail:e.message};if(path==='/api/chat')$('chat-message').value=data.message;}}
  finally{if(owner===generation){client.busy=false;client.pendingMessage=null;render();if(!client.expired)refresh();}}
}
async function signIn(credentials,continuation){
  await act('/api/login',{...credentials,...(continuation?.kind==='matters'?{show_matters:true}:{})});if(client.error||!state.user)return;
  if(continuation?.kind==='plan'&&state.activePlanId===continuation.id)await act('/api/approve-plan',{plan_id:continuation.id});
  if(continuation?.kind==='input'&&state.pendingInput?.id===continuation.id)await act('/api/input',{input_id:continuation.id,value:{}});
}
const chat=createChatRenderer(document,$('messages'),{action:act,login:signIn,pickLocation:options=>mapPicker.open(options),rate:(id,rating)=>ratings.choose(state,id,rating),example:text=>{$('chat-message').value=text;$('chat-message').focus();},reconnect:()=>{client.error=null;client.connecting=true;render();start();}});
const mobile=createMobileClient(document,{action:act,login:signIn,pickLocation:options=>mapPicker.open(options),rate:(id,rating)=>ratings.choose(state,id,rating),reconnect:()=>{client.error=null;client.connecting=true;render();start();},newSession});
function connect(){
  stream?.close();clearInterval(pollTimer);const owner=generation;
  stream=new EventSource('/api/events?after='+(state.events.at(-1)?.seq??0));
  stream.onmessage=()=>{if(owner===generation)refresh();};
  stream.onopen=()=>{if(owner===generation){client.error=null;refresh();}};
  stream.onerror=()=>{if(owner===generation&&!client.expired){client.error={key:'连接暂时中断，正在重新连接。你已填写的内容会保留。'};render();}};
  pollTimer=setInterval(()=>{if(state.running||client.error||state.activeHandoffId)refresh();},3000);
}
async function start(){
  const owner=generation;client.connecting=true;render();
  try{const r=await fetch('/api/state',{signal:AbortSignal.timeout(20000)});if(r.status===401||r.status===404||r.status===410)accept(await request('/api/session',{}),owner);else{const v=await r.json();if(!r.ok)throw Object.assign(new Error(v.error?.message??t('连接失败')),{code:v.error?.code});accept(v,owner);}if(owner===generation)connect();}
  catch(e){if(owner===generation){client.connecting=false;client.error={key:'无法连接政务服务助手：',code:e.code,detail:e.message};render();}}
}
const shellCopy={'mobile-client':'移动端体验','my-matters':'我的事项','service-catalog':'服务目录','human-help':'人工帮助','brand-title':'BALADY','brand-meta':'PI SDK · BALADY CRM · 本地仿真','new-session':'新对话','app-title':'BALADY 助理','locale-caption':'界面语言','show-tasks-label':'显示任务列表','toolbar-hint':'计划与操作确认都在聊天中','message-label':'消息','composer-hint':'Enter 发送 · Shift+Enter 换行 · 中文 / English / العربية','stop':'停止','send':'发送','test-tools-label':'测试工具与运行记录','test-tools-hint':'仅用于测试查看；工单处理所需的操作均在聊天中。','human-title':'模拟人工工作台','knowledge-title':'问答库','receipts-title':'实际 API 回执','events-title':'执行记录','feedback-tools-title':'回答反馈数据','feedback-export-csv':'导出 CSV','feedback-export-jsonl':'导出 JSONL','feedback-tools-hint':'统计与导出当前浏览器收集的反馈；集中数据已保存在云端。'};
function render(){
  t=translator(locale);document.documentElement.setAttribute('lang',locale==='en'?'en':'zh-CN');document.title=t('BALADY 助理');
  for(const [id,key]of Object.entries(shellCopy))$(id).textContent=t(key);
  $('ui-language').value=locale;$('ui-language').setAttribute('aria-label',t('界面语言'));$('messages').setAttribute('aria-label',t('对话、任务计划与操作确认'));$('chat-message').placeholder=t('描述问题，或告诉我你想改变什么…');$('show-tasks-control').title=t('在聊天中显示任务计划');
  const p=state.plans.find(x=>x.id===state.activePlanId),busy=client.busy||client.connecting;
  $('status').textContent=t(client.connecting?'正在连接':state.running?'正在处理':labels[state.status]??state.status);
  // Demo observation is independent of task-list visibility and has no effect on routing.
  const demo=state.demo_ui===true,emotion=state.emotion;
  $('emotion-sidebar').hidden=!demo;$('app-layout').className='app-layout'+(demo?'':' demo-disabled');
  const moods={positive:['正向','用户表达了满意、感谢或认可。','M16 27 Q24 37 32 27'],neutral:['中性','用户正在咨询或描述情况。','M16 29 Q24 29 32 29'],negative:['负向','用户表达了不满、焦虑或失望。','M16 32 Q24 22 32 32']};
  const mood=emotion?.status==='classified'?moods[emotion.sentiment]:null;
  const pending={pending_faq:['等待 FAQ 判定','等待本轮问答库判定。'],analyzing:['识别中…','正在识别本轮消息的情绪。'],skipped:['FAQ 直答，未分析','本轮由问答库直接回答，未进行情绪识别。'],error:['识别暂不可用','暂时无法识别，请以用户原话为准。']};
  const view=mood??(emotion?.reason==='faq_clarification'?['等待服务确认，未分析','需要先明确咨询的服务，尚未分析情绪。']:pending[emotion?.status])??['尚未识别','开始聊天后，这里会展示识别结果。'];
  $('emotion-title').textContent=t('用户当前情绪');$('emotion-demo-note').textContent=t('仅供演示观察，不在正式用户界面展示。');
  $('emotion-card').dataset.sentiment=demo&&mood?emotion.sentiment:'unclassified';
  $('emotion-status').textContent=demo?t(view[0]):'';$('emotion-description').textContent=demo?t(view[1]):'';
  $('emotion-mouth').setAttribute('d',mood?.[2]??moods.neutral[2]);
  const quote=demo&&mood?emotion.evidence?.quote:null;
  $('emotion-evidence').hidden=!quote;$('emotion-evidence-label').textContent=t('查看识别依据');$('emotion-quote').textContent=quote??'';
  $('human-section').hidden=!showTasks;
  $('service-catalog').disabled=busy||state.running||client.expired;$('my-matters').disabled=busy||state.running||client.expired;$('human-help').disabled=busy||state.running||client.expired;
  $('show-tasks').checked=showTasks;$('send').disabled=busy||state.running||client.expired;$('new-session').disabled=busy;
  $('choose-location').textContent=t('选择问题位置');$('choose-location').disabled=busy||state.running||client.expired;
  $('selected-location').hidden=!selectedLocation;$('selected-location-text').textContent=selectedLocation?locationText(selectedLocation,locale):'';$('clear-location').textContent=t('移除位置');
  $('stop').disabled=busy||client.expired||!state.running&&!state.pendingInput&&!state.pendingOperation&&(!p||['completed','superseded','paused'].includes(p.status));
  const chatView={showTasks,busy:busy||client.expired,locale,feedback:ratings.view(state),pendingMessage:client.pendingMessage&&state.messages.at(-1)?.text!==client.pendingMessage?client.pendingMessage:null,error:uiError(client.error,locale),connecting:client.connecting};
  chat.render(state,chatView);mobile.update(state,chatView);
  $('feedback-tools').hidden=!state.feedback?.enabled;
  const feedbackSummary=ratings.summary();
  $('feedback-count').textContent=t('已收集 {total} 条 · 满意 {yes} · 不满意 {no} · 满意率 {rate}',{total:feedbackSummary.total,yes:feedbackSummary.satisfied,no:feedbackSummary.unsatisfied,rate:feedbackSummary.rate===null?'—':feedbackSummary.rate+'%'});
  $('feedback-backup-note').textContent=feedbackSummary.exportError?t('暂无可导出的反馈。'):feedbackSummary.backupWarning?t('云端保存不受影响，但浏览器备份不可用，请及时导出。'):feedbackSummary.cloudWarning?t('云端暂时不可用，已保留的浏览器备份仍可导出。'):t('仅已保存的评价计入统计；未评价不等于不满意。');
  $('feedback-export-csv').disabled=feedbackSummary.total===0;$('feedback-export-jsonl').disabled=feedbackSummary.total===0;
  const panels=$('test-tools');if(!panels.open)return;
  const openKeys=new Set([...panels.querySelectorAll('details[open][data-key]')].map(d=>d.dataset.key));
  $('events').replaceChildren();for(const e of state.events.slice(-80).reverse()){const row=el('div',new Date(e.time).toLocaleTimeString(locale==='en'?'en-GB':'zh-CN')+' · '+e.type);json(row,e);$('events').append(row);}
  $('receipts').replaceChildren();for(const r of state.receipts)json($('receipts'),r);
  $('human').replaceChildren();for(const h of state.mock.handoffs){const row=el('div',`${h.ticket_id??t('当前会话')} · ${h.status}`),next={WAITING:['受理','accept'],ACCEPTED:['升级','escalate'],ESCALATED:['完成人工处理','complete']}[h.status];if(next){const b=el('button',t(next[0]));b.disabled=busy||state.running;b.addEventListener('click',()=>act('/api/human',{handoff_id:h.handoff_id,action:next[1]}));row.append(b);}$('human').append(row);}
  $('knowledge').replaceChildren(el('p',state.faq?t('{name} · 已加载 {count} 条原始问答，政策待复核',{name:state.faq.name,count:state.faq.entry_count}):t('正在加载问答库信息')));
  for(const d of panels.querySelectorAll('details[data-key]'))if(openKeys.has(d.dataset.key))d.open=true;
}
$('chat-form').addEventListener('submit',async e=>{e.preventDefault();if(client.busy||client.expired||state.running)return;const message=$('chat-message').value.trim(),location=selectedLocation;if(!message&&!location)return;$('chat-message').value='';selectedLocation=null;await act('/api/chat',{message,...(location?{location,location_locale:locale}:{})});if(client.error&&location&&!selectedLocation){selectedLocation=location;render();}});
$('choose-location').addEventListener('click',async()=>{const owner=generation,point=await mapPicker.open({locale,initial:selectedLocation});if(point&&owner===generation){selectedLocation=point;render();$('chat-message').focus();}});
$('clear-location').addEventListener('click',()=>{selectedLocation=null;render();});
$('chat-message').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();if(!e.repeat&&!$('send').disabled)$('chat-form').requestSubmit();}});
$('ui-language').addEventListener('change',()=>{locale=resolveLocale($('ui-language').value);try{localStorage.setItem('road:locale',locale);}catch{}render();});
$('show-tasks').addEventListener('change',()=>{showTasks=$('show-tasks').checked;try{localStorage.setItem('road:showTasks',String(showTasks));}catch{}render();});
for(const format of ['csv','jsonl'])$('feedback-export-'+format).addEventListener('click',async()=>{const data=await ratings.exportData(state,format);if(data)downloadFeedback(data.text,format);});
$('test-tools').addEventListener('toggle',()=>{if($('test-tools').open)render();});
$('my-matters').addEventListener('click',()=>act('/api/matters',{action:'list'}));
$('service-catalog').addEventListener('click',()=>act('/api/catalog',{}));
$('human-help').addEventListener('click',()=>act('/api/help',{action:'offer'}));
$('stop').addEventListener('click',()=>act('/api/cancel',{}));
async function newSession(){if(client.busy)return;if(state.running)await act('/api/cancel',{});generation++;selectedLocation=null;stream?.close();clearInterval(pollTimer);client.error=null;client.connecting=true;client.pendingMessage=null;render();try{accept(await request('/api/session',{}),generation);connect();}catch(e){client.connecting=false;client.error={key:'请求未能完成',code:e.code,detail:e.message};render();}}
$('new-session').addEventListener('click',newSession);
$('mobile-client').addEventListener('click',()=>mobile.open($('mobile-client')));
start().catch(e=>{client.error={key:'请求未能完成',code:e.code,detail:e.message};client.connecting=false;render();});
