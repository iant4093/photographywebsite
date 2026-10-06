"""The routing cutover adds isolation without deleting or replacing an endpoint."""
import json
from pathlib import Path
import unittest

from cfnlint.decode import decode

ROOT = Path(__file__).resolve().parents[2]
PRODUCERS = {'VideoUpgradeFunction', 'GoogleDriveBackupFunction', 'CreateAlbumFunction', 'UpdateAlbumFunction',
             'DeleteAlbumFunction', 'AddImagesFunction', 'DeleteImagesFunction', 'TagMediaObjectFunction',
             'UpdateImageFunction', 'DeleteUserFunction', 'EditUserFunction'}


class AlbumWorkInfrastructureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template, errors = decode(str(ROOT / 'backend/template.yaml'))
        if errors: raise AssertionError(errors)
        cls.resources = cls.template['Resources']

    def test_cutover_defaults_to_legacy_and_parameter_preservation_is_explicit(self):
        parameter = self.template['Parameters']['AlbumWorkRouting']
        self.assertEqual(parameter['Default'], 'legacy'); self.assertEqual(parameter['AllowedValues'], ['legacy', 'separated'])
        self.assertEqual(self.template['Conditions']['SeparateAlbumWork'], {'Fn::Equals': [{'Ref': 'AlbumWorkRouting'}, 'separated']})
        additions = json.loads((ROOT / 'ops/ci/release_parameter_additions.json').read_text())
        self.assertEqual(additions['additions']['AlbumWorkRouting'], 'legacy')
        wired = set()
        for name, resource in self.resources.items():
            env = resource.get('Properties', {}).get('Environment', {}).get('Variables', {})
            if 'ALBUM_WORK_QUEUE_URL' in env:
                wired.add(name)
                self.assertEqual(env['ALBUM_WORK_QUEUE_URL'], {'Fn::If': ['SeparateAlbumWork', {'Ref': 'AlbumWorkQueue'}, {'Ref': 'CacheInvalidationQueue'}]})
                self.assertEqual(env['CACHE_INVALIDATION_QUEUE_URL'], {'Ref': 'CacheInvalidationQueue'})
        self.assertEqual(wired, PRODUCERS)

    def test_dedicated_consumer_has_exact_target_adapters_and_no_cloudfront_permissions(self):
        old = self.resources['CacheInvalidationWorkerFunction']['Properties']
        new = self.resources['AlbumWorkWorkerFunction']['Properties']
        self.assertEqual(new['Handler'], 'album_work_worker.handler')
        self.assertEqual(new['Environment'], old['Environment'])
        self.assertEqual(new['Policies'][0], old['Policies'][0])
        self.assertNotIn('cloudfront:', json.dumps(new['Policies']))
        self.assertEqual(new['ReservedConcurrentExecutions'], 2); self.assertEqual(new['Timeout'], 30)
        self.assertEqual(new['RecursiveLoop'], 'Allow')
        event = new['Events']['AlbumWorkRequests']['Properties']
        self.assertEqual(event, {'Queue': {'Fn::GetAtt': ['AlbumWorkQueue', 'Arn']}, 'BatchSize': 4,
                                'FunctionResponseTypes': ['ReportBatchItemFailures'], 'MaximumBatchingWindowInSeconds': 0,
                                'ScalingConfig': {'MaximumConcurrency': 2}})
        self.assertEqual(old['Events']['CacheInvalidationRequests']['Properties']['Queue'], {'Fn::GetAtt': ['CacheInvalidationQueue', 'Arn']})
        self.assertNotIn('FilterCriteria', json.dumps(old['Events']))
        self.assertNotIn('FilterCriteria', json.dumps(new['Events']))

    def test_each_selected_producer_can_send_only_to_exact_selected_work_resources(self):
        for function in PRODUCERS:
            statements = [st for policy in self.resources[function]['Properties']['Policies']
                          if isinstance(policy, dict) for st in policy.get('Statement', [])
                          if 'sqs:SendMessage' in ([st['Action']] if isinstance(st.get('Action'), str) else st.get('Action', []))]
            grants = []
            for statement in statements:
                resource = statement['Resource']; grants.extend(resource if isinstance(resource, list) else [resource])
            self.assertIn({'Fn::GetAtt': ['AlbumWorkQueue', 'Arn']}, grants, function)
            self.assertIn({'Fn::GetAtt': ['CacheInvalidationQueue', 'Arn']}, grants, function)
            self.assertNotIn('*', grants)

    def test_queue_retention_redrive_visibility_and_failure_alarm_ownership(self):
        for name in ('AlbumWorkQueue', 'AlbumWorkDeadLetterQueue'):
            resource = self.resources[name]; properties = resource['Properties']
            self.assertEqual(resource['DeletionPolicy'], 'Retain'); self.assertEqual(resource['UpdateReplacePolicy'], 'Retain')
            self.assertTrue(properties['SqsManagedSseEnabled'])
        work = self.resources['AlbumWorkQueue']['Properties']
        self.assertEqual(work['VisibilityTimeout'], 6 * 30)
        self.assertEqual(work['MessageRetentionPeriod'], 86400)
        self.assertEqual(work['RedrivePolicy'], {'deadLetterTargetArn': {'Fn::GetAtt': ['AlbumWorkDeadLetterQueue', 'Arn']}, 'maxReceiveCount': 5})
        self.assertEqual(self.resources['AlbumWorkDeadLetterQueue']['Properties']['MessageRetentionPeriod'], 1209600)
        self.assertEqual(self.resources['CacheInvalidationQueue']['Properties']['VisibilityTimeout'], 6 * 30 + 10)
        registry = json.loads((ROOT / 'ops/alarm_registry.json').read_text())
        registered = {name for group in registry['groups'] for name in group['logicalResourceIds']}
        for alarm in ('AlbumWorkDeadLetterQueueAlarm', 'AlbumWorkQueueAgeAlarm'):
            self.assertIn(alarm, registered)
            self.assertEqual(self.resources[alarm]['Properties']['AlarmActions'], self.resources['AsyncFailureQueueAlarm']['Properties']['AlarmActions'])

    def test_new_release_rules_allow_only_exact_adds_and_queue_timeout_change(self):
        from ops.ci import release_guard
        intent = json.loads((ROOT / 'ops/ci/release_intent.json').read_text())
        added = [('AlbumWorkQueue', 'AWS::SQS::Queue'), ('AlbumWorkDeadLetterQueue', 'AWS::SQS::Queue'),
                 ('AlbumWorkWorkerFunction', 'AWS::Lambda::Function'), ('AlbumWorkWorkerFunctionRole', 'AWS::IAM::Role'),
                 ('AlbumWorkWorkerFunctionAlbumWorkRequests', 'AWS::Lambda::EventSourceMapping'),
                 ('AlbumWorkDeadLetterQueueAlarm', 'AWS::CloudWatch::Alarm'), ('AlbumWorkQueueAgeAlarm', 'AWS::CloudWatch::Alarm')]
        for name, kind in added:
            rules = [r for r in intent['rules'] if r['logicalId'] == name and r['action'] == 'Add']
            self.assertEqual(rules, [{'logicalId': name, 'resourceType': kind, 'action': 'Add', 'propertyPaths': [], 'allowNoDetails': True}])
        change = next(r for r in intent['rules'] if r['logicalId'] == 'CacheInvalidationQueue' and r['action'] == 'Modify')
        self.assertEqual(change['propertyPaths'], ['VisibilityTimeout', 'Tags']); self.assertFalse(change['allowNoDetails'])
        self.assertTrue(callable(release_guard.gate_change_set))

    def test_notification_topic_accepts_only_the_two_exact_new_alarm_names(self):
        template, errors = decode(str(ROOT / 'ops/security_notifications_template.yaml'))
        self.assertFalse(errors)
        source = json.dumps(template)
        for alarm in ('AlbumWorkDeadLetterQueueAlarm', 'AlbumWorkQueueAgeAlarm'):
            self.assertIn('alarm:ian-website-' + alarm + '-*', source)
        self.assertNotIn('alarm:ian-website-*', source)

    def test_parameter_guard_rejects_automatic_cutover_and_preserves_existing_routing(self):
        from ops.ci import release_guard
        safe = release_guard.load_parameter_additions(json.loads((ROOT / 'ops/ci/release_parameter_additions.json').read_text()))
        for bad in ({**safe, 'AlbumWorkRouting': 'separated'}, {**safe, 'Unexpected': 'value'}, {'AlbumWorkRouting': 'legacy'}):
            with self.assertRaises(release_guard.GateError): release_guard.load_parameter_additions({'version': 1, 'additions': bad})
        payload = release_guard.previous_parameter_payload({'Parameters': [{'ParameterKey': 'AlbumWorkRouting', 'ParameterValue': 'separated'}]}, parameter_additions=safe)
        self.assertIn({'ParameterKey': 'AlbumWorkRouting', 'UsePreviousValue': True}, payload)

    def test_existing_queue_visibility_dependency_preserves_its_mapping(self):
        import copy
        from ops.ci import release_guard as guard
        intent = guard.load_release_intent(json.loads((ROOT / 'ops/ci/release_intent.json').read_text()))
        dependencies = guard.load_release_dependencies(json.loads((ROOT / 'ops/ci/release_dependencies.json').read_text()))
        mapping = {'ResourceChange': {'Action': 'Modify', 'LogicalResourceId': 'CacheInvalidationWorkerFunctionCacheInvalidationRequests',
            'ResourceType': 'AWS::Lambda::EventSourceMapping', 'Replacement': 'Conditional', 'Details': [
                {'Target': {'Attribute': 'Properties', 'Name': 'EventSourceArn', 'RequiresRecreation': 'Always'},
                 'Evaluation': 'Dynamic', 'ChangeSource': 'ResourceAttribute', 'CausingEntity': 'CacheInvalidationQueue.Arn'}]}}
        queue = {'ResourceChange': {'Action': 'Modify', 'LogicalResourceId': 'CacheInvalidationQueue', 'ResourceType': 'AWS::SQS::Queue',
            'Replacement': 'False', 'Details': [{'Target': {'Attribute': 'Properties', 'Name': 'VisibilityTimeout', 'RequiresRecreation': 'Never'},
                'Evaluation': 'Static', 'ChangeSource': 'DirectModification'}]}}
        self.assertEqual(guard.gate_change_set([{'Changes': [queue, mapping]}], release_intent=intent, release_dependencies=dependencies),
                         {'Add': 0, 'Modify': 2, 'Total': 2})
        for field, value in [('Evaluation', 'Static'), ('ChangeSource', 'DirectModification'), ('CausingEntity', 'OtherQueue.Arn'), ('CausingEntity', 'CacheInvalidationQueue.QueueName')]:
            bad = copy.deepcopy(mapping); bad['ResourceChange']['Details'][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(guard.GateError):
                guard.gate_change_set([{'Changes': [bad]}], release_intent=intent, release_dependencies=dependencies)
        for replacement in ('True', 'unknown'):
            bad = copy.deepcopy(mapping); bad['ResourceChange']['Replacement'] = replacement
            with self.assertRaises(guard.GateError): guard.gate_change_set([{'Changes': [bad]}], release_intent=intent, release_dependencies=dependencies)
        bad = copy.deepcopy(queue); bad['ResourceChange']['Details'][0]['Target']['Name'] = 'QueueName'
        with self.assertRaises(guard.GateError): guard.gate_change_set([{'Changes': [bad, mapping]}], release_intent=intent, release_dependencies=dependencies)
