import contextlib
import json
import logging
import os
import sys
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

VOICES = (
    "Achernar",
    "Achird",
    "Algenib",
    "Algieba",
    "Alnilam",
    "Aoede",
    "Autonoe",
    "Callirrhoe",
    "Charon",
    "Despina",
    "Enceladus",
    "Erinome",
    "Fenrir",
    "Gacrux",
    "Iapetus",
    "Kore",
    "Laomedeia",
    "Leda",
    "Orus",
    "Puck",
    "Pulcherrima",
    "Rasalgethi",
    "Sadachbia",
    "Sadaltager",
    "Schedar",
    "Sulafat",
    "Umbriel",
    "Vindemiatrix",
    "Zephyr",
    "Zubenelgenubi",
)


def config_dir() -> Path:
    if override := os.environ.get("GLOSS_CONFIG_DIR"):
        return Path(override).expanduser().resolve()
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming")) / "Gloss"
    return Path.home() / ".config" / "gloss"


class Preferences(BaseModel):
    batch_size: int = Field(default=5, ge=1, le=5)
    word_cap: int = Field(default=50, ge=1, le=100)
    text_model: str = Field(default="gemini-3.8-flash", pattern=r"^[\w.-]{1,100}$")
    tts_model: str = Field(default="gemini-3.8-flash-tts", pattern=r"^[\w.-]{1,100}$")
    voice: str = "Kore"
    deck_parent: str = "Gloss"
    deck_default: str = "General"
    seed_decks: list[str] = Field(default_factory=lambda: ["General", "Subject 1", "Subject 2"])
    last_deck: str = ""
    note_type: str = Field(default="Gloss", min_length=1, max_length=80)
    tts_concurrency: int = Field(default=2, ge=1, le=3)
    tts_rpm: int = Field(default=20, ge=1, le=120)
    call_budget: int = Field(default=400, ge=4, le=1000)
    theme: str = "system"
    estimated_usd_per_word: float = Field(default=0.0055, ge=0, le=1)

    @field_validator("voice")
    @classmethod
    def valid_voice(cls, value: str) -> str:
        if value not in VOICES:
            raise ValueError("Choose a voice from the voice library.")
        return value

    @field_validator("theme")
    @classmethod
    def valid_theme(cls, value: str) -> str:
        if value not in {"system", "light", "dark"}:
            raise ValueError("Theme must be system, light, or dark.")
        return value

    @field_validator("deck_parent", "deck_default")
    @classmethod
    def valid_deck(cls, value: str) -> str:
        return validate_deck_name(value)

    @field_validator("seed_decks")
    @classmethod
    def valid_seeds(cls, value: list[str]) -> list[str]:
        if not 1 <= len(value) <= 20:
            raise ValueError("Choose between 1 and 20 starting decks.")
        return list(dict.fromkeys(validate_deck_name(name) for name in value))


def validate_deck_name(value: str) -> str:
    if (
        not value
        or len(value) > 80
        or value != value.strip()
        or "::" in value
        or '"' in value
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise ValueError("Deck names cannot contain ::, quotes, or control characters.")
    return value


class Environment(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)
    google_cloud_project: str = ""
    google_cloud_location: str = "global"
    google_application_credentials: str = ""
    voice: str = "Kore"
    deck_parent: str = "Gloss"
    deck_default: str = "General"
    gloss_release_repo: str = ""
    anki_connect_port: int = Field(default=8765, ge=1, le=65535)


class Configuration:
    def __init__(self, directory: Path | None = None):
        self.directory = directory or config_dir()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if sys.platform != "win32":
            # mkdir's mode is ignored for an existing directory.
            with contextlib.suppress(OSError):
                os.chmod(self.directory, 0o700)
        self.environment = Environment(_env_file=self.directory / ".env")
        if self.environment.google_application_credentials:
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = (
                self.environment.google_application_credentials
            )
        path = self.directory / "settings.json"
        defaults = {
            "voice": self.environment.voice,
            "deck_parent": self.environment.deck_parent,
            "deck_default": self.environment.deck_default,
        }
        data: dict = defaults
        if path.exists():
            try:
                loaded = json.loads(path.read_text())
                if not isinstance(loaded, dict):
                    raise ValueError("settings.json must contain an object")
                data = loaded
            except (OSError, ValueError) as exc:
                self.quarantine_settings(path, exc)
                data = defaults
        try:
            self.preferences = Preferences(**data)
        except ValidationError as exc:
            self.quarantine_settings(path, exc)
            self.preferences = Preferences(**defaults)

    @staticmethod
    def quarantine_settings(path: Path, exc: Exception) -> None:
        # A corrupt or out-of-date settings file must not stop the app from starting.
        logging.getLogger("gloss").warning("Ignoring unreadable %s: %s", path.name, exc)
        with contextlib.suppress(OSError):
            path.replace(path.with_name(path.name + ".bak"))

    def save(self, preferences: Preferences) -> None:
        path = self.directory / "settings.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(preferences.model_dump_json(indent=2), encoding="utf-8")
        temporary.chmod(0o600)
        temporary.replace(path)
        self.preferences = preferences
