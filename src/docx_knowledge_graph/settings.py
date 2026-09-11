import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(
        default_factory=lambda: Path(os.environ.get("DOCX_KG_DATA_DIR", ".data"))
    )
    initial_graph: Path | None = None
    max_upload_bytes: int = 20 * 1024 * 1024
    max_graph_bytes: int = 50 * 1024 * 1024
    max_storage_bytes: int = 1024 * 1024 * 1024
    max_documents: int = 128
    cached_graphs: int = 8
