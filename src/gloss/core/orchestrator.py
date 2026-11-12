import asyncio
import hashlib
import json
import logging
import random
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

    def pause(self, seconds: float) -> None:
        """Hold every worker back after a quota error, not only the one that hit it."""
        self.next_time = max(self.next_time, time.monotonic() + seconds)


CLIP_ATTEMPTS = 5


def backoff(attempt: int, rate_limited: bool) -> float:
    # Quota windows are about a minute long, so short sleeps only burn attempts.
    base = min(60.0, 10.0 * 2**attempt) if rate_limited else float(2**attempt)
    return base + random.uniform(0, 1)


def clip_key(preferences: Preferences, text: str) -> str:
    payload = {
        "model": preferences.tts_model,
        "voice": preferences.voice,
        "sample_rate": 24000,
        "encoding": "mp3-64k-v1",
        "text": text,
        "style": "calm-instructional-v1",
    }
    if preferences.audio_engine:
        # A local engine ignores the Google model and voice above, so name it here.
        payload["engine"] = preferences.audio_engine
    return hashlib.sha256(
        json.dumps(
            payload,
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
    ) -> list[Card]:
        """Write cards for the entries and return them in input order."""
        job.stage = "text"
        total = len(entries)
        if not total:
            return []
        batches = [
            entries[index : index + preferences.batch_size]
            for index in range(0, total, preferences.batch_size)
        ]
        semaphore = asyncio.Semaphore(2)
        progress_lock = asyncio.Lock()
        completed = 0
        written: dict[int, Card] = {}
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

        async def publish(entry: Entry, card: Card) -> None:
            nonlocal completed
            written[entry.index] = card
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

        async def fetch(items: list[Entry]) -> list[tuple[Entry, Generated | None, str]]:
            # A batch that fails after the provider's own retry is worth splitting:
            # a cold endpoint can serve two words when it cannot serve five, and a
            # smaller request must not cost the user every card in the batch.
            try:
                async with self.outstanding:
                    results = await model.generate(items)
            except ProviderError as exc:
                if exc.fatal:
                    raise
                if len(items) > 2:
                    logger.warning(
                        "Text batch of %d failed, retrying in pairs: %s", len(items), exc
                    )
                    outcomes: list[tuple[Entry, Generated | None, str]] = []
                    for start in range(0, len(items), 2):
                        outcomes.extend(await fetch(items[start : start + 2]))
                    return outcomes
                return [(entry, None, str(exc)) for entry in items]
            except Exception:
                # One malformed response must not discard the other batches.
                logger.exception("Text generation failed for a batch")
                return [(entry, None, "This batch failed. Retry these words.") for entry in items]
            received = (
                {item.index: item for item in results} if isinstance(results, (list, tuple)) else {}
            )
            outcomes = []
            for entry in items:
                item = received.get(entry.index)
                if item is None:
                    item, reason = await repair(entry)
                else:
                    reason = ""
                outcomes.append((entry, item, reason))
            return outcomes

        async def batch(items: list[Entry]) -> None:
            async with semaphore:
                for entry, item, reason in await fetch(items):
                    card = build(entry, item) if item is not None else fallback(entry, reason)
                    await publish(entry, card)

        tasks = [asyncio.create_task(batch(items)) for items in batches]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        return [written[index] for index in sorted(written)]

    async def clip(
        self,
        text: str,
        synth: Synthesizer,
        preferences: Preferences,
        spend: Callable[[], None],
    ) -> str:
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
            for attempt in range(CLIP_ATTEMPTS):
                await self.rate.acquire()
                spend()
                try:
                    async with self.outstanding:
                        data = await synth.synthesize(text)
                    return self.library.save_clip(key, data)
                except ProviderError as exc:
                    if not exc.retryable or attempt == CLIP_ATTEMPTS - 1:
                        raise
                    delay = backoff(attempt, exc.rate_limited)
                    if exc.rate_limited:
                        self.rate.pause(delay)
                    else:
                        await asyncio.sleep(delay)
        raise AssertionError("unreachable")

    async def audio(
        self,
        job: Job,
        cards: list[Card],
        synth: Synthesizer,
        preferences: Preferences,
        only: ClipKind | None = None,
    ) -> dict[str, int]:
        """Record missing clips and return how many clips are ready, failed, or skipped.

        Each result is written to the card as it is now in the library, and only when
        the clip's text is unchanged. Edits saved during the run are never overwritten.
        """
        job.stage = "audio"
        ready = 0
        planned: list[tuple[str, ClipKind, str]] = []
        for card in cards:
            if not card.ready():
                continue
            for kind in (only,) if only else CLIP_KINDS:
                text = card.clip_text(kind)
                cached = self.library.clip(clip_key(preferences, text))
                if cached and card.audio.get(kind) == cached:
                    ready += 1
                else:
                    planned.append((card.id, kind, text))
        total = len(planned)
        stats = {"clips": total + ready, "ready": ready, "failed": 0, "skipped": 0}
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

        def current(card_id: str, kind: ClipKind, text: str) -> Card | None:
            """The saved card, or None if it was removed or this clip's text was edited."""
            try:
                card = self.library.get(card_id)
            except KeyError:
                return None
            return card if card.clip_text(kind) == text else None

        def record(
            card_id: str, kind: ClipKind, text: str, filename: str = "", error: str = ""
        ) -> None:
            card = current(card_id, kind, text)
            if card is None:
                stats["skipped"] += 1
                return
            if filename:
                card.audio[kind] = filename
                card.audio_errors.pop(kind, None)
                stats["ready"] += 1
            else:
                card.audio_errors[kind] = error
                stats["failed"] += 1
            self.library.save(card)
            job.emit("card", card.model_dump())

        async def clip(card_id: str, kind: ClipKind, text: str) -> None:
            nonlocal completed
            async with semaphore:
                try:
                    if exhausted:
                        record(
                            card_id,
                            kind,
                            text,
                            error="Skipped: the audio request ceiling was reached.",
                        )
                    elif current(card_id, kind, text) is None:
                        # Edited or removed while queued. Do not pay for a stale clip.
                        stats["skipped"] += 1
                    else:
                        filename = await self.clip(text, synth, preferences, spend)
                        record(card_id, kind, text, filename=filename)
                except asyncio.CancelledError:
                    record(card_id, kind, text, error="Stopped before this clip finished.")
                    raise
                except ProviderError as exc:
                    record(card_id, kind, text, error=str(exc))
                    if exc.fatal:
                        raise
                except Exception:
                    # One unexpected failure must not abort the other clips.
                    logger.exception("Audio clip failed")
                    record(card_id, kind, text, error="This clip failed. Retry it.")
                finally:
                    async with progress_lock:
                        completed += 1
                        job.emit(
                            "progress",
                            {"stage": "audio", "completed": completed, "total": total},
                        )

        tasks = [asyncio.create_task(clip(*item)) for item in planned]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self.clip_locks.clear()
        return stats
