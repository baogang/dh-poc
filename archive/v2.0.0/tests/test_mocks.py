import copy
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from poc_mocks.server import MockEngine, make_server


class MockWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.engine = MockEngine()
        self.headers = {"X-POC-Actor": "citizen-a"}
        self.generated_key = 0

    def call(self, method, path, body=None, key=None, actor=None):
        headers = {**self.headers}
        if method == "POST" and path.startswith("/furas/") and key is None:
            self.generated_key += 1
            key = f"furas-auto-{self.generated_key}"
        if key:
            headers["Idempotency-Key"] = key
        if actor:
            headers["X-POC-Actor"] = actor
        return self.engine.request(method, path, body, headers)

    def ok(self, method, path, body=None, key=None):
        status, payload = self.call(method, path, body, key)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["meta"]["source_type"], "mock")
        return payload["data"]

    def validation(self):
        return self.ok("POST", "/balady/changes/validate", {
            "certificate_id": "CERT-MOCK-001", "target_use": "COMMERCIAL"})["validation_id"]

    def test_all_16_operations_with_business_outcomes(self):
        self.ok("GET", "/balady/parcels/PARCEL-MOCK-001/planning")
        self.ok("GET", "/balady/certificates/CERT-MOCK-001")
        validation_id = self.validation()
        application = self.ok("POST", "/balady/changes", {
            "validation_id": validation_id, "confirmation_ref": "CONFIRM-MOCK-CHANGE-001"}, "change-1")
        self.assertFalse(application["certificate_changed"])
        self.ok("GET", "/balady/applications/" + application["application_id"])
        self.assertEqual(self.engine.state["certificates"]["CERT-MOCK-001"]["current_use"], "RESIDENTIAL")
        self.ok("GET", "/sakani/support/requirements")
        self.ok("POST", "/sakani/support/assess", {"profile_id": "PROFILE-MOCK-001"})
        support = self.ok("GET", "/sakani/requests/SUPPORT-MOCK-001")
        self.assertEqual(support["payment_status"], "not_scheduled")
        self.ok("GET", "/crm940/complaints/CMP-MOCK-001")
        self.ok("GET", "/crm940/complaints/CMP-MOCK-001/history")
        self.ok("POST", "/crm940/complaints", {
            "category": "municipal_service_delay", "related_application_id": "APP-MOCK-001",
            "description": "POC: certificate change pending.",
            "confirmation_ref": "CONFIRM-MOCK-CREATE-001"}, "create-1")
        reopened = self.ok("POST", "/crm940/complaints/CMP-MOCK-001/reopen", {
            "reason": "POC: issue remains unresolved.", "confirmation_ref": "CONFIRM-MOCK-REOPEN-001"}, "reopen-1")
        self.assertFalse(reopened["issue_resolved"])
        task = self.ok("POST", "/furas/tasks", {"goal": "Find mock cafe opportunities", "criteria": {}})
        self.assertEqual(task["status"], "needs_input")
        identity = task["task_id"]
        task = self.ok("POST", f"/furas/tasks/{identity}/resume", {
            "criteria": {"city": "Jeddah", "sector": "cafe", "budget_sar": 250000}})
        self.assertEqual(task["status"], "pending")
        self.assertEqual(self.ok("GET", f"/furas/tasks/{identity}")["status"], "pending")
        result = self.ok("GET", f"/furas/tasks/{identity}")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["result"]["opportunities"][0]["opportunity_id"], "OPP-MOCK-001")
        self.assertFalse(result["result"]["investment_executed"])
        another = self.ok("POST", "/furas/tasks", {"goal": "Another mock task", "criteria": {}})
        self.assertEqual(self.ok("POST", f"/furas/tasks/{another['task_id']}/cancel")["status"], "cancelled")
        expected = {op["id"] for op in self.engine.catalog["operations"]}
        actual = {event.get("operation_id") for event in self.engine.trace}
        self.assertEqual(actual, expected)

    def test_confirmation_and_idempotency_do_not_duplicate_mutations(self):
        body = {"validation_id": self.validation(), "confirmation_ref": "CONFIRM-MOCK-CHANGE-001"}
        first = self.ok("POST", "/balady/changes", body, "same-request")
        second = self.ok("POST", "/balady/changes", body, "same-request")
        self.assertEqual(first, second)
        self.assertEqual(len(self.engine.state["applications"]), 2)
        self.assertTrue(self.engine.trace[-1]["replayed"])
        status, response = self.call("POST", "/balady/changes", {**body, "confirmation_ref": "tampered"}, "same-request")
        self.assertEqual(status, 409)
        self.assertEqual(response["error"]["code"], "IDEMPOTENCY_CONFLICT")

    def test_wrong_confirmation_scope_and_absent_key_are_rejected(self):
        body = {"category": "municipal_service_delay", "related_application_id": "APP-MOCK-001",
                "description": "Changed parameters", "confirmation_ref": "CONFIRM-MOCK-CREATE-001"}
        self.assertEqual(self.call("POST", "/crm940/complaints", body)[0], 400)
        self.assertEqual(self.call("POST", "/crm940/complaints", body, "new-key")[0], 403)
        self.assertEqual(len(self.engine.state["complaints"]), 2)

    def test_stale_or_disallowed_validation_cannot_submit(self):
        validation_id = self.validation()
        self.engine.state["parcels"]["PARCEL-MOCK-001"]["rule_version"] = "MOCK-PLAN-2"
        status, response = self.call("POST", "/balady/changes", {
            "validation_id": validation_id, "confirmation_ref": "CONFIRM-MOCK-CHANGE-001"}, "stale")
        self.assertEqual(status, 409)
        self.assertEqual(response["error"]["code"], "VALIDATION_NOT_USABLE")
        result = self.ok("POST", "/balady/changes/validate", {
            "certificate_id": "CERT-MOCK-001", "target_use": "INDUSTRIAL"})
        self.assertFalse(result["valid"])

    def test_ownership_and_schema_rejection(self):
        self.assertEqual(self.call("GET", "/balady/certificates/CERT-MOCK-002")[0], 403)
        self.assertEqual(self.call("GET", "/crm940/complaints/CMP-MOCK-002/history")[0], 403)
        self.assertEqual(self.call("POST", "/sakani/support/assess", {"profile_id": "PROFILE-MOCK-001", "endpoint": "https://example.test"})[0], 400)
        self.assertEqual(self.engine.request("GET", "/balady/certificates/CERT-MOCK-001")[0], 401)

    def test_sakani_missing_information_is_not_approval(self):
        result = self.ok("POST", "/sakani/support/assess", {"profile_id": "PROFILE-MOCK-002"})
        self.assertEqual(result["decision"], "needs_input")
        self.assertEqual(result["missing_fields"], ["housing_history"])
        self.assertFalse(result["official_decision"])

    def test_furas_empty_results_cancellation_and_task_ownership(self):
        task = self.ok("POST", "/furas/tasks", {"goal": "No matching opportunity", "criteria": {
            "city": "Jeddah", "sector": "retail", "budget_sar": 100000}})
        identity = task["task_id"]
        self.assertEqual(self.call("GET", f"/furas/tasks/{identity}", actor="citizen-b")[0], 403)
        self.ok("GET", f"/furas/tasks/{identity}")
        result = self.ok("GET", f"/furas/tasks/{identity}")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["result"]["opportunities"], [])
        self.assertEqual(self.call("POST", f"/furas/tasks/{identity}/cancel")[0], 409)
        waiting = self.ok("POST", "/furas/tasks", {"goal": "Cancel before execution", "criteria": {}})
        self.ok("POST", f"/furas/tasks/{waiting['task_id']}/cancel")
        self.assertEqual(self.ok("GET", f"/furas/tasks/{waiting['task_id']}")["status"], "cancelled")
        self.assertEqual(self.call("POST", f"/furas/tasks/{waiting['task_id']}/resume", {"criteria": {}})[0], 409)

    def test_furas_invalid_budget_and_unknown_filters(self):
        for criteria in ({"budget_sar": True}, {"budget_sar": float("nan")}, {"city": ""}, {"guaranteed_return": 20}):
            self.assertEqual(self.call("POST", "/furas/tasks", {"goal": "Test", "criteria": criteria})[0], 400)
        self.assertEqual(len(self.engine.tasks), 0)

    def test_faults_and_case_state_are_isolated(self):
        fixture = copy.deepcopy(self.engine.state)
        fixture["faults"] = {"balady_certificate_get": [{"status": 503, "code": "MOCK_UNAVAILABLE"}]}
        faulty = MockEngine(fixture)
        self.assertEqual(faulty.request("GET", "/balady/certificates/CERT-MOCK-001", headers=self.headers)[0], 503)
        self.assertEqual(faulty.request("GET", "/balady/certificates/CERT-MOCK-001", headers=self.headers)[0], 200)
        self.assertEqual(self.call("GET", "/balady/certificates/CERT-MOCK-001")[0], 200)
        self.assertEqual(len(self.engine.trace), 1)
        self.assertEqual(len(MockEngine().trace), 0)


