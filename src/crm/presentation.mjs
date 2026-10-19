import {BY_ID} from './contract.mjs';
import {isDeepStrictEqual} from 'node:util';
import {failure} from '../road/store.mjs';

export const CASE_GUIDANCE=['not_found','needs_choice','access_limited','action_unavailable','location_unavailable','reason_not_returned','file_unavailable','offer_separate_complaint'];

// A real failed read is different from an unconnected capability. It does not
// undo an earlier write or prove that a mutation should be repeated.
export function readFailureOutcome(failures,{language='en',hasSubmission=false}={}){
  if(!failures.length)return null;
  const words={
    zh:['有查询未能完成，本轮没有取得该项查询的结果。','已经成功提交的内容以保留的回执为准，不要因查询失败而重复提交。'],
    en:['A query did not complete, so its result was not obtained in this turn.','Successful submissions are recorded in the retained receipts. Do not repeat a submission because a query failed.'],
    ar:['لم يكتمل أحد الاستعلامات، لذا لم تُجلب نتيجته في هذه الجولة.','الإرسالات الناجحة مثبتة في الإيصالات المحفوظة. لا تكرر الإرسال بسبب فشل استعلام.']
  }[language];
  return [words[0],hasSubmission?words[1]:null].filter(Boolean).join('\n\n');
}
export function caseStatusLabel(value,language){
  return ({zh:{Open:'未结案',InProgress:'处理中',Resolved:'已解决',Rejected:'未受理'},en:{Open:'Open',InProgress:'In progress',Resolved:'Resolved',Rejected:'Rejected'},ar:{Open:'مفتوح',InProgress:'قيد المعالجة',Resolved:'تم الحل',Rejected:'مرفوض'}}[language]??{})[value]??value;
}

const guidanceWords=(language,mode='simulation')=>({
    zh:{not_found:'尚未在本次可见记录中确认你所指的事项。下表如有记录，仅为可见候选；可以补充问题描述、地点或时间帮助区分。',needs_choice:'有多个候选，尚未确认你指的是哪件。请用问题描述或记录日期说明；以下不代表已选定其中一件。',access_limited:'我只能查询当前登录账号可见的记录，不能提供他人的投诉或联系方式。',action_unavailable:'你请求的这项操作当前未接入，本次没有执行该操作。',location_unavailable:'本次报修尚未登记。当前未接入将地址转换为下级行政区域资料的服务，无法取得登记必需的位置数据。无需提供内部编号，也不必为此重复填写联系人。',reason_not_returned:'这些回执未证实结案原因，不能从状态推断具体原因或现场情况。',file_unavailable:'尚未取得你要找回的文件内容，暂不能提供下载；这不代表文件已取回。',offer_separate_complaint:mode==='simulation'?'如果你愿意，可以另起一条本地模拟的公众投诉；这属于新的本地记录，需要你选择并单独核对，不会更改原事项，也不会投递给真实部门核实处理。':'如果你愿意，可以另起一条公众投诉，需要你选择并单独核对；是否会进一步转办或处理尚未核实。'},
    en:{not_found:'The requested matter has not been identified in the records visible in this query. Any rows below are candidates only; an issue description, place or date can help distinguish it.',needs_choice:'There are multiple candidates and no target has been confirmed. Describe the issue or its recorded date; the table does not select one for you.',access_limited:'I can query only records visible to the signed-in account, not another person’s complaint or contact details.',action_unavailable:'The requested operation is not connected to this assistant and was not performed.',location_unavailable:'The physical report has not been registered. This assistant has no address-to-local-administrative-area resolver, so the required location data cannot currently be obtained. You do not need to provide internal codes or repeat your contact details.',reason_not_returned:'These receipts do not establish a closure reason. The status alone cannot explain the reason or conditions on site.',file_unavailable:'The requested file content has not been retrieved, so a download is not currently available. The requested file has not been recovered.',offer_separate_complaint:mode==='simulation'?'If you wish, we can prepare a separate local simulated public complaint. It is a new local record requiring your choice and its own review. It does not change the original matter or get forwarded to a real department for investigation or handling.':'If you wish, we can prepare a separate public complaint requiring your choice and its own review. Subsequent routing and handling have not been verified.'},
    ar:{not_found:'لم يُحدَّد الطلب الذي تقصده ضمن السجلات الظاهرة في هذا الاستعلام. أي سجلات أدناه مرشحة فقط؛ يمكن أن يساعد وصف المشكلة أو الموقع أو التاريخ في تمييزها.',needs_choice:'توجد عدة سجلات مرشحة ولم يُؤكد أيها تقصد. صف المشكلة أو تاريخها المسجل؛ الجدول لا يختار سجلاً نيابة عنك.',access_limited:'يمكنني الاستعلام فقط عن السجلات الظاهرة للحساب المسجل، ولا يمكنني تقديم شكوى شخص آخر أو بيانات اتصاله.',action_unavailable:'العملية المطلوبة غير متصلة بهذا المساعد ولم تُنفَّذ.',location_unavailable:'لم يُسجَّل البلاغ عن المشكلة الميدانية. لا تتوفر هنا خدمة لتحويل العنوان إلى بيانات النطاقات الإدارية المحلية المطلوبة للتسجيل. لا تحتاج إلى تقديم رموز داخلية أو تكرار بيانات الاتصال.',reason_not_returned:'لا تثبت هذه الإيصالات سبب الإغلاق، ولا تكفي الحالة وحدها لاستنتاج السبب أو وضع الموقع.',file_unavailable:'لم يُجلب محتوى الملف المطلوب، لذا لا يتوفر تنزيل حالياً. لم يُستعَد الملف المطلوب.',offer_separate_complaint:mode==='simulation'?'إذا رغبت، يمكن إعداد شكوى عامة منفصلة في المحاكاة المحلية. هي سجل محلي جديد يتطلب اختيارك ومراجعة مستقلة، ولا يغيّر الطلب الأصلي ولا يُحال إلى جهة حقيقية للتحقق أو المعالجة.':'إذا رغبت، يمكن إعداد شكوى عامة منفصلة تتطلب اختيارك ومراجعة مستقلة. لم يتم التحقق من الإحالة أو المعالجة اللاحقة.'}
})[language];

