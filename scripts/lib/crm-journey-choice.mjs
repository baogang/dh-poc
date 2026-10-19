// This is a UI actor transport, never an intent classifier or a private oracle.
// The fixed actor must explicitly supply an offered id or an exact visible label.
const normalize=value=>String(value??'').normalize('NFKC').trim().replace(/\s+/gu,' ');
export function journeyChoice(pending,{choice_id,text}={}){
  if(pending?.kind!=='choice')return {selected:false,reason:'not_a_service_choice'};
  const choices=(pending.choices??[]).filter(choice=>typeof choice.id==='string'&&typeof choice.label==='string');
  const declared=typeof choice_id==='string'&&choice_id.length>0;
  const matches=declared?choices.filter(choice=>choice.id===choice_id):typeof text==='string'&&normalize(text)?choices.filter(choice=>normalize(text)===normalize(choice.id)||normalize(text)===normalize(choice.label)):[];
  if(matches.length===1)return {selected:true,choice_id:matches[0].id,source:declared?'declared_choice_id':'exact_visible_label_or_id'};
  return {selected:false,reason:matches.length>1?'ambiguous_explicit_choice':declared?'declared_choice_not_offered':'no_exact_explicit_choice'};
}
