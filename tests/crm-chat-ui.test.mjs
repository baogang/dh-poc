import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatRenderer} from '../web/road/chat-ui.js';
import {createDocument} from './helpers/dom.mjs';
import {presentCrmMessage} from '../src/crm/presentation.mjs';
import {crmEditor} from '../web/road/crm-review.js';
import {translator} from '../web/road/i18n.js';

const narrative='已查询市政主资产列表，共 1 条：\n\n| 主资产 ID | 主资产名称 |\n|---|---|\n| MA-DEMO-1 | Simulated municipal infrastructure |\n\n如需查看详情，请提供对应的 `MainAssetsID`。';
const receipt={id:'r-assets',operation:'crm_get_assets',time:'2026-10-20T02:00:00Z',result:{statusDetails:{code:200,message:'success'},data:{responseCode:'1',responseMessage:'success',result:[{MainAssetsID:'MA-DEMO-1',MainAssetsName:'Simulated municipal infrastructure'}]}}};
const state=()=>({user:{name:'demo'},status:'completed',running:false,messages:[{id:'answer',role:'assistant',kind:'result',text:narrative,receipt_ids:[receipt.id],time:'2026-10-20T02:00:01Z'}],plans:[],events:[],receipts:[receipt],mock:{handoffs:[]}});
function fixture(value=state(),options={},actions={}){const document=createDocument(),container=document.createElement('div'),renderer=createChatRenderer(document,container,actions);renderer.render(value,options);return {container,renderer,value};}
const answer=container=>container.children.find(n=>n.dataset.chatId==='message:answer');

const choiceState=(question='How would you like to continue?')=>({...state(),messages:[],receipts:[],status:'input',pendingInput:{id:'service-route-input',kind:'choice',question,choices:[{id:'public-route-id',label:'General service complaint',description:'Record a separate local complaint about the service experience.',operation:'crm_create_form_request'},{id:'no-submission-id',label:'Keep the original request',description:'Explain what is still needed without registering a different service.',operation:'none'}]}});
const choiceCard=container=>container.children.find(n=>n.dataset.chatId==='input:service-route-input');

test('blocked input steps show an ordinary status in Chinese English and Arabic without claiming completion',()=>{
  for(const item of[{goal:'反映人行道破损',title:'补充问题地点',locale:'zh',label:'暂时无法继续'},{goal:'Report damaged pavement',title:'Collect the location',locale:'en',label:'Cannot continue yet'},{goal:'الإبلاغ عن تلف الرصيف',title:'تحديد الموقع',locale:'en',label:'تعذرت المتابعة حالياً'}]){const value=state();value.messages=[];value.receipts=[];value.status='blocked';value.activePlanId='location-plan';value.plans=[{id:'location-plan',goal:item.goal,status:'running',steps:[{id:'location',title:item.title,capability:'input',status:'blocked'}]}];const card=fixture(value,{locale:item.locale,showTasks:true}).container.children.find(n=>n.dataset.chatId==='plan:location-plan');const row=card.querySelector('li'),label=row.querySelectorAll('small').find(n=>n.className==='task-state');assert.equal(label.textContent,item.label);assert.doesNotMatch(label.textContent,/blocked|completed|已完成/u);assert.equal(row.querySelectorAll('s').length,0);assert.equal(card.querySelectorAll('form').length,0);}
});

test('a permanent current-request location limitation has a three-language explanation and offers no retry button or retrying plan footer',()=>{
  for(const item of[{goal:'反映路面破损',locale:'zh',reason:/地点|行政地区/u},{goal:'Report surface damage',locale:'en',reason:/administrative location|location resolution/iu},{goal:'الإبلاغ عن تلف الطريق',locale:'en',reason:/الموقع|الإداري/u}]){const value=state();value.messages=[];value.receipts=[];value.status='blocked';value.activePlanId='location-plan';value.plans=[{id:'location-plan',origin_message_id:'current-request',goal:item.goal,approved:true,status:'approved',steps:[{id:'location',title:item.goal,capability:'input',status:'blocked',error:{code:'LOCATION_METADATA_UNAVAILABLE'}}]}];value.facts={hostConstraints:{'current-request':{crm_create_municipal_service:{code:'LOCATION_METADATA_UNAVAILABLE',operation:'crm_create_municipal_service',origin_message_id:'current-request',capability:'administrative_location_resolution',available:false,step_id:'location'}}}};const rendered=fixture(value,{locale:item.locale}),card=rendered.container.children.find(n=>n.dataset.chatId==='plan:location-plan');assert.equal(rendered.container.children.filter(n=>n.dataset.chatId==='retry:location-plan').length,0);assert.match(card.textContent,item.reason);assert.doesNotMatch(card.textContent,/重试|try again|retry|حاول مرة أخرى|إعادة المحاولة/iu);assert.equal(card.querySelectorAll('button').length,0);}
});

