"""Integrity checks for the published dataset release; no model or network calls."""
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "datasets/v1"
spec = importlib.util.spec_from_file_location("dataset_audit", ROOT / "scripts/audit_datasets.py")
audit_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_module)


class DatasetReleaseTests(unittest.TestCase):
    def test_release_hashes_match_published_bytes(self):
        frozen = json.loads((DATA / "freeze.json").read_text())
        for relative, expected in frozen["files"].items():
            with self.subTest(file=relative):
                # The entry point acquired version selection. Historical v1's
                # exact original source is archived under this explicit mapping.
                path = ROOT / ("scripts/generate_datasets_v1_0.py" if relative == "scripts/generate_datasets.py" else relative)
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), expected)
        self.assertEqual(hashlib.sha256(json.dumps(frozen["files"], sort_keys=True).encode()).hexdigest(), frozen["release_digest"])

    def test_cardinality_partition_roles_and_evidence(self):
        result = audit_module.audit()
        self.assertTrue(result["passed"], result["errors"])
        self.assertEqual(result["sections"]["semantic"]["split_counts"], {"dev": 300, "regression": 120, "holdout": 180})
        self.assertEqual(result["sections"]["planning"]["split_counts"], {"dev": 32, "regression": 24, "holdout": 24})
        self.assertEqual(result["sections"]["planning"]["missing_required_tool_coverage"], [])

    def test_all_semantic_languages_and_indicators_have_cases(self):
        result = audit_module.audit()["sections"]["semantic"]
        self.assertEqual(result["declared_language_counts"], {"saudi_colloquial": 360, "msa": 120, "arabic_english": 90, "english": 30})
        self.assertEqual(set(result["indicator_positive_counts"]), {"SA01", "SA02", "SA03", "SA04", "SA05"})
        self.assertTrue(all(n > 0 for n in result["indicator_positive_counts"].values()))
        self.assertGreaterEqual(result["multi_turn_cases"], 100)

    def test_runtime_files_are_physically_separate_from_references(self):
        for kind in ["semantic", "planning"]:
            for row in audit_module.read_jsonl(DATA / kind / "inputs.jsonl"):
                with self.subTest(case_id=row["case_id"]):
                    self.assertEqual(set(row), {"case_id", "input"})
                    permitted = {"messages", "current_message_id", "transcription_quality"} if kind == "semantic" else {"actor", "turns", "fixture_patch"}
                    self.assertLessEqual(set(row["input"]), permitted)
        for row in audit_module.read_jsonl(DATA / "semantic/references.jsonl"):
            self.assertEqual(row["reference"]["status"], "provisional")

    def test_revision_preserves_semantic_and_original_reference_history(self):
        revision = ROOT / "datasets/v1.1"
        for name in ["inputs", "references", "manifest"]:
            self.assertEqual((DATA / "semantic" / f"{name}.jsonl").read_bytes(), (revision / "semantic" / f"{name}.jsonl").read_bytes())
        old = {r["case_id"]: r for r in audit_module.read_jsonl(DATA / "planning/references.jsonl")}
        new = {r["case_id"]: r for r in audit_module.read_jsonl(revision / "planning/references.jsonl")}
        changed = {cid for cid in old if old[cid] != new[cid]}
        self.assertEqual(changed, {"PLAN-04-2", "PLAN-04-4", "PLAN-11-2", "PLAN-11-4", "PLAN-12-2"})
        frozen = json.loads((revision / "freeze.json").read_text())
        for relative, expected in frozen["files"].items():
            path = ROOT / ("scripts/generate_datasets_v1_1.py" if relative == "scripts/generate_datasets.py" else relative)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), expected, relative)
        self.assertEqual(hashlib.sha256(json.dumps(frozen["files"], sort_keys=True).encode()).hexdigest(), frozen["release_digest"])

    def test_revision_v12_changes_only_three_planning_references(self):
        previous, current = ROOT / "datasets/v1.1", ROOT / "datasets/v1.2"
        for kind in ["semantic", "engineering"]:
            for name in ["inputs", "references", "manifest"]:
                self.assertEqual((previous / kind / f"{name}.jsonl").read_bytes(), (current / kind / f"{name}.jsonl").read_bytes())
        self.assertEqual((previous / "planning/inputs.jsonl").read_bytes(), (current / "planning/inputs.jsonl").read_bytes())
        old = {r["case_id"]: r for r in audit_module.read_jsonl(previous / "planning/references.jsonl")}
        new = {r["case_id"]: r for r in audit_module.read_jsonl(current / "planning/references.jsonl")}
        self.assertEqual({cid for cid in old if old[cid] != new[cid]}, {"PLAN-08-4", "PLAN-12-3", "PLAN-17-2"})
        self.assertEqual(new["PLAN-12-3"]["reference"]["required_tool_groups"], [["crm940_complaint_get", "crm940_complaint_reopen"]])
        self.assertEqual(len(new["PLAN-08-4"]["reference"]["acceptable_paths"]), 2)
        for cid in ["PLAN-11-3", "PLAN-20-3"]:
            self.assertEqual(old[cid], new[cid])
        frozen = json.loads((current / "freeze.json").read_text())
        for relative, expected in frozen["files"].items():
            self.assertEqual(hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(), expected, relative)


if __name__ == "__main__":
    unittest.main()
