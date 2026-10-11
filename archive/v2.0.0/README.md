# MOMAH POC V2

已实现：独立情绪分析模块 + 独立动态规划模块 + 宿主情绪路由。规划使用 Pi SDK 1.1.0 Agent Loop，实际验证模型为 DeepSeek `deepseek-flash`。情绪模块不输出业务 intents；规划从版本化插件目录选择能力，不维护中央业务意图枚举。当前不接知识库。

BALADY（城市规划、土地使用证书与变更）、SAKANI（补贴）、940（投诉）是 HTTP API mock；FURAS（投资建议）是任务式 Agent mock，共 16 个业务操作。后方和人工渠道均在本地模拟，身份、政策、规则、机会均虚构。

结果见 [V2 最新评测报告](reports/latest-v2.md)，实现见 [V2 设计与扩展说明](docs/government-entry-agent-poc-v2.md)。

## 准备

需要 Node >=22.19、Python >=3.12。在项目目录运行：

```bash
npm ci --ignore-scripts
# 仅首次配置：已有 .env 时直接使用，不覆盖
cp -n .env.example .env
chmod 600 .env
# 在本地填写 DEEPSEEK_API_KEY，勿打印或提交
npm run probe
```

`EMOTION_MODEL`、`PLANNER_MODEL` 可分别配置；未指定时使用 `DEEPSEEK_MODEL`。live 测试每次实际调用 API。

## Web 评测台

```bash
npm run web
```

打开 <http://127.0.0.1:8787>。中文页面提供测试数据浏览、模块与插件目录、测试运行、结果详情、JSON/JSONL 模板及导入预览、历史查询与再次运行。情绪和规划模型分别选择；高级配置提供案例子集、并发、预算及工具目录规模。

真实取消会中止模型 / Pi / 后方请求及后续调度，并保留部分结果。仅输入的数据保存输出与 Trace，标记为未评分。任务和导入版本在本地持久保存，刷新不重新发起调用；服务重启后可查看历史，异常中断不会自动重发请求。完整说明见 [Web 使用指南](docs/web-poc-guide.md)。

## 手动测试两个模块

```bash
# 仅情绪分析，无业务工具/规划
npm run poc -- emotion "I am angry about your terrible service."
# 仅动态规划，无情绪分析/路由
npm run poc -- plan "Check my complaint CMP-MOCK-001 status."
# 多轮独立规划
npm run poc -- plan
```

跨系统例子：`Find cafe investment opportunities in Jeddah with a budget of 250000 SAR, and show the contact history of complaint CMP-MOCK-001.` 应选择 FURAS 和 940。缺参数则追问；写操作先显示精确 proposal，输入 `/confirm` 才批准该 proposal。身份、确认凭据和幂等键由宿主生成。

## 测试完整 POC

```bash
npm run poc -- chat
```

依次输入：

```text
What is the status of my complaint CMP-MOCK-001?
I am angry about your terrible service. Check CMP-MOCK-001.
Check CMP-MOCK-001 status.
/resume What is the status of my complaint CMP-MOCK-001?
exit
```

预期：正常请求调用 940；负面进入模拟人工队列且停止业务执行；随后普通消息仍保持人工接管；明确 `/resume` 且情绪允许自助后恢复。mixed、undetermined 走澄清；分析失败走人工。人工不可用时暂停自动办理并明确转接失败。

```bash
npm run poc -- chat --handoff-scenario unavailable "I am angry about your terrible service."
npm run poc -- chat --handoff-scenario connected "I am angry about your terrible service."
```

`queued`、`connected`、`unavailable` 都是模拟状态，始终标记 `handoff_simulated: true`、`handoff_transferred: false`。`/resume` 是 POC 宿主控制命令，真实人工系统需要可靠的接管和释放协议。

## 独立评测与自动回归

```bash
npm run eval:emotion        # 600 条独立情绪实测
npm run eval:planning       # 80 条独立规划/工具选择实测
npm run eval:integration    # 32 个多轮路由场景
npm run poc -- eval --suite engineering --mode offline --split all  # 60 条
node scripts/check-v2-regression.mjs --suite all --split all --require-current-source
node scripts/summarize-v2.mjs
```

