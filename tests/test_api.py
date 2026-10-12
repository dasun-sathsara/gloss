from unittest.mock import AsyncMock

import httpx

from gloss.api.app import create_app
from gloss.config import Configuration


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
