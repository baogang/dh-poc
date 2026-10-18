# SENTRA 感知引擎 V3

工单客服独立演示：[Road PI SDK PoC](docs/road-pothole-pi-poc.md)，使用 FAQ → 三分类情绪 → PI Loop / 模拟人工路由，支持普通查询自动执行及精确操作 HITL。会话和反馈保存到 Neon，配置现有 `ROAD_FEEDBACK_DATABASE_URL` 或独立 `ROAD_SESSION_DATABASE_URL` 后运行 `npm run road:web`。[会话管理、容量实测与水平扩展方案](docs/road-session-management.md)。本页其余内容介绍原 SENTRA 评测工作台。

SENTRA 是本 POC 的名称，覆盖情绪识别、动态规划与自动化评测。

已实现独立情感分析、独立 Pi 动态规划及完整情感路由。当前输出三类 Sentiment 与独立 `assessment_status`；保留七类 Emotions 供运行调试，当前效果评测只检查核心情感、澄清、路由与工具任务。规划从用户原话、上下文和版本化插件目录理解目标，不维护中央业务意图枚举。

BALADY（城市规划、土地使用证书与变更）、SAKANI（补贴）、940（投诉）是 HTTP API mock；FURAS（投资建议）是任务 Agent mock，共 16 个业务操作。身份、政策、规则、机会和人工交接均为本地模拟。当前不接知识库。

[设计与扩展说明](docs/government-entry-agent-poc-v3.md) · [Web 使用指南](docs/web-poc-guide.md) · [增加情绪分析测试用例图解](docs/emotion-test-cases-guide.md) · [V3 测试报告](reports/latest-v3.md) · [数据迁移依据](datasets/v3.0/migration.json)。

## 启动和手动测试

需要 Node ≥22.19、Python 3。已有 `.env` 的模型凭证继续使用，不覆盖或打印。初次安装运行 `npm ci --ignore-scripts`；通过 `.env.example` 配置 `DEEPSEEK_API_KEY`。

```bash
npm run web
# 浏览器打开 http://127.0.0.1:8787
npm run poc -- emotion "Thanks, but I am disappointed that the issue remains unresolved."
npm run poc -- emotion "..."
npm run poc -- plan "Check CMP-MOCK-001 status."
npm run poc -- chat
```

`plan` 只调用规划器；`emotion` 只调用情感模型；`chat` 每条自助用户消息先分析，正面/中性进规划，负面转模拟人工，待补充信息请求澄清。业务编号缺失由规划器追问，补充后继续同一任务。输入 `/confirm` 批准当前精确写入提案，`exit` 退出。

人工系统返回接收回执后，本次 Agent 会话结束。后续消息由会话服务处理，不会重新分析或规划，旧版 `/resume` 不再恢复这个会话。交接失败会明确说明并暂停自动业务，不能当作成功接收。

## 公网演示部署

公网演示可使用 [Render Free 部署指南](docs/render-deploy.md)：通过根目录 `render.yaml` 创建带访问密码的 Docker Web Service。无需数据库；模型 Key 在 Render 中设置。免费服务的导入数据和报告会随重启、休眠或重新部署丢失，留存前请下载。

## 全量回归和报告

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
```

当前冻结 V3 数据：情感 620、规划 80、完整流程 44、工程 60。600 个原情感输入和 32 个原流程输入保留；边界案例与语义迁移另行记录。门槛不通过时退出 1，并保留失败案例。测试使用 DeepSeek 真实调用，后方及人工渠道模拟。

`npm run poc -- eval` 可指定 `--suite`、`--split all|dev|regression|holdout`、`--case-ids`、`--limit`、`--concurrency`、`--max-requests`、`--max-tokens`、`--emotion-model`、`--planner-model`、`--strategy flat|layered`、`--catalog-count 16|32|64|128|256`。情感和规划模型可分别替换；默认 DeepSeek `deepseek-flash`，Pi SDK 固定 1.1.0。

每次运行生成独立 `reports/history/<run-id>/`：`config.json` 保存模型、数据与源码指纹；`summary.json` 保存指标；`results.json` 和 `cases/<case-id>.json` 保存输入、预测、参考、修复、工具参数、回执及 oracle。参考在真实执行后进入评分，不提供给模型。历史页可查看原 CLI 和 Web 记录。

Sentiment Accuracy 的分母是参考为 classified 的案例；Macro-F1 是三类等权平均，包含对澄清案例误判的 FP；核心匹配率检查 `sentiment + assessment_status`。参考可不含 Emotions，它们不参与匹配、任务通过或回归门槛。空指标分母显示 —；只有输入的案例不评分。

## Web 数据和任务

页面支持六项功能：数据浏览、模块与插件、测试配置、逐案结果、JSON/JSONL 模板及导入预览、持久化历史。情感与规划模型分别选择；高级设置可限制案例、并发、预算和工具规模。取消实际中止在途请求与调度，保留已完成案例。刷新不重发任务，服务重启后中断任务保留部分结果，不自动重跑。

导入集在 `artifacts/web/datasets/`，任务状态在 `artifacts/web/jobs/`。旧版导入集保留供查看，需迁移后重新导入再运行，不能把旧标签静默用于 V3。模板以当前契约生成；内置数据与导入版本均只读。

## 版本与限制

V3 的合成参考仍需语言与业务专家审核，既有 holdout 已查看，只能作为回归，不能宣称新盲测或生产准确率。完整流程模型和下游模型的替换需重跑同一冻结集及适配契约。

旧 V1/V2 数据和历史报告保留原指标，不与新三类分数直接比较。原 V2 实现归档于 `archive/v2.0.0`；[历史 V2 报告](reports/latest-v2.md) 与 [历史 V2 设计](docs/government-entry-agent-poc-v2.md) 可继续查看。服务默认只监听本机；公网部署使用固定 HTTPS 域名和访问密码。真实客服、会话服务接入、生产持久化与并发接管需要后续工程实现。
