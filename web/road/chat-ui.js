import {translator} from './i18n.js';
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
  for(const p of s.plans){const m=s.messages.find(m=>m.kind==='plan'&&m.plan_id===p.id);rows.push({id:'plan:'+p.id,kind:'plan',time:m?.time??p.created_at,plan:p,text:m?.text??p.summary,active:s.activePlanId===p.id,loggedIn:!!s.user,outcome:s.activePlanId===p.id?s.status:p.status});}
  const inputs=inputEvents.map(e=>e.input);if(s.pendingInput&&!inputs.some(x=>x.id===s.pendingInput.id))inputs.push(s.pendingInput);
  for(const x of inputs){const m=s.messages.find(m=>m.input_id===x.id&&m.role==='assistant');const event=inputEvents.find(e=>e.input.id===x.id);rows.push({id:'input:'+x.id,kind:'input',time:m?.time??event?.time??s.messages.at(-1)?.time,input:x,active:s.pendingInput?.id===x.id,received:s.events.some(e=>e.type==='input_received'&&e.input_id===x.id),loggedIn:!!s.user});}
  const operations=s.events.filter(e=>e.type==='confirmation_required').map(e=>({proposal:e.proposal,time:e.time}));if(s.pendingOperation&&!operations.some(x=>x.proposal.id===s.pendingOperation.id))operations.push({proposal:s.pendingOperation,time:s.messages.at(-1)?.time});
  for(const {proposal:o,time}of operations){const m=s.messages.find(m=>m.kind==='operation_confirmation'&&m.proposal_id===o.id);rows.push({id:'operation:'+o.id,kind:'operation',time:m?.time??time,proposal:o,text:m?.text,active:s.pendingOperation?.id===o.id,approved:s.events.some(e=>e.type==='operation_approved'&&e.proposal_id===o.id)});}
  for(const r of s.receipts)rows.push({id:'receipt:'+r.id,kind:'receipt',time:r.time,receipt:r});
  for(const h of s.mock.handoffs.filter(h=>h.scope==='conversation'))rows.push({id:'human-desk:'+h.handoff_id,kind:'human_desk',time:h.created_at,handoff:h,active:s.activeHandoffId===h.handoff_id});
  for(const e of s.events.filter(e=>e.type==='human_status'&&e.handoff.scope!=='conversation'))rows.push({id:'human:'+e.seq,kind:'human',time:e.time,handoff:e.handoff});
  return rows.sort((a,b)=>(a.time??'').localeCompare(b.time??''));
}

export function progressText(s,locale='zh'){
  const t=translator(locale);
  const start=s.events.findLastIndex(e=>e.type==='turn_started');const current=s.events.slice(Math.max(0,start));
  if(current.some(e=>e.type==='emotion_started')&&!current.some(e=>e.type==='emotion_assessed'||e.type==='emotion_error'))return t('问答库未直接命中，正在识别你当前的情绪…');
  const api=[...current].reverse().find(e=>e.type==='api_start');
  if(api)return {login:t('正在验证模拟账号…'),query_tickets:t('正在查询你的工单记录…'),create_ticket:t('正在提交已确认的工单…'),close_ticket:t('正在关闭已确认的工单…'),complain_ticket:t('正在提交已确认的投诉…'),handoff_to_human:t('正在转交已确认的人工请求…')}[api.call.operation]??t('正在处理你的请求…');
  if(current.some(e=>e.type==='faq_miss'))return t('正在整理处理步骤，稍后会在这里说明下一步…');
  if(['resume','crm_resume'].includes(current[0]?.route))return t('正在继续已确认的计划，结果会显示在这里…');
  return t('收到，正在查看是否有能直接回答你的问答内容…');
}

