#!/usr/bin/env python3
"""V1.2 narrowly revises three planning contracts; semantic gold is immutable."""
from __future__ import annotations
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def write(path, records):
    path.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in records), encoding="utf-8")


def publish_revision():
    source, target = ROOT / "datasets/v1.1", ROOT / "datasets/v1.2"
    historical = {str(p.relative_to(ROOT)): digest(p) for name in ["v1", "v1.1"] for p in (ROOT / "datasets" / name).rglob("*") if p.is_file()}
    old_freeze = json.loads((source / "freeze.json").read_text())
    for path, expected in old_freeze["files"].items():
        real = ROOT / ("scripts/generate_datasets_v1_1.py" if path == "scripts/generate_datasets.py" else path)
        assert digest(real) == expected, f"Historical v1.1 release hash mismatch: {path}"
    for kind in ["semantic", "planning", "engineering"]:
        (target / kind).mkdir(parents=True, exist_ok=True)
        for name in ["inputs", "references", "manifest"]:
            shutil.copyfile(source / kind / f"{name}.jsonl", target / kind / f"{name}.jsonl")
    references = load(target / "planning/references.jsonl")
    changes = []
    for row in references:
        cid, ref = row["case_id"], row["reference"]
        if cid == "PLAN-17-2":
            ref["allowed_tools"].append("crm940_complaint_create")
            ref["forbidden_tools"].remove("crm940_complaint_create")
            changes.append({"case_id": cid, "reason": "As with PLAN-11-2, the write Tool prepares a host proposal before confirmation. Its invocation is legal; the retained complaints-length oracle must show no committed write after refusal."})
        elif cid == "PLAN-12-3":
            ref["required_tools"] = []
            ref["required_tool_groups"] = [["crm940_complaint_get", "crm940_complaint_reopen"]]
            changes.append({"case_id": cid, "reason": "The mock permits reopening only closed complaints. A lookup proving CMP-MOCK-002 is already open is sufficient to report failed/handoff; do not force an unnecessary invalid write. Require at least one operation that observes or rejects this subject, keep open-state oracle and forbidden reopened claim."})
        elif cid == "PLAN-08-4":
            ref["acceptable_paths"] = [
                {"allowed_statuses": ["needs_input"], "required_tools": [], "allowed_tools": [], "required_clarification_fields": ["goal"]},
                {"allowed_statuses": ["completed"], "required_tools": ["sakani_request_get"], "allowed_tools": ["sakani_request_get"], "required_clarification_fields": []},
            ]
            changes.append({"case_id": cid, "reason": "The literal message declares a SAKANI request ID and excludes the land tool but does not ask for a specific action. Asking the goal is legitimate, while a contextual status lookup remains the original canonical path. Both retain the prohibition on housing-support approval claims."})
    write(target / "planning/references.jsonl", references)
    metadata = load(target / "planning/manifest.jsonl")
    revised_ids = {c["case_id"] for c in changes}
    for row in metadata:
        if row["case_id"] in revised_ids:
            row["contract_revision"] = "poc-dataset-v1.2.0"
    write(target / "planning/manifest.jsonl", metadata)
    archive = {
        "original_path": "scripts/generate_datasets.py",
        "archived_path": "scripts/generate_datasets_v1_1.py",
        "sha256": digest(ROOT / "scripts/generate_datasets_v1_1.py"),
    }
    changelog = {
        "dataset_version": "poc-dataset-v1.2.0", "baseline_dataset_version": "poc-dataset-v1.1.0",
        "baseline_release_digest": old_freeze["release_digest"], "semantic_gold_changed": False,
        "changes": changes, "baseline_generator_archive": archive,
        "independent_contract_inspection": [
            "src/entry-agent.mjs executeBusiness prepares proposal before backend mutation",
            "poc_mocks/server.py crm940_complaint_reopen rejects any complaint not closed",
            "Literal PLAN-08-4 input has no explicit requested action; original ID-only ambiguity was not model-specific",
        ],
        "audit_only_no_reference_change": [
            {"case_id": "PLAN-12-3", "issue": "Second turn has confirm=true even when an already-open lookup ends in failed with no proposal. A runner must conditionally apply this confirmation action to a pending exact proposal; never manufacture authorization or score file existence as task success."},
            {"case_id": "PLAN-11-3", "issue": "Missing complaint subject/location remains a genuine clarification task; no relaxation of required category/description."},
            {"case_id": "PLAN-20-3", "issue": "Two explicit independent goals still require both SAKANI requirements and BALADY application calls; missing one remains a real failure."},
        ],
    }
    (target / "changelog.json").write_text(json.dumps(changelog, ensure_ascii=False, indent=2) + "\n")
    after = {str(p.relative_to(ROOT)): digest(p) for name in ["v1", "v1.1"] for p in (ROOT / "datasets" / name).rglob("*") if p.is_file()}
    assert after == historical, "Historical datasets changed"
    for kind in ["semantic", "engineering"]:
        for name in ["inputs", "references", "manifest"]:
            assert (source / kind / f"{name}.jsonl").read_bytes() == (target / kind / f"{name}.jsonl").read_bytes()
    assert (source / "planning/inputs.jsonl").read_bytes() == (target / "planning/inputs.jsonl").read_bytes()
    print(json.dumps({"published": "datasets/v1.2", "changed_cases": sorted(revised_ids), "historical_releases_unchanged": True, "semantic_gold_changed": False}))


if __name__ == "__main__":
    publish_revision()
