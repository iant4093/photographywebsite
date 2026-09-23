"""One bounded database/time allowance shared by an Explore request's workers."""
from contextvars import ContextVar
from threading import Lock
import time


class ExploreUnavailable(Exception):
    pass


current_budget = ContextVar("explore_budget", default=None)


class ExploreBudget:
    def __init__(self, context=None, *, seconds=8, reads=96, scans=8):
        remaining = getattr(context, "get_remaining_time_in_millis", None)
        if callable(remaining):
            seconds = min(seconds, max(0, remaining() / 1000 - 2))
        self.deadline = time.monotonic() + seconds
        self.reads = reads
        self.scans = scans
        self.lock = Lock()

    def check(self, *, read=False, scan=False):
        with self.lock:
            if time.monotonic() >= self.deadline or (read and self.reads <= 0) or (scan and self.scans <= 0):
                raise ExploreUnavailable("Explore request budget exhausted")
            self.reads -= int(read)
            self.scans -= int(scan)


def read(method, *, _scan=False, **kwargs):
    budget = current_budget.get()
    if budget:
        budget.check(read=True, scan=_scan)
    result = method(**kwargs)
    if budget:
        budget.check()
    return result
