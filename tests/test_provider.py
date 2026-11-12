import json

import httpx
import pytest
import respx

from gloss.config import Configuration, Preferences
from gloss.core.models import Entry
from gloss.core.ports import ProviderError
from gloss.providers.openai_compat import ChatCompletionsLanguageModel
from gloss.providers.text import TEXT_SCHEMA

BASE = "https://proxy.example/v1"
ENTRY = Entry(index=0, word="serendipity", hint="")


def reply(**overrides) -> dict:
    item = {
        "index": 0,
        "valid": True,
        "word": "serendipity",
        "pos": "noun",
        "meaning": "A lucky discovery.",
        "sinhala": "සුබ නිමිත්ත",
        "example1": "Finding the letter was serendipity.",
        "example2": "Pure serendipity brought them together.",
        "reason": "",
    }
    item.update(overrides)
    return {"choices": [{"message": {"content": json.dumps({"items": [item]})}}]}


def model(**kwargs) -> ChatCompletionsLanguageModel:
    return ChatCompletionsLanguageModel(BASE, "sk-test", Preferences(**kwargs))


def test_schema_is_self_contained():
    assert "$ref" not in json.dumps(TEXT_SCHEMA)
    assert "$defs" not in TEXT_SCHEMA
    item = TEXT_SCHEMA["properties"]["items"]["items"]
    assert set(item["required"]) == {
        "index",
        "valid",
        "word",
        "pos",
        "meaning",
        "sinhala",
        "example1",
        "example2",
    }


async def test_generate_sends_schema_and_parses_reply():
    with respx.mock(base_url=BASE) as router:
        route = router.post("/chat/completions").mock(
            return_value=httpx.Response(200, json=reply())
        )
        value = model()
        try:
            results = await value.generate([ENTRY])
        finally:
            await value.aclose()
    assert results[0].word == "serendipity"
    assert results[0].index == 0
    body = json.loads(route.calls[0].request.content)
    assert body["model"] == "gemini-3.8-flash"
    assert body["max_tokens"] == 8192
    assert body["stream"] is False
    assert body["response_format"]["type"] == "json_schema"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert route.calls[0].request.headers["authorization"] == "Bearer sk-test"


async def test_auth_failure_is_fatal():
    with respx.mock(base_url=BASE) as router:
        router.post("/chat/completions").mock(return_value=httpx.Response(401))
        value = model()
        try:
            with pytest.raises(ProviderError) as caught:
                await value.generate([ENTRY])
        finally:
            await value.aclose()
    assert caught.value.fatal


async def test_rate_limit_and_server_errors_recover():
    with respx.mock(base_url=BASE) as router:
        router.post("/chat/completions").mock(return_value=httpx.Response(429))
        value = model()
        try:
            with pytest.raises(ProviderError) as limited:
                await value.generate([ENTRY])
        finally:
            await value.aclose()
    assert limited.value.rate_limited

    with respx.mock(base_url=BASE) as router:
        router.post("/chat/completions").mock(return_value=httpx.Response(503))
        value = model()
        try:
            with pytest.raises(ProviderError) as broken:
                await value.generate([ENTRY])
        finally:
            await value.aclose()
    assert broken.value.retryable
    assert not broken.value.fatal


async def test_timeout_then_success_retries_once():
    with respx.mock(base_url=BASE) as router:
        route = router.post("/chat/completions").mock(
            side_effect=[httpx.ReadTimeout("cold start"), httpx.Response(200, json=reply())]
        )
        value = model()
        try:
            results = await value.generate([ENTRY])
        finally:
            await value.aclose()
    assert results[0].word == "serendipity"
    assert route.call_count == 2


async def test_timeout_is_retryable():
    with respx.mock(base_url=BASE) as router:
        router.post("/chat/completions").mock(side_effect=httpx.ReadTimeout("slow"))
        value = model()
        try:
            with pytest.raises(ProviderError) as caught:
                await value.generate([ENTRY])
        finally:
            await value.aclose()
    assert caught.value.retryable


def test_base_url_and_key_are_required(tmp_path):
    with pytest.raises(ProviderError):
        ChatCompletionsLanguageModel("proxy.example", "sk-test", Preferences())
    with pytest.raises(ProviderError):
        ChatCompletionsLanguageModel(BASE, "", Preferences())


async def test_api_generates_without_audio_when_only_the_endpoint_is_configured(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("TEXT_API_BASE", BASE)
    monkeypatch.setenv("TEXT_API_KEY", "sk-test")
    from gloss.api.app import create_app

    configuration = Configuration(tmp_path)
    configuration.preferences.batch_size = 1
    app = create_app(configuration)
    with respx.mock(base_url=BASE) as router:
        router.post("/chat/completions").mock(return_value=httpx.Response(200, json=reply()))
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://127.0.0.1:8766",
                headers={"Origin": "http://127.0.0.1:8766"},
            ) as http,
        ):
            bootstrap = (await http.get("/api/bootstrap")).json()
            assert bootstrap["provider_ready"] is True
            assert bootstrap["audio_ready"] is False
            assert bootstrap["text_provider"] == "endpoint"
            response = await http.post(
                "/api/generate", json={"text": "serendipity", "deck": "Gloss::General"}
            )
            job = app.state.jobs.get(response.json()["id"])
            await job.task
            summary = next(event["data"] for event in job.events if event["event"] == "summary")
            assert summary == {"words": 1, "needs_review": 0}
            cards = app.state.library.all()
            assert cards[0].word == "serendipity"
            assert cards[0].audio == {}
            selected = await http.post("/api/audio", json={"ids": [cards[0].id]})
            assert selected.status_code == 400
    app.state.library.close()
