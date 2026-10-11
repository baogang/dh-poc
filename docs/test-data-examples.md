# 测试数据样例与使用方法

2026-10-09。以下摘自已冻结的`datasets/v1.2`：600条语义、80条规划、60条工程。均为合成场景及虚构ID，参考标签为provisional，尚未由阿语母语与业务专家审核。中文为助读释义，不是发送模型的测试文本。

## 情绪分析样例

| case_id | 原始输入 | 中文助读 | 候选参考 |
|---|---|---|---|
| SEM-001-1 | الـ report عن تراكم النفايات خلف السوق صار closed، بس نفس المشكلة للحين موجودة. طفشت من هالوضع. | 市场后垃圾堆积的报告关闭了，但问题仍在，我受够了。 | sentiment=negative；emotions=[frustration]；indicators=[SA01] |
| SEM-001-2 | بلاغ تراكم النفايات خلف السوق مقفل، والمشكلة انحلت بالـ site. أنا راضي عن result. | 报告已关闭，现场问题解决了，我满意结果。 | positive；[satisfaction]；[] |
| SEM-001-3 | هل الـ report عن تراكم النفايات خلف السوق مقفل؟ ما أدري إذا انتهت المشكلة، وضحوا لي status. | 报告关闭了吗？我不知道问题是否解决，请解释状态。 | neutral；[confusion]；[] |
| SEM-065-4 | أشكرك على تعاونك في توضيح حالة طلبي، لكن result خيبت أملي. | 感谢你解释申请状态，但结果令我失望。 | mixed；[gratitude, disappointment]；[] |
| SEM-099-4 | الررر... الطلب... ما أدري وش المقصود. | 含文本噪声和不完整表达。 | undetermined；[]；[] |

模型接收的输入示例：

```json
{
  "current_message_id": "m1",
  "messages": [{
    "id": "m1",
    "role": "user",
    "content": "أشكرك على تعاونك في توضيح حالة طلبي، لكن result خيبت أملي."
  }],
  "transcription_quality": null
}
```

测试器在模型输出后比较sentiment、emotions与SA指标，计算各标签P/R/F1、整体Micro/Macro F1；同时检查JSON和证据是否为原文片段。原冻结参考还含旧16类intents，更新后的情绪模块只使用情绪/SA参考视图，不把旧业务意图标签发送模型，也不覆盖旧数据。span存在不证明该span语义上支持标签。

## 动态规划样例

| case_id | 实际输入 | 期望动作与检查 |
|---|---|---|
| PLAN-05-1 | Check the status of land-use application APP-MOCK-001, do not complain. | 调用balady_application_get(application_id=APP-MOCK-001)，不创建投诉 |
| PLAN-03-1 | تحقق فقط إذا أقدر أغير CERT-MOCK-001 إلى COMMERCIAL، لا تقدم طلباً. | 只校验变为COMMERCIAL的可行性：balady_change_validate；不能submit，证书仍为RESIDENTIAL |
| PLAN-02-3 | أبي استعمال الأرض حسب المخطط، ما أعرف رقم القطعة. | 缺parcel_id，追问；不调用业务工具，不编造ID |
| PLAN-11-1 | سجل شكوى municipal_service_delay تخص APP-MOCK-001. الوصف: POC: certificate change pending. 第二轮：نعم، أؤكد تنفيذ هذا الإجراء. | 第一轮准备投诉提案；第二轮由测试宿主提供confirm=true批准精确提案，才写入；投诉数从2变3 |
| PLAN-14-1 | 第一轮：ابحث عن فرص cafe في Jeddah. 第二轮：ميزانيتي budget_sar 250000. | start取得needs_input并追问budget_sar；补充后resume同一任务，再get；只能创建一个Agent任务 |
| PLAN-18-1 | Find cafe opportunities in Jeddah for budget_sar 250000; then check planning for the returned parcel. | furas_task_start→furas_task_get→balady_planning_get；取实际返回parcel_id，不预设资源 |

参考检查的示例片段（不发送模型）：

```json
{
  "required_tools": ["balady_application_get"],
  "allowed_tools": ["balady_application_get"],
  "tool_arguments": [{
    "tool": "balady_application_get",
    "contains": {"application_id": "APP-MOCK-001"}
  }],
  "allowed_statuses": ["completed"]
}
```

测试器给每个case建立独立mock状态，把每轮用户消息交给Agent，记录工具名、参数、顺序、proposal、真实dispatch、回执和最终状态。执行后才把参考交给评分器；mock的oracle只给宿主评分，不给模型。工具P/R检查必需操作、合法辅助操作和误调用；任务通过额外检查资源/参数/顺序/确认/后方状态。工具选对但参数错，不能称任务成功。

## 两个模块如何独立测试

情绪独立评测只调用分类模块；规划独立评测绕开情绪路由，由测试宿主允许调用工具，用来观察规划能力。完整POC另外评测“情绪→宿主策略→Agent或人工”，负面人工路径应无自动业务dispatch。不能因负面被正确转人工、没调用工具，就判定规划漏选；也不能把独立规划分数当作完整路由效果。

只查看这些样例，无需调用模型：

```bash
rg 'SEM-001-1|SEM-065-4' datasets/v1.2/semantic/inputs.jsonl datasets/v1.2/semantic/references.jsonl
rg 'PLAN-03-1|PLAN-14-1|PLAN-18-1' datasets/v1.2/planning/inputs.jsonl datasets/v1.2/planning/references.jsonl
```

原V1 CLI的选例格式如下。更新实现正在另一聊天“Semantic Analysis POC - 1”进行；待该实现完成后，以其发布的独立模块命令和报告为准，以下不表示更新版已完成验证：

```bash
npm run poc -- eval --suite semantic --case-ids SEM-001-1,SEM-001-2,SEM-065-4 --concurrency 2
npm run poc -- eval --suite planning --case-ids PLAN-05-1,PLAN-03-1,PLAN-14-1,PLAN-18-1 --concurrency 2
```

CLI输出run-id与报告路径。打开`reports/history/<run-id>/report.md`看汇总、`summary.json`看指标、`cases/<case_id>.json`看输入执行对应的预测、trace和真实后方结果。这些命令会调用已配置的模型API。

原文件：

- [语义输入](../datasets/v1.2/semantic/inputs.jsonl)、[语义参考](../datasets/v1.2/semantic/references.jsonl)、[语义分区](../datasets/v1.2/semantic/manifest.jsonl)。
- [规划输入](../datasets/v1.2/planning/inputs.jsonl)、[规划参考](../datasets/v1.2/planning/references.jsonl)。
- [工程输入](../datasets/v1.2/engineering/inputs.jsonl)：例如ENG-021验证查询他人证书时返回NOT_OWNER；ENG-041验证FURAS接口503时不能声称任务已完成。