// Normalize prose paragraph/list separators, leaving code and literal paths
// alone. API parameters, user messages and stored evidence are never rewritten.
export function nameRolePrompt(language='en'){
  return ({
    zh:{question:'请按下面的字段填写你的姓名。其他已提供的信息会保留。',FirstName:'名（Given name）',LastName:'姓（Family name）',continue:'保存姓名并继续',cancel:'取消本次请求',note:'仅填写下面尚不明确的姓名部分；这不是身份验证。',retry:'未能保存，请重试。'},
    en:{question:'Please enter your name in the labelled fields below. Your other supplied details will be kept.',FirstName:'Given name',LastName:'Family name',continue:'Save name and continue',cancel:'Cancel this request',note:'Only the name roles still unclear are shown. This is not identity verification.',retry:'Could not save. Please try again.'},
    ar:{question:'أدخل اسمك في الحقول المسمّاة أدناه. ستُحفظ المعلومات الأخرى التي قدمتها.',FirstName:'الاسم الشخصي',LastName:'اسم العائلة',continue:'حفظ الاسم والمتابعة',cancel:'إلغاء هذا الطلب',note:'تظهر فقط أجزاء الاسم التي لم تتضح بعد. هذا ليس تحققاً من الهوية.',retry:'تعذر الحفظ. حاول مرة أخرى.'}
  })[language]??nameRolePrompt('en');
}

