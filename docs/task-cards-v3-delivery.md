# 三张任务卡 V3 交付清单

三张卡已经合并到默认 CLI 和 Web 运行链路。当前契约 emotion-v3.0.0，冻结数据 v3.0，回归策略 exploratory-v3.0.0。Pi 动态规划实现保持可替换，不新增中央业务目的枚举。

| 修改位置 | 交付行为 |
|---|---|
| `src/contracts.mjs`、`src/analyzer.mjs` | 删除场景指标与对应证据；三类 Sentiment + 独立 assessment_status；七类诊断情绪保留；输出与参考分开校验 |
| `src/routing.mjs` | 正面/中性进规划；负面或分析失败请求模拟人工；待补充信息不调用业务；accepted 回执关闭会话；失败不自动放行业务；每轮调用计数不混入历史调用 |
| `src/v2-metrics.mjs`、`src/scoring.mjs`、`src/evaluate-v2.mjs` | 核心匹配只检查 sentiment + assessment_status；情感/澄清/工具指标及明确分母；流程检查情感、路由、回执、工具和会话结束 |
| `src/web-data.mjs`、`src/web-jobs.mjs` | 当前模板、导入参考、版本选择同步；旧导入集只供浏览；历史中断任务沿用对应历史评分逻辑；旧报告继续查看 |
| `web/app.js`、`web/index.html` | 显示三类情感及待补充信息；当前结果不展示退休效果指标；旧版指标仅在历史记录中展示；兼容数据列表排除旧导入契约 |
| `scripts/generate-v3-datasets.py`、`datasets/v3.0` | 发布新冻结参考；600 原输入字节保持，20 新情感边界；80 规划字节不变；32 原流程输入保持，12 新流程；60 工程迁移 |
| `scripts/regression-policy.mjs`、`scripts/check-v2-regression.mjs` | 适用原门槛保留；场景指标和诊断情绪效果门槛按三张卡范围退役并记录原因；只读取当前冻结版本 |
| `scripts/summarize-v3.mjs` | 当前报告及失败案例汇总；原 600 和新增边界分别报告；旧五类分数不直接比较三类分数 |
| `tests/v3-contract.test.mjs`、现有 Node 测试 | 契约配对、非法标签、诊断情绪独立性、澄清、编号续接、人工失败及完成、会话结束后不再分析、多轮计数、历史与模板兼容 |
| `README.md`、V3 方案与 Web 指南 | 当前命令、模板、版本、指标及会话边界同步 |
| `archive/v2.0.0` | 原 V2 运行代码、插件、模拟服务和页面完整归档，逐文件匹配历史运行源码指纹 |

原 V1/V2 冻结文件、导入数据和历史报告保持原状。旧版本 schema 不静默转换；导入旧数据时，先按当前规则裁定情感和澄清状态，再使用新模板重新导入。`mixed` 的15条原参考根据当前结果不满重裁为负面；原8条未完成/无法判定表达改为 null + needs_clarification。逐案依据在 [迁移记录](../datasets/v3.0/migration.json)。

## 最终证据

[完整评测报告](../reports/latest-v3.md) 包含三类 Accuracy/Macro-F1、负面 P/R/F1、澄清状态识别、路由、工具选择、零禁止路径调用及全部21条核心失败案例。[JSON报告](../reports/latest-v3.json) 保留逐案输入、预测和依据。

[验收检查记录](../reports/verification-v3.json) 验证输出、参考、原文保持、旧冻结 hash、归档源码、每轮禁止调用及关闭会话不分析。Node 74/74、Python 26/26、工程 60/60；语法和凭证扫描通过。实际浏览器已核验新版指标、三类标签、待补充信息、无 Emotions 参考的导入预览、历史五类报告及无浏览器报错。

[最终页面截图](../reports/v3-assets/emotion-results.jpg) 为实际运行结果，所有后方和人工交接仍为模拟。合成暂定标签需专家审核；目前的分数是 POC 回归证据。

## 运行与查看

```bash
npm test
npm run test:mocks
npm run check
npm run eval:emotion
npm run eval:planning
npm run eval:integration
npm run poc -- eval --suite engineering --mode offline --split all
node scripts/check-v2-regression.mjs --suite all --split all --require-current-source
node scripts/summarize-v3.mjs --split all
npm run web
```

打开 http://127.0.0.1:8787，选择「历史运行」中的 V3 记录，查看评分和逐案详情。「结果筛选 → 评分未通过」可以定位情感错误。命令行日志打印具体报告路径；每次重跑创建独立记录，不覆盖本次结果。门槛和源码检查要求完整同版本记录；子集烟测不能视为全量回归。

| 最终模块 | 报告目录 |
|---|---|
| 情感620条 | `reports/history/2026-10-09T19-20-43-551Z-b477cfa5/` |
| 规划80条 | `reports/history/2026-10-09T19-20-45-662Z-1061c448/` |
| 完整流程44场景 | `reports/history/2026-10-09T19-20-47-918Z-079af937/` |
| 工程60条 | `reports/history/2026-10-09T19-20-51-040Z-bf12abcd/` |

最终门槛 [全部通过](../reports/gates/2026-10-09T19-22-30-451Z-0028f8bc.json)，保留适用的原探索阈值。没有把旧五类分数当作新三类的提升幅度，也未调整冻结参考来消除实际失败。
