import {randomBytes} from 'node:crypto';
export function mapsConfiguration(env=process.env){
  const key=env.GOOGLE_MAPS_BROWSER_KEY?.trim()??'',mode=env.GOOGLE_MAPS_KEY_MODE==='demo'?'demo':'standard';
  return {enabled:!!key,browser_key:key,mode,map_id:env.GOOGLE_MAPS_MAP_ID?.trim()||'DEMO_MAP_ID',geocoding:!!key&&mode==='standard'&&env.GOOGLE_MAPS_GEOCODING_ENABLED==='true'};
}
export function mapsPage(html){
  const nonce=randomBytes(24).toString('base64');
  const csp=["default-src 'self'",`script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://maps.googleapis.com https://maps.gstatic.com`,`style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,"img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com https://*.ggpht.com","connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.google.com data: blob:","font-src 'self' https://fonts.gstatic.com","frame-src https://*.google.com","worker-src blob:","frame-ancestors 'self'","base-uri 'none'","form-action 'self'"].join('; ');
  return {html:html.replaceAll('__MAP_NONCE__',nonce),csp};
}
