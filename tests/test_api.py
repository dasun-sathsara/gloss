import asyncio
import json
from unittest.mock import AsyncMock, Mock

import httpx
import respx

from gloss.api.app import create_app
from gloss.config import VOICES, WOOF_VOICES, Configuration


def configured(tmp_path, **environment) -> Configuration:
    """A real Environment, with values fixed instead of read from the machine."""
    configuration = Configuration(tmp_path)
    for key, value in environment.items():
        setattr(configuration.environment, key, value)
    configuration.apply_audio_engine(configuration.preferences)
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
        blocked = await http.post(
            "/api/anki/pull", json={"ids": [card.id], "expected_profile": "Different"}
        )
        assert blocked.status_code == 400
        assert "original Anki profile" in blocked.json()["detail"]
        gateway.client.call.assert_awaited_once_with("getActiveProfile")
        pull = (
            await http.post(
                "/api/anki/pull", json={"ids": [card.id], "expected_profile": "Learner"}
            )
        ).json()
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
    assert data["woof_voices"] == list(WOOF_VOICES)
    assert data["voices"] == []
    assert data["woof_configured"] is True

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
        assert data["audio_provider"] == "woof"
        assert data["audio_ready"] is False
        assert data["google_audio_available"] is True
        http.headers["Origin"] = "http://127.0.0.1:8766"
        assert (await http.post("/api/audio", json={"ids": ["any"]})).status_code == 400
        saved = await http.put(
            "/api/settings", json={**data["settings"], "audio_provider": "google"}
        )
        assert saved.status_code == 200
        data = (await http.get("/api/bootstrap")).json()
        assert data["audio_provider"] == "google"
        assert data["audio_ready"] is True
        assert data["audio_voice"] == google.preferences.voice
        assert data["voices"] == list(VOICES)
    assert Configuration(tmp_path / "google-home").preferences.audio_provider == "google"


async def test_endpoint_warms_only_on_explicit_request(tmp_path, card):
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
            initial = (await http.get("/api/bootstrap")).json()
            assert initial["provider_ready"]
            assert initial["text_health"] == "off"
            assert route.call_count == 0
            http.headers["Origin"] = "http://127.0.0.1:8766"
            start = await http.post("/api/text/warm")
            assert start.status_code == 200
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
        woof_model_dir=str(tmp_path / "woof"),
        woof_voice="juno",
    )
    app = create_app(down)
    from gloss.core.orchestrator import clip_key

    key = clip_key(down.preferences, card.word)
    filename = app.state.library.save_clip(key, b"mp3-bytes")
    card.audio = {"word": filename}
    app.state.library.save(card)

    with respx.mock(base_url="https://proxy.example") as router:
        route = router.post("/v1/chat/completions").mock(
            side_effect=[
                httpx.Response(503),
                httpx.Response(200, json={"choices": []}),
            ]
        )
        async with app.router.lifespan_context(app), client(app) as http:
            initial = (await http.get("/api/bootstrap")).json()
            assert initial["provider_ready"]
            assert initial["text_health"] == "off"
            assert route.call_count == 0
            http.headers["Origin"] = "http://127.0.0.1:8766"
            start = await http.post("/api/text/warm")
            assert start.status_code == 200
            data = await settled(http)
            assert data["text_health"] == "down"
            assert "503" in data["text_health_detail"]

            http.headers["Origin"] = "http://127.0.0.1:8766"
            prefs = down.preferences.model_dump()
            prefs["audio_engine"] = ""
            prefs["text_model"] = "gemini-3.8-pro"
            saved = await http.put("/api/settings", json=prefs)
            assert saved.status_code == 200
            assert saved.json()["audio_engine"] == "woof-juno-v2"
            assert app.state.library.get(card.id).audio == {"word": filename}
            for _ in range(200):
                health = (await http.get("/api/health")).json()
                if health["text_health"] == "ready":
                    break
                await asyncio.sleep(0.01)
            assert health["text_health"] == "ready"
            assert route.call_count == 2


async def test_patch_card_resets_decision_on_identity_change_and_clears_hash_on_edit(
    tmp_path, card
):
    app = create_app(Configuration(tmp_path), demo=True)
    card.note_id = 42
    card.sync_identity = card.base_identity()
    card.synced_hash = card.content_hash()
    card.decision = "overwrite"
    app.state.library.save(card)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://127.0.0.1:8766",
            headers={"Origin": "http://127.0.0.1:8766"},
        ) as http,
    ):
        payload = card.model_dump(include=set(CardFields))
        payload["meaning"] = "Updated account."
        edited = await http.patch(f"/api/cards/{card.id}", json=payload)
        assert edited.status_code == 200
        assert edited.json()["note_id"] == 42
        assert edited.json()["synced_hash"] == ""
        assert edited.json()["decision"] == "overwrite"

        payload["word"] = "recording"
        renamed = await http.patch(f"/api/cards/{card.id}", json=payload)
        assert renamed.status_code == 200
        assert renamed.json()["note_id"] is None
        assert renamed.json()["synced_hash"] == ""
        assert renamed.json()["decision"] == "ask"


