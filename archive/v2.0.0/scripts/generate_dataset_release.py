#!/usr/bin/env python3
"""Publish a strictly enumerated contract revision without changing semantic gold."""
from __future__ import annotations
import argparse
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def write(path, records):
    path.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in records), encoding="utf-8")


def publish_revision():
    source = ROOT / "datasets/v1"
    target = ROOT / "datasets/v1.1"
    baseline = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob("*") if p.is_file()}
    for kind in ["semantic", "planning", "engineering"]:
        (target / kind).mkdir(parents=True, exist_ok=True)
        for name in ["inputs", "references", "manifest"]:
            shutil.copyfile(source / kind / f"{name}.jsonl", target / kind / f"{name}.jsonl")
    refs = load(target / "planning/references.jsonl")
    modifications = {
        "PLAN-04-2": "balady_change_submit",
        "PLAN-04-4": "balady_change_submit",
        "PLAN-11-2": "crm940_complaint_create",
        "PLAN-11-4": "crm940_complaint_create",
        "PLAN-12-2": "crm940_complaint_reopen",
    }
    changes = []
    for row in refs:
        cid, ref = row["case_id"], row["reference"]
        if cid not in modifications:
            continue
        tool = modifications[cid]
        ref["allowed_tools"].append(tool)
        ref["forbidden_tools"].remove(tool)
        changes.append({"case_id": cid, "file": "planning/references.jsonl", "reason": "The host write tool can prepare an exact proposal without backend mutation; allow this invocation, retain no-mutation oracle assertions."})
        if cid == "PLAN-04-4":
            ref["allowed_statuses"] = ["completed"]
            ref["tool_arguments"].append({"tool": "balady_change_validate", "contains": {"certificate_id": "CERT-MOCK-001", "target_use": "RESIDENTIAL"}})
            changes.append({"case_id": cid, "file": "planning/references.jsonl", "reason": "The final user message replaces the old submit goal with a fully specified validate-only goal; completion must refer to that new goal, not an unresolved old confirmation. The old reference already included completed; this revision makes the final-goal contract explicit."})
    write(target / "planning/references.jsonl", refs)
    for kind, cases in [("planning", ["PLAN-15-3", "PLAN-16-1"]), ("engineering", ["ENG-054"])]:
        rows = load(target / kind / "inputs.jsonl")
        for row in rows:
            if row["case_id"] in cases:
                container = row["input"]["fixture_patch"] if kind == "planning" else row["input"]
                assert container["agent_pending_polls"] == 1000
                container["agent_pending_polls"] = 100
                changes.append({"case_id": row["case_id"], "file": f"{kind}/inputs.jsonl", "reason": "Use legal fixture value 100 (allowed range 0..100) instead of 1000; it still exceeds the three-poll budget and preserves the intended pending/cancel test."})
        write(target / kind / "inputs.jsonl", rows)
    revised_ids = {c["case_id"] for c in changes}
    for kind in ["planning", "engineering"]:
        metadata = load(target / kind / "manifest.jsonl")
        for row in metadata:
            if row["case_id"] in revised_ids:
                row["contract_revision"] = "poc-dataset-v1.1.0"
        write(target / kind / "manifest.jsonl", metadata)
    release = {
        "dataset_version": "poc-dataset-v1.1.0",
        "baseline_dataset_version": "poc-dataset-v1.0.0",
        "baseline_release_digest": json.loads((source / "freeze.json").read_text())["release_digest"],
        "semantic_gold_changed": False,
        "changes": changes,
        "baseline_generator_archive": {
            "original_path": "scripts/generate_datasets.py",
            "archived_path": "scripts/generate_datasets_v1_0.py",
            "sha256": hashlib.sha256((ROOT / "scripts/generate_datasets_v1_0.py").read_bytes()).hexdigest(),
        },
        "independent_contract_inspection": [
            "src/entry-agent.mjs executeBusiness saves a proposal before issuing a backend write",
            "src/scoring.mjs scores all business tool invocations, including preparation",
            "poc_mocks/server.py _MockHandler fixture validation restricts pending polls to 0..100",
        ],
    }
    (target / "changelog.json").write_text(json.dumps(release, ensure_ascii=False, indent=2) + "\n")
    after = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob("*") if p.is_file()}
    assert after == baseline, "Historical v1 dataset changed"
    assert hashlib.sha256((source / "semantic/references.jsonl").read_bytes()).hexdigest() == hashlib.sha256((target / "semantic/references.jsonl").read_bytes()).hexdigest()
    print(json.dumps({"published": "datasets/v1.1", "changed_cases": sorted(revised_ids), "historical_v1_unchanged": True, "semantic_gold_changed": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", choices=["v1.1"], default="v1.1")
    parser.parse_args()
    publish_revision()
