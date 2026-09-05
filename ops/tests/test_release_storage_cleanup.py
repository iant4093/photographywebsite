import datetime as dt
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from ops.ci import release_storage_cleanup as cleanup


NOW = dt.datetime(2026, 9, 5, tzinfo=dt.timezone.utc)
OLD = (NOW - dt.timedelta(days=200)).isoformat()
SHAS = [str(i) * 40 for i in range(1, 8)]
BUCKET = 'ian-photography-ci-bootstrap-releaseartifactbucket-example'


def version(sha=SHAS[0], suffix='a' * 32, **overrides):
    return {'Key': f'releases/{sha}/123-1/backend/{suffix}', 'VersionId': 'version-one',
            'LastModified': OLD, 'Size': 100, 'IsLatest': True, **overrides}


def good_run(sha):
    return {'head_sha': sha, 'head_branch': 'main', 'conclusion': 'success', 'event': 'push',
            'name': 'Release production', 'path': '.github/workflows/release-production.yml',
            'repository': {'full_name': cleanup.REPOSITORY}}


def stack_responses():
    return [
        {'Stacks': [{'StackStatus': 'UPDATE_COMPLETE', 'EnableTerminationProtection': True,
                     'StackId': 'exact-stack', 'LastUpdatedTime': OLD,
                     'Parameters': [{'ParameterKey': 'ReleaseSha', 'ParameterValue': SHAS[0]}]}]},
        {'Summaries': []},
        {'TemplateBody': {'Resources': {'Function': {'Type': 'AWS::Lambda::Function',
          'Properties': {'Code': {'S3Bucket': BUCKET, 'S3Key': version(SHAS[1])['Key'], 'S3ObjectVersion': 'v'}}}}}},
    ]


