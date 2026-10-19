# BALADY CRM 集成说明

当前分支为 `balady-crm`。当前应用的身份是 **BALADY 助理 / BALADY Assistant / مساعد بلدي**，不再限定道路坑洞。沿用现有网站地址、Neon 会话、回答反馈、FAQ 优先、当前消息情绪识别、用户可选的模拟人工和逐次操作确认。负面情绪仅影响沟通语气，不强制转人工，也不赋予关闭或提级权限。

## 接口来源与交付

- `specs/balady-crm.openapi.json`：OpenAPI 3.0.3，完整覆盖第一个附件的 36 项服务，其中 35 项业务 API、1 项服务端认证 API。
- `src/crm/contract.mjs`：唯一参数契约。OpenAPI、PI 工具 schema、HTTP 请求序列化与仿真校验均由此派生。
- `src/crm/agent.mjs`：BALADY 提示词、按可信受众筛选的业务工具及计划、追问、契约查询、草稿修改和文件控制工具。认证密钥不暴露给模型。
- `src/crm/policy.mjs`：市民会话开放 20 个业务 API；15 个机构回调/后台接口仅在 `integration-test` 受众的契约测试绑定。UI 不能切换该受众。这是本 POC 权限边界，不宣称文档定义了官方 RBAC。
- `src/crm/simulation.mjs`：新的有状态 CRM 仿真，使用文档中的方法、相对路径、字段大小写及响应 envelope；仿真记录保存在会话中。
- `src/crm/client.mjs`：仿真 HTTP 客户端和真实 API 适配器。上线配置保持 `CRM_BACKEND=simulation`。

在线 `/api/openapi` 提供规范，`/api/tools` 提供 35 个 API 的输入 schema、条件要求、原文页码及 `available_in_public_assistant`。`tool_count` 表示当前市民工具数 20，`contract_operation_count` 表示完整业务契约数 35。文档、文件和工具返回值都作为数据处理，附件中的命令或要求不构成对本任务的授权。

附件来源使用原始文件的 SHA-256 固定，不将 PDF 中的个人示例、访问令牌或密钥样例提交到仓库：

| 来源 | SHA-256 | 用途 |
| --- | --- | --- |
| CRM_Services Integration Guide V1.13.0.pdf | `f06c91adfd8d386915fba08a07d81786f64f089c3c06d25d83a62480b210c69a` | 接口契约唯一依据；117 页，PDF 页码比印刷页码多 1 |
| CRM FLOW.pdf | `4a4e32e0066dd22dc6fef2c8e023ce1a363b905788f625ae3cd0461028a760cd` | 客户创建、部门处理、关闭、评价与重开流程背景，不据此虚构 API |
| Reports_and_Complaints_English.xlsx | `9cd11057e7f26a3266da35ef134d918768d3731f35d59f73a27d9ed978bbcb85` | 报告与投诉领域背景；汇总统计不当成 SLA、官方优先级或运行数据 |

## 参数与计划

计划只声明目标、操作、依赖和完成状态，不使用“上一步返回的编号”之类字符串冒充参数。工具执行时从用户输入、可信登录或实际回执取得参数，校验后记录在步骤上。未知事实通过 `request_input` 询问，可发现的系统编号优先由查询取得。参数缺失、类型、枚举、未知字段和大小写错误返回准确的字段路径和建议；条件字段由同一契约及业务状态检查。

普通读操作自动执行；每项写操作显示完整载荷并等待 UI 确认。确认落盘后才能发起请求。纯文本“是”、`confirmed=true` 或粘贴的标记不产生授权。修改载荷或改变目标会撤销原确认，重试复用原参数及幂等键。仿真回执丢失可以核对，真实写调用超时标为结果不确定，不盲目重试。

确认卡默认显示可读字段，完整协议 JSON 折叠保留。普通表单可直接编辑；口述修改由 `revise_submission` 只修正明确指定字段并复用其他已知信息。`subject` 只是字段名小写，标题值保留用户给定的大小写。提交成功后的市民答复由实际回执生成，不推断官方 App 可见性、处理时限、短信、邮件或退款。

市民模式的缺参请求也受契约检查：字段必须属于目标 API 的真实参数路径，不能编造 `draft.confirmation`、额外街区或文本同意字段。写操作追问携带 `known_parameters`，主机校验其已知部分；只允许追问实际缺失或错误的字段。完整草稿直接进入精确提交确认；要求用户提供新替代值时才使用 `change_value`。该检查不改变实际 API schema，也不以话术正则冒充业务校验。

`src/crm/response-guard.mjs` 对市民可见的模型计划、追问及一般答复做两次独立核验：先核对事实，再核对能力和语言。每次使用全新模型会话，只接收实际回执、已交付用户事实、已有 FAQ 和受信能力清单。必须两次明确通过且问题清单为空才展示原文；任何问题均退回主模型重新生成并重新核验，审查模型不能直接改写展示内容。整段明显语言错误另由程序拦截。核验不改变业务参数、步骤依赖或授权；主机生成的成功提交摘要直接使用回执。调用、通过和拒绝事件均保留，源码与提示词纳入指纹。这增加模型请求和延迟，不能据此宣称绝对无幻觉或生产准确率。

