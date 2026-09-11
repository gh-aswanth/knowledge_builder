import argparse
from pathlib import Path

import uvicorn

from .app import create_app
from .settings import Settings


def main():
    parser = argparse.ArgumentParser(description="Serve the DOCX knowledge graph workspace.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument(
        "--graph", type=Path, help="Optionally open an existing graph JSON at startup"
    )
    options = parser.parse_args()
    settings = Settings(
        data_dir=options.data_dir or Settings().data_dir, initial_graph=options.graph
    )
    uvicorn.run(create_app(settings), host=options.host, port=options.port, limit_concurrency=64)


if __name__ == "__main__":
    main()
