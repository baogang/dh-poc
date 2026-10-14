const special=new Set(['plan','input_request','operation_confirmation']);
const taskLabels={pending:'待执行',running:'执行中',waiting:'等待你确认',completed:'已完成',failed:'执行失败'};
const operationLabels={create_ticket:'创建工单',query_tickets:'查询工单',close_ticket:'关闭工单',complain_ticket:'提交投诉',handoff_to_human:'转交人工'};

export function conversationItems(s){
  const rows=[];
  const inputEvents=s.events.filter(e=>e.type==='input_required');
  for(const m of s.messages){
    if(special.has(m.kind)||m.kind==='question'&&inputEvents.some(e=>e.input.question===m.text))continue;
    rows.push({id:'message:'+m.id,kind:'message',time:m.time,message:m});
  }
  for(const p of s.plans){const m=s.messages.find(m=>m.kind==='plan'&&m.plan_id===p.id);rows.push({id:'plan:'+p.id,kind:'plan',time:m?.time??p.created_at,plan:p,text:m?.text??p.summary+'\n\n我会按这些步骤处理。请在这里确认是否继续。',active:s.activePlanId===p.id,loggedIn:!!s.user,outcome:s.activePlanId===p.id?s.status:p.status});}
  const inputs=inputEvents.map(e=>e.input);if(s.pendingInput&&!inputs.some(x=>x.id===s.pendingInput.id))inputs.push(s.pendingInput);
  for(const x of inputs){const m=s.messages.find(m=>m.input_id===x.id&&m.role==='assistant');const event=inputEvents.find(e=>e.input.id===x.id);rows.push({id:'input:'+x.id,kind:'input',time:m?.time??event?.time??s.messages.at(-1)?.time,input:x,active:s.pendingInput?.id===x.id,received:s.events.some(e=>e.type==='input_received'&&e.input_id===x.id),loggedIn:!!s.user});}
  const operations=s.events.filter(e=>e.type==='confirmation_required').map(e=>({proposal:e.proposal,time:e.time}));if(s.pendingOperation&&!operations.some(x=>x.proposal.id===s.pendingOperation.id))operations.push({proposal:s.pendingOperation,time:s.messages.at(-1)?.time});
  for(const {proposal:o,time}of operations){const m=s.messages.find(m=>m.kind==='operation_confirmation'&&m.proposal_id===o.id);rows.push({id:'operation:'+o.id,kind:'operation',time:m?.time??time,proposal:o,text:m?.text??'提交内容已准备好。请核对信息，再确认提交；确认前不会执行。',active:s.pendingOperation?.id===o.id,approved:s.events.some(e=>e.type==='operation_approved'&&e.proposal_id===o.id)});}
  for(const r of s.receipts)rows.push({id:'receipt:'+r.id,kind:'receipt',time:r.time,receipt:r});
  for(const e of s.events.filter(e=>e.type==='human_status'))rows.push({id:'human:'+e.seq,kind:'human',time:e.time,handoff:e.handoff});
  return rows.sort((a,b)=>(a.time??'').localeCompare(b.time??''));
}

export function progressText(s){
  const start=s.events.findLastIndex(e=>e.type==='turn_started');const current=s.events.slice(Math.max(0,start));
  const api=[...current].reverse().find(e=>e.type==='api_start');
  if(api)return {login:'正在验证模拟账号…',query_tickets:'正在查询你的工单记录…',create_ticket:'正在提交已确认的工单…',close_ticket:'正在关闭已确认的工单…',complain_ticket:'正在提交已确认的投诉…',handoff_to_human:'正在转交已确认的人工请求…'}[api.call.operation]??'正在处理你的请求…';
  if(current.some(e=>e.type==='faq_miss'))return '正在整理处理步骤，稍后会在这里说明下一步…';
  if(current[0]?.route==='resume')return '正在继续已确认的计划，结果会显示在这里…';
  return '收到，正在查看是否有能直接回答你的问答内容…';
}

