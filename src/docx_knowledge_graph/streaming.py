import asyncio
import json

import anyio
from starlette.responses import StreamingResponse

from .chat_agent import ChatError


class ChatEventResponse(StreamingResponse):
    def __init__(self, service, run, release_slot):
        self.service = service
        self.run = run
        self.release_slot = release_slot
        self.producer = None
        self.events = asyncio.Queue()
        self.sequence = 0
        self.byte_count = 0
        super().__init__(
            self.stream(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"}
        )

    def emit(self, kind: str, data: dict) -> None:
        self.sequence += 1
        payload = {"sequence": self.sequence, **data}
        frame = (
            f"event: {kind}\ndata: "
            + json.dumps(payload, ensure_ascii=False, allow_nan=False)
            + "\n\n"
        ).encode("utf-8")
        self.byte_count += len(frame)
        if (self.sequence > 10000 or self.byte_count > 2 * 1024 * 1024) and kind not in {
            "run_error",
            "run_cancelled",
            "run_end",
        }:
            raise ChatError(
                "Chat output limit reached. Try a narrower question.", "CHAT_OUTPUT_LIMIT", 422
            )
        self.events.put_nowait(frame)

    async def produce(self):
        try:
            await self.service.execute(self.run, self.emit)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.emit(
                "run_error",
                {
                    "code": "CHAT_SETUP",
                    "message": "Chat could not start. Check uv dependencies and the server's OpenAI configuration.",
                },
            )
        finally:
            self.events.put_nowait(None)

    async def stream(self):
        self.producer = asyncio.create_task(self.produce())
        while True:
            event = await self.events.get()
            if event is None:
                break
            yield event

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.run.cancelled.set()
            try:
                with anyio.CancelScope(shield=True):
                    if self.producer:
                        self.producer.cancel()
                        await asyncio.gather(self.producer, return_exceptions=True)
            finally:
                self.service.release(self.run)
                self.release_slot()
