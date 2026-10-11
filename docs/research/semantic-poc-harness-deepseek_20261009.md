# DeepSeek Harness 二次开发评估

核验日期：2026-10-09。方法：通过已连接的 GitHub 插件搜索官方仓库，读取 README、架构、SDK、工具接口、模型接口、配置与部分源码。没有安装或运行仓库，也没有实测动态规划正确率。

## 仓库与读取版本

官方仓库为 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。默认分支 master 读取时指向 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，提交日期 2026-10-03，提交说明为准备 `0.2.1-alpha.1` 发布。后续源码与包文档按该提交读取；首次 README 与架构读取使用当时默认分支。

[MIT 许可证](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/LICENSE)允许修改与分发，须保留规定声明。依赖许可另见仓库 THIRD_PARTY_NOTICES.md，本次未逐项审查依赖。

## 可以复用的能力

| 能力 | 核验结果 | 对 POC 的意义 |
| --- | --- | --- |
| 插件架构 | 模型适配器、工具注册、会话记录、agent loop 均通过 Cordis 插件组合；注册效果可以随插件卸载撤销 | 可以增加政府业务插件并替换供应商，不必重写循环 |
| 工具接口 | `ctx.tools.register(defineTool(...))`；参数与输出均有 Schema；取消信号贯穿执行 | 三个业务 API 可封装成原生 tools；业务跨字段约束仍由插件验证 |
| 执行拦截 | pre-execute、monotonic guards、around-execute、post-execute 与 result 观察点 | 可挂业务授权、任务预算、超时、审计和结果校验，保持业务规则独立于模型 |
| 模型替换 | `ctx.llm.registerAdapter`；原生 DeepSeek 与 pi-ai 多供应商适配器并存 | DeepSeek API 和未来其他 LLM 走相同 Harness 接口；不支持参数需明确失败 |
| Skill | 独立的 skill registry；多个来源合并目录，按需读取完整指令 | 插件可携带业务流程说明，工具仍承担实际执行；Skill 不是动作权限 |
| 外部工具 | MCP 客户端将外部服务 tools 注册到工具目录 | 可复用已有 MCP 包装，但服务器说明和结果仍需信任边界 |
| 子 Agent | subagent registry 支持不同 provider，capabilities 定义结构化输出、深度、工具过滤等特性 | 外部业务 Agent 可通过定制 provider 或普通 typed tool 对接；不能假设任意 Agent 自动兼容 |
| SDK | TypeScript 与 Python 客户端通过 stdio JSON-RPC 驱动完整运行时 | 可放入测试 runner 或服务进程，不必使用终端作为用户入口 |
| 日志与观察 | 请求、工具调用和结果进入 durable session event log | 有助于按轨迹评测，仍需将业务完成证据单独结构化 |

主要依据：[架构](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/architecture.md)、[工具作者接口](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/cookbook/adding-a-tool.md)、[工具执行管线](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/tool-execution-pipeline.md)、[模型适配器](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/cookbook/adding-an-llm-adapter.md)、[pi-ai 多供应商接口](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-pi-ai/README.md)、[Skill registry](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/skill/skill/README.md)、[MCP](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/mcp/mcp-client/README.md)、[Subagent](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/subsystems/subagent.md)、[SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/sdk/client/README.md)。

源码抽查：[工具注册与执行实现入口](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/tools/src/index.ts)。

## 动态规划的实际边界

架构中的一轮由多个 step 组成：请求模型、执行其工具调用、把工具结果加入日志，再请求模型。插件能改变工具目录、上下文与执行行为。这证明它提供动态选择和继续执行的运行机制。

工具目录包含 todo、plan mode、workflow、子 Agent 等插件，但这些接口不构成政府业务计划正确性的保证。任务是否完整、依赖是否成立、是否关联同一案件、是否已经完成，都仍需应用约束和评测。[工具目录](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/tool-catalog.md)

不能把编码环境中的 Todo 或 plan-mode 直接当作政府业务任务契约。建议新增结构化任务状态与业务完成验证插件，使模型只在授权目录和明确预算中规划。

## 改造与风险

1. **运行时处于开发预览。** README 明确将发生不兼容变更。固定已验证的提交或包版本，将 Harness 事件与会话格式放在适配器内部，升级后重跑工具与轨迹回归。[README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)
2. **默认编码能力需要剥离。** `sdk-minimal` 默认有持久 shell，并使用 danger-full-access；它还省略 Skills 等能力，不能因为名为 minimal 就当作安全政府入口。源码可见明确的 shell、subprocess 与 policy 配置。[sdk-minimal 说明](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/bundle/sdk-minimal/README.md)、[配置源码](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/bundle/sdk-minimal/cordis.patch.yml)
3. **插件自身是可信代码。** 工具参数校验和 guard 不限制任意插件的宿主进程权限。官方明确其未经过安全审计，也不应作为不可信工作负载的唯一安全控制。POC 采用隔离环境、固定插件名单和只读模拟业务，代码由工程团队安装。[SAFETY](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
4. **SDK 终止状态不能代替业务完成状态。** SDK `run` 收集到整个 Agent idle，`finalResponse` 是该区间最后一条根会话文本，不是严格因果关联到单个 prompt 的响应。市民会话与测试 case 要隔离，按 request/task ID 和工具事件判断完成。[SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/sdk/client/README.md)
5. **重试预算可能叠加。** pi-ai provider 可配置重试，agent loop 也有重试层。应用的最大调用、Token 与时间预算应贯穿各层；一条业务写入不能因盲目重试重复执行。[pi-ai adapter](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/llm/llm-pi-ai/README.md)
6. **MCP/Skill 指令扩大提示面。** MCP 服务器说明会加入提示，Skill 来自多个来源。只接入批准目录，并把业务数据与操作规则分开，任务层不能被工具文本改变权限与成功条件。[MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/mcp/mcp-client/README.md)

## 二次开发结论

作为插件型 POC 底座可行：复用 agent loop、model adapters、tools registry、skill loading、会话记录、SDK 和政策拦截点；增加政府目录、结构化语义分析、任务状态、三类业务 API 及外部 Agent 适配器、完成验证、评测导出。

应使用经审查的 profile/patch 组成明确的政府能力集合。移除 shell、通用文件修改、任意代码执行以及由模型管理插件安装的工具，保留只读模拟业务工具与经批准的指令。不要把四类业务系统接入笼统的“任意 HTTP 请求”工具。

与较小的 Pi SDK 比较，DeepSeek Harness 的插件服务与拦截结构更完整，可替换范围更大；成本是 Cordis 组合模型、子进程 SDK 生命周期、较大的依赖面及当前版本不稳定性。这个成本判断来自架构与源码范围，尚未进行相同业务插件的开发耗时实测。
