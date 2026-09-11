import json
import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from docx_knowledge_graph.app import create_app
from docx_knowledge_graph.chat_agent import (
    ChatService,
    GraphTools,
    chat_status,
    create_graph_agent,
    validate_api_key,
)
from docx_knowledge_graph.settings import Settings
from test_api import decode_events, upload
from test_chat_agent import AgentFixture
from test_graph_query import fixture_graph


def test_status_separates_credentials_from_dependencies(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with patch(
        "docx_knowledge_graph.chat_agent.importlib.metadata.version", return_value="missing"
    ):
        status = chat_status()
        assert not status["runtime_ready"] and not status["ready"]
        assert not status["key_configured"]
        assert len(status["issues"]) > len(status["runtime_issues"])
        monkeypatch.setenv("OPENAI_API_KEY", "secret-server-key")
        configured = chat_status()
        assert configured["key_configured"] and not configured["ready"]
        assert "secret-server-key" not in json.dumps(configured)


@pytest.mark.parametrize(
    "value",
    ["", "   ", "key with spaces", "key\r\nheader", "key\x00", "clé", "x" * 1025, 123, [], {}],
)
def test_invalid_key_values_are_rejected_without_echoing(value):
    with pytest.raises(ValueError, match="API key"):
        validate_api_key(value)


def test_key_whitespace_is_trimmed_and_null_uses_environment():
    assert validate_api_key("  test-secret-key \n") == "test-secret-key"
    assert validate_api_key(None) is None


@pytest.mark.parametrize("explicit", [None, "test-tab-key"])
def test_model_receives_key_directly_without_changing_environment(monkeypatch, explicit):
    pytest.importorskip("langchain_openai")
    monkeypatch.setenv("OPENAI_API_KEY", "test-server-key")
    with patch("langchain_openai.ChatOpenAI") as model, patch("langchain.agents.create_agent"):
        create_graph_agent(GraphTools(fixture_graph()), api_key=explicit)
    assert model.call_args.kwargs["api_key"] == (explicit or "test-server-key")
    assert os.environ["OPENAI_API_KEY"] == "test-server-key"


def test_per_request_keys_reach_agent_but_not_history_graph_or_status(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    received_keys, agents, runs = [], [], []

    def agent_factory(graph_tools, *, api_key=None):
        received_keys.append(api_key)
        agent = AgentFixture()
        agents.append(agent)
        return agent

    class KeyedService(ChatService):
        def __init__(self, graph):
            super().__init__(graph, agent_factory)

        async def execute(self, run, emit):
            runs.append(run)
            await self.execute_untraced(run, emit)

    status = {
        "ready": False,
        "runtime_ready": True,
        "runtime_issues": [],
        "issues": ["Enter an API key"],
        "key_configured": False,
    }
    app = create_app(
        Settings(data_dir=tmp_path), chat_factory=KeyedService, status_provider=lambda: status
    )
    with TestClient(app) as client:
        client.headers["X-Workspace-Token"] = client.get("/api/workspace").json()["token"]
        identifier = upload(client).json()["graph_id"]
        base = f"/api/graphs/{identifier}/chat"
        client.headers["X-Chat-Token"] = client.get(base + "/status").json()["token"]
        secret = "test-request-only-secret"
        response = client.post(base, json={"message": "Question", "api_key": secret})
        assert response.status_code == 200
        session_id = decode_events(response.text)[0][1]["session_id"]
        assert received_keys == [secret]
        assert secret not in response.text
        assert secret not in client.get(base + "/status").text
        assert secret not in json.dumps(agents[0].payload)
        assert secret not in repr(runs[0]) and runs[0].api_key is None
        assert secret not in repr(app.state.store.contexts[identifier].chat.sessions)
        assert all(secret not in path.read_text() for path in tmp_path.rglob("*.json"))
        missing = client.post(base, json={"message": "Again", "session_id": session_id})
        assert missing.status_code == 503
        replaced = client.post(
            base, json={"message": "Again", "session_id": session_id, "api_key": "test-replacement"}
        )
        assert replaced.status_code == 200 and received_keys[-1] == "test-replacement"
        status["runtime_ready"] = False
        status["runtime_issues"] = ["Dependencies missing"]
        unavailable = client.post(base, json={"message": "Question", "api_key": secret})
        assert (
            unavailable.status_code == 503
            and unavailable.json()["error"]["message"] == "Dependencies missing"
        )
        invalid = client.post(base, json={"message": "Question", "api_key": secret + "\ninvalid"})
        assert invalid.status_code == 400 and secret not in invalid.text
        assert app.state.chat_slots._value == 2


async def test_cancelled_run_releases_credential():
    service = ChatService(fixture_graph(), lambda graph_tools, **options: AgentFixture())
    run = service.reserve({"message": "Question"}, api_key="test-cancel-secret")
    assert "test-cancel-secret" not in repr(run)
    service.cancel(run.identifier)
    await service.execute_untraced(run, lambda kind, data: None)
    assert run.api_key is None
    service.release(run)
    assert service.active is None
