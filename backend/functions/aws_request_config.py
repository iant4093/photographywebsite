"""Short, explicit SDK budgets for interactive API dependencies."""

from botocore.config import Config


def request_config(*, attempts=2):
    # total_max_attempts includes the initial request. Mutating authentication
    # calls and secret reads use one attempt; the next user request can retry.
    return Config(connect_timeout=2, read_timeout=3,
                  retries={"mode": "standard", "total_max_attempts": attempts})
