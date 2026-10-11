# POC V1 模拟后方与宿主控制契约

版本：2026-10-09。业务接口数量为 16；以下控制接口不计入业务工具数量，不应进入 Pi tool/Skill 目录。

## 服务与身份边界

`python3 -m poc_mocks.server --port 8765` 只监听 `127.0.0.1`。宿主通过环境变量 `POC_MOCK_CONTROL_TOKEN` 提供随机控制 token，所有 `/__poc/` 请求要求 `X-POC-Control-Token`。token 无默认公开值，不打印到服务日志。如果未设置会在进程内随机生成，适用于只通过 Python `make_server` 控制的测试。

业务请求使用宿主头：

```text
X-POC-Case-ID: live-case-001
X-POC-Actor: citizen-a
Idempotency-Key: stable-user-action-key   # catalog标记 requires_idempotency_key 时要求
```

case actor 在创建时绑定，后续 actor 不匹配返回 `CASE_ACTOR_MISMATCH`。身份、确认 reference、case ID、幂等键属于宿主参数，不能让模型填写。这里的 token 和 fixture actor 是本地测试隔离机制，不是生产认证实现。

## 创建独立 case

`POST /__poc/cases`

```json
{
  "case_id": "live-case-001",
  "actor": "citizen-a",
  "fixture_patch": {
    "agent_pending_polls": 1,
    "faults": {
      "balady_certificate_get": [
        {"phase": "before", "status": 503, "code": "MOCK_UNAVAILABLE"}
      ]
    }
  }
}
```

201 响应：

```json
{"ok": true, "case_id": "live-case-001", "actor": "citizen-a", "fixture_version": "poc-fixtures-v1", "source_type": "mock"}
```

`fixture_patch` 为递归 object merge，数组整体替换。允许修改资源表、`investment_opportunities`、`agent_pending_polls`、`agent_failure`、`faults` 和 `fixture_version`；不允许注入 actors 或 confirmations。创建后清空旧静态 confirmations。重复 case_id 为 409，非法 fixture 或 actor 为 400。每个 case 起始状态来自冻结 base fixture，case 之间不共享变更或故障消费。

## 宿主签发确认

`POST /__poc/cases/{case_id}/confirmations`

```json
{
  "operation_id": "crm940_complaint_reopen",
  "path_parameters": {"complaint_id": "CMP-MOCK-001"},
  "body": {"reason": "The issue remains unresolved"},
  "confirmed": true
}
```

200 返回顶层 `confirmation_ref`、`operation_id`、`scope`、`ok` 和 `source_type`。issuer 验证已注册 write 操作、精确参数字段和资源归属，绑定 case 内 actor、operation、path_parameters、body；不会允许宿主借额外 actor 参数泛化授权。`confirmed` 必须为布尔 true，且只能由宿主依据可信用户交互决定，模型文本不能签发确认。

宿主在后方业务请求 body 内注入返回的 `confirmation_ref`。例如重开请求实际 body 为 `{"reason":"The issue remains unresolved","confirmation_ref":"CONFIRM-HOST-..."}`。同一确认不允许修改 reason、资源或 validation_id。执行成功后消费确认；相同幂等键重试先读取缓存，仍返回原回执。宿主应保存 exact proposal，在用户确认前仅返回 `needs_confirmation`。

BALADY issuer 根据 `validation_id` 验证预校验属于该 actor，同时绑定具体 validation；最终执行再次检查当前证书和规划版本。940 issuer 验证关联申请/投诉归属。业务执行仍会检查类别、状态等规则，签发确认不等于业务审批。

## Oracle 与清理

`GET /__poc/cases/{case_id}/snapshot` 返回：

```json
{
  "ok": true,
  "case_id": "live-case-001",
  "source_type": "mock",
  "state": {},
  "tasks": {},
  "validations": {},
  "trace": [],
  "used_confirmations": [],
  "idempotency_entries": 0
}
```

state/tasks 等由服务器实际状态生成。trace 包含 operation_id、actor、body、状态、回执和 replay 标记；写后响应丢失时 oracle 额外保留 `result_unknown=true`、`committed_data`，这些内部字段不会出现在业务错误响应中。评分器可以据此区分“模型宣称成功”和“系统确实产生状态变化”。删除使用 `DELETE /__poc/cases/{case_id}`，返回 deleted；snapshot、删除、确认都要求宿主控制 token。

## 确定性故障与幂等

每个操作对应故障数组，按首次非缓存调用逐个消费：

```json
{
  "faults": {
    "balady_certificate_get": [
      {"phase": "before", "status": 503, "code": "MOCK_UNAVAILABLE"}
    ],
    "balady_change_submit": [
      {"phase": "after_commit", "status": 504, "code": "MOCK_RESULT_UNKNOWN"}
    ]
  }
}
```

before 故障没有业务执行；省略 phase 默认 before。after_commit 仅允许配置在要求幂等键的修改操作：执行已成功、回执已经缓存，但调用者先收到 504 和结果未知错误。宿主重试必须保存原 path/body/key，返回原回执且不会重复执行或再次消费故障；不同参数重用同 key 返回 `IDEMPOTENCY_CONFLICT`。没有新重试预算时必须报告结果未知，而不能声称没有提交或已成功。

FURAS start/resume/cancel 也遵循上述幂等机制。`agent_pending_polls=0` 时完整条件的任务在首次 get 完成；缺条件时始终 needs_input。设置 `agent_failure={"code":"MOCK_PROVIDER_DOWN","message":"fixture failure"}` 后，任务在等待结束时进入 failed，而不是 HTTP 故障。get 返回 cancelled/failed/completed 均为正常任务状态响应；failed 状态包含 failure，completed 包含结果引用与限制。

Mock 状态和幂等缓存存于内存，进程重启会丢失。这里验证的是宿主逻辑与协议恢复，不代表跨进程、跨真实异构系统的生产 exactly-once 保证。
