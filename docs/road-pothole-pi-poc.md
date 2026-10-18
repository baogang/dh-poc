# Road Pothole PI SDK PoC

Requirements confirmed on 2026-10-14, updated by the 2026-10-19 product review:

- DeepSeek `deepseek-flash` and pinned PI SDK 1.1.0; no HiAgent runtime dependency.
- J-01: text-described new pothole, trusted login/profile or manually supplied city and street, automatically started plan, exact submission authorization, real mock receipt.
- J-08: query owned historical tickets, select and confirm the report, confirm it remains unresolved, use mock-supplied decision context, then submit a complaint or create a human handoff. Closing is another registered ticket operation.
- Six mock external API operations: login, create, query, close, complain, handoff. The handoff endpoint also supports simulated human status transitions.
- Knowledge first: an answerable FAQ returns its source answer directly; ambiguous service questions ask for a service and resume the original question. On a true FAQ miss, three-class sentiment runs; negative offers a user choice of simulated human help or continuing with AI, while positive/neutral proceed to PI planning. An FAQ interruption preserves pending task state.
- Plans are model-generated, versioned and automatically started after validation. Normal queries execute immediately. Writes and host-defined high-risk reads require confirmation of their exact payload at the tool boundary. Steps express dependencies and known parameters; observations may revise the plan without requiring whole-plan approval.
- Chat UI displays plan versions, task state, actual tool/API events, confirmations and mock receipts. Internal chain-of-thought is not displayed.
- Text only: no OCR, photo classification, voice or physical road repair claims.
- Independent Render service in confirmed workspace `poc`, Singapore; existing service remains on its existing branch.

The original local source had no Git metadata. Its files matched `baogang/dh-poc` branch `value`. Git metadata was restored from that remote without replacing working files, and development uses `codex/road-pothole-pi-poc`.

## 2026-10-19：更正、我的事项与时间线

- 创建确认卡新增“修改信息”和“保存，稍后继续”；修改城市、街道、描述会创建新版本，撤销旧确认。投诉确认可更正原因。所有关键操作在聊天中，独立于“显示任务列表”。
- 新报单内容齐全进入确认时自动保存账号草稿。新对话重新登录同一模拟账号，通过“我的事项”恢复并重新核对；旧会话授权、确认卡和密码不随草稿迁移。多个窗口恢复/修改时按版本校验，已提交或已删除草稿不可再次提交。
- 三个 MOCK 账号各自保存草稿、工单、投诉、人工工单、操作幂等账本、状态时间线和提醒。登录不再重置记录。同账号的浏览器窗口共享事项；“新对话”不等于清空账号。
- 线上复用已有 Neon，并按需建立独立 `road_accounts` JSONB 表；短事务和账户行锁保护版本、业务记录、幂等结果、时间线和提醒的一致性。会话仍由原来的 `road_sessions` 管理。
- HTTP 在异步草稿版本校验及授权状态保存完成后才返回执行已受理，避免客户端读到尚未启动的旧状态；校验期间取消仍撤销原确认。
- 提交前先持久化待核对操作。响应丢失、取消或会话保存故障后，先按原幂等键查询模拟账本，已成功则恢复回执，未提交才允许继续。未知结果未澄清时阻止业务调用；普通聊天或重新规划不能绕过。
- “我的事项”显示实际模拟状态、变化引用和未读提醒，支持已读。只显示有证据的变化，不补写历史流程。“演示：推进一个状态”明确模拟 OPEN → IN_PROGRESS → RESOLVED；`ROAD_DEMO_UI=false` 同时禁用该按钮与后端入口。
- 初始计划仍由 PI 动态生成；恢复完整结构化草稿时，宿主恢复已知的创建/回执步骤，重新进入精确 HITL，不把这一过程作为模型规划得分。恢复后的结果仍可评价，反馈保留恢复请求及工具结果证据。

