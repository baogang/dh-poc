import {clone,digest,id,failure} from './store.mjs';
import {languageOf} from './presentation.mjs';
export const humanState=s=>s.mock.handoffs.find(h=>h.handoff_id===s.activeHandoffId&&h.scope==='conversation');
const words={zh:{queued:'已按你的选择加入模拟人工队列，尚未有人受理。自动业务已暂停，未确认的提交不会继续。',waiting:'你补充的信息已加入人工会话，当前仍在排队，尚未有人工受理。',reply:'【模拟人工客服】已收到你的补充信息，会结合本次会话继续跟进。',done:'本次模拟人工处理已结束。你可以点击“返回智能助手”继续办理；这不代表道路已修复。',resumed:'已返回智能助手。请告诉我接下来要处理什么，原来的提交授权已失效。',accepted:'模拟人工客服已接入。你可以继续在聊天中补充情况。',escalated:'本次模拟人工会话已升级给主管继续跟进。',completed:'模拟人工处理已完成；这不表示道路已经修复。'},en:{queued:'You chose the simulated human queue. No agent has accepted yet. Automated work is paused and unconfirmed submissions will not proceed.',waiting:'Your message has been added to the human conversation. It is still queued and has not been accepted by a human.',reply:'[Simulated human agent] I received your additional information and will follow up using this conversation.',done:'Simulated human handling has ended. Choose Return to assistant to continue. This does not mean the road is repaired.',resumed:'You are back with the assistant. Tell me what you need next; previous submission authorizations have expired.',accepted:'A simulated human agent has joined. You can add details in the chat.',escalated:'The simulated conversation has been escalated to a supervisor.',completed:'Simulated human handling is complete. This does not mean the road is repaired.'},ar:{queued:'تم الانضمام إلى قائمة الموظف التجريبي باختيارك. لم يستلم موظف المحادثة بعد. تم إيقاف الأعمال الآلية والطلبات غير المؤكدة.',waiting:'أضيفت رسالتك إلى المحادثة البشرية. ما زلت في قائمة الانتظار ولم يستلمها موظف بعد.',reply:'[موظف افتراضي] وصلتني المعلومات الإضافية وسأتابعها ضمن هذه المحادثة.',done:'انتهت المتابعة البشرية الافتراضية. يمكنك العودة للمساعد للمتابعة. هذا لا يعني إصلاح الطريق.',resumed:'عدت إلى المساعد. أخبرني بما تحتاجه الآن؛ انتهت صلاحية الموافقات السابقة.',accepted:'انضم موظف افتراضي إلى المحادثة. يمكنك إضافة التفاصيل هنا.',escalated:'تم تصعيد المحادثة الافتراضية إلى المشرف للمتابعة.',completed:'اكتملت المتابعة البشرية الافتراضية. هذا لا يعني إصلاح الطريق.'}};
export const humanNotice=(s,kind)=>words[languageOf(s)][kind];
export async function queueConversationHandoff(agent,s,{requestId,signal}={}){
  const existing=humanState(s);if(existing)return existing;
  const offer=s.pendingHelp;
  if(!offer||offer.id!==requestId)throw failure('STALE_HELP','Use the current human help choice',409);
  if(!agent.humanSupport.available)throw failure('HUMAN_UNAVAILABLE','The simulated human desk is unavailable. Continue with the assistant or use the official portal.',503);
  const plan=agent.active(s);
  const summary={service_scope:s.serviceContext?.scope??null,goal:plan?.goal??null,pending_submission:false,transcript:s.messages.filter(m=>['user','assistant'].includes(m.role)&&(!m.kind||['faq','result','input'].includes(m.kind))).slice(-10).map(m=>({role:m.role,text:m.text.slice(0,500)}))};
  const parameters={scope:'conversation',request_id:offer.id,reason:'user_requested_help',conversation_summary:JSON.stringify(summary).slice(0,2000),...(s.user?{user_id:s.user.user_id}:{})};
  agent.store.emit(s,'user_handoff_authorized',{parameters:clone(parameters),request_id:offer.id});
  const result=await agent.api(s.id,'handoff_to_human',parameters,{epoch:s.epoch,idempotency_key:digest(['help_choice',s.id,offer.id]),signal,authorization:'user_help_choice'});
  signal?.throwIfAborted();
  const handoff=s.mock.handoffs.find(h=>h.handoff_id===result.handoff.handoff_id);
  handoff.wait_deadline??=new Date(Date.now()+agent.humanSupport.wait_limit_ms).toISOString();
  s.activeHandoffId=handoff.handoff_id;s.pendingHelp=null;s.status='human_waiting';
  const receipt={id:id('receipt'),operation:'handoff_to_human',parameters:clone(parameters),result:{...result,handoff:clone(handoff)},time:new Date().toISOString(),source:'user_help_choice'};s.receipts.push(receipt);agent.store.emit(s,'receipt',{receipt});
  agent.store.emit(s,'conversation_handoff',{handoff:clone(handoff)});agent.store.message(s,'assistant',humanNotice(s,'queued'),{kind:'human_notice',handoff_id:s.activeHandoffId,notice:'human.queuedChoice'});
  return handoff;
}
export const humanWaitExpired=(h,now=Date.now())=>h?.status==='WAITING'&&!!h.wait_deadline&&Date.parse(h.wait_deadline)<=now;
export function routeHumanMessage(agent,s,message){
  const h=humanState(s);if(!h)return false;
  h.messages??=[];h.messages.push({role:'user',text:message,time:new Date().toISOString()});
  const expired=humanWaitExpired(h);
  const text=expired?({zh:'模拟等待已超时，尚未有人受理。可以取消排队、返回助手或访问官方平台。',en:'The demo waiting limit has elapsed without acceptance. Cancel the queue, return to the assistant or visit the official portal.',ar:'انتهت مهلة الانتظار التجريبية دون استلام. يمكنك إلغاء الانتظار أو العودة للمساعد أو زيارة المنصة الرسمية.'}[languageOf(s)]):humanNotice(s,h.status==='WAITING'?'waiting':h.status==='COMPLETED'?'done':'reply');
  if(['ACCEPTED','ESCALATED'].includes(h.status))h.messages.push({role:'agent',text,time:new Date().toISOString(),agent_name:h.agent_name??'Mock roads agent'});
  agent.store.emit(s,'human_message',{handoff_id:h.handoff_id,status:h.status});agent.store.message(s,'assistant',text,{kind:'human_reply',handoff_id:h.handoff_id,...(expired?{}:{notice:'human.'+(h.status==='WAITING'?'waiting':h.status==='COMPLETED'?'done':'reply')})});s.status=h.status==='WAITING'?'human_waiting':h.status==='COMPLETED'?'human_completed':'human_active';return true;
}
