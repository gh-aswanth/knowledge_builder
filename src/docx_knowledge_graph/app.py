import asyncio
import json
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Annotated

from fastapi import Depends, FastAPI, File, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException

from .chat_agent import ChatError, ChatService, chat_status, validate_api_key
from .errors import WorkspaceError
from .extraction import build_graph, load_graph, reject_json_constant, validate_graph
from .graph_query import QueryEngine, QueryError, QueryLimitError
from .security import RequestGuards
from .settings import Settings
from .storage import GraphContext, GraphStore
from .streaming import ChatEventResponse

PACKAGE_DIR = Path(__file__).parent


def clean_filename(filename: str) -> str:
    name = filename.replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(character for character in name if character.isprintable()).strip()
    if not name or len(name) > 240 or Path(name).suffix.lower() not in {".docx", ".json"}:
        raise WorkspaceError(
            "Choose a .docx document or an exported .json graph.", "UNSUPPORTED_FILE", 415
        )
    return name


async def json_payload(request: Request) -> dict:
    if request.headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
        raise WorkspaceError("Use Content-Type: application/json.", "CONTENT_TYPE", 415)
    try:
        async with asyncio.timeout(15):
            raw = await request.body()
        if not raw or len(raw) > 64000:
            raise WorkspaceError("Request JSON must contain 1–64,000 bytes.", "INVALID_BODY", 413)
        payload = json.loads(raw, parse_constant=reject_json_constant)
        if not isinstance(payload, dict):
            raise ValueError("Expected an object")
        json.dumps(payload, allow_nan=False)
        return payload
    except TimeoutError as error:
        raise WorkspaceError("Request body timed out.", "REQUEST_TIMEOUT", 408) from error
    except (ValueError, RecursionError) as error:
        if isinstance(error, WorkspaceError):
            raise
        raise WorkspaceError(
            "Request body must be a finite JSON object.", "INVALID_JSON", 400
        ) from error


