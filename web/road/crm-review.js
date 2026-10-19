const labels={subject:'标题',Description:'问题描述',IssueDescription:'问题描述',FirstName:'名字',LastName:'姓氏',EmailAddress:'电子邮箱',MobileNumber:'联系电话',Phone:'联系电话',ContactEmail:'电子邮箱',CitizenCompanyName:'联系人',Address:'详细地址',StreetName:'街道',DistrictName:'街区',PreferredLanguage:'回复语言',IsCallBackSelected:'需要电话回访',pxAttachName:'文件名',pyMemo:'附件说明',Category:'类别',SubCategory:'子类别',Area:'服务区域',IssueType:'问题类型',EndUserLocation:'所在城市',Baladiah:'所属市政'};
export function reviewFields(parameters){
  const rows=[];
  const visit=(value,path=[])=>{if(value&&typeof value==='object'&&!Array.isArray(value)){for(const [key,item]of Object.entries(value))visit(item,[...path,key]);return;}const name=path.at(-1);if(labels[name]&&value!==null)rows.push({path,label:labels[name],value});};
  visit(parameters);return rows;
}
const set=(object,path,value)=>{let node=object;for(const key of path.slice(0,-1))node=node[key];node[path.at(-1)]=value;};
export function crmReview(document,parameters,t){
  const root=document.createElement('div'),dl=document.createElement('dl');dl.className='payload crm-review';
  for(const field of reviewFields(parameters)){const title=document.createElement('dt'),value=document.createElement('dd');title.textContent=t(field.label);value.textContent=field.value===true||field.value==='true'?t('是'):field.value===false||field.value==='false'?t('否'):String(field.value);dl.append(title,value);}
  if(parameters.body?.Type){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=t('提交类型');dd.textContent=t({T01:'咨询',T02:'建议',T03:'投诉'}[parameters.body.Type]??'其他');dl.prepend(dt,dd);}
  if(Array.isArray(parameters.body?.Attachments)){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=t('附件');dd.textContent=parameters.body.Attachments.length?t('已附 {count} 个文件',{count:parameters.body.Attachments.length}):t('无附件');dl.append(dt,dd);}
  root.append(dl);const details=document.createElement('details');details.className='submission-technical';const summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=t('查看完整提交数据');pre.textContent=JSON.stringify(parameters,null,2);details.append(summary,pre);root.append(details);return root;
}
export function crmEditor(document,proposal,t,{busy,onSubmit}){
  const form=document.createElement('form');form.className='inline-form';form.dataset.formKey='edit:'+proposal.id;
  const fields=reviewFields(proposal.parameters),inputs=[];
  for(const field of fields){const label=document.createElement('label');label.textContent=t(field.label);const flag=typeof field.value==='boolean'||field.path.at(-1)==='IsCallBackSelected',input=document.createElement(flag?'select':/Description$/.test(field.path.at(-1))?'textarea':'input');if(flag)for(const [value,label]of [['true','是'],['false','否']]){const option=document.createElement('option');option.value=value;option.textContent=t(label);input.append(option);}input.name=field.path.join('.');input.value=String(field.value);input.required=true;if(input.tagName==='INPUT')input.type=/Email/i.test(field.path.at(-1))?'email':/Phone|Mobile/i.test(field.path.at(-1))?'tel':typeof field.value==='number'?'number':'text';label.append(input);form.append(label);inputs.push({input,field});}
  const submit=document.createElement('button');submit.textContent=t('保存修改并重新核对');submit.disabled=busy||!fields.length;form.append(submit);
  if(!fields.length){const note=document.createElement('p');note.textContent=t('请在聊天中说明需要修改的信息。');form.append(note);}
  form.addEventListener('submit',e=>{e.preventDefault();if(busy)return;const parameters=structuredClone(proposal.parameters);for(const {input,field} of inputs)set(parameters,field.path,typeof field.value==='number'?Number(input.value):typeof field.value==='boolean'?input.value==='true':input.value);onSubmit(parameters);});return form;
}
