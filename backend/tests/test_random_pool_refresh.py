import os
import unittest
from unittest.mock import Mock, patch

import random_pool_refresh


class RandomPoolRefreshDispatchTests(unittest.TestCase):
    def tearDown(self):
        random_pool_refresh.reset_random_pool_refresh_client_for_tests()

    def test_refresh_requests_are_delayed_and_minimal(self):
        client = Mock()
        with patch.dict(
            os.environ,
            {"RANDOM_PHOTO_REFRESH_QUEUE_URL": "https://sqs.test/random-refresh"},
        ), patch.object(random_pool_refresh, "_client", return_value=client):
            self.assertTrue(random_pool_refresh.request_random_photo_pool_refresh())

        client.send_message.assert_called_once_with(
            QueueUrl="https://sqs.test/random-refresh",
            DelaySeconds=10,
            MessageBody='{"version":1,"refresh":true}',
        )

    def test_missing_queue_is_a_rollout_safe_noop(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(
            random_pool_refresh,
            "_client",
        ) as client:
            self.assertFalse(random_pool_refresh.request_random_photo_pool_refresh())
        client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
