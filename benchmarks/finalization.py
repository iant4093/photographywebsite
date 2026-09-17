"""Compare actual dispatch implementations using deterministic provider latency.

Manual and offline: every boto3 client/resource is replaced before execution.
Run from the repository root using the backend Python environment.
"""
import importlib.util
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import threading
import time
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend' / 'functions'))
os.environ.setdefault('AWS_EC2_METADATA_DISABLED', 'true')
os.environ.setdefault('AWS_DEFAULT_REGION', 'us-west-2')
# Only these two fields are used from media_access; avoid initializing any AWS
# resource or reading application configuration in this offline benchmark.
media = types.ModuleType('media_access')
media.media_id_for_key = lambda key: __import__('hashlib').sha256(key.encode()).hexdigest()
sys.modules['media_access'] = media

BASELINE = '72324da'
source = subprocess.run(['git', 'show', f'{BASELINE}:backend/functions/original_comparison_jobs.py'], cwd=ROOT, check=True, capture_output=True, text=True).stdout
before_module = types.ModuleType('baseline_jobs')
exec(compile(source, '<baseline>', 'exec'), before_module.__dict__)
spec = importlib.util.spec_from_file_location('optimized_jobs', ROOT / 'backend/functions/original_comparison_jobs.py')
after_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(after_module)

class Provider:
    def __init__(self):
        self.calls = {'sqs': 0, 'dynamodb': 0}
        self.active = self.maximum = 0
        self.lock = threading.Lock()

    def operation(self, kind):
        with self.lock:
            self.calls[kind] += 1
            self.active += 1
            self.maximum = max(self.maximum, self.active)
        time.sleep(.02)
        with self.lock:
            self.active -= 1

    def send_message_batch(self, **kwargs):
        self.operation('sqs')
        return {'Successful': [{'Id': item['Id']} for item in kwargs['Entries']]}

    def update_item(self, **_kwargs):
        self.operation('dynamodb')

    def Table(self, _name):
        return self

album_id = '11111111-1111-4111-8111-111111111111'
images = [{'rawKey': f'albums/{album_id}/original/{index}.jpg'} for index in range(220)]
results = {'before': [], 'after': []}
for trial in range(3):
    for label, module in [('before', before_module), ('after', after_module)]:
        provider = Provider()
        with patch.dict(os.environ, {'ORIGINAL_COMPARISON_TABLE': 'synthetic', 'ORIGINAL_COMPARISON_QUEUE_URL': 'synthetic'}), patch('boto3.client', return_value=provider), patch('boto3.resource', return_value=provider):
            start = time.perf_counter()
            assert module.enqueue_original_comparisons(album_id, images) == 220
            elapsed = time.perf_counter() - start
        assert provider.calls == {'sqs': 22, 'dynamodb': 220}
        assert provider.active == 0
        results[label].append(round(elapsed * 1000))
        if label == 'after':
            assert 1 < provider.maximum <= 8
before = statistics.median(results['before'])
after = statistics.median(results['after'])
assert after < before * .4
print(json.dumps({'baseline': BASELINE, 'photos': 220, 'providerLatencyMs': 20,
                  'runsMs': results, 'medianBeforeMs': before, 'medianAfterMs': after,
                  'improvementPercent': round(100 * (1 - after / before), 1),
                  'callsPerRun': {'sqs': 22, 'dynamodb': 220}, 'maxConcurrentCallsAfter': provider.maximum}, indent=2))
