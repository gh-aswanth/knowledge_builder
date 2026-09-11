import copy
import unittest

from docx_knowledge_graph.graph_query import QueryEngine, QueryError, QueryLimitError, QueryLimits


def fixture_graph():
    return {
        "schema_version": 1,
        "nodes": [
            {"id": "doc", "label": "Example", "type": "Document", "properties": {}},
            {"id": "section", "label": "Services", "type": "Section", "properties": {"level": 1}},
            {
                "id": "first",
                "label": "First passage",
                "type": "Passage",
                "properties": {"text": "Alpha uses Beta.", "score": 10, "enabled": False},
            },
            {
                "id": "second",
                "label": "Second passage",
                "type": "Passage",
                "properties": {"text": "ALPHA stores data.", "score": 0},
            },
            {"id": "alpha", "label": "alpha", "type": "Concept", "properties": {"occurrences": 2}},
            {"id": "beta", "label": "beta", "type": "Concept", "properties": {"occurrences": 1}},
            {"id": "orphan", "label": "orphan", "type": "Concept", "properties": {}},
        ],
        "edges": [
            {
                "id": "ds",
                "source": "doc",
                "target": "section",
                "type": "CONTAINS",
                "properties": {},
            },
            {
                "id": "sp1",
                "source": "section",
                "target": "first",
                "type": "CONTAINS",
                "properties": {},
            },
            {
                "id": "sp2",
                "source": "section",
                "target": "second",
                "type": "CONTAINS",
                "properties": {},
            },
            {
                "id": "pa1",
                "source": "first",
                "target": "alpha",
                "type": "MENTIONS",
                "properties": {},
            },
            {
                "id": "pb1",
                "source": "first",
                "target": "beta",
                "type": "MENTIONS",
                "properties": {},
            },
            {
                "id": "pa2",
                "source": "second",
                "target": "alpha",
                "type": "MENTIONS",
                "properties": {},
            },
            {
                "id": "ab",
                "source": "alpha",
                "target": "beta",
                "type": "CO_OCCURS_WITH",
                "properties": {"weight": 2, "evidence": ["first"]},
            },
        ],
    }


