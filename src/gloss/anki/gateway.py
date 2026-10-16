import base64
import html
from typing import Any

from gloss.anki.client import AnkiClient
from gloss.anki.templates import BACK, FIELDS, FRONT, available_fonts, css, fields
from gloss.config import Preferences, validate_deck_name
from gloss.core.events import Job
from gloss.core.models import CLIP_KINDS, Card
from gloss.core.ports import ProviderError
from gloss.library.store import Library


def quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


AUDIO_FIELDS = {
    "word": "Word Audio",
    "meaning": "Meaning Audio",
    "example1": "Example 1 Audio",
    "example2": "Example 2 Audio",
}


class AnkiGateway:
    def __init__(self, client: AnkiClient, library: Library):
        self.client = client
        self.library = library

    async def status(self, preferences: Preferences) -> dict[str, Any]:
        try:
            version = await self.client.call("version")
            if not isinstance(version, int) or version < 6:
                return {
                    "connected": False,
                    "ready": False,
                    "decks": [],
                    "models": [],
                    "message": "Update AnkiConnect to API version 6.",
                }
            profile, decks, models = await self.client.multi(
                [
                    {"action": "getActiveProfile"},
                    {"action": "deckNames"},
                    {"action": "modelNames"},
                ]
            )
            children = [name for name in decks if name.startswith(preferences.deck_parent + "::")]
            default = f"{preferences.deck_parent}::{preferences.deck_default}"
            selected = preferences.last_deck if preferences.last_deck in children else default
            warnings: list[str] = []
            if preferences.last_deck and preferences.last_deck not in children:
                warnings.append("The last deck was renamed or deleted. Choose a current deck.")
            if selected not in children:
                selected = children[0] if children else ""
            parent_cards: list[int] = []
            if preferences.deck_parent in decks:
                parent_cards = await self.client.call(
                    "findCards",
                    query=f"deck:{quote(preferences.deck_parent)} "
                    f"-deck:{quote(preferences.deck_parent + '::*')}",
                )
                config = await self.client.call("getDeckConfig", deck=preferences.deck_parent)
                if config and (
                    config.get("new", {}).get("perDay", 0) < 9999
                    or config.get("rev", {}).get("perDay", 0) < 9999
                ):
                    warnings.append("The parent deck's daily limits can restrict its subdecks.")
                if parent_cards:
                    warnings.append(f"{len(parent_cards)} cards are directly in the parent deck.")
            ready = preferences.note_type in models and bool(children)
            if preferences.note_type in models:
                remote_fields = await self.client.call(
                    "modelFieldNames", modelName=preferences.note_type
                )
                if remote_fields != FIELDS:
                    ready = False
                    warnings.append(
                        "The selected note type has different fields. Choose a new name."
                    )
            return {
                "connected": True,
                "profile": profile,
                "decks": children,
                "models": models,
                "selected_deck": selected,
                "ready": ready,
                "parent_cards": len(parent_cards),
                "warnings": warnings,
            }
        except ProviderError as exc:
            return {
                "connected": False,
                "message": str(exc),
                "decks": [],
                "models": [],
                "ready": False,
            }

    async def setup(self, preferences: Preferences, move_parent_cards: bool = False) -> None:
        decks = await self.client.call("deckNames")
        parent_new = preferences.deck_parent not in decks
        seeds = list(dict.fromkeys([preferences.deck_default, *preferences.seed_decks]))
        tree = [preferences.deck_parent, *[f"{preferences.deck_parent}::{name}" for name in seeds]]
        for name in tree:
            if name not in decks:
                await self.client.call("createDeck", deck=name)
        if parent_new:
            config_id = await self.client.call("cloneDeckConfigId", name="Gloss", cloneFrom=1)
            if config_id is False:
                raise ProviderError("Anki could not create the Gloss deck preset.")
            config = await self.client.call("getDeckConfig", deck=preferences.deck_parent)
            config["id"] = config_id
            config["name"] = "Gloss"
            config.setdefault("new", {})["perDay"] = 9999
            config.setdefault("rev", {})["perDay"] = 9999
            if not await self.client.call("saveDeckConfig", config=config):
                raise ProviderError("Anki could not save the Gloss deck preset.")
            if not await self.client.call("setDeckConfigId", decks=tree, configId=config_id):
                raise ProviderError("Anki could not assign the Gloss deck preset.")
        if move_parent_cards:
            cards = await self.client.call(
                "findCards",
                query=f"deck:{quote(preferences.deck_parent)} "
                f"-deck:{quote(preferences.deck_parent + '::*')}",
            )
            if cards:
                await self.client.call(
                    "changeDeck",
                    cards=cards,
                    deck=f"{preferences.deck_parent}::{preferences.deck_default}",
                )
        models = await self.client.call("modelNames")
        if preferences.note_type in models:
            if await self.client.call("modelFieldNames", modelName=preferences.note_type) != FIELDS:
                raise ProviderError(
                    "This note type already exists with other fields. Choose a new name."
                )
            await self.client.call(
                "updateModelStyling", model={"name": preferences.note_type, "css": css()}
            )
            await self.client.call(
                "updateModelTemplates",
                model={
                    "name": preferences.note_type,
                    "templates": {"Recall": {"Front": FRONT, "Back": BACK}},
                },
            )
        else:
            await self.client.call(
                "createModel",
                modelName=preferences.note_type,
                inOrderFields=FIELDS,
                css=css(),
                isCloze=False,
                cardTemplates=[{"Name": "Recall", "Front": FRONT, "Back": BACK}],
            )
        for path in available_fonts(self.library.directory / "fonts").values():
            encoded = base64.b64encode(path.read_bytes()).decode("ascii")
            await self.client.call("storeMediaFile", filename=path.name, data=encoded)
            if await self.client.call("retrieveMediaFile", filename=path.name) != encoded:
                raise ProviderError(f"Anki did not verify the font asset {path.name}.")
        if (await self.client.call("modelStyling", modelName=preferences.note_type))[
            "css"
        ] != css():
            raise ProviderError("Anki did not verify the card stylesheet.")
        templates = await self.client.call("modelTemplates", modelName=preferences.note_type)
        if templates.get("Recall") != {"Front": FRONT, "Back": BACK}:
            raise ProviderError("Anki did not verify the card templates.")

    async def add_deck(self, preferences: Preferences, name: str) -> str:
        target = f"{preferences.deck_parent}::{validate_deck_name(name)}"
        await self.client.call("createDeck", deck=target)
        return target

    async def matches(self, card: Card, preferences: Preferences) -> list[dict[str, Any]]:
        key = self.key(card)
        ids = await self.client.call(
            "findNotes", query=f"note:{quote(preferences.note_type)} Identity:{quote(key)}"
        )
        return await self.client.call("notesInfo", notes=ids) if ids else []

    def same_content(self, card: Card, note: dict[str, Any]) -> bool:
        expected = fields(card, "")
        return all(
            note["fields"].get(name, {}).get("value") == expected[name]
            for name in (
                "Word",
                "Part of Speech",
                "English Meaning",
                "Sinhala Meaning",
                "Example 1",
                "Example 2",
            )
        )

    @staticmethod
    def key(card: Card) -> str:
        if card.decision == "keep_both":
            return card.base_identity() + "-" + card.id
        return card.sync_identity or card.base_identity()

    async def conflicts(self, cards: list[Card], preferences: Preferences) -> list[dict[str, Any]]:
        ready = [card for card in cards if card.decision != "skip" and card.ready()]
        groups: dict[str, list[Card]] = {}
        for card in ready:
            groups.setdefault(self.key(card), []).append(card)
        # Flag every card in a group that resolves to the same note with different
        # content, not just the later ones. Otherwise the first card silently
        # aliases the note that the second card writes.
        batched = {
            key: group
            for key, group in groups.items()
            if len({card.content_hash() for card in group}) > 1
        }
        result: list[dict[str, Any]] = []
        for card in ready:
            matches = await self.matches(card, preferences)
            if len(matches) > 1 or (matches and not self.same_content(card, matches[0])):
                result.append(
                    {
                        "id": card.id,
                        "word": card.word,
                        "kind": "anki",
                        "existing": [
                            {
                                name: html.unescape(note["fields"].get(name, {}).get("value", ""))
                                for name in (
                                    "Word",
                                    "Part of Speech",
                                    "English Meaning",
                                    "Sinhala Meaning",
                                )
                            }
                            for note in matches
                        ],
                    }
                )
            group = batched.get(self.key(card))
            if group:
                others = [value for value in group if value.id != card.id]
                result.append(
                    {
                        "id": card.id,
                        "word": card.word,
                        "kind": "batch",
                        "existing": [
                            {
                                "Word": html.unescape(value.word),
                                "English Meaning": html.unescape(value.meaning),
                            }
                            for value in others
                        ],
                    }
                )
        return result

    async def sync(
        self,
        job: Job,
        cards: list[Card],
        preferences: Preferences,
        allow_missing: bool,
        expected_profile: str,
    ) -> None:
        profile = await self.client.call("getActiveProfile")
        if profile != expected_profile:
            raise ProviderError("The active Anki profile changed. Start sync again.")
        decks = await self.client.call("deckNames")
        target_prefix = preferences.deck_parent + "::"
        for card in cards:
            if card.decision == "skip":
                continue
            if not card.ready():
                raise ValueError("Finish or remove invalid cards before syncing.")
            if card.deck not in decks or not card.deck.startswith(target_prefix):
                raise ValueError(
                    "A selected deck was renamed or deleted. Choose a current subdeck."
                )
            if not allow_missing and any(kind not in card.audio for kind in CLIP_KINDS):
                raise ValueError("Some audio is missing. Retry it or explicitly sync without it.")
        conflicts = await self.conflicts(cards, preferences)
        by_id = {card.id: card for card in cards}
        unresolved = [item for item in conflicts if by_id.get(item["id"], Card()).decision == "ask"]
        if unresolved:
            job.emit("conflicts", unresolved)
            return
        keys: set[str] = set()
        for card in cards:
            if card.decision == "skip":
                continue
            key = self.key(card)
            if key in keys:
                raise ValueError(
                    "Two selected words map to the same Anki note. "
                    "Keep both meanings or remove one."
                )
            keys.add(key)
        for card in cards:
            if card.decision == "skip":
                continue
            if await self.client.call("getActiveProfile") != expected_profile:
                raise ProviderError("The active Anki profile changed. Start sync again.")
            if card.decision == "keep_both":
                card.sync_identity = self.key(card)
                self.library.save(card)
            key = card.sync_identity or card.base_identity()
            matches = await self.matches(card, preferences)
            if len(matches) > 1:
                raise ValueError(
                    "Several Anki notes share this identity. Keep both or resolve them in Anki."
                )
            if matches:
                cards_info = await self.client.call("cardsInfo", cards=matches[0]["cards"])
                if any(not item["deckName"].startswith(target_prefix) for item in cards_info):
                    raise ValueError(
                        "A matching note is outside the Gloss parent. Resolve it in Anki."
                    )
            actions = [
                {
                    "action": "storeMediaFile",
                    "params": {
                        "filename": name,
                        "data": base64.b64encode((self.library.media / name).read_bytes()).decode(
                            "ascii"
                        ),
                    },
                }
                for name in set(card.audio.values())
            ]
            if actions:
                await self.client.multi(actions)
            payload = fields(card, key)
            if matches and allow_missing:
                existing = matches[0]["fields"]
                for kind, name in AUDIO_FIELDS.items():
                    # Preserve audio that only Anki holds; an empty field would erase it.
                    if kind not in card.audio and existing.get(name, {}).get("value"):
                        payload.pop(name, None)
            if matches:
                note_id = matches[0]["noteId"]
                await self.client.call("updateNoteFields", note={"id": note_id, "fields": payload})
                await self.client.call("changeDeck", cards=matches[0]["cards"], deck=card.deck)
            else:
                note_id = await self.client.call(
                    "addNote",
                    note={
                        "deckName": card.deck,
                        "modelName": preferences.note_type,
                        "fields": payload,
                        "tags": ["gloss"],
                        "options": {"allowDuplicate": False},
                    },
                )
                if not isinstance(note_id, int):
                    raise ProviderError("Anki did not return a note id. Retry sync.")
            card.note_id = note_id
            card.sync_identity = key
            card.synced_hash = card.content_hash()
            self.library.save(card)
            job.emit("card", card.model_dump())
        await self.client.call("sync")
        job.emit(
            "sync_started",
            {"message": "Notes are saved in Anki. Finish its sync to send them to your phone."},
        )
