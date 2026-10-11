# POC Web 评测台使用指南

在项目根目录运行 `npm run web`，打开 <http://127.0.0.1:8787>。使用 Node.js 22.19 以上及 Python 3；依赖已经安装。需要换端口时运行 `POC_WEB_PORT=8788 npm run web`。服务仅监听本机地址，适合本机验证和现场演示。

DeepSeek API key 保留在服务端 `.env` 的 `DEEPSEEK_API_KEY`，不会下发到浏览器。工程回归无需模型凭证；其他三类测试发起真实 DeepSeek 调用。情绪模型与规划模型可分别选择当前 Pi SDK 目录中的 `deepseek-flash` 或 `deepseek-v4-pro`。页面不会自动发送真实个人数据，请使用模拟标识与经授权的测试内容。

## 推荐试跑

1. 打开「测试数据」，选择某个冻结集，查看案例、原话、参考与元数据；可以筛选 split、语言及关键词，勾选需要测试的案例。
2. 打开「模块与插件」，查看情绪、规划、完整流程及工程测试的职责和指标；BALADY、SAKANI、940、FURAS 的能力、参数和 SKILL 内容来自实际注册表。
3. 在「新建测试」选择模块和兼容数据集。首次可以运行工程回归全部 60 条，或情绪模块最多 5 条。高级配置支持 split、案例 ID、数量、并发、请求及 Token 预算、flat/layered 与 16/32/64/128/256 工具目录。
4. 动态规划的四系统小规模试跑可选择 `PLAN-01-1, PLAN-06-1, PLAN-09-1, PLAN-13-1`，策略 layered、目录 32、并发 2。这覆盖证书、补贴条件、投诉查询及投资 Agent；仍是小规模验证，不能替代全部 80 条的回归。
5. 完整流程可选择 `ROUTE-01-1, ROUTE-03-1, ROUTE-04-1, ROUTE-07-1`，检查自动规划、负面人工交接、混合澄清和多轮路由。人工接通为模拟，不表示真实客服已接入。
6. 运行后查看进度、预算和逐案结果，打开详情查看输入、预测、参考、工具参数、回执及后台状态。下载 `config.json`、`summary.json`、`results.json` 或 Markdown 报告。

页面刷新、切换页面不会重新启动调用。「运行结果」回到最近任务，「历史运行」包含现有 CLI 记录及 Web 新任务，可以按模块、模型/数据版本关键词及状态筛选。「再次运行」填入原有效配置，提交后创建新记录；旧版没有兼容的数据集标识时只提供结果查看，避免错误套用当前数据版本。

## 导入自己的数据

「导入数据集」分别提供每个模块的有参考与仅输入 JSON/JSONL 模板。选择文件，或粘贴内容，点击「校验并预览」，确认案例、评分范围和错误位置后点击「保存新数据集」。保存成功后立即进入该版本的浏览页，可直接运行。

JSON 文件为如下对象；`module` 使用 `emotion / planning / integration / engineering`：

```json
{
  "name": "我的规划测试集",
  "version": "1.0",
  "module": "planning",
  "cases": [
    {
      "case_id": "CUSTOM-001",
      "input": {
        "actor": "citizen-a",
        "turns": [{"message": "查询 CERT-MOCK-001 的当前用途"}]
      },
      "metadata": {"split": "regression", "language": "zh"}
    }
  ]
}
```

JSONL 每行是上面 `cases` 中的一个案例对象，名称、版本与模块使用页面配置。空行允许，错误按原文件的行号定位。最多 10 MB、5,000 案例，ID 必须唯一，只能使用字母、数字、下划线和连字符。重复 ID、非法标签、消息关联缺失、不匹配的轮数、未知工具及模块不兼容均不能保存。预览后改变内容必须重新预览。

`reference` 可省略或为 null。仅输入的案例保留真实输出与 Trace，不计算 Accuracy / Precision / Recall / F1。部分参考的数据只为有参考的案例评分，并显示覆盖数量。

情绪参考需要 `sentiment / emotions / indicators`；提供 evidence 时应覆盖标签且来自用户原话。规划的 `required_tools / allowed_tools` 可单独用于工具 P/R；完整任务通过率还需要 `allowed_statuses / required_clarification_fields / required_order / tool_arguments / assertions / turn_expectations` 等契约字段，可从有参考模板修改。参考答案只在执行后进入评分器，不作为模型输入。工程模板只能使用已有故障契约，不导入可执行代码。

每次导入生成独立 ID、版本和 SHA256。相同名称与版本也不会覆盖以前的数据，内置冻结集保持只读。导入标签被标记为用户提供，合成标签及用户标签均需要专家审核后才适合业务验收。

## 取消与持久化

点击「取消并保留部分结果」会传播 AbortSignal：停止在途模型请求、Pi 循环、后方请求及后续案例调度。页面先显示中止中，完成保存后再显示已取消。已完成案例、取消案例和未执行案例分别计数；只为已完成且有参考的案例计算部分指标，不生成完整回归通过结论。供应商可能已消费在途请求的 Token，账单以供应商为准。

数据存储在 `artifacts/web/datasets/`，任务状态在 `artifacts/web/jobs/`，实际报告和逐案输出在 `reports/history/<run_id>/`。重启服务后导入集和历史记录仍可查看。意外停止时，未结束的任务标为 interrupted，保留已经保存的案例；不会自动重发模型请求。显式「再次运行」创建新记录。

旧报告的指标、源码、样本范围保持原状。旧 semantic 包含 Intents，当前 emotion 不包含；工具指标也保留各版本定义。没有输入快照的旧案例不会仅凭相同 ID 冒用当前输入。

## 结果解释与原 CLI

工具 Precision 衡量允许的选中工具 / 所有选中工具；Recall 衡量命中的必需工具 / 必需工具，包含替代组。提议与被宿主拦截的工具尝试也计入选择；任务契约另外验证对象、参数、依赖、状态和回执。空分母显示 —。情绪的 Sentiment 单标签 Accuracy 等于 micro Recall，各标签 P/R/F1 可展开查看。

已有全量评测结论没有被 Web 功能改写：情绪 600 条 Sentiment Accuracy 87.50%、Macro F1 84.28%，部分 SA Precision 未达到原定门槛。历史规划 80 条及完整流程 32 条通过率为 100%；模拟数据的通过率不能当作真实上线准确率。请从历史页核验对应原报告。

现有 CLI 继续使用，例如 `npm run eval:offline`、`npm run eval:emotion`、`npm run eval:planning`、`npm run eval:integration`。Web 与 CLI 复用执行入口及评分器；Web 导入数据不会冒用内置冻结集的回归结论。