test('transient failed interrupted and recoverable blocked plans keep retry controls while an old-origin limit cannot suppress a new request retry',()=>{
  for(const status of['failed','interrupted','blocked']){const value=state();value.messages=[];value.receipts=[];value.status=status;value.activePlanId='current-plan';value.plans=[{id:'current-plan',origin_message_id:'new-request',goal:'Load my records',approved:true,status:'approved',steps:[{id:'history',title:'Load my records',capability:'crm_get_incidents',status:'failed',error:{code:'TEMPORARY_UNAVAILABLE'}}]}];value.facts={hostConstraints:{'old-request':{crm_create_municipal_service:{code:'LOCATION_METADATA_UNAVAILABLE',origin_message_id:'old-request',capability:'administrative_location_resolution',available:false}}}};const container=fixture(value,{locale:'en'}).container,retry=container.children.find(n=>n.dataset.chatId==='retry:current-plan');assert.ok(retry);assert.ok(retry.querySelectorAll('button').some(b=>/retry/iu.test(b.textContent)));}
});

test('service choice uses explicit native single selection and sends only its selected choice ID without approving a write',async()=>{
  const calls=[],f=fixture(choiceState(),{locale:'en'},{action:async(path,body)=>calls.push({path,body})}),card=choiceCard(f.container),form=card.querySelector('form'),radios=card.querySelectorAll('input').filter(x=>x.type==='radio');assert.ok(card.querySelector('fieldset'));assert.ok(card.querySelector('legend'));assert.equal(radios.length,2);assert.ok(radios.every(x=>x.required&&!x.checked));assert.match(card.textContent,/not.*submit|no.*submission/iu);assert.ok(!card.textContent.includes('crm_create_form_request'));assert.ok(!card.textContent.includes('public-route-id'));assert.ok(!card.textContent.includes('no-submission-id'));
  await form.listeners.submit({preventDefault(){}});assert.equal(calls.length,0,'No default route may be silently chosen');radios[1].checked=true;await form.listeners.submit({preventDefault(){}});assert.deepEqual(calls,[{path:'/api/input',body:{input_id:'service-route-input',value:{choice_id:'no-submission-id'}}}]);assert.ok(!calls.some(x=>x.path==='/api/approve-operation'));assert.ok(card.querySelectorAll('button').some(x=>/cancel/iu.test(x.textContent)));
});

test('service choice keeps selection across refresh and disables all actions while the selection is being sent',async()=>{
  let release;const calls=[],pending=new Promise(resolve=>release=resolve),f=fixture(choiceState(),{locale:'en'},{action:(path,body)=>{calls.push({path,body});return pending;}}),card=choiceCard(f.container),radios=card.querySelectorAll('input');radios[0].checked=true;f.renderer.render(f.value,{locale:'en',busy:true});const busy=choiceCard(f.container);assert.ok(busy.querySelectorAll('input').every(x=>x.disabled));assert.ok(busy.querySelectorAll('button').every(x=>x.disabled));assert.equal(busy.querySelectorAll('input')[0].checked,true);f.renderer.render(f.value,{locale:'en'});const ready=choiceCard(f.container),form=ready.querySelector('form');assert.equal(ready.querySelectorAll('input')[0].checked,true);const first=form.listeners.submit({preventDefault(){}});await form.listeners.submit({preventDefault(){}});assert.equal(calls.length,1,'A second click cannot send a duplicate selection while the first is pending');release();await first;
});