export function createChatRenderer(document,container,actions){
  const cached=new Map();
  const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
  const button=(text,fn,busy=false)=>{const n=el('button',text);n.type='button';n.disabled=busy;n.addEventListener('click',fn);return n;};
  const field=(form,label,name,type='text')=>{const l=el('label',label),i=el(type==='textarea'?'textarea':'input');i.name=name;if(type!=='textarea')i.type=type;i.required=true;i.maxLength=2000;l.append(i);form.append(l);return i;};
  function loginForm(continuation,busy){
    const form=el('form',undefined,'inline-form login-form');form.dataset.formKey='login:'+(continuation?.id??'welcome');
    const l=el('label','模拟账号'),select=el('select');select.name='username';for(const [value,title]of[['demo','demo · 有登记地址'],['demo-no-address','demo-no-address · 无登记地址'],['demo-other','demo-other · 另一用户']]){const o=el('option',title);o.value=value;select.append(o);}select.value='demo';l.append(select);form.append(l);field(form,'模拟密码','password','password').value='demo';
    const b=el('button',continuation?'登录并继续处理':'登录模拟账号');b.disabled=busy;form.append(b,el('p','仅使用 demo 等模拟账号，不要输入真实密码或个人资料。','hint'));
    form.addEventListener('submit',e=>{e.preventDefault();actions.login(Object.fromEntries(new FormData(form)),continuation);});return form;
  }
  function payload(parent,parameters){
    const dl=el('dl',undefined,'payload');const add=(label,value)=>{if(value===undefined||value===null||value==='')return;dl.append(el('dt',label),el('dd',String(value)));};
    if(parameters.address)add('工单地址',[parameters.address.city,parameters.address.street].filter(Boolean).join(', '));
    add('问题描述',parameters.description);add('工单编号',parameters.ticket_id);add('原因',parameters.reason);add('交接摘要',parameters.conversation_summary);parent.append(dl);
  }
  function build(item,{busy,showTasks}){
    const n=el('article',undefined,item.kind==='message'?'bubble '+item.message.role:'bubble assistant '+item.kind+'-card');n.dataset.chatId=item.id;n.dir='auto';
    if(item.kind==='message'){
      let text=item.message.text;
      if(item.message.kind==='input'){try{const value=item.message.value??JSON.parse(text);if(value.ticket_id)text=`已选择工单 ${value.ticket_id}；${value.unresolved?'问题仍未解决':'问题已解决'}。`;else if(value.city&&value.street)text=`工单地址：${value.city}, ${value.street}`;else if(value.text)text=value.text;}catch{}}
      n.append(el('div',text,'message-text'));if(item.message.source)n.append(el('small','问答库来源：'+item.message.source.id));
    }else if(item.kind==='welcome'){
      n.append(el('strong','你好，我是工单助手。'),el('p','你可以描述道路坑洞，查询历史工单、投诉、关闭工单或请求转人工。我会在聊天中展示下一步，涉及提交时先请你确认。'));
      const examples=el('div',undefined,'examples');for(const [label,text]of[['新坑洞报单','There is a big pothole in the road in front of my house'],['历史工单跟进','The school pothole I reported is still unresolved. Please help me follow up.'],['试问答库','Is the municipal fees invoice the same as the Civil Defense fees invoice?']])examples.append(button(label,()=>actions.example(text),busy));n.append(examples);
      if(!item.loggedIn){const d=el('details',undefined,'welcome-login');d.dataset.key='welcome-login';d.append(el('summary','模拟登录 · 办理个人工单时需要'),loginForm(null,busy));n.append(d);}
    }else if(item.kind==='plan'){
      const p=item.plan,complete=p.steps.filter(x=>x.status==='completed').length;
      n.append(el('div','任务计划 · 版本 '+p.version,'card-caption'),el('strong',p.goal,'plan-goal'),el('p',item.text,'message-text'));
      const d=el('details',undefined,'task-list');d.dataset.key='tasks:'+p.id;d.open=true;d.hidden=!showTasks;d.append(el('summary',`任务列表 · ${complete}/${p.steps.length} 已完成`));const list=el('ol',undefined,'tasks');
      for(const step of p.steps){const row=el('li',undefined,'task '+step.status),mark=el('span',step.status==='completed'?'✓':step.status==='running'?'◌':step.status==='waiting'?'⏸':'○','task-mark');const title=el(step.status==='completed'?'s':'span',step.title,'task-title');row.append(mark,title,el('small',taskLabels[step.status]??step.status,'task-state'));list.append(row);}d.append(list);n.append(d);
      if(!showTasks)n.append(el('small',`任务列表已隐藏 · ${complete}/${p.steps.length} 已完成`));
      if(item.active&&p.status==='review'){
        if(!item.loggedIn&&p.steps.some(x=>!['input','respond'].includes(x.capability))){n.append(el('p','处理个人工单前，需要先确认模拟账号。登录后就会按这份计划继续。','next-action'),loginForm({kind:'plan',id:p.id},busy));}
        else n.append(el('p','请确认是否按这个计划继续；提交操作还会单独请你核对。','next-action'),button('按计划继续',()=>actions.action('/api/approve-plan',{plan_id:p.id}),busy));
        n.append(button('取消这个任务',()=>actions.action('/api/cancel',{}),busy));
      }else n.append(el('small',p.status==='completed'?'这份计划已处理完成。':p.status==='superseded'?'已按新意图调整计划，这份计划停止执行。':p.status==='paused'?'这份计划已暂停。':['blocked','failed','interrupted'].includes(item.outcome)?'这份计划还没有完成，可以调整任务或重试。':'我正在按这份计划处理。'));
    }else if(item.kind==='operation'){
      const o=item.proposal;n.append(el('div','请确认 · '+(operationLabels[o.operation]??'提交操作'),'card-caption'),el('p',item.text));payload(n,o.parameters);
      if(item.active)n.append(button('确认提交',()=>actions.action('/api/approve-operation',{proposal_id:o.id}),busy),button('取消这个任务',()=>actions.action('/api/cancel',{}),busy));
      else n.append(el('small',item.approved?'你已确认以上内容。':'此确认已失效，以上内容不会继续提交。'));
    }else if(item.kind==='input'){
      const x=item.input;n.append(el('p',x.question,'message-text'));
      if(!item.active){n.append(el('small',item.received?'已收到你补充的信息。':'此信息请求已结束。'));return n;}
      if(x.kind==='login'){if(!item.loggedIn)n.append(loginForm({kind:'input',id:x.id},busy));else n.append(button('已登录，继续',()=>actions.action('/api/input',{input_id:x.id,value:{}}),busy));return n;}
      const f=el('form',undefined,'inline-form');f.dataset.formKey='input:'+x.id;
      if(x.kind==='address'){field(f,'城市','city');field(f,'街道','street');}
      else if(x.kind==='ticket'){
        const l=el('label','选择对应工单'),select=el('select');select.name='ticket_id';select.required=true;const placeholder=el('option','请选择工单');placeholder.value='';select.append(placeholder);for(const t of x.candidates){const opt=el('option',`${t.ticket_id} · ${t.status} · ${t.description} · ${t.address.city}, ${t.address.street}`);opt.value=t.ticket_id;select.append(opt);}select.value='';l.append(select);f.append(l);
        const match=el('label','确认这是我要跟进的工单','check'),checkbox=el('input');checkbox.type='checkbox';checkbox.name='matched';checkbox.required=true;match.prepend(checkbox);f.append(match,el('p','这个问题现在是否仍未解决？','input-label'));
        for(const [value,label]of[['yes','是，仍未解决'],['no','否，已经解决']]){const l=el('label',label,'check'),radio=el('input');radio.type='radio';radio.name='unresolved';radio.value=value;radio.required=true;l.prepend(radio);f.append(l);}
      }else field(f,'补充信息','text','textarea');
      const b=el('button','提交信息并继续');b.disabled=busy;f.append(b);f.addEventListener('submit',e=>{e.preventDefault();if(busy)return;const fd=new FormData(f),value=Object.fromEntries(fd);if(x.kind==='ticket'){if(!['yes','no'].includes(fd.get('unresolved')))return;value.matched=fd.has('matched');value.unresolved=fd.get('unresolved')==='yes';}actions.action('/api/input',{input_id:x.id,value});});n.append(f);
    }else if(item.kind==='receipt'){
      const r=item.receipt,v=r.result;let text='已完成'+(operationLabels[r.operation]??'当前操作')+'。';
      if(v.tickets)text=`已查到 ${v.tickets.length} 张属于你的工单。`;
      if(v.ticket)text=`${r.operation==='close_ticket'?'已关闭':'已创建'}工单 ${v.ticket.ticket_id} · ${v.ticket.status}`;
      if(v.complaint)text=`投诉已提交：${v.complaint.complaint_id} · ${v.complaint.status}`;
      if(v.handoff)text=`已转交人工队列：${v.handoff.ticket_id} · ${v.handoff.status}，正在等待人工受理。`;
      n.append(el('p',text,'receipt-text'));
    }else if(item.kind==='human')n.append(el('p',({ACCEPTED:'人工已受理。',ESCALATED:'人工处理已升级。',COMPLETED:'人工处理已完成；这不表示道路已经修复。'})[item.handoff.status]??'人工状态：'+item.handoff.status));
    else if(item.kind==='retry'){n.append(el('p','本轮还没有完成。你可以重试这份计划，或告诉我你想怎么调整。'),button('重试这份计划',()=>actions.action('/api/retry',{}),busy),button('取消这个任务',()=>actions.action('/api/cancel',{}),busy));}
    else if(item.kind==='working'){n.setAttribute('role','status');n.append(el('span','◌','working-icon'),el('span',item.text));}
    else if(item.kind==='error'){n.setAttribute('role','alert');n.append(el('p',item.text),button('重新连接',()=>actions.reconnect(),busy));}
    return n;
  }
  function remember(node){
    const details=[...node.querySelectorAll('details[data-key]')].map(d=>[d.dataset.key,d.open]);const values=[];
    for(const form of node.querySelectorAll('form[data-form-key]'))for(const f of form.querySelectorAll('input,select,textarea'))values.push({form:form.dataset.formKey,name:f.name,type:f.type,value:f.value,checked:f.checked});
    const focus=document.activeElement;return {details,values,focus:focus&&[...node.querySelectorAll('input,select,textarea')].includes(focus)?{name:focus.name,type:focus.type,value:focus.value,form:focus.closest('form')?.dataset.formKey,start:focus.selectionStart,end:focus.selectionEnd}:null};
  }
  function restore(node,memory){
    for(const d of node.querySelectorAll('details[data-key]')){const entry=memory.details.find(x=>x[0]===d.dataset.key);if(entry)d.open=entry[1];}
    for(const form of node.querySelectorAll('form[data-form-key]'))for(const f of form.querySelectorAll('input,select,textarea')){const old=memory.values.find(v=>v.form===form.dataset.formKey&&v.name===f.name&&(!(f.type==='radio')||v.value===f.value));if(old){if(f.type==='radio'||f.type==='checkbox')f.checked=old.checked;else f.value=old.value;}if(memory.focus?.form===form.dataset.formKey&&memory.focus.name===f.name&&(f.type!=='radio'||f.value===memory.focus.value)){f.focus({preventScroll:true});if(typeof memory.focus.start==='number'&&f.setSelectionRange&&f.type!=='select-one')f.setSelectionRange(memory.focus.start,memory.focus.end);}}
  }
  return {render(state,{showTasks=true,busy=false,pendingMessage,error,connecting=false}={}){
    const atBottom=container.scrollHeight-container.scrollTop-container.clientHeight<70,scroll=container.scrollTop;
    const rows=[{id:'welcome',kind:'welcome',loggedIn:!!state.user},...conversationItems(state)];
    if(pendingMessage)rows.push({id:'optimistic-user',kind:'message',message:{role:'user',text:pendingMessage}});
    const plan=state.plans.find(p=>p.id===state.activePlanId);if(!state.running&&plan?.approved&&['failed','blocked','interrupted'].includes(state.status))rows.push({id:'retry:'+plan.id,kind:'retry'});
    if(state.running||busy||connecting)rows.push({id:'working',kind:'working',text:connecting?'正在连接工单助手…':state.running?progressText(state):'收到，正在发送你的请求…'});
    if(error)rows.push({id:'error',kind:'error',text:error});
    const keep=new Set();let cursor=container.firstChild;
    for(const item of rows){keep.add(item.id);const interactive=['welcome','plan','input','operation','error','retry'].includes(item.kind);const signature=JSON.stringify([item,interactive?busy||state.running:false,item.kind==='plan'?showTasks:null]);let old=cached.get(item.id),node,memory;
      if(old?.signature===signature)node=old.node;
      else{memory=old?remember(old.node):null;node=build(item,{busy:busy||state.running,showTasks});if(old?.node===cursor)cursor=old.node.nextSibling;old?.node.remove();cached.set(item.id,{node,signature});}
      if(node!==cursor)container.insertBefore(node,cursor);else cursor=node.nextSibling;
      if(memory)restore(node,memory);
    }
    for(const [id,item]of cached)if(!keep.has(id)){item.node.remove();cached.delete(id);}
    if(atBottom)container.scrollTop=container.scrollHeight;else container.scrollTop=scroll;
  }};
}
