import asyncio

import pytest

from gloss.core.events import Job, Jobs
from gloss.core.models import Entry, Generated
from gloss.core.orchestrator import Orchestrator
from gloss.core.ports import ProviderError


async def test_generation_salvages_batch_and_retries_only_missing(library, preferences):
    calls = []

    class Model:
        async def generate(self, entries):
            calls.append([item.index for item in entries])
            return [
                Generated(index=item.index, valid=False, word=item.word, reason="invalid")
                for item in entries
                if len(entries) == 1 or item.index == 0
            ]

    job = Job("text")
    await Orchestrator(library).generate(
        job,
        [Entry(index=0, word="a"), Entry(index=1, word="b")],
        "Gloss::General",
        Model(),
        preferences,
    )
    assert calls == [[0, 1], [1]]
    assert len(library.all()) == 2
    assert [event["event"] for event in job.events] == ["card", "card"]


async def test_cached_audio_deduplicates_calls_and_retries_metered(library, card, preferences):
    card.meaning = card.word
    card.example1 = card.word
    card.example2 = card.word
    calls = 0

    class Synth:
        async def synthesize(self, text):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ProviderError("temporary", retryable=True)
            return b"mp3"

    preferences.tts_rpm = 120
    service = Orchestrator(library)
    await service.audio(Job("audio"), [card], Synth(), preferences)
    assert calls == 2
    assert len(set(card.audio.values())) == 1
    await service.audio(Job("audio"), [card], Synth(), preferences)
    assert calls == 2


async def test_audio_failure_is_isolated_and_ceiling_is_hard(library, card, preferences):
    class Synth:
        async def synthesize(self, text):
            if text == card.word:
                raise ProviderError("missing voice")
            return b"mp3"

    await Orchestrator(library).audio(Job("audio"), [card], Synth(), preferences)
    assert set(card.audio) == {"meaning", "example1", "example2"}
    assert card.audio_errors["word"] == "missing voice"
    preferences.call_budget = 4

    class AlwaysFail:
        async def synthesize(self, text):
            raise ProviderError("quota", retryable=True)

    service = Orchestrator(library)
    fresh = card.model_copy(deep=True)
    fresh.meaning += " changed"
    fresh.example1 += " changed"
    fresh.example2 += " changed"
    with pytest.raises(ProviderError, match="ceiling"):
        await service.audio(Job("audio"), [fresh], AlwaysFail(), preferences)


async def test_cancel_preserves_completed_cards_and_delivers_terminal_event(library, card):
    jobs = Jobs()

    async def run(job):
        library.save(card)
        job.emit("card", card.model_dump())
        await asyncio.sleep(100)

    running = jobs.start("text", run)
    await asyncio.sleep(0)
    with pytest.raises(ValueError, match="already active"):
        jobs.start("text", run)
    assert running.task is not None
    running.task.cancel()
    await running.task
    assert library.get(card.id) == card
    assert running.done
    assert [event["event"] for event in running.events] == ["card", "cancelled", "done"]

    # Closing a stream while its previous event is being delivered must still send done.
    job = Job("text")
    job.emit("card", {"id": "one"})
    stream = job.stream(0)
    assert "event: card" in await anext(stream)
    job.done = True
    job.emit("done", {"job_id": job.id})
    assert "event: done" in await anext(stream)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)


async def test_single_retry_preserves_unchanged_clips_and_never_adds_an_error_row(
    library, card, preferences
):
    card.audio["word"] = "cached-word.mp3"
    card.note_id = 11
    library.save(card)
    service = Orchestrator(library)

    class Same:
        async def generate(self, entries):
            return [
                Generated(
                    index=0,
                    **card.model_dump(
                        include={
                            "word",
                            "pos",
                            "meaning",
                            "sinhala",
                            "example1",
                            "example2",
                            "valid",
                            "reason",
                        }
                    ),
                )
            ]

    entry = [Entry(index=0, word=card.word)]
    await service.generate(Job("text"), entry, card.deck, Same(), preferences, card.id)
    assert library.get(card.id).audio["word"] == "cached-word.mp3"
    assert library.get(card.id).note_id == 11

    class Fails:
        async def generate(self, entries):
            raise ProviderError("Connection lost")

    await service.generate(Job("text"), entry, card.deck, Fails(), preferences, card.id)
    assert len(library.all()) == 1
    assert library.get(card.id).reason == "Connection lost"
