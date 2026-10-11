# POC V1.1 数据契约修订

版本 `poc-dataset-v1.1.0`，日期 2026-10-09。此版本保留 600 条语义情感、80 条规划对话、60 条工程规范及原分区。基线的数据含义、标签定义、局限和物理输入隔离见 [V1 原始说明](../v1/README.md)。所有语义输入、参考和 manifest 均从 V1 逐字复制；不根据模型预测改语义 gold。

## 独立核对与修改范围

通过实际源码核对两类契约问题后修改：

1. `src/entry-agent.mjs::executeBusiness` 的写 Tool 在未获得可信确认时只创建 proposal 并返回 `needs_confirmation`，不会调用后方写 API。`src/scoring.mjs` 则统计全部 business Tool 调用，因此等待确认和拒绝确认用例需要允许准备 proposal 的 Tool。后方状态仍必须满足原来的未变更断言。
2. `poc_mocks/server.py` 允许 `agent_pending_polls` 范围为整数 0..100。原始 1000 会在创建 fixture 时被拒绝，尚未到达轮询预算测试。100 仍远超过本轮三次 poll 的预算，保持原测试意图。

| 用例 | 修改 | 保留的约束 |
| --- | --- | --- |
| PLAN-04-2 | 允许 `balady_change_submit` 准备 proposal | 拒绝后无新申请，证书用途不变 |
| PLAN-04-4 | 允许前一轮的提交 proposal；最后的 validate-only 目标应为 completed，并要求确实预校验 RESIDENTIAL | 无新申请，证书用途不变；旧提交目标已被用户替换 |
| PLAN-11-2 | 允许 `crm940_complaint_create` 准备 proposal | 拒绝后投诉数量仍为 2 |
| PLAN-11-4 | 允许 `crm940_complaint_create` 准备 proposal | 最终 needs_confirmation，投诉数量仍为 2 |
| PLAN-12-2 | 允许 `crm940_complaint_reopen` 准备 proposal | 拒绝后原投诉仍 closed |
| PLAN-15-3 | pending polls 从 1000 改为 100 | 轮询预算结束时任务仍 pending，不伪造完成 |
| PLAN-16-1 | pending polls 从 1000 改为 100 | 任务仍未完成，可以在后续输入中取消同一任务 |
| ENG-054 | pending polls 从 1000 改为 100 | 最多 3 次 poll，不能报告任务已完成 |

PLAN-04-4 的 V1 参考原本已经允许 `completed`，本次将终态明确为新 validate-only 目标的 `completed`，不能把它解释成原变更申请已提交。取消旧目标可作为独立轨迹记录，不替代当前目标状态。未修改缺关键参数时的工具集合，也未修改其他用例的参考结论。

改过的 manifest 记录 `contract_revision`。完整机器可读变更和独立源码核对依据保存在 [changelog.json](changelog.json)。V1 原始文件和 freeze 字节保持不变，不把本修订覆盖到历史测试报告。

## 历史生成器与冻结

V1 的 freeze 曾包含可变路径 `scripts/generate_datasets.py` 的 SHA-256。为增加版本选择，该入口已修改；原始完整源码保存为 `scripts/generate_datasets_v1_0.py`，其字节哈希与 V1 freeze 内原始路径哈希相等。这个映射记录在 changelog 的 `baseline_generator_archive`，验证历史源时应读取该归档，不修改历史 freeze。

```bash
python3 scripts/generate_datasets.py --version v1.1
python3 scripts/audit_datasets.py --version v1.1 --freeze
python3 -m unittest discover -s tests -p test_datasets.py -v
```

V1.1 的 `freeze.json` 含新的发布摘要、输入/参考/manifest/说明/变更记录，以及入口、修订生成器和 V1 归档源码哈希。回归报告必须记录 `dataset_version` 和当前 release digest，历史报告继续保留其原始版本和摘要。

此修订解决评测契约和非法 fixture，不提高自然语言参考的可信度，也不构成生产资格证明。其他未知问题应作为独立审计项登记，不能为了使模型过关直接改变参考。
