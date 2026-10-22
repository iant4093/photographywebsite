"""Release optimizations preserve ordering, exact versions and failure gates."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import boto3
from botocore.exceptions import ClientError
from moto import mock_aws

from ops.ci import aws_requests, backend_scope, bind_s3_versions, frontend_changes

ROOT = Path(__file__).resolve().parents[2]
A, B = "a" * 40, "b" * 40


def stable_stack():
    return {"StackStatus": "UPDATE_COMPLETE", "EnableTerminationProtection": True,
            "Parameters": [{"ParameterKey": "ReleaseSha", "ParameterValue": A}],
            "Outputs": [{"OutputKey": k, "OutputValue": v} for k, v in {
                "AlbumIndexDeploymentPhase": "both", "PrivateMediaCloudFrontDenyEnforced": "true",
                "FrontDoorEnforcementEnabled": "true", "ExecuteApiEndpointDisabled": "true"}.items()]}


class ParallelRequestsTests(unittest.TestCase):
    def test_requests_overlap_with_a_fixed_bound_and_preserve_order(self):
        barrier = threading.Barrier(aws_requests.MAX_WORKERS, timeout=5)
        active, peak = 0, 0
        lock = threading.Lock()

        def task(i):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            barrier.wait()
            with lock:
                active -= 1
            return i * 2

        self.assertEqual(aws_requests.parallel_map(task, range(16)), list(range(0, 32, 2)))
        self.assertEqual(peak, aws_requests.MAX_WORKERS)
        with self.assertRaisesRegex(RuntimeError, "failed"):
            aws_requests.parallel_map(lambda _: (_ for _ in ()).throw(RuntimeError("failed")), [1])
        self.assertEqual(aws_requests.parallel_map(task, []), [])

    def test_sdk_has_bounded_retries_timeouts_and_pool(self):
        with patch.object(boto3, "client") as create:
            aws_requests.client("s3", "us-west-2")
        config = create.call_args.kwargs["config"]
        self.assertEqual(config.max_pool_connections, aws_requests.MAX_WORKERS)
        self.assertEqual(config.retries["total_max_attempts"], 4)
        self.assertLessEqual(config.connect_timeout, 10)
        self.assertLessEqual(config.read_timeout, 60)
        self.assertIn((ROOT / "ops/ci/requirements-aws.txt").read_text().splitlines()[-1],
                      (ROOT / "backend/requirements.txt").read_text())


class FrontendPublicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ["assets/new.js", "assets/style.css", "data.unknownextension", "print.html", "index.html"]:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name)
        self.plan = self.root.parent / (self.root.name + "-plan.json")
        self.addCleanup(lambda: self.plan.unlink(missing_ok=True))
        self.addCleanup(lambda: self.plan.with_suffix('.invalidation.json').unlink(missing_ok=True))

    @mock_aws
    def test_real_sdk_redeploy_is_empty_and_marker_commits_only_after_publish(self):
        storage = boto3.client("s3", region_name="us-east-1")
        storage.create_bucket(Bucket="frontend-test")
        with patch.object(frontend_changes, "client", return_value=storage):
            frontend_changes.prepare(self.root, "frontend-test", "us-east-1", self.plan)
            with self.assertRaises(ClientError):
                storage.head_object(Bucket="frontend-test", Key=frontend_changes.PUBLISHED_KEY)
            response = storage.get_object(Bucket="frontend-test", Key="index.html")
            self.assertEqual(response['Body'].read(), b"index.html")
            self.assertEqual(response['ContentType'], 'text/html; charset=utf-8')
            self.assertEqual(response['CacheControl'], 'no-cache,max-age=0,must-revalidate')
            frontend_changes.publish(self.plan, "frontend-test", "us-east-1")
            frontend_changes.prepare(self.root, "frontend-test", "us-east-1", self.plan)
            plan = json.loads(self.plan.read_text())
            self.assertEqual(plan['uploads'], [])
            self.assertEqual(plan['invalidation']['Paths']['Quantity'], 0)

    def storage(self):
        storage = Mock()
        storage.get_object.side_effect = ClientError({'Error': {'Code': 'NoSuchKey'}}, 'GetObject')
        storage.head_object.side_effect = ClientError({'Error': {'Code': '404'}}, 'HeadObject')
        return storage

    def test_asset_failure_prevents_both_entrypoints_and_no_plan_is_committed(self):
        storage = self.storage()
        storage.put_object.side_effect = RuntimeError("request failed")
        with patch.object(frontend_changes, "client", return_value=storage), self.assertRaises(RuntimeError):
            frontend_changes.prepare(self.root, 'bucket', 'us-west-2', self.plan)
        self.assertFalse(self.plan.exists())
        self.assertFalse(any(c.kwargs['Key'].endswith('.html') for c in storage.put_object.call_args_list))

    def test_unexpected_head_failure_never_uploads(self):
        storage = self.storage()
        storage.head_object.side_effect = ClientError({'Error': {'Code': 'SlowDown'}}, 'HeadObject')
        with patch.object(frontend_changes, "client", return_value=storage), self.assertRaises(ClientError):
            frontend_changes.prepare(self.root, 'bucket', 'us-west-2', self.plan)
        storage.put_object.assert_not_called()

    def test_oversized_or_malformed_manifest_fails_closed_and_closes_body(self):
        for content in [b'x' * 2_000_001, b'invalid-json']:
            body = io.BytesIO(content)
            with self.assertRaises(ValueError):
                frontend_changes.previous_manifest(Mock(get_object=Mock(return_value={'Body': body})), 'bucket')
            self.assertTrue(body.closed)


class VersionBindingTests(unittest.TestCase):
    source = 'Resources:\n  One:\n    CodeUri: s3://release-bucket/key-one\n  Two:\n    CodeUri: s3://release-bucket/key-two\n'

    def test_exact_versions_are_resolved_before_binding_and_invalid_sources_never_request(self):
        storage = Mock()
        storage.head_object.side_effect = lambda **kw: {'VersionId': 'version-' + kw['Key']}
        with patch.object(bind_s3_versions, 'client', return_value=storage):
            versions = bind_s3_versions.object_versions(self.source, 'release-bucket', 'us-west-2', 2)
            bound, count = bind_s3_versions.bind_versions(self.source, expected_bucket='release-bucket',
                                                        expected_count=2, resolve_version=versions.__getitem__)
        self.assertEqual(count, 2)
        self.assertIn('Version: "version-key-one"', bound)
        with patch.object(bind_s3_versions, 'client') as create:
            with self.assertRaises(bind_s3_versions.BindingError):
                bind_s3_versions.object_versions(self.source, 'wrong-bucket', 'us-west-2', 2)
            create.assert_not_called()

    def test_binding_failure_does_not_write_template_and_does_not_echo_provider_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory)/'source', Path(directory)/'target'
            source.write_text(self.source)
            storage = Mock()
            storage.head_object.side_effect = RuntimeError('sensitive-provider-payload')
            with patch.object(bind_s3_versions, 'client', return_value=storage), contextlib.redirect_stderr(io.StringIO()) as output:
                result = bind_s3_versions.main([str(source), str(target), '--bucket', 'release-bucket',
                                               '--region', 'us-west-2', '--expected-object-count', '2'])
            self.assertEqual(result, 2)
            self.assertNotIn('sensitive-provider-payload', output.getvalue())
            self.assertFalse(target.exists())
            storage.head_object.side_effect = None
            storage.head_object.return_value = {'VersionId': 'exact-version'}
            with patch.object(bind_s3_versions, 'client', return_value=storage):
                self.assertEqual(bind_s3_versions.main([str(source), str(target), '--bucket', 'release-bucket',
                                                       '--region', 'us-west-2', '--expected-object-count', '2']), 0)
            self.assertIn('Version: "exact-version"', target.read_text())


class BackendScopeTests(unittest.TestCase):
    def test_real_history_includes_unreleased_backend_changes_and_rename_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)

            def git(arguments, **options):
                return subprocess.run(arguments, cwd=folder, **options)

            def command(*args):
                return subprocess.check_output(['git', *args], cwd=folder).decode().strip()

            def commit(message):
                command('add', '.')
                command('-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.test',
                        'commit', '--quiet', '-m', message)
                return command('rev-parse', 'HEAD')

            command('init', '--quiet')
            (folder/'backend').mkdir()
            (folder/'src').mkdir()
            (folder/'backend/handler.py').write_text('original')
            deployed = commit('deployed')
            (folder/'backend/handler.py').write_text('unreleased fix')
            backend = commit('failed backend release')
            (folder/'src/page.jsx').write_text('page')
            frontend = commit('frontend change')
            self.assertTrue(backend_scope.requires_backend(deployed, frontend, git=git))
            self.assertFalse(backend_scope.requires_backend(backend, frontend, git=git))
            (folder/'backend/handler.py').rename(folder/'src/handler.py')
            moved = commit('move backend source into frontend')
            self.assertTrue(backend_scope.requires_backend(frontend, moved, git=git))

    def git(self, paths=b'src/page.jsx\0public/photo.webp\0', *, ancestry=0, diff=0):
        return Mock(side_effect=[subprocess.CompletedProcess([], ancestry, b'', b''),
                                subprocess.CompletedProcess([], diff, paths, b'')])

    def test_only_frontend_paths_skip_and_actual_deployed_revision_is_used(self):
        git = self.git(b'src/page.jsx\0package-lock.json\0index.html\0')
        self.assertFalse(backend_scope.requires_backend(A, B, git=git))
        self.assertEqual(git.call_args.args[0][-3:], [A, B, '--'])
        for path in ['backend/functions/handler.py', 'ops/ci/backend_plan.sh', '.github/workflows/_quality.yml',
                     '.node-version', 'unknown', 'src-backend/handler.py']:
            with self.subTest(path=path):
                self.assertTrue(backend_scope.requires_backend(A, B, git=self.git(path.encode()+b'\0')))
        self.assertFalse(backend_scope.requires_backend(A, B, git=self.git(b'')))

    def test_missing_history_invalid_identity_and_rollback_fail_into_full_release(self):
        for deployed, target in [('unknown', B), (A, 'bad')]:
            self.assertTrue(backend_scope.requires_backend(deployed, target, git=Mock()))
        self.assertTrue(backend_scope.requires_backend(A, B, git=self.git(ancestry=1)))
        self.assertTrue(backend_scope.requires_backend(A, B, git=self.git(diff=1)))

    def test_stable_stack_is_required_even_for_frontend_only_release(self):
        stack = stable_stack()
        with patch.object(backend_scope, 'requires_backend', return_value=False):
            self.assertEqual(backend_scope.scope(stack, B), {'backend_required': False, 'deployed_backend_sha': A})
            for key, value in [('StackStatus', 'UPDATE_IN_PROGRESS'), ('EnableTerminationProtection', False)]:
                with self.assertRaises(ValueError):
                    backend_scope.scope({**stack, key: value}, B)
        with self.assertRaises(ValueError):
            backend_scope.scope(stack, 'invalid')

    def test_cli_outputs_safe_scope_and_masks_provider_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)/'output'
            args = ['--stack', 'website', '--region', 'us-west-2', '--sha', B, '--github-output', str(output)]
            storage = Mock()
            storage.describe_stacks.return_value = {'Stacks': [stable_stack()]}
            with patch.object(backend_scope, 'client', return_value=storage), patch.object(backend_scope, 'requires_backend', return_value=False):
                self.assertEqual(backend_scope.main(args), 0)
            self.assertIn('backend_required=false\n', output.read_text())
            storage.describe_stacks.side_effect = RuntimeError('sensitive')
            with patch.object(backend_scope, 'client', return_value=storage), contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(backend_scope.main(args), 2)
            self.assertNotIn('sensitive', errors.getvalue())

    def test_workflows_require_both_browser_groups_and_install_sdk_for_release_and_rollback(self):
        quality = (ROOT / '.github/workflows/_quality.yml').read_text()
        self.assertIn('journey: [administration, visitors]', quality)
        self.assertIn('      - frontend-browser', quality.split('  quality-gate:')[1])
        self.assertIn('verify-manifest release/frontend/dist release/frontend/manifest.json', quality)
        for workflow in ['release-production.yml', 'manual-release.yml']:
            source = (ROOT / '.github/workflows' / workflow).read_text()
            self.assertEqual(source.count('-r ops/ci/requirements-aws.txt'), 2)


if __name__ == '__main__':
    unittest.main()
