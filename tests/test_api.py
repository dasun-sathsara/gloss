import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import respx

from gloss.api.app import create_app
from gloss.config import VOICES, Configuration


def configured(tmp_path, **environment) -> Configuration:
    """A real Environment, with values fixed instead of read from the machine."""
    configuration = Configuration(tmp_path)
    for key, value in environment.items():
        setattr(configuration.environment, key, value)
    return configuration


def client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:8766",
    )


async def settled(http: httpx.AsyncClient) -> dict:
    """Bootstrap once the startup warm-up has finished, whichever way it went."""
    for _ in range(400):
        data = (await http.get("/api/bootstrap")).json()
        if data["text_health"] in {"ready", "down"}:
            return data
        await asyncio.sleep(0.01)
    raise AssertionError("The text endpoint never settled.")


async def test_local_security_and_full_offline_workflow(tmp_path):
    app = create_app(Configuration(tmp_path), demo=True)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://127.0.0.1:8766",
        ) as http,
    ):
        rejected = await http.post("/api/parse", json={"text": "curious"})
        assert rejected.status_code == 403
        rejected = await http.post(
            "/api/parse", headers={"Origin": "https://evil.example"}, json={"text": "curious"}
        )
        assert rejected.status_code == 403
        http.headers["Origin"] = "http://127.0.0.1:8766"
        assert (await http.get("/.env")).status_code == 404
        assert (await http.get("/api/bootstrap")).json()["demo"]
        response = await http.post(
            "/api/generate", json={"text": "curious; nonsense", "deck": "Gloss::General"}
        )
        job_id = response.json()["id"]
        await app.state.jobs.get(job_id).task
        stream = await http.get(f"/api/jobs/{job_id}/events", headers={"Last-Event-ID": "1"})
        assert "id: 1\n" not in stream.text
        cards = (await http.get("/api/bootstrap")).json()["cards"]
        assert len(cards) == 2
        card = next(card for card in cards if card["valid"])
        app.state.configuration.preferences.tts_rpm = 120
        audio = await http.post("/api/audio", json={"ids": [card["id"]]})
        await app.state.jobs.get(audio.json()["id"]).task
        saved = app.state.library.get(card["id"])
        assert len(saved.audio) == 4
        edit = saved.model_dump(
            include={
                "word",
                "pos",
                "meaning",
                "sinhala",
                "example1",
                "example2",
                "valid",
                "deck",
                "decision",
            }
        )
        edit["meaning"] = "An edited meaning."
        changed = await http.patch(f"/api/cards/{saved.id}", json=edit)
        assert "meaning" not in changed.json()["audio"]
        assert len(changed.json()["audio"]) == 3
        assert (await http.get("/media/sa.json")).status_code == 404

    # A fresh app must restore the edited card and its remaining clips from disk.
    restarted = create_app(Configuration(tmp_path), demo=True)
    restored = restarted.state.library.get(saved.id)
    assert restored.meaning == "An edited meaning."
    assert len(restored.audio) == 3
    assert len(restarted.state.library.all()) == 2
    restarted.state.library.close()


async def test_sync_requires_pull_ticket_and_same_profile(tmp_path, card):
    app = create_app(Configuration(tmp_path), demo=True)
    app.state.library.save(card)
    gateway = app.state.gateway
    gateway.client = AsyncMock()
    gateway.client.call.side_effect = lambda action, **kwargs: (
        "Learner" if action == "getActiveProfile" else None
    )
    gateway.sync = AsyncMock()
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://127.0.0.1:8766",
            headers={"Origin": "http://127.0.0.1:8766"},
        ) as http,
    ):
        selection = {"ids": [card.id], "allow_missing": True}
        assert (await http.post("/api/anki/sync", json=selection)).status_code == 400
        pull = (await http.post("/api/anki/pull", json={"ids": [card.id]})).json()
        selection["ticket"] = pull["ticket"]
        response = await http.post("/api/anki/sync", json=selection)
        await app.state.jobs.get(response.json()["id"]).task
        gateway.sync.assert_awaited_once()
        assert (await http.post("/api/anki/sync", json=selection)).status_code == 400


async def test_batch_deck_updates_all_words_atomically(tmp_path, card):
    app = create_app(Configuration(tmp_path), demo=True)
    invalid = card.model_copy(update={"id": "invalid", "valid": False})
    other = card.model_copy(update={"id": "other"})
    for value in (card, invalid, other):
        app.state.library.save(value)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://127.0.0.1:8766",
            headers={"Origin": "http://127.0.0.1:8766"},
        ) as http,
    ):
        response = await http.put(
            "/api/batch/deck", json={"ids": [card.id, invalid.id], "deck": "Gloss::Science"}
        )
        assert response.status_code == 200
        assert {value["deck"] for value in response.json()} == {"Gloss::Science"}
        assert app.state.library.get(other.id).deck == other.deck
        response = await http.put(
            "/api/batch/deck", json={"ids": [card.id, "missing"], "deck": "Gloss::English"}
        )
        assert response.status_code == 404
        assert app.state.library.get(card.id).deck == "Gloss::Science"
        response = await http.put(
            "/api/batch/deck", json={"ids": [card.id], "deck": "Other::General"}
        )
        assert response.status_code == 400
        assert app.state.library.get(card.id).deck == "Gloss::Science"


