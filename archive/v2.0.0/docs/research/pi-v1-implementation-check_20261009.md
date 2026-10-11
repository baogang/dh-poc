# Pi v1.1.0 + DeepSeek：V1 实施接口核验

核验日期：2026-10-09。读取官方 GitHub、npm registry 和 DeepSeek 文档；下载三个发行 tarball 到 `/tmp` 检查声明/编译产物。随后使用主代理已安装的依赖运行了一次离线 SDK/faux smoke；本代理未安装依赖、未调用真实模型 API、未修改 `src` 或 `package.json`，未读取或记录密钥。下文骨架的 SDK/loader/model 查询已实际验证，业务 schema 与真实模型评测仍由实现端验证。

## 固定发行与 main 的关系

- 官方 release [`v1.1.0`](https://github.com/earendil-works/pi/releases/tag/v1.1.0) 固定 commit **`abe508e1b89912adde45528136c3221eb69acdd7`**。当前 main 为 [`6fb2e7815167e6b19006fc526d1a5d0f5f998787`](https://github.com/earendil-works/pi/commit/6fb2e7815167e6b19006fc526d1a5d0f5f998787)。以下源码引用均固定 release commit。
- 读取官方 [coding-agent npm 元数据](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/1.1.0)、[provenance](https://registry.npmjs.org/-/npm/v1/attestations/@earendil-works%2fpi-coding-agent@1.1.0)：构建来源为官方仓库 `refs/tags/v1.1.0`、上述 release commit。下载字节的 SHA-512 与 registry `dist.integrity` 一致；此处验证来源字段和哈希，没有独立校验 provenance 签名链。
- 实际检查 [coding-agent 发行包](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.1.0.tgz)、[pi-ai 发行包](https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.1.0.tgz)、[agent-core 发行包](https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-1.1.0.tgz)：版本均为 1.1.0，根导出为 `dist/index.js` 与 `dist/index.d.ts`；所需 SDK、model-runtime、tools、faux 和 agent 声明/实现均存在。
- 逐文件比较 release 与当前 main：`sdk.ts`、`resource-loader.ts`、`model-runtime.ts`、`faux.ts`、`agent-loop.ts`、`12-full-control.ts` 的 Git blob SHA 全部相同。发行包 full-control 示例的 blob SHA 也完全相同：`0ddbc2008ef14e18ead370db435e2be3ca36b0cc`。**本次核验的核心接口一致，不表示所有 main 文件或未来 main 一致。**
- 包要求 Node `>=22.19.0`。coding-agent 对 pi-ai/agent-core 依赖为 `^1.1.0`；为了可复测，应固定本项目直接依赖及 lockfile，不让后续补丁静默改变运行时。[发布 package.json](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/package.json)

## 受控 SDK 与资源入口

已核验 [CreateAgentSessionOptions](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/sdk.ts)：接收 `modelRuntime`、`model`、`resourceLoader`、`customTools`、`tools: string[]`、`sessionManager`、`settingsManager`。不存在直接的业务 final `outputSchema` 参数，也没有旧教程常见的 `authStorage`/`modelRegistry` factory 选项。使用发行版根导出，不导入未公开的源码路径。

严格资源控制沿用官方 [12-full-control.ts](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/examples/sdk/12-full-control.ts)：自定义 `ResourceLoader` 显式返回空 extensions/skills/prompts/themes/agentsFiles，受控 system prompt，空追加提示和来源，`reload`/`extendResources` 为宿主管理的方法。`getExtensions()` 必须含 `runtime: createExtensionRuntime()`；仅 `customTools` 接入业务即可，无需默认文件发现或编码工具。

以下 loader 对象已在当前 node_modules 中运行成功（TypeScript 项目再以导出的 `ResourceLoader` 类型检查）：

```ts
import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";
const extensionRuntime = createExtensionRuntime();
const controlledLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => controlledSystemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};
```

注意 `tools: []` 禁用包括 customTools 在内的全部工具；使用实际业务工具名的白名单，例如 `tools: customTools.map(t => t.name)`，或 `noTools: "builtin"`。明确白名单更适合当前四域 POC；不加载 MCP/codemode/tool_search 时可避免其额外发现/嵌套能力。工具列表控制模型能力集合；业务 execute 仍要每次检查授权、目录版本和用户确认。[SDK 源码](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/sdk.ts)、[ToolDefinition](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/extensions/types.ts)

隔离凭据/模型配置时可采用以下已存在的接口：

```ts
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager, SessionManager, createAgentSession }
  from "@earendil-works/pi-coding-agent";

const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsStore: new InMemoryModelsStore(),
  modelsPath: null,
  allowModelNetwork: false,
  refreshOnCreate: false,
});
// 从宿主秘密配置取得 key；只传入运行时，禁止写日志或发送给工具。
await runtime.setRuntimeApiKey("deepseek", key);
const model = runtime.getModel("deepseek", configuredModelId);
if (!model) throw new Error("Configured model is absent from the pinned catalog");

const { session } = await createAgentSession({
  cwd: controlledCwd,
  agentDir: controlledAgentDir,
  modelRuntime: runtime,
  model,
  thinkingLevel: "off",
  resourceLoader: controlledLoader,
  customTools,
  tools: customTools.map(t => t.name),
  sessionManager: SessionManager.inMemory(controlledCwd),
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
    cacheWarming: "off",
    retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 30000 } },
  }),
});
```

`modelsPath: null` 确实使 `ModelConfig.load(undefined)` 返回空配置；传入内存 credential/models store 避免默认 auth/models 文件。Provider 仍可解析其环境变量凭据，因此宿主应限制可选 provider/model 和环境，而非认为内存 store 是环境隔离。[ModelRuntime](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/model-runtime.ts)、[ModelConfig](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/model-config.ts)、[内存 CredentialStore](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/auth/credential-store.ts)

## DeepSeek provider 与配置

官方内置 `deepseekProvider()` 使用 `https://api.deepseek.com`、`DEEPSEEK_API_KEY` 和 `openai-completions`。SDK 的 `ModelRuntime` 默认组合官方 provider，可直接 `runtime.getModel("deepseek", configuredModelId)`，无需旧式全局注册。[provider](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/providers/deepseek.ts)

所检发行包模型数据包含 `deepseek-flash` 和 `deepseek-v4-pro`，兼容设置含 `thinkingFormat: "deepseek"` 与 `requiresReasoningContentOnAssistantMessages: true`。这是该发行包快照，不是今后默认配置承诺；业务配置应保存 model ID、thinking 设置、API 格式、endpoint 和实际响应模型，启动前检查当前账号支持。GitHub TS 目录导入的模型 JSON 由发布构建生成，实际 tarball 已读取，不依据未发布文件猜测。[模型生成入口](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/providers/deepseek.models.ts)、[构建脚本](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/package.json)

新增/覆盖模型可使用 `runtime.registerProvider(providerId, config)`，配置包含 `baseUrl`、`api: "openai-completions"`、受控 apiKey/env 引用和明确模型能力；或 `runtime.registerNativeProvider(provider)` 接纳 `createProvider()` 对象。二者皆存在于 npm 声明和编译实现。自定义模型需复制适当的 DeepSeek 兼容参数，不应只改 URL 就假设工具和 thinking 行为相同。[ModelRuntime 注册实现](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/model-runtime.ts)、[ProviderConfig](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/extensions/types.ts)、[createProvider](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/models.ts)

## 强制结构化分析和最终结果

1. 建议分析阶段只暴露一个 TypeBox 参数工具 `submit_analysis`，通过 named `tool_choice` 强制该工具；执行阶段暴露业务工具与 `submit_result`，使用 `tool_choice: "required"`，让模型每轮调用业务工具或提交终结结果。typed 接收后本地校验语义/证据/状态；缺失提交、非法参数、截断或无证据的完成声明均为失败。名称和业务 schema 为本项目设计。
2. **DeepSeek Chat Completions 的 `required` 与 named tool choice 在 thinking 模式不支持，会返回 400。**应显式关闭 thinking，不能只把 temperature 设为零；官方说明 temperature 在 thinking 下无效。SDK 用 `thinkingLevel: "off"`，必要时在受控 payload 断言 `thinking: { type: "disabled" }`。[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)
3. SDK 未暴露 prompt 级 `toolChoice` 配置，但 `session.agent.onPayload` 为公开属性，可包装已有 hook 后返回新 payload 设置 `tool_choice`、`max_tokens` 和 thinking。也可用可信 extension 的 `before_provider_request`。保留原 hook，按 provider/API 类型检查 payload，避免把 DeepSeek 字段发给其他供应商。`onPayload` 每次模型请求在 provider retry 外调用，不能据它统计所有重试 HTTP 次数。[Agent 接口](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/agent/src/agent.ts)、[OpenAI payload/重试实现](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/api/openai-completions.ts)
4. `ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)` 可返回 `{ content, details, structuredContent, terminate }`。`parameters` 在 execute 前经过参数校验；`outputSchema` 描述工具结构化结果，不能将其说成 final assistant 输出强制。core 中未发现通用自动结果 schema 验证，因此业务结果仍应本地验证。[ToolDefinition](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/extensions/types.ts)、[tool loop](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/agent/src/agent-loop.ts)
5. `terminate: true` 仅在当前批次**全部**最终工具结果都带此标记时结束；不能依赖单个 `submit_result` 在混合工具批中的 terminate。宿主应禁止终结工具与业务操作混在一批，或先切换到只允许终结工具的阶段；完成结果应只接收一次，完成后 execute 拒绝新业务操作。工具 loop 不是可靠规划保证。[终止判断](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/agent/src/agent-loop.ts#L693)
6. 普通 function 参数本地校验仍是必要的。若采用 provider strict，可在 Pi ToolDefinition 设置 `constrainedSampling: { type: "json_schema", strict: "require" }`，但 DeepSeek strict 是 beta，须 `https://api.deepseek.com/beta`、全部 function `strict:true`、object 全字段 required 和 `additionalProperties:false`，且仅支持部分 JSON Schema；V1 不必依赖 beta。[Pi sampling 类型](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/types.ts)、[DeepSeek strict](https://api-docs.deepseek.com/guides/tool_calls/)
7. JSON Output 备选只能保证 JSON 语法，仍需提示词含 json 和示例、合理 token 上限，并处理空输出；不保证业务 schema 或标签正确。[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)

## 无联网的脚本模型回归

发行版 pi-ai 根导出 `fauxProvider`、`fauxAssistantMessage`、`fauxToolCall`。建议每个 case/并发会话独立 provider 与 API ID，防止共享响应队列；`setResponses` 是脚本队列，`state.callCount` 和 `getPendingResponseCount()` 可做接线断言。`fauxAssistantMessage` 默认 stopReason 是 `stop`，工具脚本应显式 `stopReason: "toolUse"`。[faux 源码](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/providers/faux.ts)、[根导出](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/index.ts)

```ts
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
const faux = fauxProvider({ provider: `faux-${caseId}`, api: `faux-api-${caseId}` });
runtime.registerNativeProvider(faux.provider);
await runtime.refresh({ allowNetwork: false });
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("submit_analysis", expectedAnalysis), { stopReason: "toolUse" }),
]);
// createAgentSession 使用 model: faux.getModel()；其余 loader/tools 与真实模型相同。
```

离线回归验证：schema、缺少参数、未授权、确认绑定、工具/Agent 状态、幂等、取消、目录变化、终结混批拒绝。不得把脚本模拟正确轨迹的通过率称为 DeepSeek 准确率；真实语义/情感/路由质量评测另用冻结数据和真实 provider。

## 预算、取消与事件

- `session.subscribe()` 接收同步 void listener；`message_end` 是完成消息，`agent_end` 是低层 run 结束，自动恢复可能继续，宿主最终稳定事件为 `agent_settled`。`await session.prompt()` 等整个接受的 run 完成；`session.abort(): Promise<void>` 中止并等待 idle，`session.dispose()` 用于最后清理。[SDK](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/docs/sdk.md)、[session 源码](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session.ts)
- core `agent.subscribe()` 的异步 listeners 被等待；**不要在其处理器中 await `session.abort()` / waitForIdle()**，会等待自己的 listener 结束。先 `session.agent.abort()`（同步发出取消）或在宿主异步调度中 `void session.abort()`，退出回调后再等待 prompt/idle。SDK void listener 也不要依赖异步返回被等待。[Agent](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/agent/src/agent.ts)
- 设置每轮输出上限、总轮次、总 tool 次数、全请求 wall-clock、并发数和预算余量。provider/session 重试分两层；评测初期可关闭两层及 cache warming，故障重试由 runner 有界执行并记账。timeoutMs 是单次 provider 请求限制，不能代替整段工具循环的总时限。[SDK request options](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/sdk.ts)、[provider 重试](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/ai/src/api/openai-completions.ts)
- `execute` 必须遵守传入 AbortSignal；HTTP mock/真实 adapter 合并它与工具超时，取消后不再产生新调用。中止不会撤销已经完成的远端副作用；写操作仍需确认、幂等键和后端结果查询。
- 记录 `turn_start/end`、`message_end`、`tool_execution_start/end`、`agent_settled`、实际 usage/延迟/错误；工具 end 事件有 `durationMs`（未执行则无）。默认并行批事件按完成顺序到达，结果 transcript 可能按源顺序排列，评测不能把两者混为执行顺序。[事件类型与并发约定](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/agent/src/types.ts)

## 本次核验的限度

官方 npm 产物、发行源码与所选 main 文件的接口已核对。实际离线 smoke（Node v24.4.1）成功 import 公开接口、创建受控 runtime、查到 `deepseek/deepseek-flash`、注册独立 faux provider、创建受控 loader/session，并完成一次 `session.prompt()`；返回 `sdk smoke ok`、activeTools 为空、fauxCalls 为 1。该 smoke 未访问模型 API、未持久化会话和凭据；未做 TypeScript 编译、业务工具测试或真实 DeepSeek 评测。实现端的 typed-tool smoke 与真实冻结集评测仍是验收条件。所有拟用业务工具/schema、预算数值和阶段策略是 POC 实施建议，不是 Pi/DeepSeek 官方业务能力。
