import { parseArgs } from 'node:util';
import { dirname,relative } from 'node:path';
import { readdir,writeFile } from 'node:fs/promises';
import { readJSON,readJSONL,writeJSON,now } from '../src/util.mjs';
import { loadV2Suite,sourceFingerprintV2 } from '../src/evaluate-v2.mjs';
import { emotionMetrics,planningMetrics } from '../src/v2-metrics.mjs';
const {values}=parseArgs({options:{split:{type:'string',default:'all'},output:{type:'string',default:'reports/latest-v3.md'}}});
const pct=v=>typeof v==='number'?(v*100).toFixed(2)+'%':'—';
const link=(label,p)=>`[${label}](${relative(dirname(values.output),p)})`;
const table=(headers,rows)=>[headers,headers.map(()=> '---'),...rows].map(row=>'| '+row.join(' | ')+' |').join('\n');
const index=await readJSONL('reports/history/index.jsonl'),current=await sourceFingerprintV2(),runs={};
for(const suite of ['emotion','planning','integration','engineering']){
 const item=[...index].reverse().find(r=>r.dataset_version==='v3.0'&&r.suite===suite&&r.split===values.split);if(!item)throw Error('Missing current V3 '+suite);
 const directory=dirname(item.report),[config,summary,rows,dataset]=await Promise.all([readJSON(directory+'/config.json'),readJSON(directory+'/summary.json'),readJSON(directory+'/results.json'),loadV2Suite(suite,values.split)]);
 const ids=rows.map(r=>r.case_id),expected=dataset.selected.map(r=>r.case_id);
 if(summary.status!=='finished'||!summary.source_consistent||config.source.hash!==current.hash||ids.length!==expected.length||new Set(ids).size!==expected.length||expected.some(id=>!ids.includes(id))||summary.metrics.cases!==expected.length||config.release_digest!==dataset.release_digest||config.analyzer_version!=='emotion-v3.0.0')throw Error('Not a complete matching-current-source V3 run: '+suite);
 const failures=rows.filter(r=>r.error||r.pass===false||r.score?.pass===false).map(r=>({case_id:r.case_id,input:r.input,expected:suite==='emotion'?{sentiment:r.reference.sentiment,assessment_status:r.reference.assessment_status}:r.reference,actual:suite==='emotion'?r.prediction:r.result??r.turns,failures:r.score?.failures??r.error??r.route_scores??['core_pair_mismatch'],path:directory+'/cases/'+r.case_id+'.json'}));
 runs[suite]={directory,config,summary,failures,rows};
}
let gate=null;for(const name of (await readdir('reports/gates')).sort().reverse()){
 if(!name.endsWith('.json'))continue;const r=await readJSON('reports/gates/'+name);
 if(r.runs?.length===4&&r.runs.every(x=>runs[x.suite]?.directory===x.directory)){gate={path:'reports/gates/'+name,...r};break;}
}
const e=runs.emotion.summary.metrics,p=runs.planning.summary.metrics,i=runs.integration.summary.metrics,g=runs.engineering.summary.metrics;
const neg=e.sentiment.per_label.negative,clar=e.assessment_status.per_label.needs_clarification;
const classificationFailures=runs.emotion.failures;
const byLanguage=Object.fromEntries([...new Set(runs.emotion.rows.map(r=>r.manifest.language))].map(language=>[language,emotionMetrics(runs.emotion.rows.filter(r=>r.manifest.language===language))]));
const original600=emotionMetrics(runs.emotion.rows.filter(r=>r.case_id.startsWith('SEM-'))),boundaries=emotionMetrics(runs.emotion.rows.filter(r=>r.case_id.startsWith('BOUND-')));
let verification=null;try{const v=await readJSON('reports/verification-v3.json');if(v.source_hash===current.hash&&v.passed)verification=v;}catch(error){if(error.code!=='ENOENT')throw error;}
const fragments=[
 '# POC V3：三张任务卡的实现与全量回归',
 `生成时间 ${now()}。DeepSeek ${runs.emotion.config.emotion_model}；规划 ${runs.planning.config.planner_provider}/${runs.planning.config.planner_model}，Pi SDK 1.1.0，${runs.planning.config.strategy}，${runs.planning.config.catalog_count} 个业务工具。四组使用同一当前源码，开始/结束指纹一致。`,
 table(['测试','案例','结果'],[
  ['独立情感',e.cases,`三类 Accuracy ${pct(e.sentiment.accuracy)}；Macro-F1 ${pct(e.sentiment.macro_f1)}；核心匹配率 ${pct(e.core_match)}`],
  ['负面识别',neg.support,`Precision ${pct(neg.precision)}；Recall ${pct(neg.recall)}；F1 ${pct(neg.f1)}；FP ${neg.fp} / FN ${neg.fn}`],
  ['澄清状态',clar.support,`Precision ${pct(clar.precision)}；Recall ${pct(clar.recall)}；F1 ${pct(clar.f1)}；FP ${clar.fp} / FN ${clar.fn}`],
  ['独立动态规划',p.cases,`工具 P/R/F1 ${pct(p.tool_selection.precision)} / ${pct(p.tool_selection.recall)} / ${pct(p.tool_selection.f1)}；严格任务 ${p.task_pass}/${p.task_graded}`],
  ['完整流程',i.cases,`任务 ${i.pass}/${i.cases}；${i.turns} 轮路由 ${pct(i.route_accuracy)}；人工选择 F1 ${pct(i.handoff_selection.f1)}；禁止路径分发 ${i.forbidden_business_dispatches} / 尝试 ${i.forbidden_business_attempts}`],
  ['工程契约',g.cases,`${g.pass}/${g.cases}；离线，不调用模型`]
 ]),
 `回归门槛：${gate?link(gate.passed?'通过':'未通过',gate.path):'未找到匹配的四组门槛报告，不能推断通过'}。${gate?gate.runs.flatMap(r=>r.checks.filter(c=>!c.passed).map(c=>`${r.suite}: ${c.name} = ${JSON.stringify(c.observed??null)}，要求 ${JSON.stringify(c.required??null)}`)).join('；'):''}`,
 ...(verification?[`附加验收：Node ${verification.node_tests.passed}/${verification.node_tests.total}、Python ${verification.python_tests.passed}/${verification.python_tests.total}，语法与凭证扫描通过。${link('验收记录','reports/verification-v3.json')}；${link('修改清单与运行说明','docs/task-cards-v3-delivery.md')}。实际页面已核验三类标签、待补充信息、当前模板与历史报告。`]:[]),
 '## 三张卡交付及迁移',
 '当前运行输出与新模板不含固定场景 indicators 字段；规划继续读取原话和会话。当前评分只计算情感与判定状态，七类诊断情绪仍输出并做结构与原话证据校验，合法标签变化不改变核心评分和路由。原始 JSON 保留这些输出供调试，报告没有诊断情绪效果指标。',
 'classified 对应 positive / neutral / negative；needs_clarification 对应 null。业务编号不足不等于情感不确定。每条完整自助用户消息分析一次；内部规划和工具结果不重复分析。负面及分析失败请求模拟人工，待补充信息请求澄清；两条禁止路径均不得调用业务工具。人工系统的 accepted 回执使会话结束，后续 session_closed 轮次不调用模型或规划器，旧 /resume 不能重启。交接失败保持暂停，不回退业务。',
 `数据迁移：${link('逐案依据','datasets/v3.0/migration.json')}；620 条情感中原 600 输入原文保持不变，另加 20 边界；44 个流程中原 32 输入保持不变，另加 12 多轮；80 规划输入和参考字节不变；60 工程迁移契约。旧版源码 ${link('V2 归档','archive/v2.0.0/ARCHIVE.md')} 已核对历史运行源码 hash。V1/V2 冻结数据、导入版本和报告保留，新旧版本分别标识。五类历史分数不能直接用作三类模型对比分数。`,
 '## 口径、分母和逐类结果',
 e.definition,
 table(['Sentiment','参考正例','Precision','Recall','F1','FP / FN'],Object.entries(e.sentiment.per_label).map(([k,m])=>[k,m.support,pct(m.precision),pct(m.recall),pct(m.f1),`${m.fp} / ${m.fn}`])),
 table(['判定状态','参考正例','Precision','Recall','F1','FP / FN'],Object.entries(e.assessment_status.per_label).map(([k,m])=>[k,m.support,pct(m.precision),pct(m.recall),pct(m.f1),`${m.fp} / ${m.fn}`])),
 `Sentiment Accuracy 分母 ${e.sentiment.classified_reference_cases}，正确 ${e.sentiment.correct}；核心匹配分母 ${e.cases}，正确 ${e.core_matches}。最终运行契约有效率 ${pct(e.valid_rate)}，初次 ${pct(e.initial_valid_rate)}。证据检查为原文片段存在性，不是独立语义裁定。`,
 table(['数据范围','案例','三类 Accuracy','Macro-F1','核心匹配率'],[['原 600 条输入的新版参考',original600.cases,pct(original600.sentiment.accuracy),pct(original600.sentiment.macro_f1),pct(original600.core_match)],['新增边界',boundaries.cases,pct(boundaries.sentiment.accuracy),pct(boundaries.sentiment.macro_f1),pct(boundaries.core_match)]]),
 table(['语言生成标签','案例','Accuracy','Macro-F1'],Object.entries(byLanguage).map(([l,m])=>[l,m.cases,pct(m.sentiment.accuracy),pct(m.sentiment.macro_f1)])),
 `工具 Precision=${p.tool_selection.correct_selected}/${p.tool_selection.selected}；Recall=${p.tool_selection.required_hit}/${p.tool_selection.required}，每案对不同业务工具去重，含 proposal 与拦截尝试；参数、对象、依赖、分轮状态和实际回执另计严格任务评分。完整流程还检查情感及判定状态、人工回执、会话关闭与业务调用。人工模型渠道均为模拟，handoff_transferred 始终 false。`,
 '## 失败案例',
 ...Object.entries(runs).map(([suite,r])=>`${suite}：${r.failures.length?r.failures.map(f=>link(f.case_id,f.path)).join('、'):'无失败'}。`),
 '全部失败及输入、预测和依据保存在 latest-v3.json 和对应 cases 文件中。分类失误会影响负面人工路由；完整流程小规模场景通过不能代替全部文本的情感质量。所有失败如实保留，不修改冻结参考或降低门槛。',
 ...(classificationFailures.length?[table(['情感用例','参考','预测'],classificationFailures.slice(0,12).map(f=>[link(f.case_id,f.path),`${f.expected.sentiment??'null'} + ${f.expected.assessment_status}`,`${f.actual?.sentiment??'null'} + ${f.actual?.assessment_status??'invalid'}`]))]:[]),
 '## 可复现命令与报告',
 '```bash\nnpm test\nnpm run test:mocks\nnpm run check\nnpm run eval:emotion\nnpm run eval:planning\nnpm run eval:integration\nnpm run poc -- eval --suite engineering --mode offline --split all\nnode scripts/check-v2-regression.mjs --suite all --split all --require-current-source\nnode scripts/summarize-v3.mjs --split all\nnpm run web\n```',
 table(['模块','实际全量记录','请求数','Tokens'],Object.entries(runs).map(([suite,r])=>[suite,link(r.config.run_id,r.directory+'/report.md'),r.summary.budget.requests,r.summary.budget.tokens])),
 `当前源码 SHA256：\`${current.hash}\`。冻结 release_digest：\`${runs.emotion.config.release_digest}\`。输入、模型输出、参考、工具参数、回执、oracle、配置和预算均保存。Web 查看历史中的上述 run ID，进入结果和逐案详情。操作指南 ${link('Web 使用指南','docs/web-poc-guide.md')}；实现 ${link('V3 方案','docs/government-entry-agent-poc-v3.md')}。`,
 '合成参考仍需语言与政府业务专家审核，已有 holdout 是回归证据，不是新盲测。澄清指标没有擅自新增验收阈值；既有有效率、情感 Macro-F1、规划、流程和工程门槛保留。场景指标门槛按任务卡1范围退役，诊断情绪效果门槛按任务卡3范围退役，原因记录在回归策略。未进行生产客服平台接入或 32–256 工具的全量规模评测。'
];
const record={version:'v3.0',created_at:now(),source_hash:current.hash,split:values.split,production_ready:false,gate,verification,original_600_metrics:original600,boundary_metrics:boundaries,by_language:byLanguage,runs:Object.fromEntries(Object.entries(runs).map(([k,{rows,...r}])=>[k,r]))};
await writeFile(values.output,fragments.join('\n\n')+'\n');await writeJSON(values.output.replace(/\.md$/,'.json'),record);console.log(JSON.stringify({report:values.output,gate_passed:gate?.passed,runs:Object.fromEntries(Object.entries(runs).map(([k,r])=>[k,r.config.run_id]))}));
