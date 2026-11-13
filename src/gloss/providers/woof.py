"""Local speech through Underdog Woof, an on-device voice model.

Woof is a small English text-to-speech model that runs on a CPU with numpy and no
network. Its weights are not bundled with Gloss: download them from
https://huggingface.co/ConwayResearch/Underdog-Woof and point WOOF_MODEL_DIR at that
folder. The weights are licensed for non-commercial use, so Gloss never ships them.
"""

import asyncio
import importlib
import io
import multiprocessing
import os
import sys
import wave
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
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

_BLAS_THREAD_VARS = (
    "OPENBLAS_NUM_THREADS",
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "BLIS_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)
_worker_model = None


def default_workers() -> int:
    return max(1, os.process_cpu_count() or os.cpu_count() or 1)


def validate_model(model_dir: Path, voice: str) -> None:
    if not (model_dir / "woof_int8.npz").is_file() or not (model_dir / "underdog_woof").is_dir():
        raise ProviderError(
            "WOOF_MODEL_DIR must hold the Underdog Woof files. Download them from "
            "huggingface.co/ConwayResearch/Underdog-Woof into that folder.",
            fatal=True,
        )
    if voice not in WOOF_VOICES:
        raise ProviderError(f"WOOF_VOICE must be juno or mira, not {voice}.", fatal=True)


def load_model(model_dir: Path, voice: str):
    """Import the model code from its folder and load one voice.

    The model ships as a folder (`underdog_woof/` plus `woof_int8.npz`), not a package,
    so its folder goes on sys.path for the import.
    """
    validate_model(model_dir, voice)
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


def _init_worker(model_dir: Path, voice: str) -> None:
    # Pin BLAS and OpenMP to one thread per worker before numpy loads so N workers
    # do not oversubscribe N cores with N*N threads.
    for name in _BLAS_THREAD_VARS:
        os.environ[name] = "1"
    global _worker_model
    _worker_model = load_model(model_dir, voice)


def _synthesize_worker(text: str, seed: int) -> bytes:
    assert _worker_model is not None
    try:
        audio = _worker_model(text, seed=seed)
    except ProviderError:
        raise
    except Exception as exc:
        raise ProviderError("Woof could not speak this clip. Retry it.", retryable=True) from exc
    return encode_mp3(to_wav_bytes(trim_and_level(audio)), WOOF_BITRATE)


class WoofSynthesizer:
    """Synthesizer backed by a local Woof model folder."""

    def __init__(
        self,
        model_dir: Path,
        voice: str = "juno",
        seed: int = 0,
        workers: int | None = None,
    ):
        self.model_dir = model_dir
        self.voice = voice
        self.seed = seed
        self.workers = max(1, default_workers() if workers is None else workers)
        self.last_usage: dict = {}
        self._model = None
        # Single-worker mode runs in-process and must serialize Woof's module-level RNG.
        self._lock = asyncio.Lock()
        self._pool: ProcessPoolExecutor | None = None
        self._pool_lock = asyncio.Lock()

    def _model_or_load(self):
        if self._model is None:
            self._model = load_model(self.model_dir, self.voice)
        return self._model

    async def _ensure_pool(self) -> ProcessPoolExecutor:
        async with self._pool_lock:
            if self._pool is None:
                validate_model(self.model_dir, self.voice)
                self._pool = ProcessPoolExecutor(
                    max_workers=self.workers,
                    mp_context=multiprocessing.get_context("spawn"),
                    initializer=_init_worker,
                    initargs=(self.model_dir, self.voice),
                )
            return self._pool

    def _reset_pool(self, broken: ProcessPoolExecutor) -> None:
        if self._pool is broken:
            self._pool = None
            broken.shutdown(wait=False, cancel_futures=True)

    async def synthesize(self, text: str) -> bytes:
        # Woof is plain Python and numpy with a module-level RNG, so multi-core runs
        # isolate one model per worker process instead of sharing threads.
        if self.workers == 1:
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
        pool = await self._ensure_pool()
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(pool, _synthesize_worker, text, self.seed)
        except BrokenProcessPool as exc:
            self._reset_pool(pool)
            raise ProviderError(
                "Woof worker stopped unexpectedly. Retry this clip.", retryable=True
            ) from exc

    async def aclose(self, *, wait: bool = True) -> None:
        pool = self._pool
        self._pool = None
        if pool is not None:
            if wait:
                await asyncio.to_thread(pool.shutdown, wait=True, cancel_futures=True)
            else:
                pool.shutdown(wait=False, cancel_futures=True)
