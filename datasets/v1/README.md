# POC V1 冻结数据集

版本 `poc-dataset-v1.0.0`，生成日期 2026-10-09。600 条语义情感输入、80 条业务规划对话、60 条确定性工程故障规范。数据不含真实客户资料，所有业务规则、身份和 ID 均为虚构 POC 数据。

## 文件与运行隔离

每组使用三个 JSONL 文件，按 `case_id` 关联：

- `inputs.jsonl`：运行输入，语义为 `input.messages[{id,role,content}]`、`current_message_id`、`transcription_quality`；规划为 `input.actor`、`turns[{message,confirm?}]`、可选 `fixture_patch`。
- `references.jsonl`：评分参考，运行模型不能读取。语义为 `sentiment/emotions/indicators/intents/evidence`；规划为合法及必要工具、禁止工具、依赖、参数包含断言、结果状态、业务初态变化及追问要求。
- `manifest.jsonl`：分区、家族、语言/表达现象、来源与审核状态。运行模型不能读取。

规划中的 `actor` 由宿主身份注入；`fixture_patch` 由测试宿主改变模拟系统初态，不作为提示词发送；`confirm=true` 是测试模拟可信用户确认动作，只确认上一轮宿主保存的准确 proposal。它不是任何可由模型生成的授权 token。模型只接收对话消息和获准工具结果。初态以 `poc_mocks/fixtures/base.json` 为准，每条用例必须创建独立 engine 和 session。

`engineering` 是故障测试规范，不是待模型学习的文本。六类 `test_type`：`semantic_contract`、`tool_guard`、`backend_fault`、`session_isolation`、`budget`、`prompt_security`。语义契约可提供 `raw_output` 或对一份正常候选的 `mutation`；工具测试提供 operation/arguments；其余提供具体 scenario/fault 及期望错误或不变量。执行 runner 必须显式报告执行了哪些规范，不能把文件存在当作已通过。

## 规模与生成方式

语义有 150 个场景家族，每家族 4 个变体。63 个指标家族（252 条）、25 个情绪服务家族（100 条）、25 个表达难点家族（100 条）、25 个多轮家族（100 条）、12 个普通或域外家族（48 条）。原计划 250/100/100/100/50 调整为 252/100/100/100/48，以保持完整家族。

四个兄弟用例改变当前与历史、肯定与否定、同一对象与不同对象、推测与事实，或情感目标，不仅替换资源 ID。例如某场景包括“关闭仍未解决”“关闭且已解决”“不确定是否关闭”“历史未解决但今天已解决”。60 个基础 SA 故事涉及实际市政对象、不同工作环节与投资/住房支持；不同业务域的 intent 按故事单独定义。难点组和规划组另有人工编写的具体表达和依赖。

生成器保存阿语与英文表达，按预先确定的家族语言分配产生原始输入；MSA 有确定性词汇调整，阿英混合有服务术语替换。**这提供受控语言覆盖，没有证明方言自然度；共享模板和语言转换是当前数据的实际局限。**沙特口语 360、MSA 120、阿英混合 90、英语 30 是设计配额，不是客户流量比例。`requested_dialect` 是生成意图，`reviewed_dialect=null`；英文同样未经独立母语审核。

没有使用被测 DeepSeek 生成这些参考，也没有让 DeepSeek 判断自己是否正确。没有调用 Gemini。作者为 Codex，自动脚本负责渲染、配额、引用与冻结。所有语义/规划参考状态均为 `provisional`，不能称人工裁定 gold。当前模型成绩只能称“合成候选参考符合度”；投入生产仍需要真实脱敏业务输入、业务裁定和本地阿语独立复核。

## 分区

先固定家族再产生变体，固定 seed 为 `20261009`。同一故事的语义反事实、改写和语言变体不跨分区。

| 数据 | dev | regression | holdout |
| --- | ---: | ---: | ---: |
| 语义情感 | 300（75 家族） | 120（30 家族） | 180（45 家族） |
| 业务规划 | 32（8 家族） | 24（6 家族） | 24（6 家族） |
| 工程故障 | 0 | 60（15 家族） | 0 |

