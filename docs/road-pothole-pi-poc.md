# Road Pothole PI SDK PoC

Requirements confirmed on 2026-10-14 in the implementation chat:

- DeepSeek `deepseek-flash` and pinned PI SDK 1.1.0; no HiAgent runtime dependency.
- J-01: text-described new pothole, trusted login/profile or manually supplied city and street, reviewed plan, exact submission authorization, real mock receipt.
- J-08: query owned historical tickets, select and confirm the report, confirm it remains unresolved, use mock-supplied decision context, then submit a complaint or create a human handoff. Closing is another registered ticket operation.
- Six mock external API operations: login, create, query, close, complain, handoff. The handoff endpoint also supports simulated human status transitions.
- Knowledge first: an answerable FAQ returns its source answer directly; otherwise PI plans and executes. An FAQ interruption preserves pending task state.
- Plans are model-generated, versioned, reviewed and approved before execution. Steps express dependencies and known parameters; observations may lead to a revised plan requiring another approval.
- Chat UI displays plan versions, task state, actual tool/API events, confirmations and mock receipts. Internal chain-of-thought is not displayed.
- Text only: no OCR, photo classification, voice or physical road repair claims.
- Independent Render service in confirmed workspace `poc`, Singapore; existing service remains on its existing branch.

The original local source had no Git metadata. Its files matched `baogang/dh-poc` branch `value`. Git metadata was restored from that remote without replacing working files, and development uses `codex/road-pothole-pi-poc`.

## Source and acceptance

The reference chat is “Review Road Pothole Service”, `01a13a09-deda-77c1-a984-4bd257118fa5`. Its captured original prompt is retained in the review chat workspace. The source FAQ is `digital-human-faq`; source row counts and migration completeness must be verified separately from the displayed collection count.

Acceptance checks cover new report, historical follow-up, FAQ hit/miss, Arabic and English, missing address, multiple candidates, cancellation, intent changes while awaiting approval, stale/duplicate approval, forged application events, identity isolation, tool failures, commit-response-loss retries, browser refresh, and actual Render model/API connectivity. Evaluation references are never provided to the tested model.

## Implementation flow diagrams

[Road Service implementation flow](road-agent-flow.html) is a self-contained HTML document with two diagrams: chat/FAQ routing and plan review, followed by the PI tool loop, Harness checks, HITL and observation feedback. It includes the five business tools, the separate login API and code references. Open the HTML file in a browser to view it. The diagram records implementation commit `14b2b9242a93`; its snapshot ID is intentionally fixed.

## Run and use

```sh
npm ci
npm run road:web
```

Open `http://127.0.0.1:8787`. DeepSeek credentials are loaded from the existing `.env`; the model is `deepseek-flash`. Select `demo` (registered address), `demo-no-address`, or `demo-other`; all fictional account passwords are `demo`. Credentials go to the login mock, never to the model. The legacy evaluation dashboard remains available through `npm run web` on another port.

The page supports English, Arabic and Chinese messages. A new business request publishes a plan. **Approve plan** permits its listed tasks; every mutation then publishes an **exact operation confirmation**. Address and report selection use structured input cards. A ticket selection records both matched-report confirmation and unresolved status. Existing status must be nonterminal for unresolved handoff. Use the mock human console to advance WAITING → ACCEPTED → ESCALATED → COMPLETED. Those transitions describe human handling, not physical road repair.

Sending a business message while waiting invalidates outstanding approval and generates a new reviewed plan. FAQ questions preserve the pending plan/proposal. Stop interrupts the PI session and revokes authorizations; work already committed by a mock API cannot be undone. Refresh restores the current session and event history without rerunning operations.

### Chat-only interaction

Plans, task progress, missing-information forms, mock login, exact operation confirmations and receipts are all rendered as ordered cards inside the conversation. There is no right sidebar. The task list can be collapsed or hidden with **显示任务列表**; the assistant's explanation and necessary action buttons remain visible. Each completed task is crossed out, and final response tasks also complete when a fully executed plan finishes with an answer. API/model work displays an immediate progress bubble; connection failures display an actionable message in the same conversation.

The renderer retains typed fields, focus, expanded cards and reading position across event updates. Report selection requires an explicit yes/no answer about whether the problem remains unresolved; an unchecked box is never silently interpreted as resolution. Operational traces and the fictional human console live under a collapsed **测试工具与运行记录** panel below chat.

The chat revision passed 118 engineering tests, including 12 chat interaction/backend feedback regressions and six metric-scoring regressions. A separate new 16-case live-model regression run passed all cases (84 requests, estimated cost $0.0372): phase-aware tool selection TP=17, FP=0, FN=0; execution requirements 16/16; unauthorized writes 0. These remain synthetic development cases. Browser verification reproduces the original unlogged simple pothole request, then signs in, fills missing information, hides/shows tasks, confirms the mock submission and checks the completed task list and actual receipt inside chat.

