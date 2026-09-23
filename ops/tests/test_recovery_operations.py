import hashlib
import json
import unittest
from unittest.mock import Mock
from ops.reconcile_durable_work import describe, fingerprint, repair
from ops.recovery_reconstruction import reconstruct
from ops.sweep_comparison_previews import inspect

ALBUM='11111111-1111-4111-8111-111111111111'


class RecoveryOperationsTests(unittest.TestCase):
    def receipt(self):
        return {'albumId':ALBUM,'status':'deleting','visibility':'private','ownerSub':'owner',
                'pendingAlbumDeletion':{'id':'operation','continuationStartedAt':1,'deletedVersions':7}}

    def test_inventory_is_read_only_and_repair_keeps_scope(self):
        item=self.receipt(); table=Mock(); table.get_item.return_value={'Item':item}; queue=Mock()
        plan=describe(item,90000)[0]
        result=repair(table,queue,'queue',ALBUM,'operation',plan['snapshot'],now=90000)
        self.assertFalse(result['applied']); table.update_item.assert_not_called(); queue.send_message.assert_not_called()
        result=repair(table,queue,'queue',ALBUM,'operation',plan['snapshot'],now=90000,apply=True)
        self.assertTrue(result['applied'])
        saved=table.update_item.call_args.kwargs['ExpressionAttributeValues'][':next']
        self.assertEqual(saved['deletedVersions'],7)
        self.assertEqual(saved['originalContinuationStartedAt'],1)
        self.assertEqual(json.loads(queue.send_message.call_args.kwargs['MessageBody'])['albumId'],ALBUM)
        self.assertIn('ownerSub',table.update_item.call_args.kwargs['ExpressionAttributeNames'].values())

    def test_repair_refuses_changed_scope_live_lease_wrong_operation_and_budget(self):
        for change,operation in [({'mediaLeaseUntil':99999},'operation'), ({},'different'),
             ({'pendingAlbumDeletion':{'id':'operation','continuationStartedAt':1,'repairCount':3}},'operation')]:
            item={**self.receipt(),**change}; table=Mock(); table.get_item.return_value={'Item':item}; queue=Mock()
            with self.assertRaises(ValueError): repair(table,queue,'q',ALBUM,operation,fingerprint(item),now=90000,apply=True)
            queue.send_message.assert_not_called()
        with self.assertRaises(ValueError): repair(table,queue,'q',ALBUM,'operation','stale',now=90000,apply=True)

    def test_account_repair_checks_current_subject_and_protected_groups(self):
        item={'albumId':'__USER_EMAIL_UPDATE__hash','payload':{'id':'op','operation':'op','subject':'subject',
            'username':'user','oldEmail':'old@example.test','newEmail':'new@example.test','phase':'sync','continuationStartedAt':1}}
        table=Mock(); table.get_item.side_effect=lambda **kw: {'Item':item if kw['Key']['albumId']==item['albumId'] else {'emailOperation':'op'}}; queue=Mock(); cognito=Mock()
        cognito.admin_get_user.return_value={'UserAttributes':[{'Name':'sub','Value':'subject'},{'Name':'email','Value':'new@example.test'}]}
        cognito.admin_list_groups_for_user.return_value={'Groups':[{'GroupName':'Admins'}]}
        with self.assertRaises(ValueError): repair(table,queue,'q',item['albumId'],'op',fingerprint(item),cognito=cognito,pool='pool',now=90000,apply=True)
        queue.send_message.assert_not_called()
        cognito.admin_list_groups_for_user.return_value={'Groups':[]}
        self.assertFalse(repair(table,queue,'q',item['albumId'],'op',fingerprint(item),cognito=cognito,pool='pool',now=90000)['applied'])

    def test_completed_identity_deletion_can_finish_without_recreating_the_account(self):
        from botocore.exceptions import ClientError
        item={'albumId':'__USER_DELETION__hash','deletionId':'op','payload':{'id':'op', 'subject':'erased',
            'username':'gone', 'email':'gone@example.test', 'phase':'identity','continuationStartedAt':1}}
        table=Mock(); table.get_item.return_value={'Item':item}; queue=Mock(); cognito=Mock()
        cognito.admin_get_user.side_effect=ClientError({'Error':{'Code':'UserNotFoundException'}},'AdminGetUser')
        result=repair(table,queue,'q',item['albumId'],'op',fingerprint(item),cognito=cognito,pool='pool',now=90000,apply=True)
        self.assertTrue(result['applied']); cognito.admin_create_user.assert_not_called()
        item['payload']['phase']='scan'
        with self.assertRaises(ClientError): repair(table,queue,'q',item['albumId'],'op',fingerprint(item),cognito=cognito,pool='pool',now=90000)

    def test_offline_reconstruction_does_not_resurrect_deleted_media_or_accounts(self):
        raw=f'albums/{ALBUM}/photo.jpg'; media_id=hashlib.sha256(raw.encode()).hexdigest()[:24]
        backup=[{'albumId':ALBUM,'visibility':'public','images':[{'rawKey':raw},{'rawKey':'retained'}],'coverImageUrl':raw,'isShared':True,'shareCode':'old-link'},
            {'albumId':'removed'}, {'albumId':'owned','ownerSub':'erased'}, {'albumId':'legacy','ownerEmail':'legacy@example.test'},
            {'albumId':'busy','pendingMediaDeletion':{'id':'work'}}, {'albumId':'__OLD_JOB__'}]
        receipts=[{'albumId':'__ALBUM_DELETION__removed','payload':{'albumId':'removed'}},
            {'albumId':'__USER_DELETION__hash','deletionId':'delete','payload':{'subject':'erased'}},
            {'albumId':'__MEDIA_DELETION__op','payload':{'albumId':ALBUM,'mediaIds':[media_id]}}]
        result=reconstruct(backup,receipts)
        self.assertEqual(result['suppressedCount'],2); self.assertEqual(len(result['quarantine']),3)
        restored=result['candidates'][0]
        self.assertEqual(restored['images'],[{'rawKey':'retained'}]); self.assertEqual(restored['visibility'],'private')
        self.assertNotIn('coverImageUrl',restored)
        self.assertNotIn('shareCode',restored); self.assertFalse(restored['isShared'])
        self.assertEqual(backup[0]['visibility'],'public')

    def test_orphan_sweep_refuses_live_images_and_unproven_missing_albums(self):
        raw=f'albums/{ALBUM}/photo.jpg'; media_id=hashlib.sha256(raw.encode()).hexdigest()[:24]
        albums=Mock(); comparisons=Mock(); s3=Mock(); comparisons.get_item.return_value={}
        albums.get_item.return_value={'Item':{'albumId':ALBUM,'images':[{'rawKey':raw}]}}
        with self.assertRaisesRegex(ValueError,'live image'): inspect(albums,comparisons,s3,'bucket',ALBUM,media_id,90000)
        albums.get_item.return_value={}
        with self.assertRaisesRegex(ValueError,'deletion receipt'): inspect(albums,comparisons,s3,'bucket',ALBUM,media_id,90000)
        s3.delete_objects.assert_not_called()

    def test_current_pending_deletion_suppresses_media_from_older_clean_backup(self):
        raw = f'albums/{ALBUM}/removed.jpg'
        backup = [{'albumId':ALBUM, 'visibility':'public', 'images':[{'rawKey':raw}, {'rawKey':'retained'}], 'shareCode':'old', 'isShared':True}]
        current = [{'albumId':ALBUM, 'images':[], 'pendingMediaDeletion':{'mediaIds':[hashlib.sha256(raw.encode()).hexdigest()[:24]]}}]
        restored = reconstruct(backup, current)['candidates'][0]
        self.assertEqual(restored['images'], [{'rawKey':'retained'}])
        self.assertEqual(restored['imageCount'], 1)
        self.assertEqual(restored['visibility'], 'private'); self.assertFalse(restored['isShared'])
        self.assertNotIn('shareCode', restored)
        self.assertEqual(len(backup[0]['images']), 2)

    def test_current_unresolved_work_is_quarantined_even_when_backup_is_clean(self):
        for pending in ({'pendingMediaDeletion':{'id':'missing-scope'}}, {'pendingVisibilityChange':{}}, {'status':'updating'}):
            backup = [{'albumId':ALBUM, 'images':[]}, {'albumId':'unaffected', 'images':[]}]
            result = reconstruct(backup, [{'albumId':ALBUM, **pending}])
            self.assertEqual([row['albumId'] for row in result['candidates']], ['unaffected'])
            self.assertEqual(result['quarantine'], [backup[0]])
