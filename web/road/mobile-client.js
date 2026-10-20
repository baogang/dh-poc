import {createChatRenderer} from './chat-ui.js';
import {deviceTemplate,mobileTemplate} from './mobile-template.js';
import {locationText} from './location-data.js';

// Presentation adapter only. The host owns the session, requests and event stream.
export function createMobileClient(document,actions){
  let dialog,root,chat,opener,current,view,toastTimer,loginTarget=false,lastSession,selectedLocation=null;
  const $=id=>root.getElementById(id);
  const link=href=>{const n=document.createElement('link');n.rel='stylesheet';n.href=href;return n;};
  const toast=text=>{const n=$('toast');n.textContent=text;n.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>n.classList.remove('show'),4200);};
  function overlay(id,open){
    const n=$(id);n.classList.toggle(id==='quickSheet'?'on':'open',open);n.setAttribute('aria-hidden',String(!open));n.inert=!open;
    const covered=$('chatScreen').classList.contains('open')||$('loginScreen').classList.contains('open')||$('quickSheet').classList.contains('on');
    for(const item of root.querySelectorAll('.home-content,.mobile-bottom-nav,#openChat'))item.inert=covered;
  }
  function page(tab){
    // The reference's Routes tab retains the Explore map.
    const visible=tab==='reports'?'home':tab;
    for(const n of root.querySelectorAll('[data-home-view]')){const active=n.dataset.homeView===visible;n.classList.toggle('active',active);n.inert=!active;}
    for(const n of root.querySelectorAll('[data-home-tab]')){const active=n.dataset.homeTab===tab;n.classList.toggle('active',active);n.setAttribute('aria-current',active?'page':'false');}
    $('openChat').hidden=visible!=='home';
    root.querySelector('.home-content').scrollTop=0;
  }
  function showLogin(){overlay('quickSheet',false);overlay('loginScreen',true);$('loginUsername').focus({preventScroll:true});}
  function openChat(){
    if(!current?.user){loginTarget=true;overlay('quickSheet',true);$('quickSheetGo').focus({preventScroll:true});return;}
    overlay('chatScreen',true);render();$('message').focus({preventScroll:true});
  }
  function ask(text){openChat();$('message').value=text;}
  function init(){
    if(dialog)return;
    if(!customElements.get('poc-mobile-device'))customElements.define('poc-mobile-device',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'}).innerHTML=deviceTemplate;}});
    dialog=document.createElement('dialog');dialog.className='mobile-client-dialog';dialog.setAttribute('aria-label','BALADY mobile experience');
    const host=document.createElement('div');dialog.append(host);root=host.attachShadow({mode:'open'});root.append(link('/style.css'),link('/mobile-ui.css'),link('/mobile-adapter.css'));
    const template=document.createElement('template');template.innerHTML=mobileTemplate;root.append(template.content.cloneNode(true));document.body.append(dialog);
    root.querySelector('poc-mobile-device').shadowRoot.querySelector('.time').textContent=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(new Date());
    const copy={nationalIdLabel:'Username',passwordLabel:'Password',forgotPassword:'Forgot password?',loginButton:'Login',quickAccess:'Quick access',nafath:'Login via Nafath',noAccount:"Don't have an account?",createAccount:'Create account',beneficiaryName:'Guest',quickLoginTitle:'You cannot log in using quick access',quickLoginBody:'Municipal services require logging in via Nafath or using your Balady account',quickLoginNo:'Not now',quickLoginGo:'Login',title:'Balady Assistant',digitalHuman:'Digital Human'};
    for(const n of root.querySelectorAll('[data-i18n]'))n.textContent=copy[n.dataset.i18n]??'';
    $('credGreet').textContent='Good morning';$('topbarLive').textContent='Online';$('message').placeholder='Type your question...';$('message').setAttribute('aria-label','Message');
    const locationButton=document.createElement('button');locationButton.type='button';locationButton.id='mobileLocation';locationButton.className='icon-btn';locationButton.setAttribute('aria-label','Choose issue location');locationButton.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';$('message').before(locationButton);
    const locationChip=document.createElement('div');locationChip.id='mobileLocationPreview';locationChip.className='mobile-location-preview';locationChip.hidden=true;const locationCopy=document.createElement('span');locationCopy.id='mobileLocationCopy';const clearLocation=document.createElement('button');clearLocation.type='button';clearLocation.textContent='×';clearLocation.setAttribute('aria-label','Remove location');clearLocation.addEventListener('click',()=>{selectedLocation=null;render();});locationChip.append(locationCopy,clearLocation);$('composer').before(locationChip);
    locationButton.addEventListener('click',async()=>{const owner=current?.id,point=await actions.pickLocation?.({locale:view?.locale??'en',initial:selectedLocation});if(point&&current?.id===owner){selectedLocation=point;render();$('message').focus({preventScroll:true});}});
    $('loginForm').noValidate=false;$('loginUsername').required=true;$('loginPassword').required=true;
    $('loginPassword').autocomplete='current-password';
    const hint=document.createElement('p');hint.className='mobile-demo-hint';hint.textContent='POC simulation · demo / demo or sara / demo';$('loginError').before(hint);
    const day=document.createElement('div');day.className='day';day.textContent='Today';
    const welcome=document.createElement('div');welcome.className='row';
    const avatar=document.createElement('img');avatar.className='face';avatar.src='/mobile-reference/ai.jpg';avatar.alt='';
    const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent='Hello. Welcome to Balady services. How can I help you?';
    const time=document.createElement('time');time.textContent=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(new Date());bubble.append(time);welcome.append(avatar,bubble);
    const messages=document.createElement('div');messages.className='native-messages';$('chat').append(day,welcome,messages);
    chat=createChatRenderer(document,messages,{...actions,example:text=>{$('message').value=text;$('message').focus();}},{scrollContainer:$('chat')});
    for(const n of root.querySelectorAll('.mobile-dismiss'))n.addEventListener('click',close);
    dialog.addEventListener('close',()=>opener?.focus({preventScroll:true}));
    for(const n of root.querySelectorAll('[data-home-tab]'))n.addEventListener('click',()=>page(n.dataset.homeTab));
    $('openChat').addEventListener('click',openChat);root.querySelector('[data-open-app-chat]').addEventListener('click',openChat);
    $('closeChat').addEventListener('click',()=>overlay('chatScreen',false));
    $('quickSheetClose').addEventListener('click',()=>overlay('quickSheet',false));$('quickSheetNo').addEventListener('click',()=>overlay('quickSheet',false));$('quickSheetGo').addEventListener('click',showLogin);
    $('loginBack').addEventListener('click',()=>overlay('loginScreen',false));$('credQuick').addEventListener('click',()=>overlay('loginScreen',false));
    $('credEye').addEventListener('click',()=>{const show=$('loginPassword').type==='password';$('loginPassword').type=show?'text':'password';$('credEye').classList.toggle('off',!show);$('credEye').setAttribute('aria-label',show?'Hide password':'Show password');});
    $('credForgot').addEventListener('click',()=>toast('Use the simulated POC account: demo / demo or sara / demo.'));
    $('loginForm').addEventListener('submit',async e=>{
      e.preventDefault();if(view?.busy)return;
      await actions.login({username:$('loginUsername').value.trim(),password:$('loginPassword').value});
      if(current?.user){overlay('loginScreen',false);if(loginTarget)openChat();}else $('loginError').textContent=view?.error??'Login failed. Check the demo account and try again.';
    });
    $('composer').addEventListener('submit',async e=>{
      e.preventDefault();if(view?.busy||current?.running)return;
      const message=$('message').value.trim(),location=selectedLocation;if(!message&&!location)return;$('message').value='';selectedLocation=null;
      await actions.action('/api/chat',{message,...(location?{location,location_locale:view?.locale??'en'}:{})});if(view?.error){if(!$('message').value)$('message').value=message;if(location&&!selectedLocation)selectedLocation=location;render();}
    });
    $('micBtn').addEventListener('click',()=>toast('Voice input is not connected to this POC. Please type your question.'));
    $('uploadBtn').addEventListener('click',()=>{
      const input=messages.querySelector('input[type="file"]');
      if(input&&!input.disabled){input.focus();input.click();}else toast('Describe your request first. Add an attachment when the assistant asks for a file.');
    });
    const stop=document.createElement('button');stop.id='mobileStop';stop.type='button';stop.textContent='Stop';stop.className='mobile-stop';stop.addEventListener('click',()=>actions.action('/api/cancel',{}));$('chatScreen').append(stop);
    root.querySelector('.apps-search-box').addEventListener('click',openChat);
    for(const n of root.querySelectorAll('.most-used-services button,.all-apps-grid button,.apps-section-head button,.add-app'))n.addEventListener('click',()=>toast('This entry is a visual preview. Ask Balady Assistant about the services available in the POC.'));
    root.querySelector('.apps-banner-card').setAttribute('aria-label','Compliance map preview');
    root.querySelector('.contribute-card').addEventListener('click',()=>ask('How can I share a suggestion about municipal services?'));
    $('homeSearch').addEventListener('click',()=>toast('Navigation is a visual preview; live directions are not connected.'));
    for(const n of root.querySelectorAll('.quick-actions button'))n.addEventListener('click',()=>n.textContent.includes('Snap')?ask('I would like to report a municipal problem.'):toast('This shortcut is a visual preview. Municipal requests are handled by Balady Assistant.'));
    for(const n of root.querySelectorAll('.profile-menu-group button:not(#profileSignOut)'))n.addEventListener('click',()=>{
      const label=n.querySelector('b').textContent;
      if(label==='Account'){if(current?.user)toast('Signed in to the shared POC session as '+(current.user.name??current.user.username??'demo')+'.');else {loginTarget=false;showLogin();}}
      else if(label==='Help Center'){openChat();}
      else toast(label==='About the application'?'BALADY mobile simulation · connected to the current POC backend.':label==='Privacy and Terms of Use'?'POC simulation: use demo data only. No official Balady account is required.':'Settings are a visual preview. Use the main Chatbot language selector for conversation controls.');
    });
    $('profileSignOut').title='Start a new shared POC session';$('profileSignOut').addEventListener('click',async()=>{if(view?.busy)return;await actions.newSession();if(view?.error){toast(view.error);return;}overlay('chatScreen',false);overlay('loginScreen',false);page('home');toast('A new shared POC session has started.');});
    for(const id of ['chatScreen','loginScreen','quickSheet'])overlay(id,false);page('home');render();
  }
  function render(){
    if(!root||!current)return;
    if(lastSession&&lastSession!==current.id){$('message').value='';selectedLocation=null;overlay('loginScreen',false);overlay('quickSheet',false);loginTarget=false;}
    lastSession=current.id;
    const busy=view?.busy||current.running;
    $('sendBtn').disabled=!!busy;$('loginSubmit').disabled=!!view?.busy;$('profileSignOut').disabled=!!view?.busy;
    $('mobileLocation').disabled=!!busy;$('mobileLocationPreview').hidden=!selectedLocation;$('mobileLocationCopy').textContent=selectedLocation?locationText(selectedLocation,view?.locale??'en'):'';
    $('topbarLive').textContent=view?.connecting?'Connecting':view?.error?'Reconnect':current.running?'Working':'Online';$('topbarLive').classList.toggle('off',!!view?.error);
    $('mobileStop').hidden=!current.running&&!current.pendingInput&&!current.pendingOperation;
    const name=current.user?.name??current.user?.username??(current.user?'Beneficiary':'Guest');
    root.querySelector('[data-i18n="beneficiaryName"]').textContent=name;root.querySelector('.profile-head-avatar b').textContent=name.slice(0,1).toUpperCase();
    chat.render(current,{...view,showTasks:true});
  }
  function close(){dialog?.close();}
  return {open(button){opener=button;init();dialog.showModal();render();root.querySelector('[data-home-tab].active')?.focus({preventScroll:true});},close,update(state,options){current=state;view=options;if(dialog?.open)render();}};
}
