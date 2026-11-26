import asyncio
import contextlib
import logging
import re
import secrets
import time
from contextlib import asynccontextmanager
from importlib.metadata import version
from pathlib import Path
from typing import Annotated, Any, Literal

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from gloss.anki.client import AnkiClient
from gloss.anki.gateway import AnkiGateway
from gloss.anki.templates import available_fonts
from gloss.config import VOICES, WOOF_VOICES, Configuration, Preferences
from gloss.core.events import Job, Jobs
from gloss.core.manual import ManualRun
from gloss.core.models import CLIP_KINDS, Card, ClipKind, Entry
from gloss.core.orchestrator import Orchestrator, clip_key
from gloss.core.parsing import parse_entries
from gloss.core.ports import ProviderError
from gloss.library.store import Library
from gloss.providers.openai_compat import ChatCompletionsLanguageModel
from gloss.providers.vertex import VertexLanguageModel, VertexSynthesizer, make_client
from gloss.providers.woof import WoofSynthesizer


class Paste(BaseModel):
    text: str = Field(max_length=20_000)
    deck: str = Field(default="", max_length=200)
    confirm_over_cap: bool = False


class ManualImport(BaseModel):
    reply: str = Field(min_length=1, max_length=750_000)


class Selection(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=1000)
    kind: ClipKind | None = None


class ProfileSelection(Selection):
    expected_profile: str | None = None


class SyncSelection(Selection):
    allow_missing: bool = False
    ticket: str = ""


class DeckName(BaseModel):
    name: str


class BatchDeck(Selection):
    deck: str = Field(min_length=1, max_length=200)


class Setup(BaseModel):
    move_parent_cards: bool = False


class CardEdit(BaseModel):
    word: str = Field(max_length=120)
    pos: str = Field(max_length=60)
    meaning: str = Field(max_length=800)
    sinhala: str = Field(max_length=800)
    example1: str = Field(max_length=800)
    example2: str = Field(max_length=800)
    valid: bool
    deck: str = Field(max_length=200)
    decision: Literal["ask", "overwrite", "keep_both", "skip"] = "ask"