class HTTPContractTests(unittest.TestCase):
    def test_real_http_get_post_and_bad_json(self):
        server = make_server(MockEngine(), port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(base + "/health", timeout=3) as response:
                self.assertEqual(json.load(response)["source_type"], "mock")
            with urlopen(Request(base + "/balady/certificates/CERT-MOCK-001",
                                 headers={"X-POC-Actor": "citizen-a"}), timeout=3) as response:
                self.assertEqual(json.load(response)["data"]["current_use"], "RESIDENTIAL")
            request = Request(base + "/sakani/support/assess", data=b'{"profile_id":"PROFILE-MOCK-002"}',
                              headers={"X-POC-Actor": "citizen-a", "Content-Type": "application/json"})
            with urlopen(request, timeout=3) as response:
                self.assertEqual(json.load(response)["data"]["decision"], "needs_input")
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(base + "/furas/tasks", data=b"not-json", headers={"X-POC-Actor": "citizen-a"}), timeout=3)
            self.assertEqual(error.exception.code, 400)
            self.assertEqual(json.load(error.exception)["error"]["code"], "INVALID_JSON")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


class IsolatedHTTPRunnerTests(unittest.TestCase):
    """Exercise host/control and model/business boundaries over real HTTP."""

    def setUp(self):
        self.server = make_server(port=0, control_token="test-host-control-token")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def http(self, method, path, body=None, case=None, actor="citizen-a", key=None, control=False):
        headers = {"Content-Type": "application/json"}
        if case:
            headers.update({"X-POC-Case-ID": case, "X-POC-Actor": actor})
        if key:
            headers["Idempotency-Key"] = key
        if control:
            headers["X-POC-Control-Token"] = "test-host-control-token"
        encoded = None if body is None else json.dumps(body).encode()
        request = Request(self.base + path, data=encoded, headers=headers, method=method)
        try:
            response = urlopen(request, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def create(self, case="case-a", patch=None, actor="citizen-a"):
        status, response = self.http("POST", "/__poc/cases", {
            "case_id": case, "actor": actor, "fixture_patch": patch or {}}, control=True)
        self.assertEqual(status, 201, response)
        self.assertEqual(response["case_id"], case)
        self.assertIn("fixture_version", response)

    def snapshot(self, case="case-a"):
        status, response = self.http("GET", f"/__poc/cases/{case}/snapshot", control=True)
        self.assertEqual(status, 200, response)
        return response

    def issue(self, operation, body, path_parameters=None, case="case-a"):
        status, response = self.http("POST", f"/__poc/cases/{case}/confirmations", {
            "operation_id": operation, "path_parameters": path_parameters or {},
            "body": body, "confirmed": True}, control=True)
        self.assertEqual(status, 200, response)
        return response["confirmation_ref"]

    def test_control_hidden_actor_bound_and_cases_are_independent(self):
        status, response = self.http("POST", "/__poc/cases", {"case_id": "evil"})
        self.assertEqual(status, 403)
        self.assertEqual(response["error"]["code"], "CONTROL_TOKEN_REQUIRED")
        self.create()
        self.create("case-b", {"applications": {"APP-MOCK-001": {"status": "approved"}}})
        self.assertEqual(self.http("GET", "/balady/applications/APP-MOCK-001")[0], 400)
        self.assertEqual(self.http("GET", "/balady/applications/APP-MOCK-001", case="unknown")[0], 404)
        self.assertEqual(self.http("GET", "/balady/applications/APP-MOCK-001", case="case-a", actor="citizen-b")[0], 403)
        self.assertEqual(self.http("GET", "/balady/applications/APP-MOCK-001", case="case-a")[1]["data"]["status"], "pending_review")
        self.assertEqual(self.http("GET", "/balady/applications/APP-MOCK-001", case="case-b")[1]["data"]["status"], "approved")
        self.assertEqual(len(self.snapshot("case-a")["trace"]), 1)
        self.assertEqual(len(self.snapshot("case-b")["trace"]), 1)
        self.assertEqual(self.http("GET", "/__poc/cases/case-a/snapshot", case="case-a")[0], 403)
        self.assertEqual(self.http("DELETE", "/__poc/cases/case-a", control=True)[0], 200)
        self.assertEqual(self.http("GET", "/balady/applications/APP-MOCK-001", case="case-a")[0], 404)

    def test_host_confirmation_is_explicit_exact_and_single_use(self):
        self.create()
        body = {"reason": "The rubbish is still here"}
        path_parameters = {"complaint_id": "CMP-MOCK-001"}
        issuer = {"operation_id": "crm940_complaint_reopen", "path_parameters": path_parameters,
                  "body": body, "confirmed": False}
        self.assertEqual(self.http("POST", "/__poc/cases/case-a/confirmations", issuer, control=True)[0], 403)
        issuer["confirmed"] = True
        issuer["actor"] = "citizen-b"
        self.assertEqual(self.http("POST", "/__poc/cases/case-a/confirmations", issuer, control=True)[0], 400)
        reference = self.issue("crm940_complaint_reopen", body, path_parameters)
        status, _ = self.http("POST", "/crm940/complaints/CMP-MOCK-001/reopen", {
            "reason": "changed reason", "confirmation_ref": reference}, case="case-a", key="tampered")
        self.assertEqual(status, 403)
        status, response = self.http("POST", "/crm940/complaints/CMP-MOCK-001/reopen", {
            **body, "confirmation_ref": "CONFIRM-MOCK-REOPEN-001"}, case="case-a", key="legacy-reference")
        self.assertEqual(status, 403)
        status, response = self.http("POST", "/crm940/complaints/CMP-MOCK-001/reopen", {
            **body, "confirmation_ref": reference}, case="case-a", key="correct")
        self.assertEqual(status, 200, response)
        self.assertEqual(response["data"]["status"], "reopened")
        snapshot = self.snapshot()
        self.assertEqual(len(snapshot["used_confirmations"]), 1)
        self.assertEqual(len(snapshot["state"]["complaints"]["CMP-MOCK-001"]["history"]), 5)

    def test_confirmation_cannot_rebind_validation_or_foreign_resource(self):
        self.create()
        validate = {"certificate_id": "CERT-MOCK-001", "target_use": "COMMERCIAL"}
        validations = [self.http("POST", "/balady/changes/validate", validate, case="case-a")[1]["data"]["validation_id"] for _ in range(2)]
        reference = self.issue("balady_change_submit", {"validation_id": validations[0]})
        status, response = self.http("POST", "/balady/changes", {
            "validation_id": validations[1], "confirmation_ref": reference}, case="case-a", key="rebind")
        self.assertEqual(status, 403)
        self.assertEqual(response["error"]["code"], "CONFIRMATION_PARAMETERS_MISMATCH")
        status, response = self.http("POST", "/__poc/cases/case-a/confirmations", {
            "operation_id": "crm940_complaint_reopen", "path_parameters": {"complaint_id": "CMP-MOCK-002"},
            "body": {"reason": "try someone else's complaint"}, "confirmed": True}, control=True)
        self.assertEqual(status, 403)
        self.assertEqual(response["error"]["code"], "NOT_OWNER")

    def test_after_commit_unknown_result_recovered_without_duplicate_submission(self):
        self.create(patch={"faults": {"balady_change_submit": [
            {"phase": "after_commit", "status": 504, "code": "MOCK_RESULT_UNKNOWN"}]}})
        validation = self.http("POST", "/balady/changes/validate", {
            "certificate_id": "CERT-MOCK-001", "target_use": "COMMERCIAL"}, case="case-a")[1]["data"]["validation_id"]
        body = {"validation_id": validation}
        body["confirmation_ref"] = self.issue("balady_change_submit", body)
        status, response = self.http("POST", "/balady/changes", body, case="case-a", key="stable-submission")
        self.assertEqual(status, 504)
        self.assertEqual(response["error"]["code"], "MOCK_RESULT_UNKNOWN")
        self.assertNotIn("data", response)
        unknown = self.snapshot()
        self.assertEqual(len(unknown["state"]["applications"]), 2)
        self.assertTrue(unknown["trace"][-1]["result_unknown"])
        self.assertEqual(unknown["trace"][-1]["committed_data"]["status"], "submitted")
        status, receipt = self.http("POST", "/balady/changes", body, case="case-a", key="stable-submission")
        self.assertEqual(status, 200, receipt)
        final = self.snapshot()
        self.assertEqual(len(final["state"]["applications"]), 2)
        self.assertTrue(final["trace"][-1]["replayed"])
        self.assertEqual(len(final["used_confirmations"]), 1)

    def test_transient_read_then_success_and_persistent_fault(self):
        self.create(patch={"faults": {"balady_certificate_get": [
            {"status": 503, "code": "MOCK_UNAVAILABLE"}]}})
        self.assertEqual(self.http("GET", "/balady/certificates/CERT-MOCK-001", case="case-a")[0], 503)
        self.assertEqual(self.http("GET", "/balady/certificates/CERT-MOCK-001", case="case-a")[0], 200)
        self.create("persistent", {"faults": {"balady_certificate_get": [
            {"status": 503, "code": "MOCK_UNAVAILABLE"}] * 3}})
        for _ in range(3):
            self.assertEqual(self.http("GET", "/balady/certificates/CERT-MOCK-001", case="persistent")[0], 503)

    def test_furas_lifecycle_idempotency_failure_and_isolation(self):
        self.create(patch={"agent_pending_polls": 0})
        body = {"goal": "Find cafes", "criteria": {"city": "Jeddah"}}
        status, start = self.http("POST", "/furas/tasks", body, case="case-a", key="start")
        self.assertEqual(status, 200)
        identity = start["data"]["task_id"]
        self.assertEqual(start["data"]["status"], "needs_input")
        status, replay = self.http("POST", "/furas/tasks", body, case="case-a", key="start")
        self.assertEqual(replay["data"]["task_id"], identity)
        self.assertEqual(len(self.snapshot()["tasks"]), 1)
        resume = {"criteria": {"sector": "cafe", "budget_sar": 250000}}
        status, response = self.http("POST", f"/furas/tasks/{identity}/resume", resume, case="case-a", key="resume")
        self.assertEqual(response["data"]["status"], "pending")
        self.assertEqual(self.http("POST", f"/furas/tasks/{identity}/resume", resume, case="case-a", key="resume")[0], 200)
        complete = self.http("GET", f"/furas/tasks/{identity}", case="case-a")[1]["data"]
        self.assertEqual(complete["status"], "completed")
        self.assertFalse(complete["result"]["investment_executed"])
        self.create("failed", {"agent_pending_polls": 0, "agent_failure": {"code": "MOCK_PROVIDER_DOWN"}})
        self.assertEqual(self.http("GET", f"/furas/tasks/{identity}", case="failed")[0], 404)
        failed_task = self.http("POST", "/furas/tasks", {"goal": "Fail remotely", "criteria": {
            "city": "Jeddah", "sector": "cafe", "budget_sar": 250000}}, case="failed", key="failed-start")[1]["data"]
        failure = self.http("GET", f"/furas/tasks/{failed_task['task_id']}", case="failed")[1]["data"]
        self.assertEqual(failure["status"], "failed")
        self.assertEqual(failure["failure"]["code"], "MOCK_PROVIDER_DOWN")
        self.assertEqual(self.http("POST", f"/furas/tasks/{failed_task['task_id']}/resume", resume, case="failed", key="failed-resume")[0], 409)

    def test_furas_lost_start_and_resume_responses_do_not_duplicate_tasks(self):
        self.create(patch={"faults": {
            "furas_task_start": [{"phase": "after_commit", "status": 504}],
            "furas_task_resume": [{"phase": "after_commit", "status": 504}]}})
        body = {"goal": "Find cafes", "criteria": {}}
        self.assertEqual(self.http("POST", "/furas/tasks", body, case="case-a", key="start")[0], 504)
        recovered = self.http("POST", "/furas/tasks", body, case="case-a", key="start")[1]["data"]
        self.assertEqual(len(self.snapshot()["tasks"]), 1)
        path = f"/furas/tasks/{recovered['task_id']}/resume"
        supplement = {"criteria": {"city": "Jeddah", "sector": "cafe", "budget_sar": 250000}}
        self.assertEqual(self.http("POST", path, supplement, case="case-a", key="resume")[0], 504)
        self.assertEqual(self.http("POST", path, supplement, case="case-a", key="resume")[1]["data"]["status"], "pending")
        self.assertEqual(len(self.snapshot()["tasks"]), 1)
        cancel_path = f"/furas/tasks/{recovered['task_id']}/cancel"
        self.assertEqual(self.http("POST", cancel_path, {}, case="case-a", key="cancel")[1]["data"]["status"], "cancelled")
        self.assertEqual(self.http("POST", cancel_path, {}, case="case-a", key="cancel")[0], 200)
        self.assertEqual(self.http("GET", f"/furas/tasks/{recovered['task_id']}", case="case-a")[1]["data"]["status"], "cancelled")

    def test_duplicate_parallel_mutations_are_serialized_and_replayed(self):
        self.create()
        body = {"reason": "Still not fixed"}
        body["confirmation_ref"] = self.issue("crm940_complaint_reopen", body, {"complaint_id": "CMP-MOCK-001"})
        responses = []
        threads = [threading.Thread(target=lambda: responses.append(self.http("POST",
            "/crm940/complaints/CMP-MOCK-001/reopen", body, case="case-a", key="one-user-action"))) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        self.assertEqual(len(responses), 6)
        self.assertTrue(all(status == 200 for status, _ in responses), responses)
        self.assertEqual(len(self.snapshot()["state"]["complaints"]["CMP-MOCK-001"]["history"]), 5)
        self.assertEqual(sum(event.get("replayed", False) for event in self.snapshot()["trace"]), 5)

    def test_cross_case_confirmation_replay_and_missing_furas_key_rejected(self):
        self.create()
        self.create("case-b")
        body = {"reason": "Still not fixed"}
        reference = self.issue("crm940_complaint_reopen", body, {"complaint_id": "CMP-MOCK-001"})
        self.assertEqual(self.http("POST", "/crm940/complaints/CMP-MOCK-001/reopen", {
            **body, "confirmation_ref": reference}, case="case-b", key="cross-case")[0], 403)
        self.assertEqual(self.http("POST", "/furas/tasks", {
            "goal": "A single task", "criteria": {}}, case="case-a")[0], 400)
        self.assertEqual(len(self.snapshot()["tasks"]), 0)
        self.assertEqual(self.snapshot("case-b")["state"]["complaints"]["CMP-MOCK-001"]["status"], "closed")

    def test_host_invalid_fixtures_and_non_write_confirmations_are_rejected(self):
        for patch in ({"confirmations": {"forged": {}}}, {"actors": ["anyone"]},
                      {"agent_pending_polls": True}, {"complaints": []},
                      {"faults": {"invented_operation": []}},
                      {"faults": {"balady_certificate_get": [{"phase": "after_commit"}]}}):
            status, response = self.http("POST", "/__poc/cases", {
                "case_id": "invalid-patch", "fixture_patch": patch}, control=True)
            self.assertEqual(status, 400, response)
        self.create()
        status, response = self.http("POST", "/__poc/cases/case-a/confirmations", {
            "operation_id": "balady_certificate_get", "path_parameters": {"certificate_id": "CERT-MOCK-001"},
            "body": {}, "confirmed": True}, control=True)
        self.assertEqual(status, 400)
        self.assertEqual(response["error"]["code"], "NOT_CONFIRMABLE")


if __name__ == "__main__":
    unittest.main()