class ReleaseCleanupTests(unittest.TestCase):
    def test_protects_active_and_rollback_releases_even_when_old(self):
        items = [version(SHAS[0]), version(SHAS[1]), version(SHAS[2])]
        plan, report = cleanup.plan_cleanup(items, [], {SHAS[0], SHAS[1]}, NOW, 180)
        self.assertEqual(plan, [{'Key': items[2]['Key'], 'VersionId': 'version-one', 'Size': 100}])
        self.assertEqual(report['eligibleBytes'], 100)

    def test_recent_or_unknown_file_protects_the_whole_attempt(self):
        for extra in [version(suffix='packaged.yaml', LastModified=NOW.isoformat()),
                      version(suffix='unreviewed-private-file')]:
            self.assertEqual(cleanup.plan_cleanup([version(), extra], [], set(), NOW, 180)[0], [])
        self.assertEqual(cleanup.plan_cleanup([version(LastModified=(NOW-dt.timedelta(days=180)).isoformat())], [], set(), NOW, 180)[0], [])

    def test_removes_exact_current_noncurrent_and_marker_versions(self):
        items = [version(), version(VersionId='older', IsLatest=False)]
        markers = [version(suffix='packaged.yaml', VersionId='marker')]
        del markers[0]['Size']
        plan, _ = cleanup.plan_cleanup(items, markers, set(), NOW, 180)
        self.assertEqual({v['VersionId'] for v in plan}, {'version-one', 'older', 'marker'})

    def test_bounds_deletion_and_defers_excess_versions(self):
        with patch.object(cleanup, 'MAX_DELETE', 1):
            plan, report = cleanup.plan_cleanup([version(), version(suffix='packaged.yaml')], [], set(), NOW, 180)
        self.assertEqual(len(plan), 1)
        self.assertEqual(report['deferredVersions'], 1)
        with patch.object(cleanup, 'MAX_BYTES', 99):
            self.assertEqual(cleanup.plan_cleanup([version()], [], set(), NOW, 180)[0], [])

    def test_malformed_inventory_and_short_retention_fail_closed(self):
        for changes in [{'VersionId': 'null'}, {'Key': None}, {'Size': -1}, {'Size': True},
                        {'LastModified': '2026-01-01'}, {'LastModified': 'invalid'}]:
            with self.subTest(changes=changes), self.assertRaises(cleanup.CleanupError):
                cleanup.plan_cleanup([version(**changes)], [], set(), NOW, 180)
        with self.assertRaises(cleanup.CleanupError):
            cleanup.plan_cleanup([], [], set(), NOW, 90)

    def test_known_good_metadata_requires_trusted_successes(self):
        runs = [good_run(s) for s in SHAS]
        self.assertEqual(cleanup.successful_releases({'workflow_runs': runs}), set(SHAS[:5]))
        for field, value in [('head_branch', 'feature'), ('conclusion', 'failure'), ('event', 'pull_request'),
                             ('repository', {'full_name': 'another/repo'}), ('head_sha', 'bad')]:
            with self.subTest(field=field), self.assertRaises(cleanup.CleanupError):
                cleanup.successful_releases({'workflow_runs': [{**runs[0], field: value}, runs[1]]})
        for response in [{}, {'workflow_runs': runs[:1]}]:
            with self.assertRaises(cleanup.CleanupError):
                cleanup.successful_releases(response)

    def test_snapshot_protects_all_live_code_references_and_detects_mutation(self):
        responses = stack_responses()
        with patch.object(cleanup, 'aws', side_effect=responses):
            digest, protected = cleanup.stack_snapshot(BUCKET)
        self.assertEqual(protected, {SHAS[0], SHAS[1]})
        responses[0]['Stacks'][0]['LastUpdatedTime'] = NOW.isoformat()
        with patch.object(cleanup, 'aws', side_effect=responses):
            self.assertNotEqual(cleanup.stack_snapshot(BUCKET)[0], digest)
        responses = stack_responses()
        responses[1] = {'Summaries': [{'ExecutionStatus': 'AVAILABLE'}]}
        with patch.object(cleanup, 'aws', side_effect=responses), self.assertRaises(cleanup.CleanupError):
            cleanup.stack_snapshot(BUCKET)

    def test_snapshot_refuses_unstable_or_unresolved_templates(self):
        for status in ['UPDATE_IN_PROGRESS', 'UPDATE_ROLLBACK_FAILED']:
            responses = stack_responses(); responses[0]['Stacks'][0]['StackStatus'] = status
            with patch.object(cleanup, 'aws', side_effect=responses), self.assertRaises(cleanup.CleanupError):
                cleanup.stack_snapshot(BUCKET)
        for code in [{'S3Bucket': {'Ref': 'Bucket'}, 'S3Key': 'unknown'}, {'S3Bucket': BUCKET, 'S3Key': 'unknown'}]:
            responses = stack_responses();responses[2]['TemplateBody']['Resources']['Function']['Properties']['Code'] = code
            with patch.object(cleanup, 'aws', side_effect=responses), self.assertRaises(cleanup.CleanupError):
                cleanup.stack_snapshot(BUCKET)

    def test_inventory_paginates_and_rejects_incomplete_repeated_pages(self):
        first = {'Versions': [version()], 'IsTruncated': True, 'NextKeyMarker': 'key', 'NextVersionIdMarker': 'ver'}
        last = {'DeleteMarkers': [version(suffix='packaged.yaml')], 'IsTruncated': False}
        with patch.object(cleanup, 'aws', side_effect=[first, last]) as aws:
            versions, markers = cleanup.inventory(BUCKET, '123456789012')
        self.assertEqual((len(versions), len(markers)), (1, 1))
        self.assertIn('--version-id-marker', aws.call_args.args)
        for pages in [[first, first], [{}]]:
            with patch.object(cleanup, 'aws', side_effect=pages), self.assertRaises(cleanup.CleanupError):
                cleanup.inventory(BUCKET, '123456789012')

    def test_apply_checks_stack_before_every_batch_and_never_deletes_without_versions(self):
        plan = [version(VersionId=str(i)) for i in range(101)]
        def response(*args):
            batch = json.loads(args[-1])['Objects']
            self.assertTrue(all(set(v) == {'Key', 'VersionId'} for v in batch))
            return {'Deleted': batch}
        with patch.object(cleanup, 'stack_snapshot', side_effect=[('same', set()), ('changed', set())]), patch.object(cleanup, 'aws', side_effect=response) as aws:
            with self.assertRaises(cleanup.CleanupError):
                cleanup.apply_plan(BUCKET, '123456789012', plan, 'same')
        self.assertEqual(aws.call_count, 1)
        with patch.object(cleanup, 'stack_snapshot', return_value=('same', set())), patch.object(cleanup, 'aws', side_effect=response):
            self.assertEqual(cleanup.apply_plan(BUCKET, '123456789012', plan[:1], 'same'), 1)
        with patch.object(cleanup, 'stack_snapshot', return_value=('same', set())), patch.object(cleanup, 'aws', return_value={'Errors': [{'Message': 'private'}]}), self.assertRaises(cleanup.CleanupError):
            cleanup.apply_plan(BUCKET, '123456789012', plan[:1], 'same')

    def test_run_defaults_to_dry_run_and_never_calls_apply(self):
        responses = [
            {'Account': '123456789012'},
            {'Stacks': [{'StackStatus': 'UPDATE_COMPLETE', 'EnableTerminationProtection': True,
                         'Outputs': [{'OutputKey': 'ReleaseArtifactBucketName', 'OutputValue': BUCKET}],
                         'Parameters': [{'ParameterKey': 'ReleaseArtifactNoncurrentRetentionDays', 'ParameterValue': '180'}]}]},
            {'Status': 'Enabled'},
        ]
        with patch.object(cleanup, 'aws', side_effect=responses), patch.object(cleanup, 'github_releases', return_value={'workflow_runs': [good_run(s) for s in SHAS[:5]]}), patch.object(cleanup, 'stack_snapshot', return_value=('snapshot', {SHAS[0]})), patch.object(cleanup, 'inventory', return_value=([version(SHAS[6], LastModified=(dt.datetime.now(dt.timezone.utc)-dt.timedelta(days=200)).isoformat())], [])), patch.object(cleanup, 'apply_plan') as apply:
            report = cleanup.run(account='123456789012')
        apply.assert_not_called()
        self.assertEqual(report['mode'], 'dry-run')
        self.assertEqual(report['eligibleVersions'], 1)
        self.assertEqual(report['deletedVersions'], 0)

    def test_workflow_and_role_preserve_production_boundaries(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root/'.github/workflows/release-production.yml').read_text()
        self.assertIn('group: iantruongphotography-production', workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertIn('refs/heads/main', workflow)
        self.assertIn('    needs: frontend-deploy', workflow.split('  release-storage-cleanup:\n')[1])
        template = (root/'ops/ci_bootstrap_template.yaml').read_text()
        role = template.split('  ReleaseStorageCleanupRole:\n')[1].split('  PlanRole:\n')[0]
        self.assertIn('Action: s3:DeleteObjectVersion', role)
        for forbidden in ['s3:PutObject', 's3:DeleteBucket', 'kms:Decrypt', 'secretsmanager:', 'cloudformation:UpdateStack']:
            self.assertNotIn(forbidden, role)
        self.assertIn("${ReleaseArtifactBucket.Arn}/releases/*", role)
        self.assertIn('ref:refs/heads/${DefaultBranch}', role)


if __name__ == '__main__':
    unittest.main()