边界：尚未收齐信息的对话仍保存在原会话，跨会话草稿从确认阶段开始；不支持修改已提交工单、不连接真实部门进度、无短信/邮件/推送。模拟账号不是生产身份认证。旧版本会话第一次访问账号数据时，可导入该会话已有的 MOCK 记录；不会扫描并合并全部历史会话，也不会伪造缺失的历史时间线。连接真实外部接口仍需独立认证、授权、幂等及对账协议。

新增 [15 条场景数据及手工验收步骤](../datasets/road-v4/README.md)，与 road-v3 的 34 条业务回归和 48 条情绪集合一起验收。发布结果见 [本轮回归摘要](evaluation/road-next-validation-20261019.json)。

## Source and acceptance

The reference chat is “Review Road Pothole Service”, `01a13a09-deda-77c1-a984-4bd257118fa5`. Its captured original prompt is retained in the review chat workspace. The source FAQ is `digital-human-faq`; source row counts and migration completeness must be verified separately from the displayed collection count.

Acceptance checks cover new report, historical follow-up, FAQ hit/miss, Arabic and English, missing address, multiple candidates, cancellation, intent changes while awaiting approval, stale/duplicate approval, forged application events, identity isolation, tool failures, commit-response-loss retries, browser refresh, and actual Render model/API connectivity. Evaluation references are never provided to the tested model.

## Implementation flow diagrams

[Road Service implementation flow](road-agent-flow.html) is a self-contained HTML document with two diagrams: chat/FAQ routing and plan review, followed by the PI tool loop, Harness checks, HITL and observation feedback. It includes the five business tools, the separate login API and code references. Open the HTML file in a browser to view it. The diagram records historical implementation commit `14b2b9242a93`; its snapshot ID is intentionally fixed. It predates emotion routing and automatic plan execution. The current enhanced routing and risk policy are described below.

Published view: https://road-pothole-pi-poc.onrender.com/docs/road-agent-flow.html . Both diagrams are on this page, with `#overview` and `#execution` anchors. It uses the existing website login and does not require a mock account or a chat session. The container includes only this allowlisted HTML document; its inline stylesheet is authorized by a page-specific CSP hash.

## Run and use

```sh
npm ci
npm run road:web
```

Open `http://127.0.0.1:8787`. DeepSeek credentials are loaded from the existing `.env`; the model is `deepseek-flash`. Select `demo` (registered address), `demo-no-address`, or `demo-other`; all fictional account passwords are `demo`. Credentials go to the login mock, never to the model. The legacy evaluation dashboard remains available through `npm run web` on another port.

Road conversations require Neon/PostgreSQL. Set `ROAD_SESSION_DATABASE_URL`, or reuse the existing `ROAD_FEEDBACK_DATABASE_URL`. Startup creates the additive `road_sessions` table; account access creates `road_accounts` and imports legacy `ROAD_STATE_DIR` JSON files without deleting them. No database configuration means startup fails; a database outage returns an explicit error. See [session management, measured capacity and horizontal scaling](road-session-management.md) for configuration, lifecycle and rollout steps.

The page supports English, Arabic and Chinese messages. Enter sends the message; Shift+Enter inserts a newline, and IME composition does not send prematurely. A new business request publishes and starts a plan automatically. Normal reads execute directly; every business mutation and configured high-risk read publishes an **exact operation confirmation** before the API runs. Address and report selection use structured input cards. A ticket selection records both matched-report confirmation and unresolved status. Existing status must be nonterminal for unresolved handoff. Use the mock human console to advance WAITING → ACCEPTED → ESCALATED → COMPLETED. Those transitions describe human handling, not physical road repair.

Sending a new business message while waiting invalidates outstanding approval and generates a new automatically started plan. Negative sentiment pauses business and revokes pending submission authorizations before conversation handoff. FAQ questions preserve the pending plan/proposal. Stop interrupts the PI session and revokes authorizations; work already committed by a mock API cannot be undone. Refresh restores the current session and event history without rerunning operations.

### Assistant identity and welcome

