#!/usr/bin/env python3
"""Audit frozen datasets and their separation; never sends references to a model."""
from __future__ import annotations
import argparse
import collections
import hashlib
import itertools
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "datasets/v1"
SENTIMENTS = {"positive", "negative", "neutral", "mixed", "undetermined"}
EMOTIONS = {"satisfaction", "gratitude", "frustration", "anger", "worry", "disappointment", "confusion"}
INDICATORS = {"SA01", "SA02", "SA03", "SA04", "SA05"}


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def canonical_text(row, kind):
    if kind == "semantic":
        return "\n".join(m["role"] + ": " + m["content"] for m in row["input"]["messages"])
    if kind == "planning":
        return "\n".join(t["message"] for t in row["input"]["turns"])
    return json.dumps(row["input"], sort_keys=True, ensure_ascii=False)


def word_ngrams(text, n=3):
    text = re.sub(r"[\u064b-\u065f\u0670]", "", text.lower())
    words = re.findall(r"[\w]+", text)
    return {tuple(words[i:i+n]) for i in range(max(0, len(words)-n+1))}


def audit():
    errors, sections = [], {}
    for kind, count in (("semantic", 600), ("planning", 80), ("engineering", 60)):
        inputs = read_jsonl(DATA / kind / "inputs.jsonl")
        references = read_jsonl(DATA / kind / "references.jsonl")
        manifest = read_jsonl(DATA / kind / "manifest.jsonl")
        indexes = [{x["case_id"]: x for x in rows} for rows in [inputs, references, manifest]]
        if any(len(x) != count for x in indexes) or set(indexes[0]) != set(indexes[1]) or set(indexes[0]) != set(indexes[2]):
            errors.append(f"{kind}: incorrect cardinality/IDs")
        families = collections.defaultdict(set)
        duplicate_text = collections.defaultdict(list)
        for row in inputs:
            cid = row["case_id"]
            metadata = indexes[2][cid]
            families[metadata["family_id"]].add(metadata["split"])
            duplicate_text[canonical_text(row, kind)].append(cid)
            if set(row) != {"case_id", "input"}:
                errors.append(f"{cid}: runtime root contains metadata/reference")
            if kind in ("semantic", "planning"):
                forbidden = {"reference", "gold", "expected_status", "required_tools", "sentiment", "indicators", "family_id", "split"}
                if forbidden & set(row["input"]):
                    errors.append(f"{cid}: runtime input leaks reference metadata")
            if kind == "semantic":
                ref = indexes[1][cid]["reference"]
                if ref["status"] != "provisional" or ref["sentiment"] not in SENTIMENTS or not set(ref["emotions"]) <= EMOTIONS or not set(ref["indicators"]) <= INDICATORS:
                    errors.append(f"{cid}: invalid taxonomy")
                messages = {m["id"]: m for m in row["input"]["messages"]}
                if row["input"]["current_message_id"] not in messages or len(messages) != len(row["input"]["messages"]):
                    errors.append(f"{cid}: invalid message IDs")
                for evidence in ref["evidence"]:
                    message = messages.get(evidence["message_id"], {})
                    if message.get("role") != "user" or not evidence["quote"] or evidence["quote"] not in message.get("content", ""):
                        errors.append(f"{cid}: invalid evidence location/role")
                required_labels = {"sentiment:" + ref["sentiment"]} | set(ref["indicators"]) | {"emotion:" + e for e in ref["emotions"]} | {"intent:" + e for e in ref["intents"]}
                if not required_labels <= {e["label"] for e in ref["evidence"]}:
                    errors.append(f"{cid}: missing label evidence")
        if any(len(splits) != 1 for splits in families.values()):
            errors.append(f"{kind}: family split leakage")
        duplicates = [ids for ids in duplicate_text.values() if len(ids) > 1]
        if duplicates:
            errors.append(f"{kind}: exact duplicate runtime records")
        section = {"records": len(inputs), "families": len(families), "split_counts": dict(collections.Counter(m["split"] for m in manifest)), "group_counts": dict(collections.Counter(m["primary_group"] for m in manifest)), "exact_duplicate_groups": duplicates, "cross_split_family_count": sum(len(s) > 1 for s in families.values())}
        if kind in ("semantic", "planning"):
            section["declared_language_counts"] = dict(collections.Counter(m["language"] for m in manifest))
            ngrams = [(r["case_id"], word_ngrams(canonical_text(r, kind))) for r in inputs]
            near = []
            for (cid_a, a), (cid_b, b) in itertools.combinations(ngrams, 2):
                if not a or not b:
                    continue
                overlap = len(a & b) / len(a | b)
                if overlap >= .80:
                    ma, mb = indexes[2][cid_a], indexes[2][cid_b]
                    near.append({"a": cid_a, "b": cid_b, "jaccard_word_trigrams": round(overlap, 4), "same_family": ma["family_id"] == mb["family_id"], "cross_split": ma["split"] != mb["split"]})
            section["near_duplicate_audit"] = {"metric": "Jaccard over lowercase word trigrams, Arabic diacritics removed", "threshold": .8, "pairs": near, "cross_split_pairs": sum(p["cross_split"] for p in near), "note": "Lexical screening is not proof of semantic independence; shared rendering templates remain a documented limitation."}
        if kind == "semantic":
            refs = [r["reference"] for r in references]
            section["sentiment_counts"] = dict(collections.Counter(r["sentiment"] for r in refs))
            section["emotion_positive_counts"] = dict(collections.Counter(e for r in refs for e in r["emotions"]))
            section["indicator_positive_counts"] = {label: sum(label in r["indicators"] for r in refs) for label in sorted(INDICATORS)}
            section["intent_counts"] = dict(collections.Counter(e for r in refs for e in r["intents"]))
            section["phenomenon_counts"] = dict(collections.Counter(e for m in manifest for e in m.get("phenomena", [])))
            section["multi_turn_cases"] = sum(len(r["input"]["messages"]) > 1 for r in inputs)
            section["indicator_counts_by_split"] = {split: {label: sum(label in indexes[1][cid]["reference"]["indicators"] for cid in indexes[1] if indexes[2][cid]["split"] == split) for label in sorted(INDICATORS)} for split in ["dev", "regression", "holdout"]}
        if kind == "planning":
            allowed = {t for r in references for t in r["reference"]["allowed_tools"]}
            required = {t for r in references for t in r["reference"]["required_tools"]}
            catalog = {x["id"] for x in json.loads((ROOT / "poc_mocks/catalog.json").read_text())["operations"]}
            section["required_tool_coverage"] = sorted(required)
            section["missing_required_tool_coverage"] = sorted(catalog-required)
            section["multi_turn_cases"] = sum(len(r["input"]["turns"]) > 1 for r in inputs)
            section["trusted_confirmation_cases"] = sum(any(t.get("confirm") for t in r["input"]["turns"]) for r in inputs)
            if catalog-required or allowed-catalog:
                errors.append("planning: catalog coverage/unknown tool mismatch")
        sections[kind] = section
    version = {"v1": "poc-dataset-v1.0.0", "v1.1": "poc-dataset-v1.1.0", "v1.2": "poc-dataset-v1.2.0"}[DATA.name]
    return {"dataset_version": version, "passed": not errors, "errors": errors, "reference_status": "synthetic provisional, no Arabic/native-domain review", "sections": sections}


