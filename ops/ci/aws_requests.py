"""Bounded AWS clients and parallel requests for immutable release artifacts."""
from concurrent.futures import ThreadPoolExecutor

MAX_WORKERS = 8


def client(service, region):
    import boto3
    from botocore.config import Config

    return boto3.client(service, region_name=region, config=Config(
        connect_timeout=10, read_timeout=60, max_pool_connections=MAX_WORKERS,
        retries={"mode": "standard", "total_max_attempts": 4},
    ))


def parallel_map(function, items):
    # Exhaust the iterator so every failure propagates before a later phase.
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        return list(executor.map(function, items))
