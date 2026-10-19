import {digest} from '../road/store.mjs';

const operation='crm_create_form_request';
const key=text=>digest([operation,text]);
// Formatting changes do not add facts. Words, negation, numbers and their
// order remain part of the quote. This is local assistant policy, not a CRM
// schema restriction on the provider's free-text field.
const normalize=text=>text.normalize('NFKC').toLowerCase().replace(/\p{White_Space}+/gu,' ').trim();
export const sameDescription=(first,second)=>typeof first==='string'&&typeof second==='string'&&normalize(first)===normalize(second);

export function rememberDescription(session,description,source){
  session.facts.descriptionSources??={};
  session.facts.descriptionSources[key(description)]={...structuredClone(source),description};
}

export function descriptionSource(parameters,session,supplied){
  const description=parameters.body?.Description;
  if(description===undefined)return {valid:true}; // A genuine missing field.
  if(typeof description!=='string'||!description.trim())return {valid:false,error:'DESCRIPTION_SOURCE_REQUIRED',message:'Use the delivered issue text, not an empty or invented description.'};
  const cached=session.facts.descriptionSources?.[key(description)];
  if(cached?.kind==='ui_edit'&&cached.description===description)return {valid:true,source:cached};
  const sources=session.messages.filter(message=>message.role==='user').map(message=>message.text).filter(text=>typeof text==='string');
  const value=normalize(description),delivered=sources.map(normalize);
  if(delivered.some(text=>text.includes(value)))return {valid:true,source:{kind:'user_quote',quotes:[description]}};
  const evidence=supplied??cached;
  const ordered=quotes=>{let message=0,offset=0;for(const quote of quotes){if(typeof quote!=='string'||!normalize(quote))return false;let found=false;for(;message<delivered.length;message++,offset=0){const index=delivered[message].indexOf(normalize(quote),offset);if(index!==-1){offset=index+normalize(quote).length;found=true;break;}}if(!found)return false;}return true;};
  if(Array.isArray(evidence?.quotes)&&evidence.quotes.length&&ordered(evidence.quotes)&&normalize(evidence.quotes.join('\n'))===value){
    return {valid:true,source:{kind:'user_quotes',quotes:[...evidence.quotes]}};
  }
  return {valid:false,error:'DESCRIPTION_SOURCE_REQUIRED',message:'The description adds or rewrites words without a delivered user source. Use a contiguous quote of the user\'s issue, preserving its context, negation and qualifiers; or provide description_source.quotes containing actual user spans and join them with newlines in body.Description. Do not add a duration, visit, cause, frequency or other event. Reuse known contacts, title and attachments. Do not ask for text consent. The person may edit the description in the exact card.',errors:[{path:'/body/Description',code:'source_required',message:'No verbatim user source supports this full description.'}]};
}
