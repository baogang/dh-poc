// Shared validation for user-selected geographic facts. No administrative IDs.
export function normalizeLocation(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('LOCATION_REQUIRED');
  const allowed=['latitude','longitude','address','city','street','district','accuracy','source'];
  if(Object.keys(value).some(key=>!allowed.includes(key)))throw Error('INVALID_LOCATION_FIELD');
  const {latitude,longitude}=value;
  if(typeof latitude!=='number'||!Number.isFinite(latitude)||latitude< -90||latitude>90||typeof longitude!=='number'||!Number.isFinite(longitude)||longitude< -180||longitude>180)throw Error('INVALID_COORDINATES');
  const result={latitude,longitude};
  for(const [field,max]of [['address',2000],['city',200],['street',400],['district',400]]){
    if(value[field]===undefined)continue;
    if(typeof value[field]!=='string'||value[field].length>max)throw Error('INVALID_LOCATION_TEXT');
    const text=value[field].trim();if(text)result[field]=text;
  }
  if(value.accuracy!==undefined){if(typeof value.accuracy!=='number'||!Number.isFinite(value.accuracy)||value.accuracy<0||value.accuracy>1000000)throw Error('INVALID_LOCATION_ACCURACY');result.accuracy=value.accuracy;}
  if(value.source!==undefined&&!['map_pin','device','manual'].includes(value.source))throw Error('INVALID_LOCATION_SOURCE');
  result.source=value.source??'manual';return result;
}
export function locationText(value,locale='en'){
  const point=normalizeLocation(value),labels=locale==='zh'?['已选择的问题位置','纬度','经度','地址','城市','街道','地区','定位精度（米）']:locale==='ar'?['موقع المشكلة المحدد','خط العرض','خط الطول','العنوان','المدينة','الشارع','الحي','دقة الموقع بالأمتار']:['Selected issue location','Latitude','Longitude','Address','City','Street','District','Location accuracy (metres)'];
  return [labels[0],labels[1]+': '+point.latitude,labels[2]+': '+point.longitude,...['address','city','street','district','accuracy'].flatMap((field,i)=>point[field]===undefined?[]:[labels[i+3]+': '+point[field]])].join('\n');
}
export function locationInput(input){return input?.kind==='address'||(input?.fields??[]).some(path=>/^(?:body\.)?LocationInfo\.(?:Latitude|Longitude|Address|StreetName|DistrictName|MunicipalityID)$/.test(path)||['municipalityID','MunicipalityID'].includes(path));}
export function validMapMessage(event,frame,channel,origin){return event.origin===origin&&event.source===frame.contentWindow&&event.data?.type==='balady:location-selected'&&event.data.channel===channel;}
