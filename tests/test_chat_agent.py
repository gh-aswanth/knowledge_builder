import asyncio
import copy
import json
import sys
import time
import unittest
import warnings
from types import SimpleNamespace
from unittest.mock import patch

from docx_knowledge_graph.chat_agent import (
    MAX_TOOL_CALLS,
    MAX_TURNS,
    ChatError,
    ChatService,
    GraphTools,
    chat_status,
    consume_v3,
)
from test_graph_query import fixture_graph


class GraphChatToolTests(unittest.TestCase):
    def setUp(self):
        self.graph = fixture_graph()
        self.tools = GraphTools(self.graph)

    def test_schema_uses_actual_types_without_document_text(self):
        schema = self.tools.get_graph_schema()
        self.assertEqual(schema["node_types"]["Concept"], 3)
        self.assertIn("text", schema["properties"]["nodes"]["Passage"])
        self.assertNotIn("Alpha uses Beta", json.dumps(schema))
        self.assertIn(
            {
                "source_type": "Passage",
                "relationship": "MENTIONS",
                "target_type": "Concept",
                "count": 3,
            },
            schema["directions"],
        )

    def test_bound_query_and_artifact_preserve_graph(self):
        original = copy.deepcopy(self.graph)
        content, artifact = self.tools.run_graph_query(
            "MATCH (concept:Concept {label:$term}) RETURN concept", '{"term":"alpha"}'
        )
        self.assertTrue(json.loads(content)["ok"])
        self.assertEqual(artifact["result"]["graph"]["node_ids"], ["alpha"])
        self.assertEqual(self.graph, original)

    def test_parameter_injection_and_write_rejection(self):
        content, artifact = self.tools.run_graph_query(
            "MATCH (concept:Concept {label:$term}) RETURN concept",
            json.dumps({"term": "alpha'}) RETURN concept; DELETE concept"}),
        )
        self.assertEqual(artifact["result"]["rows"], [])
        for source, parameters in [
            ("DELETE node", "{}"),
            ("RETURN missing", "{}"),
            ("RETURN $value", "null"),
            ("RETURN $value", '{"value":1e999}'),
        ]:
            with self.subTest(source=source):
                content, artifact = self.tools.run_graph_query(source, parameters)
                self.assertFalse(json.loads(content)["ok"])
                self.assertEqual(artifact, {})

    def test_tool_errors_include_source_location(self):
        content, artifact = self.tools.run_graph_query("MATCH (node)\nRETURN missing")
        self.assertEqual(json.loads(content)["error"]["line"], 2)
        self.assertEqual(artifact, {})

    def test_source_read_is_id_only_and_bounded(self):
        self.graph["nodes"][2]["properties"]["text"] = "text" * 3000
        result = self.tools.read_graph_node("first")
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["text"]), 6000)
        self.assertFalse(self.tools.read_graph_node("/etc/passwd")["ok"])

    def test_tool_call_limit_prevents_more_queries(self):
        for _count in range(MAX_TOOL_CALLS):
            self.tools.read_graph_node("alpha")
        with self.assertRaises(ChatError):
            self.tools.run_graph_query("RETURN 1")

    def test_preview_is_bounded_and_does_not_change_counts(self):
        self.graph["nodes"][2]["properties"]["text"] = "data " * 6000
        content, artifact = self.tools.run_graph_query("MATCH (node) RETURN node")
        self.assertLessEqual(len(content), 18000)
        self.assertEqual(artifact["result"]["stats"]["total_rows"], 7)
        self.assertIn("abbreviated", content)

    def test_status_never_contains_the_key(self):
        with patch.dict("os.environ", {"OPENAI_API_KEY": "test-secret-never-return"}):
            self.assertNotIn("test-secret", json.dumps(chat_status()))
        with patch.dict("os.environ", {"OPENAI_API_KEY": ""}):
            self.assertFalse(chat_status()["ready"])


