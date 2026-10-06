import datetime as dt,unittest
from unittest.mock import Mock,patch
from ops.ci import performance_report


class PerformanceReportTests(unittest.TestCase):
    def test_window_is_bounded_and_timezones_are_preserved(self):
        now=dt.datetime(2026,10,6,tzinfo=dt.timezone.utc)
        first,last=performance_report.window(24,now)
        self.assertEqual(last-first,dt.timedelta(days=1));self.assertIs(last,now)
        for value in [True,0,169,1.5]:
            with self.assertRaises(ValueError):performance_report.window(value,now)

    def test_empty_or_zero_samples_are_unavailable_and_complete_rows_are_aggregates(self):
        client=Mock();client.get_query_results.return_value={'status':'Complete','results':[],'statistics':{'bytesScanned':100}}
        self.assertTrue(performance_report.wait_result(client,'query')['noSamples'])
        client.get_query_results.return_value={'status':'Complete','results':[[{'field':'jobs','value':'0'}]]}
        self.assertTrue(performance_report.wait_result(client,'query')['noSamples'])
        client.get_query_results.return_value={'status':'Complete','results':[[{'field':'requests','value':'3'},{'field':'responseP95Ms','value':'12'}]]}
        self.assertFalse(performance_report.wait_result(client,'query')['noSamples'])

    def test_failed_and_timed_out_queries_do_not_become_zero_latency(self):
        client=Mock();client.get_query_results.return_value={'status':'Failed'}
        with self.assertRaises(ValueError):performance_report.wait_result(client,'query')
        client.get_query_results.return_value={'status':'Running'}
        with patch.object(performance_report.time,'monotonic',side_effect=[0,2]):
            with self.assertRaises(TimeoutError):performance_report.wait_result(client,'query',timeout=1)
        client.stop_query.assert_called_once_with(queryId='query')
        client.get_query_results.side_effect=[{'status':'Scheduled'},{'status':'Complete','results':[]}]
        with patch.object(performance_report.time,'sleep') as sleep:
            self.assertTrue(performance_report.wait_result(client,'query')['noSamples']);sleep.assert_called_once_with(1)

    def test_query_output_never_requests_raw_records_and_main_resolves_only_owned_groups(self):
        import io
        from contextlib import redirect_stdout
        for _,query in performance_report.QUERIES.values():
            self.assertIn('stats ',query);self.assertNotIn('display @message',query)
        cf=Mock();cf.describe_stacks.return_value={'Stacks':[{'StackId':'arn:aws:cloudformation:us-west-2:123456789012:stack/ian-website/id'}]}
        cf.get_paginator.return_value.paginate.return_value=[{'StackResourceSummaries':[{'LogicalResourceId':n,'PhysicalResourceId':'owned-'+n} for n in ['ApplicationLogGroup','ApiAccessLogGroup']]}]
        logs=Mock();logs.start_query.return_value={'queryId':'query'};logs.get_query_results.return_value={'status':'Complete','results':[]}
        with patch('boto3.client',side_effect=lambda name,**kw:{'cloudformation':cf,'logs':logs}[name]):
            with self.assertRaises(ValueError):performance_report.main(['--expected-account-id','different'])
            logs.start_query.assert_not_called()
            with redirect_stdout(io.StringIO()) as output:performance_report.main(['--expected-account-id','123456789012','--hours','24'])
        import json
        self.assertEqual(set(json.loads(output.getvalue())['reports']),set(performance_report.QUERIES))
        self.assertEqual(logs.start_query.call_count,3)
        self.assertTrue(all(c.kwargs['logGroupName'].startswith('owned-') for c in logs.start_query.call_args_list))
