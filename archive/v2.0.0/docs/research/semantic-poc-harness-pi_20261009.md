# Pi Agent / Harness 适配政府业务总入口：评估记录

核验日期：2026-10-09（Asia/Shanghai）。研究方法：优先使用 GitHub 插件搜索、读取官方仓库 README、文档、SDK 与扩展示例源码；旧仓库重定向通过 GitHub 网页确认。未安装或运行 Pi，没有接入真实政府系统，也没有模型准确率实验。

## 决策结论

**Pi 是当前 POC 的可行候选，可复用模型接口、会话、工具循环和插件加载能力。建议作为宿主服务内的受控 SDK，接入三个 API 系统插件及一个业务 Agent 适配插件。**它可省掉从零实现 agent loop、会话、工具调用、模型切换、事件和扩展加载的工作。

Pi 的工具循环允许模型根据工具结果继续选择调用，符合“总入口接入动态系统”的需求；这不是可证明正确的跨系统规划器。跨系统步骤依赖、用户身份与操作权限、写操作确认、业务状态、预算及终止条件仍由宿主与插件契约约束。官方明确没有内置完整权限系统；不能将默认编码 CLI 原样作为市民服务运行时。

SDK 路线适合优先复用完整扩展/skill/session 生态；更轻的 `pi-agent-core + pi-ai` 路线能缩小默认能力，但要自己接资源加载、skill 分发和持久化。对于本 POC 推荐先以 SDK 做一项小型适配验证，再决定是否退回轻量核心。本文不比较其他 harness。

## 仓库迁移、固定版本和许可