class GraphQueryTests(unittest.TestCase):
    def setUp(self):
        self.graph = fixture_graph()
        self.engine = QueryEngine(self.graph)

    def rows(self, source, parameters=None):
        return self.engine.execute(source, parameters)["rows"]

    def test_typed_match_and_flat_or_nested_properties(self):
        self.assertEqual(
            self.rows(
                "MATCH (passage:Passage) RETURN passage.score, passage.properties.score ORDER BY passage.score"
            ),
            [[0, 0], [10, 10]],
        )
        self.assertEqual(
            self.rows("MATCH (passage:Passage {score: 0}) RETURN passage.id"), [["second"]]
        )

    def test_directions_and_relationship_properties(self):
        self.assertEqual(
            len(self.rows("MATCH (concept:Concept)<-[edge:MENTIONS]-(passage) RETURN edge")), 3
        )
        self.assertEqual(
            self.rows(
                "MATCH (left)-[edge:CO_OCCURS_WITH]->(right) RETURN left.label, edge.weight, right.label"
            ),
            [["alpha", 2, "beta"]],
        )
        self.assertEqual(
            self.rows(
                "MATCH (left)-[:CO_OCCURS_WITH]-(right) RETURN left.label, right.label ORDER BY left.label"
            ),
            [["alpha", "beta"], ["beta", "alpha"]],
        )

    def test_multiple_patterns_join_shared_variables_without_reusing_edges(self):
        query = "MATCH (passage:Passage)-[:MENTIONS]->(left:Concept), (passage)-[:MENTIONS]->(right:Concept) WHERE left.label < right.label RETURN passage.id, left.label, right.label"
        self.assertEqual(self.rows(query), [["first", "alpha", "beta"]])

    def test_repeated_match_and_with_scope(self):
        query = "MATCH (concept:Concept {label: $name}) WITH concept AS target MATCH (passage)-[:MENTIONS]->(target) RETURN passage.id ORDER BY passage.id"
        self.assertEqual(self.rows(query, {"name": "alpha"}), [["first"], ["second"]])
        with self.assertRaisesRegex(QueryError, "Unknown variable"):
            self.rows("MATCH (concept) WITH concept.label AS label RETURN concept")

    def test_named_paths_and_variable_length_relationship_binding(self):
        query = "MATCH path = (doc:Document)-[edges:CONTAINS*1..3]->(passage:Passage) RETURN passage.id, length(path), size(edges), path ORDER BY passage.id"
        result = self.rows(query)
        self.assertEqual([row[:3] for row in result], [["first", 2, 2], ["second", 2, 2]])
        self.assertEqual(result[0][3]["$type"], "path")
        self.assertEqual(
            [node["id"] for node in result[0][3]["nodes"]], ["doc", "section", "first"]
        )
        self.assertEqual(
            self.rows(
                "MATCH path=(doc:Document)-[:CONTAINS*0..0]->(same) RETURN id(doc)=id(same), length(path), size(nodes(path)), size(relationships(path))"
            ),
            [[True, 0, 1, 0]],
        )

    def test_path_types_and_exact_depth(self):
        self.assertEqual(
            len(
                self.rows(
                    "MATCH (doc:Document)-[:CONTAINS|MENTIONS*3]->(concept:Concept) RETURN concept"
                )
            ),
            3,
        )

    def test_optional_match_preserves_orphans(self):
        query = "MATCH (concept:Concept) OPTIONAL MATCH (passage:Passage)-[:MENTIONS]->(concept) RETURN concept.label AS label, count(passage) AS mentions ORDER BY label"
        self.assertEqual(self.rows(query), [["alpha", 2], ["beta", 1], ["orphan", 0]])
        self.assertEqual(
            self.rows(
                "MATCH (concept:Concept {label:'alpha'}) OPTIONAL MATCH (passage)-[:MENTIONS]->(concept) WHERE passage.score > 100 RETURN passage, concept.label"
            ),
            [[None, "alpha"]],
        )

    def test_grouping_having_order_and_pagination(self):
        query = "MATCH (passage)-[:MENTIONS]->(concept:Concept) WITH concept, count(DISTINCT passage) AS mentions WHERE mentions >= 1 RETURN concept.label AS label, mentions ORDER BY mentions DESC, label ASC SKIP $offset LIMIT $count"
        self.assertEqual(self.rows(query, {"offset": 1, "count": 1}), [["beta", 1]])

    def test_aggregate_functions_and_empty_groups(self):
        self.assertEqual(
            self.rows(
                "MATCH (passage:Passage) RETURN sum(passage.score), avg(passage.score), min(passage.score), max(passage.score), count(*)"
            ),
            [[10, 5, 0, 10, 2]],
        )
        self.assertEqual(
            self.rows(
                "MATCH (nothing:Missing) RETURN count(*), sum(nothing.score), avg(nothing.score), collect(nothing), min(nothing.score)"
            ),
            [[0, 0, None, [], None]],
        )
        self.assertEqual(self.rows("MATCH (nothing:Missing) RETURN nothing.type, count(*)"), [])
        self.assertEqual(
            self.rows(
                "MATCH (passage)-[:MENTIONS]->(concept) RETURN count(DISTINCT concept), size(collect(DISTINCT concept))"
            ),
            [[2, 2]],
        )

    def test_distinct_merges_graph_provenance(self):
        result = self.engine.execute(
            "MATCH (passage)-[edge:MENTIONS]->(concept:Concept {label:'alpha'}) RETURN DISTINCT concept.label"
        )
        self.assertEqual(result["rows"], [["alpha"]])
        self.assertEqual(set(result["graph"]["node_ids"]), {"first", "second", "alpha"})
        self.assertEqual(set(result["graph"]["edge_ids"]), {"pa1", "pa2"})

    def test_limit_preserves_only_returned_row_provenance(self):
        result = self.engine.execute(
            "MATCH (passage)-[edge:MENTIONS]->(concept) RETURN passage.id, concept.label ORDER BY passage.id, concept.label LIMIT 1"
        )
        self.assertEqual(set(result["graph"]["node_ids"]), {"first", "alpha"})
        self.assertEqual(result["graph"]["edge_ids"], ["pa1"])

    def test_case_insensitive_keywords_and_text_functions(self):
        self.assertEqual(
            self.rows(
                "match (passage:Passage) where toLower(passage.text) contains $term return passage.id order by passage.id",
                {"term": "alpha"},
            ),
            [["first"], ["second"]],
        )
        self.assertEqual(
            self.rows(
                "MATCH (concept:Concept) WHERE concept.label STARTS WITH 'a' OR concept.label ENDS WITH 'ta' RETURN upper(concept.label) AS label ORDER BY label"
            ),
            [["ALPHA"], ["BETA"]],
        )

    def test_boolean_precedence_nulls_and_zero(self):
        self.assertEqual(
            self.rows(
                "RETURN NOT 1=2 AND TRUE OR FALSE, NULL AND FALSE, NULL OR TRUE, NULL=1, NULL IS NULL, NULL IS NOT NULL, coalesce(NULL, 0, 9)"
            ),
            [[True, False, True, None, True, False, 0]],
        )
        self.assertEqual(
            self.rows("MATCH (passage:Passage) WHERE passage.enabled = FALSE RETURN passage.id"),
            [["first"]],
        )
        self.assertEqual(
            self.rows(
                "RETURN 1=TRUE, 1 IN [2,NULL], 1 IN [NULL,1], NOT ('a' IN ['b']), 2 + 3 * 4, (2+3)*4"
            ),
            [[False, None, True, True, 14, 20]],
        )

    def test_maps_lists_indexes_and_escaped_strings(self):
        self.assertEqual(
            self.rows(
                "RETURN {name: 'O''Brien', score: 2}['name'], [1,2,3][-1], [1][4], 'line\\nnext', size('café')"
            ),
            [["O'Brien", 3, None, "line\nnext", 4]],
        )
        self.assertEqual(self.rows("WITH 'value' AS `odd name` RETURN `odd name`"), [["value"]])

    def test_degree_and_entity_functions(self):
        self.assertEqual(
            self.rows(
                "MATCH (concept:Concept {label:'alpha'}) RETURN id(concept), type(concept), labels(concept), degree(concept), degree(concept,'MENTIONS')"
            ),
            [["alpha", "Concept", ["Concept"], 3, 2]],
        )

    def test_parameters_cannot_inject_syntax(self):
        malicious = "alpha'}) RETURN concept; MATCH (anything) RETURN anything //"
        self.assertEqual(
            self.rows(
                "MATCH (concept:Concept {label:$value}) RETURN concept", {"value": malicious}
            ),
            [],
        )
        self.assertEqual(self.rows("RETURN $value", {"value": malicious}), [[malicious]])

    def test_missing_parameters_are_reported_even_without_matches(self):
        with self.assertRaisesRegex(QueryError, "Missing parameter"):
            self.rows("MATCH (nothing:Missing) RETURN $missing")

    def test_parameter_types_and_non_finite_values(self):
        for parameters in [
            [],
            "text",
            {"term": float("inf")},
            {"term": float("nan")},
            {"term": {"nested": float("inf")}},
        ]:
            with self.subTest(parameters=parameters), self.assertRaises(QueryError):
                self.rows("RETURN $term", parameters)

    def test_comments_wildcard_and_computed_aggregate(self):
        self.assertEqual(
            self.rows("/* graph query */ WITH 2 AS first, 3 AS second // constants\nRETURN *"),
            [[2, 3]],
        )
        self.assertEqual(self.rows("MATCH (concept:Concept) RETURN count(*) + 1 AS total"), [[4]])

    def test_bound_relationships_can_be_reused_in_later_match(self):
        self.assertEqual(
            self.rows(
                "MATCH (first)-[link:CO_OCCURS_WITH]->(second) MATCH (first)-[link]->(second) RETURN link.weight"
            ),
            [[2]],
        )
        self.assertEqual(
            self.rows(
                "MATCH (first)-[link:CO_OCCURS_WITH]->(second), (first)-[link]->(second) RETURN link"
            ),
            [],
        )

    def test_grouped_graph_provenance_survives_with(self):
        result = self.engine.execute(
            "MATCH (passage)-[:MENTIONS]->(concept) WITH concept, count(*) AS total WHERE total > 1 RETURN concept.label, total"
        )
        self.assertEqual(result["rows"], [["alpha", 2]])
        self.assertEqual(set(result["graph"]["node_ids"]), {"alpha", "first", "second"})
        self.assertEqual(set(result["graph"]["edge_ids"]), {"pa1", "pa2"})

    def test_sorting_nulls(self):
        self.assertEqual(
            self.rows(
                "MATCH (concept:Concept) RETURN concept.label AS label, concept.occurrences AS occurrences ORDER BY occurrences"
            ),
            [["beta", 1], ["alpha", 2], ["orphan", None]],
        )
        self.assertEqual(
            self.rows(
                "MATCH (concept:Concept) RETURN concept.label AS label, concept.occurrences AS occurrences ORDER BY occurrences DESC LIMIT 1"
            ),
            [["orphan", None]],
        )

    def test_errors_have_source_locations(self):
        with self.assertRaises(QueryError) as caught:
            self.rows("MATCH (concept:Concept)\nRETURN missing")
        details = caught.exception.details("MATCH (concept:Concept)\nRETURN missing")
        self.assertEqual((details["line"], details["column"]), (2, 8))

    def test_unsupported_or_invalid_queries(self):
        queries = [
            "CREATE (node)",
            "MATCH (node) DELETE node",
            "RETURN 1; RETURN 2",
            "MATCH (node)-[:MENTIONS*]->(other) RETURN node",
            "MATCH (node)-[:MENTIONS*1..7]->(other) RETURN node",
            "MATCH (node)-[:MENTIONS*3..1]->(other) RETURN node",
            "MATCH (node) RETURN unknown",
            "RETURN __import__('os')",
            "RETURN count(DISTINCT *)",
            "RETURN count(count(*))",
            "MATCH (node) WHERE count(*) > 0 RETURN node",
            "MATCH (node) RETURN node.label + count(*)",
            "MATCH (node) WITH node.label RETURN node",
            "RETURN 1 AS same, 2 AS same",
            "RETURN 1 LIMIT -1",
            "RETURN 1 LIMIT TRUE",
            "RETURN 1/0",
            "RETURN 'x' - 2",
            "RETURN lower(1)",
            "RETURN size(1)",
            "RETURN 1 IN '1'",
            "RETURN 'unterminated",
            "RETURN 1e999",
            "RETURN 1 =",
            "MATCH (node) WHERE node RETURN node",
            "RETURN $missing",
        ]
        for query in queries:
            with self.subTest(query=query), self.assertRaises(QueryError):
                self.rows(query)

    def test_relationships_are_not_repeated_within_a_trail(self):
        graph = fixture_graph()
        graph["edges"].append(
            {
                "id": "loop",
                "source": "alpha",
                "target": "alpha",
                "type": "CO_OCCURS_WITH",
                "properties": {},
            }
        )
        result = QueryEngine(graph).execute(
            "MATCH path=(start:Concept {label:'alpha'})-[:CO_OCCURS_WITH*1..4]-(end) RETURN path"
        )
        self.assertTrue(result["rows"])
        for row in result["rows"]:
            identifiers = [edge["id"] for edge in row[0]["relationships"]]
            self.assertEqual(len(identifiers), len(set(identifiers)))

    def test_work_and_intermediate_limits_fail_explicitly(self):
        with self.assertRaises(QueryLimitError):
            QueryEngine(self.graph, QueryLimits(max_steps=5)).execute("MATCH (node) RETURN node")
        with self.assertRaises(QueryLimitError):
            QueryEngine(self.graph, QueryLimits(max_intermediate_rows=2)).execute(
                "MATCH (node) RETURN node"
            )

    def test_output_caps_are_reported(self):
        result = QueryEngine(self.graph, QueryLimits(max_rows=1)).execute(
            "MATCH (concept:Concept) RETURN concept.label ORDER BY concept.label"
        )
        self.assertTrue(result["truncated"])
        self.assertEqual(result["stats"]["total_rows"], 3)
        self.assertEqual(result["rows"], [["alpha"]])
        with self.assertRaises(QueryLimitError):
            QueryEngine(self.graph, QueryLimits(max_result_bytes=10)).execute(
                "MATCH (node) RETURN node"
            )

    def test_queries_do_not_modify_the_graph(self):
        before = copy.deepcopy(self.graph)
        self.rows("MATCH path=(node)-[*1..2]-(other) RETURN path LIMIT 3")
        self.assertEqual(self.graph, before)
