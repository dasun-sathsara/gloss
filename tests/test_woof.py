import asyncio
import io
import time
import wave

import httpx
import numpy as np
import pytest

from gloss.api.app import create_app
from gloss.config import Configuration, Environment
from gloss.core.ports import ProviderError
from gloss.providers import woof


def test_environment_defaults_and_overrides(tmp_path):
    assert Environment(_env_file=None).woof_model_dir == ""
    assert Environment(_env_file=None).woof_voice == "juno"

    env_file = tmp_path / ".env"
    env_file.write_text("WOOF_MODEL_DIR=/models/woof\nWOOF_VOICE=mira\n")
    environment = Environment(_env_file=env_file)
    assert environment.woof_model_dir == "/models/woof"
    assert environment.woof_voice == "mira"


def test_missing_model_folder_is_fatal(tmp_path):
    with pytest.raises(ProviderError) as error:
        woof.load_model(tmp_path, "juno")
    assert error.value.fatal
    assert "WOOF_MODEL_DIR" in str(error.value)


def test_unknown_voice_is_rejected(tmp_path):
    (tmp_path / "underdog_woof").mkdir()
    (tmp_path / "woof_int8.npz").write_bytes(b"")
    with pytest.raises(ProviderError) as error:
        woof.load_model(tmp_path, "rex")
    assert error.value.fatal
    assert "juno or mira" in str(error.value)


def test_float_samples_become_a_24khz_wav():
    samples = np.zeros(2400, dtype=np.float32)
    samples[100] = 0.5
    samples[200] = -1.5  # clipped, not wrapped
    with wave.open(io.BytesIO(woof.to_wav_bytes(samples))) as handle:
        assert handle.getnchannels() == 1
        assert handle.getsampwidth() == 2
        assert handle.getframerate() == 24000
        assert handle.getnframes() == 2400
        frames = handle.readframes(2400)
    assert int.from_bytes(frames[200:202], "little", signed=True) == 16383
    assert int.from_bytes(frames[400:402], "little", signed=True) == -32767


def test_empty_audio_is_retryable():
    with pytest.raises(ProviderError) as error:
        woof.to_wav_bytes(np.zeros(0, dtype=np.float32))
    assert error.value.retryable


async def test_synthesizer_encodes_mp3(tmp_path, monkeypatch):
    class FakeWoof:
        def __call__(self, text, seed=0):
            assert text == "serene"
            assert seed == 0
            return np.full(24000, 0.1, dtype=np.float32)

    monkeypatch.setattr(woof, "load_model", lambda directory, voice: FakeWoof())
    synthesizer = woof.WoofSynthesizer(tmp_path)
    data = await synthesizer.synthesize("serene")
    assert data[:3] == b"ID3" or data[:2] == b"\xff\xfb"
    assert len(data) > 100


async def test_bootstrap_reports_audio_ready_with_only_woof(tmp_path):
    (tmp_path / ".env").write_text(
        "WOOF_MODEL_DIR=/models/woof\nTEXT_API_BASE=https://example.test/v1\nTEXT_API_KEY=test\n"
    )
    app = create_app(Configuration(tmp_path))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://127.0.0.1:8766",
        ) as http,
    ):
        data = (await http.get("/api/bootstrap")).json()
    assert data["audio_ready"] is True
    assert data["provider_ready"] is True
    assert data["text_provider"] == "endpoint"


async def test_synthesizer_serializes_clips(tmp_path, monkeypatch):
    # Woof shares one module-level RNG, so concurrent clips must not overlap.
    state = {"active": 0, "peak": 0}

    class FakeWoof:
        def __call__(self, text, seed=0):
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
            time.sleep(0.05)
            state["active"] -= 1
            return np.zeros(2400, dtype=np.float32)

    monkeypatch.setattr(woof, "load_model", lambda directory, voice: FakeWoof())
    synthesizer = woof.WoofSynthesizer(tmp_path)
    await asyncio.gather(synthesizer.synthesize("one"), synthesizer.synthesize("two"))
    assert state["peak"] == 1
