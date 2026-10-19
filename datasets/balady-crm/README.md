# BALADY CRM 技术契约回归

本目录验证 API 参数、工具覆盖和技术依赖，使用 `integration-test` 受众；其中明确指定内部字段、工具和执行顺序的话术不是市民业务场景。真实市民目标测试见 [自然业务集](../balady-crm-natural/README.md) 和 [20 个手测场景](../../docs/balady-crm-user-scenarios.md)。两种分数独立报告，技术契约通过率不代表业务成功率。

`tool-cases.jsonl` 有 50 项：35 个操作覆盖案例，以及 15 个缺参、错误枚举、格式纠正、条件必填和查找编号流程。`planning-cases.jsonl` 有 20 个独立流程，覆盖单/双/三/五工具依赖、读后写、两次写操作确认、SSO 登录、追问续办、中英阿拉伯语。

所有案例启用；旧流程在上级 `registry.json` 中标为 disabled，原文件内容不改动。案例引用是人工整理的合成参考，不是生产真实标签或盲测。用例中的个人信息和文件内容均为虚构测试数据。

运行 `npm run crm:contract-eval` 或 `npm run crm:planning`，也可 `node --env-file=.env scripts/crm-eval.mjs --case CRM-P-020 --concurrency 1`。评测调用真实 DeepSeek 模型与实际 PI SDK，业务请求通过文档路径访问本地 HTTP 仿真。为测规划本身，评测隔离 FAQ 和情绪路由；`npm run crm:eval` 默认运行完整路由的自然业务集。参考答案只在执行后参与评分，不送入模型。

每项记录输入、全部计划、模型请求、工具参数、错误、追问、确认事件和实际回执。`reports/crm/<run-id>/` 保存逐项结果、运行配置、源码和数据 SHA-256。发布摘要保存在 `docs/evaluation/`。

指标：工具类型 precision/recall/F1 检查多调和漏调；执行 precision/recall 按调用次数计算，重复调用也扣分；工具 schema 通过率与参考参数匹配率分别报告。动态计划检查必要操作和依赖顺序，缺参流程允许尚未执行的后续 API。`optional_operations` 只用于明确允许的安全前置查询（已给 etag 的再次版本查询、附件发现、缺少分类时的分类查询），不增加 TP，也不豁免错误业务写入。数组子字段追问可覆盖其必填父字段。

无分母指标为 null；不把“没有调用”的案例记为工具 precision=100%。每项写入还检查其实际回执之前有对应参数的 UI 授权。错误和超时保留失败，不从分母排除。