The public interface and the business agent use **政务服务助手 / Government Services Assistant**. Opening the page immediately shows a localized welcome in the chat, an overview of supported government service assistance, and the requirement to confirm submissions. The welcome remains available in new conversations and switches with the interface language without making a model request. Broad branding does not expand the capability registry: the current PoC still uses its six mock APIs and nine verified FAQ entries. Unsupported requests explain the current service limit without presenting the assistant as a pothole-only product or claiming unconnected services. Existing conversation and FAQ evidence remain verbatim.

### Interface language

The header offers **中文 / English**. An explicit selection is saved in browser local storage (`road:locale`); without a saved selection, an English browser starts in English and other browsers use the existing Chinese default. New conversations and refreshes retain the interface choice.

The switch covers page labels, accessibility labels, progress, task state, login and information forms, exact confirmation cards, sentiment, receipts, errors and simulated human controls. Locale changes preserve typed values, focus, expanded cards and reading position. New fixed host notices carry semantic keys so their display can switch languages without changing stored evidence. User messages, model-generated plan titles/summaries and replies, FAQ source answers, addresses and ticket content remain in their original language. The assistant still follows the user's conversation language, including Arabic. Language selection never approves a plan or operation, reruns a tool, changes an API payload or resets a conversation.

Localization regression: 146 engineering tests pass, including English/browser preference, remembered selection, switching with address drafts and exact approvals, localized sentiment/human/receipt/progress states, dictionary coverage and placeholder parity. Translation strings are in `web/road/i18n.js`; its HTTP route uses the same website authentication and CSP as the rest of the app.

### Answer satisfaction feedback

Formal FAQ answers, final agent replies (including refusals and blocked outcomes), and terminal agent errors offer **满意 / 不满意** (Satisfied / Not satisfied) directly beneath the answer. Welcome, plans, forms, submission confirmations and simulated human notices do not offer ratings. No tags, comment form or configuration dashboard are required. A rating can be changed, is counted once per answer, and is independent of sentiment, task visibility and HITL. It may be submitted while another turn is running. Failed writes remain visibly unsaved and can be retried.

The backend uses `ROAD_FEEDBACK_DATABASE_URL` for a TLS-verified PostgreSQL connection to Neon. The URL is backend-only, excluded from Git and browser assets. `ROAD_FEEDBACK_ENABLED=false` disables collection. Startup creates two additive tables: `road_answer_feedback` (latest opinion and immutable evidence) and `road_answer_feedback_events` (request IDs and revision history). Parameterized queries, a transaction and a locked answer row provide idempotency and version checks. A retry with the same request ID does not create a second event; an old version cannot overwrite a newer opinion. Database failure never changes a ticket or starts an agent task.

Each newly generated eligible answer captures its original question, triggering message, up to 20 related preceding messages, FAQ/source and prompt hashes, application/model versions, plan and tool-outcome summaries, current emotion and usage evidence. Plan origin IDs preserve the business question across missing information, approval and intervening FAQs. Captures exclude login credentials, CSRF, transport keys and authorization objects; recognized credential text is redacted. Source snapshots and votes are not sent back to the model. Existing answers without a reliable snapshot remain readable but are not retroactively labeled.

`POST /api/feedback` accepts `answer_message_id`, `rating` (`satisfied` or `unsatisfied`), `request_id` and `expected_version`. It uses the existing session cookie/CSRF and verifies answer ownership before persistence. `/api/state` includes only own-session rating summaries; `GET /api/feedback` and `/api/feedback/export?format=jsonl|csv` only return the current session's saved records. There is no public all-session data endpoint.

Under **测试工具与运行记录 → 回答反馈数据**, the browser shows totals and downloads CSV or JSONL for records collected in this browser. IndexedDB retains acknowledged records across refresh and new conversations; backup failure is reported separately from cloud write success. Unrated answers are not negative ratings. Revisions are merged by feedback ID, using the highest version. CSV is UTF-8 with BOM, quoted fields and spreadsheet formula protection; JSONL keeps structured multilingual evidence.

