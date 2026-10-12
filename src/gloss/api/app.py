import asyncio
import contextlib
import re
import secrets
from contextlib import asynccontextmanager
from importlib.metadata import version
from pathlib import Path
from typing import Annotated, Any, Literal

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from gloss.anki.client import AnkiClient
from gloss.anki.gateway import AnkiGateway
from gloss.anki.templates import available_fonts
from gloss.config import VOICES, Configuration, Preferences
from gloss.core.events import Job, Jobs
from gloss.core.models import CLIP_KINDS, Card, ClipKind, Entry
from gloss.core.orchestrator import Orchestrator, clip_key
from gloss.core.parsing import parse_entries
from gloss.core.ports import ProviderError
from gloss.library.store import Library
from gloss.providers.vertex import VertexLanguageModel, VertexSynthesizer, make_client


class Paste(BaseModel):
    text: str = Field(max_length=20_000)
    deck: str = Field(default="", max_length=200)
    confirm_over_cap: bool = False


class Selection(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=100)
    kind: ClipKind | None = None


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

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        if jobs.active and jobs.active.task:
            jobs.active.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await jobs.active.task
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
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            expected = f"{request.url.scheme}://{request.headers.get('host', '')}"
            if origin != expected:
                return JSONResponse(
                    {"detail": "Use Gloss from its own browser window."}, status_code=403
                )
        if any(part.startswith(".") for part in request.url.path.split("/") if part):
            return JSONResponse({"detail": "Not found."}, status_code=404)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
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

    @app.exception_handler(KeyError)
    async def key_error(_: Request, exc: KeyError):
        return JSONResponse({"detail": "This card or run no longer exists."}, status_code=404)

    def idle() -> None:
        if jobs.active:
            raise HTTPException(409, "Wait for the run to finish, or cancel it to edit.")

    def selected(ids: list[str]) -> list[Card]:
        return [library.get(card_id) for card_id in dict.fromkeys(ids)]

    def valid_audio(card: Card) -> Card:
        for kind in CLIP_KINDS:
            expected = library.clip(clip_key(configuration.preferences, card.clip_text(kind)))
            if card.audio.get(kind) != expected:
                card.audio.pop(kind, None)
        return card

    async def with_provider(job: Job, operation, audio: bool = False) -> None:
        preferences = configuration.preferences.model_copy(deep=True)
        if demo:
            from gloss.providers.demo import DemoLanguageModel, DemoSynthesizer

            provider = DemoSynthesizer() if audio else DemoLanguageModel()
            await operation(job, provider, preferences)
            return
        client = make_client(configuration)
        try:
            provider = (
                VertexSynthesizer(client, preferences)
                if audio
                else VertexLanguageModel(client, preferences)
            )
            await operation(job, provider, preferences)
        finally:
            await client.aio.aclose()
            client.close()

    @app.get("/api/health")
    async def health():
        return {"app": "gloss", "version": app.version}

    @app.get("/api/bootstrap")
    async def bootstrap():
        active = jobs.active
        return {
            "settings": configuration.preferences,
            "voices": VOICES,
            "cards": [valid_audio(card) for card in library.all()],
            "active_job": {"id": active.id, "kind": active.kind} if active else None,
            "provider_ready": bool(configuration.environment.google_cloud_project) or demo,
            "config_dir": str(configuration.directory),
            "demo": demo,
            "fonts_complete": "_StudioFeixenSansVariable.ttf"
            in available_fonts(configuration.directory / "fonts"),
        }

    @app.put("/api/settings")
    async def settings(preferences: Preferences):
        idle()
        configuration.save(preferences)
        for card in library.all():
            library.save(valid_audio(card))
        return preferences

    @app.post("/api/parse")
    async def parse(paste: Paste):
        entries = parse_entries(paste.text)
        count = sum(not entry.duplicate and not entry.warning for entry in entries)
        return {
            "entries": entries,
            "count": count,
            "over_cap": count > configuration.preferences.word_cap,
            "estimate_usd": round(count * configuration.preferences.estimated_usd_per_word, 3),
            "audio_calls": count * 4,
        }

    @app.post("/api/generate")
    async def generate(paste: Paste):
        idle()
        entries = [
            entry
            for entry in parse_entries(paste.text)
            if not entry.duplicate and not entry.warning
        ]
        if not entries:
            raise ValueError("Paste at least one word.")
        if len(entries) > configuration.preferences.word_cap and not paste.confirm_over_cap:
            raise ValueError("This paste exceeds your word cap. Confirm the estimate to continue.")

        async def run(job: Job, provider, preferences):
            await orchestrator.generate(job, entries, paste.deck, provider, preferences)

        job = jobs.start("text", lambda job: with_provider(job, run))
        return {"id": job.id, "kind": job.kind}

    @app.post("/api/cards/{card_id}/retry")
    async def retry(card_id: str):
        idle()
        card = library.get(card_id)

        async def run(job: Job, provider, preferences):
            await orchestrator.generate(
                job,
                [Entry(index=0, word=card.source_word, hint=card.hint)],
                card.deck,
                provider,
                preferences,
                card_id,
            )

        job = jobs.start("text", lambda job: with_provider(job, run))
        return {"id": job.id, "kind": job.kind}

    @app.patch("/api/cards/{card_id}")
    async def edit(card_id: str, edit: CardEdit):
        idle()
        card = library.get(card_id)
        previous = card.base_identity()
        for key, value in edit.model_dump().items():
            setattr(card, key, value)
        if previous != card.base_identity():
            card.sync_identity = ""
            card.note_id = None
            card.synced_hash = ""
        card.audio_errors.clear()
        return library.save(valid_audio(card))

    @app.delete("/api/cards/{card_id}")
    async def remove(card_id: str):
        idle()
        library.delete(card_id)
        return {"removed": card_id}

    @app.post("/api/audio")
    async def audio(selection: Selection):
        idle()
        cards = [valid_audio(card) for card in selected(selection.ids)]
        if any(not card.ready() for card in cards):
            raise ValueError("Finish or remove invalid cards before generating audio.")

        async def run(job: Job, provider, preferences):
            await orchestrator.audio(job, cards, provider, preferences, selection.kind)

        job = jobs.start("audio", lambda job: with_provider(job, run, audio=True))
        return {"id": job.id, "kind": job.kind}

    @app.put("/api/batch/deck")
    async def batch_deck(selection: BatchDeck):
        idle()
        if not selection.deck.startswith(configuration.preferences.deck_parent + "::"):
            raise ValueError("Choose a subdeck under the configured parent.")
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
            raise HTTPException(409, "Anki writes are finishing. Wait to avoid a partial write.")
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
    async def conflicts(selection: Selection):
        idle()
        return await gateway.conflicts(selected(selection.ids), configuration.preferences)

    @app.post("/api/anki/pull")
    async def pull(selection: Selection):
        idle()
        selected(selection.ids)
        profile = await gateway.client.call("getActiveProfile")
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
        cards = [valid_audio(card) for card in selected(selection.ids)]
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
        return {"id": job.id, "kind": job.kind}

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
