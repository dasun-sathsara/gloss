import asyncio
import json
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4


@dataclass
class Job:
    kind: str
    id: str = field(default_factory=lambda: uuid4().hex)
    events: list[dict[str, Any]] = field(default_factory=list)
    done: bool = False
    task: asyncio.Task[None] | None = None
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    created: float = field(default_factory=time.monotonic)

    def emit(self, event: str, data: Any) -> None:
        self.events.append({"id": len(self.events) + 1, "event": event, "data": data})
        self.changed.set()

    async def stream(self, after: int):
        cursor = max(0, after)
        while True:
            self.changed.clear()
            for event in self.events[cursor:]:
                cursor = event["id"]
                yield (
                    f"id: {cursor}\nevent: {event['event']}\n"
                    f"data: {json.dumps(event['data'], ensure_ascii=False)}\n\n"
                )
            # An event can arrive while the consumer is sending the previous slice.
            # Drain it before closing, especially the terminal done event.
            if cursor < len(self.events):
                continue
            if self.done:
                return
            try:
                await asyncio.wait_for(self.changed.wait(), timeout=15)
            except TimeoutError:
                yield ": keepalive\n\n"


class Jobs:
    def __init__(self):
        self.history: deque[Job] = deque(maxlen=20)

    @property
    def active(self) -> Job | None:
        return next((job for job in self.history if not job.done), None)

    def start(self, kind: str, run) -> Job:
        if self.active:
            raise ValueError("A run is already active. Wait or cancel it first.")
        job = Job(kind=kind)
        self.history.append(job)

        async def execute() -> None:
            try:
                await run(job)
            except asyncio.CancelledError:
                job.emit("cancelled", {"message": "Stopped. Completed work is saved."})
            except Exception as exc:
                from gloss.core.ports import ProviderError

                message = (
                    str(exc)
                    if isinstance(exc, (ProviderError, ValueError))
                    else (
                        "The run stopped unexpectedly. Your library is saved. Check the server log."
                    )
                )
                if not isinstance(exc, (ProviderError, ValueError)):
                    import logging

                    logging.getLogger("gloss").exception("Run failed")
                job.emit("failed", {"message": message})
            finally:
                job.done = True
                job.emit("done", {"job_id": job.id})

        job.task = asyncio.create_task(execute())

        def finished(task: asyncio.Task[None]) -> None:
            if task.cancelled() and not job.done:
                job.emit("cancelled", {"message": "Stopped before the run started."})
                job.done = True
                job.emit("done", {"job_id": job.id})

        job.task.add_done_callback(finished)
        return job

    def get(self, job_id: str) -> Job:
        for job in self.history:
            if job.id == job_id:
                return job
        raise KeyError(job_id)
