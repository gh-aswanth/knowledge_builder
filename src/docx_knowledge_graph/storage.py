import json
import os
import re
import secrets
import threading
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from .chat_agent import ChatService
from .errors import WorkspaceError
from .extraction import load_graph, validate_graph
from .settings import Settings


@dataclass
class GraphContext:
    identifier: str
    graph: dict
    chat: ChatService
    leases: int = 0


class GraphStore:
    def __init__(self, settings: Settings, chat_factory=ChatService):
        self.settings = settings
        self.directory = settings.data_dir.resolve() / "graphs"
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.chat_factory = chat_factory
        self.contexts = OrderedDict()
        self.lock = threading.RLock()

    def path(self, identifier: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise WorkspaceError(
                "Graph not found. Upload a document to begin.", "GRAPH_NOT_FOUND", 404
            )
        return self.directory / f"{identifier}.json"

    def save(self, graph: dict) -> str:
        validate_graph(graph)
        content = json.dumps(graph, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(content) > self.settings.max_graph_bytes:
            raise WorkspaceError(
                f"Generated graph exceeds the {self.settings.max_graph_bytes / 1024 / 1024:g} MiB limit. Use a smaller document.",
                "GRAPH_TOO_LARGE",
                413,
            )
        with self.lock:
            files = list(self.directory.glob("*.json"))
            if (
                len(files) >= self.settings.max_documents
                or sum(path.stat().st_size for path in files) + len(content)
                > self.settings.max_storage_bytes
            ):
                raise WorkspaceError(
                    "Document storage is full. Archive or remove graph files from the data directory.",
                    "STORAGE_FULL",
                    507,
                )
            identifier = secrets.token_hex(16)
            destination = self.path(identifier)
            temporary = destination.with_suffix(".tmp")
            try:
                with temporary.open("xb") as output:
                    os.chmod(temporary, 0o600)
                    output.write(content)
                temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
            return identifier

    def acquire(self, identifier: str) -> GraphContext:
        with self.lock:
            if identifier not in self.contexts:
                path = self.path(identifier)
                if not path.is_file():
                    raise WorkspaceError(
                        "Graph not found. Upload the document again.", "GRAPH_NOT_FOUND", 404
                    )
                if len(self.contexts) >= self.settings.cached_graphs:
                    evict = next(
                        (
                            key
                            for key, context in self.contexts.items()
                            if not context.leases and context.chat.active is None
                        ),
                        None,
                    )
                    if evict is None:
                        raise WorkspaceError(
                            "All graph workspaces are busy. Try again shortly.",
                            "WORKSPACE_BUSY",
                            429,
                        )
                    self.contexts.pop(evict)
                try:
                    graph = load_graph(path)
                except (ValueError, RecursionError) as error:
                    raise WorkspaceError(
                        "The saved graph is invalid. Upload the original document again.",
                        "INVALID_GRAPH",
                        422,
                    ) from error
                self.contexts[identifier] = GraphContext(
                    identifier, graph, self.chat_factory(graph)
                )
            self.contexts.move_to_end(identifier)
            context = self.contexts[identifier]
            context.leases += 1
            return context

    def release(self, context: GraphContext) -> None:
        with self.lock:
            context.leases = max(0, context.leases - 1)

    def close(self) -> None:
        with self.lock:
            for context in self.contexts.values():
                if context.chat.active:
                    context.chat.active.cancelled.set()