For a complete centrally stored dataset, use the backend-only exporter on a machine configured with the same ignored `.env`:

```sh
npm run road:feedback-export -- --format jsonl --output reports/road/feedback.jsonl
npm run road:feedback-export -- --format csv --output reports/road/feedback.csv
# Optional: --session session-...
```

Exports default to `review_status: unreviewed`. Ratings are satisfaction labels, not verified correct answers; training data requires manual review, privacy checks and, when needed, corrected target answers. Both acknowledged feedback and conversation/mock state are now saved to Neon. Sessions use renewable ownership leases, version checks and bounded working caches; an interrupted agent turn is recovered as paused work and is never silently replayed. Ordinary sessions expire after 30 idle minutes; unfinished conversation-level human handoffs remain protected. The SENTRA emotion evaluation report download pause is separate from these answer feedback exports.

Real database regression (isolated disposable schema, never the production feedback tables):

```sh
node --env-file-if-exists=.env --test tests/road-feedback.postgres.mjs
```

### Chat-only interaction

Plans, task progress, missing-information forms, mock login, exact operation confirmations and receipts are all rendered as ordered cards inside the conversation. Only demo sentiment observation uses a separate right sidebar. The task list can be collapsed or hidden with **显示任务列表**; the assistant's explanation and necessary action buttons remain visible. Each completed task is crossed out, and final response tasks also complete when a fully executed plan finishes with an answer. API/model work displays an immediate progress bubble; connection failures display an actionable message in the same conversation.

The renderer retains typed fields, focus, expanded cards and reading position across event updates. Report selection requires an explicit yes/no answer about whether the problem remains unresolved; an unchecked box is never silently interpreted as resolution. Current sentiment and optional evidence quotes appear only in an independent **DEMO ONLY** observation sidebar, never as chat cards or toolbar badges. Positive is green, neutral gray and negative red, with a text label and matching face icon. Unclassified, pending, analyzing, FAQ-skipped and failed analysis remain distinct from neutral and clear stale evidence. The sidebar follows the interface language and remains visible when **显示任务列表** is unchecked. Below 900px it becomes a compact separate observation area above the chat. Set `ROAD_DEMO_UI=false` on the server to hide the entire observation area for the customer interface; this changes presentation only, not classification, routing or confirmation policy. The task toggle still controls conversation-level simulated human details; essential handoff notices, submission confirmations and Return to assistant remain accessible. Operational traces and a secondary fictional human console also live under a collapsed **测试工具与运行记录** panel below chat. The toggle affects presentation only; it never disables classification or routing.

Historical 2026-10-14 chat revision: passed 118 engineering tests, including 12 chat interaction/backend feedback regressions and six metric-scoring regressions. A separate new 16-case live-model regression run passed all cases (84 requests, estimated cost $0.0372): phase-aware tool selection TP=17, FP=0, FN=0; execution requirements 16/16; unauthorized writes 0. These remain synthetic development cases. Browser verification reproduces the original unlogged simple pothole request, then signs in, fills missing information, hides/shows tasks, confirms the mock submission and checks the completed task list and actual receipt inside chat.

## Knowledge routing

`src/knowledge/road-faq.json` contains 9 complete migrated source records, not 9 independently verified official policies. The original UI displayed 26; 17 entries remain unavailable and were not invented. Immutable source text lives in `road-faq.original.json`. Cleaned canonical questions name the service; short source questions are scoped aliases. Each entry retains original text, capture date, source-entry ID, SHA-256, cleaning version and changes. Policy verification and entry-specific official URLs remain explicitly pending. `npm run road:knowledge-audit` validates structure, original evidence, hashes, duplicates and service identity, and reports policy/source gaps separately. Git review and a tested versioned release publish the POC knowledge; this does not substitute for business-owner policy approval.

