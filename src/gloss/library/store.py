import sqlite3
from pathlib import Path

from gloss.core.models import Card


class Library:
    def __init__(self, directory: Path):
        self.directory = directory
        self.media = directory / "media"
        self.media.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(directory / "library.sqlite3")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, data TEXT NOT NULL)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS clips (key TEXT PRIMARY KEY, filename TEXT NOT NULL)"
        )
        self.db.commit()

    def save(self, card: Card) -> Card:
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO cards VALUES (?, ?)", (card.id, card.model_dump_json())
            )
        return card

    def get(self, card_id: str) -> Card:
        row = self.db.execute("SELECT data FROM cards WHERE id=?", (card_id,)).fetchone()
        if row is None:
            raise KeyError(card_id)
        return Card.model_validate_json(row[0])

    def save_many(self, cards: list[Card]) -> list[Card]:
        with self.db:
            self.db.executemany(
                "INSERT OR REPLACE INTO cards VALUES (?, ?)",
                [(card.id, card.model_dump_json()) for card in cards],
            )
        return cards

    def all(self, limit: int = 10_000) -> list[Card]:
        return [
            Card.model_validate_json(row[0])
            for row in self.db.execute(
                "SELECT data FROM cards ORDER BY rowid DESC LIMIT ?", (limit,)
            )
        ]

    def count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM cards").fetchone()[0]

    def delete(self, card_id: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM cards WHERE id=?", (card_id,))

    def clip(self, key: str) -> str | None:
        row = self.db.execute("SELECT filename FROM clips WHERE key=?", (key,)).fetchone()
        return row[0] if row and (self.media / row[0]).is_file() else None

    def save_clip(self, key: str, data: bytes) -> str:
        name = f"gloss_{key}.mp3"
        path = self.media / name
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(data)
        temporary.replace(path)
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO clips VALUES (?, ?)", (key, name))
        return name

    def close(self) -> None:
        self.db.close()