- 旧地址 [badlogic/pi-mono](https://github.com/badlogic/pi-mono) 实际重定向到 [earendil-works/pi](https://github.com/earendil-works/pi)。当前官方 README 与源码使用 `@earendil-works` 包名；旧教程的 `@mariozechner` 接口不能直接作为当前 SDK 契约。
- 本记录的核心阅读固定到 commit [`6fb2e7815167e6b19006fc526d1a5d0f5f998787`](https://github.com/earendil-works/pi/commit/6fb2e7815167e6b19006fc526d1a5d0f5f998787)，commit 时间为 2026-10-08T15:26:34Z。
- 核验时最新正式 release 为 [`v1.1.0`](https://github.com/earendil-works/pi/releases/tag/v1.1.0)，发布时间 2026-10-07T22:26:31Z，tag 对应 commit `abe508e1b89912adde45528136c3221eb69acdd7`。本报告源码阅读 ref 与 release ref 不同，实施时须固定发布包并跑适配验证，不能假定 main 文档与发行包完全一致。
- [LICENSE](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/LICENSE) 为 MIT。二次开发和分发时保留许可要求的版权与许可文本，依赖包许可另行核对。本文不是法律意见。
- 当前 [coding-agent package.json](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/package.json) 的 version 为 `1.1.0`，运行要求 Node.js `>=22.19.0`。

## 已核验能力及适配边界

下列全部核验日期为 2026-10-09；“应用方式”是针对用户当前 POC 的设计判断，不是项目官方功能承诺。

| 能力 | 固定源码或官方文档 | 在总入口 POC 的应用方式 | 边界 |
| --- | --- | --- | --- |
| SDK 嵌入 | [sdk.md](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/sdk.md) | `createAgentSession()` 嵌入 Node/Bun；宿主接数字人文本、传用户上下文、订阅流式文本与工具事件。 | 默认会发现资源、读取设置/凭据并持久化 session，业务服务需显式覆盖。 |
| 一会话一状态对象 | [SDK session lifecycle](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/sdk.md) | 每个用户会话创建独立 `AgentSession`/`SessionManager`；评测每个 case 从独立初态开始。 | 这提供逻辑状态分离，不能替代租户隔离、进程隔离或后方系统权限。并发 prompt 需明确 steering/follow-up，普通并发调用会拒绝。 |
| 流式事件和取消 | [Agent README](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/agent/README.md) | 宿主可记录 model/tool/message/turn 事件；用户打断时取消工具链并保存状态。 | 工具实现必须遵守 AbortSignal；需要业务方定义取消后实际副作用状态。 |
| Extension 注册业务工具 | [extensions.md](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/extensions.md)；[ExtensionAPI 源码](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/core/extensions/types.ts) | `pi.registerTool()` 提供 TypeBox 参数 schema、描述、execute 和结构化 details；三个完整 API 系统各封装为 extension 包中的业务工具。 | extension 与 Pi 同进程、同操作系统权限；第三方插件不是沙箱，也不是可信权限声明。 |
| Skill 与可执行工具分开 | [skills.md](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/skills.md) | skill 放业务术语、流程、前置条件、调用说明；extension/tool 实现 HTTP、校验、审计、权限。 | skill 为模型指令，不能强制访问控制。模型可能漏加载 skill；标准机制让模型读取 SKILL.md，禁用普通 read 后需受控 skill loader 或宿主注入。 |
| Plugins 分发已有实现 | [packages.md](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/packages.md) | Pi package 能一起分发 extensions、skills、prompts；支持 npm/git/local，显式版本/tag/commit 可固定。 | 这不是业务系统自动发现或组织权限平台；仍需自己维护能力目录与配置分发。 |
| 动态注册及可见工具更新 | [dynamic-tools.ts](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/examples/extensions/dynamic-tools.ts)；[tool exposure 文档](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/extensions.md) | 可在 `session_start` 或运行时注册，`setActiveTools()` 更新下一轮模型的 loadout；可用 namespace 按系统组织。 | 普通工具不能 unregister；用 `hidden` 重新注册可撤出。已在运行的调用及权限撤销须由宿主阻断。 |
| 延迟发现与 MCP | [extensions.md MCP](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/extensions.md)；[SDK 配置](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/sdk.md) | 后续系统增多可通过 deferred/tool search 或 MCP 逐步暴露，不必把所有能力同时塞入提示词。 | SDK 不自动加载 CLI 的 MCP/codemode/tool_search 内置扩展，需显式添加并绑定；`setActiveTools` 不等于撤销 codemode/deferred 工具可调用性。 |
| DeepSeek、多 provider 与上下文转换 | [pi-ai README](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/ai/README.md)；[deepseek.ts](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/ai/src/providers/deepseek.ts) | 官方内置 DeepSeek provider 使用其 endpoint 与 `DEEPSEEK_API_KEY`；Models 支持供应商集合、custom provider、跨供应商上下文转换。 | API 兼容选项和模型能力仍存在差异。能切换不证明阿语表现或工具规划质量一致，换模型必须回归。 |
| LLM 工具循环 | [agent-loop.ts](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/agent/src/agent-loop.ts#L178) | 工具结果写入上下文后模型可继续决定下一步；能够完成先查案件、再查流程、再调用业务 Agent 的运行轨迹。 | 源码是响应/工具/续轮调度；没有证明自动规划一定正确。官方 README 明确不内置 plan mode 或 sub-agent 产品功能。 |
| 调用前后 hook | [Agent README](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/agent/README.md#L118)；[extensions.md](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/extensions.md) | core `beforeToolCall`、`afterToolCall` 或 extension `tool_call`/`tool_result` 可接授权、参数校验、结果审计与脱敏。 | 参数 schema 和声明 hints 不等于认证授权；写操作确认要绑定实际业务参数，不能仅靠模型说已授权。 |
| 工具并发/串行控制 | [Agent README](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/agent/README.md#L109) | 当前 core 默认 parallel；查询可并发，依赖链/写操作设置 `executionMode: sequential` 并加入业务幂等键。 | 任一 sequential 工具让整批串行。工具结果持久化顺序与完成事件顺序可能不同，评测不得误判执行顺序。 |
| 技术回归可用脚本 provider | [Faux provider](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/ai/README.md#L1441)；[faux.ts](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/ai/src/providers/faux.ts) | 使用脚本模型响应和工具 mock，测工具接线、会话、动态目录、权限拒绝及错误恢复，无 API 可跑。 | 完整情感/多语言质量回归仍需实际 LLM。并发脚本流需要独立 faux handle/provider ID，不能共享响应队列。 |

## 关键安全与状态事实

[README](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/README.md#L88) 明确 Pi 无内置系统级权限限制，默认继承启动用户和进程权限。[SDK 源码](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/core/sdk.ts#L64) 明确默认 built-in tools 为 `read/bash/edit/write`，可设置 `noTools: "builtin"` 并保留自定义工具，或用显式工具 allowlist。政府服务 POC 应显式构造 ResourceLoader，禁用用户目录/项目目录自动发现，只加载受审查的业务插件与指令，不向市民会话暴露默认编码工具。

active tool set 只决定模型声明集合；`codemode`/`deferred` exposure 的注册工具即使 inactive 也可被其他工具调用。宿主不能通过“从模型工具列表删除”来实现授权撤销。业务插件 execute 入口每次重新校验身份、权限、目录有效版本及资源归属；初期不需要 codemode 时直接不加载它。这是避免编码工具与动态暴露产生隐性能力的实现约束。[Tool exposure](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/extensions.md)

Pi SessionManager 提供会话树与 JSONL 持久化，不自动提供政府业务事务、后端任务状态或跨系统 exactly-once。需要 pending confirmation、业务 idempotency key、后方 task ID、轮次与结果状态等结构化业务记录。当前 main 另有 durable/telemetry 等包，但本研究未深入核验这些包，不能据其名称承诺可恢复业务执行。SDK 的会话与动态加载已经足够支撑小 POC，业务恢复另做明确契约。[SDK](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/docs/sdk.md)

## SDK 配置细节：工具白名单、资源加载、结构化结果

**`tools: []` 会禁用全部工具，不能用它表达“禁用系统工具、保留 customTools”。** `sdk.ts` 将它设为 `allowedToolNames`，`AgentSession` 会过滤 extensions 和 SDK `customTools`。可使用 `noTools: "builtin"` 保留业务 customTools，或提供显式 `tools: ["gov_*", "agent_*", "submit_result"]` 工具名称白名单（示意名称，需和实际注册一致）。后者更明确；但 MCP 有特殊保留规则，因此初期不加载 MCP/codemode/tool_search，后续启用时重新验证可调用集合。[SDK 源码](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/core/sdk.ts#L64)、[AgentSession 过滤](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/core/agent-session.ts#L3504)

`DefaultResourceLoader` 当前源码提供 `noExtensions`、`noSkills`、`noContextFiles`、`noPromptTemplates`、`noThemes`、显式 `extensionFactories` 与额外资源路径。禁用自动发现后可显式指定可信资源；不过 loader 仍会解析包/设置、discover system prompt 等路径，因此“所有 no* 标志”不等于完整零文件发现。严格业务宿主应采用官方 [full-control.ts](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/examples/sdk/12-full-control.ts) 的自定义 `ResourceLoader`，显式返回业务 extensions/skills/prompt、空 context files 与 themes，结合 `SettingsManager.inMemory`、独立会话及受控 `agentDir`/ModelRuntime。[ResourceLoader 源码](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/core/resource-loader.ts#L270)

SDK 的 extension `pi.on("tool_call", ...)` 可返回 `{block: true, reason: "..."}`，官方示例与 `AgentSession._beforeToolCall` 实现均核验；业务 `execute` 中仍应检查用户身份和授权，避免绕过 hook 的其他应用调用路径。工具结果具有 `content`、`details`，AgentSession 也传递 `structuredContent`。[扩展示例](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/examples/sdk/06-extensions.ts#L67)、[调用 hook 源码](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/core/agent-session.ts#L657)

所读 `CreateAgentSessionOptions` 没有业务 `outputSchema` 一等参数；SDK 通过 `getLastAssistantText()` 或 messages 读取助手输出，不能据此宣称原生强制业务 final JSON。建议插件注册 TypeBox 参数的 `submit_result` 工具，承载 `status`、情感、证据、系统事实、用户响应与动作结果；宿主本地验证后取结构化参数/结果。没有调用、schema 错误或事实不一致视为失败/人工复核。需要停止循环时使用明确结束机制及预算，不能假定工具 `terminate: true` 在混合工具批中必定结束（它要求该批全部结果终止）。[SDK options](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/core/sdk.ts#L48)、[final text](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/coding-agent/src/core/agent-session.ts#L4347)、[终止语义](https://github.com/earendil-works/pi/blob/6fb2e7815167e6b19006fc526d1a5d0f5f998787/packages/agent/README.md#L118)

## 四系统接入的最小设计（建议）

数字人/文本渠道 → 宿主会话服务 → Pi SDK + DeepSeek → 已授权能力目录 → 三个 API 插件 / 一个 Agent 插件。情感与语义分析是总入口的输入理解能力，并行或前置产生证据化结构；它不直接代表某个业务系统的最终决定。

每个插件应声明 `system_id`、版本、适用能力、输入/输出 schema、读写属性、身份要求、确认条件、超时、幂等约束、允许并发方式与健康状态。能力目录用宿主维护；插件注册、实际调用和授权的版本写入 trace。新增系统通过部署新插件/配置并更新目录实现，不在主提示词写死四条路由。

前三个完整 API 系统：extension/tool 调用固定 endpoint 与预定义业务操作，skill 描述前置条件和返回含义。不要给模型任意 URL/SQL/credential 参数。

第四个业务 Agent：用一个同样受控的 `agent.invoke` 工具适配其接口，输入为明确任务及最少上下文、授权范围、trace ID；返回结构化 `completed/needs_input/pending/failed`、可核验事实/来源、task ID、缺失字段和后续动作。它作为远端业务能力接入即可，不需要 Pi 内置 sub-agent。业务 Agent 输出视为数据，不能自行扩张入口权限或再调用其他系统；入口继续负责用户确认与统一回应。

初期只配置三个 API mock、一个 Agent mock，覆盖单系统、串行跨系统、并行只读、Agent 追问、系统新增/禁用、未授权调用、超时、部分失败、重复提交和提示注入。先明确这些契约，再连接真实系统。

## 自动回归保留并扩展（建议）

原有阿语/多语言/情感冻结数据集与确定性字段评分保留，并将“总入口选择与执行行为”作为新评测层：

1. 语义与情感：原有多标签、情感目标/强度、否定、时态、讽刺、方言、混合文本、证据，按语言和场景分组评分。
2. 路由与规划：正确系统/工具、必需步骤、参数正确、前置条件满足、允许并发、未做多余调用。以允许动作集合及步骤依赖评分，避免要求所有模型生成同样文字计划或工具顺序。
3. 业务执行：mock 校验资源归属、幂等、确认与 API/Agent 状态；错误后不捏造完成，失败和追问路由正确。
4. 动态能力：同一用例在目录 v1/v2、不同插件数量、某系统停用或插件版本变化时重测；目录更新及权限撤销的调用时校验必须覆盖。
5. 模型替换：同一 dataset/schema/plugin/mock/目录快照换 provider，比较逐例结果、路由召回、任务成功率、情感 macro-F1、错误率、latency、tokens 和稳定性；新模型不能仅以能调用工具就验收。

技术回归采用 Pi faux provider + API/Agent fixtures；质量回归采用实际 DeepSeek，未来供应商加入同一 runner。完整记录 case ID、session ID、LLM/provider/ref、插件/skill/目录版本、模型每轮与工具事件、参数、受控输出、评分及失败类型。Pi 已有事件和 faux 机制，但本项目仍需自己的 dataset runner 与业务评分器。

## 二次开发量判断与适配验证

| 可复用部分 | 仍需开发部分 |
| --- | --- |
| provider、模型切换、流式输出、tool loop、参数 schema 入口、会话管理、扩展/skill/package 机制、事件、脚本模型 | 政府身份/权限、动态能力目录、三个 API 适配器、远端 Agent 契约、确认交互、业务状态与幂等、情感分析与证据 schema、用户友好回答、数据集与评分器、数字人渠道接入 |

判断为**运行时少量适配、业务接入与评测中等工作量**；实际工期取决于接口质量、四系统的状态/认证契约及前端渠道。不能因 Pi 有 extensions 就声称零开发。

建议第一项适配验证限定：固定发布依赖，创建不自动发现外部资源的 SDK session；仅载入一个查询 API mock 和一个 Agent mock；接 DeepSeek；录制事件；执行一次串行调用、一次 Agent 追问、一次权限拒绝、一次系统目录变化；用 faux provider 回放技术轨迹，再用实际模型跑小冻结集。通过后扩展到四系统和完整多语言回归。这个验证可以决定 SDK 能否直接满足宿主契约，也能暴露发布包与 main 文档差异。

## 限制与未执行

本研究固定主分支 commit 阅读，不是完整安全审计或 release 兼容测试。没有验证 Pi 在该政府业务上的准确率、阿语能力、长期任务可靠性、租户隔离或部署吞吐。项目的 plan/sub-agent 缺省、并发工具及 sandbox 边界按所读 ref 为准。任何“可靠动态规划”结论必须由业务 mock、冻结数据与实际模型实验产生。
