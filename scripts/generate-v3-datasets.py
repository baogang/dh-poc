"""Freeze V3 references before execution. Never relabel from evaluated model outputs."""
from pathlib import Path
import json,hashlib,shutil,collections
ROOT=Path(__file__).resolve().parents[1]
OLD=ROOT/'datasets/v2.0';NEW=ROOT/'datasets/v3.0'
def load(p):return [json.loads(s) for s in p.read_text().splitlines() if s]
def write(p,rows):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(''.join(json.dumps(r,ensure_ascii=False,sort_keys=True)+'\n' for r in rows))
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
if (NEW/'freeze.json').exists():raise SystemExit('V3 is frozen; publish another version instead of overwriting')
for p,h in json.loads((OLD/'freeze.json').read_text())['files'].items():
 if digest(ROOT/p)!=h:raise SystemExit('Historical release changed: '+p)
changes=[]
for suite in ['emotion','planning','engineering','integration']:
 rows={n:load(OLD/suite/(n+'.jsonl')) for n in ['inputs','references','manifest']}
 if suite=='emotion':
  for r in rows['references']:
   old=r['reference'];sent=old['sentiment'];status='classified'
   if sent=='mixed':sent='negative';basis='Current outcome dissatisfaction prevails over thanks/praise; examined original current message.'
   elif sent=='undetermined':sent=None;status='needs_clarification';basis='Unreadable or truncated current expression; not merely missing a business identifier.'
   else:basis='Existing current-attitude label remains one of the three registered classes.'
   new={'sentiment':sent,'assessment_status':status,'status':'provisional','evidence':[dict(e,label='sentiment:'+sent) for e in old['evidence'] if e['label']=='sentiment:'+old['sentiment']] if sent else []}
   if old['sentiment'] in ['mixed','undetermined']:changes.append({'case_id':r['case_id'],'from':old['sentiment'],'to':sent,'assessment_status':status,'basis':basis})
   r['reference']=new
  # Inputs are copied byte-for-byte for the original 600. Additional independently authored boundaries.
  boundaries=[
   ('The report is closed and the debris remains. Please check CMP-MOCK-001.','neutral','facts'),
   ('شكواي مغلقة والمخلفات ما زالت موجودة، أريد معرفة الحالة.','neutral','facts'),
   ('Thank you, but the problem is still unresolved and I am disappointed.','negative','thanks_with_dissatisfaction'),
   ('شكراً لكم، لكن المشكلة لم تحل وأنا محبط.','negative','thanks_with_dissatisfaction'),
   ('I was disappointed before, but it is fixed now and I am very satisfied.','positive','resolved_history'),
   ('كنت غاضباً سابقاً، الآن حلت المشكلة وأنا راضٍ جداً.','positive','resolved_history'),
   ('I am worried that my support payment will not arrive.','negative','worry'),
   ('أنا قلق بشأن وصول دفعة الدعم.','negative','worry'),
   ('Wonderful service: you lost my application again. What an amazing failure.','negative','sarcasm'),
   ('يا سلام على الخدمة! ضيعتوا طلبي مرة ثانية، خدمة فاشلة.','negative','sarcasm'),
   ('...','needs_clarification','incomplete'),
   ('طل...','needs_clarification','incomplete'),
   ('Help me check my application.','neutral','missing_business_id'),
   ('ساعدني في الاستعلام عن الطلب.','neutral','missing_business_id'),
   ('CMP-MOCK-001','neutral','business_id_answer'),
   ('شكراً، رقم الطلب APP-MOCK-001.','positive','business_id_answer'),
   ('I have equally positive and negative feelings about the current result; I cannot say which prevails.','needs_clarification','ambiguous_current_attitude'),
   ('مشاعري الحالية إيجابية وسلبية بالتساوي، لا أستطيع تحديد الغالب.','needs_clarification','ambiguous_current_attitude'),
   ('An open hole exists near the walkway; I am reporting a fact, without expressing feelings.','neutral','hazard_fact'),
   ('هناك حفرة مفتوحة قرب الممر، أصف الواقع فقط دون التعبير عن مشاعري.','neutral','hazard_fact')]
  for i,(text,label,tag) in enumerate(boundaries,1):
   cid=f'BOUND-{i:03}';sent=None if label=='needs_clarification' else label;status='needs_clarification' if sent is None else 'classified'
   source={'messages':[{'id':'m1','role':'user','content':text}],'current_message_id':'m1'}
   if tag=='business_id_answer':source['messages'].insert(0,{'id':'a0','role':'assistant','content':'Please provide your complaint or application number.'})
   rows['inputs'].append({'case_id':cid,'input':source});rows['references'].append({'case_id':cid,'reference':{'sentiment':sent,'assessment_status':status,'status':'provisional','evidence':[] if sent in [None,'neutral'] else [{'label':'sentiment:'+sent,'message_id':'m1','quote':text}]}})
   rows['manifest'].append({'case_id':cid,'family_id':'boundary-'+tag,'split':'regression','language':'english' if i%2 else 'msa','tags':[tag],'reference_status':'provisional','provenance':{'generator':'Codex independent contract-boundary authoring','reviewer':None,'real_customer_data':False}})
 elif suite=='engineering':
  rows['inputs'][6]['input']['mutation']={'assessment_status':'invalid_status'}
  rows['inputs'][7]['input']['mutation']={'sentiment':'mixed'}
 elif suite=='integration':
  for row in rows['references']:
   r=row['reference'];ended=False;routes=[];sentiments=[];statuses=[];ends=[];tools=[]
   for route,sent in zip(r['expected_routes'],r['expected_sentiments']):
    if ended:routes.append('session_closed');sentiments.append(None);statuses.append('skipped');tools.append([])
    else:
     current=None if sent=='undetermined' else 'negative' if sent=='mixed' else sent
     action='clarify' if current is None else 'human' if current=='negative' else 'agent'
     routes.append(action);sentiments.append(current);statuses.append('needs_clarification' if current is None else 'classified');tools.append(['crm940_complaint_get'] if action=='agent' else [])
     if action=='human' and r['handoff_state']!='failed':ended=True
    ends.append(ended)
   r.update(expected_routes=routes,expected_sentiments=sentiments,expected_assessment_statuses=statuses,expected_session_ended=ends,business_tools_by_turn=tools)
  extra=[
   (["Check my complaint status.","CMP-MOCK-001"],['neutral','neutral'],['agent','agent'],[[],['crm940_complaint_get']],'queued','business_number_continuation'),
   (["...","Check CMP-MOCK-001 status."],[None,'neutral'],['clarify','agent'],[[],['crm940_complaint_get']],'queued','clarification_recovery'),
   (["Thanks, but I am disappointed that you did not resolve my issue."],['negative'],['human'],[[]],'queued','thanks_dissatisfied'),
   (["I used to be angry. Now it is resolved and I am satisfied; check CMP-MOCK-001."],['positive'],['agent'],[['crm940_complaint_get']],'queued','history_satisfied'),
   (["I am worried about my support payment."],['negative'],['human'],[[]],'queued','worry'),
   (["Wonderful service: you lost my application again. What an amazing failure."],['negative'],['human'],[[]],'queued','sarcasm'),
   (["أنا غاضب من الخدمة.","CMP-MOCK-001"],['negative',None],['human','session_closed'],[[],[]],'connected','connected_ends_session'),
   (["I am angry about this service.","Check CMP-MOCK-001 status."],['negative','neutral'],['human','human'],[[],[]],'unavailable','failed_handoff_never_releases'),
   (["أريد معرفة حالة الشكوى.","CMP-MOCK-001"],['neutral','neutral'],['agent','agent'],[[],['crm940_complaint_get']],'queued','arabic_number_continuation'),
   (["???","ما حالة الشكوى CMP-MOCK-001؟"],[None,'neutral'],['clarify','agent'],[[],['crm940_complaint_get']],'queued','arabic_clarification_recovery'),
   (["I have equally positive and negative feelings about the current result; I cannot say which prevails."],[None],['clarify'],[[]],'queued','ambiguous_current_attitude'),
   (["Check CMP-MOCK-001 status.","Thank you, I am satisfied.","Now I am angry about your service.","/resume Check CMP-MOCK-001"],['neutral','positive','negative',None],['agent','agent','human','session_closed'],[['crm940_complaint_get'],[],[],[]],'queued','emotion_changes_session_boundary')]
  for i,(texts,sents,routes,tools,scenario,tag) in enumerate(extra,1):
   cid=f'FLOW-{i:03}';ends=[];ended=False
   for route in routes:
    if route=='human' and scenario!='unavailable':ended=True
    ends.append(ended)
   rows['inputs'].append({'case_id':cid,'input':{'actor':'citizen-a','turns':[{'message':t} for t in texts],'handoff_scenario':scenario}})
   rows['references'].append({'case_id':cid,'reference':{'expected_routes':routes,'expected_sentiments':sents,'expected_assessment_statuses':['skipped' if route=='session_closed' else 'needs_clarification' if s is None else 'classified' for route,s in zip(routes,sents)],'expected_session_ended':ends,'business_tools_by_turn':tools,'handoff_state':'failed' if scenario=='unavailable' else scenario,'status':'provisional'}})
   rows['manifest'].append({'case_id':cid,'family_id':'flow-'+tag,'split':'regression','language':'arabic' if i in [7,9,10] else 'english','tags':[tag],'reference_status':'provisional','provenance':{'generator':'Codex authored V3 conversation policy','reviewer':None,'real_customer_data':False}})
 for name,records in rows.items():write(NEW/suite/(name+'.jsonl'),records)
 # Preserve 600 original input rows exactly; the new rows follow the untouched bytes.
 if suite=='emotion':
  original=(OLD/suite/'inputs.jsonl').read_bytes();added=''.join(json.dumps(r,ensure_ascii=False,sort_keys=True)+'\n' for r in rows['inputs'][600:]).encode();(NEW/suite/'inputs.jsonl').write_bytes(original+added)
 # All planning records are strictly identical, not relabeled from this run.
 if suite=='planning':
  for name in ['inputs','references','manifest']:shutil.copy2(OLD/suite/(name+'.jsonl'),NEW/suite/(name+'.jsonl'))
