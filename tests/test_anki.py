import json
from unittest.mock import AsyncMock

import httpx
import pytest
import respx

from gloss.anki.client import AnkiClient
from gloss.anki.gateway import AnkiGateway
from gloss.anki.templates import fields
from gloss.core.events import Job
from gloss.core.ports import ProviderError


def mock_client(notes=None):
    client = AsyncMock(spec=AnkiClient)
    values = {
        "getActiveProfile": "Learner",
        "deckNames": ["Gloss", "Gloss::General", "Gloss::Science"],
        "findNotes": [11] if notes else [],
        "notesInfo": notes or [],
        "cardsInfo": [{"deckName": "Gloss::General"}],
        "addNote": 12,
    }

    async def call(action, **kwargs):
        return values.get(action)

    client.call.side_effect = call
    client.multi.return_value = []
    return client


def note_for(card, note_id=11):
    return {
        "noteId": note_id,
        "cards": [note_id + 100],
        "fields": {
            name: {"value": value} for name, value in fields(card, card.base_identity()).items()
        },
    }


def assert_no_writes(client):
    assert not any(
        call.args[0] in {"addNote", "updateNoteFields", "changeDeck", "storeMediaFile"}
        for call in client.call.call_args_list
    )
    client.multi.assert_not_awaited()


async def test_upsert_updates_and_moves_cards_preserving_note_id(library, card, preferences):
    card.deck = "Gloss::Science"
    client = mock_client([note_for(card)])
    await AnkiGateway(client, library).sync(Job("sync"), [card], preferences, True, "Learner")
    client.call.assert_any_await(
        "updateNoteFields", note={"id": 11, "fields": fields(card, card.base_identity())}
    )
    client.call.assert_any_await("changeDeck", cards=[111], deck="Gloss::Science")
    assert library.get(card.id).note_id == 11
    assert not any(call.args[0] == "addNote" for call in client.call.call_args_list)


async def test_sync_rejects_unsafe_writes(library, card, preferences):
    client = mock_client()
    gateway = AnkiGateway(client, library)
    with pytest.raises(ProviderError, match="profile changed"):
        await gateway.sync(Job("sync"), [card], preferences, True, "Other")
    card.deck = "Gloss::Deleted"
    with pytest.raises(ValueError, match="renamed or deleted"):
        await gateway.sync(Job("sync"), [card], preferences, True, "Learner")
    card.deck = "Gloss::General"
    with pytest.raises(ValueError, match="audio is missing"):
        await gateway.sync(Job("sync"), [card], preferences, False, "Learner")
    assert_no_writes(client)

    client = mock_client([note_for(card)])
    original = client.call.side_effect

    async def call(action, **kwargs):
        if action == "cardsInfo":
            return [{"deckName": "Outside"}]
        return await original(action, **kwargs)

    client.call.side_effect = call
    with pytest.raises(ValueError, match="outside"):
        await AnkiGateway(client, library).sync(Job("sync"), [card], preferences, True, "Learner")
    assert_no_writes(client)


async def test_keep_both_preserves_conflicting_meanings_and_retry_does_not_duplicate(
    library, card, preferences
):
    old = card.model_copy(update={"meaning": "A different definition."})
    other = card.model_copy(update={"id": "second", "meaning": "A best performance."})
    notes = {11: note_for(old)}
    client = mock_client()
    original = client.call.side_effect

    async def call(action, **kwargs):
        if action == "findNotes":
            key = kwargs["query"].split('Identity:"')[1][:-1]
            return [id for id, note in notes.items() if note["fields"]["Identity"]["value"] == key]
        if action == "notesInfo":
            return [notes[id] for id in kwargs["notes"]]
        if action == "addNote":
            id = max(notes) + 1
            notes[id] = {
                "noteId": id,
                "cards": [id + 100],
                "fields": {
                    key: {"value": value} for key, value in kwargs["note"]["fields"].items()
                },
            }
            return id
        if action == "updateNoteFields":
            payload = kwargs["note"]
            notes[payload["id"]]["fields"] = {
                key: {"value": value} for key, value in payload["fields"].items()
            }
            return None
        return await original(action, **kwargs)

    client.call.side_effect = call
    gateway = AnkiGateway(client, library)
    job = Job("sync")
    await gateway.sync(job, [card, other], preferences, True, "Learner")
    assert {conflict["kind"] for conflict in job.events[0]["data"]} == {"anki", "batch"}
    assert_no_writes(client)
    card.decision = other.decision = "keep_both"
    await gateway.sync(Job("sync"), [card, other], preferences, True, "Learner")
    saved_ids = [card.note_id, other.note_id]
    await gateway.sync(Job("sync"), [card, other], preferences, True, "Learner")
    assert [card.note_id, other.note_id] == saved_ids
    assert len(notes) == 3
    assert notes[11] == note_for(old)
    assert [library.get(value.id).note_id for value in (card, other)] == saved_ids
    assert sum(call.args[0] == "addNote" for call in client.call.call_args_list) == 2


async def test_ankiconnect_multi_uses_v6_on_custom_port_and_surfaces_partial_failure():
    async with httpx.AsyncClient() as http, respx.mock:
        endpoint = respx.post("http://127.0.0.1:8766").mock(
            return_value=httpx.Response(
                200, json={"result": [{"result": "Learner", "error": None}], "error": None}
            )
        )
        client = AnkiClient(http, port=8766)
        assert await client.multi([{"action": "getActiveProfile"}]) == ["Learner"]
        request = json.loads(endpoint.calls.last.request.content)
        assert request["params"]["actions"] == [{"action": "getActiveProfile", "version": 6}]
        endpoint.mock(
            return_value=httpx.Response(
                200,
                json={
                    "result": [
                        {"result": "ok", "error": None},
                        {"result": None, "error": "failure"},
                    ],
                    "error": None,
                },
            )
        )
        with pytest.raises(ProviderError, match="One Anki operation failed"):
            await client.multi([{"action": "storeMediaFile"}, {"action": "storeMediaFile"}])
