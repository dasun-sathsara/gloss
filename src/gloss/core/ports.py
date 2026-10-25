from typing import Protocol

from gloss.core.models import Entry, Generated


class LanguageModel(Protocol):
    async def generate(self, entries: list[Entry]) -> list[Generated]: ...


class Synthesizer(Protocol):
    async def synthesize(self, text: str) -> bytes: ...


class ProviderError(Exception):
    def __init__(
        self,
        message: str,
        *,
        retryable: bool = False,
        fatal: bool = False,
        rate_limited: bool = False,
    ):
        super().__init__(message)
        self.retryable = retryable or rate_limited
        self.fatal = fatal
        # Quota errors need a long, shared cooldown rather than a quick per-clip retry.
        self.rate_limited = rate_limited