(NEW/'migration.json').write_text(json.dumps({'version':'v3.0','source':'v2.0','original_emotion_inputs':600,'input_bytes_preserved':True,'core_reference_changes':changes,'removed_reference_fields':['indicators','emotions'],'evidence_policy':'Only assigned sentiment evidence retained; scenario and diagnostic-emotion evidence removed. Core reference may omit evidence.','engineering_changes':{'ENG-007':'Unregistered assessment status replaces retired scenario-label test.','ENG-008':'Unregistered sentiment test replaces historical intent-label test.'},'integration':'32 original inputs preserved; references honor precedence, clarification, accepted handoff session closure; 12 new boundary flows.','no_tested_model_reference_grading':True,'reference_status':'provisional_synthetic','old_scores_comparable':False},ensure_ascii=False,indent=2)+'\n')
(NEW/'README.md').write_text('# V3.0 frozen release\n\n620 emotion cases = 600 byte-preserved original inputs + 20 boundary cases; 80 unchanged planning contracts; 44 integration cases = 32 original inputs + 12 new flows; 60 migrated engineering cases. References evaluate sentiment + assessment_status. Diagnostic emotions are optional in references and excluded from quality scoring. See migration.json for semantic decisions.\n\nSynthetic provisional labels require language/domain expert review. Previously viewed holdout is regression evidence, not a blind test. Five-class historical scores cannot be directly compared with this release. Human acceptance is a simulated receipt, never a real staff connection.\n')
files={str(p.relative_to(ROOT)):digest(p) for p in sorted(NEW.rglob('*')) if p.is_file()};files['scripts/generate-v3-datasets.py']=digest(Path(__file__))
release=hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest();(NEW/'freeze.json').write_text(json.dumps({'version':'v3.0','contract_version':'emotion-v3.0.0','release_digest':release,'files':files,'reference_status':'provisional_synthetic'},indent=2)+'\n')
print(json.dumps({'published':'v3.0','emotion':620,'planning':80,'integration':44,'engineering':60,'release_digest':release}))