def manual_item(index, word, **changes):
    return {
        "index": index,
        "source_word": word,
        "valid": True,
        "word": word,
        "pos": "noun",
        "meaning": "A short meaning.",
        "sinhala": "අර්ථය",
        "example1": "This is the first example.",
        "example2": "This is a second example.",
        "reason": "",
        **changes,
    }


async def test_manual_generation_resumes_25_word_batches_without_text_credentials(tmp_path):
    configuration = configured(tmp_path, text_api_base="", text_api_key="", google_cloud_project="")
    app = create_app(configuration)
    words = ["record: noun", "record: verb", *(f"word {i}" for i in range(3, 51))]
    origin = "http://127.0.0.1:8766"
    deck = f"{configuration.preferences.deck_parent}::General"
    async with app.router.lifespan_context(app), client(app) as http:
        http.headers["Origin"] = origin
        initial = (await http.get("/api/bootstrap")).json()
        assert not initial["provider_ready"]
        assert initial["manual"] is None
        assert initial["settings"]["manual_batch_size"] == 25
        response = await http.post(
            "/api/manual",
            json={
                "text": "\n".join(words),
                "deck": deck,
            },
        )
        assert response.status_code == 200, response.text
        first = response.json()
        assert first["current_count"] == 25
        assert first["total"] == 50
        assert first["number"] == 1
        assert "Teach English to a Sinhala-speaking" in first["full_prompt"]
        assert "Teach English to a Sinhala-speaking" not in first["short_prompt"]
        assert "same card-writing instructions" in first["short_prompt"]
        assert "word 25" in first["full_prompt"]
        assert "word 26" not in first["full_prompt"]
        assert "record" in first["full_prompt"]
        assert '"hint": "noun"' in first["full_prompt"]
        assert '"hint": "verb"' in first["full_prompt"]
        rows = [manual_item(i, word.split(":")[0]) for i, word in enumerate(words[:25], 1)]
        rows[1]["pos"] = "verb"
        rows[2].update(valid=False, reason="Intended word unclear.")
        import_path = "/api/manual/import"
        bad = await http.post(
            import_path,
            json={
                "reply": json.dumps({"batch": first["code"], "items": rows[1:] + rows[1:2]}),
            },
        )
        assert bad.status_code == 400
        assert "Missing row 1: record." in bad.json()["detail"]
        assert "Duplicate rows: 2." in bad.json()["detail"]
        bad_fields = await http.post(
            import_path,
            json={
                "reply": json.dumps(
                    {"batch": first["code"], "items": [rows[0] | {"meaning": ""}, *rows[1:]]}
                ),
            },
        )
        assert bad_fields.status_code == 400
        assert "Row 1:" in bad_fields.json()["detail"]
        wrong_word = await http.post(
            import_path,
            json={
                "reply": json.dumps(
                    {
                        "batch": first["code"],
                        "items": [rows[0] | {"source_word": "wrong"}, *rows[1:]],
                    }
                ),
            },
        )
        assert wrong_word.status_code == 400
        assert "expected the original word" in wrong_word.json()["detail"]
        assert app.state.library.count() == 0
        assert (await http.get("/api/bootstrap")).json()["manual"] == first
        fenced = (
            "```json\r\n" + json.dumps({"batch": first["code"], "items": rows[::-1]}) + "\r\n```"
        )
        imported = await http.post(import_path, json={"reply": fenced})
        assert imported.status_code == 200, imported.text
        data = imported.json()
        assert [card["hint"] for card in data["cards"][:2]] == ["noun", "verb"]
        assert data["cards"][2]["reason"] == "Intended word unclear."
        assert not data["cards"][2]["valid"]
        assert all(card["manual"] and not card["audio"] for card in data["cards"])
        assert app.state.library.count() == 25

    configuration = configured(tmp_path, text_api_base="", text_api_key="", google_cloud_project="")
    app = create_app(configuration)
    async with app.router.lifespan_context(app), client(app) as http:
        http.headers["Origin"] = origin
        second = (await http.get("/api/bootstrap")).json()["manual"]
        assert second["number"] == 2
        assert second["completed"] == 25
        assert second["current_count"] == 25
        assert second["code"] != first["code"]
        repeated = await http.post(import_path, json={"reply": fenced})
        assert repeated.status_code == 400
        assert "another batch" in repeated.json()["detail"]
        assert app.state.library.count() == 25
        rows = [manual_item(i, word) for i, word in enumerate(words[25:], 1)]
        reply = json.dumps({"batch": second["code"], "items": rows})
        imported = await http.post(import_path, json={"reply": reply})
        assert imported.status_code == 200, imported.text
        done = imported.json()["manual"]
        assert done["completed"] == 50
        assert done["current_count"] == 0
        assert app.state.library.count() == 50
        assert (await http.post(import_path, json={"reply": reply})).status_code == 409
        assert (await http.delete(f"/api/manual/{done['code']}")).status_code == 200
        assert (await http.get("/api/bootstrap")).json()["manual"] is None
        assert app.state.library.count() == 50


