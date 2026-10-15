import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the shipped renderer with a small DOM adapter; native browser checks
// separately cover scrolling, layout and form validation.
class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attrs={};this.listeners={};this.className='';this.value='';this.checked=false;this.type='';this.name='';this.open=false;this.hidden=false;this.disabled=false;this.scrollTop=0;this.clientHeight=600;this.scrollHeight=600;this.style={};this._text='';if(tag==='textarea')Object.defineProperty(this,'type',{get:()=> 'textarea'});}
  set textContent(v){this._text=String(v);this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  append(...children){for(const c of children){c.remove?.();c.parentElement=this;this.children.push(c);}}prepend(...children){for(const c of children.reverse()){c.remove?.();c.parentElement=this;this.children.unshift(c);}}
  replaceChildren(...children){for(const c of this.children)c.parentElement=null;this.children=[];this._text='';this.append(...children);}
  remove(){if(this.parentElement){const p=this.parentElement;p.children=p.children.filter(x=>x!==this);this.parentElement=null;}}
  insertBefore(node,before){node.remove();node.parentElement=this;const i=this.children.indexOf(before);if(i<0)this.children.push(node);else this.children.splice(i,0,node);}
  get firstChild(){return this.children[0]??null;}get nextSibling(){const p=this.parentElement;return p?.children[p.children.indexOf(this)+1]??null;}
  setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}
  addEventListener(type,fn){this.listeners[type]=fn;}async fire(type,props={}){const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},target:this,...props};await this.listeners[type]?.(event);return event;} requestSubmit(){return this.fire('submit');}
  matches(selector){return selector.split(',').some(s=>{s=s.trim();if(s.startsWith('.'))return this.className.split(' ').includes(s.slice(1));const tag=s.match(/^[a-z]+/i)?.[0];if(tag&&this.tagName!==tag.toUpperCase())return false;for(const a of s.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)){const key=a[1],value=key==='open'?this.open:key.startsWith('data-')?this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]:this[key]??this.attrs[key];if(!value||a[2]!==undefined&&String(value)!==a[2])return false;}return !!tag||s.startsWith('[');});}
  querySelectorAll(s){const list=this.children.flatMap(c=>[...(c.matches(s)?[c]:[]),...c.querySelectorAll(s)]);list.includes=undefined;return list;}querySelector(s){return this.querySelectorAll(s)[0]??null;}
  closest(s){return this.matches(s)?this:this.parentElement?.closest(s)??null;}focus(){this.document.activeElement=this;}setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}
}
const source=await readFile(new URL('../web/road/app.js',import.meta.url),'utf8');
const fixture=()=>({id:'session',demo_ui:true,running:false,status:'review',user:null,messages:[{id:'m1',role:'user',text:'There is a big pothole in front of my house',time:'2026-10-14T14:00:00Z'}],plans:[{id:'p1',version:1,goal:'Report this pothole',summary:'Collect the location, then create the report.',created_at:'2026-10-14T14:00:01Z',status:'review',approved:false,steps:[{id:'address',title:'Collect pothole location',capability:'input',depends_on:[],parameters:{},status:'pending'},{id:'create',title:'Create pothole report',capability:'create_ticket',depends_on:['address'],parameters:{},status:'pending'}]}],activePlanId:'p1',pendingInput:null,pendingOperation:null,events:[],receipts:[],mock:{calls:[],handoffs:[]},faq:{name:'test',entry_count:9,source_displayed_count:26,migration_status:'verified-subset'}});
async function harness({storedLocale,browserLanguage='zh-CN'}={}){
  const nodes=new Map(),doc={activeElement:null,getElementById(id){if(!nodes.has(id)){const e=new Element();e.document=doc;nodes.set(id,e);}return nodes.get(id);},createElement(tag){const e=new Element(tag);e.document=doc;return e;},querySelectorAll(s){return [...nodes.values()].flatMap(e=>e.querySelectorAll(s));}};
  doc.documentElement=new Element('html');
  const requests=[];const storage=new Map(storedLocale?[['road:locale',storedLocale]]:[]);const context=vm.createContext({document:doc,console,navigator:{language:browserLanguage},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v))},requestAnimationFrame:fn=>fn(),setTimeout,clearTimeout,setInterval:()=>0,clearInterval,AbortSignal,FormData,fetch:async(path,options={})=>{requests.push({path,...options});return {ok:true,status:200,json:async()=>fixture()};},EventSource:class{close(){}}});
  // New renderer stays importable for tests without a browser or server.
  if(source.startsWith('import ')){const {createChatRenderer}=await import('../web/road/chat-ui.js');context.createChatRenderer=createChatRenderer;Object.assign(context,await import('../web/road/i18n.js'));}
  vm.runInContext(source.replace(/^import .*;\n/gm,'').replace(/start\(\)\.catch\([\s\S]*?\);\s*$/,"globalThis.testUI={render,setState(value){state=value;if(typeof client!=='undefined')client.connecting=false;}};"),context);
  const state=fixture();context.testUI.setState(state);context.testUI.render();return {nodes,doc,state,requests,storage,render(){context.testUI.setState(state);context.testUI.render();},chat:doc.getElementById('messages')};
}
test('plan reply and next action are inside the conversation, so a chatbot-only user can continue',async()=>{
  const h=await harness();assert(h.chat.textContent.includes('Collect the location, then create the report.'));
  assert(h.chat.querySelectorAll('button').some(b=>/继续|Continue/.test(b.textContent)),'plan approval must be inside messages');
  assert(h.chat.textContent.includes('Collect pothole location'),'task list must be inside messages');
});
test('a completed task is visibly crossed out inside the conversation',async()=>{
  const h=await harness();h.state.plans[0].steps[0].status='completed';h.render();
  assert(h.chat.querySelectorAll('s').some(n=>n.textContent==='Collect pothole location'));
});
test('hiding task details keeps the plan reply and next action accessible',async()=>{
  const h=await harness();const toggle=h.doc.getElementById('show-tasks');toggle.checked=false;await toggle.fire('change');
  assert(h.chat.querySelectorAll('details').filter(d=>d.className==='task-list').every(d=>d.hidden));
  assert(h.chat.textContent.includes('Collect the location, then create the report.'));assert(h.chat.querySelectorAll('button').some(b=>/继续/.test(b.textContent)));
});
test('pending submission and missing information are actionable in the chat itself',async()=>{
  const h=await harness();h.state.plans[0].status='approved';h.state.user={user_id:'U001'};
  h.state.pendingInput={id:'i1',kind:'address',question:'Please provide city and street.',candidates:[]};h.render();
  assert(h.chat.querySelectorAll('form').some(f=>f.dataset.formKey==='input:i1'));assert(h.chat.textContent.includes('Please provide city and street.'));
  h.state.pendingInput=null;h.state.pendingOperation={id:'o1',operation:'create_ticket',parameters:{address:{city:'Riyadh',street:'Test Road'},description:'Pothole'}};h.render();
  assert(h.chat.querySelectorAll('button').some(b=>b.textContent==='确认提交'));assert(h.chat.textContent.includes('Riyadh, Test Road'));
});
test('server updates preserve typed input, focus and scroll rather than clearing the form',async()=>{
  const h=await harness();h.state.pendingInput={id:'i1',kind:'address',question:'Address?',candidates:[]};h.render();
  const form=h.chat.querySelectorAll('form').find(f=>f.dataset.formKey==='input:i1');const city=form.querySelectorAll('input').find(x=>x.name==='city'),street=form.querySelectorAll('input').find(x=>x.name==='street');city.value='الرياض';street.value='Test Cedar Road';street.focus();street.setSelectionRange(4,4);h.chat.scrollHeight=1800;h.chat.scrollTop=100;
  h.state.running=true;h.render();const next=h.chat.querySelectorAll('form').find(f=>f.dataset.formKey==='input:i1');
  assert.equal(next.querySelectorAll('input').find(x=>x.name==='city').value,'الرياض');assert.equal(next.querySelectorAll('input').find(x=>x.name==='street').value,'Test Cedar Road');assert.equal(h.doc.activeElement.name,'street');assert.equal(h.chat.scrollTop,100);
});
test('while the model is running the conversation shows progress, and ticket resolution needs an explicit choice',async()=>{
  const h=await harness();h.state.running=true;h.render();assert(h.chat.querySelectorAll('article').some(n=>n.className.includes('working-card')));
  h.state.events.push({type:'turn_started',route:'resume',seq:10,time:new Date().toISOString()});h.render();assert(h.chat.textContent.includes('正在继续已确认的计划'));
  h.state.running=false;h.state.pendingInput={id:'i2',kind:'ticket',question:'Which report?',candidates:[{ticket_id:'T101',status:'OPEN',description:'Pothole',address:{city:'Riyadh',street:'Test Road'}}]};h.render();
  const radios=h.chat.querySelectorAll('input').filter(i=>i.name==='unresolved');assert.equal(radios.length,2);assert(radios.every(i=>i.required&&!i.checked));
});
test('a text clarification renders using native-like readonly textarea properties',async()=>{
  const h=await harness();h.state.pendingInput={id:'text-1',kind:'text',question:'Can you clarify the location?',candidates:[]};h.render();assert(h.chat.textContent.includes('Can you clarify the location?'));assert(h.chat.querySelectorAll('textarea').some(t=>t.name==='text'));assert(h.chat.querySelectorAll('button').some(b=>b.textContent==='提交信息并继续'));
});

