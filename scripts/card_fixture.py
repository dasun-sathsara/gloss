"""Render synthetic Anki card fixtures for browser QA, without writing to Anki."""

import html
import json
import re
import sys

from gloss.anki.templates import BACK, FRONT, css, fields
from gloss.core.models import CLIP_KINDS, Card

card = Card(
    word="resilient",
    pos="adjective",
    meaning="Able to recover after difficulties or setbacks.",
    sinhala="අභියෝග හමුවේ නොසැලී සිටින",
    example1="The resilient community rebuilt after the storm.",
    example2="She remained resilient through a difficult year.",
    deck="Gloss::Vocabulary",
    audio={kind: f"gloss_{kind}.mp3" for kind in CLIP_KINDS},
)
if "--long" in sys.argv:
    card.word = "characteristically"
    card.meaning *= 4
    card.sinhala *= 4
    card.example1 *= 4
    card.example2 *= 4
if "--missing-audio" in sys.argv:
    card.audio = {}
values = fields(card, "fixture")
values["Deck"] = html.escape(card.deck)
if "--legacy-audio" in sys.argv:
    for key in ("Meaning Audio", "Example 1 Audio", "Example 2 Audio"):
        values[key] = values[key].replace("<audio ", "<audio controls ")


def render(template: str) -> str:
    template = re.sub(
        r"{{#([^}]+)}}(.*?){{/\1}}",
        lambda match: match[2] if values.get(match[1]) else "",
        template,
        flags=re.DOTALL,
    )
    template = re.sub(r"{{([^}]+)}}", lambda match: values[match[1]], template)
    # The desktop reviewer replaces this sound tag with its native replay link.
    return re.sub(
        r"\[sound:[^]]+\]",
        '<a class="replay-button" href="#" onclick="return false">'
        '<svg width="32" height="32"><circle cx="16" cy="16" r="15"/></svg></a>',
        template,
    )


print(json.dumps({"front": render(FRONT), "back": render(BACK), "css": css()}))
