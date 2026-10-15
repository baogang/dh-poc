# Road Pothole PI SDK PoC

Requirements confirmed on 2026-10-14, updated by the 2026-10-15 enhancement request:

- DeepSeek `deepseek-flash` and pinned PI SDK 1.1.0; no HiAgent runtime dependency.
- J-01: text-described new pothole, trusted login/profile or manually supplied city and street, automatically started plan, exact submission authorization, real mock receipt.
- J-08: query owned historical tickets, select and confirm the report, confirm it remains unresolved, use mock-supplied decision context, then submit a complaint or create a human handoff. Closing is another registered ticket operation.
- Six mock external API operations: login, create, query, close, complain, handoff. The handoff endpoint also supports simulated human status transitions.
- Knowledge first: an answerable FAQ returns its source answer directly; otherwise three-class sentiment runs; negative queues a conversation-level human handoff, while positive/neutral proceed to PI planning. An FAQ interruption preserves pending task state.
- Plans are model-generated, versioned and automatically started after validation. Normal queries execute immediately. Writes and host-defined high-risk reads require confirmation of their exact payload at the tool boundary. Steps express dependencies and known parameters; observations may revise the plan without requiring whole-plan approval.
- Chat UI displays plan versions, task state, actual tool/API events, confirmations and mock receipts. Internal chain-of-thought is not displayed.
- Text only: no OCR, photo classification, voice or physical road repair claims.
- Independent Render service in confirmed workspace `poc`, Singapore; existing service remains on its existing branch.

The original local source had no Git metadata. Its files matched `baogang/dh-poc` branch `value`. Git metadata was restored from that remote without replacing working files, and development uses `codex/road-pothole-pi-poc`.

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

The page supports English, Arabic and Chinese messages. Enter sends the message; Shift+Enter inserts a newline, and IME composition does not send prematurely. A new business request publishes and starts a plan automatically. Normal reads execute directly; every business mutation and configured high-risk read publishes an **exact operation confirmation** before the API runs. Address and report selection use structured input cards. A ticket selection records both matched-report confirmation and unresolved status. Existing status must be nonterminal for unresolved handoff. Use the mock human console to advance WAITING → ACCEPTED → ESCALATED → COMPLETED. Those transitions describe human handling, not physical road repair.

Sending a new business message while waiting invalidates outstanding approval and generates a new automatically started plan. Negative sentiment pauses business and revokes pending submission authorizations before conversation handoff. FAQ questions preserve the pending plan/proposal. Stop interrupts the PI session and revokes authorizations; work already committed by a mock API cannot be undone. Refresh restores the current session and event history without rerunning operations.

### Assistant identity and welcome

The public interface and the business agent use **政务服务助手 / Government Services Assistant**. Opening the page immediately shows a localized welcome in the chat, an overview of supported government service assistance, and the requirement to confirm submissions. The welcome remains available in new conversations and switches with the interface language without making a model request. Broad branding does not expand the capability registry: the current PoC still uses its six mock APIs and nine verified FAQ entries. Unsupported requests explain the current service limit without presenting the assistant as a pothole-only product or claiming unconnected services. Existing conversation and FAQ evidence remain verbatim.

### Interface language

The header offers **中文 / English**. An explicit selection is saved in browser local storage (`road:locale`); without a saved selection, an English browser starts in English and other browsers use the existing Chinese default. New conversations and refreshes retain the interface choice.

The switch covers page labels, accessibility labels, progress, task state, login and information forms, exact confirmation cards, sentiment, receipts, errors and simulated human controls. Locale changes preserve typed values, focus, expanded cards and reading position. New fixed host notices carry semantic keys so their display can switch languages without changing stored evidence. User messages, model-generated plan titles/summaries and replies, FAQ source answers, addresses and ticket content remain in their original language. The assistant still follows the user's conversation language, including Arabic. Language selection never approves a plan or operation, reruns a tool, changes an API payload or resets a conversation.

Localization regression: 146 engineering tests pass, including English/browser preference, remembered selection, switching with address drafts and exact approvals, localized sentiment/human/receipt/progress states, dictionary coverage and placeholder parity. Translation strings are in `web/road/i18n.js`; its HTTP route uses the same website authentication and CSP as the rest of the app.

### Chat-only interaction

Plans, task progress, missing-information forms, mock login, exact operation confirmations and receipts are all rendered as ordered cards inside the conversation. There is no right sidebar. The task list can be collapsed or hidden with **显示任务列表**; the assistant's explanation and necessary action buttons remain visible. Each completed task is crossed out, and final response tasks also complete when a fully executed plan finishes with an answer. API/model work displays an immediate progress bubble; connection failures display an actionable message in the same conversation.

