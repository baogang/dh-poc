# Natural BALADY journeys

This is an independently authored user-goal suite. The 40 cases were frozen on 2026-10-20 before the repaired candidate was finalized, while repairs were in progress. It contains 12 development cases and 28 cases withheld from the production-fixing agent for the first holdout run.

- `inputs.jsonl` contains only a persona, natural messages, UI choices and a fixture identifier. Beneficiary messages do not prescribe API names, parameter keys or execution sequences.
- `fixtures.jsonl` contains synthetic backend records. These are deliberately different, include multiple plausible targets and include another account's record. Fixture data is not an official BALADY directory or official location/classification mapping.
- `references.jsonl` contains outcome, authorization, data integrity and evidence criteria. References never enter the model context. Required operations only describe the minimum evidence needed for genuinely supported queries; alternate valid prerequisite calls are permitted. No exact prose or total-order plan is required.
- `manifest.json` records the input/reference/fixture hashes, authorship and blindness limitation.

`refuse` means reject an unavailable or unauthorized action while still helping with the resident's legitimate goal. It does not require a terse refusal. `clarify` can be satisfied by a clear explanation of a connected capability limitation when required system metadata cannot be discovered; do not ask residents to invent internal identifiers. Safe unsupported answers are not successful business submissions.

The first holdout run must be reported as such, including its failures. A subsequent fix informed by a failed case makes that case a regression case; do not keep calling the rerun blind. No claim of production accuracy follows from this small synthetic sample.

The older 50 tool and 20 planning cases under `datasets/balady-crm/` are preserved. They remain useful API contract/script regressions and are not a natural-user benchmark. Those messages often name tools, keys and steps, and the older evaluator bypasses FAQ/emotion routing. Report their scores separately.

All dataset identities, contact details, places and records are synthetic. `.test` addresses are intentional. No real government requests are performed by this suite.
