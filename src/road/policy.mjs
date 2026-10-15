import {failure} from './store.mjs';

// Host-owned metadata. Neither model arguments nor display preferences can lower risk.
export const TOOL_POLICY=Object.freeze({
  query_tickets:Object.freeze({effect:'read',risk:'normal',confirmation:false}),
  create_ticket:Object.freeze({effect:'write',risk:'normal',confirmation:true}),
  close_ticket:Object.freeze({effect:'write',risk:'normal',confirmation:true}),
  complain_ticket:Object.freeze({effect:'write',risk:'normal',confirmation:true}),
  handoff_to_human:Object.freeze({effect:'write',risk:'normal',confirmation:true})
});
export function parseHighRiskReads(value=''){
  const names=Array.isArray(value)?value:String(value).split(',').map(s=>s.trim()).filter(Boolean);
  if(names.some(name=>TOOL_POLICY[name]?.effect!=='read'))throw failure('INVALID_RISK_POLICY','High-risk reads must name registered read tools');
  return [...new Set(names)];
}
export function policyFor(operation,highRiskReads=[]){
  const base=TOOL_POLICY[operation];if(!base)throw failure('UNKNOWN_CAPABILITY','Unknown business capability');
  const high=base.effect==='read'&&highRiskReads.includes(operation);
  return {...base,risk:high?'high':base.risk,confirmation:base.confirmation||high,reason:high?'high_risk_read':base.confirmation?'business_write':null};
}
export function policyRegistry(highRiskReads=[]){return Object.fromEntries(Object.keys(TOOL_POLICY).map(name=>[name,policyFor(name,highRiskReads)]));}