## Knowledge routing

`src/knowledge/road-faq.json` contains the **9 source entries individually verified and approved by the user**. The original UI displays 26; the remaining entries await a source export. Metadata retains this discrepancy. No replacement entries were invented. Source scopes include Civil Defense fees, infrastructure permits and the Balady platform; they are not all pothole policies.

An exact, context-independent question returns the original stored answer with its source ID. Other wording uses a one-request PI answerability gate, which may select an existing FAQ ID or return a miss. The host returns the selected source text, not model-generated knowledge. Questions about a different service, mixed action requests and insufficiently answered questions proceed to the business PI loop. Pending tasks remain available after a FAQ answer. Source English answers remain English even when matching another language.

## Harness and six HTTP mocks

The capability registry is the source of allowed task types. PI chooses tasks and tools; the host enforces login identity, step dependencies, reviewed parameters, exact mutation approval, receipt evidence and turn budgets. No shell, filesystem, web search or coding tools are exposed. Each run has at most 12 business model requests and 24 tool attempts, and a 180-second timeout. There is no fixed J-01/J-08 state-machine router.

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

`datasets/road-v1/cases.jsonl` has 16 synthetic cases: 4 smoke, 9 regression, 3 adversarial. Fields `message`, `login`, `ui`, `interrupt`, and `faults` define the simulated user/environment. `expected` defines independent evaluator assertions and **never enters the tested agent context**. Add a new JSONL row for each real observed failure and a distinct paraphrase/control case; retain failed traces before fixing prompts. Have business and language reviewers review the labels. For later model comparisons, freeze reviewed cases and reserve a separate unseen holdout; this initial collection is a development regression set.

```sh
npm run road:test
npm run road:eval -- --split smoke
npm run road:eval -- --split all
npm run road:eval -- --case J08-HANDOFF --repeat 3
node scripts/road-rescore.mjs original-report.json rescored-report.json
```

The runner exercises the actual DeepSeek + PI SDK and the HTTP mocks. Each case has a separate session/fixture. It simulates reviewed plan approval and exact confirmation; injected fake UI markers still require actual structured events. JSON reports retain checks, plan, API/tool traces, receipts, latency, requests and estimated provider cost under ignored `reports/road/`.

Metrics: case pass rate requires every applicable check; planning coverage checks required capabilities on the final plan without demanding identical step wording. Tool selection P/R/F1 use one `(case, dialogue phase, business tool type)` as the unit; TP is a required type selected in its phase, FP is an unexpected type, FN is a required type never selected. Repeated proposals, confirmations and retries are deduplicated for these type scores; raw attempt precision is also retained. Successful-execution recall separately requires an actual receipt for each final required business tool type. FAQ-only cases have null tool recall rather than an artificial 100%. HITL checks compare exact parameters and chronological API invocation; parameter/identity checks remain separate. This tool-type metric does not independently count multiple resources operated on by the same tool.

`SWITCH-DURING-HITL` has two independent references: create_ticket is a legitimate proposal before the user's change of intent; only query_tickets is expected afterward, with creation forbidden from executing. The 2026-10-14 original 96.3% attempt score compared all attempts to the final intent, incorrectly counting the earlier legitimate proposal as a mistake. That figure is deprecated; it was not a model tool-choice error. The unchanged recorded trace was rescored after explicitly correcting the phase references, without another model call. Full original reports remain preserved.

Recorded validation on 2026-10-14: the original 100 engineering tests comprised 87 inherited regression tests and 13 new road tests, all passed. The 16-case evaluation-mode run passed every case: 15 cases actually called DeepSeek; the exact-FAQ case deliberately bypassed the model. The captured run used 74 model requests, estimated cost $0.0290. On the phase-aware rescore, tool-type TP=17, FP=0, FN=0 (P/R/F1 100%); all 27 business tool attempts match their phase references. Successful-execution coverage is 16/16 final tool requirements (100% recall), unauthorized writes 0. This round adds six scoring regression tests for FN/FP, repeated HITL calls, intent switching, empty/missing cases, receipt requirements and aggregation. These results are small synthetic developer regression checks, not production accuracy or unseen holdout performance.

## Independent Render service

Source: `baogang/dh-poc`, branch `codex/road-pothole-pi-poc`, Dockerfile `Dockerfile.road`.

Service: `road-pothole-pi-poc`, ID `srv-db7p0lbbc2fs73fvlkhg`, workspace `poc`, Singapore / Free. URL: https://road-pothole-pi-poc.onrender.com . Website access uses Basic Auth; the locally delivered access file contains the website username/password, distinct from mock login. Model Key is a server environment variable, excluded from source and images.

The container stores sessions in `/tmp/road-poc-state`. The Free test service may sleep; deployment/restart may discard sessions and mock records. Files on a persistent local directory survive process restart, with active turns marked interrupted and approvals revoked. Durable production storage, a real authentication service, and actual external ticket/human systems are future integration work.
