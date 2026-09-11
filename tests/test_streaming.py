import asyncio
import json

import httpx
import pytest

from docx_knowledge_graph.app import create_app
from docx_knowledge_graph.chat_agent import ChatService
from docx_knowledge_graph.errors import WorkspaceError
from docx_knowledge_graph.settings import Settings
from docx_knowledge_graph.storage import GraphStore
from docx_knowledge_graph.streaming import ChatEventResponse
from test_chat_agent import AgentFixture
from test_graph_query import fixture_graph


class SlowAgent(AgentFixture):
    async def astream_events(self, *arguments, **options):
        await asyncio.sleep(30)
        return await super().astream_events(*arguments, **options)


class SlowService(ChatService):
    def __init__(self, graph):
        super().__init__(graph, lambda graph_tools: SlowAgent())

    async def execute(self, run, emit):
        await self.execute_untraced(run, emit)


@pytest.mark.parametrize("disconnect", [True, False])
async def test_stream_cancel_and_disconnect_release_graph_and_admission(tmp_path, disconnect):
    app = create_app(
        Settings(data_dir=tmp_path),
        chat_factory=SlowService,
        status_provider=lambda: {"ready": True, "issues": []},
    )
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            token = (await client.get("/api/workspace")).json()["token"]
            client.headers["X-Workspace-Token"] = token
            identifier = app.state.store.save(fixture_graph())
            base = f"/api/graphs/{identifier}/chat"
            chat_token = (await client.get(base + "/status")).json()["token"]
            client.headers["X-Chat-Token"] = chat_token
            body = json.dumps({"message": "Slow query"}).encode()
            scope = {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.0"},
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": base,
                "raw_path": base.encode(),
                "root_path": "",
                "query_string": b"",
                "headers": [
                    (b"host", b"testserver"),
                    (b"content-type", b"application/json"),
                    (b"x-workspace-token", token.encode()),
                    (b"x-chat-token", chat_token.encode()),
                ],
                "client": ("127.0.0.1", 1234),
                "server": ("testserver", 80),
            }
            received = asyncio.Queue()
            await received.put({"type": "http.request", "body": body, "more_body": False})
            started = asyncio.Event()
            frames = []

            async def send(message):
                if message["type"] == "http.response.body" and message.get("body"):
                    frames.append(message["body"])
                    started.set()

            task = asyncio.create_task(app(scope, received.get, send))
            try:
                await asyncio.wait_for(started.wait(), 3)
                context = app.state.store.contexts[identifier]
                run = context.chat.active
                assert context.leases == 1 and run is not None
                assert (await client.post(base, json={"message": "Busy"})).status_code == 429
                if disconnect:
                    await received.put({"type": "http.disconnect"})
                else:
                    result = await client.post(base + "/cancel", json={"run_id": run.identifier})
                    assert result.json() == {"cancelled": True}
                await asyncio.wait_for(task, 3)
                assert context.leases == 0 and context.chat.active is None
                assert app.state.chat_slots._value == 2
                assert not context.chat.sessions[run.session_id].messages
                if not disconnect:
                    assert b"event: run_cancelled" in b"".join(frames)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)


async def test_sse_output_limit_is_bounded():
    service = ChatService(fixture_graph())
    run = service.reserve({"message": "Question"})
    response = ChatEventResponse(service, run, lambda: None)
    response.byte_count = 2 * 1024 * 1024
    with pytest.raises(ValueError, match="output limit"):
        response.emit("llm_delta", {"text": "Too much"})
    assert response.events.empty()
    response.emit("run_error", {"message": "Output limit"})
    assert response.events.qsize() == 1
    service.release(run)


def test_leased_graph_is_not_evicted(tmp_path):
    store = GraphStore(Settings(data_dir=tmp_path, cached_graphs=1))
    first = store.save(fixture_graph())
    second = store.save(fixture_graph())
    context = store.acquire(first)
    with pytest.raises(WorkspaceError, match="busy"):
        store.acquire(second)
    store.release(context)
    other = store.acquire(second)
    assert first not in store.contexts
    store.release(other)
    store.close()