The FAQ gate has hit, miss, needs-clarification and unavailable outcomes. A context-free service question displays a service choice in chat. Selecting a service (or typing a recognized service name) resumes the saved original question and attributes answer feedback to that question. `serviceContext` persists in Neon. A new explicitly named service overrides it; host checks reject cross-service FAQ selection. A confirmed service with no answer gets a knowledge-gap answer and official-portal/help exits. Gate outages are distinguishable from a miss and offer retry; they never silently become business execution. Standalone emotion statements containing “this service” are not clarification questions. Existing FAQ interruptions and clarifications preserve pending exact operation proposals.

Knowledge replies retain English source answers, with expandable original collection, service scope, capture date and policy-review status. Official Balady portal links are navigation exits, not fabricated citations. The catalog has one mock-transaction service (road tickets) and three consultation scopes (infrastructure permits, Civil Defense fees, Balady platform); selecting a consultation service never creates an application. Header and welcome controls expose catalog/help independently of task-list visibility.

## Current sentiment and risk policy (2026-10-19)

Order: **FAQ hit → source answer**, **service ambiguity → clarification**, **FAQ outage → visible recovery**, or **true FAQ miss → sentiment → negative help choice / positive or neutral PI loop**. FAQ answers and clarification skip sentiment. The classifier still returns only positive, negative and neutral with current-message evidence. No real human is contacted in this POC.

`src/road/policy.mjs` owns effect and risk metadata. `query_tickets` is a normal read by default; create/close/complain/ticket-handoff are writes. The model receives this registry but cannot override it. Set `ROAD_HIGH_RISK_READS=query_tickets` to make queries require exact confirmation. Unknown or non-read names reject configuration. New plans have `approval_source: host_risk_policy`; a compatibility endpoint still accepts old persisted manual-review plans, but new production plans never wait for whole-plan approval.

The business dispatcher checks current plan, dependencies, known parameters, identity, ticket eligibility and policy before invoking HTTP. Required confirmation is bound to `(plan, step, operation, canonical parameters, epoch)`. Changed intent, cancellation or negative handoff invalidates it. Completed API plans normalize to `completed` even when the model labels its final reply `answered`, and still require every actual receipt. The UI shows a high-risk read as **确认查询**.

Negative sentiment pauses the current business plan and revokes old write authorization, but does not submit a transfer. A help card lets the user choose a simulated human queue or continue the original request with AI. The fixed help button also supports neutral/anonymous users without ticket selection. Only the current session's help-choice token can authorize the conversation-level mock handoff (`user_help_choice`); exact ticket-level escalation still follows its query, matched/unresolved confirmation and exact HITL rules.

The simulated desk progresses `WAITING → ACCEPTED → [ESCALATED] → COMPLETED`. Queued is not accepted; completed is not a repaired road. The handoff carries recent conversation, current service and task summary. Users can cancel waiting or leave an active handoff, and return to AI with old submission approvals invalidated. `ROAD_HUMAN_AVAILABLE=false` disables queue entry while preserving AI/official-portal exits. `ROAD_HUMAN_WAIT_LIMIT_MS` defaults to 180000: elapsed waiting is shown without inventing an estimated connection time, and late simulated acceptance is rejected. Real staffing hours are not configured and the UI says so. User controls remain visible with task details hidden. This is demonstration functionality, not a staffed support channel.

## Enhanced evaluation

The default `road:eval` uses `datasets/road-v3/cases.jsonl`: 34 frozen synthetic cases (23 prior scenarios with explicitly updated human-choice references plus 11 added service/context/help scenarios). V1 and V2 remain unchanged as historical policy datasets. V3 includes choosing/declining human help, Chinese/English/Arabic service ambiguity, original-question resume, typed service choice, multi-turn follow-up, service switching, missing knowledge and catalog inspection. Evaluation UI actions are separate from reference labels; references do not reach the model. Tool metrics separately report PI-only choices and user-confirmed host handoff actions, including precision and recall. They are development regression measurements, not production accuracy.

