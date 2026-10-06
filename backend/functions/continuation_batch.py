"""Bounded batch execution shared by legacy and separated continuation consumers."""
import logging
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger("photography_api.continuation_batch")


def resume_batch(records, context, invoke):
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    grouped = {}
    for identifier, body in records:
        identity = (body["kind"], body["albumId"], body.get("jobEntry"), body.get("key"))
        group = grouped.setdefault(identity, {"body": body, "ids": []})
        group["ids"].append(identifier)

    def resume(group):
        try:
            if callable(remaining) and remaining() < 24000:
                raise RuntimeError("Defer continuation to the next batch")
            invoke(group["body"])
            return []
        except Exception as error:
            logger.error("album_continuation_failed error_type=%s", type(error).__name__)
            if not all(group["ids"]):
                raise
            return [{"itemIdentifier": identifier} for identifier in group["ids"]]

    failures = []
    if grouped:
        with ThreadPoolExecutor(max_workers=min(4, len(grouped)), thread_name_prefix="album-work") as executor:
            for batch_failures in executor.map(resume, grouped.values()):
                failures.extend(batch_failures)
    return failures
