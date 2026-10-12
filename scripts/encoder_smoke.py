"""Verify that the bundled encoder writes decodable MP3 without system FFmpeg."""

import io
import math
import struct
import subprocess
import wave

import imageio_ffmpeg

from gloss.providers.vertex import encode_mp3

output = io.BytesIO()
with wave.open(output, "wb") as wav:
    wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
    wav.writeframes(
        b"".join(struct.pack("<h", int(1000 * math.sin(i * 0.1))) for i in range(24000))
    )
encoded = encode_mp3(output.getvalue())
decoded = subprocess.run(
    [imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", "pipe:0", "-f", "s16le", "pipe:1"],
    input=encoded,
    capture_output=True,
    check=True,
)
assert len(decoded.stdout) >= 48000
print(f"Bundled encoder passed: {len(encoded)} MP3 bytes; {len(decoded.stdout)} decoded PCM bytes.")
