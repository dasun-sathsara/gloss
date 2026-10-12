import html
import json
from pathlib import Path

from gloss.core.models import Card, ClipKind

ASSETS = Path(__file__).resolve().parents[1] / "assets"
FONT_NAMES = {
    "_StudioFeixenSansVariable.ttf",
    "_GeistMonoVariable.ttf",
    "_GeistMonoVariable-Italic.ttf",
    "_NotoSansSinhalaVariable.ttf",
    "_Geist-Mono-OFL.txt",
    "_Noto-Sans-Sinhala-OFL.txt",
}


def available_fonts(private: Path) -> dict[str, Path]:
    result = {
        name: ASSETS / "fonts" / name for name in FONT_NAMES if (ASSETS / "fonts" / name).is_file()
    }
    result.update({name: private / name for name in FONT_NAMES if (private / name).is_file()})
    return result


FIELDS = [
    "Identity",
    "Word",
    "Part of Speech",
    "Word Audio",
    "English Meaning",
    "Meaning Audio",
    "Example 1",
    "Example 1 Audio",
    "Example 2",
    "Example 2 Audio",
    "Sinhala Meaning",
]
_ICONS = json.loads((ASSETS / "playback-icons.json").read_text(encoding="utf-8"))["icons"]
_SCRIPT = (
    "<script>"
    + (ASSETS / "vocabulary.js")
    .read_text(encoding="utf-8")
    .replace(
        "/* Phosphor playback icons */",
        f"var playIcon = {json.dumps(_ICONS['play'])};\n"
        f"var stopIcon = {json.dumps(_ICONS['stop'])};",
    )
    + "</script>"
)
FRONT = (
    """<article class="flashcard gloss-card gloss-front">
<header class="meta-info"><div class="deck gloss-deck">{{Deck}}</div></header>
<div class="main"><div class="question front">
<div class="field field--front gloss-word">{{Word}}</div>
{{#Part of Speech}}<div class="gloss-pos">{{Part of Speech}}</div>{{/Part of Speech}}
</div></div></article>"""
    + _SCRIPT
)
BACK = (
    """<article class="flashcard gloss-card gloss-back">
<header class="meta-info"><div class="deck gloss-deck">{{Deck}}</div></header>
<div class="main">
<div class="question back gloss-word-row"><div>
<div class="field field--front gloss-word">{{Word}}</div>
{{#Part of Speech}}<div class="gloss-pos">{{Part of Speech}}</div>{{/Part of Speech}}</div>
<div class="gloss-word-audio">{{Word Audio}}</div></div>
<div class="divider"></div><div class="answer back">
<section class="gloss-definition" aria-label="Meaning">
<div class="gloss-line"><div class="field field--back gloss-meaning">{{English Meaning}}</div>
<div class="gloss-audio" data-label="Play definition audio">{{Meaning Audio}}</div></div>
{{#Sinhala Meaning}}<div class="gloss-sinhala" lang="si">{{Sinhala Meaning}}</div>
{{/Sinhala Meaning}}</section>
<ol class="field field--extra gloss-examples" aria-label="Examples">
{{#Example 1}}<li><div class="gloss-line"><div>{{Example 1}}</div>
<div class="gloss-audio" data-label="Play example 1 audio">{{Example 1 Audio}}</div></div></li>
{{/Example 1}}
{{#Example 2}}<li><div class="gloss-line"><div>{{Example 2}}</div>
<div class="gloss-audio" data-label="Play example 2 audio">{{Example 2 Audio}}</div></div></li>
{{/Example 2}}</ol>
<p class="gloss-audio-error" role="status" hidden></p>
</div></div></article>"""
    + _SCRIPT
)


def css() -> str:
    return (ASSETS / "jade-glass.css").read_text(encoding="utf-8") + (
        ASSETS / "vocabulary.css"
    ).read_text(encoding="utf-8")


def fields(card: Card, key: str) -> dict[str, str]:
    def manual(kind: ClipKind) -> str:
        filename = card.audio.get(kind)
        # A real src attribute in a note field keeps media discoverable by Anki's checker.
        return (
            (f'<audio preload="none" src="{html.escape(filename, quote=True)}"></audio>')
            if filename
            else ""
        )

    word_audio = card.audio.get("word", "")
    return {
        "Identity": key,
        "Word": html.escape(card.word),
        "Part of Speech": html.escape(card.pos),
        "English Meaning": html.escape(card.meaning),
        "Sinhala Meaning": html.escape(card.sinhala),
        "Example 1": html.escape(card.example1),
        "Example 2": html.escape(card.example2),
        "Word Audio": f"[sound:{word_audio}]" if word_audio else "",
        "Meaning Audio": manual("meaning"),
        "Example 1 Audio": manual("example1"),
        "Example 2 Audio": manual("example2"),
    }
