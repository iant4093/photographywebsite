"""Bounded timing logs without request payloads or per-user metric dimensions."""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import json
import logging
import time

logger = logging.getLogger("photography_api.performance")
_stages = ContextVar("performance_stages", default=None)
_cold_start = True


@contextmanager
def measure_stage(name):
    started = time.perf_counter()
    try:
        yield
    finally:
        stages = _stages.get()
        if stages is not None:
            stages[name] = stages.get(name, 0) + round((time.perf_counter() - started) * 1000, 2)


def measure_handler(operation):
    def decorate(handler):
        @wraps(handler)
        def measured(event, context):
            global _cold_start
            cold_start, _cold_start = _cold_start, False
            stages = {}
            token = _stages.set(stages)
            started = time.perf_counter()
            result = None
            returned = False
            try:
                result = handler(event, context)
                returned = True
                return result
            finally:
                _stages.reset(token)
                record = {
                    "event": "backend_performance", "operation": operation,
                    "coldStart": cold_start, "returned": returned,
                    "elapsedMs": round((time.perf_counter() - started) * 1000, 2),
                    "stagesMs": stages,
                }
                if isinstance(result, dict) and type(result.get("statusCode")) is int:
                    record["statusCode"] = result["statusCode"]
                # Observability must never change a response, acknowledgement,
                # or exception, even if a configured logging handler fails.
                try:
                    logger.info(json.dumps(record, separators=(",", ":")))
                except Exception:
                    pass
        return measured
    return decorate
