"""Local-only mock APIs. Run: python3 -m poc_mocks.server --port 8765.

No LLM, external network, real identity provider, official policy or government API.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).parent


def merge_fixture(original, patch):
    """Merge only host-supplied fixture objects; never expose to business tools."""
    result = copy.deepcopy(original)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_fixture(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


class MockError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


class MockEngine:
    """One isolated fixture state per engine; reset by creating a new engine."""

    def __init__(self, fixture=None):
        self.state = copy.deepcopy(fixture) if fixture is not None else json.loads(
            (ROOT / "fixtures/base.json").read_text()
        )
        self.catalog = json.loads((ROOT / "catalog.json").read_text())
        self.routes = []
        for operation in self.catalog["operations"]:
            pattern = re.escape(operation["path"])
            for parameter in operation["path_parameters"]:
                pattern = pattern.replace(re.escape("{" + parameter + "}"),
                                          "(?P<" + parameter + ">[^/]+)")
            self.routes.append((operation, re.compile(pattern)))
        self.lock = threading.RLock()
        self.trace = []
        self.counters = {}
        self.validations = {}
        self.tasks = {}
        self.idempotency = {}
        self.used_confirmations = set()

    def snapshot(self):
        with self.lock:
            return copy.deepcopy({"state": self.state, "tasks": self.tasks,
                "validations": self.validations, "trace": self.trace,
                "used_confirmations": sorted(self.used_confirmations),
                "idempotency_entries": len(self.idempotency)})

    def issue_confirmation(self, operation_id, path_parameters, body, actor, confirmed):
        """Host-only confirmation. The model must never receive this endpoint."""
        with self.lock:
            if confirmed is not True:
                raise MockError(403, "USER_CONFIRMATION_REQUIRED", "Explicit mock user confirmation required")
            operation = next((op for op in self.catalog["operations"] if op["id"] == operation_id), None)
            if operation is None or operation["effect"] != "write":
                raise MockError(400, "NOT_CONFIRMABLE", "Only registered business writes can be confirmed")
            if not isinstance(path_parameters, dict) or set(path_parameters) != set(operation["path_parameters"]):
                raise MockError(400, "INVALID_PATH_PARAMETERS", "Exact path parameters required")
            if any(not isinstance(value, str) or not value.strip() or "/" in value for value in path_parameters.values()):
                raise MockError(400, "INVALID_PATH_PARAMETERS", "Nonempty resource identifiers required")
            if not isinstance(body, dict) or "confirmation_ref" in body:
                raise MockError(400, "HOST_BODY_REQUIRED", "Provide business parameters without confirmation_ref")
            provisional_body = {**body, "confirmation_ref": "HOST-PENDING"}
            self._validate_body(operation, provisional_body)
            scope = self._confirmation_scope(operation_id, path_parameters, body, actor)
            reference = "CONFIRM-HOST-" + secrets.token_hex(16)
            self.state["confirmations"][reference] = {"actor": actor, "operation": operation_id,
                "scope": scope, "binding": {"path_parameters": copy.deepcopy(path_parameters),
                "body": copy.deepcopy(body)}}
            return {"confirmation_ref": reference, "operation_id": operation_id,
                "scope": copy.deepcopy(scope), "source_type": "mock"}

    def _confirmation_scope(self, operation_id, path_parameters, body, actor):
        if operation_id == "balady_change_submit":
            validation = self.validations.get(body["validation_id"])
            if not validation or validation["owner"] != actor:
                raise MockError(403, "INVALID_VALIDATION", "No owned mock validation")
            return {"certificate_id": validation["certificate_id"], "target_use": validation["target_use"]}
        if operation_id == "crm940_complaint_reopen":
            self._record("complaints", path_parameters["complaint_id"], actor)
            return {**path_parameters, "reason": body["reason"]}
        if operation_id == "crm940_complaint_create":
            if body.get("related_application_id"):
                self._record("applications", body["related_application_id"], actor)
            if body.get("parcel_id"):
                self._record("parcels", body["parcel_id"], actor, False)
            return copy.deepcopy(body)
        raise MockError(400, "NOT_CONFIRMABLE", "Unknown business write")

    def _new_id(self, prefix):
        self.counters[prefix] = self.counters.get(prefix, 0) + 1
        return f"{prefix}-{self.counters[prefix]:04d}"

    def _record(self, table, identity, actor, owned=True):
        record = self.state[table].get(identity)
        if record is None:
            raise MockError(404, "NOT_FOUND", "Mock resource not found")
        if owned and record.get("owner") != actor:
            raise MockError(403, "NOT_OWNER", "Mock resource belongs to another actor")
        return record

    def _confirmation(self, reference, operation, actor, scope, path_parameters=None, body=None):
        confirmation = self.state["confirmations"].get(reference)
        if not confirmation or confirmation["actor"] != actor or confirmation["operation"] != operation:
            raise MockError(403, "CONFIRMATION_REQUIRED", "No matching mock confirmation")
        if scope != confirmation["scope"]:
            raise MockError(403, "CONFIRMATION_SCOPE_MISMATCH", "Mock confirmation does not cover these parameters")
        if "binding" in confirmation and confirmation["binding"] != {
                "path_parameters": path_parameters or {},
                "body": {key: value for key, value in (body or {}).items() if key != "confirmation_ref"}}:
            raise MockError(403, "CONFIRMATION_PARAMETERS_MISMATCH", "Mock confirmation binds exact submitted parameters")
        if reference in self.used_confirmations:
            raise MockError(409, "CONFIRMATION_USED", "Use the original idempotency key to retry")

    @staticmethod
    def _validate_body(operation, body):
        if not isinstance(body, dict):
            raise MockError(400, "INVALID_BODY", "JSON object required")
        if set(body) - set(operation["properties"]):
            raise MockError(400, "UNKNOWN_FIELD", "Unexpected parameter")
        if any(key not in body for key in operation["required"]):
            raise MockError(400, "MISSING_FIELD", "Required parameter missing")
        for key, value in body.items():
            expected = operation["properties"][key]
            if expected == "string" and (not isinstance(value, str) or not value.strip()):
                raise MockError(400, "INVALID_FIELD", f"{key} requires a nonempty string")
            if expected == "object" and not isinstance(value, dict):
                raise MockError(400, "INVALID_FIELD", f"{key} requires an object")

    def request(self, method, path, body=None, headers=None):
        """Return (HTTP status, JSON). Trace is available to the harness, not the model."""
        with self.lock:
            return self._request(method, path, body, headers or {})

    def _request(self, method, path, body, headers):
        operation = None
        actor = headers.get("X-POC-Actor")
        event = {"event_id": len(self.trace) + 1, "actor": actor,
                 "method": method, "path": path, "body": copy.deepcopy(body)}
        try:
            if actor not in self.state["actors"]:
                raise MockError(401, "MOCK_ACTOR_REQUIRED", "Use a configured X-POC-Actor")
            for candidate, pattern in self.routes:
                match = pattern.fullmatch(path)
                if candidate["method"] == method and match:
                    operation = candidate
                    parameters = {key: unquote(value) for key, value in match.groupdict().items()}
                    break
            if operation is None:
                raise MockError(404, "OPERATION_NOT_FOUND", "No matching mock operation")
            event["operation_id"] = operation["id"]
            body = {} if body is None else body
            self._validate_body(operation, body)
            key = headers.get("Idempotency-Key")
            cache_key = (actor, operation["id"], key)
            fingerprint = json.dumps({"path": path, "body": body}, sort_keys=True)
            if operation.get("requires_idempotency_key"):
                if not key:
                    raise MockError(400, "IDEMPOTENCY_KEY_REQUIRED", "A mock write needs an idempotency key")
                if cache_key in self.idempotency:
                    previous, result = self.idempotency[cache_key]
                    if previous != fingerprint:
                        raise MockError(409, "IDEMPOTENCY_CONFLICT", "Key already used with different parameters")
                    event["replayed"] = True
                    event["side_effect"] = "replayed"
                    data = copy.deepcopy(result)
                else:
                    fault = self._take_fault(operation["id"])
                    self._before_fault(fault)
                    data = self._execute(operation["id"], parameters, body, actor)
                    self.idempotency[cache_key] = (fingerprint, copy.deepcopy(data))
                    event["side_effect"] = "committed"
                    self._after_fault(fault, event, data)
            else:
                fault = self._take_fault(operation["id"])
                self._before_fault(fault)
                data = self._execute(operation["id"], parameters, body, actor)
                self._after_fault(fault, event, data)
            status = 200
            payload = {"ok": True, "data": copy.deepcopy(data)}
        except MockError as error:
            status = error.status
            payload = {"ok": False, "error": {"code": error.code, "message": str(error)}}
        payload["meta"] = {"source_type": "mock", "fixture_version": self.state["fixture_version"],
                           "operation_id": operation["id"] if operation else None,
                           "event_id": event["event_id"]}
        event.update({"status": status, "result": copy.deepcopy(payload)})
        self.trace.append(event)
        return status, payload

    def _take_fault(self, operation_id):
        faults = self.state.get("faults", {}).get(operation_id, [])
        return faults.pop(0) if faults else None

    @staticmethod
    def _before_fault(fault):
        if fault and fault.get("phase", "before") == "before":
            raise MockError(fault.get("status", 503), fault.get("code", "MOCK_UNAVAILABLE"), "Fixture-injected fault before execution")

    @staticmethod
    def _after_fault(fault, event, data):
        if fault and fault.get("phase") == "after_commit":
            event["result_unknown"] = True
            event["committed_data"] = copy.deepcopy(data)
            raise MockError(fault.get("status", 504), fault.get("code", "MOCK_RESULT_UNKNOWN"),
                            "Fixture-injected lost response; execution outcome unknown to caller")

    def _execute(self, op, path, body, actor):
        if op == "balady_planning_get":
            return {"parcel_id": path["parcel_id"], **self._record("parcels", path["parcel_id"], actor, False)}
        if op == "balady_certificate_get":
            return {"certificate_id": path["certificate_id"], **self._record("certificates", path["certificate_id"], actor)}
        if op == "balady_change_validate":
            certificate = self._record("certificates", body["certificate_id"], actor)
            parcel = self._record("parcels", certificate["parcel_id"], actor, False)
            allowed = body["target_use"] in parcel["allowed_uses"]
            identity = self._new_id("VALIDATION-MOCK")
            self.validations[identity] = {"owner": actor, "certificate_id": body["certificate_id"],
                "certificate_version": certificate["version"], "target_use": body["target_use"],
                "valid": allowed, "used": False, "rule_version": parcel["rule_version"]}
            return {"validation_id": identity, "valid": allowed,
                    "issues": [] if allowed else ["MOCK_TARGET_USE_NOT_ALLOWED"],
                    "rule_version": parcel["rule_version"], "approval": False}
        if op == "balady_change_submit":
            validation = self.validations.get(body["validation_id"])
            if not validation or validation["owner"] != actor:
                raise MockError(403, "INVALID_VALIDATION", "No owned mock validation")
            certificate = self._record("certificates", validation["certificate_id"], actor)
            parcel = self._record("parcels", certificate["parcel_id"], actor, False)
            if (not validation["valid"] or validation["used"]
                    or certificate["version"] != validation["certificate_version"]
                    or parcel["rule_version"] != validation["rule_version"]
                    or validation["target_use"] not in parcel["allowed_uses"]):
                raise MockError(409, "VALIDATION_NOT_USABLE", "Validation rejected, used or stale")
            self._confirmation(body["confirmation_ref"], op, actor,
                               {"certificate_id": validation["certificate_id"], "target_use": validation["target_use"]}, path, body)
            identity = self._new_id("APP-MOCK-NEW")
            self.state["applications"][identity] = {"owner": actor,
                "certificate_id": validation["certificate_id"], "target_use": validation["target_use"],
                "status": "submitted", "stage": "awaiting_mock_review"}
            validation["used"] = True
            self.used_confirmations.add(body["confirmation_ref"])
            return {"application_id": identity, "status": "submitted", "certificate_changed": False}
        if op == "balady_application_get":
            return {"application_id": path["application_id"], **self._record("applications", path["application_id"], actor)}
        if op == "sakani_requirements_get":
            return {"policy_version": "MOCK-SUPPORT-1", "description": "Fixture scenario decisions only; no official eligibility thresholds.",
                    "possible_decisions": ["eligible", "ineligible", "needs_input"], "official_decision": False}
        if op == "sakani_support_assess":
            profile = self._record("support_profiles", body["profile_id"], actor)
            return {"profile_id": body["profile_id"], "decision": profile["scenario_decision"],
                    "missing_fields": profile["missing_fields"], "policy_version": "MOCK-SUPPORT-1", "official_decision": False}
        if op == "sakani_request_get":
            return {"request_id": path["request_id"], **self._record("support_requests", path["request_id"], actor)}
        if op in ("crm940_complaint_get", "crm940_history_get"):
            complaint = self._record("complaints", path["complaint_id"], actor)
            if op.endswith("history_get"):
                return {"complaint_id": path["complaint_id"], "events": complaint["history"]}
            return {"complaint_id": path["complaint_id"], **{key: value for key, value in complaint.items() if key != "history"}}
        if op == "crm940_complaint_create":
            if body["category"] not in ("municipal_service_delay", "waste", "streetlight", "current_hazard"):
                raise MockError(422, "OUTSIDE_MOCK_SERVICE_SCOPE", "Not a supported municipal complaint category")
            if "related_application_id" in body:
                self._record("applications", body["related_application_id"], actor)
            if "parcel_id" in body:
                self._record("parcels", body["parcel_id"], actor, False)
            if not body.get("related_application_id") and not body.get("parcel_id"):
                raise MockError(422, "LOCATION_OR_APPLICATION_REQUIRED", "Missing complaint subject")
            self._confirmation(body["confirmation_ref"], op, actor,
                               {key: value for key, value in body.items() if key != "confirmation_ref"}, path, body)
            identity = self._new_id("CMP-MOCK-NEW")
            self.state["complaints"][identity] = {"owner": actor,
                **{key: value for key, value in body.items() if key != "confirmation_ref"},
                "status": "open", "resolution_record": None, "history": [{"event": "created"}]}
            self.used_confirmations.add(body["confirmation_ref"])
            return {"complaint_id": identity, "status": "open", "issue_resolved": False}
        if op == "crm940_complaint_reopen":
            complaint = self._record("complaints", path["complaint_id"], actor)
            if complaint["status"] != "closed":
                raise MockError(409, "NOT_CLOSED", "Only a closed mock complaint can be reopened")
            self._confirmation(body["confirmation_ref"], op, actor,
                               {**path, "reason": body["reason"]}, path, body)
            complaint["status"] = "reopened"
            complaint["history"].append({"event": "reopened", "reason": body["reason"]})
            self.used_confirmations.add(body["confirmation_ref"])
            return {"complaint_id": path["complaint_id"], "status": "reopened", "issue_resolved": False}
        return self._furas(op, path, body, actor)

    @staticmethod
    def _validate_criteria(criteria):
        if set(criteria) - {"city", "sector", "budget_sar"}:
            raise MockError(400, "UNKNOWN_CRITERION", "Unsupported investment filter")
        for key in ("city", "sector"):
            if key in criteria and (not isinstance(criteria[key], str) or not criteria[key].strip()):
                raise MockError(400, "INVALID_CRITERION", "City and sector must be nonempty strings")
        budget = criteria.get("budget_sar")
        if "budget_sar" in criteria and (isinstance(budget, bool) or not isinstance(budget, (int, float)) or not math.isfinite(budget) or budget <= 0):
            raise MockError(400, "INVALID_BUDGET", "Positive finite mock budget required")

    def _prepare_task(self, task):
        task["missing_fields"] = [key for key in ("city", "sector", "budget_sar") if key not in task["criteria"]]
        task["status"] = "needs_input" if task["missing_fields"] else "pending"
        task["remaining_polls"] = self.state.get("agent_pending_polls", 1)

    def _furas(self, op, path, body, actor):
        if op == "furas_task_start":
            self._validate_criteria(body["criteria"])
            identity = self._new_id("FURAS-TASK-MOCK")
            task = {"task_id": identity, "owner": actor, "goal": body["goal"],
                    "criteria": copy.deepcopy(body["criteria"]), "result": None}
            self._prepare_task(task)
            self.tasks[identity] = task
        else:
            task = self.tasks.get(path["task_id"])
            if task is None:
                raise MockError(404, "TASK_NOT_FOUND", "Unknown mock agent task")
            if task["owner"] != actor:
                raise MockError(403, "NOT_OWNER", "Task belongs to another actor")
            if op == "furas_task_resume":
                if task["status"] != "needs_input":
                    raise MockError(409, "TASK_NOT_WAITING_INPUT", "Task is not waiting for clarification")
                self._validate_criteria(body["criteria"])
                task["criteria"].update(body["criteria"])
                self._prepare_task(task)
            elif op == "furas_task_cancel":
                if task["status"] in ("completed", "failed"):
                    raise MockError(409, "TASK_TERMINAL", "Task already completed or failed")
                task["status"] = "cancelled"
            elif op == "furas_task_get" and task["status"] == "pending":
                if task["remaining_polls"] > 0:
                    task["remaining_polls"] -= 1
                else:
                    failure = self.state.get("agent_failure")
                    if failure:
                        task["status"] = "failed"
                        task["failure"] = {"code": failure.get("code", "MOCK_AGENT_FAILED"),
                            "message": failure.get("message", "Fixture-injected remote agent failure")}
                        return {key: value for key, value in task.items() if key not in ("owner", "remaining_polls")}
                    criteria = task["criteria"]
                    selected = [opportunity for opportunity in self.state["investment_opportunities"]
                        if opportunity["city"].casefold() == criteria["city"].casefold()
                        and opportunity["sector"].casefold() == criteria["sector"].casefold()
                        and opportunity["minimum_mock_budget_sar"] <= criteria["budget_sar"]]
                    task["status"] = "completed"
                    task["result"] = {"opportunities": selected,
                        "basis": ["city", "sector", "mock_budget_filter"],
                        "advisory_only": True, "investment_executed": False,
                        "limitations": "Scripted fixture filtering; no financial return or official offer."}
        return {key: value for key, value in task.items() if key not in ("owner", "remaining_polls")}


class MockRegistry:
    """Host control plane and per-case isolation; never register control routes as tools."""

    def __init__(self, control_token, base_fixture=None, default_engine=None):
        self.control_token = control_token
        self.base_fixture = copy.deepcopy(base_fixture) if base_fixture is not None else json.loads(
            (ROOT / "fixtures/base.json").read_text())
        self.default_engine = default_engine
        self.cases = {}
        self.lock = threading.RLock()

    @staticmethod
    def _error(error):
        return error.status, {"ok": False, "error": {"code": error.code, "message": str(error)},
            "meta": {"source_type": "mock", "control_or_case_boundary": True}}

    def request(self, method, path, body, headers):
        try:
            if path.startswith("/__poc/"):
                supplied = headers.get("X-POC-Control-Token", "")
                if not secrets.compare_digest(supplied.encode("utf-8"), self.control_token.encode("utf-8")):
                    raise MockError(403, "CONTROL_TOKEN_REQUIRED", "Host-only mock control endpoint")
                return self._control(method, path, body or {})
            case_id = headers.get("X-POC-Case-ID")
            with self.lock:
                case = self.cases.get(case_id)
            if case is None:
                if case_id is None and self.default_engine is not None:
                    return self.default_engine.request(method, path, body, headers)
                raise MockError(404 if case_id else 400, "MOCK_CASE_REQUIRED", "Create and select an isolated mock case")
            if headers.get("X-POC-Actor") != case["actor"]:
                raise MockError(403, "CASE_ACTOR_MISMATCH", "Actor is bound by the host to this case")
            return case["engine"].request(method, path, body, headers)
        except MockError as error:
            return self._error(error)

    def _control(self, method, path, body):
        if not isinstance(body, dict):
            raise MockError(400, "INVALID_BODY", "JSON object required")
        with self.lock:
            if method == "POST" and path == "/__poc/cases":
                if set(body) - {"case_id", "actor", "fixture_patch"}:
                    raise MockError(400, "UNKNOWN_FIELD", "Unexpected case creation parameter")
                case_id, actor = body.get("case_id"), body.get("actor", "citizen-a")
                if not isinstance(case_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", case_id):
                    raise MockError(400, "INVALID_CASE_ID", "Use a unique alphanumeric case identifier")
                if case_id in self.cases:
                    raise MockError(409, "CASE_EXISTS", "An existing case cannot be silently reset")
                if actor not in self.base_fixture["actors"]:
                    raise MockError(400, "INVALID_ACTOR", "Unknown fixture actor")
                patch = body.get("fixture_patch", {})
                if not isinstance(patch, dict) or set(patch) - {
                        "fixture_version", "parcels", "certificates", "applications", "support_profiles",
                        "support_requests", "complaints", "investment_opportunities", "agent_pending_polls",
                        "agent_failure", "faults"}:
                    raise MockError(400, "INVALID_FIXTURE_PATCH", "Unknown or unpatchable fixture fields")
                fixture = merge_fixture(self.base_fixture, patch)
                fixture["confirmations"] = {}  # static demo references never authorize runner cases
                for table in ("parcels", "certificates", "applications", "support_profiles", "support_requests", "complaints"):
                    if not isinstance(fixture.get(table), dict) or any(not isinstance(record, dict) for record in fixture[table].values()):
                        raise MockError(400, "INVALID_FIXTURE_PATCH", "Fixture resource tables must contain objects")
                if not isinstance(fixture.get("investment_opportunities"), list):
                    raise MockError(400, "INVALID_FIXTURE_PATCH", "Mock opportunities must be a list")
                if isinstance(fixture.get("agent_pending_polls", 1), bool) or not isinstance(fixture.get("agent_pending_polls", 1), int) or not 0 <= fixture.get("agent_pending_polls", 1) <= 100:
                    raise MockError(400, "INVALID_FIXTURE_PATCH", "Mock pending poll count must be 0..100")
                failure = fixture.get("agent_failure")
                if failure is not None and not isinstance(failure, dict):
                    raise MockError(400, "INVALID_FIXTURE_PATCH", "agent_failure must be an object")
                engine = MockEngine(fixture)
                known_operations = {op["id"]: op for op in engine.catalog["operations"]}
                faults = fixture.get("faults", {})
                if not isinstance(faults, dict) or set(faults) - set(known_operations):
                    raise MockError(400, "INVALID_FIXTURE_PATCH", "Fault keys must name registered operations")
                for operation_id, operation_faults in faults.items():
                    if not isinstance(operation_faults, list):
                        raise MockError(400, "INVALID_FIXTURE_PATCH", "Fault sequences must be lists")
                    for fault in operation_faults:
                        if (not isinstance(fault, dict) or fault.get("phase", "before") not in ("before", "after_commit")
                                or not isinstance(fault.get("status", 503), int) or not 400 <= fault.get("status", 503) <= 599):
                            raise MockError(400, "INVALID_FIXTURE_PATCH", "Invalid deterministic fault")
                        if fault.get("phase") == "after_commit" and not known_operations[operation_id].get("requires_idempotency_key"):
                            raise MockError(400, "INVALID_FIXTURE_PATCH", "Lost write responses require an idempotent modifying operation")
                self.cases[case_id] = {"actor": actor, "engine": engine}
                return 201, {"ok": True, "case_id": case_id, "actor": actor,
                    "fixture_version": fixture["fixture_version"], "source_type": "mock"}
            match = re.fullmatch(r"/__poc/cases/([A-Za-z0-9_.-]{1,128})(?:/(snapshot|confirmations))?", path)
            if not match:
                raise MockError(404, "CONTROL_OPERATION_NOT_FOUND", "Unknown mock control route")
            case_id, operation = match.groups()
            case = self.cases.get(case_id)
            if case is None:
                raise MockError(404, "CASE_NOT_FOUND", "Unknown mock case")
            if method == "GET" and operation == "snapshot":
                return 200, {"ok": True, "case_id": case_id, "source_type": "mock", **case["engine"].snapshot()}
            if method == "POST" and operation == "confirmations":
                if set(body) - {"operation_id", "path_parameters", "body", "confirmed"}:
                    raise MockError(400, "UNKNOWN_FIELD", "Unexpected host confirmation parameter")
                result = case["engine"].issue_confirmation(body.get("operation_id"),
                    body.get("path_parameters", {}), body.get("body"), case["actor"], body.get("confirmed"))
                return 200, {"ok": True, **result}
            if method == "DELETE" and operation is None:
                del self.cases[case_id]
                return 200, {"ok": True, "case_id": case_id, "deleted": True, "source_type": "mock"}
            raise MockError(405, "CONTROL_METHOD_NOT_ALLOWED", "Method does not match mock control route")

    def snapshots(self):
        with self.lock:
            return {case_id: case["engine"].snapshot() for case_id, case in self.cases.items()}


def make_server(engine=None, host="127.0.0.1", port=8765, control_token=None, base_fixture=None):
    if host != "127.0.0.1":
        raise ValueError("POC mock server must listen on 127.0.0.1")
    token = control_token or os.environ.get("POC_MOCK_CONTROL_TOKEN") or secrets.token_urlsafe(32)
    registry = MockRegistry(token, base_fixture, default_engine=engine)

    class Handler(BaseHTTPRequestHandler):
        def _handle(self):
            path = urlsplit(self.path).path
            if self.command == "GET" and path == "/health":
                status, payload = 200, {"ok": True, "source_type": "mock"}
            else:
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 <= length <= 65536:
                        raise ValueError("Invalid request length")
                    raw = self.rfile.read(length) if length else b""
                    body = json.loads(raw) if raw else {}
                    status, payload = registry.request(self.command, path, body, self.headers)
                except (ValueError, UnicodeDecodeError):
                    status, payload = 400, {"ok": False, "source_type": "mock", "error": {"code": "INVALID_JSON"}}
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        do_GET = _handle
        do_POST = _handle
        do_DELETE = _handle

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer((host, port), Handler)
    server.registry = registry
    server.control_token = token
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--trace-out", type=Path, help="Write trace when the server stops")
    args = parser.parse_args()
    fixture = json.loads(args.fixture.read_text()) if args.fixture else None
    server = make_server(port=args.port, base_fixture=fixture)
    print(f"POC mock server: http://127.0.0.1:{server.server_port} (fictional data only)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if args.trace_out:
            args.trace_out.parent.mkdir(parents=True, exist_ok=True)
            args.trace_out.write_text(json.dumps(server.registry.snapshots(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