test('service choice notices and controls follow Chinese English and Arabic prompts with native RTL-safe labels',()=>{
  for(const item of [{question:'你希望使用哪种办理方式？',notice:/选择.*(?:不会|尚未).*提交/u,action:'选择后继续',dir:'ltr'},{question:'Which service would you like to use?',notice:/not.*submit|no.*submission/iu,action:'Continue with this choice',dir:'ltr'},{question:'كيف تود متابعة هذا الطلب؟',notice:/لا.*(?:إرسال|تقديم)/u,action:'متابعة بهذا الاختيار',dir:'rtl'}]){const value=choiceState(item.question);if(item.dir==='rtl'){value.pendingInput.choices[0].label='شكوى عن تجربة الخدمة';value.pendingInput.choices[0].description='تسجيل شكوى محلية منفصلة بعد مراجعة التفاصيل.';}const card=choiceCard(fixture(value,{locale:'en'}).container);assert.match(card.textContent,item.notice);assert.ok(card.querySelectorAll('button').some(x=>x.textContent===item.action));assert.equal(card.querySelector('form').dir,item.dir);assert.ok(card.querySelectorAll('label').every(x=>x.dir==='auto'));assert.equal(card.querySelectorAll('textarea').length,0,'Choosing a service must not require API JSON or typed consent');}
});

test('an expired or answered service choice keeps readable history without live route buttons',()=>{
  const value=choiceState();value.events=[{type:'input_required',input:structuredClone(value.pendingInput)},{type:'input_received',input_id:value.pendingInput.id}];value.pendingInput=null;const card=choiceCard(fixture(value,{locale:'en'}).container);assert.ok(card);assert.equal(card.querySelectorAll('form').length,0);assert.equal(card.querySelectorAll('input').length,0);assert.equal(card.querySelectorAll('button').length,0);assert.match(card.textContent,/choice.*received|recorded.*choice/iu);
});

test('case choice names actual readable reports in three languages without implying service selection or approval',async()=>{
  for(const item of [{question:'你说的是哪一件报告？',legend:'选择一件报告',notice:/确定.*记录.*(?:不会|并不).*提交/u,received:/已记录.*报告选择/u,dir:'ltr',statusLabel:'记录状态',resolved:'已解决',open:'未结案'},{question:'Which report did you mean?',legend:'Choose a report',notice:/identifies.*record.*does not.*submit/iu,received:/report choice has been received/iu,dir:'ltr',statusLabel:'Recorded status',resolved:'Resolved',open:'Open'},{question:'أي بلاغ تقصد؟',legend:'اختر بلاغًا',notice:/يحدد.*السجل.*ولا.*يرسل/u,received:/استلام اختيار البلاغ/u,dir:'rtl',statusLabel:'الحالة المسجلة',resolved:'تم الحل',open:'مفتوح'}]){
    const value=choiceState(item.question);Object.assign(value.pendingInput,{purpose:'case',choices:[{id:'record-one-private',label:'Waste by Cedar Library · 2031-04-12',description:item.statusLabel+': '+item.resolved,record_key:'MOMRA-OPS-CS-WORK INC-31-04-000011',record_id:'INC-31-04-000011',record_fingerprint:'private-fingerprint-one'},{id:'record-two-private',label:'Waste by Oak Park · 2031-04-17',description:item.statusLabel+': '+item.open,record_key:'MOMRA-OPS-CS-WORK INC-31-04-000024',record_id:'INC-31-04-000024',record_fingerprint:'private-fingerprint-two'},{id:'record-none-private',label:'None of these'}]});
    const calls=[],f=fixture(value,{locale:'en'},{action:async(path,body)=>calls.push({path,body})}),card=choiceCard(f.container),form=card.querySelector('form');assert.equal(card.querySelector('legend').textContent,item.legend);assert.match(card.textContent,item.notice);assert.equal(form.dir,item.dir);assert.ok(card.textContent.includes(item.resolved));assert.ok(card.textContent.includes(item.open));if(item.statusLabel!=='Recorded status')assert.doesNotMatch(card.textContent,/\b(?:Resolved|Open|InProgress)\b/u);assert.ok(card.querySelectorAll('input').every(x=>!x.checked));assert.match(card.textContent,/Cedar Library.*2031-04-12/u);assert.match(card.textContent,/Oak Park.*2031-04-17/u);assert.doesNotMatch(card.textContent,/MOMRA-OPS-CS-WORK|private-fingerprint|record-one-private/u);
    card.querySelectorAll('input')[1].checked=true;await form.listeners.submit({preventDefault(){}});assert.deepEqual(calls,[{path:'/api/input',body:{input_id:'service-route-input',value:{choice_id:'record-two-private'}}}]);assert.ok(!calls.some(c=>c.path==='/api/approve-operation'));
    value.events=[{type:'input_required',input:structuredClone(value.pendingInput)},{type:'input_received',input_id:value.pendingInput.id}];value.pendingInput=null;const history=choiceCard(fixture(value,{locale:'en'}).container);assert.match(history.textContent,item.received);assert.equal(history.querySelectorAll('input').length,0);assert.equal(history.querySelectorAll('button').length,0);
  }
});