export function createChatRenderer(document,container,actions){
  const cached=new Map();let t=translator(),uiLocale='zh';
  const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
  const button=(text,fn,busy=false)=>{const n=el('button',text);n.type='button';n.disabled=busy;n.addEventListener('click',fn);return n;};
  const field=(form,label,name,type='text')=>{const l=el('label',label),i=el(type==='textarea'?'textarea':'input');i.name=name;if(type!=='textarea')i.type=type;i.required=true;i.maxLength=2000;l.append(i);form.append(l);return i;};
  const name=service=>service?.title?.[uiLocale]??service?.title?.en??'';
  function officialLink(parent,url){if(!/^https:\/\/(?:www\.)?balady\.gov\.sa(?:\/|$)/.test(url??''))return;const a=el('a',t('访问官方平台'));a.href=url;a.target='_blank';a.rel='noopener noreferrer';parent.append(a);}
  function serviceCard(parent,service,item,busy){
    const card=el('section',undefined,'service-option');card.append(el('strong',name(service)),el('small',service.department?.[uiLocale]??service.department?.en),el('span',t(['mock_transaction','simulation'].includes(service.mode)?'模拟办理':'仅知识咨询'),'service-mode'),el('p',service.description?.[uiLocale]??service.description?.en));
    if(item.choiceActive!==false)card.append(button(t(item.clarificationId?'选择并回答原问题':'查看此服务'),()=>actions.action('/api/service',{scope:service.id,...(item.clarificationId?{clarification_id:item.clarificationId}:{})}),busy));officialLink(card,service.official_url);parent.append(card);
  }
  function loginForm(continuation,busy){
    const form=el('form',undefined,'inline-form login-form');form.dataset.formKey='login:'+(continuation?.id??'welcome');
    const l=el('label',t('模拟账号')),select=el('select');select.name='username';for(const [value,title]of[['demo','demo · BALADY beneficiary A'],['sara','sara · BALADY beneficiary B']]){const o=el('option',title);o.value=value;select.append(o);}select.value='demo';l.append(select);form.append(l);field(form,t('模拟密码'),'password','password').value='demo';
    const b=el('button',continuation?t('登录并继续处理'):t('登录模拟账号'));b.disabled=busy;form.append(b,el('p',t('仅使用 demo 等模拟账号，不要输入真实密码或个人资料。'),'hint'));
    form.addEventListener('submit',e=>{e.preventDefault();actions.login(Object.fromEntries(new FormData(form)),continuation);});return form;
  }
  function payload(parent,parameters){
    if(parameters.body){parent.append(el('pre',JSON.stringify(parameters,null,2),'crm-payload'));return;}
    const dl=el('dl',undefined,'payload');const add=(label,value)=>{if(value===undefined||value===null||value==='')return;dl.append(el('dt',t(label)),el('dd',String(value)));};
    if(parameters.address)add(t('工单地址'),[parameters.address.city,parameters.address.street].filter(Boolean).join(', '));
    add(t('问题描述'),parameters.description);add(t('工单编号'),parameters.ticket_id);add(t('原因'),parameters.reason);add(t('交接摘要'),parameters.conversation_summary);parent.append(dl);
  }
  function mattersCard(n,item,busy){
    const data=item.matters;
    n.append(el('strong',t('我的事项')));
    if(!item.latestMatters){n.append(el('p',t('请查看下方最新的事项列表。')));return;}
    n.append(el('p',t('仅显示当前模拟账号的事项；所有办理和提醒均为演示。')));
    n.append(button(t('刷新事项'),()=>actions.action('/api/matters',{action:'list'}),busy));
    if(!data)return;
    const unread=data.notifications.filter(x=>!x.read);n.append(el('h3',t('站内提醒 · {count} 条未读',{count:unread.length})));
    if(unread.length)n.append(button(t('全部标为已读'),()=>actions.action('/api/matters',{action:'read',ids:unread.map(x=>x.id).slice(0,200)}),busy));
    const notices=el('ul',undefined,'matter-notices');for(const x of data.notifications.slice(-8).reverse())notices.append(el('li',`${x.read?'✓':'●'} ${x.ticket_id} · ${t(operationLabels[x.kind]??(x.kind==='demo_status'?'模拟状态更新':x.kind))} · ${t('matter.status.'+x.status)}`));n.append(notices);
    n.append(el('h3',t('待继续的草稿')));const drafts=data.drafts.filter(d=>d.status==='draft');
    if(!drafts.length)n.append(el('p',t('暂无待继续的草稿。')));
    for(const d of drafts){const section=el('section',undefined,'matter-item');section.append(el('strong',t('报单草稿 · 版本 {version}',{version:d.version})));payload(section,d.parameters);
      section.append(button(t('恢复并核对'),()=>actions.action('/api/matters',{action:'resume',draft_id:d.id,version:d.version}),busy),button(t('删除草稿'),()=>actions.action('/api/matters',{action:'discard',draft_id:d.id,version:d.version}),busy));n.append(section);}
    n.append(el('h3',t('已提交的事项')));if(!data.tickets.length)n.append(el('p',t('暂无已提交的事项。')));
    for(const ticket of data.tickets){const section=el('section',undefined,'matter-item');section.append(el('strong',`${ticket.ticket_id} · ${t('matter.status.'+ticket.status)}`),el('p',ticket.description));payload(section,{address:ticket.address});
      const d=el('details',undefined,'matter-timeline');d.dataset.key='timeline:'+ticket.ticket_id;d.append(el('summary',t('查看办理时间线')));
      d.append(el('p',t('当前状态来自模拟业务记录；未提供的历史过程不会补写。'),'hint'));const list=el('ol');
      for(const change of data.timeline.filter(x=>x.ticket_id===ticket.ticket_id)){const row=el('li');row.append(el('time',new Date(change.time).toLocaleString(uiLocale==='en'?'en-GB':'zh-CN')),el('p',`${t(operationLabels[change.kind]??(change.kind==='demo_status'?'模拟状态更新':change.kind))} · ${t('matter.status.'+change.status)}`),el('small',t('模拟回执：{id}',{id:change.reference_id})));list.append(row);}
      if(!list.children.length)d.append(el('p',t('这是已有模拟记录，暂无本次演示的状态变化。')));else d.append(list);section.append(d);
      if(item.demoUI&&['OPEN','IN_PROGRESS'].includes(ticket.status))section.append(button(t('演示：推进一个状态'),()=>actions.action('/api/matters',{action:'simulate',ticket_id:ticket.ticket_id}),busy));n.append(section);
    }
  }
  function editForm(n,o,busy){
    if(o.operation.startsWith('crm_')){
      const details=el('details',undefined,'operation-edit');details.dataset.key='edit:'+o.id;details.append(el('summary',t('修改信息')));
      const form=el('form',undefined,'inline-form');form.dataset.formKey='edit:'+o.id;field(form,'CRM parameters (JSON)','text','textarea').value=JSON.stringify(o.parameters,null,2);
      const submit=el('button',t('保存修改并重新核对'));submit.disabled=busy;form.append(submit);form.addEventListener('submit',e=>{e.preventDefault();if(!busy)actions.action('/api/edit-operation',{proposal_id:o.id,value:{text:new FormData(form).get('text')}});});details.append(form);n.append(details);return;
    }
    if(!['create_ticket','complain_ticket'].includes(o.operation))return;
    const details=el('details',undefined,'operation-edit');details.dataset.key='edit:'+o.id;details.append(el('summary',t('修改信息')));
    const form=el('form',undefined,'inline-form');form.dataset.formKey='edit:'+o.id;
    if(o.operation==='create_ticket'){field(form,t('城市'),'city').value=o.parameters.address?.city??'';field(form,t('街道'),'street').value=o.parameters.address?.street??'';field(form,t('问题描述'),'description','textarea').value=o.parameters.description;}
    else field(form,t('原因'),'reason','textarea').value=o.parameters.reason;
    const submit=el('button',t('保存修改并重新核对'));submit.disabled=busy;form.append(submit,el('p',t('修改后旧确认立即失效；不会自动提交。'),'hint'));
    form.addEventListener('submit',e=>{e.preventDefault();if(busy)return;const data=Object.fromEntries(new FormData(form));actions.action('/api/edit-operation',{proposal_id:o.id,value:o.operation==='create_ticket'?{address:{city:data.city,street:data.street},description:data.description}:{reason:data.reason}});});details.append(form);n.append(details);
  }
  function build(item,{busy,showTasks}){
    const n=el('article',undefined,item.kind==='message'?'bubble '+item.message.role:'bubble assistant '+item.kind+'-card');n.dataset.chatId=item.id;n.dir='auto';
    if(item.kind==='message'){
      const m=item.message;let text=m.text;
      if(m.kind==='matters'){mattersCard(n,item,busy);return n;}
      if(m.kind==='matters_login'){if(item.loggedIn)n.append(el('p',t('当前模拟账号已登录。')));else n.append(el('p',t('登录后可查看已保存的草稿、事项与站内提醒。')),loginForm({kind:'matters'},busy));return n;}
      if(m.kind==='draft_saved'){n.append(el('p',t('草稿已保存。下次登录同一模拟账号，在“我的事项”中继续。')));return n;}
      if(m.kind==='draft_restore'){n.append(el('p',t('已恢复报单草稿，请核对下方信息。')));return n;}
      if(m.kind==='reconciled'){n.append(el('p',t(m.reconcile_state==='committed'?'已核实操作成功，已恢复实际回执，不会重复提交。':'已核实模拟系统未提交该操作，可以重新核对后继续。')));return n;}

      if(['matters','matters_login','service_catalog','service_overview','knowledge_clarification'].includes(m.kind)){
        n.append(el('strong',t(m.kind==='knowledge_clarification'?'你指的是哪项服务？':m.kind==='service_overview'?'服务详情':'服务目录')));
        if(m.kind==='knowledge_clarification'){n.append(el('p',t('选择服务后，我会直接回答你刚才的问题，无需重复输入。')));n.append(el('blockquote',m.clarification.question));if(!item.choiceActive){n.append(el('small',t('此服务选择已结束。')));return n;}}
        else n.append(el('p',t('这里显示当前已支持的范围；官方平台链接是查询入口，不代表本助手已接入该服务。')));
        const list=m.kind==='service_overview'?item.catalog.filter(s=>s.id===m.scope):m.kind==='knowledge_clarification'?item.catalog.filter(s=>m.clarification.candidate_scopes.includes(s.id)):item.catalog;
        for(const service of list)serviceCard(n,service,item,busy);
        return n;
      }
      if(['knowledge_missing','knowledge_unavailable'].includes(m.kind)){
        n.append(el('p',t(m.kind==='knowledge_missing'?'已确认服务，但现有问答没有足够依据回答这个问题。':'知识查询暂时不可用，这不代表问答库没有答案。')));
        n.append(button(t('查看服务目录'),()=>actions.action('/api/catalog',{}),busy),button(t('人工帮助'),()=>actions.action('/api/help',{action:'offer'}),busy));if(m.kind==='knowledge_unavailable'&&m.question)n.append(button(t('重试知识查询'),()=>actions.action('/api/chat',{message:m.question}),busy));officialLink(n,item.humanSupport.official_url);return n;
      }
      if(m.kind==='help_offer'){
        n.append(el('strong',t('需要人工帮助吗？')),el('p',t('可以选择模拟人工或继续使用智能助手。未确认的提交已暂停，原来的提交授权已失效。')));
        n.append(el('small',t('当前为人工演示，无真实客服排班或预计接入时间。')));
        if(item.helpActive){
          n.append(el('p',t(item.humanSupport.available?'模拟人工可排队；排队成功不代表已经受理。':'模拟人工暂不可用。你可以继续使用助手或访问官方平台。')));
          n.append(button(t('加入模拟人工队列'),()=>actions.action('/api/help',{action:'queue',request_id:m.request_id}),busy||!item.humanSupport.available),button(t('继续使用智能助手'),()=>actions.action('/api/help',{action:'continue',request_id:m.request_id}),busy));
          n.append(el('small',t('交接将携带最近的对话、当前服务与任务摘要，不会重复办理业务。')));
        }else n.append(el('small',t('此帮助选择已结束。')));
        officialLink(n,item.humanSupport.official_url);return n;
      }
      const notice=m.notice??(m.kind==='login'?'login':m.kind==='decision'?'confirmed':m.kind==='info'?(m.plan_id?'approved':'cancelled'):null);
      if(notice)text=t('notice.'+notice,m.notice_values??{});
      else if(['human_notice','human_reply'].includes(m.kind))text=t(text);
      if(item.message.kind==='input'){try{const value=item.message.value??JSON.parse(text);if(value.ticket_id)text=t('已选择工单 {id}；{state}。',{id:value.ticket_id,state:t(value.unresolved?t('问题仍未解决'):t('问题已解决'))});else if(value.city&&value.street)text=t('工单地址：{city}, {street}',{city:value.city,street:value.street});else if(value.text)text=value.text;}catch{}}
      n.append(el('div',text,'message-text'));
      if(m.knowledge_state){n.append(button(t('查看服务目录'),()=>actions.action('/api/catalog',{}),busy),button(t('人工帮助'),()=>actions.action('/api/help',{action:'offer'}),busy));if(m.knowledge_state==='unavailable')n.append(button(t('重试知识查询'),()=>actions.action('/api/chat',{message:m.question}),busy));officialLink(n,item.humanSupport.official_url);}
      if(item.message.source){
        const source=m.source;n.append(el('small',t('问答库来源：{id}',{id:source.id})));
        if(source.provenance){const d=el('details',undefined,'knowledge-source');d.dataset.key='source:'+m.id;d.append(el('summary',t('查看来源与适用范围')),el('p',name(item.catalog.find(s=>s.id===source.scope))));
          d.append(el('p',t('原始来源：{collection} · {id}',{collection:source.provenance.collection,id:source.id})),el('p',t('采集日期：{date}',{date:source.provenance.captured_at})),el('p',t('POC 问答已做结构清洗，政策内容待官方复核；尚无逐条官方依据。'),'knowledge-warning'),el('p',t('原始问题')),el('blockquote',source.original_question),el('p',source.original_answer,'message-text'));
          officialLink(d,source.provenance.official_url);n.append(d);
        }
      }
      if(item.feedback){
        const f=item.feedback,controls=el('div',undefined,'answer-feedback');controls.setAttribute('role','group');controls.setAttribute('aria-label',t('评价这个回答'));
        for(const [rating,icon,label]of [['satisfied','👍',t('满意')],['unsatisfied','👎',t('不满意')]]){const b=button(icon,()=>actions.rate(m.id,rating),f.pending);b.className='feedback-vote'+(f.rating===rating?' selected':'');b.setAttribute('aria-label',label);b.setAttribute('title',label);b.setAttribute('aria-pressed',String(f.rating===rating));controls.append(b);}
        const status=el('span',f.pending?t('正在保存反馈…'):f.error?t(f.error==='FEEDBACK_CONFLICT'?'评价已更新，请重试。':'反馈未保存，请重试。'):f.rating?t('感谢反馈'):'','feedback-status');status.setAttribute('role','status');controls.append(status);
        if(f.error)controls.append(button(t('重试反馈'),()=>actions.rate(m.id,f.requested)));
        n.append(controls);
      }
    }else if(item.kind==='welcome'){
      n.append(el('strong',t('您好，欢迎使用 BALADY 助理！')),el('p',t('可以办理已接入的 CRM 案件、市政请求、咨询投诉、分类资产、附件与满意度调查。当前为本地仿真；我会补问缺少的参数，并在提交前请你核对。')));
      n.append(el('small',t('办理功能使用模拟数据；其他服务当前仅支持已有知识咨询。')),button(t('查看服务目录'),()=>actions.action('/api/catalog',{}),busy),button(t('人工帮助'),()=>actions.action('/api/help',{action:'offer'}),busy),button(t('我的事项'),()=>actions.action('/api/matters',{action:'list'}),busy));
      const examples=el('div',undefined,'examples');for(const [label,text]of[[t('CRM 案件与详情'),'Show my CRM incidents, then fetch the full details of the first incident.'],[t('资产目录'),'List the main municipal assets, then show details of the first one.'],[t('市政服务分类'),'List main classifications for type CRM in municipality 004, then list sub and special classifications for the first entries.'],[t('咨询与投诉'),'I want to submit a public complaint about a municipal service. What information do you need?']])examples.append(button(label,()=>actions.example(text),busy));n.append(examples);
      if(!item.loggedIn){const d=el('details',undefined,'welcome-login');d.dataset.key='welcome-login';d.append(el('summary',t('模拟登录 · 办理个人工单时需要')),loginForm(null,busy));n.append(d);}
    }else if(item.kind==='plan'){
      const p=item.plan,complete=p.steps.filter(x=>x.status==='completed').length;
      n.append(el('div',t('任务计划 · 版本 {version}',{version:p.version}),'card-caption'),el('strong',p.goal,'plan-goal'),el('p',p.summary,'message-text'),el('p',t(p.status==='review'?'notice.plan':'notice.autoPlan')));
      const d=el('details',undefined,'task-list');d.dataset.key='tasks:'+p.id;d.open=true;d.hidden=!showTasks;d.append(el('summary',t('任务列表 · {done}/{total} 已完成',{done:complete,total:p.steps.length})));const list=el('ol',undefined,'tasks');
      for(const step of p.steps){const row=el('li',undefined,'task '+step.status),mark=el('span',step.status==='completed'?'✓':step.status==='running'?'◌':step.status==='waiting'?'⏸':'○','task-mark');const title=el(step.status==='completed'?'s':'span',step.title,'task-title');row.append(mark,title,el('small',t(step.status==='waiting'&&step.capability==='input'?'等待你补充信息':taskLabels[step.status]??step.status),'task-state'));list.append(row);}d.append(list);n.append(d);
      if(!showTasks)n.append(el('small',t('任务列表已隐藏 · {done}/{total} 已完成',{done:complete,total:p.steps.length})));
      if(item.active&&p.status==='review'){
        if(!item.loggedIn&&p.steps.some(x=>!['input','respond'].includes(x.capability))){n.append(el('p',t('处理个人工单前，需要先确认模拟账号。登录后就会按这份计划继续。'),'next-action'),loginForm({kind:'plan',id:p.id},busy));}
        else n.append(el('p',t('请确认是否按这个计划继续；提交操作还会单独请你核对。'),'next-action'),button(t('按计划继续'),()=>actions.action('/api/approve-plan',{plan_id:p.id}),busy));
        n.append(button(t('取消这个任务'),()=>actions.action('/api/cancel',{}),busy));
      }else n.append(el('small',p.status==='completed'?t('这份计划已处理完成。'):p.status==='superseded'?t('已按新意图调整计划，这份计划停止执行。'):p.status==='paused'?t('这份计划已暂停。'):['blocked','failed','interrupted'].includes(item.outcome)?t('这份计划还没有完成，可以调整任务或重试。'):t('我正在按这份计划处理。')));
    }else if(item.kind==='operation'){
      const o=item.proposal;n.append(el('div',t('请确认 · {operation}',{operation:o.title??t(operationLabels[o.operation]??t('提交操作'))}),'card-caption'),el('p',t(o.confirmation_reason==='high_risk_read'?'notice.highRiskRead':'notice.operation')));payload(n,o.parameters);
      if(item.active){n.append(button(o.operation==='query_tickets'?t('确认查询'):t('确认提交'),()=>actions.action('/api/approve-operation',{proposal_id:o.id}),busy),button(t('取消这个任务'),()=>actions.action('/api/cancel',{}),busy));editForm(n,o,busy);if(o.operation==='create_ticket')n.append(button(t('保存，稍后继续'),()=>actions.action('/api/save-draft',{proposal_id:o.id}),busy));}
      else n.append(el('small',item.approved?t('你已确认以上内容。'):t('此确认已失效，以上内容不会继续提交。')));
    }else if(item.kind==='input'){
      const x=item.input;n.append(el('p',x.question,'message-text'));
      if(!item.active){n.append(el('small',item.received?t('已收到你补充的信息。'):t('此信息请求已结束。')));return n;}
      if(x.kind==='login'){if(!item.loggedIn)n.append(loginForm({kind:'input',id:x.id},busy));else n.append(button(t('已登录，继续'),()=>actions.action('/api/input',{input_id:x.id,value:{}}),busy));return n;}
      const f=el('form',undefined,'inline-form');f.dataset.formKey='input:'+x.id;
      if(x.kind==='address'){field(f,t('城市'),'city');field(f,t('街道'),'street');}
      else if(x.kind==='ticket'){
        const l=el('label',t('选择对应工单')),select=el('select');select.name='ticket_id';select.required=true;const placeholder=el('option',t('请选择工单'));placeholder.value='';select.append(placeholder);for(const t of x.candidates){const opt=el('option',`${t.ticket_id} · ${t.status} · ${t.description} · ${t.address.city}, ${t.address.street}`);opt.value=t.ticket_id;select.append(opt);}select.value='';l.append(select);f.append(l);
        const match=el('label',t('确认这是我要跟进的工单'),'check'),checkbox=el('input');checkbox.type='checkbox';checkbox.name='matched';checkbox.required=true;match.prepend(checkbox);f.append(match,el('p',t('这个问题现在是否仍未解决？'),'input-label'));
        for(const [value,label]of[['yes',t('是，仍未解决')],['no',t('否，已经解决')]]){const l=el('label',label,'check'),radio=el('input');radio.type='radio';radio.name='unresolved';radio.value=value;radio.required=true;l.prepend(radio);f.append(l);}
      }else field(f,t('补充信息'),'text','textarea');
      const b=el('button',t('提交信息并继续'));b.disabled=busy;f.append(b);f.addEventListener('submit',e=>{e.preventDefault();if(busy)return;const fd=new FormData(f),value=Object.fromEntries(fd);if(x.kind==='ticket'){if(!['yes','no'].includes(fd.get('unresolved')))return;value.matched=fd.has('matched');value.unresolved=fd.get('unresolved')==='yes';}actions.action('/api/input',{input_id:x.id,value});});n.append(f);
    }else if(item.kind==='human_desk'){
      const h=item.handoff,labels={CANCELLED:t('已取消人工交接'),WAITING:t('排队中，尚未受理'),ACCEPTED:t('模拟人工已受理'),ESCALATED:t('已升级至模拟主管'),COMPLETED:t('模拟人工处理已结束')};
      n.append(el('div',t('模拟人工接管'),'card-caption'),el('strong',labels[h.status]??h.status));
      if(item.active){
        n.append(el('p',t('当前为人工演示，无真实客服排班或预计接入时间。')));
        if(h.status==='WAITING'){n.append(el('p',t(item.humanSupport.wait_expired?'模拟等待已超时，尚未有人受理。':'尚未有人工受理，你可以随时取消排队并返回助手。')));}
        if(['WAITING','ACCEPTED','ESCALATED'].includes(h.status))n.append(button(t(h.status==='WAITING'?'取消排队并返回助手':'结束人工并返回助手'),()=>actions.action('/api/human',{handoff_id:h.handoff_id,action:'cancel'}),busy));
        const d=el('details',undefined,'handoff-summary');d.dataset.key='handoff-summary:'+h.handoff_id;d.append(el('summary',t('查看交接摘要')),el('pre',h.conversation_summary));n.append(d);officialLink(n,item.humanSupport.official_url);
      }
      if(showTasks){const d=el('details',undefined,'human-progress');d.dataset.key='human:'+h.handoff_id;d.open=true;d.append(el('summary',t('人工处理进度与模拟操作')),el('p',t('会话编号：{id}',{id:h.handoff_id})),el('p',t('排队 → 人工受理 → 可选升级 → 处理完成')));
        if(h.agent_name)d.append(el('p',t('当前客服：{name}',{name:h.agent_name})));
        if(item.active){const call=action=>actions.action('/api/human',{handoff_id:h.handoff_id,action});if(h.status==='WAITING')d.append(button(t('模拟人工受理'),()=>call('accept'),busy||item.humanSupport.wait_expired));if(h.status==='ACCEPTED')d.append(button(t('模拟升级主管'),()=>call('escalate'),busy));if(['ACCEPTED','ESCALATED'].includes(h.status))d.append(button(t('结束模拟人工处理'),()=>call('complete'),busy));}
        n.append(d);
      }
      if(item.active&&h.status==='COMPLETED')n.append(button(t('返回智能助手'),()=>actions.action('/api/human',{handoff_id:h.handoff_id,action:'resume'}),busy));
      n.append(el('small',t('这是模拟人工流程；不会自动修改或关闭你的工单。')));
    }else if(item.kind==='receipt'){
      const r=item.receipt,v=r.result;let text=t('已完成{operation}。',{operation:t(operationLabels[r.operation]??t('当前操作'))});
      if(v.data)text=r.operation+' · '+v.data.responseMessage+'\n'+JSON.stringify(v.data.result??{responseId:v.data.responseId},null,2);
      if(v.tickets)text=t('已查到 {count} 张属于你的工单。',{count:v.tickets.length});
      if(v.ticket)text=t(r.operation==='close_ticket'?t('已关闭工单 {id} · {status}'):t('已创建工单 {id} · {status}'),{id:v.ticket.ticket_id,status:v.ticket.status});
      if(v.complaint)text=t('投诉已提交：{id} · {status}',{id:v.complaint.complaint_id,status:v.complaint.status});
      if(v.handoff)text=t('已转交人工队列：{ticket} · {status}，正在等待人工受理。',{ticket:v.handoff.ticket_id??t('当前会话'),status:v.handoff.status});
      n.append(el('p',text,'receipt-text'));
    }else if(item.kind==='human')n.append(el('p',({ACCEPTED:t('人工已受理。'),ESCALATED:t('人工处理已升级。'),COMPLETED:t('人工处理已完成；这不表示道路已经修复。')})[item.handoff.status]??t('人工状态：{status}',{status:item.handoff.status})));
    else if(item.kind==='retry'){n.append(el('p',t('本轮还没有完成。你可以重试这份计划，或告诉我你想怎么调整。')),button(t('重试这份计划'),()=>actions.action('/api/retry',{}),busy),button(t('取消这个任务'),()=>actions.action('/api/cancel',{}),busy));}
    else if(item.kind==='uncertain'){n.setAttribute('role','alert');n.append(el('strong',t('正在核对提交结果')),el('p',t('尚未确认是否提交成功。请先核对结果，避免重复提交。')),button(t('核对提交结果'),()=>actions.action('/api/reconcile',{}),busy));}
    else if(item.kind==='working'){n.setAttribute('role','status');n.append(el('span','◌','working-icon'),el('span',item.text));}
    else if(item.kind==='error'){n.setAttribute('role','alert');n.append(el('p',item.text),button(t('重新连接'),()=>actions.reconnect(),busy));}
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
  return {render(state,{showTasks=true,busy=false,pendingMessage,error,connecting=false,locale='zh',feedback={enabled:false,items:{}}}={}){
    t=translator(locale);uiLocale=locale;
    const atBottom=container.scrollHeight-container.scrollTop-container.clientHeight<70,scroll=container.scrollTop;
    const rows=[{id:'welcome',kind:'welcome',loggedIn:!!state.user},...conversationItems(state)];
    for(const item of rows){item.loggedIn=!!state.user;item.matters=state.mattersView;item.demoUI=state.demo_ui===true;item.latestMatters=item.message?.id===state.messages.findLast(m=>m.kind==='matters')?.id;item.catalog=state.catalog??[];item.humanSupport=state.human_support??{};item.helpActive=!!state.pendingHelp&&item.message?.request_id===state.pendingHelp.id;item.clarificationId=state.pendingKnowledge?.id;item.choiceActive=item.message?.kind==='knowledge_clarification'?state.pendingKnowledge?.id===item.message.clarification.id:true;}
    if(state.uncertainOperation)rows.push({id:'uncertain:'+state.uncertainOperation.key,kind:'uncertain'});
    if(pendingMessage)rows.push({id:'optimistic-user',kind:'message',message:{role:'user',text:pendingMessage}});
    const plan=state.plans.find(p=>p.id===state.activePlanId);if(!state.running&&plan?.approved&&['failed','blocked','interrupted'].includes(state.status))rows.push({id:'retry:'+plan.id,kind:'retry'});
    if(state.running||busy||connecting)rows.push({id:'working',kind:'working',text:connecting?t('正在连接政务服务助手…'):state.running?progressText(state,locale):t('收到，正在发送你的请求…')});
    if(error)rows.push({id:'error',kind:'error',text:error});
    const keep=new Set();let cursor=container.firstChild;
    for(const item of rows){if(item.kind==='message'&&item.message.role==='assistant'&&item.message.rateable&&feedback.enabled)item.feedback=feedback.items[item.message.id]??{};keep.add(item.id);const interactive=['welcome','plan','input','operation','error','retry','human_desk','uncertain'].includes(item.kind)||['matters','matters_login','service_catalog','service_overview','knowledge_clarification','knowledge_missing','knowledge_unavailable','help_offer'].includes(item.message?.kind)||!!item.message?.knowledge_state;const signature=JSON.stringify([locale,item,interactive?busy||state.running:false,['plan','human_desk'].includes(item.kind)?showTasks:null]);let old=cached.get(item.id),node,memory;
      if(old?.signature===signature)node=old.node;
      else{memory=old?remember(old.node):null;node=build(item,{busy:busy||state.running,showTasks});if(old?.node===cursor)cursor=old.node.nextSibling;old?.node.remove();cached.set(item.id,{node,signature});}
      if(node!==cursor)container.insertBefore(node,cursor);else cursor=node.nextSibling;
      if(memory)restore(node,memory);
    }
    for(const [id,item]of cached)if(!keep.has(id)){item.node.remove();cached.delete(id);}
    if(atBottom)container.scrollTop=container.scrollHeight;else container.scrollTop=scroll;
  }};
}
