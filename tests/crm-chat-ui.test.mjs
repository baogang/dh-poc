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
function fixture(value=state(),options={}){const document=createDocument(),container=document.createElement('div'),renderer=createChatRenderer(document,container,{});renderer.render(value,options);return {container,renderer,value};}
const answer=container=>container.children.find(n=>n.dataset.chatId==='message:answer');

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
