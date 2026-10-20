import {normalizeLocation,validMapMessage} from './location-data.js';
export function createMapPicker(document){
  let dialog,frame,pending,opener,options,channel=crypto.randomUUID();
  const copy=locale=>locale==='zh'?['选择问题位置','关闭地图','Google 地图选点']:locale==='ar'?['تحديد موقع المشكلة','إغلاق الخريطة','تحديد الموقع على خرائط Google']:['Choose issue location','Close map','Google Maps location picker'];
  const context=()=>({type:'balady:map-open',channel,locale:options.locale??'en',initial:options.initial??null,required_fields:(options.fields??[]).flatMap(path=>({Address:['address'],StreetName:['street'],DistrictName:['district'],MunicipalityID:['city'],municipalityID:['city']})[path.split('.').at(-1)]??[])});
  function init(){
    dialog=document.createElement('dialog');dialog.className='map-picker-dialog';dialog.setAttribute('aria-labelledby','map-picker-title');
    const header=document.createElement('div');header.className='map-picker-heading';const title=document.createElement('h2');title.id='map-picker-title';const close=document.createElement('button');close.type='button';close.className='secondary';close.textContent='×';close.addEventListener('click',()=>dialog.close());header.append(title,close);
    frame=document.createElement('iframe');frame.setAttribute('allow','geolocation');frame.src='/map-picker.html?channel='+encodeURIComponent(channel)+'&lang='+encodeURIComponent(options.locale??'en');
    frame.addEventListener('load',()=>{if(pending)frame.contentWindow.postMessage(context(),location.origin);});dialog.append(header,frame);document.body.append(dialog);
    dialog.addEventListener('close',()=>{const resolve=pending;pending=null;resolve?.(null);opener?.focus({preventScroll:true});});
    window.addEventListener('message',event=>{if(!pending||!dialog.open||!validMapMessage(event,frame,channel,location.origin))return;let selection;try{selection=normalizeLocation(event.data.selection);}catch{return;}const resolve=pending;pending=null;dialog.close();resolve(selection);});
  }
  return {open(next={}){
    if(pending)return Promise.resolve(null);options=next;opener=document.activeElement?.shadowRoot?.activeElement??document.activeElement;
    if(!dialog)init();const words=copy(options.locale);dialog.querySelector('h2').textContent=words[0];dialog.querySelector('button').setAttribute('aria-label',words[1]);frame.title=words[2];
    return new Promise(resolve=>{pending=resolve;dialog.showModal();frame.contentWindow?.postMessage(context(),location.origin);});
  }};
}