def create_app(
    settings: Settings | None = None, chat_factory=ChatService, status_provider=chat_status
) -> FastAPI:
    settings = settings or Settings()
    token = secrets.token_urlsafe(32)

    @asynccontextmanager
    async def lifespan(application):
        application.state.store = GraphStore(settings, chat_factory)
        application.state.upload_slots = asyncio.Semaphore(2)
        application.state.query_slots = asyncio.Semaphore(2)
        application.state.chat_slots = asyncio.Semaphore(2)
        application.state.initial_graph_id = None
        if settings.initial_graph:
            graph = await run_in_threadpool(load_graph, settings.initial_graph)
            application.state.initial_graph_id = await run_in_threadpool(
                application.state.store.save, graph
            )
        try:
            yield
        finally:
            application.state.store.close()

    application = FastAPI(
        title="DOCX Knowledge Graph",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
    )
    application.add_middleware(
        RequestGuards, token=token, max_upload_bytes=settings.max_upload_bytes
    )

    @application.exception_handler(WorkspaceError)
    @application.exception_handler(ChatError)
    async def application_error(request, error):
        return JSONResponse(
            {"error": {"code": error.code, "message": str(error)}}, status_code=error.status
        )

    @application.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse(
            {"error": {"code": "HTTP_ERROR", "message": str(error.detail)}},
            status_code=error.status_code,
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse(
            {
                "error": {
                    "code": "INVALID_REQUEST",
                    "message": "Invalid request. Upload one file using the 'file' field.",
                }
            },
            status_code=422,
        )

    async def context_for(graph_id: str, request: Request):
        context = await run_in_threadpool(request.app.state.store.acquire, graph_id)
        try:
            yield context
        finally:
            request.app.state.store.release(context)

    Context = Annotated[GraphContext, Depends(context_for)]

    @application.get("/", include_in_schema=False)
    async def index():
        return FileResponse(PACKAGE_DIR / "static" / "index.html")

    @application.get("/api/workspace")
    async def workspace(request: Request):
        return {
            "token": token,
            "initial_graph_id": request.app.state.initial_graph_id,
            "max_upload_bytes": settings.max_upload_bytes,
            "accepted_files": [".docx", ".json"],
        }

    @application.post("/api/documents", status_code=201)
    async def upload_document(
        request: Request,
        file: Annotated[UploadFile, File(description="DOCX document or exported graph JSON")],
    ):
        slots = request.app.state.upload_slots
        try:
            if slots.locked():
                raise WorkspaceError(
                    "Two documents are already processing. Try again shortly.", "UPLOAD_BUSY", 429
                )
            async with slots:
                filename = clean_filename(file.filename or "")
                size = 0
                with TemporaryDirectory(prefix="docx-knowledge-graph-") as temporary:
                    path = Path(temporary) / ("upload" + Path(filename).suffix.lower())
                    with path.open("wb") as output:
                        while chunk := await file.read(1024 * 1024):
                            size += len(chunk)
                            if size > settings.max_upload_bytes:
                                raise WorkspaceError(
                                    f"File exceeds the {settings.max_upload_bytes / 1024 / 1024:g} MiB upload limit.",
                                    "UPLOAD_TOO_LARGE",
                                    413,
                                )
                            await run_in_threadpool(output.write, chunk)
                    if not size:
                        raise WorkspaceError("The selected file is empty.", "EMPTY_FILE", 422)

                    def convert():
                        graph = (
                            build_graph(path, source_name=filename)
                            if path.suffix == ".docx"
                            else load_graph(path)
                        )
                        validate_graph(graph)
                        identifier = request.app.state.store.save(graph)
                        return identifier, graph

                    identifier, graph = await run_in_threadpool(convert)
                return {
                    "graph_id": identifier,
                    "filename": filename,
                    "graph": graph,
                    "download_url": f"/api/graphs/{identifier}/download",
                }
        except (ValueError, RecursionError) as error:
            if isinstance(error, WorkspaceError):
                raise
            raise WorkspaceError(
                "Cannot process this document. Check that it is a valid DOCX or exported graph JSON."
            ) from error
        except OSError as error:
            raise WorkspaceError(
                "The server could not save this graph. Check storage permissions and free space.",
                "STORAGE_ERROR",
                507,
            ) from error
        finally:
            await file.close()

    @application.get("/api/graphs/{graph_id}")
    async def graph(context: Context):
        return context.graph

    @application.get("/api/graphs/{graph_id}/download")
    async def download(request: Request, context: Context):
        source = str(context.graph.get("metadata", {}).get("source", "knowledge-graph"))
        filename = Path(source.replace("\\", "/")).stem
        filename = (
            "".join(character for character in filename if character.isprintable())[:180]
            or "knowledge-graph"
        )
        return FileResponse(
            request.app.state.store.path(context.identifier),
            media_type="application/json",
            filename=f"{filename}.graph.json",
        )

    @application.post("/api/graphs/{graph_id}/query")
    async def query(request: Request, context: Context):
        payload = await json_payload(request)
        source = payload.get("query")
        if not isinstance(source, str) or not isinstance(payload.get("parameters", {}), dict):
            raise WorkspaceError(
                "Provide a query string and an optional parameters object.", "QUERY_ERROR", 400
            )
        slots = request.app.state.query_slots
        if slots.locked():
            raise WorkspaceError(
                "Two queries are already running. Try again shortly.", "QUERY_BUSY", 429
            )
        try:
            async with slots:
                return await run_in_threadpool(
                    lambda: QueryEngine(context.graph).execute(
                        source, payload.get("parameters", {})
                    )
                )
        except QueryError as error:
            return JSONResponse(
                {"error": error.details(source)},
                status_code=422 if isinstance(error, QueryLimitError) else 400,
            )

    @application.get("/api/graphs/{graph_id}/chat/status")
    async def chat_setup(context: Context):
        return {**status_provider(), "token": context.chat.token}

    def check_chat_token(request: Request, context: GraphContext):
        if not secrets.compare_digest(request.headers.get("x-chat-token", ""), context.chat.token):
            raise ChatError(
                "Reload chat setup for this graph and try again.", "CHAT_FORBIDDEN", 403
            )

    @application.post("/api/graphs/{graph_id}/chat")
    async def chat(request: Request, context: Context):
        check_chat_token(request, context)
        payload = await json_payload(request)
        api_key = validate_api_key(payload.pop("api_key", None))
        status = status_provider()
        ready = status.get("runtime_ready", status["ready"]) if api_key else status["ready"]
        if not ready:
            issues = status.get("runtime_issues", status["issues"]) if api_key else status["issues"]
            raise ChatError(" ".join(issues), "CHAT_UNAVAILABLE", 503)
        slots = request.app.state.chat_slots
        if slots.locked():
            raise ChatError(
                "Two chat requests are already running. Try again shortly.", "CHAT_BUSY", 429
            )
        await slots.acquire()
        try:
            run = context.chat.reserve(payload, api_key=api_key)
        except BaseException:
            slots.release()
            raise
        return ChatEventResponse(context.chat, run, slots.release)

    @application.post("/api/graphs/{graph_id}/chat/cancel")
    async def cancel(request: Request, context: Context):
        check_chat_token(request, context)
        payload = await json_payload(request)
        if not isinstance(payload.get("run_id"), str):
            raise ChatError("A run_id string is required.")
        return {"cancelled": context.chat.cancel(payload["run_id"])}

    @application.post("/api/graphs/{graph_id}/chat/reset")
    async def reset(request: Request, context: Context):
        check_chat_token(request, context)
        payload = await json_payload(request)
        if not isinstance(payload.get("session_id"), str):
            raise ChatError("A session_id string is required.")
        context.chat.forget(payload["session_id"])
        return {"cleared": True}

    application.mount("/static", StaticFiles(directory=PACKAGE_DIR / "static"), name="static")
    return application
