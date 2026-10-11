# Semantic Analysis POC v0.2：官方能力与评测证据

核验日期：2026-10-09（Asia/Shanghai）。本文为方案研究记录；没有调用模型、生成测试数据或测得准确率、延迟、成本。核验范围为官方文档及主代理已核验的研究论文。工作区与其祖先目录未发现适用的 `AGENTS.md`。

## 结论

DeepSeek API + LangGraph 可以组成当前 POC 的推理与编排层。LangGraph 支持代码节点与模型节点、状态、条件分支、重试和中断恢复；它不自动统一不同模型的输出与能力。应用仍需模型适配器、稳定业务 schema、本地校验及版本化评测。

Codex/Gemini 可以生成候选样本，Gemini 网页版明确支持阿语，Gemini API 支持结构化输出；这些事实不证明样本具有业务代表性，也不证明 Gemini 在沙特方言或情感分类上优于 DeepSeek。代表性与金标质量来自场景配额、独立复核、真实样本补充及受控评测。

## 官方能力、影响和限制

下表各项均于 2026-10-09 核验。影响栏为针对本 POC 的设计推论，不是官方效果承诺。

| 能力或事实 | 第一手来源 | 对 POC 的影响 | 限制 |
| --- | --- | --- | --- |
| LangGraph 是面向长期、有状态工作流的底层编排运行时，可混合确定性代码和 LLM 步骤；使用它不要求使用 LangChain。 | [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview) | 可用独立 adapter 包装 DeepSeek、未来 Qwen/Gemini；业务验证与规则节点保持稳定。 | 框架不抽象提示词或应用架构；供应商参数、能力和输出转换由应用负责。 |
| `StateGraph` 用共享 state、函数节点和边组织流程；`add_conditional_edges` 根据状态路由，`Command` 可同时更新状态和路由。 | [Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api) | 可明确实现“提取 → 校验 → 查询 mock → 规则 → 澄清/人工复核/输出”，避免让模型自由决定全部业务流程。 | 同一节点的静态边与动态路由都可执行，设计时不可误混；编译检查不等于业务正确性检查。 |
| `RetryPolicy` 支持按异常、尝试次数、退避配置节点重试；当前文档的节点超时及错误处理要求 `langgraph>=1.2`，节点超时仅适用于异步节点。 | [Fault tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance) | 固定依赖版本、分别处理传输失败与语义失败，限制重试预算，最终输出可记录失败状态。 | 默认重试并非覆盖所有异常；解析/校验失败不会自动被正确修复。多层 SDK/graph 重试可能放大次数，需统一预算。 |
| Checkpointer 保存图状态；checkpointer 的状态范围为 thread。`MemorySaver`/`InMemorySaver` 在进程重启后丢失，SQLite 可用于本地开发持久化。 | [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | 本地 POC 可用 SQLite 保存待澄清/复核状态，评测每条 case 使用独立 thread ID。 | RAM checkpointer 不证明重启恢复；跨 case 共用 thread 会引入状态污染。 |
| `interrupt()` 可暂停并保存状态；恢复需同一 thread ID 和 `Command(resume=...)`；恢复时节点从头执行。 | [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | 可演示补充信息及人工复核分支，并自动测试中断/恢复。 | 需要 checkpointer；中断前的代码会再次运行，外部副作用需幂等或放在独立节点。 |
| DeepSeek 提供兼容 OpenAI/Anthropic 格式的 API；API model 名称可能是别名，官网明确有旧名称请求转由新后端服务的情况。 | [Your First API Call](https://api-docs.deepseek.com/)；[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) | 配置 `provider`、`base_url`、`model`、能力及参数，不在业务代码写死型号；记录请求 model、返回 model（如提供）、运行时间和官网版本信息。 | API 格式兼容不表示参数及 schema 保证完全相同；别名与返回 model 也不一定锁定不可变后端。升级后要重跑基线。 |
| DeepSeek JSON Output 使用 `response_format={"type":"json_object"}`；提示词须包含 json 并给出格式示例，token 上限需避免截断；官方提醒可能出现空内容。 | [JSON Output](https://api-docs.deepseek.com/guides/json_mode/) | 按 JSON 模式调用后仍以 Pydantic/JSON Schema 校验字段、类型、枚举和约束；空内容、截断、非法结构分别统计。 | 该模式是有效 JSON 的机制，本文未核验到它等同严格业务 JSON Schema 保证；有效 JSON 不证明分类、情感或证据正确。 |
| Gemini 网页应用支持多种语言，其支持列表明确包括 Arabic、English、Chinese。 | [Where you can use the Gemini web app](https://support.google.com/gemini/answer/13575153?hl=en) | 可通过用户已授权的浏览器会话生成阿语/英语/混合文本候选，并保留完整输入、输出和生成来源。 | 语言可用性列表不提供沙特各方言情感指标，也不支持对 DeepSeek 的优劣判断；本轮未访问用户账号。 |
| Gemini API 可依据 JSON Schema 生成结构化内容，SDK 可用 Pydantic/Zod；仅支持 schema 子集，大型或过深 schema 可能被拒绝；官方要求应用验证值并处理语义错误。 | [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output) | 有 API 时可批量生成统一 case 格式并自动校验，适合候选数据和可追踪实验。 | schema 合规不等于正确金标；不要将生成者输出直接当作事实标签。 |
| Gemini 网页应用的限制、可用性、模型名称和版本可能变化；API 则可显式提交模型与生成参数，`generateContent` 响应有 `modelVersion`、`responseId`、token usage；该接口定义 `seed`。 | [Gemini Apps limits](https://support.google.com/gemini/answer/16275805?hl=en)；[Generating content API](https://ai.google.dev/api/generate-content) | 浏览器适合初期候选补充；长期批量生成/模型对比优先 API。冻结导出的数据集后，回归只读本地数据，不在每轮测试时重新生成。 | API 比 UI 更容易记录控制条件，但 seed 或低温度不是本次核验所得的完全确定性承诺；不同接口/型号参数支持需检查。 |
| 官方评测建议采用与任务相符的多样样本、参考答案和多种指标；模型裁判可能有偏差，仍需人工评测。 | [Develop a generative AI application: Evaluate a model](https://docs.cloud.google.com/docs/ai-ml/generative-ai/develop-generative-ai-application) | 确定字段用代码评分；情感/讽刺争议样本由独立复核解决，模型裁判辅助筛查。 | 单一 LLM judge 的分数不能替代人工校准的金标；通用语言能力不能直接外推业务准确率。 |
| 官方数据集教程要求评测样本独立、具有真实业务代表性，避免训练/测试重复；反复用测试集做优化会削弱其独立性。 | [Datasets: Dividing the original dataset](https://developers.google.com/machine-learning/crash-course/overfitting/dividing-datasets) | 在无训练场景中将其原则应用于提示词开发：分开开发集、冻结盲测集和固定回归集；同一个语义种子的改写/翻译/最小对立样本按组切分。 | 分组及提示词评测应用为本 POC 推论；合成覆盖不能当作真实投诉分布或总体生产准确率。 |
| LangSmith 官方区分离线 benchmark、回归、历史数据测试，以及规则评分与 LLM judge。 | [Evaluation types](https://docs.langchain.com/langsmith/evaluation-types) | 可在本地实现同样评测分层：固定 case、结构化逐例结果、聚合指标、版本差异与失败清单；LangSmith 是可选工具。 | 本文未要求购买或使用 LangSmith；LangGraph 编排本身不会自动提供完整评测体系。 |

## 建议写入更新方案的评测约束（设计推论）

1. “代表性”分成业务场景覆盖与真实分布代表性。现阶段可以验证前者；没有真实 MOMAH/CRM 文本时，不承诺后者。将合成、公开数据和真实业务数据的指标分别报告。
2. 冻结标签规范后，先指定场景、事实、说话者、时间、情感目标与预期业务信号，再由不同来源生成表达。Codex/Gemini 的来源配额与生成版本进入元数据；禁止一个生成模型同时承担唯一标签权威。
3. 先复核原文是否自然、业务是否成立、标签是否自洽。阿语方言及讽刺样本需要熟悉沙特语境的评审；无评审时保留 `provisional`，只用于管线探索，不能计入已人工验证金标的正式分数。
4. 以 semantic seed/group ID 分组切分，隔离同义改写、翻译和最小对立对；开发集可调提示词，盲测集不回流。回归集固定用于防止已知错误复发，其分数不再宣称独立泛化能力。
5. 技术回归使用固定 fixtures/mock adapter，无 API 也能跑；质量回归实际调用配置模型，记录空响应、schema 成功率、业务多标签 F1/召回、情感 macro-F1、证据校验、路由、各语言/方言分组、延迟与失败率。字段金标评分以代码为主。
6. 更换模型时只改 adapter/config，并执行 adapter 能力预检、同一冻结数据集、同一 schema/规则/mock 及预算。报告稳定运行条件与差异；敏感子集重复运行评估波动，而不是保证温度为零就完全重现。

## 研究论文补充（主代理已核验）

以下论文及适用解释由主代理在 2026-10-09 核验，本文件没有重复读取全文。它们用于支持测试维度选择，不能作为 MOMAH 准确率或模型排名证据。

| 研究 | 方案中的适用范围 | 限制 |
| --- | --- | --- |
| [ArSarcasm](https://aclanthology.org/2020.osact-1.5/) | 阿语讽刺及主观情感标注需要单列并校准。 | 社交媒体语料与政务服务投诉不同。 |
| [Sa‘7r Saudi irony corpus](https://aclanthology.org/2022.osact-1.7/) | 沙特语境中的反讽属于独立困难子集。 | 不能直接推导当前 DeepSeek/Gemini 表现。 |
| [Saudi/Moroccan hotel reviews benchmark](https://aclanthology.org/2025.ranlp-ahasis.13/) | 方言情感评测需按方言、来源分组。 | 酒店评论不是 MOMAH 业务分布。 |
| [Saudi-English code switching](https://aclanthology.org/2026.abjadnlp-1.30/) | 阿语与英语混合表达应纳入测试。 | 公开语料与实际市民渠道仍可能存在分布差异。 |

## 未核验或未执行

- 没有任何针对该业务的 DeepSeek/Gemini 阿语、沙特方言、讽刺或情感实验，不能给出模型优劣排名。
- 没有评审者标注结果、真实业务样本或已验证数据集；没有使用浏览器提交 Gemini 提示词。
- DeepSeek `create-chat-completion`、thinking/tool-call guide 在部分抓取中超时；结论只依据成功读取的首页、模型能力表和 JSON Output 文档。不以未读页面推断额外严格 schema 或参数保证。
- 本记录不固定 DeepSeek/Gemini 型号与报价；这些信息会变化，应在实际实施时按官方文档复核并保存运行清单。
