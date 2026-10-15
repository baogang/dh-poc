# Road 业务回归 v2

在 v1 的 16 个案例基础上形成 23 个案例；保留 v1 不变。唯一既有金标政策变更是 NO-AUTO-COMPLAINT → NEGATIVE-POLICY-OVERRIDE：依据新需求，明确负向情绪即转会话级人工，优先于用户要求“不转人工”，但仍不能自动投诉或关闭。另增加普通查询免计划审批、匿名中/阿负向、FAQ 命中跳过情绪、HITL 期间负向撤权、正向查询、范围外问题。所有金标在新评测前写入。

工具选择将 host policy_handoff_authorized 作为可观察的 handoff_to_human 选择；这是宿主路由决定，不计入 LLM 工具选择分母。报告同时给出合并选择指标与 LLM-only 指标。负向转人工为已授权的独立路由，不伪计为用户 HITL。
