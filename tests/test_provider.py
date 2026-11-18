import json

import httpx
import pytest
import respx

from gloss.config import Configuration, Preferences
from gloss.core.models import Entry
from gloss.core.ports import ProviderError
from gloss.providers.openai_compat import ChatCompletionsLanguageModel

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
    schema = body["response_format"]["json_schema"]["schema"]
    assert "$ref" not in json.dumps(schema)
    assert "$defs" not in schema
    assert set(schema["properties"]["items"]["items"]["required"]) == {
        "index",
        "valid",
        "word",
        "pos",
        "meaning",
        "sinhala",
        "example1",
        "example2",
    }
    assert route.calls[0].request.headers["authorization"] == "Bearer sk-test"


async def test_endpoint_retries_cold_timeout_and_classifies_errors():
    with pytest.raises(ProviderError):
        ChatCompletionsLanguageModel("proxy.example", "sk-test", Preferences())
    with pytest.raises(ProviderError):
        ChatCompletionsLanguageModel(BASE, "", Preferences())

    with respx.mock(base_url=BASE) as router:
        route = router.post("/chat/completions")
        value = model()
        try:
            route.mock(
                side_effect=[httpx.ReadTimeout("cold start"), httpx.Response(200, json=reply())]
            )
            results = await value.generate([ENTRY])
            assert results[0].word == "serendipity"
            assert route.call_count == 2

            route.mock(return_value=httpx.Response(401))
            with pytest.raises(ProviderError) as auth:
                await value.generate([ENTRY])
            assert auth.value.fatal

            route.mock(return_value=httpx.Response(429))
            with pytest.raises(ProviderError) as limited:
                await value.generate([ENTRY])
            assert limited.value.rate_limited

            route.mock(return_value=httpx.Response(503))
            with pytest.raises(ProviderError) as broken:
                await value.generate([ENTRY])
            assert broken.value.retryable
            assert not broken.value.fatal

            route.mock(side_effect=httpx.ReadTimeout("slow"))
            with pytest.raises(ProviderError) as timed_out:
                await value.generate([ENTRY])
            assert timed_out.value.retryable
        finally:
            await value.aclose()


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


def test_parse_generated_accepts_top_level_array_and_single_typo_repair():
    from gloss.providers.text import parse_generated

    entry = Entry(index=4, word="recieve", hint="")
    item = {
        "index": 0,
        "valid": True,
        "word": "receive",
        "pos": "verb",
        "meaning": "To get something.",
        "sinhala": "ලැබෙනවා",
        "example1": "Did you receive my message?",
        "example2": "They will receive the package tomorrow.",
        "reason": "",
    }
    parsed = parse_generated(json.dumps([item]), [entry])
    assert len(parsed) == 1
    assert parsed[0].index == 4
    assert parsed[0].word == "receive"
