import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from test_support import claims, gateway_event, response_body

import get_audit_log
import get_site_health


CONTEXT = SimpleNamespace(aws_request_id="observability-request")
ADMIN_EVENT = gateway_event(claims(groups=["Admins"]))


class SiteHealthTests(unittest.TestCase):
    def test_guards_run_before_provider_checks(self):
        denied = {"statusCode": 403, "body": "denied"}
        with patch.object(get_site_health, "verify_front_door_request", return_value=denied), patch.object(get_site_health, "_public_check") as check:
            self.assertIs(get_site_health.handler({}, CONTEXT), denied)
            check.assert_not_called()
        with patch.object(get_site_health, "verify_front_door_request", return_value=None), patch.object(get_site_health, "require_admin", return_value=denied), patch.object(get_site_health, "_public_check") as check:
            self.assertIs(get_site_health.handler({}, CONTEXT), denied)
            check.assert_not_called()

    def test_returns_website_scoped_health_and_audits(self):
        checks = [
            {"id": "website", "label": "Public website", "status": "healthy", "detail": "HTTP 200", "latencyMs": 40},
            {"id": "api", "label": "Public album API", "status": "healthy", "detail": "HTTP 200", "latencyMs": 80},
        ]
        stack = {"id": "infrastructure", "label": "AWS infrastructure", "status": "healthy", "detail": "Update Complete", "latencyMs": None}
        alarms = [{"name": "API Server Error", "description": "Website API", "state": "OK", "updatedAt": "2026-08-27T00:00:00Z"}]
        with patch.object(get_site_health, "verify_front_door_request", return_value=None), patch.object(get_site_health, "require_admin", return_value=None), patch.object(
            get_site_health, "_public_check", side_effect=checks
        ), patch.object(get_site_health, "_stack_check", return_value=stack), patch.object(
            get_site_health, "_alarms", return_value=(alarms, None)
        ), patch.object(get_site_health, "emit_audit_event") as audit:
            response = get_site_health.handler(ADMIN_EVENT, CONTEXT)
        body = response_body(response)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        self.assertEqual(body["overall"], "healthy")
        self.assertEqual(body["summary"]["monitoredAlarms"], 1)
        self.assertEqual(body["summary"]["checksPassing"], 3)
        self.assertEqual(audit.call_args.kwargs["reason_code"], "healthy_report")

    def test_alarm_or_unknown_provider_state_changes_overall_status(self):
        checks = [{"status": "healthy"}]
        self.assertEqual(get_site_health._overall(checks, [{"state": "ALARM"}], None), "incident")
        self.assertEqual(get_site_health._overall(checks, [], "Unavailable"), "degraded")

    def test_alarm_names_drop_stack_and_generated_suffixes(self):
        with patch.dict(get_site_health.os.environ, {"STACK_NAME": "ian-website-test"}):
            self.assertEqual(get_site_health._label_alarm("ian-website-test-PreviewQueueDepthAlarm-AbCd123456"), "Preview Queue Depth")


    def test_alarm_inventory_includes_exact_edge_backup_names_and_paginates(self):
        home, edge = Mock(), Mock()
        def read(**args):
            if 'AlarmNames' in args:
                names = args['AlarmNames']
                return {'MetricAlarms': [{'AlarmName': n, 'StateValue': 'OK'} for n in names]}
            if args.get('NextToken'):
                return {'MetricAlarms': [{'AlarmName': 'ian-website-test-QueueAlarm-AbCd123456', 'StateValue': 'OK'}]}
            return {'MetricAlarms': [{'AlarmName': 'ian-website-test-ApiAlarm-AbCd123456', 'StateValue': 'OK'}, {'AlarmName': 'unrelated-account-alarm', 'StateValue': 'ALARM'}], 'NextToken': 'page-two'}
        home.describe_alarms.side_effect = read
        edge.describe_alarms.side_effect = read
        with patch.object(get_site_health, 'cloudwatch', home), patch.object(get_site_health, 'edge_cloudwatch', edge), patch.dict(get_site_health.os.environ, {'STACK_NAME': 'ian-website-test', 'APPLICATION_STAGE': 'test'}):
            alarms, error = get_site_health._alarms()
        self.assertIsNone(error)
        self.assertEqual(len(alarms), 7)
        self.assertIn('Backup Freshness', {a['name'] for a in alarms})
        self.assertIn('Website Edge Server Errors', {a['name'] for a in alarms})
        self.assertNotIn('unrelated-account-alarm', str(alarms))
        self.assertEqual(home.describe_alarms.call_count, 3)
        self.assertEqual(edge.describe_alarms.call_args.kwargs['AlarmNames'], ['ian-photography-frontend-5xx-test', 'ian-photography-media-5xx-test', 'ian-photography-waf-blocked-test'])

    def test_partial_failure_or_missing_expected_alarm_degrades_health(self):
        home, edge = Mock(), Mock()
        home.describe_alarms.return_value = {'MetricAlarms': []}
        edge.describe_alarms.side_effect = PermissionError('private-provider-detail')
        with patch.object(get_site_health, 'cloudwatch', home), patch.object(get_site_health, 'edge_cloudwatch', edge), patch.dict(get_site_health.os.environ, {'STACK_NAME': 'ian-website-test', 'APPLICATION_STAGE': 'test'}):
            alarms, error = get_site_health._alarms()
        self.assertEqual(len(alarms), 5)
        self.assertTrue(all(a['state'] == 'INSUFFICIENT_DATA' for a in alarms))
        self.assertEqual(get_site_health._overall([{'status': 'healthy'}], alarms, error), 'degraded')
        self.assertNotIn('private-provider-detail', str((alarms, error)))