New `datasets/road-emotion-v1/cases.jsonl` has 48 Chinese/English/Arabic cases, including Saudi dialect, code-switching, sarcasm, negation, quoted emotion, historical versus current emotion and injection. Existing V3 emotion data has 620 inputs: Arabic/mixed 580, English 40; 608 classified references and 12 null/needs-clarification references. The 12 null references receive protocol checks only, never a fabricated three-class accuracy score. Labels remain provisional and synthetic; the existing holdout has been viewed and is a regression split, not unseen validation.

```sh
npm test
npm run road:eval -- --split all
npm run road:emotion-eval -- --source road --split all
npm run road:emotion-eval -- --source legacy --split all
```

See [the enhancement test report](road-enhancement-tests-20261015.md) and its compact machine-readable evidence for exact denominators, class precision/recall, source hashes and first-run failures. Full per-case traces remain under ignored `reports/road/`.

## Harness and six HTTP mocks

The capability registry is the source of allowed task types. PI chooses tasks and tools; the host enforces login identity, step dependencies, plan-bound known parameters, exact write/high-risk-read approval, receipt evidence and turn budgets. No shell, filesystem, web search or coding tools are exposed. Each run has at most one FAQ-gate request, up to two sentiment requests (the second only repairs invalid output evidence), 12 business model requests and 24 business tool attempts, within a 180-second timeout. There is no fixed J-01/J-08 state-machine router.

Mock endpoints are six private HTTP operations, deployed within the PoC service to simulate external systems. The model does not see the private transport key, session credential, passwords, or a writable User ID. The adapter injects User ID from server login and the current turn epoch. An interrupted epoch is rejected before commit. Every mutation has an idempotency key bound to plan, step, operation and canonical parameters; a transient response failure retries once with the same key.

| Endpoint | Input fields (in addition to host-bound User ID) | Result |
|---|---|---|
| `/mock/login` | username, password | User ID, mock profile, registered address |
| `/mock/create_ticket` | address: city/street, description | success, actual ticket ID/status |
| `/mock/query_tickets` | optional ticket ID | owned tickets, decision context, complaints, handoffs |
| `/mock/close_ticket` | ticket ID | success, updated ticket |
| `/mock/complain_ticket` | ticket ID, reason | success, complaint ID/status |
| `/mock/handoff_to_human` | ticket ID, reason, conversation summary | success, handoff ID/WAITING |

Handoff also accepts mock console actions accept/escalate/complete with a handoff ID and checks transitions. `decisionContext` is a synthetic backend rule, explicitly labeled `demoRule`; it does not claim to be official sentiment/SLA/priority policy. API audit events and receipts are observable, not chain-of-thought.

## Evaluation dataset

Historical `datasets/road-v1/cases.jsonl` has 16 synthetic cases: 4 smoke, 9 regression, 3 adversarial. Fields `message`, `login`, `ui`, `interrupt`, and `faults` define the simulated user/environment. `expected` defines independent evaluator assertions and **never enters the tested agent context**. Add a new JSONL row for each real observed failure and a distinct paraphrase/control case; retain failed traces before fixing prompts. Have business and language reviewers review the labels. For later model comparisons, freeze reviewed cases and reserve a separate unseen holdout; this initial collection is a development regression set.

```sh
npm run road:test
npm run road:eval -- --split smoke
npm run road:eval -- --split all
npm run road:eval -- --case J08-HANDOFF --repeat 3
node scripts/road-rescore.mjs original-report.json rescored-report.json
```

The runner exercises the actual DeepSeek + PI SDK and the HTTP mocks. Each case has a separate session/fixture. It confirms only the exact operations requiring HITL; injected fake UI markers still require actual structured events. JSON reports retain checks, plan, API/tool traces, receipts, latency, requests and estimated provider cost under ignored `reports/road/`.

