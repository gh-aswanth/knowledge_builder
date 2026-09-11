# GraphQuery v1

GraphQuery is a read-only, Cypher-inspired language for the JSON property graph
produced by this application. It runs locally in Python, without Neo4j,
third-party dependencies, `eval`, remote calls, or changes to the graph file.
It is a deliberately bounded subset, not an implementation of the full Cypher
standard or a database replacement.

## Execution model

1. Tokenize and parse one statement into a typed syntax tree.
2. Validate variable scopes, function names, parameters, and traversal bounds.
3. Match patterns using node-type and incoming/outgoing adjacency indexes.
4. Filter, project, group, sort, and paginate rows in written clause order.
5. Return a table plus the supporting graph IDs for the returned rows.

There is no cost-based planner. Put selective types and property maps at the
start of patterns. Narrow early with `MATCH ... WHERE` and `WITH ... LIMIT`.
`RETURN ... LIMIT` limits the final table, not the work of preceding matches or
aggregates. Disconnected patterns produce Cartesian products and can hit limits.

## Quick start

In the viewer, click the terminal icon in the left rail to open **GraphQuery**.
Choose an example, edit its JSON parameters, and run with **Cmd/Ctrl+Enter**.
Results are paginated at 50 rows per page. Click entity cells to inspect them,
path cells to explore a route, or **Show on graph** for the supporting subgraph.
**Download results** saves the complete returned table, not just its visible page.
Long table values are abbreviated on screen but retained in the downloaded JSON.

Canvas search/type/weight filters do not constrain queries. Query graph views
temporarily bypass these filters. The canvas still displays at most 600 nodes;
the table and download are independent of this canvas cap. Clearing focus or
changing filters restores regular exploration. Editing the query or parameters
invalidates previous results and cancels the browser's pending request, if any.
Server work already started may continue until its execution budget is reached.

### Frequently mentioned concepts

```cypher
MATCH (passage:Passage)-[:MENTIONS]->(concept:Concept)
WITH concept, count(DISTINCT passage) AS mentions
WHERE mentions >= 3
RETURN concept, mentions
ORDER BY mentions DESC
LIMIT 20
```

### Text search with source concepts

Parameters: `{"term":"security"}`

```cypher
MATCH (passage:Passage)
WHERE toLower(passage.text) CONTAINS toLower($term)
OPTIONAL MATCH (passage)-[:MENTIONS]->(concept:Concept)
RETURN passage, collect(DISTINCT concept) AS concepts
LIMIT 50
```

### Shared source passages (a join)

Parameters: `{"first":"provider","second":"agreement"}`

```cypher
MATCH (first:Concept {label: $first})<-[:MENTIONS]-(passage:Passage),
      (passage)-[:MENTIONS]->(second:Concept {label: $second})
RETURN passage.text AS text, first, second
LIMIT 50
```

### Strong associations

Parameters: `{"weight":3}`

```cypher
MATCH (first:Concept)-[link:CO_OCCURS_WITH]->(second:Concept)
WHERE link.weight >= $weight
RETURN first, link, second, link.weight AS sharedPassages
ORDER BY sharedPassages DESC
LIMIT 30
```

`->` honors the JSON's stored direction, including `CO_OCCURS_WITH`. Use
`(first)-[:CO_OCCURS_WITH]-(second)` to search an association in either direction.
An unrestricted undirected pattern normally returns both endpoint orientations;
add `WHERE first.id < second.id` to return each distinct-endpoint pair once.

### Bounded routes through the document

Parameters: `{"term":"data"}`

```cypher
MATCH path=(document:Document)-[links:CONTAINS*1..3]->(passage:Passage)
WHERE toLower(passage.text) CONTAINS toLower($term)
RETURN path, length(path) AS hops, size(links) AS relationships
ORDER BY hops
LIMIT 25
```

This enumerates matching trails; it is not a shortest-path algorithm. The existing
viewer **Path finder** remains available for shortest routes. Paths follow only
`CONTAINS` here, so a mention/co-occurrence edge cannot create an unrelated route.

### Include concepts without passages

```cypher
MATCH (concept:Concept)
OPTIONAL MATCH (passage:Passage)-[:MENTIONS]->(concept)
WITH concept, count(passage) AS mentions
WHERE mentions = 0
RETURN concept
```

## Syntax

The following is a compact grammar outline. A statement must finish with RETURN;
an optional semicolon is allowed. Multiple statements are rejected.

```text
statement  := (match | with)* return [";"]
match      := [OPTIONAL] MATCH pattern ("," pattern)* [WHERE expression]
pattern    := [identifier "="] node (relationship node)*
node       := "(" [identifier] [":" type] [propertyMap] ")"
relationship := "-" ["[" edgeSpec "]"] ("->" | "-")
              | "<-" ["[" edgeSpec "]"] "-"
edgeSpec   := [identifier] [":" type ("|" [":"] type)*]
              ["*" integer [".." integer]] [propertyMap]
with       := WITH projection [WHERE expression] [order] [skip] [limit]
return     := RETURN projection [order] [skip] [limit]
projection := [DISTINCT] ("*" | expression [AS identifier]
              ("," expression [AS identifier])*)
order      := ORDER BY expression [ASC | DESC] ("," expression [ASC | DESC])*
skip       := SKIP expression
limit      := LIMIT expression
```

