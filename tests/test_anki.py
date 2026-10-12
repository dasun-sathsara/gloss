from unittest.mock import AsyncMock

import httpx
import pytest
import respx

from gloss.anki.client import AnkiClient
from gloss.anki.gateway import AnkiGateway
from gloss.anki.templates import BACK, FIELDS, FRONT, fields
from gloss.core.events import Job
from gloss.core.ports import ProviderError


def mock_client(card, notes=None, decks=None):
    client = AsyncMock(spec=AnkiClient)
    values = {
        "getActiveProfile": "Learner",
        "deckNames": decks or ["Gloss", "Gloss::General", "Gloss::Science"],
        "findNotes": [11] if notes else [],
        "notesInfo": notes or [],
        "cardsInfo": [{"deckName": "Gloss::General"}],
        "addNote": 12,
        "version": 6,
        "findCards": [],
        "getDeckConfig": {"new": {"perDay": 20}},
        "modelFieldNames": FIELDS,
    }

    async def call(action, **kwargs):
        return values.get(action)

    client.call.side_effect = call
    client.multi.return_value = []
    return client


async def test_upsert_updates_and_moves_cards_preserving_note_id(library, card, preferences):
    card.deck = "Gloss::Science"
    note = {
        "noteId": 11,
        "cards": [22],
        "fields": {
            name: {"value": value} for name, value in fields(card, card.base_identity()).items()
        },
    }
    client = mock_client(card, [note])
    job = Job("sync")
    await AnkiGateway(client, library).sync(job, [card], preferences, True, "Learner")
    client.call.assert_any_await(
        "updateNoteFields", note={"id": 11, "fields": fields(card, card.base_identity())}
    )
    client.call.assert_any_await("changeDeck", cards=[22], deck="Gloss::Science")
    assert card.note_id == 11
    assert library.get(card.id).note_id == 11
    assert not any(call.args[0] == "createDeck" for call in client.call.call_args_list)


async def test_deleted_deck_missing_audio_and_profile_change_stop_writes(
    library, card, preferences
):
    client = mock_client(card)
    gateway = AnkiGateway(client, library)
    with pytest.raises(ProviderError, match="profile changed"):
        await gateway.sync(Job("sync"), [card], preferences, True, "Other")
    card.deck = "Gloss::Deleted"
    with pytest.raises(ValueError, match="renamed or deleted"):
        await gateway.sync(Job("sync"), [card], preferences, True, "Learner")
    card.deck = "Gloss::General"
    with pytest.raises(ValueError, match="audio is missing"):
        await gateway.sync(Job("sync"), [card], preferences, False, "Learner")
    assert not any(
        call.args[0] in {"addNote", "updateNoteFields", "storeMediaFile"}
        for call in client.call.call_args_list
    )


async def test_conflict_requires_choice_and_keep_both_key_is_stable(library, card, preferences):
    old = card.model_copy(update={"meaning": "A different definition."})
    note = {
        "noteId": 11,
        "cards": [22],
        "fields": {
            name: {"value": value} for name, value in fields(old, old.base_identity()).items()
        },
    }
    client = mock_client(card, [note])
    gateway = AnkiGateway(client, library)
    job = Job("sync")
    await gateway.sync(job, [card], preferences, True, "Learner")
    assert job.events[0]["event"] == "conflicts"
    assert not any(call.args[0] == "updateNoteFields" for call in client.call.call_args_list)
    card.decision = "keep_both"
    card.sync_identity = card.base_identity()
    key = gateway.key(card)
    assert key.endswith(card.id)
    card.sync_identity = key
    assert gateway.key(card) == key


async def test_conflicts_detect_two_senses_in_one_batch(library, card, preferences):
    other = card.model_copy(update={"id": "second", "meaning": "A best performance."})
    gateway = AnkiGateway(mock_client(card), library)
    conflicts = await gateway.conflicts([card, other], preferences)
    assert [(item["id"], item["kind"]) for item in conflicts] == [("second", "batch")]
    other.decision = "keep_both"
    assert await gateway.conflicts([card, other], preferences) == []


async def test_matching_note_outside_parent_is_never_modified(library, card, preferences):
    note = {
        "noteId": 11,
        "cards": [22],
        "fields": {
            name: {"value": value} for name, value in fields(card, card.base_identity()).items()
        },
    }
    client = mock_client(card, [note])
    original = client.call.side_effect

    async def call(action, **kwargs):
        if action == "cardsInfo":
            return [{"deckName": "Outside"}]
        return await original(action, **kwargs)

    client.call.side_effect = call
    with pytest.raises(ValueError, match="outside"):
        await AnkiGateway(client, library).sync(Job("sync"), [card], preferences, True, "Learner")
    assert not any(call.args[0] == "updateNoteFields" for call in client.call.call_args_list)


async def test_partial_multi_results_are_not_ignored():
    async with httpx.AsyncClient() as http, respx.mock:
        respx.post("http://127.0.0.1:8765").mock(
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
            await AnkiClient(http).multi([{"action": "a"}, {"action": "b"}])


def test_audio_tags_and_fields_escape_untrusted_text(card):
    card.word = '<script>alert("x")</script>'
    for kind in ("word", "meaning", "example1", "example2"):
        card.audio[kind] = f"gloss_{'a' * 64}.mp3"
    values = fields(card, card.base_identity())
    assert sum(value.count("[sound:") for value in values.values()) == 1
    assert "Word Audio" not in FRONT
    assert 'preload="none"' in values["Meaning Audio"]
    assert "controls" not in values["Meaning Audio"]
    assert "autoplay" not in values["Meaning Audio"]
    assert 'src="gloss_' in values["Meaning Audio"]
    assert "<script>" not in values["Word"]
    assert "&lt;script&gt;" in values["Word"]
    assert 'lang="si"' in BACK


async def test_configured_anki_port_stays_on_loopback():
    async with httpx.AsyncClient() as http, respx.mock:
        endpoint = respx.post("http://127.0.0.1:8766").mock(
            return_value=httpx.Response(200, json={"result": 6, "error": None})
        )
        assert await AnkiClient(http, port=8766).call("version") == 6
        assert endpoint.called


async def test_multi_actions_explicitly_request_version_6():
    async with httpx.AsyncClient() as http, respx.mock:
        endpoint = respx.post("http://127.0.0.1:8765").mock(
            return_value=httpx.Response(
                200, json={"result": [{"result": "Learner", "error": None}], "error": None}
            )
        )
        assert await AnkiClient(http).multi([{"action": "getActiveProfile"}]) == ["Learner"]
        import json

        request = json.loads(endpoint.calls.last.request.content)
        assert request["params"]["actions"] == [{"action": "getActiveProfile", "version": 6}]