dev 可以调提示词；regression 检查已知行为退步；holdout 用于预先约定的里程碑。只要根据 holdout 失败更改了系统并据此选择候选，应在报告中登记 `holdout_used_for_selection=true`，后续独立确认需新家族。不能把同一保留集的反复修复成绩当独立估计。

## 标注规则

情感：`positive` 正面评价/感谢，`negative` 当前明确负面评价，`mixed` 当前存在相反评价或目标，`neutral` 无可确定的正负态度，`undetermined` 输入过短、截断或不可解释。事实性“尚未完成”不自动代表负面情感；强度也不能替代业务风险。

七类情绪：`satisfaction` 对结果/处理满意；`gratitude` 表达感谢；`frustration` 反复障碍或等待导致沮丧；`anger` 明确愤怒/不可接受的对抗评价；`worry` 当前担忧；`disappointment` 期望与结果落差；`confusion` 不理解或困惑。不把坐席、第三方引语或已经缓和的历史情绪转成市民当前情绪。邻近情绪仍可能有真实歧义，需独立复核。

- `SA01`：当前同一已关闭问题仍未解决；关闭状态单独不足。历史未解决但现已解决排除。
- `SA02`：市民表示对同一问题/请求多次联系；第三个对象、三个不同请求和编号含 3 排除。
- `SA03`：当前感知过度等待/延迟；仅日期或在预期时间内排除。它不等于 SLA 违约。
- `SA04`：当前潜在现场安全危险；历史已消除、假设危险、愤怒本身排除。
- `SA05`：同一对象修复或报告修复后再次发生；从未修复、另一对象的新故障排除。报告修复只是市民语义主张，未经独立后方核验。

意图为 16 类：`complaint_status`、`complaint_reopen`、`complaint_create`、`contact_history`、`application_status`、`certificate_query`、`land_use_change`、`planning_query`、`support_requirements`、`support_eligibility`、`support_status`、`investment_advice`、`investment_status`、`investment_cancel`、`clarify`、`other`。`support_*` 仅住房支持。假设性问“如何报事”而未请求登记当前问题标 `other`；仅情绪但没有可执行业务目标时标 `other/clarify`。多意图允许多标签。

证据用原文 message_id + quote，允许模型选择更短但同样支持结论的片段。候选参考多数使用完整当前句，故定位有效不代表语义正确，评分器应将位置与标签支持分别报告。`neutral/undetermined` 引用的是判断依据文本，不代表有情绪锚点。多轮 SA 可能同时依赖历史与当前，评分不能把一处引用视为完整事实核验。

## 规划断言

`allowed_tools` 是合法操作集合，`required_tools` 是必须实际调用的业务操作集合，宿主目录/Skill/结果提交不混入业务 P/R；重复调用另算效率。`required_order` 只描述必要数据依赖，独立查询顺序任意。`tool_arguments[].contains` 比较必须参数，`allowed_statuses` 接受正常拒绝/失败/人工建议等明确状态。

`assertions` 用 `oracle.state.*` 路径对实际模拟 engine 终态评分；`tasks_count`、`task_status_counts` 对实际任务库评分，防止重复建任务。`turn_expectations` 描述部分多轮的重要阶段。`forbidden_claims` 是具体业务结论 ID（例如投资已执行、证书已改、现场已解决），评测需要将结果主张与系统证据对照，不能只做英文字符串查找。

全套覆盖 16 个操作、缺 ID 追问及续接、可信确认后写、拒绝不写、FURAS 追问续接/取消/pending、条件跨域调用、规划冲突、身份、查无记录、系统失败和部分成功。工具规模扩展实验保持输入/参考冻结；新增能力若形成新的合法路径，应升级参考版本。

## 重建、审计与冻结

```bash
python3 scripts/generate_datasets.py
python3 scripts/audit_datasets.py --freeze
python3 -m unittest discover -s tests -p test_datasets.py -v
```

`audit.json` 列出规模、语言、标签正例数、分区、工具覆盖、证据定位及近重复；近重复用词三元组 Jaccard ≥0.80 筛查，精确重复按完整角色文本判断。阈值未命中不能证明语义独立，跨故事共享句式仍需人工检查。`freeze.json` 保存各文件 SHA-256 和总 release digest；运行报告应记录冻结摘要，改数据必须重新发版/保存新冻结记录，不能静默修改原报告的输入。