async def test_generation_records_audio_and_allows_edits_while_it_runs(tmp_path):
    app = create_app(Configuration(tmp_path), demo=True)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://127.0.0.1:8766",
            headers={"Origin": "http://127.0.0.1:8766"},
        ) as http,
    ):
        response = await http.post(
            "/api/generate", json={"text": "curious, resilient, nonsense", "deck": "Gloss::General"}
        )
        job = app.state.jobs.get(response.json()["id"])
        while job.stage != "audio" and not job.done:
            await asyncio.sleep(0.01)
        assert (await http.get("/api/bootstrap")).json()["active_job"]["stage"] == "audio"
        # Text edits wait for the run, but card edits are accepted while audio records.
        assert (await http.post("/api/generate", json={"text": "record"})).status_code == 409
        card = next(card for card in app.state.library.all() if card.word == "curious")
        edit = card.model_dump(include=set(CardFields))
        edit["example2"] = "She was curious about the noise."
        assert (await http.patch(f"/api/cards/{card.id}", json=edit)).status_code == 200
        await job.task
        summary = next(event["data"] for event in job.events if event["event"] == "summary")
        assert summary["words"] == 3
        assert summary["needs_review"] == 1
        assert summary["audio"]["failed"] == 0
        saved = app.state.library.get(card.id)
        assert saved.example2 == "She was curious about the noise."
        resilient = next(card for card in app.state.library.all() if card.word == "resilient")
        assert len(resilient.audio) == 4
        # Whether the edit landed before or after its clip was recorded, the edited
        # field never keeps audio for its old text.
        assert "example2" not in saved.audio
        assert {"word", "meaning", "example1"} <= saved.audio.keys()


CardFields = (
    "word",
    "pos",
    "meaning",
    "sinhala",
    "example1",
    "example2",
    "valid",
    "deck",
    "decision",
)


async def test_bootstrap_reports_provider_and_audio_for_woof_and_google(tmp_path):
    woof = configured(
        tmp_path / "woof-home",
        google_cloud_project="",
        text_api_base="",
        text_api_key="",
        woof_model_dir=str(tmp_path / "woof"),
        woof_voice="juno",
    )
    app = create_app(woof)
    async with app.router.lifespan_context(app), client(app) as http:
        data = (await http.get("/api/bootstrap")).json()
    assert data["text_provider"] == ""
    assert data["text_health"] == "off"
    assert data["provider_ready"] is False
    assert data["audio_provider"] == "woof"
    assert data["audio_voice"] == "juno"
    assert data["audio_ready"] is True
    assert data["voices"] == []

    google = configured(
        tmp_path / "google-home",
        google_cloud_project="demo-project",
        text_api_base="",
        text_api_key="",
        woof_model_dir="",
    )
    app = create_app(google)
    async with app.router.lifespan_context(app), client(app) as http:
        data = (await http.get("/api/bootstrap")).json()
    assert data["text_provider"] == "google"
    assert data["text_health"] == "off"
    assert data["provider_ready"] is True
    assert data["audio_provider"] == "google"
    assert data["audio_voice"] == google.preferences.voice
    assert data["voices"] == list(VOICES)


async def test_bootstrap_warms_endpoint_and_reports_health(tmp_path):
    configuration = configured(
        tmp_path / "ready",
        google_cloud_project="",
        text_api_base="https://proxy.example/v1",
        text_api_key="sk-test",
        woof_model_dir=str(tmp_path / "woof"),
    )
    with respx.mock(base_url="https://proxy.example") as router:
        route = router.post("/v1/chat/completions").mock(
            side_effect=[
                httpx.Response(303, headers={"location": "https://wake.example/"}),
                httpx.Response(200, json={"choices": []}),
            ]
        )
        app = create_app(configuration)
        async with app.router.lifespan_context(app), client(app) as http:
            data = await settled(http)
    assert data["text_health"] == "ready"
    assert data["text_health_detail"] == ""
    assert data["text_provider"] == "endpoint"
    assert data["audio_provider"] == "woof"
    assert data["voices"] == []
    assert route.call_count == 2
    body = json.loads(route.calls[0].request.content)
    assert body["max_tokens"] == 1
    assert body["model"] == "gemini-3.8-flash"
    assert route.calls[0].request.headers["authorization"] == "Bearer sk-test"

    down = configured(
        tmp_path / "down",
        google_cloud_project="",
        text_api_base="https://proxy.example/v1",
        text_api_key="sk-test",
        woof_model_dir="",
    )
    with respx.mock(base_url="https://proxy.example") as router:
        router.post("/v1/chat/completions").mock(return_value=httpx.Response(503))
        app = create_app(down)
        async with app.router.lifespan_context(app), client(app) as http:
            data = await settled(http)
    assert data["text_health"] == "down"
    assert "503" in data["text_health_detail"]
