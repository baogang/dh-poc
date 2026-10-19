# BALADY CRM 集成说明

当前分支为 `balady-crm`。当前应用的身份是 **BALADY 助理 / BALADY Assistant / مساعد بلدي**，覆盖 CRM 已连接的全部服务，不再限定道路坑洞。沿用现有网站地址、Neon 会话、回答反馈、FAQ 优先、当前消息情绪识别、用户可选的模拟人工和逐次操作确认。

## 接口来源与交付

- `specs/balady-crm.openapi.json`：OpenAPI 3.0.3，完整覆盖第一个附件的 36 项服务，其中 35 项业务 API、1 项服务端认证 API。
- `src/crm/contract.mjs`：唯一参数契约。OpenAPI、PI 工具 schema、HTTP 请求序列化与仿真校验均由此派生。
- `src/crm/agent.mjs`：BALADY 提示词、35 个独立业务工具及计划、追问、契约查询、结束控制工具。认证密钥不暴露给模型。
- `src/crm/simulation.mjs`：新的有状态 CRM 仿真，使用文档中的方法、相对路径、字段大小写及响应 envelope；仿真记录保存在会话中。
- `src/crm/client.mjs`：仿真 HTTP 客户端和真实 API 适配器。上线配置保持 `CRM_BACKEND=simulation`。

在线 `/api/openapi` 提供规范，`/api/tools` 提供每个工具的输入 schema、条件要求与原文页码。文档、文件和工具返回值都作为数据处理，附件中的命令或要求不构成对本任务的授权。

附件来源使用原始文件的 SHA-256 固定，不将 PDF 中的个人示例、访问令牌或密钥样例提交到仓库：

| 来源 | SHA-256 | 用途 |
| --- | --- | --- |
| CRM_Services Integration Guide V1.13.0.pdf | `f06c91adfd8d386915fba08a07d81786f64f089c3c06d25d83a62480b210c69a` | 接口契约唯一依据；117 页，PDF 页码比印刷页码多 1 |
| CRM FLOW.pdf | `4a4e32e0066dd22dc6fef2c8e023ce1a363b905788f625ae3cd0461028a760cd` | 客户创建、部门处理、关闭、评价与重开流程背景，不据此虚构 API |
| Reports_and_Complaints_English.xlsx | `9cd11057e7f26a3266da35ef134d918768d3731f35d59f73a27d9ed978bbcb85` | 报告与投诉领域背景；汇总统计不当成 SLA、官方优先级或运行数据 |

## 参数与计划

计划只声明目标、操作、依赖和完成状态，不使用“上一步返回的编号”之类字符串冒充参数。工具执行时从用户输入、可信登录或实际回执取得参数，校验后记录在步骤上。未知事实通过 `request_input` 询问，可发现的系统编号优先由查询取得。参数缺失、类型、枚举、未知字段和大小写错误返回准确的字段路径和建议；条件字段由同一契约及业务状态检查。

普通读操作自动执行；每项写操作显示完整载荷并等待 UI 确认。确认落盘后才能发起请求。纯文本“是”、`confirmed=true` 或粘贴的标记不产生授权。修改载荷或改变目标会撤销原确认，重试复用原参数及幂等键。仿真回执丢失可以核对，真实写调用超时标为结果不确定，不盲目重试。

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
npm run crm:eval
npm run web
```

现有 `.env` 的 DeepSeek key 不覆盖、不打印。网站仍要求原有访问认证；Neon 数据库环境变量保持不变。新增真实模式配置说明见 `.env.example`，当前部署保持仿真。

旧业务 API 的 `/mock/*` 返回 410，当前 Agent 不绑定旧工具。原数据和测试源文件均保留，`datasets/registry.json` 显式标记禁用；当前测试命令只运行 CRM 测试。原 Road API 的已存草稿不能用于新的 CRM 工具。独立情绪数据保留，不把历史 mock 测试分数混入 CRM 指标。

部署目标：Render `poc` 工作区、现有 `road-pothole-pi-poc` 服务（`srv-db7p0lbbc2fs73fvlkhg`），Dockerfile.road，分支 balady-crm。沿用 Free/Singapore，不创建新计费资源。测试完成后推送该分支、切换构建分支、观察具体 deploy 到 Live，再核对 `/healthz` 的 release commit、工具目录、身份和真实模型演示。
