// The catalog describes connected capabilities; it never authorizes a tool.
export const services=[
  {id:'balady-crm',mode:'simulation',title:{zh:'BALADY CRM 综合服务',en:'BALADY CRM services',ar:'خدمات بلدي CRM'},department:{zh:'BALADY 市政与客户服务',en:'BALADY municipal and customer services',ar:'الخدمات البلدية وخدمة العملاء'},description:{zh:'查询本人事项、整理咨询建议与投诉、浏览市政分类和资产目录。当前为仿真；提交前确认。地点自动解析及机构后台处理未接入市民助手。',en:'View your reports, prepare inquiries, suggestions and complaints, and browse service classifications and asset references. Simulation with confirmation before submission. Automatic location resolution and organizational back-office actions are not connected to this citizen assistant.',ar:'متابعة بلاغاتك وإعداد الاستفسارات والمقترحات والشكاوى وتصفح التصنيفات والأصول. محاكاة مع تأكيد الإرسال. تحديد المواقع التلقائي وإجراءات الجهات الداخلية غير متاحة هنا.'},official_url:'https://balady.gov.sa/en',example:'What is happening with my waste collection report?'},
  {id:'infrastructure-permit',mode:'knowledge_only',title:{zh:'新开发规划区域基础设施施工许可',en:'Infrastructure works permit in a new development plan',ar:'تصريح أعمال البنية التحتية في مخطط تطوير جديد'},department:{zh:'基础设施许可服务',en:'Infrastructure permit services',ar:'خدمات تصاريح البنية التحتية'},description:{zh:'咨询服务定义、申请人、材料和费用；本助手未接入许可申请接口。',en:'FAQ consultation on the service, applicants, documents and fees. Permit applications are not connected here.',ar:'استشارات عن الخدمة والمتقدمين والمستندات والرسوم. تقديم الطلبات غير متصل هنا.'},official_url:'https://balady.gov.sa/en',example:'Who can apply for this service?'},
  {id:'civil-defense-fees',mode:'knowledge_only',title:{zh:'民防与市政费用咨询',en:'Civil Defense and municipal fee guidance',ar:'استفسارات رسوم الدفاع المدني والبلدية'},department:{zh:'许可缴费相关咨询',en:'License payment guidance',ar:'استفسارات سداد رسوم التراخيص'},description:{zh:'咨询已有问答中的费用与发票规则；本助手不支持缴费。',en:'FAQ guidance on fees and invoices. Payments are not connected here.',ar:'استشارات الأسئلة الشائعة عن الرسوم والفواتير. الدفع غير متصل هنا.'},official_url:'https://balady.gov.sa/en',example:'Is the municipal fees invoice the same as the Civil Defense fees invoice?'},
  {id:'balady-platform',mode:'knowledge_only',title:{zh:'Balady 平台咨询',en:'Balady platform guidance',ar:'استفسارات منصة بلدي'},department:{zh:'平台服务咨询',en:'Platform service guidance',ar:'استفسارات خدمات المنصة'},description:{zh:'当前仅有平台个性化服务相关问答；其他业务请通过官方平台查询。',en:'The current FAQ covers platform personalization. Use the official platform for other services.',ar:'تغطي الأسئلة الحالية تخصيص خدمات المنصة. للخدمات الأخرى يرجى زيارة المنصة الرسمية.'},official_url:'https://balady.gov.sa/en',example:'Does the Balady Platform personalize the services and content displayed to the beneficiary?'}
];
export const serviceById=id=>services.find(s=>s.id===id)||(id==='road-pothole'?services[0]:undefined);
export const localize=(values,language='en')=>values?.[language]??values?.en??'';
export function serviceScopes(text){
  const patterns={
    'balady-crm':/crm|municipal service|incident|complaint|pothole|工单|投诉|案件|市政请求|坑洞|بلاغ|شكوى/iu,
    'infrastructure-permit':/infrastructure|new development plan|基础设施|新开发规划|البنية التحتية|مخطط تطوير/iu,
    'civil-defense-fees':/civil defen[cs]e|民防|消防费用|الدفاع المدني/iu,
    'balady-platform':/balady|baladi|بلدي|个性化|personaliz/iu
  };
  return Object.entries(patterns).filter(([,pattern])=>pattern.test(text)).map(([scope])=>scope);
}
export const isCatalogRequest=text=>/^(?:服务目录|支持哪些服务|你能做什么|有哪些服务|what (?:services|can you do)|show (?:the )?service catalog|service catalog|ما الخدمات|دليل الخدمات)[?？\s.!]*$/iu.test(text.trim());
export const isHelpRequest=text=>/^(?:转人工|联系人工|人工客服|找人工|talk to (?:a )?human|human (?:help|agent)|contact (?:a )?human|أريد موظف|التحدث مع موظف)[?？\s.!]*$/iu.test(text.trim());
