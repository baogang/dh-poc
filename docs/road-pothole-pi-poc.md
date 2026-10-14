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

## Run and use

```sh
npm ci
npm run road:web
```

Open `http://127.0.0.1:8787`. DeepSeek credentials are loaded from the existing `.env`; the model is `deepseek-flash`. Select `demo` (registered address), `demo-no-address`, or `demo-other`; all fictional account passwords are `demo`. Credentials go to the login mock, never to the model. The legacy evaluation dashboard remains available through `npm run web` on another port.

The page supports English, Arabic and Chinese messages. A new business request publishes a plan. **Approve plan** permits its listed tasks; every mutation then publishes an **exact operation confirmation**. Address and report selection use structured input cards. A ticket selection records both matched-report confirmation and unresolved status. Existing status must be nonterminal for unresolved handoff. Use the mock human console to advance WAITING → ACCEPTED → ESCALATED → COMPLETED. Those transitions describe human handling, not physical road repair.

Sending a business message while waiting invalidates outstanding approval and generates a new reviewed plan. FAQ questions preserve the pending plan/proposal. Stop interrupts the PI session and revokes authorizations; work already committed by a mock API cannot be undone. Refresh restores the current session and event history without rerunning operations.

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
```

The runner exercises the actual DeepSeek + PI SDK and the HTTP mocks. Each case has a separate session/fixture. It simulates reviewed plan approval and exact confirmation; injected fake UI markers still require actual structured events. JSON reports retain checks, plan, API/tool traces, receipts, latency, requests and estimated provider cost under ignored `reports/road/`.

Metrics: case pass rate requires every applicable check; planning coverage checks required capabilities on the final plan without demanding identical step wording; tool selection precision includes all business tool attempts (including blocked incorrect attempts); HITL checks compare exact parameters and the chronological API invocation. Receipt checks verify selected ticket/address/identity and final result state. A safe blocked case can pass its expected refusal assertions; this is not counted as successful execution of an unavailable operation.

Recorded local validation on 2026-10-14: 99 engineering tests passed, including 12 new road tests. The 16-case real model run passed every case, required-capability coverage 100%, tool selection precision **96.3% (26/27 attempts)**, unauthorized writes 0. One extra attempt was blocked by a guard. These are small, synthetic regression results, not a production accuracy claim. Estimated model cost for that run was $0.0301.

## Independent Render service

Source: `baogang/dh-poc`, branch `codex/road-pothole-pi-poc`, Dockerfile `Dockerfile.road`.

Service: `road-pothole-pi-poc`, ID `srv-db7p0lbbc2fs73fvlkhg`, workspace `poc`, Singapore / Free. URL: https://road-pothole-pi-poc.onrender.com . Website access uses Basic Auth; the locally delivered access file contains the website username/password, distinct from mock login. Model Key is a server environment variable, excluded from source and images.

The container stores sessions in `/tmp/road-poc-state`. The Free test service may sleep; deployment/restart may discard sessions and mock records. Files on a persistent local directory survive process restart, with active turns marked interrupted and approvals revoked. Durable production storage, a real authentication service, and actual external ticket/human systems are future integration work.