class AuditLogTests(unittest.TestCase):
    def test_guards_run_before_logs_query(self):
        denied = {"statusCode": 403, "body": "denied"}
        with patch.object(get_audit_log, "verify_front_door_request", return_value=denied), patch.object(get_audit_log, "_query_events") as query:
            self.assertIs(get_audit_log.handler({}, CONTEXT), denied)
            query.assert_not_called()
        with patch.object(get_audit_log, "verify_front_door_request", return_value=None), patch.object(get_audit_log, "require_admin", return_value=denied), patch.object(get_audit_log, "_query_events") as query:
            self.assertIs(get_audit_log.handler({}, CONTEXT), denied)
            query.assert_not_called()

    def test_returns_allowlisted_privacy_safe_events_and_summary(self):
        events = [
            {"timestamp": "2026-08-27T00:00:00Z", "event_name": "album.create", "outcome": "success", "severity": "info", "actor_type": "admin", "auth_method": "jwt", "action": "album.create.execute", "resource_type": "album", "reason_code": "album_created"},
            {"timestamp": "2026-08-27T00:01:00Z", "event_name": "auth.login", "outcome": "denied", "severity": "warning", "actor_type": "anonymous", "auth_method": "none", "action": "auth.login.attempt", "resource_type": "authentication", "reason_code": "invalid_credentials"},
        ]
        with patch.object(get_audit_log, "verify_front_door_request", return_value=None), patch.object(get_audit_log, "require_admin", return_value=None), patch.object(
            get_audit_log, "_query_events", return_value=(events, 2048)
        ), patch.object(get_audit_log, "emit_audit_event") as audit:
            response = get_audit_log.handler({**ADMIN_EVENT, "queryStringParameters": {"days": "7"}}, CONTEXT)
        body = response_body(response)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(body["summary"]["outcomes"], {"success": 1, "denied": 1})
        self.assertEqual(body["summary"]["bytesScanned"], 2048)
        self.assertNotIn("request_id", json.dumps(body))
        self.assertNotIn("trace_id", json.dumps(body))
        self.assertEqual(audit.call_args.kwargs["reason_code"], "events_returned")

    def test_nested_lambda_log_is_strictly_parsed(self):
        safe = {
            "record_type": "security_audit", "timestamp": "2026-08-27T00:00:00Z",
            "event_name": "album.create", "outcome": "success", "action": "album.create.execute",
            "resource_type": "album", "reason_code": "album_created", "request_id": "private-id",
        }
        record = get_audit_log._parse_record(json.dumps({"message": json.dumps(safe), "requestId": "outer-id"}))
        self.assertEqual(record["event_name"], "album.create")
        self.assertNotIn("request_id", record)
        self.assertIsNone(get_audit_log._parse_record(json.dumps({"message": "not json"})))

    def test_rejects_unbounded_windows_and_redacts_provider_errors(self):
        with patch.object(get_audit_log, "verify_front_door_request", return_value=None), patch.object(get_audit_log, "require_admin", return_value=None):
            response = get_audit_log.handler({**ADMIN_EVENT, "queryStringParameters": {"days": "365"}}, CONTEXT)
        self.assertEqual(response["statusCode"], 400)
        with patch.object(get_audit_log, "verify_front_door_request", return_value=None), patch.object(get_audit_log, "require_admin", return_value=None), patch.object(
            get_audit_log, "_query_events", side_effect=RuntimeError("provider secret")
        ), self.assertLogs("photography_api.audit_log", level="ERROR") as captured:
            response = get_audit_log.handler(ADMIN_EVENT, CONTEXT)
        self.assertEqual(response["statusCode"], 503)
        self.assertNotIn("provider secret", response["body"] + " ".join(captured.output))


if __name__ == "__main__":
    unittest.main()
