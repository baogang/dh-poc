import {failure} from '../road/store.mjs';

// The model selects the actions and dependencies. Labels describe those
// actions without inventing dates, case facts or a completed outcome.
const labels={
  input:['确认必要信息','Clarify necessary information','استكمال المعلومات اللازمة'],
  respond:['说明结果与限制','Explain the result and limits','توضيح النتيجة والحدود'],
  crm_get_assets:['查看市政设施类别','View municipal asset categories','عرض فئات الأصول البلدية'],
  crm_get_asset_details:['查看设施子类别','View sub-asset categories','عرض الفئات الفرعية للأصول'],
  crm_upload_file:['向已有事项上传附件','Upload an attachment to an existing case','رفع مرفق إلى طلب قائم'],
  crm_download_file:['获取事项附件','Retrieve a case attachment','جلب مرفق الطلب'],
  crm_get_incidents:['查看本人可见事项','View matters visible to your account','عرض الطلبات الظاهرة لحسابك'],
  crm_fetch_incident:['查看所选报告的详情','View the selected report details','عرض تفاصيل البلاغ المختار'],
  crm_create_municipal_service:['提交市政服务请求','Submit a municipal service request','تقديم طلب خدمة بلدية'],
  crm_retrieve_msr_data:['查看市政服务分类资料','View municipal service classification data','عرض بيانات تصنيف الخدمة البلدية'],
  crm_get_main_classifications:['查看服务主分类','View main service categories','عرض فئات الخدمة الرئيسية'],
  crm_get_sub_classifications:['查看服务子分类','View service subcategories','عرض فئات الخدمة الفرعية'],
  crm_get_special_classifications:['查看具体问题分类','View specific issue categories','عرض تصنيفات المشكلات التفصيلية'],
  crm_get_special_classifications_by_type:['按服务类型查看问题分类','View issue categories by service type','عرض تصنيفات المشكلات حسب نوع الخدمة'],
  crm_get_classification_parents:['查看问题分类的所属类别','View the parent categories of an issue type','عرض الفئات الأصلية لتصنيف المشكلة'],
  crm_create_inquiry:['提交市政咨询请求','Submit a classified municipal inquiry','تقديم استفسار بلدي مصنّف'],
  crm_retrieve_tsr_data:['查看技术支持可选类别','View technical support options','عرض خيارات الدعم الفني'],
  crm_fetch_municipal_service:['查看市政服务申请详情','View municipal service request details','عرض تفاصيل طلب الخدمة البلدية'],
  crm_fetch_inquiry:['查看咨询申请详情','View inquiry request details','عرض تفاصيل طلب الاستفسار'],
  crm_create_daem_ticket:['提交技术支持请求','Submit a technical support request','تقديم طلب دعم فني'],
  crm_create_form_request:['登记咨询、建议或投诉','Record an inquiry, suggestion or complaint','تسجيل استفسار أو اقتراح أو شكوى'],
  crm_upload_attachment:['上传表单附件','Upload a form attachment','رفع مرفق للنموذج']
};
export function publicPlan(steps,language){
  const index={zh:0,en:1,ar:2}[language];
  const words={
    zh:{goal:'本轮处理计划',summary:'按以下步骤处理你的请求。查询会自动进行；提交前会请你核对具体内容。计划不代表事项已经办理。'},
    en:{goal:'Plan for this request',summary:'These are the planned steps for your request. Queries run automatically; you will review exact details before a submission. A plan does not mean the request has been carried out.'},
    ar:{goal:'خطة هذا الطلب',summary:'هذه خطوات التعامل مع طلبك. تُنفّذ الاستعلامات تلقائياً، وتراجع التفاصيل قبل أي إرسال. لا تعني الخطة أن الطلب قد أُنجز.'}
  }[language];
  if(!words)throw failure('INVALID_LANGUAGE','A supported conversation language is required');
  return {...words,titles:steps.map(step=>{const label=labels[step.capability]?.[index];if(!label)throw failure('OPERATION_NOT_AVAILABLE','No public action label exists for this capability');return label;})};
}
