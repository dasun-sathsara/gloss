"""Local speech through Underdog Woof, an on-device voice model.

Woof is a small English text-to-speech model that runs on a CPU with numpy and no
network. Its weights are not bundled with Gloss: download them from
https://huggingface.co/ConwayResearch/Underdog-Woof and point WOOF_MODEL_DIR at that
folder. The weights are licensed for non-commercial use, so Gloss never ships them.
"""

import asyncio
import importlib
import io
import sys
import wave
from pathlib import Path

from gloss.core.ports import ProviderError
from gloss.providers.vertex import encode_mp3

WOOF_VOICES = ("juno", "mira")
WOOF_SAMPLE_RATE = 24000
# Woof pads short clips with up to 0.3 s of silence at each end. Keep a small
# breath around the speech, then even out loudness so cards play at one level.
LEAD_SECONDS = 0.04
TAIL_SECONDS = 0.15
TARGET_RMS = 0.10
PEAK_CEILING = 0.89
WOOF_BITRATE = "96k"


def load_model(model_dir: Path, voice: str):
    """Import the model code from its folder and load one voice.

    The model ships as a folder (`underdog_woof/` plus `woof_int8.npz`), not a package,
    so its folder goes on sys.path for the import.
    """
    if not (model_dir / "woof_int8.npz").is_file() or not (model_dir / "underdog_woof").is_dir():
        raise ProviderError(
            "WOOF_MODEL_DIR must hold the Underdog Woof files. Download them from "
            "huggingface.co/ConwayResearch/Underdog-Woof into that folder.",
            fatal=True,
        )
    if voice not in WOOF_VOICES:
        raise ProviderError(f"WOOF_VOICE must be juno or mira, not {voice}.", fatal=True)
    if str(model_dir) not in sys.path:
        sys.path.insert(0, str(model_dir))
    try:
        module = importlib.import_module("underdog_woof")
        return module.Woof(voice=voice)
    except Exception as exc:
        raise ProviderError(
            "Woof could not load. Check WOOF_MODEL_DIR and that numpy is installed.",
            fatal=True,
        ) from exc


def trim_and_level(audio):
    """Trim Woof's leading and trailing silence, then even out the clip's level."""
    import numpy as np

    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    window = max(1, int(0.01 * WOOF_SAMPLE_RATE))
    if samples.size >= window:
        frames = samples[: samples.size - samples.size % window].reshape(-1, window)
        envelope = np.abs(frames).max(axis=1)
        # Ignore anything 34 dB below the loudest frame, which is room tone in
        # practice, and keep a short breath around the speech.
        threshold = max(0.01, float(envelope.max()) * 0.02) if envelope.size else 0.01
        loud = np.flatnonzero(envelope > threshold)
        if loud.size:
            start = max(0, loud[0] * window - int(LEAD_SECONDS * WOOF_SAMPLE_RATE))
            end = min(
                samples.size,
                (loud[-1] + 1) * window + int(TAIL_SECONDS * WOOF_SAMPLE_RATE),
            )
            samples = samples[start:end]
    rms = float(np.sqrt(np.mean(samples**2))) if samples.size else 0.0
    if rms > 0:
        gain = TARGET_RMS / rms
        peak = float(np.abs(samples).max())
        if peak * gain > PEAK_CEILING:
            gain = PEAK_CEILING / peak
        samples = (samples * gain).astype(np.float32)
    return samples


def to_wav_bytes(audio) -> bytes:
    """Wrap Woof's float32 mono samples as the 24 kHz 16-bit WAV that encode_mp3 reads."""
    import numpy as np

    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if samples.size == 0:
        raise ProviderError("Woof returned an empty clip. Retry it.", retryable=True)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with io.BytesIO() as buffer:
        with wave.open(buffer, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(WOOF_SAMPLE_RATE)
            handle.writeframes(pcm.tobytes())
        return buffer.getvalue()


class WoofSynthesizer:
    """Synthesizer backed by a local Woof model folder."""

    def __init__(self, model_dir: Path, voice: str = "juno", seed: int = 0):
        self.model_dir = model_dir
        self.voice = voice
        self.seed = seed
        self.last_usage: dict = {}
        self._model = None
        # Woof keeps one module-level random generator, so two clips in flight would
        # share it. Gloss records two clips at a time; run them one after another.
        self._lock = asyncio.Lock()

    def _model_or_load(self):
        if self._model is None:
            self._model = load_model(self.model_dir, self.voice)
        return self._model

    async def synthesize(self, text: str) -> bytes:
        # Woof is plain Python and numpy, so it belongs on a worker thread. Loading is
        # lazy because a batch may never reach the audio stage.
        async with self._lock:
            model = await asyncio.to_thread(self._model_or_load)
            try:
                audio = await asyncio.to_thread(model, text, seed=self.seed)
            except ProviderError:
                raise
            except Exception as exc:
                raise ProviderError(
                    "Woof could not speak this clip. Retry it.", retryable=True
                ) from exc
        return await asyncio.to_thread(
            lambda: encode_mp3(to_wav_bytes(trim_and_level(audio)), WOOF_BITRATE)
        )