快速检查 / CI regression split：

```bash
npm test
npm run test:mocks
npm run eval:offline
node scripts/check-v2-regression.mjs --suite engineering --require-current-source
npm run eval:live
node scripts/check-v2-regression.mjs --suite all --require-current-source
npm run check
```

默认冻结数据集 `datasets/v2.0`，input/reference/manifest 物理分离，执行完成后才评分。`--split dev|regression|holdout|all`、`--limit 8`、`--case-ids PLAN-20-2` 可缩小范围。有限样本不替代完整 split 的回归门槛。

工具 Precision = 正确选择数量 / 全部选择数量；Recall = 命中必需工具数量 / 必需工具数量。每案按不同业务工具计数，额外允许的工具不扣 Precision；proposal 和被宿主拦截的尝试也计入选择。`skill_read`、`submit_result` 等控制工具不计入。另报严格任务通过率，检查参数、对象、顺序、状态及实际后方结果。

回归门槛检查冻结样本覆盖、源码一致性、执行错误和质量指标；失败退出 1，报告保存到 `reports/gates/`。阈值为 POC 探索阈值，不代表生产验收。情绪误报导致门槛失败时保留失败报告，不修改参考或阈值掩盖。GitHub Actions 已配置，尚未远端运行；手动 live 工作流需仓库 API secret。

## 如何查看结果

终端每次打印 `report` 路径，可在 Codex 或编辑器直接打开：

- `reports/latest-v2.md`：中文总览、模块指标、失败用例、局限。
- `reports/history/<run-id>/report.md`、`summary.json`：该次指标。
- `config.json`：模型、隔离方式、数据版本、源码和插件 hash。
- `cases/<case-id>.json`：逐案预测、目标、参数、回执、mock oracle、评分。
- `reports/manual/<time-id>/session.json`：手动会话记录；情绪单测为单独 JSON。
- `reports/history/index.jsonl`：追加式历史索引，旧报告保留。

公开回答由宿主从回执生成事实 JSON；模型自然语言存为 `draft_answer` 供审查，尚未接数字人 UI。`--output reports/manual/my-session.json` 可自定手动路径；重复用同一路径会覆盖该手动记录。

手动 chat 的 `turns[*].business_dispatches` 是截至该轮的累计数量；看本轮是否执行，应查看 `planner.trace` 的 business 事件及对应 turn。integration 的逐案文件另外保留每轮 `business` 列表，回归禁止调用指标按该轮列表计算。

## 替换模型与添加系统

```bash
npm run poc -- eval --suite emotion --emotion-model MODEL_NAME --split regression
npm run poc -- eval --suite planning --planner-model MODEL_NAME --split regression
npm run poc -- plan --strategy layered --catalog-count 256
```

跨供应商时，情绪模块替换注入的 `emotionClient`；规划使用 Pi provider 和对应 API key。仅 DeepSeek 做过 live 验证，其他供应商需检查 JSON/工具协议并重新评测。

新增系统提供 `plugins/<system>/manifest.json`、`SKILL.md`、宿主适配器，能力契约含参数、操作、对象字段和完成回执条件。新增数据发布新冻结版本；跑新增、受影响和完整旧 regression 用例。第五个 FEES 的 SDK 脚本测试已证明无需中央 intents 枚举，但未做第五系统 live 准确率实验。扩容目录含模拟干扰工具，不能代表大量真实异构系统准确率。

合成 provisional 参考尚无沙特母语/业务专家审核；旧 holdout 已查看，不能称新盲测。业务会话和幂等仍在内存，不恢复正在办理的业务流程；Web 评测任务和结果已持久保存，异常任务只恢复查看，不自动继续执行；FURAS 是脚本协议，人工是本地模拟。宿主校验声明动作/资源与回执自洽，不能独立证明声明覆盖全部隐含目的。

[V1 历史设计](docs/government-entry-agent-poc-v1.md) · [V1 历史结果](reports/latest-summary.md) · [Mock 接口](poc_mocks/catalog.json) · [宿主契约](docs/mock-contract-v1.md) · [数据限制](datasets/v2.0/README.md)
