import asyncio
import io
import time
import wave

import httpx
import numpy as np
import pytest

from gloss.api.app import create_app
from gloss.config import Configuration, Environment, Preferences
from gloss.core.orchestrator import clip_key
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
    synthesizer = woof.WoofSynthesizer(tmp_path, workers=1)
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
    assert data["audio_provider"] == "woof"
    assert data["audio_voice"] == "juno"
    assert data["provider_ready"] is True
    assert data["text_provider"] == "endpoint"


async def test_synthesizer_serializes_clips_in_single_worker_mode(tmp_path, monkeypatch):
    # In single-worker mode, Woof shares one module-level RNG so clips must not overlap.
    state = {"active": 0, "peak": 0}

    class FakeWoof:
        def __call__(self, text, seed=0):
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
            time.sleep(0.05)
            state["active"] -= 1
            return np.zeros(2400, dtype=np.float32)

    monkeypatch.setattr(woof, "load_model", lambda directory, voice: FakeWoof())
    synthesizer = woof.WoofSynthesizer(tmp_path, workers=1)
    await asyncio.gather(synthesizer.synthesize("one"), synthesizer.synthesize("two"))
    assert state["peak"] == 1


async def test_synthesizer_parallelizes_across_workers(tmp_path):
    package = tmp_path / "underdog_woof"
    package.mkdir()
    (tmp_path / "woof_int8.npz").write_bytes(b"")
    marker_dir = tmp_path / "markers"
    marker_dir.mkdir()
    (package / "__init__.py").write_text(
        "import os, time\n"
        "from pathlib import Path\n"
        "import numpy as np\n"
        "class Woof:\n"
        "    def __init__(self, voice='juno'):\n"
        "        assert os.environ.get('OPENBLAS_NUM_THREADS') == '1'\n"
        "        self.voice = voice\n"
        "    def __call__(self, text, seed=0):\n"
        f"        markers = Path({str(marker_dir)!r})\n"
        "        (markers / f'{os.getpid()}.seen').write_text(text)\n"
        "        deadline = time.monotonic() + 5.0\n"
        "        while len(list(markers.glob('*.seen'))) < 2 and time.monotonic() < deadline:\n"
        "            time.sleep(0.02)\n"
        "        return np.full(2400, 0.1, dtype=np.float32)\n"
    )
    synthesizer = woof.WoofSynthesizer(tmp_path, workers=2)
    try:
        clips = await asyncio.gather(
            synthesizer.synthesize("one"),
            synthesizer.synthesize("two"),
        )
    finally:
        await synthesizer.aclose()
    assert len(clips) == 2
    assert all(len(clip) > 100 for clip in clips)
    assert len(list(marker_dir.glob("*.seen"))) == 2


def test_clip_key_names_the_local_engine():
    google = Preferences()
    juno = Preferences(audio_engine="woof-juno-v2")
    mira = Preferences(audio_engine="woof-mira-v2")
    assert clip_key(google, "serene") == clip_key(google.model_copy(), "serene")
    assert clip_key(google, "serene") != clip_key(juno, "serene")
    assert clip_key(juno, "serene") != clip_key(mira, "serene")


def test_config_selects_the_local_engine(tmp_path):
    (tmp_path / ".env").write_text("WOOF_MODEL_DIR=/models/woof\nWOOF_VOICE=mira\n")
    configuration = Configuration(tmp_path)
    assert configuration.preferences.audio_engine == "woof-mira-v2"

    (tmp_path / ".env").write_text("TEXT_API_BASE=https://example.test/v1\n")
    assert Configuration(tmp_path).preferences.audio_engine == ""


def test_trim_removes_padding_and_keeps_a_breath():
    samples = np.zeros(24000, dtype=np.float32)  # 1 s of silence
    tone = 0.3 * np.sin(2 * np.pi * 220 * np.arange(12000) / 24000)
    samples[6000:18000] = tone
    trimmed = woof.trim_and_level(samples)
    expected = 12000 + int((woof.LEAD_SECONDS + woof.TAIL_SECONDS) * 24000)
    assert abs(len(trimmed) - expected) <= 240
    assert abs(trimmed[0]) < 0.05


def test_trim_levels_the_clip():
    quiet = 0.02 * np.sin(2 * np.pi * 220 * np.arange(24000) / 24000)
    levelled = woof.trim_and_level(quiet)
    rms = float(np.sqrt(np.mean(levelled**2)))
    assert abs(rms - woof.TARGET_RMS) < 0.01
    assert float(np.abs(levelled).max()) <= woof.PEAK_CEILING + 1e-4


def test_trim_respects_the_peak_ceiling():
    loud = 0.99 * np.ones(24000, dtype=np.float32)
    levelled = woof.trim_and_level(loud)
    assert float(np.abs(levelled).max()) <= woof.PEAK_CEILING + 1e-4


async def test_bootstrap_names_the_google_engine(tmp_path):
    (tmp_path / ".env").write_text("GOOGLE_CLOUD_PROJECT=test-project\n")
    app = create_app(Configuration(tmp_path))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://127.0.0.1:8766",
        ) as http,
    ):
        data = (await http.get("/api/bootstrap")).json()
    assert data["audio_provider"] == "google"
    assert data["audio_ready"] is True
