import asyncio
import hashlib
import json
import logging
import time
from collections.abc import Callable

from gloss.config import Preferences
from gloss.core.events import Job
from gloss.core.models import CLIP_KINDS, Card, ClipKind, Entry, Generated
from gloss.core.ports import LanguageModel, ProviderError, Synthesizer
from gloss.library.store import Library

logger = logging.getLogger("gloss")


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
        total = len(entries)
        if not total:
            return
        batches = [
            entries[index : index + preferences.batch_size]
            for index in range(0, total, preferences.batch_size)
        ]
        semaphore = asyncio.Semaphore(2)
        progress_lock = asyncio.Lock()
        completed = 0
        # A monotonic per-card order so the client can show input order even though
        # two batches run concurrently and finish out of order.
        base_order = int(time.time() * 1000) * 1000
        job.emit("progress", {"stage": "text", "completed": 0, "total": total})

        def fallback(entry: Entry, reason: str) -> Card:
            if retry_id:
                card = self.library.get(retry_id)
            else:
                card = Card(word=entry.word, source_word=entry.word, hint=entry.hint, deck=deck)
                card.order = base_order + entry.index
            card.reason = reason
            return card

        def build(entry: Entry, item: Generated) -> Card:
            if not retry_id:
                return Card(
                    **item.model_dump(exclude={"index"}),
                    source_word=entry.word,
                    hint=entry.hint,
                    deck=deck,
                    order=base_order + entry.index,
                )
            old = self.library.get(retry_id)
            card = Card(
                **item.model_dump(exclude={"index"}),
                source_word=entry.word,
                hint=entry.hint,
                deck=old.deck,
                order=old.order,
                decision=old.decision,
            )
            card.id = retry_id
            if card.base_identity() == old.base_identity():
                card.note_id = old.note_id
                card.sync_identity = old.sync_identity
                card.synced_hash = old.synced_hash
            for kind in CLIP_KINDS:
                if card.clip_text(kind) == old.clip_text(kind) and kind in old.audio:
                    card.audio[kind] = old.audio[kind]
            return card

        async def publish(card: Card) -> None:
            nonlocal completed
            self.library.save(card)
            job.emit("card", card.model_dump())
            async with progress_lock:
                completed += 1
                job.emit("progress", {"stage": "text", "completed": completed, "total": total})

        async def repair(entry: Entry) -> tuple[Generated | None, str]:
            # A repair call must never take down the whole run. Fatal provider
            # errors still propagate to abort a doomed run.
            try:
                async with self.outstanding:
                    single = await model.generate([entry])
            except ProviderError as exc:
                if exc.fatal:
                    raise
                return None, str(exc)
            except Exception:
                logger.exception("Single-entry repair failed")
                return None, "This word failed. Retry it."
            if isinstance(single, (list, tuple)):
                found = next(
                    (value for value in single if getattr(value, "index", None) == entry.index),
                    None,
                )
                if found is not None:
                    return found, ""
            return None, "The response was incomplete. Retry this entry."

        async def batch(items: list[Entry]) -> None:
            async with semaphore:
                try:
                    async with self.outstanding:
                        results = await model.generate(items)
                except ProviderError as exc:
                    if exc.fatal:
                        raise
                    reason = str(exc)
                    for entry in items:
                        await publish(fallback(entry, reason))
                    return
                except Exception:
                    # One malformed response must not discard the other batches.
                    logger.exception("Text generation failed for a batch")
                    for entry in items:
                        await publish(fallback(entry, "This batch failed. Retry these words."))
                    return
                received = (
                    {item.index: item for item in results}
                    if isinstance(results, (list, tuple))
                    else {}
                )
                for entry in items:
                    item = received.get(entry.index)
                    if item is None:
                        item, reason = await repair(entry)
                    else:
                        reason = ""
                    card = build(entry, item) if item is not None else fallback(entry, reason)
                    await publish(card)

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
        planned = [
            (card, kind)
            for card in cards
            if card.ready()
            for kind in ((only,) if only else CLIP_KINDS)
        ]
        total = len(planned)
        semaphore = asyncio.Semaphore(preferences.tts_concurrency)
        progress_lock = asyncio.Lock()
        completed = 0
        calls = 0
        exhausted = False
        if total:
            job.emit("progress", {"stage": "audio", "completed": 0, "total": total})

        def spend() -> None:
            nonlocal calls, exhausted
            calls += 1
            if calls > preferences.call_budget:
                # Non-fatal: already-completed clips are kept and the rest are skipped
                # with a visible reason instead of discarding the whole run.
                exhausted = True
                raise ProviderError(
                    "The audio request ceiling was reached. Completed clips are saved; "
                    "generate audio again for the rest.",
                    fatal=False,
                )

        async def clip(card: Card, kind: ClipKind) -> None:
            nonlocal completed
            async with semaphore:
                try:
                    if exhausted:
                        card.audio_errors[kind] = "Skipped: the audio request ceiling was reached."
                    else:
                        card.audio[kind] = await self.clip(card, kind, synth, preferences, spend)
                        card.audio_errors.pop(kind, None)
                except asyncio.CancelledError:
                    card.audio_errors[kind] = "Stopped before this clip finished."
                    raise
                except ProviderError as exc:
                    card.audio_errors[kind] = str(exc)
                    if exc.fatal:
                        raise
                finally:
                    self.library.save(card)
                    job.emit("card", card.model_dump())
                    async with progress_lock:
                        completed += 1
                        job.emit(
                            "progress",
                            {"stage": "audio", "completed": completed, "total": total},
                        )

        tasks = [asyncio.create_task(clip(card, kind)) for card, kind in planned]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self.clip_locks.clear()