The renderer retains typed fields, focus, expanded cards and reading position across event updates. Report selection requires an explicit yes/no answer about whether the problem remains unresolved; an unchecked box is never silently interpreted as resolution. Current sentiment, exact evidence quotes and conversation-level simulated human progress are displayed in chat when **显示任务列表** is checked. Unchecking hides these details and simulation controls, but essential handoff notices, submission confirmations and Return to assistant remain accessible. Operational traces and a secondary fictional human console also live under a collapsed **测试工具与运行记录** panel below chat. The toggle affects presentation only; it never disables classification or routing.

Historical 2026-10-14 chat revision: passed 118 engineering tests, including 12 chat interaction/backend feedback regressions and six metric-scoring regressions. A separate new 16-case live-model regression run passed all cases (84 requests, estimated cost $0.0372): phase-aware tool selection TP=17, FP=0, FN=0; execution requirements 16/16; unauthorized writes 0. These remain synthetic development cases. Browser verification reproduces the original unlogged simple pothole request, then signs in, fills missing information, hides/shows tasks, confirms the mock submission and checks the completed task list and actual receipt inside chat.

## Knowledge routing

`src/knowledge/road-faq.json` contains the **9 source entries individually verified and approved by the user**. The original UI displays 26; the remaining entries await a source export. Metadata retains this discrepancy. No replacement entries were invented. Source scopes include Civil Defense fees, infrastructure permits and the Balady platform; they are not all pothole policies.

An exact, context-independent question returns the original stored answer with its source ID. Other wording uses a one-request PI answerability gate, which may select an existing FAQ ID or return a miss. The host returns the selected source text, not model-generated knowledge. Questions about a different service, mixed action requests and insufficiently answered questions proceed to the business PI loop. Pending tasks remain available after a FAQ answer. Source English answers remain English even when matching another language.

## Current sentiment and risk policy (2026-10-15)

Order: **FAQ → source answer and stop**, or **FAQ miss → sentiment → negative human handoff / positive or neutral PI loop**. The user explicitly chose to skip sentiment on FAQ hits, even when the question contains negative words. The classifier returns only `positive`, `negative`, `neutral`. `pending_faq`, `analyzing`, `skipped` and `error` are technical statuses, not extra sentiment classes. Evidence must be a verbatim span of the current user message. Missing fields, delays, failed repair facts and danger descriptions alone do not prove an emotional attitude. Free-text clarification replies are also classified before continuing their existing FAQ-miss plan. Classification failure blocks business rather than silently assuming neutral.

`src/road/policy.mjs` owns effect and risk metadata. `query_tickets` is a normal read by default; create/close/complain/ticket-handoff are writes. The model receives this registry but cannot override it. Set `ROAD_HIGH_RISK_READS=query_tickets` to make queries require exact confirmation. Unknown or non-read names reject configuration. New plans have `approval_source: host_risk_policy`; a compatibility endpoint still accepts old persisted manual-review plans, but new production plans never wait for whole-plan approval.

The business dispatcher checks current plan, dependencies, known parameters, identity, ticket eligibility and policy before invoking HTTP. Required confirmation is bound to `(plan, step, operation, canonical parameters, epoch)`. Changed intent, cancellation or negative handoff invalidates it. Completed API plans normalize to `completed` even when the model labels its final reply `answered`, and still require every actual receipt. The UI shows a high-risk read as **确认查询**.

Negative handoff is a separately authorized **host routing policy**, not a model-generated ticket mutation and not a bypassable UI checkbox. It calls the same sixth mock endpoint with `scope: conversation`, current emotion evidence and a summary; anonymous users need no ticket or login. Its idempotency key is bound to the conversation and current message. The private mock checks the host authorization, current negative emotion and turn epoch. Failed handoff never starts business or claims success.

The chat simulator progresses `WAITING → ACCEPTED → [optional ESCALATED] → COMPLETED`. WAITING means queued, not accepted. After acceptance, additional chat receives a clearly marked simulated-human acknowledgment while business remains paused, even if sentiment later becomes neutral/positive. Completion is human handling only. **返回智能助手** explicitly returns to AI after completion; it does not restore old write authorizations. No external person is contacted, and the simulator never repairs or closes tickets automatically.

## Enhanced evaluation

The default `road:eval` now uses `datasets/road-v2/cases.jsonl`: 23 frozen synthetic cases. V1 remains unchanged. The one changed policy reference is the angry status-only request, which must now route to a conversation-level human while still forbidding automatic complaint/closure. Added cases cover automatic query, positive query, anonymous Chinese/Arabic negative sentiment, FAQ-hit sentiment skip, negative interruption during HITL and out-of-scope requests. Tool metrics explicitly distinguish LLM tool choices from host-policy handoff choices.

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
