import io
import json
import zipfile
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from docx_knowledge_graph.app import create_app
from docx_knowledge_graph.chat_agent import ChatService
from docx_knowledge_graph.settings import Settings
from test_chat_agent import AgentFixture
from test_graph_query import fixture_graph


def docx_bytes(text="Alpha uses Beta.", xml=None):
    document = (
        xml
        or f"""<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Services</w:t></w:r></w:p>
      <w:p><w:r><w:t>{text}</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Beta</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>Platform</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>"""
    )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", document)
    return output.getvalue()


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path)


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as current:
        current.headers["X-Workspace-Token"] = current.get("/api/workspace").json()["token"]
        yield current


def upload(client, filename="Example.docx", content=None):
    return client.post(
        "/api/documents", files={"file": (filename, docx_bytes() if content is None else content)}
    )


def test_docx_upload_returns_graph_and_persists(client, settings):
    response = upload(client, r"C:\documents\Example.docx")
    assert response.status_code == 201, response.text
    result = response.json()
    graph = result["graph"]
    assert result["filename"] == graph["metadata"]["source"] == "Example.docx"
    assert {node["type"] for node in graph["nodes"]} == {
        "Document",
        "Section",
        "Passage",
        "Concept",
    }
    assert any(node["properties"].get("kind") == "table_row" for node in graph["nodes"])
    saved = settings.data_dir / "graphs" / f"{result['graph_id']}.json"
    assert json.loads(saved.read_text()) == graph
    assert client.get(f"/api/graphs/{result['graph_id']}").json() == graph
    download = client.get(result["download_url"])
    assert download.json() == graph
    assert "Example.graph.json" in download.headers["content-disposition"]
    assert not list(settings.data_dir.rglob("*.docx"))


def test_import_download_and_restart(client, settings):
    first = upload(client).json()
    downloaded = client.get(first["download_url"]).content
    second = upload(client, "restored.json", downloaded).json()
    assert second["graph_id"] != first["graph_id"]
    assert second["graph"] == first["graph"]
    with TestClient(create_app(settings)) as restarted:
        assert restarted.get(f"/api/graphs/{first['graph_id']}").json() == first["graph"]


@pytest.mark.parametrize(
    "filename,content,status",
    [
        ("example.txt", b"hello", 415),
        ("empty.docx", b"", 422),
        ("bad.docx", b"not a zip", 422),
        ("bad.json", b"{}", 422),
        ("bad.json", b"{", 422),
        ("bad.docx", docx_bytes(xml="<unclosed>"), 422),
        (
            "bad.json",
            json.dumps({**fixture_graph(), "metadata": {"number": float("inf")}}).encode(),
            422,
        ),
    ],
)
def test_invalid_uploads_are_structured_and_not_saved(client, settings, filename, content, status):
    response = upload(client, filename, content)
    assert response.status_code == status, response.text
    assert isinstance(response.json()["error"]["message"], str)
    assert not list((settings.data_dir / "graphs").iterdir())


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16"])
def test_xml_entities_are_rejected(client, encoding):
    xml = f'''<?xml version="1.0" encoding="{encoding}"?>
    <!DOCTYPE document [<!ENTITY private SYSTEM "file:///etc/passwd">]>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:body><w:p><w:r><w:t>&private;</w:t></w:r></w:p></w:body></w:document>'''
    response = upload(client, content=docx_bytes(xml=xml.encode(encoding)))
    assert response.status_code == 422
    assert "root:" not in response.text


def test_upload_limit_and_missing_file(settings):
    with TestClient(create_app(replace(settings, max_upload_bytes=100))) as client:
        client.headers["X-Workspace-Token"] = client.get("/api/workspace").json()["token"]
        assert upload(client, content=b"x" * 101).status_code == 413
        assert upload(client, content=b"x" * 70000).status_code == 413
        assert client.post("/api/documents").status_code == 422


@pytest.mark.parametrize(
    "headers",
    [
        {"X-Workspace-Token": "wrong"},
        {"Origin": "https://untrusted.example"},
        {"Sec-Fetch-Site": "cross-site"},
    ],
)
def test_write_guards(client, headers):
    response = client.post(
        "/api/documents", files={"file": ("example.docx", docx_bytes())}, headers=headers
    )
    assert response.status_code == 403


def test_static_assets_and_security_headers(client):
    for path in [
        "/",
        "/static/viewer.js",
        "/static/workspace.js",
        "/static/chat.js",
        "/static/appearance.css",
        "/static/vendor/markdown-it.min.js",
    ]:
        response = client.get(path)
        assert response.status_code == 200
        assert response.content
        assert "script-src 'self'" in response.headers["content-security-policy"]
        assert response.headers["x-content-type-options"] == "nosniff"
    assert client.get("/static/../CHAT_PROMPT.md").status_code == 404
    assert client.get("/api/graphs/not-a-graph").status_code == 404
    assert client.get("/api/graphs/" + "a" * 32).status_code == 404
    assert client.get("/openapi.json").status_code == 200


