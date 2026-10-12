import asyncio
import hashlib
import json
import time
from collections.abc import Callable

from gloss.config import Preferences
from gloss.core.events import Job
from gloss.core.models import CLIP_KINDS, Card, ClipKind, Entry
from gloss.core.ports import LanguageModel, ProviderError, Synthesizer
from gloss.library.store import Library


class RateLimiter:
    """A one-token bucket. Smooth requests rather than allowing an RPM-sized burst."""

    def __init__(self, rpm: int):
        self.interval = 60 / rpm
        self.next_time = 0.0
        self.lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self.lock:
            wait = max(0, self.next_time - time.monotonic())
            if wait:
                await asyncio.sleep(wait)
            self.next_time = time.monotonic() + self.interval


def clip_key(preferences: Preferences, text: str) -> str:
    return hashlib.sha256(
        json.dumps(
            {
                "model": preferences.tts_model,
                "voice": preferences.voice,
                "sample_rate": 24000,
                "encoding": "mp3-64k-v1",
                "text": text,
                "style": "calm-instructional-v1",
            },
            sort_keys=True,
            ensure_ascii=False,
        ).encode()
    ).hexdigest()


class Orchestrator:
    def __init__(self, library: Library):
        self.library = library
        self.outstanding = asyncio.Semaphore(4)
        self.clip_locks: dict[str, asyncio.Lock] = {}
        self.rate: RateLimiter | None = None
        self.rate_rpm = 0

    async def generate(
        self,
        job: Job,
        entries: list[Entry],
        deck: str,
        model: LanguageModel,
        preferences: Preferences,
        retry_id: str | None = None,
    ) -> None:
        batches = [
            entries[index : index + preferences.batch_size]
            for index in range(0, len(entries), preferences.batch_size)
        ]
        semaphore = asyncio.Semaphore(2)

        async def batch(items: list[Entry]) -> None:
            async with semaphore:
                async with self.outstanding:
                    try:
                        results = await model.generate(items)
                    except ProviderError as exc:
                        if exc.fatal:
                            raise
                        for entry in items:
                            card = (
                                self.library.get(retry_id)
                                if retry_id
                                else Card(
                                    word=entry.word,
                                    source_word=entry.word,
                                    hint=entry.hint,
                                    deck=deck,
                                )
                            )
                            card.reason = str(exc)
                            self.library.save(card)
                            job.emit("card", card.model_dump())
                        return
                received = {item.index: item for item in results}
                for entry in items:
                    item = received.get(entry.index)
                    if item is None:
                        # Repair may salvage other entries. Only missing entries are retried.
                        async with self.outstanding:
                            single = await model.generate([entry])
                        item = next((value for value in single if value.index == entry.index), None)
                    if item is None:
                        card = Card(
                            source_word=entry.word,
                            hint=entry.hint,
                            word=entry.word,
                            reason="The response was incomplete. Retry this entry.",
                            deck=deck,
                        )
                    else:
                        card = Card(
                            **item.model_dump(exclude={"index"}),
                            source_word=entry.word,
                            hint=entry.hint,
                            deck=deck,
                        )
                    if retry_id:
                        old = self.library.get(retry_id)
                        card.id = retry_id
                        if card.base_identity() == old.base_identity():
                            card.note_id = old.note_id
                            card.sync_identity = old.sync_identity
                            card.synced_hash = old.synced_hash
                        for kind in CLIP_KINDS:
                            if card.clip_text(kind) == old.clip_text(kind) and kind in old.audio:
                                card.audio[kind] = old.audio[kind]
                    self.library.save(card)
                    job.emit("card", card.model_dump())

        tasks = [asyncio.create_task(batch(items)) for items in batches]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def clip(
        self,
        card: Card,
        kind: ClipKind,
        synth: Synthesizer,
        preferences: Preferences,
        spend: Callable[[], None],
    ) -> str:
        text = card.clip_text(kind)
        if not text.strip():
            raise ValueError("Add text before generating audio.")
        key = clip_key(preferences, text)
        lock = self.clip_locks.setdefault(key, asyncio.Lock())
        async with lock:
            if filename := self.library.clip(key):
                return filename
            if self.rate is None or self.rate_rpm != preferences.tts_rpm:
                self.rate = RateLimiter(preferences.tts_rpm)
                self.rate_rpm = preferences.tts_rpm
            for attempt in range(3):
                await self.rate.acquire()
                spend()
                try:
                    async with self.outstanding:
                        data = await synth.synthesize(text)
                    return self.library.save_clip(key, data)
                except ProviderError as exc:
                    if not exc.retryable or attempt == 2:
                        raise
                    await asyncio.sleep(2**attempt)
        raise AssertionError("unreachable")

    async def audio(
        self,
        job: Job,
        cards: list[Card],
        synth: Synthesizer,
        preferences: Preferences,
        only: ClipKind | None = None,
    ) -> None:
        calls = 0
        semaphore = asyncio.Semaphore(preferences.tts_concurrency)

        def spend() -> None:
            nonlocal calls
            calls += 1
            if calls > preferences.call_budget:
                raise ProviderError(
                    "The run reached its audio request ceiling. Start a new run.", fatal=True
                )

        async def clip(card: Card, kind: ClipKind) -> None:
            async with semaphore:
                try:
                    card.audio[kind] = await self.clip(card, kind, synth, preferences, spend)
                    card.audio_errors.pop(kind, None)
                except ProviderError as exc:
                    card.audio_errors[kind] = str(exc)
                    if exc.fatal:
                        raise
                finally:
                    self.library.save(card)
                    job.emit("card", card.model_dump())

        tasks = [
            asyncio.create_task(clip(card, kind))
            for card in cards
            if card.ready()
            for kind in ((only,) if only else CLIP_KINDS)
        ]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self.clip_locks.clear()