- Keywords and function names are case-insensitive. Variables, type/property
  names, and string comparisons are case-sensitive. Use `toLower` for text search.
- Identifiers can use backticks, for example `` AS `shared passages` ``.
- Strings use single or double quotes. Double the quote to escape it, or use
  `\n`, `\r`, `\t`, `\\`, `\'`, and `\"` escapes. Unicode text is supported.
- `//` line comments and `/* block comments */` are supported.
- Literals include finite numbers, `TRUE`, `FALSE`, `NULL`, lists `[1, 2]`, and
  maps `{term: 'data'}`. Map keys are identifiers or backtick-quoted identifiers.
- `$name` binds a JSON value; it cannot substitute a variable/type/property name
  or inject syntax. All referenced parameters must be supplied even if no rows match.

## Pattern and scope semantics

Each JSON node has one type, selected with `(concept:Concept)`. Generated types
are `Document`, `Section`, `Passage`, and `Concept`; custom graph types also work.
Relationships have one type and optional properties. Types may be omitted to
match any type; `[:CONTAINS|MENTIONS]` selects alternatives for a relationship.

Shared variables join patterns. An already-bound variable must match the same
entity/value; it is not silently rebound. Each relationship may be traversed only
once within one MATCH clause, including its comma-separated patterns. Nodes may
repeat. A later MATCH clause can reuse a relationship.

`*2` means exactly two hops; `*0..3` means zero through three. Bounds must be
explicit integers, with an upper bound no greater than six per segment. A
variable-length relationship variable is a list, even for one hop; an ordinary
relationship variable is one relationship. Named paths expose ordered nodes and
relationships. Zero-hop paths contain one node and no relationships.

Inline property maps use equality against literals, parameters, or constant
expressions. They cannot refer to bound variables; use `WHERE first.label =
second.label` instead. A null/missing property does not satisfy a map constraint.

`OPTIONAL MATCH` preserves an incoming row when its entire pattern and attached
WHERE have no match, assigning NULL to newly introduced variables. Its WHERE
belongs to the optional match; filter the resulting rows afterward with WITH.

WITH replaces the variable scope with its projected columns; variables not
carried forward are no longer available. Computed WITH expressions need an AS
alias. RETURN expressions without aliases use their source text as column names.
Column names must be unique. `WITH *` and `RETURN *` project the current scope;
wildcards cannot be mixed with other projection items.

## Expressions

| Operation | Syntax / semantics |
| --- | --- |
| Properties | `node.label`, `node.text`, `node.properties.text`, `link.weight` |
| Equality | `=`, `!=`, `<>`; numbers compare numerically, booleans are not numbers |
| Ordering | `<`, `<=`, `>`, `>=`; comparable numbers, strings, or booleans |
| Boolean | `NOT`, `AND`, `OR`; accepts only booleans or NULL |
| Missing values | `IS NULL`, `IS NOT NULL` |
| Membership | `value IN [value1, value2]` |
| Text | `CONTAINS`, `STARTS WITH`, `ENDS WITH` |
| Arithmetic | `+`, `-`, `*`, `/`, `%`, unary `+`/`-`; `+` also joins two strings |
| Indexing | `list[0]`, `list[-1]`, `map['key']`, `text[0]`; out of range gives NULL |

Built-in entity fields such as `id`, `type`, `label`, `source`, and `target` take
precedence over properties with the same name. Access a shadowed custom property
explicitly through `.properties`. Missing properties return NULL.

Multiplication/division precede addition, then comparisons, NOT, AND, and OR.
Use parentheses to make complex conditions explicit. Comparisons and arithmetic
with NULL return NULL; WHERE retains only TRUE. NULL AND FALSE is FALSE; NULL OR
TRUE is TRUE. An unsuccessful IN against a list containing NULL returns NULL.

| Function | Result |
| --- | --- |
| `toLower(text)`, `lower(text)` | Lowercase text |
| `toUpper(text)`, `upper(text)` | Uppercase text |
| `coalesce(first, second, ...)` | First non-null value (up to 32 arguments) |
| `size(value)` | String/list length or number of map entries |
| `length(path)` | Relationship count in a named path |
| `nodes(path)`, `relationships(path)` | Ordered entity lists |
| `id(entity)`, `type(entity)` | Node/relationship ID or type |
| `labels(node)` | A one-element list containing the node type |
| `degree(node[, relationshipType])` | Full-graph incident edge count, either direction; self-loops counted once |
| `abs(number)` | Absolute value |

Except coalesce, a function with a null first argument returns NULL. Invalid
argument types produce errors rather than implicit conversions.

## Aggregation, ordering, and pagination

