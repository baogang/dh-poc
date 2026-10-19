import {BY_ID} from './contract.mjs';
import {requestFor} from './validation.mjs';
const problem=(code,message,extra={})=>({ok:false,error:{code,message,...extra}});
export function inspectResponse(status,value){
  const transport=value?.statusDetails?.code??value?.statusDetails?.Code;
  const code=value?.data?.responseCode??value?.Data?.responseCode;
  if(status<200||status>=300||transport!==undefined&&Number(transport)>=400||code!==undefined&&!['1','MMRH-00000'].includes(String(code)))return problem(String(code??transport??status),value?.data?.responseMessage??value?.Data?.responseMessage??value?.statusDetails?.message??'CRM request failed',{http_status:status,response:value,...(value?.data?.validation?{validation:value.data.validation}:{})});
  if(transport===undefined||code===undefined)return problem('MALFORMED_RESPONSE','CRM did not return its documented status and business response codes.',{http_status:status});
  return {ok:true,response:value};
}

// Credentials never appear in a tool schema or model observation. There is no
// retry of a mutation: timeout after dispatch is an uncertain result.
export class RealCrmClient{
  constructor({baseUrl=process.env.CRM_BASE_URL??'https://apiservicesstg.balady.gov.sa',consumerKey=process.env.CRM_CONSUMER_KEY,consumerSecret=process.env.CRM_CONSUMER_SECRET,ssoToken=process.env.CRM_SSO_JWT,reopenAuth=process.env.CRM_REOPEN_AUTH,daemShape=process.env.CRM_DAEM_SHAPE,statusWireType=process.env.CRM_STATUS_WIRE_TYPE,formTypeStyle=process.env.CRM_FORM_TYPE_STYLE,fetchImpl=fetch}={}){
    if(!['https://apiservicesstg.balady.gov.sa','https://apiservices.balady.gov.sa'].includes(baseUrl))throw Error('CRM_BASE_URL must be a documented BALADY HTTPS origin');
    Object.assign(this,{baseUrl,consumerKey,consumerSecret,ssoToken,reopenAuth,daemShape,statusWireType,formTypeStyle,fetchImpl});this.mode='real';
  }
  async oauth(signal){
    if(this.token&&this.expiresAt>Date.now()+30000)return this.token;
    if(!this.consumerKey||!this.consumerSecret)throw Error('CRM consumer credentials are not configured');
    const r=await this.fetchImpl(this.baseUrl+'/oauth/v1/token',{method:'POST',headers:{authorization:'Basic '+Buffer.from(this.consumerKey+':'+this.consumerSecret).toString('base64'),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials'}),signal});
    const value=await r.json();if(!r.ok||!value.access_token)throw Error('CRM OAuth authentication failed');
    this.token=value.access_token;this.expiresAt=Date.now()+Math.min(Number(value.expires_in)||0,86400)*1000;return this.token;
  }
  async execute(_session,operation,parameters,{signal}={}){
    const request=requestFor(operation,parameters);if(!request.valid)return problem('INVALID_PARAMETERS','Correct the listed parameters before dispatch',{validation:request});
    const op=BY_ID.get(operation);let auth=op.auth;
    if(auth==='ambiguous_reopen'){if(!['basic','oauth'].includes(this.reopenAuth))return problem('DOCUMENTATION_AMBIGUITY','Configure CRM_REOPEN_AUTH=basic|oauth after provider confirmation (section 3.13).');auth=this.reopenAuth;}
    if(operation==='crm_create_daem_ticket'&&!['array','object'].includes(this.daemShape))return problem('DOCUMENTATION_AMBIGUITY','Confirm CRM_DAEM_SHAPE=array|object with provider (section 3.30).');
    if(operation==='crm_create_form_request'&&!['code','label'].includes(this.formTypeStyle))return problem('DOCUMENTATION_AMBIGUITY','Confirm CRM_FORM_TYPE_STYLE=code|label with provider (section 3.31).');
    if(operation==='crm_update_incident_status_v2'&&parameters.body.CaseStatusID!==undefined&&!['number','padded-string'].includes(this.statusWireType))return problem('DOCUMENTATION_AMBIGUITY','Confirm CRM_STATUS_WIRE_TYPE=number|padded-string and status code mapping with provider (section 3.14).');
    if(auth==='sso'&&!this.ssoToken)return problem('SSO_NOT_CONFIGURED','This mobile operation requires an SSO JWT; consumer OAuth is not interchangeable. Configure it outside chat.');
    if(auth==='basic'&&(!this.consumerKey||!this.consumerSecret))return problem('AUTH_NOT_CONFIGURED','Basic consumer credentials are not configured.');
    let authorization;try{authorization=auth==='sso'?'Bearer '+this.ssoToken:auth==='basic'?'Basic '+Buffer.from(this.consumerKey+':'+this.consumerSecret).toString('base64'):'Bearer '+await this.oauth(signal);}catch{return problem('AUTH_UNAVAILABLE','Server-side CRM authentication is unavailable.');}
    const body=structuredClone(request.body);
    if(operation==='crm_create_form_request'&&this.formTypeStyle==='label')body.Type=({T01:'Inquiry',T02:'Suggestion',T03:'Complain'})[body.Type];
    if(operation==='crm_create_daem_ticket'&&this.daemShape==='object'){if(body.IncidentManagementBaladyIntCRM.length!==1)return problem('INVALID_PARAMETERS','Provider object mode accepts one Daem ticket at a time.');body.IncidentManagementBaladyIntCRM=body.IncidentManagementBaladyIntCRM[0];}
    if(operation==='crm_update_incident_status_v2'&&this.statusWireType==='padded-string'&&body.CaseStatusID!==undefined)body.CaseStatusID=String(body.CaseStatusID).padStart(3,'0');
    try{const r=await this.fetchImpl(this.baseUrl+request.path,{method:request.method,headers:{authorization,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});return inspectResponse(r.status,await r.json());}
    catch{return problem(op.effect==='write'?'RESULT_UNCERTAIN':'TRANSPORT_UNAVAILABLE',op.effect==='write'?'The request may have reached CRM. Reconcile before any retry.':'CRM transport is unavailable; no result is available.');}
  }
}

export class SimulationHttpClient{
  constructor({origin,key}){Object.assign(this,{origin,key,mode:'simulation'});}
  async execute(session,operation,parameters,{signal,idempotency_key,epoch}={}){
    const request=requestFor(operation,parameters);if(!request.valid)return problem('INVALID_PARAMETERS','Correct the listed parameters before dispatch',{validation:request});
    try{const r=await fetch(this.origin+request.path,{method:request.method,headers:{'x-crm-simulation-key':this.key,'x-road-session':session.id,'x-crm-epoch':String(epoch??session.epoch),...(idempotency_key?{'x-crm-idempotency-key':idempotency_key}:{}),...(request.body?{'content-type':'application/json'}:{})},...(request.body?{body:JSON.stringify(request.body)}:{}),signal});return {...inspectResponse(r.status,await r.json()),mode:'simulation'};}
    catch{return problem(BY_ID.get(operation).effect==='write'?'RESULT_UNCERTAIN':'TRANSPORT_UNAVAILABLE','CRM simulation transport did not return a result.');}
  }
}