async def test_manual_batch_uses_saved_size_and_keeps_it_for_the_run(tmp_path):
    config = configured(tmp_path)
    app = create_app(config)
    async with app.router.lifespan_context(app), client(app) as http:
        http.headers["Origin"] = "http://127.0.0.1:8766"

        async def save_size(size):
            preferences = config.preferences.model_dump() | {"manual_batch_size": size}
            return await http.put("/api/settings", json=preferences)

        paste = {
            "text": "alpha; beta; gamma; delta; epsilon; zeta",
            "deck": f"{config.preferences.deck_parent}::General",
        }
        assert (await save_size(101)).status_code == 422
        assert (await save_size(2)).json()["manual_batch_size"] == 2
        start = await http.post("/api/manual", json=paste)
        assert start.status_code == 200, start.text
        run = start.json()
        assert run["current_count"] == 2
        assert (await save_size(3)).json()["manual_batch_size"] == 3

        reply = {"batch": run["code"], "items": [manual_item(1, "alpha"), manual_item(2, "beta")]}
        imported = await http.post("/api/manual/import", json={"reply": json.dumps(reply)})
        assert imported.status_code == 200, imported.text
        next_run = imported.json()["manual"]
        assert next_run["completed"] == 2
        assert next_run["current_count"] == 2
        assert "delta" in next_run["short_prompt"]
        assert "epsilon" not in next_run["short_prompt"]
        assert (await http.delete(f"/api/manual/{next_run['code']}")).status_code == 200
        next_start = await http.post("/api/manual", json=paste)
        assert next_start.json()["current_count"] == 3

    assert Configuration(tmp_path).preferences.manual_batch_size == 3


async def test_local_woof_audio_does_not_require_text_credentials(tmp_path, card, monkeypatch):
    configuration = configured(
        tmp_path,
        text_api_base="https://unused.example/v1",
        text_api_key="",
        google_cloud_project="",
        woof_model_dir=str(tmp_path),
    )
    synth = AsyncMock()
    synth.workers = 1
    monkeypatch.setattr("gloss.api.app.WoofSynthesizer", lambda *_args: synth)
    monkeypatch.setattr(
        "gloss.core.orchestrator.Orchestrator.audio",
        generate_test_audio := AsyncMock(
            return_value={"clips": 4, "ready": 4, "failed": 0, "skipped": 0}
        ),
    )
    app = create_app(configuration)
    app.state.library.save(card)
    async with app.router.lifespan_context(app), client(app) as http:
        http.headers["Origin"] = "http://127.0.0.1:8766"
        response = await http.post("/api/audio", json={"ids": [card.id]})
        assert response.status_code == 200, response.text
        await app.state.jobs.get(response.json()["id"]).task
        generate_test_audio.assert_awaited_once()
        assert generate_test_audio.await_args is not None
        assert generate_test_audio.await_args.args[2] is synth


async def test_woof_voice_switch_recreates_synth_without_google(tmp_path, card, monkeypatch):
    configuration = configured(
        tmp_path,
        google_cloud_project="configured-but-not-selected",
        woof_model_dir=str(tmp_path),
        woof_voice="juno",
    )
    variants = [AsyncMock(voice=voice, workers=1) for voice in ("juno", "mira")]
    build_woof = Mock(side_effect=variants)
    monkeypatch.setattr("gloss.api.app.WoofSynthesizer", build_woof)
    google = Mock(side_effect=AssertionError("Woof must not contact Google"))
    monkeypatch.setattr("gloss.api.app.make_client", google)
    audio = AsyncMock(return_value={"clips": 1, "ready": 1, "failed": 0, "skipped": 0})
    monkeypatch.setattr("gloss.core.orchestrator.Orchestrator.audio", audio)
    app = create_app(configuration)
    app.state.library.save(card)
    async with app.router.lifespan_context(app), client(app) as http:
        http.headers["Origin"] = "http://127.0.0.1:8766"

        async def record():
            response = await http.post("/api/audio", json={"ids": [card.id]})
            assert response.status_code == 200, response.text
            await app.state.jobs.get(response.json()["id"]).task

        await record()
        data = (await http.get("/api/bootstrap")).json()
        assert data["audio_voice"] == "juno"
        assert (
            await http.put("/api/settings", json={**data["settings"], "woof_voice": "Kore"})
        ).status_code == 422
        saved = await http.put("/api/settings", json={**data["settings"], "woof_voice": "mira"})
        assert saved.status_code == 200
        assert saved.json()["audio_engine"] == "woof-mira-v2"
        await record()
        data = (await http.get("/api/bootstrap")).json()
        assert data["audio_voice"] == "mira"
        variants[0].aclose.assert_awaited_once_with(wait=False)
        google.assert_not_called()
        assert [call.args[1] for call in build_woof.call_args_list] == ["juno", "mira"]
        assert [call.args[2] for call in audio.await_args_list] == variants

    assert Configuration(tmp_path).preferences.woof_voice == "mira"
