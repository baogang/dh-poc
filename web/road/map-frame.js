import {normalizeLocation} from './location-data.js';
const $=id=>document.getElementById(id),query=new URLSearchParams(location.search),channel=query.get('channel');
let locale=query.get('lang')??'en',point=null,map,marker,geocoder,config,source='manual',accuracy,automaticAddress=false,searchEpoch=0,mapStatus='loading',authenticationFailed=false;
const copies={
  zh:{hint:'请选择问题发生的位置。当前位置不一定是问题位置。',current:'使用我的当前位置',retry:'重新加载地图',search:'搜索地址或地标',searchButton:'搜索',loading:'正在加载 Google 地图…',manual:'Google 地图尚未配置。仍可使用设备定位或手动填写坐标与地址。',failed:'Google 地图暂时不可用。可重试，或使用设备定位 / 手动输入。',latitude:'纬度',longitude:'经度',address:'问题地址 / 地标',city:'城市',district:'地区 / 社区',street:'街道',lookup:'解析图钉地址',choose:'使用这个问题位置',note:'请核对图钉和地址。选定位置后仍需发送信息、核对工单，不会直接提交投诉。',pick:'点击地图或拖动图钉选择问题位置。',moved:'位置已变更，请核对地址。',device:'已选取设备当前位置。请确认这里就是问题发生地点。',denied:'未获得定位权限。你可以在地图上选点或手动输入。',gpsError:'无法取得当前位置，请在地图选点或手动输入。',gpsBusy:'正在取得设备位置…',invalid:'请填写有效经纬度，并补全要求的地址信息。',searching:'正在查询地址…',notFound:'没有找到地址，请换一个名称，或直接在地图上选点。',addressFailed:'地址解析未成功，已保留所选坐标。请手动核对地址。',accuracy:'设备定位精度约 ±{n} 米。'},
  en:{hint:'Choose the location of the issue. Your current position may be different.',current:'Use my current location',retry:'Reload map',search:'Find an address or landmark',searchButton:'Search',loading:'Loading Google Maps…',manual:'Google Maps is not configured yet. You can still use device location or enter coordinates and an address.',failed:'Google Maps is unavailable. Retry, use device location, or enter coordinates manually.',latitude:'Latitude',longitude:'Longitude',address:'Issue address / landmark',city:'City',district:'District / neighbourhood',street:'Street',lookup:'Find address for pin',choose:'Use this issue location',note:'Check the pin and address. Selecting a location does not send a message or submit a complaint.',pick:'Click the map or drag the pin to choose the issue location.',moved:'Location changed. Please check the address.',device:'Device position selected. Check that this is where the issue occurred.',denied:'Location permission was not granted. Select on the map or enter coordinates.',gpsError:'Unable to get your location. Select on the map or enter coordinates.',gpsBusy:'Getting device location…',invalid:'Enter valid coordinates and complete the requested address fields.',searching:'Looking up the address…',notFound:'No address found. Try another name or select directly on the map.',addressFailed:'Address lookup failed. Your coordinates are retained; check the address manually.',accuracy:'Device location accuracy is approximately ±{n} metres.'},
  ar:{hint:'حدد موقع المشكلة. قد يختلف عن موقعك الحالي.',current:'استخدام موقعي الحالي',retry:'إعادة تحميل الخريطة',search:'البحث عن عنوان أو معلم',searchButton:'بحث',loading:'جارٍ تحميل خرائط Google…',manual:'لم تُهيأ خرائط Google بعد. يمكنك استخدام موقع الجهاز أو إدخال الإحداثيات والعنوان.',failed:'الخريطة غير متاحة. أعد المحاولة أو استخدم موقع الجهاز أو الإدخال اليدوي.',latitude:'خط العرض',longitude:'خط الطول',address:'عنوان المشكلة / معلم',city:'المدينة',district:'الحي',street:'الشارع',lookup:'معرفة عنوان الدبوس',choose:'استخدام موقع المشكلة هذا',note:'راجع الدبوس والعنوان. اختيار الموقع لا يرسل رسالة أو شكوى.',pick:'انقر على الخريطة أو اسحب الدبوس لتحديد موقع المشكلة.',moved:'تغير الموقع. راجع العنوان.',device:'تم تحديد موقع الجهاز. تأكد أن المشكلة تقع هنا.',denied:'لم يُمنح إذن الموقع. حدد على الخريطة أو أدخل الإحداثيات.',gpsError:'تعذر الحصول على الموقع. حدد على الخريطة أو أدخل الإحداثيات.',gpsBusy:'جارٍ تحديد موقع الجهاز…',invalid:'أدخل إحداثيات صحيحة وأكمل حقول العنوان المطلوبة.',searching:'جارٍ البحث عن العنوان…',notFound:'لم يُعثر على العنوان. جرّب اسماً آخر أو حدد على الخريطة.',addressFailed:'تعذر تحديد العنوان. تم حفظ الإحداثيات؛ راجع العنوان يدوياً.',accuracy:'دقة موقع الجهاز نحو ±{n} متر.'}
};
const t=(key,values={})=>Object.entries(values).reduce((s,[k,v])=>s.replace('{'+k+'}',v),(copies[locale]??copies.en)[key]);
function translate(){
  document.documentElement.lang=locale;document.documentElement.dir=locale==='ar'?'rtl':'ltr';
  for(const [id,key]of Object.entries({hint:'hint',current:'current',retry:'retry','search-label':'search','search-button':'searchButton','latitude-label':'latitude','longitude-label':'longitude','address-label':'address','city-label':'city','district-label':'district','street-label':'street',lookup:'lookup',choose:'choose','review-note':'note'}))$(id).textContent=t(key);
}
function setPoint(value,kind='map_pin',precision){
  const selected=normalizeLocation({...value,source:kind,...(precision!==undefined?{accuracy:precision}:{})});
  searchEpoch++;point={lat:selected.latitude,lng:selected.longitude};source=kind;accuracy=precision;
  $('latitude').value=String(selected.latitude);$('longitude').value=String(selected.longitude);
  if(automaticAddress){for(const id of ['address','city','street','district'])$(id).value='';automaticAddress=false;}
  if(marker)marker.position=point;if(map)map.panTo(point);
  $('accuracy').hidden=precision===undefined;$('accuracy').textContent=precision===undefined?'':t('accuracy',{n:Math.round(precision)});
  $('status').textContent=t(kind==='device'?'device':'moved');$('error').textContent='';
}
function clearSelection(){point=null;accuracy=undefined;source='manual';automaticAddress=false;searchEpoch++;for(const id of ['latitude','longitude','address','city','street','district'])$(id).value='';if(marker)marker.position=null;$('accuracy').hidden=true;$('error').textContent='';$('status').textContent=t(mapStatus);if($('map').classList.contains('unavailable'))$('map').textContent=t(mapStatus);}
function unavailable(key){mapStatus=key;$('map').classList.add('unavailable');$('map').replaceChildren(document.createTextNode(t(key)));$('status').textContent=t(key);$('retry').hidden=!config?.enabled;}
function addressResult(result){
  const find=types=>result.address_components?.find(c=>types.some(type=>c.types.includes(type)))?.long_name??'';
  $('address').value=result.formatted_address??'';$('city').value=find(['locality','postal_town','administrative_area_level_2']);$('street').value=find(['route']);$('district').value=find(['sublocality_level_1','sublocality','neighborhood']);automaticAddress=true;
}
async function geocode(request){
  if(!geocoder)return;
  const owner=++searchEpoch;$('status').textContent=t('searching');
  try{const {results}=await geocoder.geocode(request);if(owner!==searchEpoch)return;const result=results?.[0];if(!result){$('status').textContent=t('notFound');return;}
    if(request.address){setPoint({latitude:result.geometry.location.lat(),longitude:result.geometry.location.lng()});map?.setZoom(17);}
    addressResult(result);$('status').textContent=t('pick');
  }catch{if(owner===searchEpoch)$('status').textContent=t('addressFailed');}
}
async function initialize(){
  translate();$('status').textContent=t('loading');
  try{
    const response=await fetch('/api/maps/config',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('CONFIG_UNAVAILABLE');config=await response.json();
    if(!config.enabled){unavailable('manual');return;}
    window.gm_authFailure=()=>{authenticationFailed=true;unavailable('failed');};
    await new Promise((resolve,reject)=>{
      const script=document.createElement('script'),url=new URL('https://maps.googleapis.com/maps/api/js');url.searchParams.set('key',config.browser_key);url.searchParams.set('v','weekly');url.searchParams.set('loading','async');url.searchParams.set('callback','__baladyMapsReady');url.searchParams.set('language',locale==='zh'?'zh-CN':locale);url.searchParams.set('region','SA');
      const timer=setTimeout(()=>reject(Error('MAP_TIMEOUT')),15000);window.__baladyMapsReady=()=>{clearTimeout(timer);resolve();};script.onerror=()=>{clearTimeout(timer);reject(Error('MAP_UNAVAILABLE'));};script.src=url.href;script.nonce=document.querySelector('script[nonce]').nonce;document.head.append(script);
    });
    const [{Map},{AdvancedMarkerElement}]=await Promise.all([google.maps.importLibrary('maps'),google.maps.importLibrary('marker')]);
    if(authenticationFailed)throw Error('MAP_AUTH_FAILED');
    map=new Map($('map'),{center:{lat:24.7136,lng:46.6753},zoom:11,mapId:config.map_id,mapTypeControl:false,streetViewControl:false,fullscreenControl:false});
    marker=new AdvancedMarkerElement({map,gmpDraggable:true,title:t('choose')});
    map.addListener('click',event=>{if(event.latLng)setPoint({latitude:event.latLng.lat(),longitude:event.latLng.lng()});});
    marker.addListener('dragend',()=>{const p=marker.position;if(p)setPoint({latitude:typeof p.lat==='function'?p.lat():p.lat,longitude:typeof p.lng==='function'?p.lng():p.lng});});
    if(point){marker.position=point;map.panTo(point);}
    mapStatus='pick';$('status').textContent=t('pick');
    if(config.geocoding){try{const {Geocoder}=await google.maps.importLibrary('geocoding');geocoder=new Geocoder();$('search-form').hidden=false;$('lookup').hidden=false;}catch{$('status').textContent=t('addressFailed');}}
  }catch{unavailable('failed');}
}
$('current').addEventListener('click',()=>{
  if(!navigator.geolocation){$('status').textContent=t('gpsError');return;}
  $('current').disabled=true;$('status').textContent=t('gpsBusy');const owner=++searchEpoch;
  navigator.geolocation.getCurrentPosition(position=>{if(owner===searchEpoch){setPoint({latitude:position.coords.latitude,longitude:position.coords.longitude},'device',position.coords.accuracy);map?.setZoom(17);}$('current').disabled=false;},error=>{if(owner===searchEpoch)$('status').textContent=t(error.code===1?'denied':'gpsError');$('current').disabled=false;},{enableHighAccuracy:true,timeout:12000,maximumAge:0});
});
for(const id of ['latitude','longitude'])$(id).addEventListener('input',()=>{searchEpoch++;source='manual';accuracy=undefined;$('accuracy').hidden=true;if(automaticAddress){for(const field of ['address','city','street','district'])$(field).value='';automaticAddress=false;}const lat=$('latitude').value,lng=$('longitude').value;if(lat!==''&&lng!==''){try{const p=normalizeLocation({latitude:Number(lat),longitude:Number(lng)});point={lat:p.latitude,lng:p.longitude};if(marker)marker.position=point;if(map)map.panTo(point);}catch{point=null;}}else point=null;if(!point&&marker)marker.position=null;$('status').textContent=t('moved');});
for(const id of ['address','city','street','district'])$(id).addEventListener('input',()=>{searchEpoch++;automaticAddress=false;});
$('search-form').addEventListener('submit',e=>{e.preventDefault();const address=$('search').value.trim();if(address)geocode({address});});
$('lookup').addEventListener('click',()=>{if(point)geocode({location:point});});
$('retry').addEventListener('click',()=>location.reload());
$('location-form').addEventListener('submit',event=>{
  event.preventDefault();
  try{
    if($('latitude').value===''||$('longitude').value==='')throw Error('MISSING_COORDINATES');
    if(['address','city','street','district'].some(id=>$(id).required&&!$(id).value.trim()))throw Error('MISSING_ADDRESS');
    const selection=normalizeLocation({latitude:Number($('latitude').value),longitude:Number($('longitude').value),source,...(accuracy!==undefined?{accuracy}:{}),...Object.fromEntries(['address','city','street','district'].map(id=>[id,$(id).value]))});
    if(!channel||window.parent===window)throw Error('PICKER_CONTEXT_REQUIRED');
    window.parent.postMessage({type:'balady:location-selected',channel,selection},location.origin);
  }catch{$('error').textContent=t('invalid');}
});
window.addEventListener('message',event=>{
  if(event.source!==window.parent||event.origin!==location.origin||event.data?.type!=='balady:map-open'||event.data.channel!==channel)return;
  if(['zh','en','ar'].includes(event.data.locale)){locale=event.data.locale;translate();}
  clearSelection();for(const id of ['address','city','street','district'])$(id).required=(event.data.required_fields??[]).includes(id);
  if(event.data.initial){try{const initial=normalizeLocation(event.data.initial);setPoint(initial,initial.source,initial.accuracy);for(const id of ['address','city','street','district'])$(id).value=initial[id]??'';}catch{}}
});
initialize();
