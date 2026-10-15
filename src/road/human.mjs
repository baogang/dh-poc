import {clone,digest,id,failure} from './store.mjs';
import {languageOf} from './presentation.mjs';
export const humanState=s=>s.mock.handoffs.find(h=>h.handoff_id===s.activeHandoffId&&h.scope==='conversation');
const words={zh:{queued:'我识别到你当前的负向情绪，已将本次会话转入模拟人工队列。自动业务已暂停，尚未确认的提交不会继续。',waiting:'你补充的信息已加入人工会话，当前仍在排队，尚未有人工受理。',reply:'【模拟人工客服】已收到你的补充信息，会结合本次会话继续跟进。',done:'本次模拟人工处理已结束。你可以点击“返回智能助手”继续办理；这不代表道路已修复。',resumed:'已返回智能助手。请告诉我接下来要处理什么，原来的提交授权已失效。',accepted:'模拟人工客服已接入。你可以继续在聊天中补充情况。',escalated:'本次模拟人工会话已升级给主管继续跟进。',completed:'模拟人工处理已完成；这不表示道路已经修复。'},en:{queued:'I detected current negative sentiment and queued this conversation for a simulated human. Automated business work is paused; pending submissions will not proceed.',waiting:'Your message has been added to the human conversation. It is still queued and has not been accepted by a human.',reply:'[Simulated human agent] I received your additional information and will follow up using this conversation.',done:'Simulated human handling has ended. Choose Return to assistant to continue. This does not mean the road is repaired.',resumed:'You are back with the assistant. Tell me what you need next; previous submission authorizations have expired.',accepted:'A simulated human agent has joined. You can add details in the chat.',escalated:'The simulated conversation has been escalated to a supervisor.',completed:'Simulated human handling is complete. This does not mean the road is repaired.'},ar:{queued:'رصدت مشاعر سلبية حالية وحولت هذه المحادثة فوراً إلى قائمة انتظار موظف افتراضي. تم إيقاف الأعمال الآلية ولن تنفذ الطلبات غير المؤكدة.',waiting:'أضيفت رسالتك إلى المحادثة البشرية. ما زلت في قائمة الانتظار ولم يستلمها موظف بعد.',reply:'[موظف افتراضي] وصلتني المعلومات الإضافية وسأتابعها ضمن هذه المحادثة.',done:'انتهت المتابعة البشرية الافتراضية. يمكنك العودة للمساعد للمتابعة. هذا لا يعني إصلاح الطريق.',resumed:'عدت إلى المساعد. أخبرني بما تحتاجه الآن؛ انتهت صلاحية الموافقات السابقة.',accepted:'انضم موظف افتراضي إلى المحادثة. يمكنك إضافة التفاصيل هنا.',escalated:'تم تصعيد المحادثة الافتراضية إلى المشرف للمتابعة.',completed:'اكتملت المتابعة البشرية الافتراضية. هذا لا يعني إصلاح الطريق.'}};
export const humanNotice=(s,kind)=>words[languageOf(s)][kind];
export async function queueNegativeHandoff(agent,s,{signal}={}){
  const existing=humanState(s);if(existing)return existing;
  if(s.emotion?.status!=='classified'||s.emotion.sentiment!=='negative')throw failure('NEGATIVE_SENTIMENT_REQUIRED','Automatic handoff requires a classified current negative sentiment');
  const parameters={scope:'conversation',emotion_message_id:s.emotion.message_id,reason:'negative_sentiment',conversation_summary:s.messages.filter(m=>m.role==='user'&&!m.kind).slice(-6).map(m=>m.text).join(' | ').slice(0,2000),...(s.user?{user_id:s.user.user_id}:{})};
  agent.store.emit(s,'policy_handoff_authorized',{parameters:clone(parameters),message_id:s.emotion.message_id,policy:'negative_sentiment_v1'});
  const result=await agent.api(s.id,'handoff_to_human',parameters,{epoch:s.epoch,idempotency_key:digest(['negative_handoff',s.id,s.emotion.message_id]),signal,authorization:'negative_sentiment_policy'});
  signal?.throwIfAborted();
  s.activeHandoffId=result.handoff.handoff_id;s.status='human_waiting';
  const receipt={id:id('receipt'),operation:'handoff_to_human',parameters:clone(parameters),result,time:new Date().toISOString(),source:'negative_sentiment_policy'};s.receipts.push(receipt);agent.store.emit(s,'receipt',{receipt});
  agent.store.emit(s,'conversation_handoff',{handoff:result.handoff});agent.store.message(s,'assistant',humanNotice(s,'queued'),{kind:'human_notice',handoff_id:s.activeHandoffId,notice:'human.queued'});
  return result.handoff;
}
export function routeHumanMessage(agent,s,message){
  const h=humanState(s);if(!h)return false;
  h.messages??=[];h.messages.push({role:'user',text:message,time:new Date().toISOString()});
  const text=humanNotice(s,h.status==='WAITING'?'waiting':h.status==='COMPLETED'?'done':'reply');
  if(['ACCEPTED','ESCALATED'].includes(h.status))h.messages.push({role:'agent',text,time:new Date().toISOString(),agent_name:h.agent_name??'Mock roads agent'});
  agent.store.emit(s,'human_message',{handoff_id:h.handoff_id,status:h.status});agent.store.message(s,'assistant',text,{kind:'human_reply',handoff_id:h.handoff_id,notice:'human.'+(h.status==='WAITING'?'waiting':h.status==='COMPLETED'?'done':'reply')});s.status=h.status==='WAITING'?'human_waiting':h.status==='COMPLETED'?'human_completed':'human_active';return true;
}
