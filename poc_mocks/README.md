# BALADY / SAKANI / 940 / FURAS POC mocks

该服务实现 16 个业务操作：BALADY 5、SAKANI 3、940 4、FURAS task 4。所有身份、路径、规则、数据和机会都是自定义虚构内容。没有连接政府平台、模型或真实认证服务。

Python 3.10+，仅标准库。在项目根目录执行：

```bash
python3 -m unittest discover -s tests -p test_mocks.py -v
POC_MOCK_CONTROL_TOKEN=local-host-test-token python3 -m poc_mocks.server --port 8765 --trace-out artifacts/mock-trace.json
```

服务仅监听 `127.0.0.1`；Ctrl+C 停止时写出各 case 的 oracle snapshot。`/health` 可直接查询。业务调用需要宿主创建独立 case，然后注入 `X-POC-Case-ID` 和绑定身份 `X-POC-Actor`。控制平面要求 `X-POC-Control-Token`，不注册成模型工具，也不把 token、oracle 或 confirmation reference 放入模型上下文。上面的 token 仅为本地手工示例；自动运行器应生成随机值。这些是 fixture 控制，不是生产鉴权。

```bash
curl -X POST -H 'X-POC-Control-Token: local-host-test-token' -H 'Content-Type: application/json' --data '{"case_id":"manual-demo","actor":"citizen-a"}' http://127.0.0.1:8765/__poc/cases
curl -H 'X-POC-Case-ID: manual-demo' -H 'X-POC-Actor: citizen-a' http://127.0.0.1:8765/balady/certificates/CERT-MOCK-001
curl -X POST -H 'X-POC-Case-ID: manual-demo' -H 'X-POC-Actor: citizen-a' -H 'Idempotency-Key: manual-start-1' -H 'Content-Type: application/json' --data '{"goal":"Find mock cafe opportunities","criteria":{"city":"Jeddah","sector":"cafe","budget_sar":250000}}' http://127.0.0.1:8765/furas/tasks
```

接口和参数见 [catalog.json](catalog.json)。JSON 响应包含 `ok`、`data` 或 `error`，以及 `meta.source_type=mock`、fixture 版本、operation ID、event ID。trace 由宿主/测试代码读取，不向模型提供后台 fixture 或参考答案。

BALADY 用途变更必须先预校验，再由宿主根据可信用户确认交互签发参数绑定的 confirmation，注入后方 body 和 `Idempotency-Key`。模型侧 tool schema 应剔除 `confirmation_ref`。控制创建的 case 清空所有旧静态确认；资源归属、完整参数绑定、确认消费、陈旧校验均在执行时检查。提交仅新增申请，原证书用途不会变化。940 新建/重开也要求确认和幂等；重开不表示问题修复。

FURAS start/resume/cancel 要求幂等键，get 为查询。缺少 city/sector/budget_sar 返回 `needs_input`；在同一 task 补充后为 `pending`。默认第一次 GET 仍为 pending，第二次为 completed；`agent_pending_polls` 可设置等待轮数，`agent_failure` 可模拟最终 failed，也可取消未完成任务。completed 只代表脚本机会筛选完成，不包含收益预测或实际投资。当前没有 LLM 驱动的 Giant Agent。

fixture 可从 [base.json](fixtures/base.json) 复制修改，再通过 `--fixture <path>` 加载。不要在运行时让模型选择 fixture 或修改它。可注入按操作名消耗的故障，例如：

```json
{
  "faults": {
    "balady_certificate_get": [{"status": 503, "code": "MOCK_UNAVAILABLE"}]
  }
}
```

将 `faults` 合并到完整 fixture，首次对应调用返回 503，随后恢复正常。控制接口的 `fixture_patch` 可为各 case 注入独立故障；`phase=after_commit` 模拟写提交后响应丢失：先返回 504，但以相同参数和幂等键重试会取得原回执，不会重复修改。一个服务支持并行的独立 case，每个 case 拥有自己的初态、申请、task、确认、幂等缓存、故障和 trace，不同用例不会共享被改写的状态。

完整控制契约见 [mock-contract-v1.md](../docs/mock-contract-v1.md)：`POST /__poc/cases` 创建、`GET /__poc/cases/{case_id}/snapshot` 读取 oracle、`POST /__poc/cases/{case_id}/confirmations` 签发确认、`DELETE /__poc/cases/{case_id}` 清理。控制路径必须保留在宿主，不能让模型调用或看到 oracle。

直接进程内调用可用于离线 harness 测试：

```python
from poc_mocks.server import MockEngine

engine = MockEngine()
status, payload = engine.request(
    "GET", "/crm940/complaints/CMP-MOCK-001",
    headers={"X-POC-Actor": "citizen-a"},
)
events = engine.trace
```

进程内 `MockEngine` 的旧静态 confirmations 仅为离线合同测试兼容；自动 Agent 回归必须走独立 case 控制接口。当前测试验证 mock 合同、真实 HTTP 隔离、确认绑定、任务状态与结果未知恢复；这些不证明真实政府接口可用、Agent 语义准确或达到生产条件。
