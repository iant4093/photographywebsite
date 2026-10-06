import copy,json,unittest
from pathlib import Path
from cfnlint.decode import decode
from ops import feature_costs
from ops.ci.release_guard import gate_change_set,load_release_intent,GateError

ROOT=Path(__file__).resolve().parents[2]


class FeatureCostTests(unittest.TestCase):
    def setUp(self):
        self.registry=json.loads((ROOT/'ops/feature_costs.json').read_text())

    def test_frontend_plan_is_idempotent_preserves_unrelated_labels_and_refuses_other_owner(self):
        existing=[{'Key':'Application','Value':self.registry['application']},{'Key':'Stage','Value':'prod'},{'Key':'Other','Value':'keep'}]
        before=copy.deepcopy(existing)
        plan=feature_costs.frontend_tag_plan(existing,self.registry)
        self.assertEqual(plan,[{'Key':'Feature','Value':'public-delivery'}])
        self.assertEqual(existing,before)
        self.assertEqual(feature_costs.frontend_tag_plan(existing+plan,self.registry),[])
        self.assertEqual(len(feature_costs.frontend_tag_plan([],self.registry)),2)
        with self.assertRaises(ValueError):feature_costs.frontend_tag_plan([{'Key':'Application','Value':'different'}],self.registry)

    def test_billing_query_is_bounded_to_application_and_keeps_shared_costs_distinct(self):
        r=feature_costs.report_request('2026-10-01','2026-10-06',self.registry)
        self.assertEqual(r['Filter'],{'Tags':{'Key':'Application','Values':[self.registry['application']]}})
        self.assertEqual(r['GroupBy'],[{'Type':'TAG','Key':'Feature'},{'Type':'DIMENSION','Key':'SERVICE'}])
        for start,end in [('2026-10-01','2026-10-01'),('2026-10-06','2026-10-01'),('2026-09-01','2026-10-06')]:
            with self.assertRaises(ValueError):feature_costs.report_request(start,end,self.registry)

    def test_all_functions_and_data_resources_have_explicit_feature_labels_without_retention_changes(self):
        template,errors=decode(str(ROOT/'backend/template.yaml'));self.assertFalse(errors)
        selected={n:r for n,r in template['Resources'].items() if r['Type'] in {'AWS::Serverless::Function','AWS::DynamoDB::Table','AWS::S3::Bucket','AWS::SQS::Queue','AWS::Logs::LogGroup','AWS::CloudFront::Distribution','AWS::Serverless::HttpApi'}}
        self.assertEqual(set(selected),set(self.registry['resources']))
        for name,r in selected.items():
            tags=r['Properties']['Tags'];labels=tags if isinstance(tags,dict) else {t['Key']:t['Value'] for t in tags}
            self.assertEqual(labels['Feature'],self.registry['resources'][name])
            if r['Type'] in {'AWS::DynamoDB::Table','AWS::S3::Bucket'}:
                self.assertIn(r['DeletionPolicy'], {'Retain','RetainExceptOnCreate'});self.assertEqual(r['UpdateReplacePolicy'],'Retain')
        for name in ['AlbumsTable','ImagesBucket','AlbumMediaTable','PreviewMetadataTable','AlbumWorkQueue']:
            self.assertEqual(self.registry['resources'][name],'shared-platform')

    def test_tag_release_scope_cannot_authorize_data_key_or_capacity_changes(self):
        intent=load_release_intent(json.loads((ROOT/'ops/ci/release_intent.json').read_text()))
        def change(name):return {'ResourceChange':{'Action':'Modify','LogicalResourceId':'AlbumsTable','ResourceType':'AWS::DynamoDB::Table','Replacement':'False','Details':[{'Evaluation':'Static','ChangeSource':'DirectModification','Target':{'Attribute':'Properties','Name':name,'RequiresRecreation':'Never'}}]}}
        self.assertEqual(gate_change_set([{'Changes':[change('Tags')]}],release_intent=intent)['Modify'],1)
        for prop in ['KeySchema','BillingMode','DeletionProtectionEnabled','PointInTimeRecoverySpecification']:
            with self.assertRaises(GateError):gate_change_set([{'Changes':[change(prop)]}],release_intent=intent)
        template,errors=decode(str(ROOT/'backend/template.yaml'));self.assertFalse(errors)
        format=template['Resources']['Api']['Properties']['AccessLogSettings']['Format']
        self.assertIn('$context.integrationLatency',format);self.assertIn('$context.responseLatency',format)
        self.assertNotIn('$context.path',format)

    def test_cli_dry_run_and_account_guard_do_not_write_provider_state(self):
        from unittest.mock import Mock,patch
        from contextlib import redirect_stdout
        import io
        identity=Mock();identity.get_caller_identity.return_value={'Account':'123456789012','Arn':'arn:aws:iam::123456789012:role/test'}
        billing=Mock();billing.update_cost_allocation_tags_status.return_value={};billing.list_cost_allocation_tags.return_value={'CostAllocationTags':[{'TagKey':'Application','Status':'Inactive'},{'TagKey':'Stage','Status':'Active'}]}
        edge=Mock();edge.list_tags_for_resource.return_value={'Tags':{'Items':[]}}
        clients={'sts':identity,'ce':billing,'cloudfront':edge}
        with patch('boto3.client',side_effect=lambda name,**kw:clients[name]):
            for command in [['activate'],['tag-frontend','--distribution-id','EXACT'],['report','--start','2026-10-01','--end','2026-10-06']]:
                with redirect_stdout(io.StringIO()):feature_costs.main(command+['--expected-account-id','123456789012'])
            billing.update_cost_allocation_tags_status.assert_not_called();billing.get_cost_and_usage.assert_not_called();edge.tag_resource.assert_not_called()
            with self.assertRaises(ValueError):feature_costs.main(['status','--expected-account-id','different'])
            with redirect_stdout(io.StringIO()) as output:feature_costs.main(['activate','--expected-account-id','123456789012','--apply'])
            self.assertEqual(json.loads(output.getvalue())['pendingRegistration'],['Feature'])
            billing.update_cost_allocation_tags_status.assert_called_once_with(CostAllocationTagsStatus=[{'TagKey':'Application','Status':'Active'}])

    def test_cli_mutations_and_provider_failures_are_explicit(self):
        from unittest.mock import Mock,patch
        from contextlib import redirect_stdout
        import io
        identity=Mock();identity.get_caller_identity.return_value={'Account':'123456789012','Arn':'arn:aws:iam::123456789012:role/test'}
        billing=Mock();billing.list_cost_allocation_tags.return_value={'CostAllocationTags':[{'TagKey':k,'Status':'Active'} for k in ['Application','Stage','Feature']]}
        edge=Mock();edge.list_tags_for_resource.return_value={'Tags':{'Items':[]}}
        clients={'sts':identity,'ce':billing,'cloudfront':edge};account=['--expected-account-id','123456789012']
        with patch('boto3.client',side_effect=lambda name,**kw:clients[name]):
            with redirect_stdout(io.StringIO()) as output:feature_costs.main(['status']+account)
            self.assertEqual(len(json.loads(output.getvalue())['tags']),3)
            with redirect_stdout(io.StringIO()):feature_costs.main(['tag-frontend','--distribution-id','EXACT','--apply']+account)
            self.assertEqual(edge.tag_resource.call_args.kwargs['Resource'],'arn:aws:cloudfront::123456789012:distribution/EXACT')
            for args in [['tag-frontend'],['report']]:
                with self.assertRaises(ValueError):feature_costs.main(args+account)
            billing.get_cost_and_usage.return_value={'ResultsByTime':[]}
            with redirect_stdout(io.StringIO()) as output:feature_costs.main(['report','--start','2026-10-01','--end','2026-10-06','--apply']+account)
            self.assertIn('sharedResourceRule',json.loads(output.getvalue()))
            billing.get_cost_and_usage.return_value={'NextPageToken':'more'}
            with self.assertRaises(ValueError):feature_costs.main(['report','--start','2026-10-01','--end','2026-10-06','--apply']+account)
            billing.list_cost_allocation_tags.return_value={'CostAllocationTags':[{'TagKey':'Feature','Status':'Inactive'}]}
            billing.update_cost_allocation_tags_status.return_value={'Errors':[{'TagKey':'Feature'}]}
            with self.assertRaises(ValueError):feature_costs.main(['activate','--apply']+account)

    def test_frontend_storage_merges_labels_with_expected_owner_and_idempotent_stage(self):
        import io
        from contextlib import redirect_stdout
        from unittest.mock import Mock,patch
        from botocore.exceptions import ClientError
        identity=Mock();identity.get_caller_identity.return_value={'Account':'123456789012','Arn':'arn:aws:iam::123456789012:role/test'}
        storage=Mock();storage.exceptions.ClientError=ClientError;storage.get_bucket_tagging.return_value={'TagSet':[{'Key':'Keep','Value':'yes'}]}
        clients={'sts':identity,'ce':Mock(),'s3':storage};args=['tag-frontend-storage','--bucket-name','reviewed-bucket','--stage','prod','--expected-account-id','123456789012','--apply']
        with patch('boto3.client',side_effect=lambda name,**kw:clients[name]):
            with redirect_stdout(io.StringIO()):feature_costs.main(args)
            kw=storage.put_bucket_tagging.call_args.kwargs
            self.assertEqual(kw['ExpectedBucketOwner'],'123456789012')
            tags={x['Key']:x['Value'] for x in kw['Tagging']['TagSet']};self.assertEqual(tags['Keep'],'yes');self.assertEqual(tags['Stage'],'prod')
            storage.get_bucket_tagging.return_value={'TagSet':kw['Tagging']['TagSet']}
            with redirect_stdout(io.StringIO()):feature_costs.main(args)
            self.assertEqual(storage.put_bucket_tagging.call_count,1)
            with self.assertRaises(ValueError):feature_costs.main(['tag-frontend-storage','--expected-account-id','123456789012'])
            storage.get_bucket_tagging.side_effect=ClientError({'Error':{'Code':'NoSuchTagSet'}},'GetBucketTagging')
            with redirect_stdout(io.StringIO()):feature_costs.main(args)
            storage.get_bucket_tagging.side_effect=ClientError({'Error':{'Code':'AccessDenied'}},'GetBucketTagging')
            with self.assertRaises(ClientError):feature_costs.main(args)
            storage.get_bucket_tagging.side_effect=None;storage.get_bucket_tagging.return_value={'TagSet':[{'Key':'key'+str(i),'Value':'keep'} for i in range(50)]}
            with self.assertRaises(ValueError):feature_costs.main(args)
