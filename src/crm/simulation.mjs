import {OPERATIONS,BY_ID} from './contract.mjs';
import {validateInput} from './validation.mjs';
import {clone,digest,id,failure} from '../road/store.mjs';

export const MAIN='004_MC-1',SUB=MAIN+'_SC-1',SPECIAL=SUB+'_SPC-1';
export const INCIDENT='INC-26-10-000001',KEY='MOMRA-OPS-CS-WORK '+INCIDENT;
const envelope=(result,{responseCode='1',responseMessage='success',responseId}={})=>({statusDetails:{code:200,message:'OK'},data:{responseCode,responseMessage,...(responseId?{responseId}:{}),...(result!==undefined?{result}:{})}});
const error=(code,message,details={})=>({ok:false,error:{code,message,...details}});
export function ensureCrm(s){
  s.crm??={version:'1.13.0',incidents:[{pyID:INCIDENT,pzInsKey:KEY,pyStatusWork:'InProgress',MunicipalityID:'004',MainClassificationID:MAIN,SubClassificationID:SUB,SplClassificationID:SPECIAL,Description:'Simulated public street maintenance report',hasAttachments:false,routedToMadinati:true,history:[]},{pyID:'INC-26-10-000002',pzInsKey:'MOMRA-OPS-CS-WORK INC-26-10-000002',pyStatusWork:'Resolved',MunicipalityID:'004',Description:'Simulated waste container report',hasAttachments:true,routedToMadinati:true,history:[]}],files:{},forms:[],support:[],surveys:{},idempotency:{},faults:{},calls:[],sequence:2,caseVersion:'20261020T090000.000 GMT'};
  return s.crm;
}
const routes=OPERATIONS.map(op=>({op,regex:new RegExp('^'+op.path.replace(/\{([^}]+)\}/g,'([^/]+)')+'$'),names:[...op.path.matchAll(/\{([^}]+)\}/g)].map(m=>m[1])}));
export class CrmSimulation{
  constructor(store){this.store=store;this.mode='simulation';}
  match(method,pathname){return routes.find(r=>r.op.method===method&&r.regex.test(pathname));}
  async http(s,method,url,body,context={}){
    const route=this.match(method,url.pathname);if(!route)return error('UNKNOWN_API','No documented CRM operation matches this method and URI.');
    const match=url.pathname.match(route.regex),parameters={};route.names.forEach((name,i)=>parameters[name]=decodeURIComponent(match[i+1]));
    for(const [key,value]of url.searchParams){const schema=route.op.query.properties[key];parameters[key]=schema?.type==='boolean'&&['true','false'].includes(value)?value==='true':value;}
    if(route.op.body)parameters.body=body;
    return this.execute(s,route.op.id,parameters,context);
  }
  async execute(s,operation,parameters,{idempotency_key,epoch=s.epoch,signal}={}){
    signal?.throwIfAborted();if(epoch!==s.epoch)return error('STALE_TURN','The conversation changed; publish a current plan.');
    const op=BY_ID.get(operation),valid=validateInput(operation,parameters);if(!valid.valid)return error('INVALID_PARAMETERS','Correct the listed parameter paths.',{validation:valid});
    const c=ensureCrm(s),body=parameters.body??{},fingerprint=digest([operation,parameters]);
    if(op.auth==='sso'&&!s.user)return error('LOGIN_REQUIRED','Use the demo login form before SSO operations; never provide credentials in tool arguments.');
    if(op.effect==='write'&&!idempotency_key)return error('IDEMPOTENCY_REQUIRED','Host must provide the current authorized operation key.');
    if(idempotency_key&&c.idempotency[idempotency_key]){const prior=c.idempotency[idempotency_key];return prior.fingerprint===fingerprint?{...clone(prior.result),replayed:true}:error('IDEMPOTENCY_CONFLICT','This operation key was used for a different payload.');}
    const call={operation,parameters:clone(parameters),time:new Date().toISOString()};c.calls.push(call);this.store.emit(s,'api_start',{call});
    const fault=c.faults[operation];if(fault){if(fault.once!==false)delete c.faults[operation];return error(fault.code??'SERVICE_UNAVAILABLE',fault.message??'Injected simulation fault',{http_status:fault.status??503});}
    const incidentNumber=body.MomraIncidentNo??body.IncidentID??body.CRMIncidentID??parameters.CRMID;
    const findIncident=()=>c.incidents.find(x=>x.pyID===incidentNumber||x.pzInsKey===parameters.pzInsKey||x.pzInsKey===parameters.caseId);
    const target=findIncident();
    if((incidentNumber||parameters.pzInsKey||parameters.caseId)&&!target)return error('NOT_FOUND','No matching incident/case is available in this session. Use a returned identifier, or ask for the correct one.');
    let result;
    if(operation==='crm_get_assets')result=[{MainAssetsID:'MA-DEMO-1',MainAssetsName:'Simulated municipal infrastructure'}];
    else if(operation==='crm_get_asset_details'){if(parameters.id!=='MA-DEMO-1')return error('NOT_FOUND','Unknown main asset ID; list assets first.');result={SubAssetsID:'SA-DEMO-1',Unit:1,SubAssetsName:'Simulated street asset'};}
    else if(operation==='crm_get_case')result=c.caseVersion;
    else if(operation==='crm_update_case'){if(body.content?.etag&&body.content.etag!==c.caseVersion)return error('STALE_ETAG','Read the current case version and correct content.etag.');if(body.content?.pxUrgencyWork!==undefined)target.pxUrgencyWork=body.content.pxUrgencyWork;c.caseVersion=new Date().toISOString();}
    else if(operation==='crm_get_incidents')result={TotalRecordCount:String(c.incidents.length),IncidentRequestList:c.incidents.map(x=>clone(x))};
    else if(['crm_fetch_incident','crm_fetch_municipal_service','crm_fetch_inquiry'].includes(operation))result=clone(target);
    else if(operation==='crm_get_main_classifications')result=[{ID:MAIN,Name:'Simulated municipal services'}];
    else if(operation==='crm_get_sub_classifications'){if(parameters.mainClassificationID!==MAIN)return error('NOT_FOUND','Unknown main classification. Read the main classification list.');result=[{ID:SUB,Name:'Simulated public space maintenance'}];}
    else if(operation==='crm_get_special_classifications'){if(parameters.subClassificationID!==SUB)return error('NOT_FOUND','Unknown sub classification. Read the sub classification list.');result=[{ID:SPECIAL,Name:'Simulated road and public space report'}];}
    else if(operation==='crm_get_special_classifications_by_type')result=[{ID:SPECIAL,SubClassificationID:SUB,Name:'Simulated classification'}];
    else if(operation==='crm_get_classification_parents'){if(parameters.ID!==SPECIAL)return error('NOT_FOUND','Unknown special classification.');result={MainClassificationID:MAIN,MainClassificationName:'Simulated municipal services',SubClassificationID:SUB,SubClassificationName:'Simulated public space maintenance'};}
    else if(operation==='crm_retrieve_msr_data'){if(parameters.ID!==SPECIAL)return error('NOT_FOUND','Unknown special classification.');result=parameters.Action==='MSRClsData'?{MainClassificationID:MAIN,MainClassificationName:'Simulated municipal services',SubClassificationID:SUB,SubClassificationName:'Simulated public space maintenance'}:{SplClsList:[{ID:SPECIAL,Name:'Simulated classification'}]};}
    else if(operation==='crm_get_external_new_classifications')result=[{NewClassID:'NC-DEMO-1',NClassNameAR:'تصنيف تجريبي',NClassNameEN:'Simulated external class'}];
    else if(operation==='crm_get_external_special_classifications')result=[{SplClassificationID:SPECIAL,SplClassificationNameAr:'تصنيف تجريبي'}];
    else if(operation==='crm_get_external_entities')result=[{EEName:'Simulated Engineering Entity',EECode:'AGC-DEMO-1',EENameAR:'جهة تجريبية'}];
    else if(operation==='crm_get_external_entity_classifications'){if(parameters.EECode&&parameters.EECode!=='AGC-DEMO-1')return error('NOT_FOUND','Unknown EECode. Read crm_get_external_entities.');result=[{EEName:'Simulated Engineering Entity',EECode:'AGC-DEMO-1',EENameAR:'جهة تجريبية',LinkedClassifications:[{ClassificationCode:SPECIAL,ClassificationName:'Simulated municipal maintenance'}]}];}
    else if(operation==='crm_get_closure_reasons'){const t=c.incidents.find(x=>x.pyID===parameters.MomraIncidentNo);if(!t||!t.routedToMadinati)return error('NO_ACCESS','Incident must exist and be routed to Madinati.');result=[{pxObjClass:'MOMRA-FW-CS-Data-IncidentStatus',ID:parameters.IsProcessed?'DEMO-PROCESSED':'DEMO-UNPROCESSED',Name:parameters.IsProcessed?'Processed in simulation':'Not processed in simulation'}];}
    else if(operation==='crm_retrieve_tsr_data'){const values={IssueTypeList:[{IssueType:'Simulated platform issue'}],Amanat:[{ID:'004',Name:'Riyadh'}],AmanatBaladiah:[{ID:'004001',Name:'Simulated Baladiah'}],AreaList:[{Area:'Simulated area'}],Category:[{Category:'Simulated category'}],SubCategory:[{SubCategory:'Simulated subcategory'}],CategoryByIssueType:[{Category:'Simulated category'}],IssueType:[{IssueType:'Simulated platform issue'}]};result={[parameters.Action]:values[parameters.Action]};}
    else if(['crm_create_municipal_service','crm_create_inquiry'].includes(operation)){
      const info=body.IncidentInformation;if(info.MainClassificationID!==MAIN||info.SubClassificationID!==SUB||info.SplClassificationID!==SPECIAL)return error('INVALID_CLASSIFICATION','Use a consistent classification hierarchy from lookups; do not fabricate IDs.');
      const inquiry=operation==='crm_create_inquiry',pyID=`${inquiry?'INQ':'REQ'}-26-10-${String(++c.sequence).padStart(6,'0')}`,pzInsKey=(inquiry?'MOMRA-OPS-CS-WORK ':'MOMRA-OPS-CS-WORK-MUNICIPALSERVICEREQUEST ')+pyID;
      const row={...clone(body),pyID,pzInsKey,pyStatusWork:'Open',MunicipalityID:body.LocationInfo.MunicipalityID,hasAttachments:false,history:[]};c.incidents.push(row);result={pyID,pzInsKey,CaseDeadline:'19700101T000000.000 GMT',AssignmentKey:'ASSIGN-DEMO '+pyID};
    }else if(['crm_upload_file','crm_upload_attachment'].includes(operation)){
      if(operation==='crm_upload_file'&&!c.incidents.some(x=>x.pyID===body.CaseID||x.pzInsKey===body.CaseID))return error('NOT_FOUND','CaseID must identify an existing case. The source example uses the full Pega key.');
      const fileId='FILE-DEMO-'+String(++c.sequence).padStart(6,'0');c.files[fileId]={AttachName:body.pxAttachName??'upload',AttachmentStream:body.AttachStream,CaseID:body.CaseID??null};result=operation==='crm_upload_attachment'?[{fileId}]:{LinkedRefFrom:body.CaseID,LinkedRefTo:fileId};
    }else if(operation==='crm_download_file'){const f=c.files[parameters.FileKey];if(!f)return error('NOT_FOUND','Unknown FileKey; use an actual uploaded or returned file key.');result=clone(f);}
    else if(operation==='crm_create_form_request'){
      for(const a of body.Attachments)if(!c.files[a.AttachmentID])return error('INVALID_ATTACHMENT','Upload the attachment first and use returned fileId as AttachmentID.');
      const pyID='PUB-DEMO-'+String(++c.sequence).padStart(6,'0');c.forms.push({pyID,...clone(body)});result={id:pyID,insKey:'MOMRA-OPS-CS-WORK '+pyID};
    }else if(operation==='crm_create_daem_ticket'){result=body.IncidentManagementBaladyIntCRM.map(entry=>{const TSRNo='TSR-DEMO-'+String(++c.sequence).padStart(6,'0');c.support.push({TSRNo,...clone(entry)});return {TSRNo,IncidentID:TSRNo};});}
    else if(operation==='crm_resolve_madinati_incident'){
      if(!target.routedToMadinati)return error('NO_ACCESS','This incident is not routed to Madinati.');
      const lookup=[...s.receipts].reverse().find(r=>r.operation==='crm_get_closure_reasons'&&r.parameters.MomraIncidentNo===body.MomraIncidentNo&&r.parameters.IsProcessed===body.IsProcessed);
      if(!lookup)return error('CLOSURE_LOOKUP_REQUIRED','Read closure reasons for this incident and the same IsProcessed flag first.');
      if(!lookup.result.data.result.some(r=>r.Name===body.ClosureReasonName))return error('INVALID_CLOSURE_REASON','Use an eligible reason Name from the matching lookup, not the ID.');
      if(target.hasAttachments&&!body.IncidentPhotosAfterFixing?.length)return error('CONDITIONAL_PARAMETER_MISSING','This incident has attachments; IncidentPhotosAfterFixing with all four photo fields is required.');
      target.pyStatusWork='Resolved';target.history.push(clone(body));
    }else if(operation==='crm_reopen_incident'){if(!target.pyStatusWork.startsWith('Resolved'))return error('INELIGIBLE_STATE','Only a resolved incident can be reopened in this simulation.');target.pyStatusWork='InProgress';target.history.push({operation,...clone(body)});}
    else if(operation==='crm_update_external_incident'){if(target.pyStatusWork.startsWith('Resolved'))return error('EEAPI_02','Incident already resolved; no further external updates.');target.pyStatusWork=body.IncidentStatusName;target.history.push(clone(body));}
    else if(operation==='crm_update_cis_incident'){target.pyStatusWork=({'2':'InProgress','3':'Resolved','4':'Rejected'})[body.IncidentStatusID];target.history.push(clone(body));}
    else if(operation==='crm_update_incident_status_v2'){target.statusV2=clone(body);target.history.push(clone(body));}
    else if(operation==='crm_update_vehicle_status'){target.vehicleStatus=body.Status;}
    else if(['crm_update_survey_url','crm_submit_survey_evaluation'].includes(operation)){c.surveys[body.IncidentID]={...c.surveys[body.IncidentID],...clone(body)};}
    else return error('UNIMPLEMENTED','This operation has no simulation behavior.');
    const response=envelope(result,{responseCode:operation==='crm_update_vehicle_status'?'MMRH-00000':'1',...(op.effect==='write'?{responseId:'SIM-'+String(++c.sequence).padStart(6,'0')}:{})});
    const out={ok:true,response,mode:'simulation'};
    if(idempotency_key)c.idempotency[idempotency_key]={fingerprint,result:clone(out)};
    await this.store.save(s);this.store.emit(s,'api_end',{operation,response:clone(response)});return out;
  }
  // UI-only support facilities are deliberately absent from the CRM toolset.
  async call(sid,operation,parameters,context={}){
    const s=this.store.get(sid);ensureCrm(s);
    if(operation==='login'){
      if(!['demo','registered','noaddress','sara'].includes(parameters.username)||parameters.password!=='demo')throw failure('INVALID_LOGIN','Use a listed demo account and password demo',401);
      s.user={user_id:'demo-'+parameters.username,name:parameters.username};return {user:clone(s.user)};
    }
    if(operation!=='handoff_to_human'||parameters.scope!=='conversation')throw failure('UNKNOWN_API','Legacy business APIs are disabled',404);
    if(!['user_help_choice','human_simulator'].includes(context.authorization))throw failure('AUTHORIZATION_REQUIRED','Use the help UI');
    let h=s.mock.handoffs.find(x=>x.handoff_id===parameters.handoff_id);
    if(!h){h={handoff_id:id('human'),scope:'conversation',request_id:parameters.request_id,reason:parameters.reason,conversation_summary:parameters.conversation_summary,status:'WAITING',history:[],messages:[]};s.mock.handoffs.push(h);}
    else{const transitions={accept:['WAITING','ACCEPTED'],escalate:['ACCEPTED','ESCALATED'],complete:[['ACCEPTED','ESCALATED'],'COMPLETED'],cancel:[['WAITING','ACCEPTED','ESCALATED'],'CANCELLED']};const t=transitions[parameters.action];if(!t||![t[0]].flat().includes(h.status))throw failure('INVALID_TRANSITION','Invalid human desk action');h.status=t[1];h.history.push({status:h.status,time:new Date().toISOString()});}
    await this.store.save(s);return {handoff:clone(h)};
  }
}
