import json
import runpy
import tomllib
from pathlib import Path

from fastapi.testclient import TestClient

from docx_knowledge_graph.chat_agent import RUN_TIMEOUT
from test_api import docx_bytes

PROJECT_DIR = Path(__file__).resolve().parents[1]


def test_vercel_configuration_points_to_asgi_entrypoint():
    config = json.loads((PROJECT_DIR / "vercel.json").read_text())
    project = tomllib.loads((PROJECT_DIR / "pyproject.toml").read_text())
    assert config["framework"] == "fastapi"
    assert config["functions"]["main.py"]["maxDuration"] > RUN_TIMEOUT
    assert "--extra chat" in config["installCommand"]
    assert "--active" in config["installCommand"]
    assert "--frozen" in config["installCommand"]
    assert project["tool"]["vercel"]["entrypoint"] == "main:app"
    assert project["tool"]["vercel"]["fastapi"]["static"]["cdn"] is False


def test_vercel_entrypoint_uses_temporary_bounded_storage(tmp_path, monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setattr("tempfile.gettempdir", lambda: str(tmp_path))
    namespace = runpy.run_path(str(PROJECT_DIR / "main.py"))
    settings = namespace["settings"]
    assert settings.data_dir == tmp_path / "docx-knowledge-graph"
    assert settings.max_upload_bytes == settings.max_graph_bytes == 3 * 1024 * 1024
    with TestClient(namespace["app"]) as client:
        workspace = client.get("/api/workspace").json()
        assert workspace["max_upload_bytes"] == settings.max_upload_bytes
        client.headers["X-Workspace-Token"] = workspace["token"]
        response = client.post("/api/documents", files={"file": ("example.docx", docx_bytes())})
        assert response.status_code == 201
        assert client.get(response.json()["download_url"]).status_code == 200
        for path in ["/", "/static/viewer.js", "/static/chat.js"]:
            served = client.get(path)
            assert served.status_code == 200
            assert "script-src 'self'" in served.headers["content-security-policy"]


def test_entrypoint_keeps_local_settings_outside_vercel(tmp_path, monkeypatch):
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.setenv("DOCX_KG_DATA_DIR", str(tmp_path))
    settings = runpy.run_path(str(PROJECT_DIR / "main.py"))["settings"]
    assert settings.data_dir == tmp_path
    assert settings.max_upload_bytes == 20 * 1024 * 1024