test('public complaint confirmation presents readable fields and collapses protocol JSON',()=>{
  const value=state();value.messages=[];value.receipts=[];value.pendingOperation={id:'public-review',operation:'crm_create_form_request',title:'Create public form',parameters:{body:{subject:'Rubbish Still Outside',Description:'The waste was not collected.',CustomerInformation:{FirstName:'Lina',LastName:'Citizen',EmailAddress:'lina@example.test',MobileNumber:'0501234567'},Type:'T03',Attachments:[]}}};
  const {container}=fixture(value),card=container.children.find(n=>n.dataset.chatId==='operation:public-review');
  assert.match(card.querySelector('dl').textContent,/标题Rubbish Still Outside/);assert.match(card.querySelector('dl').textContent,/投诉/);
  const technical=card.querySelector('details');assert.equal(technical.open,false);assert.match(technical.querySelector('pre').textContent,/"Type": "T03"/);
  const editor=card.querySelector('form');assert.ok(editor.querySelectorAll('input').some(n=>n.name==='body.subject'));assert.ok(!editor.querySelectorAll('textarea').some(n=>n.name==='text'));
});
test('editing a title preserves its exact case and the other reviewed submission fields',()=>{
  const document=createDocument(),parameters={body:{subject:'Original title',Description:'The waste was not collected.',CustomerInformation:{FirstName:'Lina',LastName:'Citizen',EmailAddress:'lina@example.test',MobileNumber:'0501234567'},Type:'T03',Attachments:[]}};let edited;
  const form=crmEditor(document,{id:'draft',parameters},translator('en'),{busy:false,onSubmit:value=>edited=value});
  form.querySelectorAll('input').find(n=>n.name==='body.subject').value='Rubbish Still Outside';form.listeners.submit({preventDefault(){}});
  assert.equal(edited.body.subject,'Rubbish Still Outside');assert.deepEqual(edited.body.CustomerInformation,parameters.body.CustomerInformation);assert.equal(edited.body.Description,parameters.body.Description);assert.equal(parameters.body.subject,'Original title');
});

