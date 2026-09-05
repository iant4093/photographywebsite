"""Exercise the deployed daily auditor against live-policy response shapes."""
import json
from pathlib import Path
import textwrap
import types
import unittest
from unittest.mock import Mock, patch


def load_audit():
    template = (Path(__file__).resolve().parents[1] / 'security_managed_services_template.yaml').read_text()
    block = template.split('  LambdaPermissionsAuditFunction:\n', 1)[1].split('  LambdaPermissionsAuditPermission:\n', 1)[0]
    code = textwrap.dedent(block.split('        ZipFile: |\n', 1)[1])
    module = types.ModuleType('daily_lambda_audit')
    exec(compile(code, '<daily-lambda-audit>', 'exec'), module.__dict__)
    return module


class DailyLambdaAuditTests(unittest.TestCase):
    def setUp(self):
        self.audit = load_audit()

    def policy(self, principal, condition=None, **extra):
        return {'Statement': [{'Effect': 'Allow', 'Principal': principal, 'Condition': condition or {}, **extra}]}

    def test_rejects_public_variable_and_unbounded_s3_grants(self):
        for principal in ('*', {'AWS': '*'}, {'AWS': ['123456789012', '*']}, {'AWS': '${aws:PrincipalArn}'}, {}, {'Service': []}):
            with self.subTest(principal=principal):
                self.assertFalse(self.audit.policy_safe(self.policy(principal)))
        self.assertFalse(self.audit.policy_safe(self.policy({'Service': 's3.amazonaws.com'})))
        self.assertFalse(self.audit.policy_safe(self.policy({'Service': 's3.amazonaws.com'}, {'ArnLike': {'AWS:SourceArn': 'arn:aws:s3:::*'}})))
        self.assertFalse(self.audit.policy_safe(self.policy({'AWS': '123456789012'}, NotPrincipal='*')))

    def test_accepts_fixed_principals_and_bounded_s3(self):
        cases = [
            self.policy({'AWS': '123456789012'}),
            self.policy({'Service': 'apigateway.amazonaws.com'}),
            self.policy({'Service': 's3.amazonaws.com'}, {'StringEquals': {'AWS:SourceAccount': '123456789012'}}),
            self.policy({'Service': 's3.amazonaws.com'}, {'ArnLike': {'AWS:SourceArn': 'arn:aws:s3:::private-bucket'}}),
            {'Statement': [{'Effect': 'Deny', 'Principal': '*'}]},
        ]
        for policy in cases:
            self.assertTrue(self.audit.policy_safe(policy))
        self.assertFalse(self.audit.policy_safe({}))
        self.assertTrue(self.audit.policy_safe({'Statement': self.policy('123456789012')['Statement'][0]}))

    def client(self):
        client = Mock()
        client.exceptions.ResourceNotFoundException = type('NoPolicy', (Exception,), {})
        pages = {
            'list_functions': [{'Functions': [{'FunctionName': 'example'}]}],
            'list_aliases': [{'Aliases': [{'Name': 'live'}]}],
            'list_versions_by_function': [{'Versions': [{'Version': '$LATEST'}, {'Version': '2'}]}],
        }
        client.get_paginator.side_effect = lambda operation: Mock(paginate=Mock(return_value=pages[operation]))
        return client

    def test_alias_and_version_policies_are_checked_and_absence_is_safe(self):
        client = self.client()
        def get_policy(**args):
            if not args.get('Qualifier'):
                raise client.exceptions.ResourceNotFoundException()
            return {'Policy': json.dumps(self.policy('*' if args['Qualifier'] == 'live' else '123456789012'))}
        client.get_policy.side_effect = get_policy
        result = self.audit.inventory(client)
        self.assertEqual(result, {'functions': 1, 'policies': 2, 'unsafe': 1, 'errors': 0})
        self.assertEqual({c.kwargs.get('Qualifier') for c in client.get_policy.call_args_list}, {None, '2', 'live'})

    def test_access_denial_and_malformed_policies_never_look_compliant(self):
        for failure in (PermissionError('sensitive provider message'), {'Policy': 'broken-json'}):
            client = self.client()
            if isinstance(failure, Exception):
                client.get_policy.side_effect = failure
            else:
                client.get_policy.return_value = failure
            self.assertEqual(self.audit.inventory(client)['errors'], 1)

    def test_daily_result_is_account_scoped_and_dry_run_does_not_write(self):
        client = self.client()
        config = Mock()
        config.put_evaluations.return_value = {}
        client.get_policy.return_value = {'Policy': json.dumps(self.policy('123456789012'))}
        with patch.object(self.audit.boto3, 'client', side_effect=lambda service: client if service == 'lambda' else config), patch.dict(self.audit.os.environ, {'ACCOUNT_ID': '123456789012'}), patch('builtins.print'):
            self.assertEqual(self.audit.handler({'dryRun': True}, None)['compliance'], 'COMPLIANT')
            config.put_evaluations.assert_not_called()
            self.audit.handler({'resultToken': 'opaque'}, None)
        args = config.put_evaluations.call_args.kwargs
        self.assertEqual(args['ResultToken'], 'opaque')
        self.assertEqual(len(args['Evaluations']), 1)
        self.assertEqual(args['Evaluations'][0]['ComplianceResourceType'], 'AWS::::Account')
        self.assertNotIn('example', args['Evaluations'][0]['Annotation'])

    def test_failed_inventory_reports_noncompliance_and_put_failure_raises(self):
        config = Mock()
        config.put_evaluations.return_value = {'FailedEvaluations': [{}]}
        with patch.object(self.audit, 'inventory', return_value={'functions': 0, 'policies': 0, 'unsafe': 0, 'errors': 1}), patch.object(self.audit.boto3, 'client', return_value=config), patch.dict(self.audit.os.environ, {'ACCOUNT_ID': '123456789012'}):
            with self.assertRaises(RuntimeError):
                self.audit.handler({'resultToken': 'opaque'}, None)
        self.assertEqual(config.put_evaluations.call_args.kwargs['Evaluations'][0]['ComplianceType'], 'NON_COMPLIANT')