const settle=()=>new Promise(r=>setImmediate(r));
test('Enter submits once; Shift+Enter, IME composition, repeats and busy state do not send',async()=>{
 const h=await harness(),input=h.doc.getElementById('chat-message');input.value='Show ticket history';const e=await input.fire('keydown',{key:'Enter'});await settle();assert(e.defaultPrevented);assert.equal(h.requests.filter(r=>r.path==='/api/chat').length,1);assert.equal(JSON.parse(h.requests.find(r=>r.path==='/api/chat').body).message,'Show ticket history');
 for(const props of [{shiftKey:true},{isComposing:true},{keyCode:229},{repeat:true}]){input.value='Must not send';await input.fire('keydown',{key:'Enter',...props});}await settle();assert.equal(h.requests.filter(r=>r.path==='/api/chat').length,1);
 h.state.running=true;h.render();await input.fire('keydown',{key:'Enter'});await settle();assert.equal(h.requests.filter(r=>r.path==='/api/chat').length,1);
});
test('automatic plans have no whole-plan continue button and keep the exact write confirmation visible',async()=>{
 const h=await harness();h.state.plans[0].approved=true;h.state.plans[0].status='approved';h.state.pendingOperation={id:'o1',operation:'create_ticket',parameters:{address:{city:'Riyadh',street:'Test Road'},description:'Pothole'}};h.render();assert(!h.chat.querySelectorAll('button').some(b=>/按计划继续/.test(b.textContent)));assert(h.chat.querySelectorAll('button').some(b=>b.textContent==='确认提交'));
});
test('sentiment stays in the demo sidebar when task details are toggled and never becomes a chat card',async()=>{
 const h=await harness();h.state.emotion={status:'classified',sentiment:'negative',message_id:'m1',evidence:{quote:'I am disappointed'}};h.state.activeHandoffId='h1';h.state.mock.handoffs=[{handoff_id:'h1',scope:'conversation',status:'WAITING'}];h.state.status='human_waiting';h.render();
 const sidebar=h.doc.getElementById('emotion-sidebar');assert.equal(sidebar.hidden,false);assert.equal(h.doc.getElementById('emotion-status').textContent,'负向');assert.equal(h.doc.getElementById('emotion-card').dataset.sentiment,'negative');assert.equal(h.doc.getElementById('emotion-quote').textContent,'I am disappointed');assert(!h.chat.textContent.includes('I am disappointed'));assert(!h.chat.querySelectorAll('article').some(n=>n.dataset.chatId.startsWith('emotion:')));
 const before=JSON.stringify(h.state),toggle=h.doc.getElementById('show-tasks');toggle.checked=false;await toggle.fire('change');assert.equal(sidebar.hidden,false);assert.equal(h.doc.getElementById('emotion-status').textContent,'负向');assert.equal(JSON.stringify(h.state),before);assert.equal(h.requests.length,0);assert(!h.chat.querySelectorAll('button').some(b=>/模拟人工受理/.test(b.textContent)));assert(h.chat.textContent.includes('排队中，尚未受理'));
 h.state.emotion.sentiment='neutral';h.render();assert.equal(h.doc.getElementById('emotion-card').dataset.sentiment,'neutral');assert.equal(h.doc.getElementById('emotion-status').textContent,'中性');h.state.mock.handoffs[0].status='COMPLETED';h.render();assert(h.chat.querySelectorAll('button').some(b=>b.textContent==='返回智能助手'));
});
test('demo sentiment follows current classification, clears stale results and can be disabled for customers',async()=>{
 const h=await harness({storedLocale:'en'}),status=h.doc.getElementById('emotion-status'),card=h.doc.getElementById('emotion-card'),quote=h.doc.getElementById('emotion-quote');
 for(const [sentiment,label]of [['positive','Positive'],['neutral','Neutral'],['negative','Negative']]){h.state.emotion={status:'classified',sentiment,evidence:{quote:'原文 <script>not executable</script>'}};h.render();assert.equal(card.dataset.sentiment,sentiment);assert.equal(status.textContent,label);assert.equal(quote.textContent,'原文 <script>not executable</script>');assert(!h.chat.textContent.includes('原文 <script>'));}
 for(const [phase,label]of [['skipped','FAQ answered; not analyzed'],['pending_faq','Waiting for FAQ check'],['analyzing','Analyzing…'],['error','Analysis unavailable'],['idle','Not analyzed yet']]){h.state.emotion={status:phase,sentiment:'positive',evidence:{quote:'stale'}};h.render();assert.equal(card.dataset.sentiment,'unclassified');assert.equal(status.textContent,label);assert.equal(quote.textContent,'');assert(h.doc.getElementById('emotion-evidence').hidden);}
 h.state.emotion={status:'classified',sentiment:'negative',evidence:{quote:'private demo quote'}};h.state.demo_ui=false;h.render();assert(h.doc.getElementById('emotion-sidebar').hidden);assert(h.doc.getElementById('app-layout').className.includes('demo-disabled'));assert.equal(status.textContent,'');assert.equal(quote.textContent,'');assert(!h.chat.textContent.includes('private demo quote'));assert.equal(h.requests.length,0);
});

