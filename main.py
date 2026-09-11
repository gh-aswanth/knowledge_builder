import os
from pathlib import Path
from tempfile import gettempdir

from docx_knowledge_graph.app import create_app
from docx_knowledge_graph.settings import Settings

settings = (
    Settings(
        data_dir=Path(gettempdir()) / "docx-knowledge-graph",
        max_upload_bytes=3 * 1024 * 1024,
        max_graph_bytes=3 * 1024 * 1024,
        max_storage_bytes=128 * 1024 * 1024,
    )
    if os.environ.get("VERCEL") == "1"
    else Settings()
)

app = create_app(settings)
