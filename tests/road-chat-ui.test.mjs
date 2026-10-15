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
const fixture=()=>({id:'session',running:false,status:'review',user:null,messages:[{id:'m1',role:'user',text:'There is a big pothole in front of my house',time:'2026-10-14T14:00:00Z'}],plans:[{id:'p1',version:1,goal:'Report this pothole',summary:'Collect the location, then create the report.',created_at:'2026-10-14T14:00:01Z',status:'review',approved:false,steps:[{id:'address',title:'Collect pothole location',capability:'input',depends_on:[],parameters:{},status:'pending'},{id:'create',title:'Create pothole report',capability:'create_ticket',depends_on:['address'],parameters:{},status:'pending'}]}],activePlanId:'p1',pendingInput:null,pendingOperation:null,events:[],receipts:[],mock:{calls:[],handoffs:[]},faq:{name:'test',entry_count:9,source_displayed_count:26,migration_status:'verified-subset'}});
async function harness(){
  const nodes=new Map(),doc={activeElement:null,getElementById(id){if(!nodes.has(id)){const e=new Element();e.document=doc;nodes.set(id,e);}return nodes.get(id);},createElement(tag){const e=new Element(tag);e.document=doc;return e;},querySelectorAll(s){return [...nodes.values()].flatMap(e=>e.querySelectorAll(s));}};
  const requests=[];const storage=new Map();const context=vm.createContext({document:doc,console,localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v))},requestAnimationFrame:fn=>fn(),setTimeout,clearTimeout,setInterval:()=>0,clearInterval,AbortSignal,FormData,fetch:async(path,options={})=>{requests.push({path,...options});return {ok:true,status:200,json:async()=>fixture()};},EventSource:class{close(){}}});
  // New renderer stays importable for tests without a browser or server.
  if(source.startsWith('import ')){const {createChatRenderer}=await import('../web/road/chat-ui.js');context.createChatRenderer=createChatRenderer;}
  vm.runInContext(source.replace(/^import .*;\n/gm,'').replace(/start\(\)\.catch\([\s\S]*?\);\s*$/,"globalThis.testUI={render,setState(value){state=value;if(typeof client!=='undefined')client.connecting=false;}};"),context);
  const state=fixture();context.testUI.setState(state);context.testUI.render();return {nodes,doc,state,requests,render(){context.testUI.setState(state);context.testUI.render();},chat:doc.getElementById('messages')};
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
test('task toggle controls sentiment and human simulation details while essential handoff status stays usable',async()=>{
 const h=await harness();h.state.emotion={status:'classified',sentiment:'negative',message_id:'m1',evidence:{quote:'I am disappointed'}};h.state.activeHandoffId='h1';h.state.mock.handoffs=[{handoff_id:'h1',scope:'conversation',status:'WAITING'}];h.state.status='human_waiting';h.render();
 assert(h.doc.getElementById('emotion-status').textContent.includes('negative'));assert(h.chat.textContent.includes('I am disappointed'));assert(h.chat.querySelectorAll('button').some(b=>/模拟人工受理/.test(b.textContent)));
 h.state.emotion.sentiment='neutral';h.render();assert(h.chat.textContent.includes('当前处于模拟人工会话，自动业务保持暂停。'));const toggle=h.doc.getElementById('show-tasks');toggle.checked=false;await toggle.fire('change');assert(h.doc.getElementById('emotion-status').hidden);assert(!h.chat.textContent.includes('I am disappointed'));assert(!h.chat.querySelectorAll('button').some(b=>/模拟人工受理/.test(b.textContent)));assert(h.chat.textContent.includes('排队中，尚未受理'));
 h.state.mock.handoffs[0].status='COMPLETED';h.render();assert(h.chat.querySelectorAll('button').some(b=>b.textContent==='返回智能助手'));
});