def test_query_and_document_isolation(client):
    first = upload(client).json()["graph_id"]
    second = upload(client, "Second.docx", docx_bytes("Gamma manages Delta.")).json()["graph_id"]
    payload = {
        "query": "MATCH (passage:Passage) WHERE passage.text CONTAINS $term RETURN passage.text",
        "parameters": {"term": "Alpha"},
    }
    assert client.post(f"/api/graphs/{first}/query", json=payload).json()["rows"] == [
        ["Alpha uses Beta."]
    ]
    assert client.post(f"/api/graphs/{second}/query", json=payload).json()["rows"] == []
    invalid = client.post(f"/api/graphs/{first}/query", json={"query": "CREATE (node)"})
    assert invalid.status_code == 400
    assert "line" in invalid.json()["error"]
    assert (
        client.post(
            f"/api/graphs/{first}/query", content="{}", headers={"Content-Type": "text/plain"}
        ).status_code
        == 415
    )
    assert (
        client.post(
            f"/api/graphs/{first}/query",
            content='{"query":"RETURN 1","parameters":{"bad":NaN}}',
            headers={"Content-Type": "application/json"},
        ).status_code
        == 400
    )


def test_chunked_json_body_limit(client):
    identifier = upload(client).json()["graph_id"]
    response = client.post(
        f"/api/graphs/{identifier}/query",
        content=iter([b"x" * 40000, b"y" * 40000]),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 413


def test_storage_full_is_explicit(settings):
    with TestClient(create_app(replace(settings, max_documents=1))) as client:
        client.headers["X-Workspace-Token"] = client.get("/api/workspace").json()["token"]
        assert upload(client).status_code == 201
        response = upload(client)
        assert response.status_code == 507
        assert response.json()["error"]["code"] == "STORAGE_FULL"


class ScriptedService(ChatService):
    def __init__(self, graph):
        super().__init__(graph, lambda graph_tools: AgentFixture())

    async def execute(self, run, emit):
        await self.execute_untraced(run, emit)


def decode_events(content):
    return [
        (frame.split("\n", 1)[0][7:], json.loads(frame.split("\ndata: ", 1)[1]))
        for frame in content.strip().split("\n\n")
    ]


def test_chat_sse_and_isolated_sessions(settings):
    app = create_app(
        settings,
        chat_factory=ScriptedService,
        status_provider=lambda: {"ready": True, "issues": []},
    )
    with TestClient(app) as client:
        client.headers["X-Workspace-Token"] = client.get("/api/workspace").json()["token"]
        first = upload(client, "graph.json", json.dumps(fixture_graph()).encode()).json()[
            "graph_id"
        ]
        second = upload(client).json()["graph_id"]
        first_base, second_base = f"/api/graphs/{first}/chat", f"/api/graphs/{second}/chat"
        first_token = client.get(first_base + "/status").json()["token"]
        second_token = client.get(second_base + "/status").json()["token"]
        assert first_token != second_token
        assert client.post(first_base, json={"message": "Count"}).status_code == 403
        response = client.post(
            first_base, json={"message": "Count"}, headers={"X-Chat-Token": first_token}
        )
        assert response.status_code == 200, response.text
        assert response.headers["content-type"].startswith("text/event-stream")
        events = decode_events(response.text)
        assert events[0][0] == "run_start" and events[-1][0] == "run_end"
        assert [data["sequence"] for kind, data in events] == list(range(1, len(events) + 1))
        assert any(
            kind == "query_result" and data["result"]["rows"] == [[3]] for kind, data in events
        )
        session = events[0][1]["session_id"]
        assert (
            client.post(
                second_base,
                json={"message": "Again", "session_id": session},
                headers={"X-Chat-Token": second_token},
            ).status_code
            == 410
        )
        assert client.post(
            first_base + "/reset",
            json={"session_id": session},
            headers={"X-Chat-Token": first_token},
        ).json() == {"cleared": True}
        assert (
            client.post(
                first_base,
                json={"message": "Again", "session_id": session},
                headers={"X-Chat-Token": first_token},
            ).status_code
            == 410
        )
        context = app.state.store.contexts[first]
        assert context.leases == 0 and context.chat.active is None
        assert app.state.chat_slots._value == 2


def test_chat_unavailable_does_not_block_graph(client, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    identifier = upload(client).json()["graph_id"]
    base = f"/api/graphs/{identifier}"
    status = client.get(base + "/chat/status").json()
    assert not status["ready"]
    assert (
        client.post(
            base + "/chat", json={"message": "Hello"}, headers={"X-Chat-Token": status["token"]}
        ).status_code
        == 503
    )
    assert client.post(base + "/query", json={"query": "RETURN 1"}).json()["rows"] == [[1]]
