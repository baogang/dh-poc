# Semantic Analysis POC：Deep Agents 与 OpenCode 二次开发评估

核验日期：2026-10-09（Asia/Shanghai）。范围：政府业务总入口，后方 3 个 API 系统及 1 个业务 Agent，DeepSeek 首轮验证，模型可替换，阿语意图/情感识别与自动化回归。这里只评估 Deep Agents，并用 OpenCode 对照；不包含 Pi 或 DeepSeek Harness 的评估。未安装、运行这些远程项目，也未测量准确率或时延。

## 结论

**优先将 Deep Agents Python SDK 作为可替换的编排候选，做小规模兼容性验证；不需要从零写 tool loop。** 它基于 LangChain `create_agent` 与 LangGraph，可复用消息循环、工具调用、上下文压缩、子 Agent 及 checkpoint；业务能力通过 tools、skills、middleware 接入。官方定位和接口支持此方向，但政府业务的权限、案件状态机、幂等、实体消歧及跨系统一致性仍需本项目实现。[官方 README](https://github.com/langchain-ai/deepagents/blob/6a3a12bc5b3ac88aeb091e6c77ba81ad4d6732af/README.md)、[SDK 源码](https://github.com/langchain-ai/deepagents/blob/6a3a12bc5b3ac88aeb091e6c77ba81ad4d6732af/libs/deepagents/deepagents/graph.py)

**“具备动态规划机制”不能推导为“动态规划已可靠”。** 此 harness 让模型根据任务、工具说明及执行结果选择后续动作，并提供委派机制；任务是否被正确拆解、阿语情感是否被识别、是否遗漏查询，仍受模型和业务描述影响。建议限定 capability catalog，让模型在注册的能力中规划，再用程序执行授权/参数/前置条件检查。所有效果结论需来自本 POC 回归，而非框架 README 的宣传性表述。

**OpenCode 可扩展，但列为次选。** 它提供 SDK、plugins、custom tools、DeepSeek provider 与 JSON Schema 输出；其官方定位是 coding agent，SDK 操作的是 OpenCode server，嵌入政府服务通常会引入额外服务进程、会话配置和 coding 默认行为的清理成本。优先级判断是依据架构的工程推断，不是实测性能结论。[README](https://github.com/anomalyco/opencode/blob/388406238bd5ca15564a762840a2362c3a45bd9c/README.md)、[SDK](https://opencode.ai/docs/sdk/)

## 核验的版本与许可证

| 项目 | 分支/commit | 源码内版本 | 许可证与状态 |
| --- | --- | --- | --- |
| langchain-ai/deepagents | main；`6a3a12bc5b3ac88aeb091e6c77ba81ad4d6732af` | `libs/deepagents/pyproject.toml`: `0.7.23` | 实际 LICENSE 为 MIT；包 classifier 为 Beta；Python `>=3.11,<4.0` |
| anomalyco/opencode | dev；`388406238bd5ca15564a762840a2362c3a45bd9c` | `packages/opencode/package.json`: `1.18.35` | 实际 LICENSE 为 MIT |

上述版本来自检查时分支源码，不声称是稳定 release 或已验证版本。Deep Agents 已把 `backend=lambda rt: ...` 的旧模式改为 backend 实例，说明复制历史示例有兼容风险；应固定包版本、依赖 lockfile 与回归。[Deep Agents 包定义](https://github.com/langchain-ai/deepagents/blob/6a3a12bc5b3ac88aeb091e6c77ba81ad4d6732af/libs/deepagents/pyproject.toml)、[Deep Agents LICENSE](https://github.com/langchain-ai/deepagents/blob/6a3a12bc5b3ac88aeb091e6c77ba81ad4d6732af/LICENSE)、[OpenCode 包定义](https://github.com/anomalyco/opencode/blob/388406238bd5ca15564a762840a2362c3a45bd9c/packages/opencode/package.json)、[OpenCode LICENSE](https://github.com/anomalyco/opencode/blob/388406238bd5ca15564a762840a2362c3a45bd9c/LICENSE)、[迁移说明](https://docs.langchain.com/oss/python/deepagents/backends)

## Deep Agents 可直接复用的接口

| 需求 | 已核验的公开能力 | 本项目仍需处理 |
| --- | --- | --- |
| 基础循环、状态、恢复 | `create_deep_agent` 返回 `CompiledStateGraph`；参数含 `checkpointer`、`store`、`state_schema`、`context_schema` | 会话隔离、用户身份、checkpoint 生命周期、恢复后的写入幂等 |
| DeepSeek 和未来切换模型 | `model` 可传 provider:model 字符串或 `BaseChatModel` 实例 | Provider Adapter；各模型 tool calling/JSON/流式错误的契约测试 |
| API tools | `tools` 接收 `BaseTool`、Python callable 或 tool dict；官方也说明可接 MCP | 每个业务 API 的 typed schema、认证、timeout、错误归一化、审计 |
| Skills | `skills` 为 skill source 路径，按需加载行为说明 | 版本化的意图/情感标签、业务适用边界、澄清策略；Skill 不能替代可执行 API |
| 已有 Agent | `CompiledSubAgent` 包装 Runnable/已编译 LangGraph；`AsyncSubAgent` 接收 graph_id/url/headers | 异构远程 Agent 若不满足其运行协议，包装为 typed tool；定义超时、状态、证据与权限合同 |
| 结构化结果 | `response_format` 接收 schema/strategy；子 Agent 也可设 response_format | Schema validation 后还要做枚举、实体、证据原文定位及业务一致性检查 |
| 审批暂停 | `interrupt_on` + HITL middleware | 实际授权在 tool adapter 中，不只依赖模型遵守提示词 |

接口证据：[SDK 签名和实现](https://github.com/langchain-ai/deepagents/blob/6a3a12bc5b3ac88aeb091e6c77ba81ad4d6732af/libs/deepagents/deepagents/graph.py)、[Tools 文档](https://docs.langchain.com/oss/python/deepagents/tools)、[Subagents 文档](https://docs.langchain.com/oss/python/deepagents/subagents)。`CompiledSubAgent` 的 graph 需要消息 state 兼容，不能据此声称“任意外部 Agent 零适配接入”。

DeepSeek 首轮可以使用 `langchain_deepseek.ChatDeepSeek` 对象注入 `create_deep_agent(model=...)`。官方集成要求 `langchain-deepseek` 与 `DEEPSEEK_API_KEY`，并给出 `deepseek-chat` 示例。具体上线模型名称与能力以配置及运行前 provider 元数据为准，不能把示例名称当永久合同。[官方 DeepSeek 集成](https://docs.langchain.com/oss/python/integrations/chat/deepseek)

## 必须裁剪的默认能力

1. **`tools=[]` 不会删除内建工具。** 源码明确 tools 为 additive。默认有文件工具和子 Agent 工具；执行 shell 取决于 backend 的执行能力。
2. **默认 StateBackend 将文件保存在本线程 graph state，不是宿主机目录。** 它不是 shell backend；不要为政府入口配置 LocalShellBackend 或可访问宿主机秘密的 FilesystemBackend。
3. **当前 0.7.23 源码支持裁剪。** 可注册 `HarnessProfile(excluded_tools=...)`，不向模型提供相应工具；或替换同名 `FilesystemMiddleware(tools=[...])`，限制其工具列表。后者要求列表至少包含 `read_file`，不能直接传空列表。若技能只需读取，可只允许 `read_file` 并用受控 backend 提供白名单 skill 文件；若要完全隐藏文件调用，须使用 profile exclusions 并验证 skills/context offload 所需行为。
4. **默认 general-purpose 子 Agent 会自动添加。** `general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False)` 可关闭；没有同步 subagents 时不暴露 `task`。业务 Agent 可先通过 typed tool 接入，避免不必要的通用委派。
5. **排除工具不是完整安全隔离。** 不向模型展示工具和在工具执行层做拒绝是两层措施；认证/授权/允许的案件范围/是否可写/幂等键仍须在业务 adapter 中强制检查。父 Agent 的权限不能想当然覆盖任意 compiled/远程 Agent。
6. **运行预算必须主动限制。** 当前源码返回 graph 时设置 `recursion_limit=9_999`；POC 应另设较小循环、总 tool call、token、墙钟和子 Agent 预算，达到限制返回澄清/人工处理，避免循环花费。

证据：[graph.py](https://github.com/langchain-ai/deepagents/blob/6a3a12bc5b3ac88aeb091e6c77ba81ad4d6732af/libs/deepagents/deepagents/graph.py)、[FilesystemMiddleware 参数与执行判断](https://github.com/langchain-ai/deepagents/blob/6a3a12bc5b3ac88aeb091e6c77ba81ad4d6732af/libs/deepagents/deepagents/middleware/filesystem.py)、[HarnessProfile 与排除机制](https://github.com/langchain-ai/deepagents/blob/6a3a12bc5b3ac88aeb091e6c77ba81ad4d6732af/libs/deepagents/deepagents/profiles/harness/harness_profiles.py)、[后端风险与 StateBackend](https://docs.langchain.com/oss/python/deepagents/backends)。仓库 README 自述安全边界应施加在 tools/sandbox，而不是指望 LLM 自我约束。[安全说明](https://github.com/langchain-ai/deepagents/blob/6a3a12bc5b3ac88aeb091e6c77ba81ad4d6732af/README.md#security)

## 与手写 LangGraph 的成本比较

以下是本场景的工程推断，需通过最小 spike 核实，并非官方开发工期或实测。

| 路线 | 可节省的工作 | 额外成本/风险 | 本 POC 适合度 |
| --- | --- | --- | --- |
| 手写 LangGraph tool loop | 控制最直接 | 自写消息循环、工具 dispatch、上下文、重试/恢复、schema 收敛；增加框架行为回归工作 | 只有业务图必须高度固定或 harness 难裁剪时再选择 |
| Deep Agents SDK + 业务 adapters | 复用已有 loop、LangGraph 状态与可插拔子 Agent | 裁剪默认文件/委派；版本变化；模型表现和 planner 仍须评测 | 首选候选，优先不 fork 上游，用公开扩展点 |
| OpenCode server + SDK/plugins | 复用完整 coding agent 与客户端、插件 hook | 额外进程；coding 默认与工作目录语义；需约束权限与隔离项目配置 | 次选，若未来需要 coding/admin 入口才更有优势 |

建议保持一个内部 `OrchestratorAdapter.run(request, capabilities, model_config)` 接口，把业务 schema、API adapters、测试 fixtures 与 harness 解耦。Deep Agents 为第一实现；如其复杂度超过收益，可换 LangChain `create_agent` 并保留相同合同。不是把未来切换能力等同于所有模型效果相同。

## OpenCode 简短对照

- 官方 SDK 是 OpenCode server 的 JS/TS client，`createOpencode` 会启动 server 和 client；也可仅连接已有 server。[SDK](https://opencode.ai/docs/sdk/)
- plugin 是 JS/TS 模块，返回 hooks；custom tools 用 Zod 参数 schema，可调用业务 API。[Plugins](https://opencode.ai/docs/plugins/)、[Custom tools](https://opencode.ai/docs/custom-tools/)
- SDK 支持 JSON Schema 输出和校验重试，最终可能返回 `StructuredOutputError`；结构合法仍不意味着意图/情感正确。[结构化输出](https://opencode.ai/docs/sdk/#structured-output)
- provider 文档包含 DeepSeek；permission 有 allow/ask/deny，业务入口需要显式 deny coding/shell 工具，并独立实现业务授权。[Providers](https://opencode.ai/docs/providers/#deepseek)、[Permissions](https://opencode.ai/docs/permissions/)

## 可复用的 POC 回归合同

保持原有语义评测，增加独立编排评测；测试 fixtures 和 scorer 应位于 harness 外部。下面为建议，尚未实现。

- **语义结果合同：** 多意图、情感类别/强度、紧急程度分别评价，输出原文 evidence span、否定/时间关系、实体与需澄清字段；不能把负面情绪自动等同于紧急风险。
- **能力目录合同：** capability_id、description、input/output schema、read/write、scope、prerequisites、timeout、error types、版本。系统从 4 个增加到 N 个时更新目录与 adapters，不靠硬编码四路分类。
- **测试判定：** 接受等价 tool 路径或偏序依赖，不强行匹配一个唯一动作顺序；检查必要查询是否完成、无关工具是否调用、前置条件是否满足、澄清是否正确。
- **工具仿真：** 3 个 API 和第 4 个 Agent 先使用 fixtures；覆盖超时、缺失字段、权限拒绝、结果矛盾、Agent 返回自由文本/无效 schema、重复回调及不可信说明。
- **模型切换：** 固定数据集、标签、capability schema 与 scorer，替换 provider 后重新运行；报告语义 F1、情感 Macro-F1、路由/任务成功率、越权调用计数、成本、时延、schema/重试错误。
- **稳定基线：** 同时保留“语义 schema + 固定只读查询规则”的 baseline。动态规划应在复杂任务上取得额外收益，同时不能令简单场景质量倒退；结论来自同一盲测集。

## 源码证据摘要

通过 GitHub 插件读取实际仓库文件，并用上述 commit 重读 Deep Agents 关键文件验证与分支读取的 blob 一致：

| 文件 | blob SHA |
| --- | --- |
| deepagents README.md | `efa13c884a5f984cf30c5da8f571fc9264e20216` |
| deepagents graph.py | `6e33cf1307c94b48895b9cf2855f76206340e732` |
| deepagents pyproject.toml | `5bbca9150e3ca943c4dd9a662cdaeaf8459453b2` |
| deepagents harness_profiles.py | `01d61b9cb2701a75b48c13cb4b5bc8fbdd8bc92a` |
| deepagents filesystem.py | `c7c4a177ff94a51e9e6d6aa312fe5553e1b63ed8` |
| deepagents LICENSE | `3957738673765912ca83a0048f833e095d61e087` |
| opencode README.md（dev） | `b5a4c8ddd9794e8c20bd287603bfa0c336522796` |
| opencode package.json（dev） | `9def9a322eb3c47435a7b0f0009b4035f0de01d7` |
| opencode LICENSE（dev） | `6439474beed8e0271df9862eff97ffd70ec2464c` |

链接为官方仓库/文档；资料中可能随版本变化的默认值应以固定源码为准。尚待 spike 的事项：DeepSeek 选择模型的 structured output 与工具兼容性、profile 排除与 skill 读取能否兼容、tool 预算/恢复边界、实际业务 Agent 协议、阿语与方言表现。