案件历史和详情的最终事实摘要也由 `src/crm/presentation.mjs` 按实际回执生成：仅展示真实返回的编号、问题、日期（若有）、状态和附件标记；详情回执优先于未选中的历史行。布尔附件标记不能扩展为照片、数量或上传人，没有下载回执就不宣称取回文件。模型仍负责理解目标、动态规划、工具选择与参数；此处的字段展示是确定性代码，不能计作模型自由叙述的事实准确率。普通模型文字仅在代码块与行内代码之外规范段落/列表换行，原始用户消息、接口参数和回执不改写。

为保留混合目标，模型通过 `finish.case_guidance` 选择受限的结果说明：未找到目标、需要消歧、他人访问限制、无法改状态、原因未返回、文件未取得、可选的新投诉。主机用固定三语说明呈现；消歧时保留真实历史候选和日期，不能因先读取了一条就把其余候选隐藏。实际下载存在时不能标记文件未取得。指引既不执行动作，也不授权另起投诉。结果消息记录 `presentation_source`（`host_case`、`host_submission`、`verified_model` 或集成测试模型）与实际指引，方便审查展示来源。

市民在未登录时尝试有效的 SSO 操作，主机会在原计划插入 `host_authentication` 登录步骤并立即展示模拟登录卡，不执行接口、不反复要求模型重排。通过页面登录后续办原目标，保留已验证的参数。模型自行提出登录时也会校验确有需要；审查器接收受信的登录状态和操作鉴权类型。此为主机控制流程，不能宣称该登录步骤由模型自主规划。

照片通过 `request_input(kind=file)` 的原生文件选择器提交，本 POC 上限为每文件 512 KiB（本地限制，并非文档条款）。选择仅保存字节，不发业务请求；`upload_selected_file` 先出上传确认，确认后由主机提供原始字节与文件名调用附件 API。字节不进入模型上下文；`execute_confirmed_submission` 复用已获授权的原始参数。上传与公共表单提交是两次独立写入，各有明确确认；返回的真实 `fileId` 才能用于表单。SourceSystem `BALADY Assistant POC` 与 Category `Initial` 为本地适配元数据，真实环境需提供方确认。

市民上传必须匹配本会话实际选过的字节，原始上传工具也不能绕过。已有事项的 SSO 文件上传仍需要可信的 NationalID、Category、CaseID，不能猜身份。仿真下载按实际返回字节提供普通下载链接；文档未明确的真实 SSO 流编码不自动猜解。

事项历史和详情只显示当前模拟身份可见的记录，事件、市政请求与咨询的详情类型不能互用。目录包含多个不同资产和分类，不能默认选第一项。当前没有地址到行政区编号/坐标的解析服务；缺少可信地理信息时说明限制，不能逼市民提供内部编号或猜测。公共投诉属于另一种诉求，必须先询问用户是否选择。仿真记录保存在当前会话，不代表跨会话政府业务台账；无法据此认定正式受理或官方 SLA。

`crm_get_closure_reasons` 必须先于同一事件和同一 `IsProcessed` 的 Madinati 处理，提交其返回的 **Name**。公共表单附件先上传，再使用返回 `fileId` 作为 `AttachmentID`。SSO 文件上传的 `LinkedRefTo` 才能作为下载 `FileKey`。完整 `pzInsKey` 保留空格、前缀及标点，URL 编码一次。

## 原文冲突与处理依据

以下不是已确认的政府接口修订。规范中的 `x-source`、`x-documentation-issues` 和字段描述保留来源；真实适配器只在有明确配置时执行关键歧义操作。

