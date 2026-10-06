import json
import unittest
from unittest.mock import patch
import test_support  # noqa: F401
import performance_observation as observation


class PerformanceObservationTests(unittest.TestCase):
    def setUp(self):
        observation._cold_start = True

    def test_response_identity_payload_privacy_and_cold_marker(self):
        response = {'statusCode': 200, 'body': 'private response'}
        @observation.measure_handler('catalog')
        def handler(event, context):
            with observation.measure_stage('database'):
                self.assertEqual(event['token'], 'private-token')
            return response
        with patch.object(observation.logger, 'info') as log:
            self.assertIs(handler({'token': 'private-token'}, None), response)
            self.assertIs(handler({'token': 'private-token'}, None), response)
        records = [json.loads(call.args[0]) for call in log.call_args_list]
        self.assertEqual([r['coldStart'] for r in records], [True, False])
        self.assertEqual(records[0]['statusCode'], 200)
        self.assertGreaterEqual(records[0]['stagesMs']['database'], 0)
        self.assertNotIn('private', str(records))
        self.assertIsNone(observation._stages.get())

    def test_worker_acknowledgements_and_original_exceptions_survive_logging_failure(self):
        response = {'batchItemFailures': [{'itemIdentifier': 'retry'}]}
        @observation.measure_handler('worker')
        def handler(event, context):
            if event:
                raise event
            return response
        error = RuntimeError('secret provider details')
        with patch.object(observation.logger, 'info', side_effect=RuntimeError('logger failed')):
            self.assertIs(handler(None, None), response)
            with self.assertRaises(RuntimeError) as raised:
                handler(error, None)
        self.assertIs(raised.exception, error)
        self.assertIsNone(observation._stages.get())

    def test_exception_record_contains_no_exception_details(self):
        @observation.measure_handler('worker')
        def handler(event, context):
            with observation.measure_stage('read'):
                raise ValueError('private album path')
        with patch.object(observation.logger, 'info') as log:
            with self.assertRaises(ValueError):handler({}, None)
        record = json.loads(log.call_args.args[0])
        self.assertFalse(record['returned'])
        self.assertNotIn('private', str(record))
        self.assertNotIn('statusCode', record)
        self.assertIn('read', record['stagesMs'])

    def test_undecorated_stage_is_inert_and_nested_handler_restores_parent(self):
        with observation.measure_stage('outside'):pass
        @observation.measure_handler('inner')
        def inner(event, context):
            with observation.measure_stage('inner-read'):pass
            return {'statusCode': 'untrusted'}
        @observation.measure_handler('outer')
        def outer(event, context):
            with observation.measure_stage('outer-read'):inner({}, None)
            with observation.measure_stage('outer-read'):pass
            return None
        with patch.object(observation.logger, 'info') as log:outer({}, None)
        records = [json.loads(call.args[0]) for call in log.call_args_list]
        self.assertEqual(set(records[0]['stagesMs']), {'inner-read'})
        self.assertEqual(set(records[1]['stagesMs']), {'outer-read'})
        self.assertNotIn('statusCode', records[0])
        self.assertIsNone(observation._stages.get())
