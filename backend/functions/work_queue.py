"""Select one continuation destination while retaining legacy v1 delivery support."""
import os


def queue_url():
    # The template supplies the selected URL. Missing configuration falls back
    # for old artifacts/tests; send failures must never dispatch to both queues.
    return (os.environ.get("ALBUM_WORK_QUEUE_URL", "").strip()
            or os.environ.get("CACHE_INVALIDATION_QUEUE_URL", "").strip())