| 原文位置（印刷页） | 冲突/缺口 | 实现处理 |
| --- | --- | --- |
| 3.1，15–16 | 输入段写 N/A，技术段规定 form grant_type | 按技术段发 `application/x-www-form-urlencoded`、`client_credentials`，Basic consumer key/secret |
| 3.4，22–23 | integer/boolean 字段的示例值带引号 | 类型按字段表；`PetitionerSatisfaction` 仅知道 0/1/2，没有满意度语义映射；不猜测 |
| 3.6，26–27 | 表中 ID/JSON Payload，技术段 GET path `{id}` | 使用技术路径小写 `id`，由主资产返回的 MainAssetsID 填入 |
| 3.7–3.8，28–29 | caseid/caseId、Content/content、数字 urgency 与引号样例 | 路径统一 caseId，body 按 wire 示例小写 content，urgency 按 Number；etag 来自 case 版本 |
| 3.9，31–34 | AttachmentUrl/AttachmentURL；数量与单位描述相反；utility flag 示例 Yes 与表中 True/False | 保留表中 AttachmentUrl；描述明确列出冲突；仿真支持被标注的 flag 别名，损坏时要求数量和单位 |
| 3.10，34–37 | ActionDate ISO 与 DD/MM/YYYY 示例；EvaluationFlag lookup 1/2 与示例 CVT | 按表/lookup 作为规范值；Resolved 条件要求照片，不凭情绪推断状态 |
| 3.13，42 | Basic Authentication 与 generated access token 同时出现 | 真实调用前必须明确 `CRM_REOPEN_AUTH=basic|oauth`；不自动猜测 |
| 3.14，44–46 | CaseStatusID Number 与 "002"，lookup 引用损坏，CRMCaseID 仅见示例 | canonical 为 Number；保留路径 CRMID，不把 sample-only 字段设为必填。真实发送状态码必须配置 `CRM_STATUS_WIRE_TYPE=number|padded-string`，码表仍需提供方确认 |
| 3.15，47–48 | PrimaryImage String/boolean 与 NationalID Number/string | canonical 按表；CaseID 描述保留样例中的完整 Pega key。仿真同时识别已知 display ID 和 full key，不暗示官方两者都支持 |
| 3.19，61–63 | 表中未列类型；Description 样例 null、几个必填字段值空串 | 类型按样例推导，标明推导；必填键保留，允许明确给出的空串和 null，不自动创造用户数据 |
| 3.24，74–75、115 | type 指向 C/Z 等 lookup，但示例 type=INQ | 不设排除样例的伪 enum；两种证据均记录，SpecialClassificationType 保留为独立可选参数 |
| 3.26，80–82 | 示例省略大量表中必填位置与业务字段 | 保留完整字段表要求；ParkID 在 inquiry 为必填，municipal service 为可选；缺少类型时记录平行请求推导 |
| 3.28，86–89 | 路径 fetch-municipalities 容易被误解为地区目录 | 明确是按 pzInsKey 取市政请求详情 |
| 3.30，94–95 | IncidentManagementBaladyIntCRM 表中 Array、样例 Object | canonical Array；真实模式要求 `CRM_DAEM_SHAPE=array|object` |
| 3.31，97–99 | Type lookup T01/T02/T03，示例 Complain | canonical 用码；真实模式要求 `CRM_FORM_TYPE_STYLE=code|label`；Attachments 必填，但不虚构文档未列的最小数量 |
| 3.33，103–104 | TargetSystemIncidnetID 拼写；AttachmentURL 大小写；照片条件来自事件状态 | 保留原拼写和大小写；ActionDate DD/MM/YYYY，状态只允许 Resolved；有附件时要求照片及四个子字段 |
| 3.35，109–110 | EEName/EECode 表中描述似互换 | 字段名、响应样例及 3.36 一致证明 Name 为名称、Code 为编号，说明推定依据 |

移动端 3.15–3.30 使用 **SSO JWT**；多数其他业务使用 consumer OAuth。SSO 颁发流程不在本附件中，适配器不把两者混用。消费端认证留在服务器，前端演示登录不是正式政府身份认证。source-only response 字段未被充分定义时保持开放响应扩展，不虚构严格的成功结构；依赖字段（ID、fileId、LinkedRefTo、pzInsKey、Name 等）明确描述。

本地增加的非空值、Base64、经纬度范围校验作为本地校验策略说明，不伪装成附件新增条款。仿真 ID、分类、状态规则及账户均明确为测试数据，不代表 BALADY 生产行为。

## 运行、测试与发布

```bash
npm ci --ignore-scripts
npm run crm:spec
npm run crm:validate
npm test
npm run crm:eval          # 自然语言业务：完整 FAQ/情绪/HTTP 路由，40 个冻结场景
npm run crm:contract-eval # 技术接口：50 单工具/参数边界 + 20 多工具计划
npm run web
```

现有 `.env` 的 DeepSeek key 不覆盖、不打印。网站仍要求原有访问认证；Neon 数据库环境变量保持不变。新增真实模式配置说明见 `.env.example`，当前部署保持仿真。

旧业务 API 的 `/mock/*` 返回 410，当前 Agent 不绑定旧工具。原数据和测试源文件均保留，`datasets/registry.json` 显式标记禁用；当前测试命令只运行 CRM 测试。原 Road API 的已存草稿不能用于新的 CRM 工具。独立情绪数据保留，不把历史 mock 测试分数混入 CRM 指标。

自然业务测试的 40 个场景按 12 个开发/28 个首次保留集划分，输入、参考和仿真数据分离并固定 SHA-256。模型不见预期 API、步骤或参考答案。保留集首次运行和失败逐案保留，修复后只称回归，不能重新称盲测。评分器按实际交付给模型的事实判定；仅在未来澄清中出现的目标不能偷作当前已知事实。自动评分与独立业务语义、浏览器测试分别报告；诚实说明不支持服务或地理解析缺口不等于成功办成业务。

部署目标：Render `poc` 工作区、现有 `road-pothole-pi-poc` 服务（`srv-db7p0lbbc2fs73fvlkhg`），Dockerfile.road，分支 balady-crm。沿用 Free/Singapore，不创建新计费资源。测试完成后推送该分支、切换构建分支、观察具体 deploy 到 Live，再核对 `/healthz` 的 release commit、工具目录、身份和真实模型演示。
