"""Publish immutable emotion-only, planning-only and routing integration references."""
from pathlib import Path
import json,hashlib,shutil

root=Path(__file__).resolve().parents[1]
target=root/'datasets/v2.0'
if (target/'freeze.json').exists():
    raise SystemExit('Already frozen; publish a new dataset version rather than overwrite')
def load(path):return [json.loads(line) for line in path.read_text().splitlines() if line]
def write(path,rows):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(''.join(json.dumps(r,ensure_ascii=False,sort_keys=True)+'\n' for r in rows))
for suite,source in [('emotion','semantic'),('planning','planning'),('engineering','engineering')]:
    for name in ['inputs','references','manifest']:
        records=load(root/f'datasets/v1.2/{source}/{name}.jsonl')
        if suite=='emotion' and name=='references':
            for row in records:
                row['reference'].pop('intents',None)
                row['reference']['evidence']=[e for e in row['reference']['evidence'] if not e['label'].startswith('intent:')]
        write(target/f'{suite}/{name}.jsonl',records)

normal=['ما حالة الشكوى CMP-MOCK-001؟','أريد معرفة حالة شكواي CMP-MOCK-001.','What is the status of my complaint CMP-MOCK-001?','Check my municipal complaint CMP-MOCK-001 status.']
positive=['أنا راضٍ عن خدمتكم وأشكركم، أريد معرفة حالة الشكوى CMP-MOCK-001.','خدمتكم ممتازة وأنا سعيد بها. ما حالة شكواي CMP-MOCK-001؟','I am pleased with your excellent service. Please check complaint CMP-MOCK-001.','Thank you, your service has been wonderful. What is the status of CMP-MOCK-001?']
negative=['أنا غاضب من خدمتكم السيئة. ما حالة شكواي CMP-MOCK-001؟','طفشت من خدمتكم، تعبت من الانتظار. أريد معرفة حالة CMP-MOCK-001.','I am angry about your terrible service. Check complaint CMP-MOCK-001.','Your service is disappointing and I am frustrated. Check CMP-MOCK-001.']
mixed=['أشكركم على الخدمة الممتازة سابقًا لكن خدمتكم اليوم سيئة ومخيبة. ما حالة CMP-MOCK-001؟','أنا سعيد بتعاملكم السابق لكنني غاضب من خدمتكم الحالية.','I appreciate your excellent earlier help, but today your service is terrible and disappointing.','I am happy with the earlier support and angry about the current poor service.']
unknown=['...','???','asdf qwer zxcv','%%%%']
inputs=[];refs=[];manifests=[]
for family in range(1,9):
    for variant in range(4):
        cid=f'ROUTE-{family:02}-{variant+1}'
        texts={1:normal,2:positive,3:negative,4:mixed,5:unknown,6:negative}.get(family)
        turns=[{'message':texts[variant]}] if texts else ([{'message':normal[variant]},{'message':negative[variant]},{'message':normal[variant]}] if family==7 else [{'message':negative[variant]},{'message':normal[variant],'resume':True}])
        routes={1:['agent'],2:['agent'],3:['human'],4:['clarify'],5:['clarify'],6:['human'],7:['agent','human','human'],8:['human','agent']}[family]
        sentiments={1:['neutral'],2:['positive'],3:['negative'],4:['mixed'],5:['undetermined'],6:['negative'],7:['neutral','negative','neutral'],8:['negative','neutral']}[family]
        inputs.append({'case_id':cid,'input':{'actor':'citizen-a','turns':turns,'handoff_scenario':'unavailable' if family==6 else 'queued'}})
        refs.append({'case_id':cid,'reference':{'expected_routes':routes,'expected_sentiments':sentiments,'business_tools_by_turn':[['crm940_complaint_get'] if r=='agent' else [] for r in routes],'handoff_state':'failed' if family==6 else 'queued','status':'provisional'}})
        manifests.append({'case_id':cid,'family_id':f'routing-{family:02}','split':['dev','regression','holdout','regression'][variant],'language':'arabic' if variant<2 else 'english','reference_status':'provisional','provenance':{'generator':'Codex-authored policy scenarios','real_customer_data':False,'reviewer':None}})
for name,records in [('inputs',inputs),('references',refs),('manifest',manifests)]:write(target/f'integration/{name}.jsonl',records)
(target/'README.md').write_text('''# V2 test release\n\n600 emotion-only references derive from v1.2 by removing business intents and their evidence; sentiment/emotion/SA labels are unchanged. 80 planning and 60 engineering contracts are byte-equivalent in JSON meaning to v1.2. 32 new integration cases separately exercise negative-to-human routing, normal business lookup, mixed/undetermined, unavailable handoff, mid-session handoff and explicit self-service resumption.\n\nReferences are synthetic/provisional and not independently reviewed Saudi production labels. Previously inspected holdout splits are regression evidence, not new blind evidence. Planning-only invokes no emotion model. Integration references enter the scorer only after execution. Handoff is a local simulation; no real staff connection.\n''')
files={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(target.rglob('*')) if p.is_file()}
files['scripts/generate-v2-datasets.py']=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
digest=hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()
(target/'freeze.json').write_text(json.dumps({'version':'v2.0','release_digest':digest,'files':files,'reference_status':'provisional_synthetic'},indent=2)+'\n')
print(json.dumps({'published':'v2.0','emotion':600,'planning':80,'integration':32,'engineering':60,'digest':digest}))