class ChatSessionTests(unittest.TestCase):
    def setUp(self):
        self.service = ChatService(fixture_graph())

    def test_sessions_are_isolated_and_one_run_is_admitted(self):
        first = self.service.reserve({"message": "Find concepts"})
        with self.assertRaises(ChatError) as caught:
            self.service.reserve({"message": "Another question"})
        self.assertEqual(caught.exception.status, 429)
        self.assertFalse(self.service.cancel("unknown-run"))
        self.assertTrue(self.service.cancel(first.identifier))
        self.assertTrue(first.cancelled.is_set())
        self.service.release(first)
        second = self.service.reserve({"message": "Other tab"})
        self.assertNotEqual(first.session_id, second.session_id)

    def test_invalid_message_and_session_ids(self):
        for payload in [
            {},
            {"message": " "},
            {"message": "x" * 4001},
            {"message": []},
            {"message": "Hello", "session_id": []},
        ]:
            with self.subTest(payload=payload), self.assertRaises(ChatError):
                self.service.reserve(payload)

    def test_expiry_limits_and_clear(self):
        run = self.service.reserve({"message": "Hello"})
        with self.assertRaises(ChatError):
            self.service.forget(run.session_id)
        self.service.release(run)
        session = self.service.sessions[run.session_id]
        session.turns = MAX_TURNS
        with self.assertRaises(ChatError) as caught:
            self.service.reserve({"message": "Again", "session_id": run.session_id})
        self.assertEqual(caught.exception.code, "SESSION_LIMIT")
        session.touched = time.monotonic() - 3601
        with self.assertRaises(ChatError) as caught:
            self.service.reserve({"message": "Again", "session_id": run.session_id})
        self.assertEqual(caught.exception.code, "SESSION_EXPIRED")
        self.service.forget(run.session_id)


class AsyncItems:
    def __init__(self, items):
        self.items = items

    async def __aiter__(self):
        for item in self.items:
            await asyncio.sleep(0)
            yield item


class ModelProjection:
    message_id = "message-1"
    node = "model"

    def __init__(self):
        self.text = AsyncItems(["Found ", "three concepts."])
        self.reasoning = AsyncItems(["I will count the matching concepts."])
        self.tool_calls = AsyncItems(
            [
                {"id": "tool-1", "index": 0, "name": "run_graph_query", "args": '{"query":'},
                {"index": 0, "args": '"RETURN 1"}'},
            ]
        )

    @property
    def output(self):
        async def final():
            return SimpleNamespace(usage_metadata={"total_tokens": 20}, tool_calls=[{}])

        return final()


class ToolProjection:
    tool_call_id = "tool-1"
    tool_name = "run_graph_query"
    input = {"query": "MATCH (concept:Concept) RETURN count(*) AS total"}
    error = None

    def __init__(self):
        content, artifact = GraphTools(fixture_graph()).run_graph_query(self.input["query"])
        self.output = SimpleNamespace(content=content, artifact=artifact, status="success")
        self.output_deltas = AsyncItems([{"phase": "Querying"}])


class RunProjection:
    def __init__(self):
        self.messages = AsyncItems([ModelProjection()])
        self.tool_calls = AsyncItems([ToolProjection()])
        self.values = AsyncItems([{"messages": ["user"]}, {"messages": ["user", "answer"]}])
        self.closed = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *arguments):
        self.closed = True

    async def output(self):
        return {"messages": [{"role": "assistant", "content": "Found three concepts."}]}


class AgentFixture:
    def __init__(self):
        self.stream = RunProjection()

    async def astream_events(self, payload, *, config, version):
        if version != "v3":
            raise AssertionError("Expected the actual v3 API")
        self.payload = payload
        return self.stream


class ChatStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_expected_v3_beta_warning_is_filtered(self):
        try:
            from langchain_core._api import LangChainBetaWarning
        except ImportError:
            self.skipTest("Run uv sync --extra chat for warning category validation")

        class WarningAgent(AgentFixture):
            async def astream_events(self, *args, **kwargs):
                warnings.warn(
                    "The v3 streaming protocol on Pregel is experimental.",
                    LangChainBetaWarning,
                    stacklevel=2,
                )
                warnings.warn("Another beta feature", LangChainBetaWarning, stacklevel=2)
                warnings.warn(
                    "The v3 streaming protocol on Pregel is experimental.",
                    RuntimeWarning,
                    stacklevel=2,
                )
                return await super().astream_events(*args, **kwargs)

        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            await consume_v3(WarningAgent(), [], lambda kind, data: None)
            self.assertEqual(
                [(str(item.message), item.category) for item in caught],
                [
                    ("Another beta feature", LangChainBetaWarning),
                    ("The v3 streaming protocol on Pregel is experimental.", RuntimeWarning),
                ],
            )
            warnings.warn(
                "The v3 streaming protocol on Pregel is experimental.",
                LangChainBetaWarning,
                stacklevel=2,
            )
            self.assertEqual(len(caught), 3)

    async def test_independent_model_tool_state_and_artifact_events(self):
        agent = AgentFixture()
        events = []
        result = await consume_v3(
            agent,
            [{"role": "user", "content": "Count concepts"}],
            lambda kind, data: events.append((kind, data)),
        )
        kinds = [kind for kind, data in events]
        for kind in [
            "llm_start",
            "llm_delta",
            "reasoning_delta",
            "tool_argument_delta",
            "llm_end",
            "tool_start",
            "tool_delta",
            "tool_end",
            "query_result",
            "agent_state",
        ]:
            self.assertIn(kind, kinds)
        self.assertEqual(
            "".join(data["text"] for kind, data in events if kind == "llm_delta"),
            "Found three concepts.",
        )
        self.assertEqual(
            next(data["result"]["rows"] for kind, data in events if kind == "query_result"), [[3]]
        )
        self.assertTrue(agent.stream.closed)
        self.assertEqual(result[-1]["content"], "Found three concepts.")

    async def test_failed_tool_has_no_successful_query_artifact(self):
        agent = AgentFixture()
        agent.stream.tool_calls.items[0].error = "Sensitive internal exception"
        events = []
        await consume_v3(agent, [], lambda kind, data: events.append((kind, data)))
        self.assertIn("tool_error", [kind for kind, data in events])
        self.assertNotIn("query_result", [kind for kind, data in events])
        self.assertNotIn("Sensitive internal", json.dumps(events))

    async def test_model_failure_has_its_own_redacted_event(self):
        class FailingText:
            async def __aiter__(self):
                yield "Partial response"
                raise RuntimeError("private provider error")

        agent = AgentFixture()
        agent.stream.messages.items[0].text = FailingText()
        events = []
        with self.assertRaises(RuntimeError):
            await consume_v3(agent, [], lambda kind, data: events.append((kind, data)))
        self.assertIn("llm_error", [kind for kind, data in events])
        self.assertNotIn("private provider", json.dumps(events))
        self.assertTrue(agent.stream.closed)

    async def test_success_commits_history_and_followups_use_it(self):
        agents = []

        def factory(graph_tools):
            agent = AgentFixture()
            agents.append(agent)
            return agent

        service = ChatService(fixture_graph(), factory)
        run = service.reserve({"message": "Count concepts"})
        events = []
        await service.execute_untraced(run, lambda kind, data: events.append((kind, data)))
        self.assertEqual(events[-1][0], "run_end")
        self.assertEqual(service.sessions[run.session_id].turns, 1)
        service.release(run)
        followup = service.reserve({"message": "And passages?", "session_id": run.session_id})
        await service.execute_untraced(followup, lambda kind, data: None)
        self.assertEqual(agents[-1].payload["messages"][0]["content"], "Found three concepts.")

    async def test_timeout_and_cancel_do_not_commit_partial_history(self):
        async def wait_forever(*arguments):
            await asyncio.sleep(30)

        for cancelled in [False, True]:
            service = ChatService(fixture_graph(), lambda graph_tools: None)
            run = service.reserve({"message": "Slow question"})
            if cancelled:
                service.cancel(run.identifier)
            events = []
            with patch("docx_knowledge_graph.chat_agent.consume_v3", wait_forever):
                await service.execute_untraced(
                    run, lambda kind, data, events=events: events.append((kind, data)), timeout=0.02
                )
            self.assertEqual(events[-1][0], "run_cancelled" if cancelled else "run_error")
            self.assertEqual(service.sessions[run.session_id].messages, [])

    async def test_provider_errors_are_redacted(self):
        def broken_factory(graph_tools):
            raise RuntimeError("secret-api-key and private response body")

        service = ChatService(fixture_graph(), broken_factory)
        run = service.reserve({"message": "Question"})
        events = []
        await service.execute_untraced(run, lambda kind, data: events.append((kind, data)))
        self.assertEqual(events[-1][0], "run_error")
        self.assertNotIn("secret-api-key", json.dumps(events))

    async def test_disconnect_cleans_up_stream(self):
        agent = AgentFixture()

        def disconnected(kind, data):
            raise BrokenPipeError()

        with self.assertRaises(BrokenPipeError):
            await consume_v3(agent, [], disconnected)
        self.assertTrue(agent.stream.closed)

    @unittest.skipUnless(
        sys.version_info >= (3, 11) and sys.version_info.releaselevel == "final",
        "Real LangChain requires stable Python; configured alpha interpreter crashes native dependencies",
    )
    async def test_real_create_agent_v3_with_scripted_model(self):
        try:
            from langchain.agents import create_agent
            from langchain_core.language_models.chat_models import BaseChatModel
            from langchain_core.messages import AIMessage, AIMessageChunk
            from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
            from langchain_core.tools import StructuredTool
        except ImportError:
            self.skipTest("Run uv sync --extra chat for the real v3 integration check")

        class ScriptedModel(BaseChatModel):
            @property
            def _llm_type(self):
                return "scripted-tool-test"

            def bind_tools(self, tools, **kwargs):
                return self

            def reply(self, messages):
                if any(getattr(message, "type", None) == "tool" for message in messages):
                    return AIMessage(content="Found three concepts.")
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "run_graph_query",
                            "args": {"query": "MATCH (concept:Concept) RETURN count(*) AS total"},
                            "id": "tool-real",
                            "type": "tool_call",
                        }
                    ],
                )

            def _generate(self, messages, stop=None, run_manager=None, **kwargs):
                return ChatResult(generations=[ChatGeneration(message=self.reply(messages))])

            def _stream(self, messages, stop=None, run_manager=None, **kwargs):
                message = self.reply(messages)
                chunks = [
                    {
                        "name": call["name"],
                        "args": json.dumps(call["args"]),
                        "id": call["id"],
                        "index": index,
                    }
                    for index, call in enumerate(message.tool_calls)
                ]
                yield ChatGenerationChunk(
                    message=AIMessageChunk(content=message.content, tool_call_chunks=chunks)
                )

        graph_tools = GraphTools(fixture_graph())
        agent = create_agent(
            model=ScriptedModel(),
            tools=[
                StructuredTool.from_function(
                    graph_tools.run_graph_query, response_format="content_and_artifact"
                )
            ],
        )
        events = []
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            result = await consume_v3(
                agent,
                [{"role": "user", "content": "Count concepts"}],
                lambda kind, data: events.append((kind, data)),
            )
        self.assertFalse(
            any("The v3 streaming protocol on Pregel" in str(item.message) for item in caught)
        )
        self.assertEqual(result[-1].text, "Found three concepts.")
        self.assertTrue(
            any(kind == "query_result" and data["result"]["rows"] == [[3]] for kind, data in events)
        )


if __name__ == "__main__":
    unittest.main()
