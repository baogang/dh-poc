import { parseArgs } from 'node:util';
import { dirname,relative } from 'node:path';
import { readdir,writeFile } from 'node:fs/promises';
import { readJSON,readJSONL,writeJSON,now } from '../src/util.mjs';
import { loadV2Suite } from '../src/evaluate-v2.mjs';
import { emotionMetrics,planningMetrics } from '../src/v2-metrics.mjs';

const {values}=parseArgs({options:{split:{type:'string',default:'all'},output:{type:'string',default:'reports/latest-v2.md'}}});
const percent=value=>typeof value==='number'?`${(value*100).toFixed(2)}%`:'N/A';
const link=(label,path)=>`[${label}](${relative(dirname(values.output),path)})`;
const table=(head,rows)=>[head.join(' | '),head.map(()=> '---').join(' | '),...rows.map(row=>row.join(' | '))].map(line=>'| '+line+' |').join('\n');
const index=await readJSONL('reports/history/index.jsonl'),runs={};
for(const suite of ['emotion','planning','integration','engineering']){
 const item=[...index].reverse().find(r=>r.dataset_version==='v2.0'&&r.suite===suite&&r.split===values.split);if(!item)throw new Error(`Missing V2 ${suite}/${values.split} evaluation`);
 const directory=dirname(item.report),config=await readJSON(directory+'/config.json'),summary=await readJSON(directory+'/summary.json'),rows=await readJSON(directory+'/results.json'),dataset=await loadV2Suite(suite,values.split);
 const expected=dataset.selected.map(r=>r.case_id),ids=rows.map(r=>r.case_id);
 if(summary.status!=='finished'||ids.length!==expected.length||new Set(ids).size!==expected.length||expected.some(id=>!ids.includes(id))||summary.metrics.cases!==expected.length)throw new Error(`Incomplete frozen ${suite}/${values.split} report`);
 const byLanguage={};for(const language of [...new Set(rows.map(r=>r.manifest?.language??'unspecified'))]){
  const subset=rows.filter(r=>(r.manifest?.language??'unspecified')===language);
  byLanguage[language]=suite==='emotion'?emotionMetrics(subset):suite==='planning'?planningMetrics(subset):{cases:subset.length};
 }
 runs[suite]={directory,config,summary,by_language:byLanguage,failed_cases:rows.filter(r=>r.error||r.pass===false||r.score?.pass===false).map(r=>({case_id:r.case_id,failures:r.score?.failures??r.error??r.route_scores})),rows};
}
let gate=null;
for(const filename of (await readdir('reports/gates')).sort().reverse()){
 if(!filename.endsWith('.json'))continue;const candidate=await readJSON('reports/gates/'+filename);
 if(candidate.runs?.length===4&&candidate.runs.every(r=>runs[r.suite]?.directory===r.directory)){gate={path:'reports/gates/'+filename,...candidate};break;}
}
const emotion=runs.emotion,planning=runs.planning,integration=runs.integration,engineering=runs.engineering,e=emotion.summary.metrics,p=planning.summary.metrics,i=integration.summary.metrics,n=e.sentiment.per_label.negative;
const fp=emotion.rows.filter(r=>r.prediction?.sentiment==='negative'&&r.reference.sentiment!=='negative');
const fn=emotion.rows.filter(r=>r.prediction?.sentiment!=='negative'&&r.reference.sentiment==='negative');
const sourceHashes=[...new Set(Object.values(runs).map(r=>r.config.source.hash))];
let verification=null;
try{const candidate=await readJSON('reports/verification-v2.json');if(sourceHashes.length===1&&candidate.source_hash===sourceHashes[0])verification=candidate;}catch(error){if(error.code!=='ENOENT')throw error;}
const passed=r=>r.checks.every(c=>c.passed);
const gateText=gate?`${link('自动回归门槛报告',gate.path)}：${gate.passed?'通过':'未通过'}。${gate.runs.map(r=>`${r.suite} ${passed(r)?'通过':'未通过'}`).join('；')}。`:'尚无与这四份运行记录完全匹配的 gate 报告，不能推断门槛通过。';
const sections=[
 '# POC V2：独立模块实测与完整流程验证',
 `生成时间：${now()}。冻结数据 V2.0，split=${values.split}。${sourceHashes.length===1?'四组使用同一份源码快照':'各组源码快照不同，详见配置'}；所有运行开始/结束源码一致：${Object.values(runs).every(r=>r.summary.source_consistent===true)}。当前 POC 可按下文运行，情绪质量与生产验收须分别判断。`,
 '## 本次结果',
 table(['模块 / 测试','样本','实际结果'],[
  ['独立情绪分析',e.cases,`Sentiment Accuracy ${percent(e.sentiment.micro.f1)}；Macro-F1 ${percent(e.sentiment.macro_f1)}；标签完全匹配 ${percent(e.exact_match)}`],
  ['7 类 Emotions',e.cases,`Micro P/R/F1 ${percent(e.emotions.micro.precision)} / ${percent(e.emotions.micro.recall)} / ${percent(e.emotions.micro.f1)}`],
  ['SA01–05',e.cases,`Micro P/R/F1 ${percent(e.indicators.micro.precision)} / ${percent(e.indicators.micro.recall)} / ${percent(e.indicators.micro.f1)}`],
  ['独立规划 / 工具选择',p.cases,`Precision ${percent(p.tool_selection.precision)}；Recall ${percent(p.tool_selection.recall)}；F1 ${percent(p.tool_selection.f1)}；严格任务 ${p.task_pass}/${p.cases}`],
  ['完整情绪路由和执行',i.cases,`场景 ${i.pass}/${i.cases}；${i.turns} 轮 route accuracy ${percent(i.route_accuracy)}；禁止路径业务调用 ${i.forbidden_business_dispatches}，尝试 ${i.forbidden_business_attempts}`],
  ['工程故障和宿主契约',engineering.summary.metrics.cases,`${engineering.summary.metrics.pass}/${engineering.summary.metrics.cases}；不调用模型`]
 ]),
 `情绪模型 ${emotion.config.emotion_model}；规划 ${planning.config.planner_provider}/${planning.config.planner_model}，Pi SDK 1.1.0，flat、${planning.config.catalog_count} 个业务工具。情绪独测不调用 Pi/业务工具；规划独测不调用情绪模型或情绪路由。错误退出数：${Object.values(runs).reduce((count,r)=>count+(r.summary.metrics.errors??0),0)}。JSON/原文证据契约最终通过率 ${percent(e.valid_rate)}，初次 ${percent(e.initial_valid_rate)}；结构正确不等于语义正确。`,
 gateText,
 '## 情绪识别：分类结果和路由影响',
 table(['Sentiment','正例数','Precision','Recall','F1','FP / FN'],Object.entries(e.sentiment.per_label).map(([label,m])=>[label,m.support,percent(m.precision),percent(m.recall),percent(m.f1),`${m.fp} / ${m.fn}`])),
 `按冻结参考，negative 误报 ${n.fp} 条、漏报 ${n.fn} 条。将同一规则用于这些文本时，误报会导致不必要的人工路由，漏报则可能放行自助或进入澄清；这 ${e.cases} 条只测分类，没有逐条再跑业务执行。${i.cases} 个明确路由场景通过不能代替更广泛文本上的负面识别质量。`,
 `误报主要出现于“问题未维修、维修后复发、请求跟进”等事实描述，被推断为 frustration/negative；SA 标签也有从复发推断已关单、从等待推断过长的误报。漏报包含 worry/negative 的边界与阿拉伯语讽刺被判 mixed。参考标签仍为 provisional，需专家裁定“报告负面事件”和“表达负面态度”的边界，不能把本次参考直接当生产真值。`,
 '可复查代表用例：'+[...fp.slice(0,3),...fn.slice(0,3)].map(r=>link(r.case_id,`${emotion.directory}/cases/${r.case_id}.json`)).join('、')+'。完整误报/漏报 ID 保存于 latest-v2.json。',
 table(['Emotion','正例数','Precision','Recall','F1'],Object.entries(e.emotions.per_label).map(([label,m])=>[label,m.support,percent(m.precision),percent(m.recall),percent(m.f1)])),
 table(['SA 指标','正例数','Precision','Recall','F1'],Object.entries(e.indicators.per_label).map(([label,m])=>[label,m.support,percent(m.precision),percent(m.recall),percent(m.f1)])),
 'SA01=已关单仍未解决；SA02=同一事项重复联系；SA03=认为等待过长；SA04=当前/可信迫近的人身危险；SA05=实际或报告维修后复发。SA04 高 Recall 不能替代负面路由或其他指标 Precision。',
 '## 动态规划：指标口径和验证范围',
 `Precision = 正确选择 / 全部选择 = ${p.tool_selection.correct_selected}/${p.tool_selection.selected}；Recall = 命中必需工具 / 必需工具 = ${p.tool_selection.required_hit}/${p.tool_selection.required}。每案对不同业务工具去重，额外允许工具不扣 Precision，proposal 与宿主拦截尝试也计入选择；控制工具不计入业务选择。这里报告的是 Precision，不是带大量真阴性的传统分类 Accuracy。`,
 `严格任务通过率 ${percent(p.task_pass_rate)}，另检查参数、资源对象、调用依赖/顺序、每轮状态、回执与实际 mock oracle。覆盖四系统、权限拒绝、追问、写入确认、失败重试、多目标、FURAS 等待/续接/取消。${planning.failed_cases.length?'未通过用例：'+planning.failed_cases.map(r=>link(r.case_id,`${planning.directory}/cases/${r.case_id}.json`)).join('、'):`本次 ${p.cases} 个规划用例无失败。`} 本次未重新做 32–256 工具规模实验；16 工具上的指标不能推及大规模目录。`,
 '## 修复后的完整 POC',
 'positive/neutral → 动态规划；negative → 模拟人工；mixed/undetermined → 澄清；分析失败 → 人工。宿主控制，模型不能覆盖。每次业务调用再次校验许可。人工接管后保持状态，明确 /resume 且情绪正常才恢复；普通消息不自动恢复。转人工清空未确认 proposal，不回滚已完成操作。',
 '本轮修复了两处宿主问题：ticket 释放不得改写历史轮次状态；FURAS 可以保留早期 pending 作为历史，但完成证明必须来自当前有效终态回执。修复前完整全量报告仍保留：'+link('规划 79/80','reports/history/2026-10-09T09-57-02-108Z-00970b9d/report.md')+'、'+link('完整流程 28/32','reports/history/2026-10-09T09-57-09-142Z-fb1dabae/report.md')+'。修复后重跑全部四组，没有改参考标签或放宽情绪门槛；另补充完整流程通过率门槛，避免仅路由正确就掩盖交接失败。',
 '人工 queued/connected/unavailable 仅为本地协议模拟，handoff_transferred 始终 false。FURAS 是脚本任务协议，政府规则、身份和机会均虚构。输出是宿主回执事实 JSON；自然语言 draft 供审查，未接数字人 UI。',
 ...(verification?[`附加验证：Node ${verification.node_tests.passed}/${verification.node_tests.total}，Python mock/数据测试 ${verification.python_tests.passed}/${verification.python_tests.total}；syntax/credential scan 通过。手动 CLI 的独立 ${link('emotion',verification.manual.emotion)}、${link('plan',verification.manual.planning)} 和 ${link('完整 chat',verification.manual.integrated_chat)} 已实际运行。chat 路由 agent → human → human → agent，后方只调用两次查询；人工状态 queued 的历史保留，最终释放。验证记录见 ${link('verification-v2.json','reports/verification-v2.json')}。`]:[]),
 '## 数据与证据',
 '合成 provisional 标签，未做沙特母语/业务专家审核；语言、方言来自生成标签，不表示人工鉴定。600 情绪源于 V1.2，只移除业务 intents；80 规划与 60 工程保持原参考；32 路由为新场景。输入和参考物理分离，执行后才评分。旧 holdout 已查看，不能称新盲测。',
 table(['Suite','dev / regression / holdout','实测记录'],Object.entries(runs).map(([suite,r])=>{
  const counts={dev:0,regression:0,holdout:0};r.rows.forEach(row=>counts[row.manifest.split]++);
  return [suite,`${counts.dev} / ${counts.regression} / ${counts.holdout}`,link(r.config.run_id,r.directory+'/report.md')];
 })),
 table(['情绪语言生成标签','样本','Sentiment Accuracy','Macro-F1'],Object.entries(emotion.by_language).map(([language,m])=>[language,m.cases,percent(m.sentiment.micro.f1),percent(m.sentiment.macro_f1)])),
 `冻结 release_digest：\`${emotion.config.release_digest}\`。源码 hash：${sourceHashes.map(h=>'`'+h+'`').join('、')}。逐案文件记录输出、修复、工具参数、回执和 oracle；config.json 记录模型及完整源码清单。请求总数 ${Object.values(runs).reduce((count,r)=>count+r.summary.budget.requests,0)}；记录总 tokens ${Object.values(runs).reduce((count,r)=>count+r.summary.budget.tokens,0)}。`,
 '## 运行与查看',
 '```bash\nnpm run poc -- emotion "I am angry about your terrible service."\nnpm run poc -- plan "Check CMP-MOCK-001 status."\nnpm run poc -- chat\nnpm run eval:emotion\nnpm run eval:planning\nnpm run eval:integration\nnode scripts/check-v2-regression.mjs --suite all --split all --require-current-source\nnode scripts/summarize-v2.mjs\n```',
 'chat 中正常消息执行，负面消息进入模拟人工；/resume 明确恢复，/confirm 批准精确写入 proposal，exit 退出。终端打印 report 路径。手动记录在 reports/manual/；评测记录在 reports/history/<run-id>/，summary.json 看指标、cases/<id>.json 看逐案 trace。门槛因情绪质量失败会退出 1，属于真实质量结果。完整步骤见 '+link('README','README.md')+'；设计和插件扩展见 '+link('V2 方案','docs/government-entry-agent-poc-v2.md')+'。',
 '两个模型可用 --emotion-model / --planner-model 分别替换并重跑同一冻结集。仅 DeepSeek 已 live 验证；跨供应商还需适配验证。新增系统不修改中央 intents，但必须新增契约/适配器和测试，回归受影响用例及完整旧 regression。当前尚无真实第五系统、大规模业务目录、持久化恢复、并发人工接管验证。'
];
const record={created_at:now(),split:values.split,production_ready:false,gate,verification,source_hashes:sourceHashes,
 negative_false_positives:fp.map(r=>r.case_id),negative_false_negatives:fn.map(r=>r.case_id),
 runs:Object.fromEntries(Object.entries(runs).map(([suite,{rows,...run}])=>[suite,run]))};
await writeFile(values.output,sections.join('\n\n')+'\n');await writeJSON(values.output.replace(/\.md$/,'.json'),record);
console.log(JSON.stringify({report:values.output,gate_passed:gate?.passed??null,runs:Object.fromEntries(Object.entries(runs).map(([suite,r])=>[suite,r.config.run_id]))}));
