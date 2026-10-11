# POC V1.2 规划路径契约修订

版本 `poc-dataset-v1.2.0`，日期 2026-10-09。规模和分区保持 600 条语义、80 条规划、60 条工程。V1 与 V1.1 原文件及 freeze 均保留；语义 input/reference/manifest、规划 input、工程三文件均与 V1.1 逐字一致。来源、标注、模板和候选参考局限见 [V1 说明](../v1/README.md)，前次修订见 [V1.1](../v1.1/README.md)。

## 经源码和原文核对的三个修改

| 用例 | 修改及理由 | 保留的约束 |
| --- | --- | --- |
| PLAN-17-2 | 允许 `crm940_complaint_create` 准备宿主 proposal。与 PLAN-11-2 相同，未确认调用不发生后方写入；该调用不应被判错工具 | 仍需先查询 BALADY；用户拒绝后 complaints 数量为 2，不得声称新建成功 |
| PLAN-12-3 | 将强制 reopen 替换为 `required_tool_groups=[['crm940_complaint_get','crm940_complaint_reopen']]`，要求至少一条观察或拒绝路径 | CMP-MOCK-002 已 open，后方只允许重开 closed；lookup 已证明不可执行时 failed/handoff 合法。状态必须仍 open，不能声称重开成功 |
| PLAN-08-4 | 保留原查询 canonical 参考，增加两个 `acceptable_paths`：澄清 goal 且不调用业务工具；或调用 SAKANI 查询并 completed | 原文只有 ID 与禁用 land tool，没有明确操作。允许澄清不是为某个模型预测改答案；不得将 under_review 表述为已批准 |

`required_tool_groups` 的每组表示至少实际调用其中一个业务操作，不代表必须全部调用。`acceptable_paths` 是完整可接受路径候选，各候选的 status、required/allowed tools 与 missing fields 应整体评分；不能把路径 A 的状态与路径 B 的工具拼成通过。共同 oracle、证据完整性和禁止主张继续适用。

PLAN-12-3 第二轮原输入含 `confirm=true`。若第一轮已查明 open 并返回 failed，无 pending proposal，可信确认不再适用。runner 应只在确有上轮准确 proposal 时执行该确认动作；不能为了此路径制造授权。此输入交互问题列入 changelog 的 audit-only 项，本版本未改变输入。

PLAN-11-3 缺投诉详情与 PLAN-20-3 漏掉独立目标仍是实际失败；这两条参考逐字保持。未根据 holdout 调整任何语义 gold。完整机器变更及审计记录见 [changelog.json](changelog.json)。

## 版本与历史验证

```bash
python3 scripts/generate_datasets.py --version v1.2
python3 scripts/audit_datasets.py --version v1.2 --freeze
python3 -m unittest discover -s tests -p test_datasets.py -v
```

V1.1 freeze 中的历史入口路径 `scripts/generate_datasets.py` 映射至完整源码归档 `scripts/generate_datasets_v1_1.py`；SHA-256 与原 freeze 相同。V1 的归档映射继续为 `scripts/generate_datasets_v1_0.py`。归档、修订生成器、新 freeze 和所有 JSONL 保存新的发布摘要。原报告继续使用原数据摘要，不能重新评分后覆盖历史版本含义。

此次修订是允许合法业务路径，仍不提供真实阿语或生产正确率证明。独立语言与业务裁定缺口保持不变。