def create_app(
    configuration: Configuration | None = None, frontend: Path | None = None, demo: bool = False
) -> FastAPI:
    configuration = configuration or Configuration()
    library = Library(configuration.directory)
    orchestrator = Orchestrator(library)
    jobs = Jobs()
    http = httpx.AsyncClient(trust_env=False)
    gateway = AnkiGateway(AnkiClient(http, configuration.environment.anki_connect_port), library)
    sync_ticket: dict[str, Any] = {}
    mutation_lock = asyncio.Lock()
    text_health: dict[str, str] = {"state": "off", "detail": ""}
    warm_task: asyncio.Task[None] | None = None
    woof_synth: WoofSynthesizer | None = None

    def unlocked(path: str) -> bool:
        # Parsing changes nothing, and Cancel must never queue behind a slow Anki call.
        return path == "/api/parse" or bool(re.fullmatch(r"/api/jobs/[^/]+/cancel", path))

    async def warm_text() -> None:
        """Probe the endpoint after the user opts into automatic generation."""
        current = asyncio.current_task()
        environment = configuration.environment
        if not environment.text_api_base or not environment.text_api_key:
            if warm_task is current:
                text_health.update(state="off", detail="")
            return
        if not environment.text_api_base.startswith(("http://", "https://")):
            if warm_task is current:
                text_health.update(
                    state="down", detail="TEXT_API_BASE must be an http or https URL."
                )
            return
        if warm_task is current:
            text_health.update(state="warming", detail="")
        response: httpx.Response | None = None
        for attempt in range(2):
            try:
                response = await http.post(
                    environment.text_api_base.rstrip("/") + "/chat/completions",
                    json={
                        "model": configuration.preferences.text_model,
                        "messages": [{"role": "user", "content": "ok"}],
                        "max_tokens": 1,
                        "stream": False,
                    },
                    headers={"Authorization": f"Bearer {environment.text_api_key}"},
                    timeout=environment.text_timeout,
                )
            except httpx.InvalidURL:
                if warm_task is current:
                    text_health.update(state="down", detail="TEXT_API_BASE is not a valid URL.")
                return
            except httpx.HTTPError:
                if warm_task is current:
                    text_health.update(state="down", detail="The text provider did not respond.")
                return
            if 300 <= response.status_code < 400 and not attempt:
                # The proxy redirects while the container wakes; try once more.
                continue
            break
        assert response is not None
        if warm_task is not current:
            return
        if response.status_code == 200:
            text_health.update(state="ready", detail="")
        elif response.status_code in {401, 403}:
            text_health.update(state="down", detail="The endpoint rejected the API key.")
        else:
            text_health.update(
                state="down", detail=f"The endpoint returned HTTP {response.status_code}."
            )

    def start_warm() -> None:
        nonlocal warm_task
        if demo:
            return
        if warm_task and not warm_task.done():
            warm_task.cancel()
        environment = configuration.environment
        if not environment.text_api_base or not environment.text_api_key:
            text_health.update(state="off", detail="")
            warm_task = None
            return
        text_health.update(state="warming", detail="")
        warm_task = asyncio.create_task(warm_text())

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        nonlocal woof_synth
        yield
        if warm_task and not warm_task.done():
            warm_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await warm_task
        if jobs.active and jobs.active.task:
            jobs.active.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await jobs.active.task
        if woof_synth is not None:
            await woof_synth.aclose(wait=False)
            woof_synth = None
        await http.aclose()
        library.close()

    app = FastAPI(
        title="Gloss", version=version("gloss"), lifespan=lifespan, docs_url=None, redoc_url=None
    )
    app.state.library = library
    app.state.jobs = jobs
    app.state.gateway = gateway
    app.state.configuration = configuration
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "[::1]"])

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        security = {
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        }
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            expected = f"{request.url.scheme}://{request.headers.get('host', '')}"
            if origin != expected:
                return JSONResponse(
                    {"detail": "Use Gloss from its own browser window."},
                    status_code=403,
                    headers=security,
                )
        if any(part.startswith(".") for part in request.url.path.split("/") if part):
            return JSONResponse({"detail": "Not found."}, status_code=404, headers=security)
        if request.method not in {"GET", "HEAD", "OPTIONS"} and not unlocked(request.url.path):
            async with mutation_lock:
                response = await call_next(request)
        else:
            response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = (
            "no-store" if request.url.path.startswith("/api") else "no-cache"
        )
        return response

    @app.exception_handler(ProviderError)
    async def provider_error(_: Request, exc: ProviderError):
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @app.exception_handler(ValueError)
    async def value_error(_: Request, exc: ValueError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(ValidationError)
    async def validation_error(_: Request, exc: ValidationError):
        logging.getLogger("gloss").exception("Request validation failed")
        return JSONResponse({"detail": "The request was not valid."}, status_code=422)

    @app.exception_handler(KeyError)
    async def key_error(_: Request, exc: KeyError):
        return JSONResponse({"detail": "This card or run no longer exists."}, status_code=404)

    def idle(during_audio: bool = False) -> None:
        active = jobs.active
        # Card edits are safe while audio records: each clip result is merged into
        # the saved card and dropped if its text changed.
        if active and not (during_audio and active.stage == "audio"):
            raise HTTPException(409, "Wait for the run to finish, or cancel it to edit.")

    def selected(ids: list[str]) -> list[Card]:
        return [library.get(card_id) for card_id in dict.fromkeys(ids)]

    def valid_audio(card: Card, clips_by_key: dict[str, str] | None = None) -> Card:
        for kind in CLIP_KINDS:
            current_file = card.audio.get(kind)
            if not current_file:
                card.audio.pop(kind, None)
                continue
            key = clip_key(configuration.preferences, card.clip_text(kind))
            expected = clips_by_key.get(key) if clips_by_key is not None else library.clip(key)
            if current_file != expected:
                card.audio.pop(kind, None)
        if card.synced_hash and card.content_hash() != card.synced_hash:
            card.synced_hash = ""
        return card

    def valid_cards(cards: list[Card]) -> list[Card]:
        clips_by_key = library.clip_map()
        return [valid_audio(card, clips_by_key) for card in cards]

    async def with_providers(job: Job, operation) -> None:
        nonlocal woof_synth
        preferences = configuration.preferences.model_copy(deep=True)
        if demo:
            from gloss.providers.demo import DemoLanguageModel, DemoSynthesizer

            # Test tones cost nothing, so the speech quota does not apply.
            preferences.tts_rpm = 120
            await operation(job, DemoLanguageModel(), DemoSynthesizer(), preferences)
            return
        environment = configuration.environment
        uses_google_text = job.kind != "audio" and not environment.text_api_base
        uses_google_audio = preferences.audio_provider == "google" and (
            job.kind == "audio" or preferences.auto_audio
        )
        client = (
            make_client(configuration)
            if environment.google_cloud_project and (uses_google_text or uses_google_audio)
            else None
        )
        text: VertexLanguageModel | ChatCompletionsLanguageModel | None = None
        synth: VertexSynthesizer | WoofSynthesizer | None = None
        cancelled = False
        try:
            if job.kind != "audio":
                if environment.text_api_base:
                    text = ChatCompletionsLanguageModel(
                        environment.text_api_base,
                        environment.text_api_key,
                        preferences,
                        timeout=environment.text_timeout,
                        client=http,
                    )
                elif client:
                    text = VertexLanguageModel(client, preferences)
                else:
                    raise ProviderError(
                        "Add TEXT_API_BASE and TEXT_API_KEY, or the Google project and "
                        "credentials, to the config .env.",
                        fatal=True,
                    )
            if preferences.audio_provider == "woof" and environment.woof_model_dir:
                voice = configuration.woof_voice(preferences)
                if woof_synth is not None and woof_synth.voice != voice:
                    await woof_synth.aclose(wait=False)
                    woof_synth = None
                if woof_synth is None:
                    woof_synth = WoofSynthesizer(Path(environment.woof_model_dir), voice)
                synth = woof_synth
                # Local clips cost nothing and answer to no quota; use every available core.
                preferences.tts_rpm = 0
                preferences.tts_concurrency = synth.workers
            elif uses_google_audio and client:
                synth = VertexSynthesizer(client, preferences)
            await operation(job, text, synth, preferences)
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            if cancelled and woof_synth is not None:
                await woof_synth.aclose(wait=False)
                woof_synth = None
            if isinstance(text, ChatCompletionsLanguageModel):
                await text.aclose()
            if client:
                await client.aio.aclose()
                client.close()

    def audio_ready() -> bool:
        environment = configuration.environment
        return demo or bool(
            environment.woof_model_dir
            if configuration.preferences.audio_provider == "woof"
            else environment.google_cloud_project
        )

    def text_ready() -> bool:
        environment = configuration.environment
        if demo:
            return True
        if environment.text_api_base:
            return bool(environment.text_api_key)
        return bool(environment.google_cloud_project)

    async def write_cards(
        job: Job,
        entries: list[Entry],
        deck: str,
        model,
        synth,
        preferences: Preferences,
        retry_id: str | None = None,
    ) -> None:
        cards = await orchestrator.generate(job, entries, deck, model, preferences, retry_id)
        ready = [card for card in cards if card.ready()]
        summary: dict[str, Any] = {"words": len(cards), "needs_review": len(cards) - len(ready)}
        if preferences.auto_audio and ready and synth is not None:
            summary["audio"] = await orchestrator.audio(job, ready, synth, preferences)
        job.emit("summary", summary)

    @app.get("/api/health")
    async def health():
        return {
            "app": "gloss",
            "version": app.version,
            "text_health": text_health["state"],
            "text_health_detail": text_health["detail"],
        }

    @app.get("/api/bootstrap")
    async def bootstrap():
        active = jobs.active
        cards = valid_cards(library.all())
        total = library.count()
        manual = library.manual_run()
        environment = configuration.environment
        return {
            "settings": configuration.preferences,
            "voices": VOICES if environment.google_cloud_project else [],
            "woof_voices": WOOF_VOICES,
            "woof_default_voice": configuration.woof_voice(),
            "woof_configured": bool(environment.woof_model_dir),
            "google_audio_available": bool(environment.google_cloud_project),
            "cards": cards,
            "card_count": total,
            "manual": manual.status() if manual else None,
            "library_truncated": total > len(cards),
            "active_job": {"id": active.id, "kind": active.kind, "stage": active.stage}
            if active
            else None,
            "provider_ready": text_ready(),
            "text_provider": "demo"
            if demo
            else "endpoint"
            if environment.text_api_base
            else "google"
            if environment.google_cloud_project
            else "",
            "text_health": text_health["state"],
            "text_health_detail": text_health["detail"],
            "audio_ready": audio_ready(),
            "audio_provider": "demo" if demo else configuration.preferences.audio_provider,
            "audio_voice": configuration.woof_voice(configuration.preferences)
            if configuration.preferences.audio_provider == "woof"
            else configuration.preferences.voice,
            "config_dir": str(configuration.directory),
            "demo": demo,
            "fonts_complete": "_StudioFeixenSansVariable.ttf"
            in available_fonts(configuration.directory / "fonts"),
        }

    @app.put("/api/settings")
    async def settings(preferences: Preferences):
        idle()
        previous_text_model = configuration.preferences.text_model
        if (
            preferences.audio_provider == "google"
            and not configuration.environment.google_cloud_project
            and configuration.preferences.audio_provider != "google"
        ):
            raise ValueError("Configure a Google Cloud project before enabling Google audio.")
        configuration.save(preferences)
        clips_by_key = library.clip_map()
        changed: list[Card] = []
        for card in library.all_unlimited():
            old_audio = dict(card.audio)
            old_hash = card.synced_hash
            valid_audio(card, clips_by_key)
            if card.audio != old_audio or card.synced_hash != old_hash:
                changed.append(card)
        if changed:
            library.save_many(changed)
        if configuration.preferences.text_model != previous_text_model and warm_task is not None:
            start_warm()
        return configuration.preferences

    @app.post("/api/text/warm")
    async def warm_endpoint():
        if text_health["state"] in {"off", "down"}:
            start_warm()
        return await health()

    @app.post("/api/parse")
    async def parse(paste: Paste):
        entries = parse_entries(paste.text)
        count = sum(not entry.warning for entry in entries)
        return {
            "entries": entries,
            "count": count,
            "over_cap": count > configuration.preferences.word_cap,
            "estimate_usd": round(count * configuration.preferences.estimated_usd_per_word, 3),
            "audio_calls": count * 4,
        }

    @app.post("/api/manual")
    async def start_manual(paste: Paste):
        idle()
        if library.manual_run() is not None:
            raise HTTPException(409, "Finish or close the current manual run first.")
        entries = [entry for entry in parse_entries(paste.text) if not entry.warning]
        if not entries:
            raise ValueError("Paste at least one word.")
        if not paste.deck.startswith(configuration.preferences.deck_parent + "::"):
            raise ValueError("Choose a subdeck inside your parent deck.")
        run = ManualRun(
            entries=entries,
            deck=paste.deck,
            order=int(time.time() * 1000) * 1000,
            size=configuration.preferences.manual_batch_size,
        )
        library.save_manual(run)
        return run.status()

    @app.post("/api/manual/import")
    async def import_manual(paste: ManualImport):
        idle()
        run = library.manual_run()
        if run is None or not run.current:
            raise HTTPException(409, "Start a manual batch before importing a reply.")
        cards = run.import_cards(paste.reply)
        run = run.advance(cards)
        library.save_manual(run, cards)
        return {"manual": run.status(), "cards": cards}

    @app.delete("/api/manual/{code}")
    async def close_manual(code: str):
        idle()
        run = library.manual_run()
        if run is None or run.code != code:
            raise HTTPException(409, "This manual run has changed. Refresh Gloss and try again.")
        library.clear_manual()
        return {"closed": True}

    @app.post("/api/generate")
    async def generate(paste: Paste):
        idle()
        entries = [entry for entry in parse_entries(paste.text) if not entry.warning]
        if not entries:
            raise ValueError("Paste at least one word.")
        if len(entries) > configuration.preferences.word_cap and not paste.confirm_over_cap:
            raise ValueError(
                "This list exceeds your word limit. Confirm the larger batch to continue."
            )

        async def run(job: Job, model, synth, preferences):
            await write_cards(job, entries, paste.deck, model, synth, preferences)

        job = jobs.start("text", lambda job: with_providers(job, run))
        return {"id": job.id, "kind": job.kind, "stage": job.stage}

    @app.post("/api/cards/{card_id}/retry")
    async def retry(card_id: str):
        idle()
        card = library.get(card_id)

        async def run(job: Job, model, synth, preferences):
            await write_cards(
                job,
                [Entry(index=0, word=card.source_word, hint=card.hint)],
                card.deck,
                model,
                synth,
                preferences,
                card_id,
            )

        job = jobs.start("text", lambda job: with_providers(job, run))
        return {"id": job.id, "kind": job.kind, "stage": job.stage}

    @app.patch("/api/cards/{card_id}")
    async def edit(card_id: str, edit: CardEdit):
        idle(during_audio=True)
        card = library.get(card_id)
        previous = card.base_identity()
        for key, value in edit.model_dump().items():
            setattr(card, key, value)
        if previous != card.base_identity():
            card.sync_identity = ""
            card.note_id = None
            card.synced_hash = ""
            card.decision = "ask"
        elif card.synced_hash and card.content_hash() != card.synced_hash:
            card.synced_hash = ""
        card.audio_errors.clear()
        return library.save(valid_audio(card))

    @app.delete("/api/cards/{card_id}")
    async def remove(card_id: str):
        idle(during_audio=True)
        library.delete(card_id)
        return {"removed": card_id}

    @app.post("/api/audio")
    async def audio(selection: Selection):
        idle()
        if not audio_ready():
            raise ValueError(
                "Set WOOF_MODEL_DIR in your .env file, then restart Gloss."
                if configuration.preferences.audio_provider == "woof"
                else "Set GOOGLE_CLOUD_PROJECT in your .env file, then restart Gloss."
            )
        cards = valid_cards(selected(selection.ids))
        if any(not card.ready() for card in cards):
            raise ValueError(
                "Fill in and verify these cards, or remove them before recording audio."
            )

        async def run(job: Job, _model, synth, preferences):
            stats = await orchestrator.audio(job, cards, synth, preferences, selection.kind)
            job.emit("summary", {"audio": stats})

        job = jobs.start("audio", lambda job: with_providers(job, run))
        return {"id": job.id, "kind": job.kind, "stage": job.stage}

    @app.put("/api/batch/deck")
    async def batch_deck(selection: BatchDeck):
        idle()
        if not selection.deck.startswith(configuration.preferences.deck_parent + "::"):
            raise ValueError("Choose a subdeck inside your parent deck.")
        cards = selected(selection.ids)
        for card in cards:
            card.deck = selection.deck
        return library.save_many(cards)

    @app.get("/api/jobs/{job_id}/events")
    async def events(
        job_id: str, last_event_id: Annotated[str | None, Header()] = None, after: int = 0
    ):
        job = jobs.get(job_id)
        cursor = after
        if last_event_id:
            try:
                cursor = int(last_event_id)
            except ValueError:
                raise HTTPException(400, "Invalid event cursor.") from None
        return StreamingResponse(
            job.stream(cursor), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"}
        )

    @app.post("/api/jobs/{job_id}/cancel")
    async def cancel(job_id: str):
        job = jobs.get(job_id)
        if job.kind == "sync":
            raise HTTPException(409, "Wait for Gloss to finish saving the notes to Anki.")
        if job.task and not job.done:
            job.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await job.task
        return {"cancelled": True}

    @app.get("/api/anki")
    async def anki():
        return await gateway.status(configuration.preferences)

    @app.post("/api/anki/setup")
    async def setup(options: Setup):
        idle()
        await gateway.setup(configuration.preferences, options.move_parent_cards)
        return await gateway.status(configuration.preferences)

    @app.post("/api/anki/decks")
    async def deck(name: DeckName):
        idle()
        return {"deck": await gateway.add_deck(configuration.preferences, name.name)}

    @app.post("/api/anki/conflicts")
    async def conflicts(selection: ProfileSelection):
        idle()
        if selection.expected_profile:
            profile = await gateway.client.call("getActiveProfile")
            if selection.expected_profile != profile:
                raise ValueError("Switch back to the original Anki profile before retrying.")
        return await gateway.conflicts(selected(selection.ids), configuration.preferences)

    @app.post("/api/anki/pull")
    async def pull(selection: ProfileSelection):
        idle()
        selected(selection.ids)
        profile = await gateway.client.call("getActiveProfile")
        if selection.expected_profile and selection.expected_profile != profile:
            raise ValueError("Switch back to the original Anki profile before retrying.")
        await gateway.client.call("sync")
        ticket = secrets.token_urlsafe(32)
        sync_ticket.clear()
        sync_ticket.update(ticket=ticket, ids=sorted(set(selection.ids)), profile=profile)
        return {"ticket": ticket, "profile": profile}

    @app.post("/api/anki/sync")
    async def sync(selection: SyncSelection):
        idle()
        if (
            not selection.ticket
            or selection.ticket != sync_ticket.get("ticket")
            or sorted(set(selection.ids)) != sync_ticket.get("ids")
        ):
            raise ValueError("Start Anki sync and confirm it completed before sending notes.")
        cards = valid_cards(selected(selection.ids))
        preferences = configuration.preferences.model_copy(deep=True)
        profile = sync_ticket["profile"]
        sync_ticket.clear()
        if cards:
            preferences.last_deck = cards[0].deck
            configuration.save(preferences)
        job = jobs.start(
            "sync",
            lambda job: gateway.sync(job, cards, preferences, selection.allow_missing, profile),
        )
        return {"id": job.id, "kind": job.kind, "stage": job.stage}

    @app.get("/media/{filename}")
    async def media(filename: str):
        if not re.fullmatch(r"gloss_[0-9a-f]{64}\.mp3", filename):
            raise HTTPException(404)
        path = library.media / filename
        if not path.is_file():
            raise HTTPException(404)
        return FileResponse(path, media_type="audio/mpeg")

    @app.get("/assets/fonts/{filename}")
    async def font(filename: str):
        path = available_fonts(configuration.directory / "fonts").get(filename)
        if path is None:
            raise HTTPException(404)
        return FileResponse(path)

    if frontend:
        frontend = frontend.resolve()
        if configuration.directory.resolve().is_relative_to(frontend):
            raise ValueError("The config directory must be outside the served frontend.")
        assets = frontend / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="frontend-assets")

    @app.get("/favicon.svg")
    async def favicon():
        if frontend and (frontend / "favicon.svg").is_file():
            return FileResponse(frontend / "favicon.svg", media_type="image/svg+xml")
        raise HTTPException(404)

    @app.get("/")
    async def index():
        if frontend and (frontend / "index.html").exists():
            return FileResponse(frontend / "index.html")
        return HTMLResponse(
            "<h1>Gloss</h1><p>Build the frontend with pnpm build, then restart Gloss.</p>"
        )

    return app