export function normalizeCustomerText(text){
  return text.split(/(```[\s\S]*?```|`[^`\n]+`)/gu).map((part,index)=>index%2?part:part.replace(/(?<!\\)(?:\\n){2,}/gu,separator=>'\n'.repeat(separator.length/2)).replace(/(?<!\\)\\n(?=\s*(?:[-*+·•] |\d+[.)] |#{1,6} |\|))/gu,'\n')).join('');
}

// The same typed capability guidance is meaningful without a case lookup. It
// must not fall back to arbitrary promises merely because no API ran.
export function guidanceOutcome(receipts,{language='en',mode='simulation',guidance=[],incomplete=false}={}){
  const selected=[...new Set(guidance)];if(!selected.length)return null;
  if(selected.some(code=>['not_found','needs_choice','reason_not_returned'].includes(code)))throw failure('GUIDANCE_EVIDENCE_REQUIRED','A case search or candidate choice needs actual query receipts. Do not imply that a search occurred without evidence.');
  if(selected.includes('file_unavailable')&&receipts.some(r=>r.operation==='crm_download_file'&&r.result?.data?.result?.AttachmentStream))throw failure('GUIDANCE_EVIDENCE_MISMATCH','Actual file content is cited; do not report file_unavailable.');
  const words=guidanceWords(language,mode),scope={
    zh:mode==='simulation'?'这里仅提供本地仿真记录，不会投递给政府、部门或工作人员核实处理，也不会执行真实退款、缴费、办证或通知。真实业务需要通过官方渠道另行发起；本地编号不能用于官方查询。':'这里只说明当前连接能力；没有回执证明的办理、转办、通知及后续处理均未核实。',
    en:mode==='simulation'?'This environment keeps local simulation records only. Nothing is forwarded to a government body, department or staff for verification or handling; no real refund, payment, permit or notification is performed. Real transactions require a separate official channel, where local numbers cannot be used for tracking.':'This describes only the connected capabilities. Actions, handoffs, notifications and subsequent handling without receipt evidence have not been verified.',
    ar:mode==='simulation'?'تحتفظ هذه البيئة بسجلات محاكاة محلية فقط. لا يُحال شيء إلى جهة حكومية أو قسم أو موظف للتحقق أو المعالجة، ولا تُنفَّذ عمليات حقيقية للاسترداد أو الدفع أو الترخيص أو الإشعارات. تتطلب المعاملات الحقيقية قناة رسمية مستقلة، ولا تُستخدم الأرقام المحلية للتتبع فيها.':'هذا وصف للقدرات المتصلة فقط. لم يتم التحقق من الإجراءات أو الإحالات أو الإشعارات أو المعالجة اللاحقة دون دليل من الإيصالات.'
  }[language];
  const partial={zh:'本次请求尚未完成；下方说明不代表原事项已经登记或办理。',en:'This request is not complete. The information below does not mean that the original matter was registered or carried out.',ar:'لم يكتمل هذا الطلب. لا يعني التوضيح أدناه أن الطلب الأصلي قد سُجل أو نُفذ.'}[language];
  return [incomplete?partial:null,...selected.map(code=>words[code]),scope].filter(Boolean).join('\n\n');
}

// Case facts are rendered from actual returned fields. A language model can
// choose tools and ask questions, but cannot elaborate a boolean into a photo,
// invent a work stage, or invent an official follow-up for a local record.
export function caseReadOutcome(receipts,{language='en',mode='simulation',guidance=[],incomplete=false,excluded_visible_cases=false}={}){
  const fetches=new Set(['crm_fetch_incident','crm_fetch_municipal_service','crm_fetch_inquiry']);
  const relevant=receipts.filter(r=>r.operation==='crm_get_incidents'||fetches.has(r.operation));
  if(!relevant.length)return null;
  const fetched=relevant.filter(r=>fetches.has(r.operation)).flatMap(r=>{const result=r.result?.data?.result;return Array.isArray(result)?result:result&&typeof result==='object'?[result]:[];});
  const history=relevant.filter(r=>r.operation==='crm_get_incidents').flatMap(r=>r.result?.data?.result?.IncidentRequestList??[]);
  const selected=new Set(guidance),candidates=['needs_choice','not_found','access_limited'].some(code=>selected.has(code));
  if(selected.has('needs_choice')&&history.length<2)throw failure('GUIDANCE_EVIDENCE_MISMATCH','needs_choice requires multiple returned history candidates. Ask for genuinely missing facts with request_input instead.');
  const rows=[...new Map((candidates?history:fetched.length?fetched:history).filter(r=>r&&typeof r==='object').map(r=>[r.pyID??r.pzInsKey,r])).values()];
  const words={
    zh:{heading:'可见记录如下：',headers:['记录编号','问题描述','记录状态','附件标记'],missing:'未返回',yes:'有附件标记',no:'无附件标记',empty:'本次引用的结果中没有记录。',status:'以上是记录中的状态，不能据此确定现场修复、派工或处理时间。',attachments:'附件标记不能证明文件数量、类型或上传人。当前引用的回执未包含文件内容，暂不能提供下载。',download:'已取得附件返回内容；可用的文件下载入口显示在回执下方。',choose:'如需继续查询其中一件，可用问题描述说明是哪件。',scope:'这些是本地仿真记录，未发送至政府系统，不能用这些本地编号在官方渠道查询。',real:'这里只展示接口实际返回的记录，未核实现场情况或后续通知。'},
    en:{heading:'Visible records:',headers:['Report number','Issue','Recorded status','Attachment flag'],missing:'Not returned',yes:'Marked as having attachments',no:'Not marked as having attachments',empty:'No records were returned in the referenced results.',status:'These are recorded statuses; they do not establish a repair, dispatch or handling time.',attachments:'The attachment flag does not establish a count, file type or uploader. The cited receipts contain no file content, so a download is not currently available.',download:'An attachment response is available in the cited receipts. Any available download is shown below the receipt.',choose:'To check one of these, describe which issue you mean.',scope:'These are local simulation records. They were not sent to government systems, and these local numbers cannot be used to look them up through official channels.',real:'Only the actual API records are shown. On-site conditions and subsequent notifications have not been verified.'},
    ar:{heading:'السجلات الظاهرة:',headers:['رقم السجل','وصف المشكلة','الحالة المسجلة','علامة المرفقات'],missing:'لم يُرجع',yes:'توجد علامة مرفقات',no:'لا توجد علامة مرفقات',empty:'لا توجد سجلات في النتائج المشار إليها.',status:'هذه حالات مسجلة فقط، ولا تثبت إصلاح الموقع أو إرسال فريق أو موعد المعالجة.',attachments:'علامة المرفقات لا تثبت عدد الملفات أو نوعها أو من رفعها. لا تحتوي الإيصالات المشار إليها على محتوى ملف، لذا لا يتوفر تنزيل حالياً.',download:'تتوفر استجابة المرفق في الإيصالات المشار إليها. يظهر رابط التنزيل المتاح أسفل الإيصال.',choose:'لمتابعة أحد هذه السجلات، صف المشكلة التي تقصدها.',scope:'هذه سجلات محاكاة محلية لم تُرسل إلى أنظمة حكومية، ولا يمكن البحث عنها بهذه الأرقام المحلية عبر القنوات الرسمية.',real:'تُعرض سجلات الواجهة الفعلية فقط. لم يتم التحقق من حالة الموقع أو الإشعارات اللاحقة.'}
  }[language];
  const instructions=guidanceWords(language,mode);
  if(excluded_visible_cases){
    const excluded={
      zh:{heading:'本次已排除的可见记录：',message:'已记录：这些都不是你要查询的事项。本次可见记录中未找到目标；下表是本次已排除的记录，没有选中其中任何一条。'},
      en:{heading:'Visible records excluded for this query:',message:'You selected “None of these”. The requested matter was not found in the records shown. The rows below have been excluded for this query; no record was selected.'},
      ar:{heading:'السجلات الظاهرة المستبعدة من هذا الاستعلام:',message:'تم تسجيل اختيارك «لا شيء منها». لم يُعثر على الطلب المقصود في السجلات الظاهرة. السجلات أدناه مستبعدة من هذا الاستعلام ولم يُختر أي منها.'}
    }[language];
    words.heading=excluded.heading;instructions.not_found=excluded.message;
  }
  const safe=value=>String(value??words.missing).replace(/[\\`*_[\]<>|]/gu,'\\$&').replace(/[\r\n]+/gu,' ');
  const issue=row=>{const description=row.Description??row.IncidentInformation?.IssueDescription,date=row.pxCreateDateTime??row.CreatedAt??row.CreatedDate??row.CreateDateTime??row.ReportedDate??row.CreatedOn;return date?[description??words.missing,date].join(' · '):description;};
  const table=rows.length?'| '+words.headers.join(' | ')+' |\n|---|---|---|---|\n'+rows.map(row=>'| '+[row.pyID,issue(row),caseStatusLabel(row.pyStatusWork,language),typeof row.hasAttachments==='boolean'?(row.hasAttachments?words.yes:words.no):words.missing].map(safe).join(' | ')+' |').join('\n'):words.empty;
  const downloaded=receipts.some(r=>r.operation==='crm_download_file'&&r.result?.data?.result?.AttachmentStream);
  if(selected.has('file_unavailable')&&downloaded)throw failure('GUIDANCE_EVIDENCE_MISMATCH','The cited receipts include downloaded file content. Do not report file_unavailable.');
  const partial={zh:'部分请求尚未完成；以下仅为已取得的记录，不能视为全部办理成功。',en:'Part of the request is incomplete. Only the records already obtained are shown; this is not completion of the whole request.',ar:'لم يكتمل جزء من الطلب. تُعرض السجلات التي جُلبت فقط، وهذا لا يعني اكتمال الطلب كله.'}[language];
  return [incomplete?partial:null,...['access_limited','not_found','needs_choice'].filter(code=>selected.has(code)).map(code=>instructions[code]),rows.length?words.heading:null,table,rows.length?words.status:null,downloaded?words.download:rows.some(row=>row.hasAttachments===true)?words.attachments:null,...['reason_not_returned','action_unavailable','location_unavailable','file_unavailable','offer_separate_complaint'].filter(code=>selected.has(code)).map(code=>instructions[code]),rows.length>1&&!candidates?words.choose:null,mode==='simulation'?words.scope:words.real].filter(Boolean).join('\n\n');
}