Metrics: case pass rate requires every applicable check; planning coverage checks required capabilities on the final plan without demanding identical step wording. Tool selection P/R/F1 use one `(case, dialogue phase, business tool type)` as the unit; TP is a required type selected in its phase, FP is an unexpected type, FN is a required type never selected. Repeated proposals, confirmations and retries are deduplicated for these type scores; raw attempt precision is also retained. Successful-execution recall separately requires an actual receipt for each final required business tool type. FAQ-only cases have null tool recall rather than an artificial 100%. HITL checks compare exact parameters and chronological API invocation; parameter/identity checks remain separate. This tool-type metric does not independently count multiple resources operated on by the same tool.

`SWITCH-DURING-HITL` has two independent references: create_ticket is a legitimate proposal before the user's change of intent; only query_tickets is expected afterward, with creation forbidden from executing. The 2026-10-14 original 96.3% attempt score compared all attempts to the final intent, incorrectly counting the earlier legitimate proposal as a mistake. That figure is deprecated; it was not a model tool-choice error. The unchanged recorded trace was rescored after explicitly correcting the phase references, without another model call. Full original reports remain preserved.

Recorded validation on 2026-10-14: the original 100 engineering tests comprised 87 inherited regression tests and 13 new road tests, all passed. The 16-case evaluation-mode run passed every case: 15 cases actually called DeepSeek; the exact-FAQ case deliberately bypassed the model. The captured run used 74 model requests, estimated cost $0.0290. On the phase-aware rescore, tool-type TP=17, FP=0, FN=0 (P/R/F1 100%); all 27 business tool attempts match their phase references. Successful-execution coverage is 16/16 final tool requirements (100% recall), unauthorized writes 0. This round adds six scoring regression tests for FN/FP, repeated HITL calls, intent switching, empty/missing cases, receipt requirements and aggregation. These results are small synthetic developer regression checks, not production accuracy or unseen holdout performance.

## Independent Render service

Source: `baogang/dh-poc`, branch `codex/road-pothole-pi-poc`, Dockerfile `Dockerfile.road`.

Service: `road-pothole-pi-poc`, ID `srv-db7p0lbbc2fs73fvlkhg`, workspace `poc`, Singapore / Free. URL: https://road-pothole-pi-poc.onrender.com . Website access uses Basic Auth; the locally delivered access file contains the website username/password, distinct from mock login. Model Key is a server environment variable, excluded from source and images.

The container stores sessions in `/tmp/road-poc-state`. The Free test service may sleep; deployment/restart may discard sessions and mock records. Files on a persistent local directory survive process restart, with active turns marked interrupted and approvals revoked. Durable production storage, a real authentication service, and actual external ticket/human systems are future integration work.

## 2026-10-19 product-review release verification

The 1–4 feature release passes 175 Node tests, 26 Python mock tests, 20 real-Neon checks (including service/clarification/help recovery), 60 offline engineering cases, 34 real-model business/service cases and 48 real-model sentiment cases. The final 34-case sample has tool-type precision/recall both 100% and zero unauthorized writes; PI-only choices are reported separately. Earlier runs exposed a statement-versus-question routing bug and an attempted handoff based on pasted confirmation; the host blocked the latter, both were corrected and the full suite was rerun. This is synthetic developer regression, not production accuracy.

Browser verification covers the original “Who can apply for this service?” interaction, choosing a service without repeating the question, source evidence, a task-hidden human queue/cancel flow, Chinese/English and a 390px mobile viewport with no horizontal overflow. A 31-check real-HTTP local smoke verifies scoped knowledge, CSRF/stale tokens, handoff context, exact HITL preservation and one mock submission. Run `node scripts/road-release-smoke.mjs --access-file /absolute/path/to/protected-access-file --output /absolute/path/to/live-report.json` after publishing; credentials and session tokens never enter its report. The production run additionally checks Neon, website auth, answer feedback and the negative-user-choice flow.

Release evidence: [feature validation](evaluation/road-p0-validation-20261019.json), [knowledge quality audit](evaluation/road-knowledge-audit-20261019.json), and the frozen [34-case dataset](../datasets/road-v3/cases.jsonl). The audit deliberately reports zero officially policy-verified entries and 17 missing source records.
