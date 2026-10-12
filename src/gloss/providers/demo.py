"""Offline development fixtures. Enabled only by the explicit --demo flag."""

import asyncio
import io
import math
import struct
import wave

from gloss.core.models import Entry, Generated
from gloss.providers.vertex import encode_mp3

DATA = {
    "curious": (
        "adjective",
        "Wanting to know or learn about something.",
        "කුතුහලයෙන් පිරි; දැනගැනීමට කැමති",
        "The curious child asked how the clock worked.",
        "I am curious about your new project.",
    ),
    "resilient": (
        "adjective",
        "Able to recover after a difficult experience.",
        "දුෂ්කරතාවලින් පසු යළි නැගී සිටිය හැකි",
        "The team stayed resilient after losing the match.",
        "These plants are resilient in dry weather.",
    ),
    "record": (
        "noun",
        "Information kept so you can look at it later.",
        "වාර්තාව; සටහන",
        "Keep a record of what you spend.",
        "The school has a record of each student's results.",
    ),
}


class DemoLanguageModel:
    async def generate(self, entries: list[Entry]) -> list[Generated]:
        await asyncio.sleep(0.3)
        result = []
        for entry in entries:
            data = DATA.get(entry.word.lower())
            if data:
                result.append(
                    Generated(
                        index=entry.index,
                        valid=True,
                        word=entry.word.lower(),
                        pos=data[0],
                        meaning=data[1],
                        sinhala=data[2],
                        example1=data[3],
                        example2=data[4],
                    )
                )
            else:
                result.append(
                    Generated(
                        index=entry.index,
                        valid=False,
                        word=entry.word,
                        reason="Offline demo includes curious, resilient, and record only.",
                    )
                )
        return result


class DemoSynthesizer:
    async def synthesize(self, text: str) -> bytes:
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            wav.writeframes(
                b"".join(struct.pack("<h", int(500 * math.sin(i * 0.08))) for i in range(4800))
            )
        return await asyncio.to_thread(encode_mp3, output.getvalue())