// Successful citizen writes have an authoritative receipt, not an LLM promise
// about another system's notifications, refund, work schedule or app visibility.
export function submissionOutcome(receipts,{language='en',mode='simulation',incomplete=false}={}){
  const writes=receipts.filter(r=>BY_ID.get(r.operation)?.effect==='write');
  if(!writes.length)return null;
  const words={
    zh:{heading:mode==='simulation'?'已完成本次本地仿真提交。':'CRM 已返回提交回执。',number:'记录编号',title:'标题',file:'已上传附件',scope:'记录仅保存在本次仿真会话中，未发送至政府系统；不能在官方 App 查询，也不会触发真实短信、邮件或退款。',real:'以下仅表示接口已返回回执；后续处理、通知和官方平台可见性尚未核实。'},
    en:{heading:mode==='simulation'?'This local simulated submission is complete.':'CRM returned a submission receipt.',number:'Record number',title:'Title',file:'Attachment uploaded',scope:'This record exists only in this simulated conversation. It was not sent to a government system, cannot be tracked in the official app, and triggers no real SMS, email or refund.',real:'The receipt confirms only the API response. Subsequent handling, notifications and visibility in official channels have not been verified.'},
    ar:{heading:mode==='simulation'?'اكتمل الإرسال في المحاكاة المحلية.':'أعاد CRM إيصال الإرسال.',number:'رقم السجل',title:'العنوان',file:'تم رفع المرفق',scope:'هذا السجل موجود في هذه المحادثة التجريبية فقط. لم يُرسل إلى جهة حكومية، ولا يمكن تتبعه في التطبيق الرسمي، ولا يرسل رسائل أو بريداً ولا ينفذ استرداداً مالياً.',real:'يثبت الإيصال استجابة الواجهة فقط. لم يتم التحقق من المعالجة اللاحقة أو الإشعارات أو ظهوره في القنوات الرسمية.'}
  }[language];
  const safe=value=>String(value??'').replace(/[\\`*_[\]<>|]/g,'\\$&').replace(/[\r\n]+/g,' ');
  const lines=writes.flatMap(r=>{const result=r.result?.data?.result,body=r.parameters?.body??{};
    if(['crm_upload_attachment','crm_upload_file'].includes(r.operation))return ['- '+words.file+': '+safe(body.pxAttachName??'')];
    const rows=Array.isArray(result)?result:[result];
    return rows.filter(Boolean).flatMap(row=>{const number=row.id??row.pyID??row.TSRNo??row.IncidentID;
      return [...(number?['- '+words.number+': '+safe(number)]:[]),...(body.subject?['- '+words.title+': '+safe(body.subject)]:[])];});
  });
  const partial={zh:'以下操作已取得回执，其余请求尚未完成。',en:'The operations below returned receipts; the remaining request is not complete.',ar:'أعادت العمليات أدناه إيصالات؛ لم يكتمل الجزء المتبقي من الطلب.'}[language];
  return [incomplete?partial:words.heading,lines.join('\n'),mode==='simulation'?words.scope:words.real].filter(Boolean).join('\n\n');
}

// Old answers appended an exact host-generated JSON suffix. Hide only that
// verified suffix in the public view; preserve stored history and evidence.
export function presentCrmMessage(message,receipts){
  if(message.role!=='assistant'||message.kind!=='result'||!message.receipt_ids?.length)return message;
  const supporting=message.receipt_ids.map(id=>receipts.find(r=>r.id===id));
  if(supporting.some(r=>!r||!BY_ID.has(r.operation)||!r.result?.data))return message;
  const start=message.text.lastIndexOf('\n\n'+BY_ID.get(supporting[0].operation).summary+': ');
  if(start<0)return message;
  const lines=message.text.slice(start+2).split('\n');if(lines.length!==supporting.length)return message;
  // JSONB does not preserve object key order. Compare parsed evidence, not its
  // serialization, while requiring every known operation prefix and response.
  try{
    if(!supporting.every((r,i)=>{const prefix=BY_ID.get(r.operation).summary+': ';return lines[i].startsWith(prefix)&&isDeepStrictEqual(JSON.parse(lines[i].slice(prefix.length)),r.result.data);}))return message;
  }catch{return message;}
  return {...message,text:message.text.slice(0,start)};
}
// Supplemental explanations add goal/limitation context; host summaries already
// render the receipt rows. Reject the format before model review so a repeated
// table cannot be approved as a merely factually correct explanation.
export function explanationHasTable(text){return normalizeCustomerText(text).split(/\r?\n/u).some(line=>/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line));}

// Source-bound supplements identify the citizen's question without granting
// the author a prose channel to invent capability, policy or field claims.
export function sourceBoundOutcome({language='en',unavailableQuote,unconfirmedQuote}){
  const safe=value=>value.replace(/[\\`*_[\]<>|]/gu,'\\$&').replace(/[\r\n]+/gu,' ');
  const words={zh:['本次未办理的请求是：','当前引用的记录尚未核实你问到的这项信息：'],en:['The request not carried out in this turn is:','The cited records have not established the information you asked about:'],ar:['الطلب الذي لم يُنفَّذ في هذه الجولة هو:','لم تثبت السجلات المشار إليها المعلومة التي سألت عنها:']}[language];
  return [unavailableQuote?words[0]+' “'+safe(unavailableQuote)+'”':null,unconfirmedQuote?words[1]+' “'+safe(unconfirmedQuote)+'”':null].filter(Boolean).join('\n\n')||null;
}

export function constraintObservationOutcome(labels,{language='en'}={}){
  const routes=labels.join(' / ');
  return ({zh:`保留的操作检查涉及：${routes}。检查发现缺少必需的下级行政位置资料，且未连接相应的地址解析服务。这些检查没有执行提交；最终尚未核实这些路线与原诉求的关联。`,en:`The retained operation checks concern: ${routes}. They found missing required local administrative location data and no connected address resolver. These checks did not execute a submission; the final association of these routes with the original request has not been verified.`,ar:`تخص فحوص العمليات المحفوظة: ${routes}. وجدت نقصاً في بيانات النطاق الإداري المحلي المطلوبة وعدم اتصال خدمة لتحليل العنوان. لم تنفذ هذه الفحوص إرسالاً؛ ولم يُتحقق نهائياً من ارتباط هذه المسارات بالطلب الأصلي.`})[language];
}
