export function languageOf(s){const text=[...s.messages].reverse().find(m=>m.role==='user'&&!m.kind)?.text??'';return /[\u4e00-\u9fff]/u.test(text)?'zh':/[\u0600-\u06ff]/u.test(text)?'ar':'en';}
export function chatNotice(s,kind){const language=languageOf(s);return {
  plan:{zh:'我会按下面的步骤处理。请在聊天中确认是否按此计划继续。',en:'I will follow the steps below. Please review the plan and choose Continue here in the chat.',ar:'سأتبع الخطوات أدناه. يرجى مراجعة الخطة واختيار المتابعة هنا في المحادثة.'},
  autoPlan:{zh:'我会按这些步骤直接处理普通查询；写入数据或高危查询前，会在聊天中请你确认具体内容。',en:'I will start these steps now. Normal queries run automatically; writes and high-risk reads will ask for confirmation of their exact details.',ar:'سأبدأ هذه الخطوات الآن. تنفذ الاستعلامات العادية تلقائياً، وسأطلب تأكيد التفاصيل قبل الكتابة أو الاستعلام عالي المخاطر.'},
  highRiskRead:{zh:'此查询被后端标记为高危读取。请核对查询内容并确认；确认前不会读取数据。',en:'The host marks this query as a high-risk read. Review the query details and confirm before data is retrieved.',ar:'صنف النظام هذا الاستعلام كقراءة عالية المخاطر. راجع التفاصيل وأكد قبل جلب البيانات.'},
  operation:{zh:'已整理好要提交的内容。请核对下面的信息，再确认提交；确认之前不会执行这个操作。',en:'The details are ready. Please review them below and confirm submission here. This operation will wait for your confirmation.',ar:'التفاصيل جاهزة. يرجى مراجعتها أدناه وتأكيد الإرسال هنا. لن يتم تنفيذ العملية قبل تأكيدك.'},
  approved:{zh:'已确认计划，我开始处理。',en:'Plan confirmed. I will start now.',ar:'تم تأكيد الخطة. سأبدأ الآن.'},
  confirmed:{zh:'我已确认提交以上内容。',en:'I confirm submitting the details above.',ar:'أؤكد إرسال التفاصيل الموضحة أعلاه.'},
  cancelled:{zh:'已停止当前任务。你可以告诉我接下来要处理什么。',en:'The current task has stopped. Tell me what you would like to do next.',ar:'تم إيقاف المهمة الحالية. أخبرني بما تريد القيام به بعد ذلك.'},
  login:{zh:'模拟登录成功。现在可以继续处理你的工单。',en:'Demo sign-in succeeded. We can continue with your tickets.',ar:'تم تسجيل الدخول التجريبي بنجاح. يمكننا متابعة بلاغاتك.'}
}[kind][language];}
export function inputReply(s,input,result){
  const language=languageOf(s);
  if(input.kind==='text')return result.text;
  if(input.kind==='address')return `${language==='zh'?'工单地址：':language==='ar'?'عنوان البلاغ:':'Report address:'} ${result.city}, ${result.street}`;
  if(input.kind==='login')return chatNotice(s,'login');
  const status=language==='zh'?(result.unresolved?'问题仍未解决':'问题已解决'):language==='ar'?(result.unresolved?'لم يتم حل المشكلة بعد':'تم حل المشكلة'):(result.unresolved?'the issue is still unresolved':'the issue is resolved');
  return `${language==='zh'?'已确认对应工单：':language==='ar'?'تم تأكيد البلاغ:':'Confirmed report:'} ${result.ticket_id} — ${status}`;
}