def freeze():
    previous_path = DATA / "freeze.json"
    if previous_path.exists():
        previous = json.loads(previous_path.read_text())
        # Published releases are immutable. Mutable entry-point paths are verified
        # against the exact historical snapshots without rewriting old manifests.
        archives = {"v1": "scripts/generate_datasets_v1_0.py", "v1.1": "scripts/generate_datasets_v1_1.py"}
        for relative, expected in previous["files"].items():
            source = ROOT / (archives[DATA.name] if relative == "scripts/generate_datasets.py" and DATA.name in archives else relative)
            if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
                raise SystemExit(f"Published release changed: {relative}; publish a new dataset version instead of overwriting freeze")
        return previous
    files = sorted(p for kind in ["semantic", "planning", "engineering"] for p in (DATA / kind).glob("*.jsonl"))
    files += [ROOT / "scripts/generate_datasets.py", DATA / "README.md"]
    if DATA.name == "v1.1":
        files += [DATA / "changelog.json", ROOT / "scripts/generate_dataset_release.py", ROOT / "scripts/generate_datasets_v1_0.py"]
    if DATA.name == "v1.2":
        files += [DATA / "changelog.json", ROOT / "scripts/generate_dataset_release_v1_2.py", ROOT / "scripts/generate_datasets_v1_1.py", ROOT / "scripts/generate_datasets_v1_0.py"]
    hashes = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    digest = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    version = {"v1": "poc-dataset-v1.0.0", "v1.1": "poc-dataset-v1.1.0", "v1.2": "poc-dataset-v1.2.0"}[DATA.name]
    output = {"dataset_version": version, "frozen_date": "2026-10-09", "hash_algorithm": "SHA-256", "release_digest": digest, "files": hashes, "reference_status": "provisional", "provenance": "Codex authored synthetic scenarios, deterministic local generator; no tested-model generation or tested-model reference grading"}
    (DATA / "freeze.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--freeze", action="store_true")
    parser.add_argument("--version", choices=["v1", "v1.1", "v1.2"], default="v1")
    args = parser.parse_args()
    DATA = ROOT / "datasets" / args.version
    result = audit()
    (DATA / "audit.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"passed": result["passed"], "errors": result["errors"], "near_cross_split_pairs": {k: v.get("near_duplicate_audit", {}).get("cross_split_pairs", 0) for k, v in result["sections"].items()}}, ensure_ascii=False))
    if args.freeze:
        if not result["passed"]:
            raise SystemExit("Audit failed; refuse freezing")
        frozen = freeze()
        print(json.dumps({"release_digest": frozen["release_digest"]}))
    raise SystemExit(0 if result["passed"] else 1)