test('asset answer renders an accessible table instead of literal Markdown pipes',()=>{
  const {container}=fixture(),node=answer(container),table=node.querySelector('table');
  assert.ok(table,'Assistant Markdown table must be a real table');
  assert.equal(table.querySelectorAll('th').length,2);assert.equal(table.querySelectorAll('td').length,2);
  assert.match(table.textContent,/MA-DEMO-1/);assert.doesNotMatch(node.textContent,/\|---/);
  assert.equal(node.querySelector('code').textContent,'MainAssetsID');
});
test('raw CRM evidence is collapsed and attached to the answer without another JSON bubble',()=>{
  const {container}=fixture(),details=answer(container).querySelector('details');
  assert.ok(details,'Answer must retain expandable authoritative API evidence');assert.equal(details.open,false);
  assert.match(details.querySelector('pre').textContent,/MainAssetsID/);
  assert.equal(container.children.filter(n=>n.dataset.chatId==='receipt:r-assets').length,0);
});
test('a simulated file download offers the actual returned bytes as a normal download link',()=>{
  const value=state();value.receipts=[{id:'download',operation:'crm_download_file',api_mode:'simulation',result:{data:{result:{AttachName:'evidence.txt',AttachmentStream:'SGVsbG8='}}}}];value.messages[0].receipt_ids=['download'];value.messages[0].text='The attachment is ready.';
  const link=answer(fixture(value).container).querySelector('a');assert.ok(link);assert.equal(link.download,'evidence.txt');assert.equal(link.href,'data:application/octet-stream;base64,SGVsbG8=');
  value.receipts[0].result.data.result.AttachmentStream='javascript:alert(1)';assert.equal(answer(fixture(value).container).querySelectorAll('a').length,0);
  value.receipts[0].result.data.result.AttachmentStream='SGVsbG8=';value.receipts[0].api_mode='real';assert.equal(answer(fixture(value).container).querySelectorAll('a').length,0,'The undocumented real stream encoding is not guessed');
});
test('assistant formatting treats HTML as text and refuses executable links or external images',()=>{
  const value=state();value.messages[0].text='**重点** [官方入口](https://balady.gov.sa/) [危险](javascript:alert(1)) [编码](javascript&#58;alert) ![图片说明](https://example.test/tracker)\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>';
  const node=answer(fixture(value).container);
  assert.equal(node.querySelector('strong').textContent,'重点');assert.equal(node.querySelectorAll('a').length,1);
  assert.equal(node.querySelector('a').href,'https://balady.gov.sa/');assert.equal(node.querySelector('a').rel,'noopener noreferrer');
  for(const tag of ['script','img','iframe'])assert.equal(node.querySelectorAll(tag).length,0);
  assert.match(node.textContent,/<script>/);assert.match(node.textContent,/图片说明/);
});
test('tables retain escaped pipes, inline formatting and multilingual values; user text stays literal',()=>{
  const value=state();value.messages[0].text='| 编号 | 名称 |\n|---|---|\n| `MA-1` | **市政** \\| بلدي |\n\n- 第一项\n- 第二项\n\n```json\n{"code":1}\n```';
  value.messages.push({id:'literal',role:'user',text:'**原样** <script>未执行</script>'});
  const {container}=fixture(value),node=answer(container);
  assert.match(node.querySelectorAll('td')[1].textContent,/市政 \| بلدي/);assert.equal(node.querySelectorAll('li').length,2);
  const user=container.children.find(n=>n.dataset.chatId==='message:literal');assert.equal(user.querySelectorAll('strong').length,0);assert.equal(user.textContent,'**原样** <script>未执行</script>');
});
test('receipt expansion survives refresh and locale change; in-flight receipts remain inspectable',()=>{
  const f=fixture(),details=answer(f.container).querySelector('details');details.open=true;
  f.renderer.render(f.value,{locale:'en'});const next=answer(f.container).querySelector('details');assert.equal(next.open,true);assert.match(next.querySelector('summary').textContent,/View API receipts/);
  const value=state();value.messages=[];const pending=fixture(value).container.children.find(n=>n.dataset.chatId==='receipt:r-assets');assert.ok(pending);
  assert.equal(pending.querySelector('details').open,false);assert.ok(pending.querySelector('pre'));
});
test('existing saved answers drop only the exact host suffix and keep authoritative receipts',()=>{
  const value=state(),message=value.messages[0],suffix='\n\nList main municipal assets: '+JSON.stringify(receipt.result.data);
  const stored={...message,text:narrative+suffix};assert.equal(presentCrmMessage(stored,[receipt]).text,narrative);
  assert.equal(stored.text,narrative+suffix);assert.equal(presentCrmMessage(stored,[]).text,stored.text);
  assert.equal(presentCrmMessage({...stored,role:'user'},[receipt]).text,stored.text);
  assert.equal(presentCrmMessage({...message,text:narrative+'\nResponse from model: '+JSON.stringify(receipt.result.data)},[receipt]).text,narrative+'\nResponse from model: '+JSON.stringify(receipt.result.data));
});
test('old JSON evidence remains recognizable after Neon JSONB reorders nested object fields',()=>{
  const value=state(),message=value.messages[0],stored={...message,text:narrative+'\n\nList main municipal assets: '+JSON.stringify(receipt.result.data)};
  const reloaded={...receipt,result:{...receipt.result,data:{result:[{MainAssetsName:'Simulated municipal infrastructure',MainAssetsID:'MA-DEMO-1'}],responseMessage:'success',responseCode:'1'}}};
  assert.equal(presentCrmMessage(stored,[reloaded]).text,narrative);
  const different={...reloaded,result:{...reloaded.result,data:{...reloaded.result.data,responseCode:'2'}}};assert.equal(presentCrmMessage(stored,[different]).text,stored.text);
});
