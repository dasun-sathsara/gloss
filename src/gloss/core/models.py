from __future__ import annotations

import hashlib
import unicodedata
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, model_validator

ClipKind = Literal["word", "meaning", "example1", "example2"]
CLIP_KINDS: tuple[ClipKind, ...] = ("word", "meaning", "example1", "example2")
Decision = Literal["ask", "overwrite", "keep_both", "skip"]


def normalized(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def identity(word: str, pos: str) -> str:
    # Hashing avoids Anki query syntax ambiguity for punctuation and quotes.
    return hashlib.sha256(f"{normalized(word)}\0{normalized(pos)}".encode()).hexdigest()


class Entry(BaseModel):
    index: int
    word: str
    hint: str = ""
    duplicate: bool = False
    warning: str = ""


class Generated(BaseModel):
    index: int = Field(ge=0)
    valid: bool
    word: str = Field(max_length=120)
    pos: str = Field(default="", max_length=60)
    meaning: str = Field(default="", max_length=800)
    sinhala: str = Field(default="", max_length=800)
    example1: str = Field(default="", max_length=800)
    example2: str = Field(default="", max_length=800)
    reason: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def complete(self) -> Generated:
        if self.valid and not all(
            value.strip()
            for value in (
                self.word,
                self.pos,
                self.meaning,
                self.sinhala,
                self.example1,
                self.example2,
            )
        ):
            raise ValueError("A valid word needs all definition and example fields.")
        return self


class GeneratedBatch(BaseModel):
    items: list[Generated]


class Card(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    source_word: str = ""
    hint: str = ""
    word: str = Field(default="", max_length=120)
    pos: str = Field(default="", max_length=60)
    meaning: str = Field(default="", max_length=800)
    sinhala: str = Field(default="", max_length=800)
    example1: str = Field(default="", max_length=800)
    example2: str = Field(default="", max_length=800)
    valid: bool = False
    reason: str = ""
    deck: str = ""
    audio: dict[ClipKind, str] = Field(default_factory=dict)
    audio_errors: dict[ClipKind, str] = Field(default_factory=dict)
    decision: Decision = "ask"
    sync_identity: str = ""
    note_id: int | None = None
    synced_hash: str = ""

    def clip_text(self, kind: ClipKind) -> str:
        return {
            "word": self.word,
            "meaning": self.meaning,
            "example1": self.example1,
            "example2": self.example2,
        }[kind]

    def base_identity(self) -> str:
        return identity(self.word, self.pos)

    def content_hash(self) -> str:
        return hashlib.sha256(
            "\0".join(
                (self.word, self.pos, self.meaning, self.sinhala, self.example1, self.example2)
            ).encode()
        ).hexdigest()

    def ready(self) -> bool:
        return self.valid and all(
            value.strip()
            for value in (
                self.word,
                self.pos,
                self.meaning,
                self.sinhala,
                self.example1,
                self.example2,
            )
        )
