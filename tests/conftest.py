from pathlib import Path

import pytest

from gloss.config import Preferences
from gloss.core.models import Card
from gloss.library.store import Library


@pytest.fixture
def library(tmp_path: Path):
    value = Library(tmp_path)
    yield value
    value.close()


@pytest.fixture
def card() -> Card:
    return Card(
        word="record",
        pos="noun",
        meaning="A written account.",
        sinhala="වාර්තාව",
        example1="Keep a record of each sale.",
        example2="I read the record.",
        valid=True,
        source_word="record",
        deck="Gloss::General",
    )


@pytest.fixture
def preferences() -> Preferences:
    return Preferences(tts_rpm=120)