async function switchLocale(h,value){const select=h.doc.getElementById('ui-language');select.value=value;await select.fire('change');}
test('English UI follows browser language, persists the explicit preference and switches back without requests',async()=>{
 const h=await harness({browserLanguage:'en-GB'});assert.equal(h.doc.documentElement.getAttribute('lang'),'en');assert.equal(h.doc.getElementById('send').textContent,'Send');assert.equal(h.doc.getElementById('ui-language').getAttribute('aria-label'),'Interface language');assert.equal(h.doc.getElementById('app-title').textContent,'Government Services Assistant');assert.equal(h.doc.title,'Government Services Assistant');assert.equal(h.doc.getElementById('brand-title').textContent,'Government Services');assert(h.chat.textContent.includes('Welcome! I’m your Government Services Assistant.'));assert(h.chat.textContent.includes('Sign in and continue'));assert(h.chat.textContent.includes('Demo password'));
 h.doc.getElementById('chat-message').value='保留草稿 keep this';await switchLocale(h,'zh');assert.equal(h.storage.get('road:locale'),'zh');assert.equal(h.doc.getElementById('send').textContent,'发送');assert.equal(h.doc.title,'政务服务助手');assert(h.chat.textContent.includes('您好，欢迎使用政务服务助手！'));assert.equal(h.chat.querySelectorAll('article').filter(n=>n.dataset.chatId==='welcome').length,1);assert.equal(h.doc.getElementById('chat-message').value,'保留草稿 keep this');assert.equal(h.requests.length,0);
 const restored=await harness({storedLocale:'zh',browserLanguage:'en-US'});assert.equal(restored.doc.documentElement.getAttribute('lang'),'zh-CN');const invalid=await harness({storedLocale:'invalid',browserLanguage:'en-US'});assert.equal(invalid.doc.getElementById('send').textContent,'Send');
});
test('switching UI language preserves address drafts, focus, expanded task lists, scroll and exact confirmation parameters',async()=>{
 const h=await harness();h.state.plans[0].status='approved';h.state.plans[0].approved=true;h.state.pendingInput={id:'locale-address',kind:'address',question:'Where is the pothole?',candidates:[]};h.state.pendingOperation={id:'locale-proposal',operation:'create_ticket',parameters:{address:{city:'الرياض',street:'原样街道 Test Road'},description:'Keep original وصف'}};h.render();const before=JSON.stringify(h.state.pendingOperation);
 const form=h.chat.querySelectorAll('form').find(f=>f.dataset.formKey==='input:locale-address');form.querySelectorAll('input').find(x=>x.name==='city').value='الرياض';const street=form.querySelectorAll('input').find(x=>x.name==='street');street.value='Test Road 原样';street.focus();street.setSelectionRange(4,4);const tasks=h.chat.querySelectorAll('details').find(d=>d.className==='task-list');tasks.open=false;h.chat.scrollHeight=1800;h.chat.scrollTop=100;
 await switchLocale(h,'en');const next=h.chat.querySelectorAll('form').find(f=>f.dataset.formKey==='input:locale-address');assert.equal(next.querySelectorAll('input').find(x=>x.name==='city').value,'الرياض');assert.equal(next.querySelectorAll('input').find(x=>x.name==='street').value,'Test Road 原样');assert.equal(h.doc.activeElement.name,'street');assert.equal(h.chat.scrollTop,100);assert.equal(h.chat.querySelectorAll('details').find(d=>d.className==='task-list').open,false);assert.equal(JSON.stringify(h.state.pendingOperation),before);assert(h.chat.querySelectorAll('button').some(b=>b.textContent==='Confirm submission'));assert(h.chat.textContent.includes('Keep original وصف'));assert(h.chat.textContent.includes('Ticket address'));
});
test('English sentiment, human lifecycle and host notices stay localized while user and FAQ source text stays verbatim',async()=>{
 const h=await harness({storedLocale:'en'});h.state.plans=[];h.state.activePlanId=null;h.state.messages=[{id:'arabic',role:'user',text:'أنا محبط جداً'},{id:'notice',role:'assistant',kind:'human_notice',notice:'human.queued',text:'我识别到你当前的负向情绪'},{id:'faq',role:'assistant',kind:'faq',text:'知识库原文不改写',source:{id:'FAQ-002'}}];h.state.emotion={status:'classified',sentiment:'negative',message_id:'arabic',evidence:{quote:'أنا محبط جداً'}};h.state.activeHandoffId='locale-human';h.state.mock.handoffs=[{handoff_id:'locale-human',scope:'conversation',status:'WAITING'}];h.render();
 assert.equal(h.doc.getElementById('emotion-status').textContent,'Negative');assert(h.chat.textContent.includes('I detected current negative sentiment'));assert(h.chat.textContent.includes('أنا محبط جداً'));assert(h.chat.textContent.includes('知识库原文不改写'));assert(h.chat.textContent.includes('FAQ source: FAQ-002'));assert(h.chat.querySelectorAll('button').some(b=>b.textContent==='Simulate human acceptance'));assert(!h.chat.textContent.includes('当前处于模拟人工'));
 h.state.mock.handoffs[0].status='ACCEPTED';h.render();assert(h.chat.querySelectorAll('button').some(b=>b.textContent==='Simulate supervisor escalation'));h.state.mock.handoffs[0].status='COMPLETED';h.render();assert(h.chat.querySelectorAll('button').some(b=>b.textContent==='Return to assistant'));await switchLocale(h,'zh');assert(h.chat.querySelectorAll('button').some(b=>b.textContent==='返回智能助手'));assert(h.chat.textContent.includes('我识别到你当前的负向情绪'));
});
test('English ticket input, high-risk query confirmation, receipts and progress use translated labels without changing API values',async()=>{
 const h=await harness({storedLocale:'en'});h.state.user={user_id:'U001'};h.state.plans[0].approved=true;h.state.plans[0].status='approved';h.state.pendingInput={id:'locale-ticket',kind:'ticket',question:'Select the report',candidates:[{ticket_id:'T101',status:'OPEN',description:'工单原文',address:{city:'Riyadh',street:'Test Road'}}]};h.state.pendingOperation={id:'locale-risk',operation:'query_tickets',confirmation_reason:'high_risk_read',parameters:{ticket_id:'T101'}};h.state.receipts=[{id:'locale-receipt',operation:'query_tickets',result:{tickets:[]}}];h.render();assert(h.chat.textContent.includes('Select the matching ticket'));assert(h.chat.textContent.includes('Is the issue still unresolved?'));assert(h.chat.querySelectorAll('button').some(b=>b.textContent==='Confirm query'));assert(h.chat.textContent.includes('high-risk read'));assert(h.chat.textContent.includes('Retrieved 0 of your tickets.'));const radios=h.chat.querySelectorAll('input').filter(i=>i.name==='unresolved');assert.deepEqual(radios.map(i=>i.value),['yes','no']);assert(h.chat.textContent.includes('工单原文'));
 h.state.running=true;h.state.events=[{type:'turn_started',route:'faq_first'},{type:'emotion_started'}];h.render();assert(h.chat.textContent.includes('Analyzing your current sentiment'));h.state.emotion={status:'skipped'};h.render();assert.equal(h.doc.getElementById('emotion-status').textContent,'FAQ answered; not analyzed');
});
