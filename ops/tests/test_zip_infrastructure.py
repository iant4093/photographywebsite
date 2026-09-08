"""Guard archive retention, privacy, durable preparation and packaging."""

from pathlib import Path
import unittest
from test_infrastructure import resource_block, MAKEFILE


class ZipInfrastructureTests(unittest.TestCase):
    def test_current_archive_is_retained_but_old_versions_and_uploads_expire(self):
        bucket = resource_block('ImagesBucket')
        archive_rule = bucket.split('- Id: RetainCurrentAlbumArchives', 1)[1].split('- Id:', 1)[0]
        self.assertIn('Prefix: album-zips/', archive_rule)
        self.assertNotIn('ExpirationInDays:', archive_rule)
        self.assertIn('NoncurrentDays: 1', archive_rule)
        self.assertIn('DaysAfterInitiation: 1', archive_rule)
        self.assertIn("${ImagesBucket.Arn}/album-zips/*", resource_block('ImagesBucketPolicy'))

    def test_queue_serializes_builds_and_keeps_failed_jobs(self):
        queue = resource_block('ZipPreparationQueue')
        self.assertIn("QueueName: !Sub 'ian-photography-zip-preparation-${Stage}.fifo'", queue)
        dead_letter_queue = resource_block('ZipPreparationDeadLetterQueue')
        self.assertIn("QueueName: !Sub 'ian-photography-zip-preparation-dlq-${Stage}.fifo'", dead_letter_queue)
        self.assertIn('FifoQueue: true', queue)
        self.assertIn('VisibilityTimeout: 5400', queue)
        self.assertIn('DelaySeconds: 5', queue)
        self.assertIn('ZipPreparationDeadLetterQueue.Arn', queue)
        worker = resource_block('WorkerZipFunction')
        self.assertIn('BatchSize: 1', worker)
        self.assertIn('MaximumConcurrency: 2', worker)
        self.assertIn('sqs:ChangeMessageVisibility', worker)
        self.assertIn('s3:GetObjectVersion', worker)

    def test_changes_and_existing_albums_are_prepared_without_mutation_hooks(self):
        function = resource_block('ZipArchiveRefreshFunction')
        self.assertIn('Stream: !GetAtt AlbumsTable.StreamArn', function)
        self.assertIn('MaximumBatchingWindowInSeconds: 10', function)
        self.assertIn('Schedule: rate(15 minutes)', function)
        self.assertIn('dynamodb:Scan', function)
        self.assertIn('ReportBatchItemFailures', function)
        self.assertIn('SOURCES_ZipArchiveRefreshFunction :=', MAKEFILE)
        self.assertIn('zip_jobs.py', MAKEFILE.split('SOURCES_CreateZipFunction :=', 1)[1].split('\n')[0])

    def test_album_and_user_erasure_include_persistent_archives(self):
        root = Path(__file__).resolve().parents[2]
        for function, source in (('DeleteAlbumFunction', 'delete_album.py'), ('DeleteUserFunction', 'delete_user.py')):
            self.assertIn('${ImagesBucket.Arn}/album-zips/*', resource_block(function))
            self.assertIn('f"album-zips/{album_id}/"', (root / 'backend/functions' / source).read_text())
