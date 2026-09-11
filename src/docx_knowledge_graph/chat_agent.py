"""Optional LangChain/Astra assistant with independent v3 event consumers."""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import os
import secrets
import sys
import threading
import time
import warnings
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .graph_query import QueryEngine, QueryError, QueryLimits

MODEL = "gpt-6-astra"
MAX_TURNS = 6
MAX_TOOL_CALLS = 50
RUN_TIMEOUT = 120
DEPENDENCIES = {
    "langchain": "1.4.0",
    "langchain-core": "1.6.2",
    "langchain-openai": "1.6.2",
    "langgraph": "1.2.11",
    "openai": "3.13.0",
}


class ChatError(ValueError):
    def __init__(self, message: str, code: str = "CHAT_ERROR", status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def chat_status() -> dict:
    issues = []
    if sys.version_info < (3, 11) or sys.version_info.releaselevel != "final":
        issues.append("Chat requires stable Python 3.11 or newer.")
    missing = []
    for name, required in DEPENDENCIES.items():
        try:
            if importlib.metadata.version(name) != required:
                missing.append(name)
        except importlib.metadata.PackageNotFoundError:
            missing.append(name)
    if missing:
        issues.append("Install the tested dependencies: uv sync --extra chat.")
    runtime_issues = list(issues)
    key_configured = bool(os.environ.get("OPENAI_API_KEY", "").strip())
    if not key_configured:
        issues.append(
            "Enter an API key in the chat's API key settings, or set OPENAI_API_KEY on the server."
        )
    return {
        "ready": not issues,
        "model": MODEL,
        "stream_version": "v3",
        "issues": issues,
        "max_turns": MAX_TURNS,
        "runtime_ready": not runtime_issues,
        "runtime_issues": runtime_issues,
        "key_configured": key_configured,
    }


def validate_api_key(api_key: object) -> str | None:
    if api_key is None:
        return None
    if not isinstance(api_key, str):
        raise ChatError("API key must be text.", "INVALID_API_KEY", 400)
    cleaned = api_key.strip()
    if (
        not cleaned
        or len(cleaned) > 1024
        or any(not 33 <= ord(character) <= 126 for character in cleaned)
    ):
        raise ChatError(
            "Enter an API key of up to 1,024 characters without spaces or control characters.",
            "INVALID_API_KEY",
            400,
        )
    return cleaned


def json_object(source: str) -> dict:
    def reject_constant(value):
        raise ValueError("Parameters must contain finite JSON values.")

    value = json.loads(source, parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise ValueError("Parameters must be a JSON object.")
    json.dumps(value, allow_nan=False)
    return value


def preview(value, depth: int = 0):
    if isinstance(value, str):
        return value if len(value) <= 600 else value[:600] + "… [abbreviated]"
    if isinstance(value, (list, tuple)):
        if depth >= 5:
            return "[nested value omitted]"
        return [preview(item, depth + 1) for item in value[:12]] + (
            ["[additional items omitted]"] if len(value) > 12 else []
        )
    if isinstance(value, dict):
        if depth >= 5:
            return "[nested value omitted]"
        result = {key: preview(item, depth + 1) for key, item in list(value.items())[:20]}
        if len(value) > 20:
            result["_preview"] = "Additional properties omitted"
        return result
    return value


class GraphTools:
    def __init__(self, graph: dict):
        self.graph = graph
        self.engine = QueryEngine(graph, QueryLimits(max_rows=100, max_result_bytes=256 * 1024))
        self.calls = 0
        self.lock = threading.Lock()

    def use_budget(self):
        with self.lock:
            self.calls += 1
            if self.calls > MAX_TOOL_CALLS:
                raise ChatError(
                    "Tool-call budget reached. Narrow the question and try again.",
                    "TOOL_LIMIT",
                    422,
                )

    def get_graph_schema(self) -> dict:
        """Read exact node/relationship types, property names, counts, and stored directions before querying. No document text is returned."""
        self.use_budget()
        node_types = Counter(node["type"] for node in self.graph["nodes"])
        edge_types = Counter(edge["type"] for edge in self.graph["edges"])
        properties = {"nodes": defaultdict(set), "relationships": defaultdict(set)}
        for group, entities in [
            ("nodes", self.graph["nodes"]),
            ("relationships", self.graph["edges"]),
        ]:
            for entity in entities:
                properties[group][entity["type"]].update(entity.get("properties", {}))
        directions = Counter(
            (
                self.engine.nodes[edge["source"]]["type"],
                edge["type"],
                self.engine.nodes[edge["target"]]["type"],
            )
            for edge in self.graph["edges"]
        )
        result = {
            "language": "GraphQuery/1",
            "node_types": dict(node_types),
            "relationship_types": dict(edge_types),
            "properties": {
                group: {kind: sorted(keys) for kind, keys in types.items()}
                for group, types in properties.items()
            },
            "directions": [
                {
                    "source_type": source,
                    "relationship": relation,
                    "target_type": target,
                    "count": count,
                }
                for (source, relation, target), count in directions.items()
            ],
        }
        if len(json.dumps(result)) > 32000:
            return {
                "ok": False,
                "error": "Schema exceeds the chat size limit. Use a smaller graph or the manual query editor.",
            }
        return result

    def run_graph_query(self, query: str, parameters_json: str = "{}") -> tuple[str, dict]:
        """Execute a read-only GraphQuery/1 statement. Bind $values using parameters_json, a JSON object string. Returns a bounded evidence preview; the UI receives the full capped table and subgraph. Errors include source locations for correction."""
        self.use_budget()
        try:
            parameters = json_object(parameters_json)
            result = self.engine.execute(query, parameters)
        except (QueryError, ValueError, RecursionError) as error:
            detail = (
                error.details(query)
                if isinstance(error, QueryError)
                else {"message": "Invalid parameters: use a finite JSON object."}
            )
            return json.dumps({"ok": False, "error": detail}), {}
        compact = {
            "ok": True,
            "columns": result["columns"],
            "rows": preview(result["rows"][:12]),
            "stats": result["stats"],
            "truncated": result["truncated"],
            "preview_notice": "Up to 12 rows; text/list/map values may be abbreviated. Use read_graph_node for source text. The UI has the full capped result.",
        }
        while len(json.dumps(compact, ensure_ascii=False)) > 18000 and compact["rows"]:
            compact["rows"].pop()
        return json.dumps(compact, ensure_ascii=False), {
            "query": query,
            "parameters": parameters,
            "result": result,
        }

    def read_graph_node(self, node_id: str) -> dict:
        """Read one known graph node by its exact ID for source evidence. Returns at most 6,000 source characters; never reads filesystem paths."""
        self.use_budget()
        node = self.engine.nodes.get(node_id)
        if node is None:
            return {"ok": False, "error": "No node has that ID."}
        text = str(node.get("properties", {}).get("text", node["label"]))
        return {
            "ok": True,
            "id": node["id"],
            "type": node["type"],
            "label": node["label"][:300],
            "text": text[:6000],
            "truncated": len(text) > 6000,
        }


def create_graph_agent(graph_tools: GraphTools, *, api_key: str | None = None):
    from langchain.agents import create_agent
    from langchain.agents.middleware import ModelCallLimitMiddleware, ToolCallLimitMiddleware
    from langchain_core.tools import StructuredTool
    from langchain_openai import ChatOpenAI

    model = ChatOpenAI(
        model=MODEL,
        api_key=api_key or os.environ.get("OPENAI_API_KEY", "").strip() or None,
        use_responses_api=True,
        reasoning={"effort": "low", "summary": "auto"},
        temperature=None,
        max_tokens=4096,
        timeout=45,
        max_retries=1,
        store=False,
        include=["reasoning.encrypted_content"],
        output_version="responses/v1",
    )
    tools = [
        StructuredTool.from_function(graph_tools.get_graph_schema),
        StructuredTool.from_function(
            graph_tools.run_graph_query, response_format="content_and_artifact"
        ),
        StructuredTool.from_function(graph_tools.read_graph_node),
    ]
    return create_agent(
        model=model,
        tools=tools,
        system_prompt=Path(__file__).with_name("CHAT_PROMPT.md").read_text(encoding="utf-8"),
        middleware=[
            ModelCallLimitMiddleware(run_limit=50, exit_behavior="error"),
            ToolCallLimitMiddleware(run_limit=MAX_TOOL_CALLS, exit_behavior="error"),
        ],
        name="graph_search",
    )


async def consume_v3(agent, messages: list, emit) -> list:
    try:
        from langchain_core._api import LangChainBetaWarning
    except ImportError:
        LangChainBetaWarning = None
    with warnings.catch_warnings():
        if LangChainBetaWarning is not None:
            warnings.filterwarnings(
                "ignore",
                message=r"^The v3 streaming protocol on Pregel is experimental\.$",
                category=LangChainBetaWarning,
            )
        stream = await agent.astream_events(
            {"messages": messages}, config={"recursion_limit": 48}, version="v3"
        )
    async with stream:

        async def consume_message(message):
            identifier = message.message_id or secrets.token_hex(8)
            emit("llm_start", {"id": identifier, "node": message.node, "model": MODEL})

            async def text_deltas():
                async for delta in message.text:
                    emit("llm_delta", {"id": identifier, "text": delta})

            async def reasoning_deltas():
                async for delta in message.reasoning:
                    emit("reasoning_delta", {"id": identifier, "text": delta})

            async def argument_deltas():
                async for delta in message.tool_calls:
                    emit(
                        "tool_argument_delta",
                        {
                            "id": identifier,
                            "chunk": {
                                key: delta.get(key) for key in ("id", "index", "name", "args")
                            },
                        },
                    )

            consumers = [
                asyncio.create_task(consumer())
                for consumer in (text_deltas, reasoning_deltas, argument_deltas)
            ]
            try:
                await asyncio.gather(*consumers)
                output = await message.output
                emit(
                    "llm_end",
                    {
                        "id": identifier,
                        "usage": output.usage_metadata or {},
                        "tool_calls": len(output.tool_calls),
                    },
                )
            except (BrokenPipeError, ConnectionError, OSError):
                raise
            except Exception:
                emit("llm_error", {"id": identifier, "message": "The model response failed."})
                raise
            finally:
                for consumer in consumers:
                    if not consumer.done():
                        consumer.cancel()
                await asyncio.gather(*consumers, return_exceptions=True)

        async def model_events():
            count = 0
            async for message in stream.messages:
                count += 1
                if count > 50:
                    raise ChatError(
                        "Model-step budget reached. Narrow the question and try again.",
                        "MODEL_LIMIT",
                        422,
                    )
                await consume_message(message)

        async def consume_tool(call):
            identifier = call.tool_call_id
            emit("tool_start", {"id": identifier, "name": call.tool_name, "input": call.input})
            async for delta in call.output_deltas:
                emit("tool_delta", {"id": identifier, "data": preview(delta)})
            if call.error is not None:
                emit("tool_error", {"id": identifier, "message": "Tool execution failed."})
                return
            output = call.output
            content = getattr(output, "content", output)
            if isinstance(content, str):
                try:
                    content = json.loads(content)
                except ValueError:
                    content = {"message": content[:1200]}
            failed = (
                getattr(output, "status", None) == "error"
                or isinstance(content, dict)
                and content.get("ok") is False
            )
            emit(
                "tool_error" if failed else "tool_end",
                {
                    "id": identifier,
                    "output": preview(content),
                    "message": "Query or tool input rejected." if failed else "Completed",
                },
            )
            artifact = getattr(output, "artifact", None)
            if not failed and isinstance(artifact, dict) and "result" in artifact:
                emit("query_result", {"id": identifier, **artifact})

        async def tool_events():
            tasks = []
            try:
                async for call in stream.tool_calls:
                    tasks.append(asyncio.create_task(consume_tool(call)))
                if tasks:
                    await asyncio.gather(*tasks)
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)

        async def state_events():
            async for snapshot in stream.values:
                emit("agent_state", {"message_count": len(snapshot.get("messages", []))})

        tasks = [
            asyncio.create_task(consumer())
            for consumer in (model_events, tool_events, state_events)
        ]
        try:
            await asyncio.gather(*tasks)
            output = await stream.output()
            return output["messages"]
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


@dataclass
class ChatSession:
    messages: list = field(default_factory=list)
    turns: int = 0
    touched: float = field(default_factory=time.monotonic)


@dataclass
class ChatRun:
    session_id: str
    message: str
    identifier: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    cancelled: threading.Event = field(default_factory=threading.Event)
    api_key: str | None = field(default=None, repr=False, compare=False)


class ChatService:
    def __init__(self, graph: dict, agent_factory=create_graph_agent):
        self.graph = graph
        self.agent_factory = agent_factory
        self.token = secrets.token_urlsafe(32)
        self.sessions = {}
        self.active = None
        self.lock = threading.Lock()

    def reserve(self, payload: dict, *, api_key: str | None = None) -> ChatRun:
        api_key = validate_api_key(api_key)
        message = payload.get("message")
        session_id = payload.get("session_id")
        if not isinstance(message, str) or not message.strip() or len(message) > 4000:
            raise ChatError("Enter a message between 1 and 4,000 characters.")
        if session_id is not None and (not isinstance(session_id, str) or len(session_id) > 100):
            raise ChatError("Invalid conversation ID.")
        with self.lock:
            if self.active:
                raise ChatError(
                    "Another chat run is active. Stop it or try again shortly.", "CHAT_BUSY", 429
                )
            now = time.monotonic()
            self.sessions = {
                key: session
                for key, session in self.sessions.items()
                if now - session.touched < 3600
            }
            if session_id and session_id not in self.sessions:
                raise ChatError("Conversation expired. Start a new chat.", "SESSION_EXPIRED", 410)
            if not session_id:
                if len(self.sessions) >= 32:
                    del self.sessions[
                        min(self.sessions, key=lambda key: self.sessions[key].touched)
                    ]
                session_id = secrets.token_urlsafe(24)
                self.sessions[session_id] = ChatSession()
            if self.sessions[session_id].turns >= MAX_TURNS:
                raise ChatError(
                    "Conversation limit reached. Start a new chat to keep context bounded.",
                    "SESSION_LIMIT",
                    409,
                )
            self.sessions[session_id].touched = now
            self.active = ChatRun(session_id, message.strip(), api_key=api_key)
            return self.active

    def cancel(self, identifier: str) -> bool:
        with self.lock:
            if self.active and self.active.identifier == identifier:
                self.active.cancelled.set()
                return True
            return False

    def forget(self, session_id: str):
        with self.lock:
            if self.active and self.active.session_id == session_id:
                raise ChatError(
                    "Stop the current response before clearing the conversation.", "CHAT_BUSY", 409
                )
            self.sessions.pop(session_id, None)

    def release(self, run: ChatRun):
        with self.lock:
            run.api_key = None
            if self.active is run:
                self.active = None

    async def execute(self, run: ChatRun, emit, timeout: float = RUN_TIMEOUT):
        from langsmith import tracing_context

        with tracing_context(enabled=False):
            await self.execute_untraced(run, emit, timeout)

    async def execute_untraced(self, run: ChatRun, emit, timeout: float = RUN_TIMEOUT):
        session = self.sessions[run.session_id]
        emit(
            "run_start",
            {
                "run_id": run.identifier,
                "session_id": run.session_id,
                "model": MODEL,
                "stream_version": "v3",
            },
        )
        tools = GraphTools(self.graph)

        async def work():
            agent = (
                self.agent_factory(tools, api_key=run.api_key)
                if run.api_key
                else self.agent_factory(tools)
            )
            return await consume_v3(
                agent, [*session.messages, {"role": "user", "content": run.message}], emit
            )

        async def monitor():
            last_heartbeat = time.monotonic()
            while not run.cancelled.is_set():
                await asyncio.sleep(0.1)
                if time.monotonic() - last_heartbeat >= 5:
                    emit("heartbeat", {})
                    last_heartbeat = time.monotonic()

        worker = asyncio.create_task(work())
        watcher = asyncio.create_task(monitor())
        try:
            done, pending = await asyncio.wait(
                [worker, watcher], timeout=timeout, return_when=asyncio.FIRST_COMPLETED
            )
            if run.cancelled.is_set():
                emit(
                    "run_cancelled",
                    {"message": "Response stopped. Completed API usage may still be billed."},
                )
            elif not done:
                emit(
                    "run_error",
                    {"code": "CHAT_TIMEOUT", "message": "Chat timed out. Try a narrower question."},
                )
            elif watcher in done:
                watcher.result()
            else:
                messages = worker.result()
                session.messages = [
                    message.model_copy(update={"artifact": None})
                    if getattr(message, "artifact", None) is not None
                    else message
                    for message in messages
                ]
                session.turns += 1
                session.touched = time.monotonic()
                emit(
                    "run_end",
                    {"tool_calls": tools.calls, "turns_remaining": MAX_TURNS - session.turns},
                )
        except (BrokenPipeError, ConnectionError, OSError):
            run.cancelled.set()
        except Exception as error:
            names = {
                "AuthenticationError": "OpenAI rejected the API key. Update the key in chat settings or the server configuration.",
                "PermissionDeniedError": "Your OpenAI project does not have access to this model.",
                "NotFoundError": "Astra is unavailable to this OpenAI project. Check model access.",
                "RateLimitError": "OpenAI rate or quota limit reached. Check billing or retry later.",
                "APITimeoutError": "The OpenAI request timed out. Try again.",
                "ModelCallLimitExceededError": "Model-call limit reached. Try a narrower question.",
                "ToolCallLimitExceededError": "Tool-call limit reached. Try a narrower question.",
                "GraphRecursionError": "Agent step limit reached. Try a narrower question.",
                "APIConnectionError": "Cannot connect to OpenAI. Check the server's network connection.",
            }
            emit(
                "run_error",
                {
                    "code": error.code if isinstance(error, ChatError) else "AGENT_ERROR",
                    "message": str(error)
                    if isinstance(error, ChatError)
                    else names.get(
                        type(error).__name__,
                        "The agent could not complete this request. Check model access and the documented dependency versions.",
                    ),
                },
            )
        finally:
            for task in (worker, watcher):
                if not task.done():
                    task.cancel()
            await asyncio.gather(worker, watcher, return_exceptions=True)
            run.api_key = None
