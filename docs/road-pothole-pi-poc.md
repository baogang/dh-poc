# Road Pothole PI SDK PoC

Requirements confirmed on 2026-10-14 in the implementation chat:

- DeepSeek `deepseek-flash` and pinned PI SDK 1.1.0; no HiAgent runtime dependency.
- J-01: text-described new pothole, trusted login/profile or manually supplied city and street, reviewed plan, exact submission authorization, real mock receipt.
- J-08: query owned historical tickets, select and confirm the report, confirm it remains unresolved, use mock-supplied decision context, then submit a complaint or create a human handoff. Closing is another registered ticket operation.
- Six mock external API operations: login, create, query, close, complain, handoff. The handoff endpoint also supports simulated human status transitions.
- Knowledge first: an answerable FAQ returns its source answer directly; otherwise PI plans and executes. An FAQ interruption preserves pending task state.
- Plans are model-generated, versioned, reviewed and approved before execution. Approved plans may use conditional steps; expansion of scope requires a revised approval.
- Chat UI displays plan versions, task state, actual tool/API events, confirmations and mock receipts. Internal chain-of-thought is not displayed.
- Text only: no OCR, photo classification, voice or physical road repair claims.
- Independent Render service in confirmed workspace `poc`, Singapore; existing service remains on its existing branch.

The original local source had no Git metadata. Its files matched `baogang/dh-poc` branch `value`. Git metadata was restored from that remote without replacing working files, and development uses `codex/road-pothole-pi-poc`.

## Source and acceptance

The reference chat is “Review Road Pothole Service”, `01a13a09-deda-77c1-a984-4bd257118fa5`. Its captured original prompt is retained in the review chat workspace. The source FAQ is `digital-human-faq`; source row counts and migration completeness must be verified separately from the displayed collection count.

Acceptance checks cover new report, historical follow-up, FAQ hit/miss, Arabic and English, missing address, multiple candidates, cancellation, intent changes while awaiting approval, stale/duplicate approval, forged application events, identity isolation, tool failures, commit-response-loss retries, browser refresh, and actual Render model/API connectivity. Evaluation references are never provided to the tested model.
