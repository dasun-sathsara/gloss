from typing import Protocol

from gloss.core.models import Entry, Generated


class LanguageModel(Protocol):
    async def generate(self, entries: list[Entry]) -> list[Generated]: ...


class Synthesizer(Protocol):
    async def synthesize(self, text: str) -> bytes: ...


class ProviderError(Exception):
    def __init__(self, message: str, *, retryable: bool = False, fatal: bool = False):
        super().__init__(message)
        self.retryable = retryable
        self.fatal = fatal
