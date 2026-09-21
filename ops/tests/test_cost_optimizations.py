"""Cost reductions preserve late-photo discovery, publication, and alerts."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from cfnlint.decode import decode
from ops.ci import frontend_changes as frontend
from ops.ci.release_guard import frontend_upload_plan, load_release_intent

ROOT = Path(__file__).resolve().parents[2]


class FrontendChangesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in ['index.html', 'print.html', 'theme-init.js', 'service-worker.js',
                     'assets/hashed.js', 'images/heroes/one.webp']:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('original')
        self.first = frontend.plan_changes(self.root, {})
        self.live = {x['path']: {
            'ETag': hashlib.md5((self.root / x['path']).read_bytes()).hexdigest(),
            'CacheControl': x['cache_control'], 'ContentType': 'text/html; charset=utf-8',
        } for x in frontend_upload_plan(self.root)}

    def test_unchanged_redeploy_uploads_and_invalidates_nothing(self):
        plan = frontend.plan_changes(self.root, self.first['manifest'], self.live)
        self.assertEqual(plan['uploads'], [])
        self.assertEqual(plan['invalidation']['Paths']['Quantity'], 0)

    def test_new_release_updates_only_changed_shell_and_keeps_assets_cached(self):
        (self.root / 'index.html').write_text('new release')
        (self.root / 'assets/hashed-new.js').write_text('new asset')
        plan = frontend.plan_changes(self.root, self.first['manifest'], self.live)
        self.assertEqual([x['path'] for x in plan['uploads']], ['assets/hashed-new.js', 'index.html'])
        self.assertEqual(plan['invalidation']['Paths']['Items'], ['/', '/index.html'])

    def test_changed_print_service_worker_and_hero_have_precise_invalidations(self):
        for name in ['print.html', 'service-worker.js', 'images/heroes/one.webp']:
            (self.root / name).write_text('new')
        plan = frontend.plan_changes(self.root, self.first['manifest'], self.live)
        self.assertEqual(plan['invalidation']['Paths']['Items'], ['/images/heroes/*', '/print.html', '/service-worker.js'])

    def test_interrupted_publication_repeats_invalidations_even_if_bytes_uploaded(self):
        plan = frontend.plan_changes(self.root, {}, self.live)
        self.assertEqual(plan['uploads'], [])
        self.assertGreater(plan['invalidation']['Paths']['Quantity'], 0)

    def test_rollback_repairs_partial_failed_upload_even_when_marker_matches_target(self):
        live = copy.deepcopy(self.live)
        live['index.html']['ETag'] = 'partially-uploaded-new-release'
        plan = frontend.plan_changes(self.root, self.first['manifest'], live)
        self.assertEqual([x['path'] for x in plan['uploads']], ['index.html'])
        self.assertEqual(plan['invalidation']['Paths']['Items'], ['/', '/index.html'])

    def test_cache_metadata_and_unverifiable_etags_are_repaired(self):
        for change in [{'CacheControl': 'wrong'}, {'ContentType': 'wrong'}, {'ServerSideEncryption': 'aws:kms'}]:
            live = copy.deepcopy(self.live)
            live['index.html'].update(change)
            self.assertEqual([x['path'] for x in frontend.plan_changes(self.root, self.first['manifest'], live)['uploads']], ['index.html'])

    def test_prepare_and_publish_commit_marker_separately_and_keep_html_last(self):
        calls = []
        def aws(args, **kwargs):
            calls.append(args)
            if 'get-object' in args:
                return False
            if 'head-object' in args:
                return {}
            return True
        output = self.root / 'plan.json'
        with patch.object(frontend, 'aws', side_effect=aws):
            frontend.prepare(self.root, 'test-bucket', 'us-west-2', output)
            self.assertFalse(any(frontend.PUBLISHED_KEY in str(a) for a in calls if 'cp' in a))
            uploads = [a for a in calls if 'cp' in a]
            self.assertTrue(uploads[-1][2].endswith('index.html'))
            frontend.publish(output, 'test-bucket', 'us-west-2')
        self.assertIn(frontend.PUBLISHED_KEY, calls[-1][3])

    def test_provider_errors_fail_closed_except_missing_marker_or_object(self):
        for code in ['NoSuchKey', '403']:
            with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', f'({code})')):
                self.assertFalse(frontend.aws([], missing_ok=True))
        with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', '(Timeout)')):
            with self.assertRaises(RuntimeError):
                frontend.aws([], missing_ok=True)
        with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '{}', '')):
            self.assertEqual(frontend.aws([], json_output=True), {})

    def test_manifest_type_is_checked_and_cli_routes_to_exact_phase(self):
        with self.assertRaises(ValueError):
            frontend.plan_changes(self.root, {'version': 1, 'files': []})
        for phase in ['prepare', 'publish']:
            with patch.object(frontend, phase) as run:
                frontend.main([phase, '--bucket', 'bucket', '--region', 'us-west-2', '--plan', '/tmp/plan'])
                run.assert_called_once()


class SparseMonitoringTests(unittest.TestCase):
    def test_sparse_filters_keep_every_matching_event_and_compatible_alarms(self):
        count = 0
        for name in ['backend/template.yaml', 'ops/security_notifications_template.yaml']:
            template, errors = decode(str(ROOT / name))
            self.assertFalse(errors)
            resources = template['Resources']
            for item in resources.values():
                if item['Type'] != 'AWS::Logs::MetricFilter':
                    continue
                count += 1
                props = item['Properties']
                self.assertTrue(props['FilterPattern'])
                for metric in props['MetricTransformations']:
                    self.assertEqual(metric['MetricValue'], '1')
                    self.assertNotIn('DefaultValue', metric)
                    for alarm in resources.values():
                        ap = alarm.get('Properties', {})
                        if alarm['Type'] == 'AWS::CloudWatch::Alarm' and ap.get('MetricName') == metric['MetricName']:
                            self.assertEqual(ap['TreatMissingData'], 'notBreaching')
                            self.assertEqual(ap['Statistic'], 'Sum')
                            self.assertEqual(ap['EvaluationPeriods'], 1)
        self.assertEqual(count, 21)
        self.assertIn('TreatMissingData: breaching', (ROOT / 'ops/security_backup_template.yaml').read_text())
        intent = load_release_intent(json.loads((ROOT / 'ops/ci/release_intent.json').read_text()))
        for resource in ['PreviewJobCompletedMetricFilter', 'AuditFailureMetricFilter']:
            self.assertEqual(intent[(resource, 'AWS::Logs::MetricFilter', 'Modify')][0], frozenset({'MetricTransformations'}))

    def test_manifest_advances_after_invalidation_waiter(self):
        script = (ROOT / 'ops/ci/frontend_deploy.sh').read_text()
        self.assertLess(script.index('invalidation-completed'), script.index('frontend_changes.py publish'))
        self.assertIn('if [[ "$path_count" !=', script)