`count(*)` counts rows, including optional rows. `count(expression)` counts
non-null values. `sum`, `avg`, `min`, `max`, and `collect` ignore NULL. All accept
DISTINCT arguments except `count(*)`. `collect(DISTINCT concept)` deduplicates by
entity ID. `RETURN DISTINCT ...` deduplicates the full projected row.

Non-aggregate projection items define grouping keys. With no matches, an
aggregate-only projection returns one row: count/sum are 0, collect is `[]`, and
avg/min/max are NULL. A grouped projection with no matches returns no rows.
Nested aggregates are unsupported.

Keep grouping expressions separate from aggregates. For example,
`RETURN concept.label + count(*)` is rejected; compute `WITH concept.label AS
label, count(*) AS total` then `RETURN label, total` instead. Aggregates may be
combined with constants or wrapped in scalar functions, such as `size(collect(concept))`.

Use projected aliases in ORDER BY after aggregation or DISTINCT. For example,
`RETURN concept, count(*) AS total ORDER BY total DESC`, not `ORDER BY count(*)`.
Without aggregation/DISTINCT, ORDER BY may also use incoming variables. Multiple
sort keys are supported. NULL sorts last ascending and first descending. Values
being ordered must have comparable scalar types, not entities/maps/lists.

Within a projection clause, WHERE (WITH only) runs before ORDER BY, then SKIP,
then LIMIT. Pagination takes non-negative integers, parameters, or constant
expressions. Use an explicit ORDER BY for repeatable pages.

## Python and HTTP

```python
from pathlib import Path
from docx_knowledge_graph.extraction import load_graph
from docx_knowledge_graph.graph_query import QueryEngine

engine = QueryEngine(load_graph(Path("graph.json")))
result = engine.execute(
    "MATCH (node:Concept {label:$term}) RETURN node",
    {"term": "data"},
)
```

Send the same query and parameters to `POST /api/graphs/{graph_id}/query`
with `Content-Type: application/json` and `X-Workspace-Token`. See the
[README](README.md#api) for the upload/bootstrap and curl workflow.

Response shape (illustrative):

```json
{
  "language": "GraphQuery/1",
  "columns": ["concept", "mentions"],
  "rows": [["agreement", 15]],
  "graph": {"node_ids": ["concept_1", "passage_1"], "edge_ids": ["edge_1"]},
  "truncated": false,
  "stats": {"rows": 1, "total_rows": 1, "elapsed_ms": 1.2, "work": 123, "peak_intermediate_rows": 15}
}
```

Rows are arrays aligned with columns, not dictionaries. Entity cells include
`"$type":"node"` or `"$type":"relationship"` alongside their original JSON
fields. Paths use `{"$type":"path","nodes":[...],"relationships":[...]}`.
Lists and maps can contain serialized entities.

The graph IDs preserve **provenance**: all matched entities supporting returned
rows, including through aggregates and DISTINCT, not only entities projected as
cells. `MATCH (node) RETURN count(*)` therefore supports the full matched graph's
nodes. Entities belonging solely to rows excluded by WHERE/SKIP/LIMIT are not
included. Pure scalar queries such as `RETURN 1` have no supporting entities.
Relationship evidence remains in the original relationship properties and can
be explored in the inspector; evidence IDs do not automatically expand the
matched subgraph. `stats.total_rows` is the row count after explicit query
pagination but before transport truncation.

Errors use `{"error":{"message":"...","code":"QUERY_ERROR","line":2,
"column":8,"position":23}}`. Positions are zero-based Unicode code-point
offsets; lines/columns are one-based. Location fields are present when available.
HTTP status is 400 for invalid queries/JSON, 422 for execution limits
(`QUERY_LIMIT`), 429 when two queries are already executing, 415 for non-JSON
content types, and 413 for oversized request bodies. Protocol errors may only
include a message.

## Limits and deliberate omissions

Default safeguards:

- 16,000 query characters, 4,000 tokens, 48 levels of expression nesting.
- 24 clauses; 12 patterns per MATCH; 12 relationship segments per pattern.
- At most six hops per variable-length segment; no unbounded traversals.
- 250,000 work steps, 20,000 intermediate rows, and a checked two-second budget.
- Up to 1,000 returned rows and approximately 4 MiB of serialized row data;
  the supporting graph IDs and response metadata are additional.
- HTTP bodies up to 64,000 bytes; at most two concurrently executing queries.

Work/intermediate limits fail explicitly: partial aggregates are never presented
as complete answers. Output caps set `truncated: true`; paginate or project fewer
properties. A single row exceeding the size cap raises an error. These are local
application safeguards, not a production multitenant isolation mechanism.

Unsupported: CREATE/MERGE/SET/DELETE, schema mutations, UNION, UNWIND, subqueries,
regex predicates, comprehensions, user-defined functions, transactions, database
indexes, multiple node labels, unbounded paths, and shortestPath in query syntax.
The local server has no authentication; keep its default loopback binding unless
you intend to share the document and query endpoint with your network.
