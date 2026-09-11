"""GraphQuery: a read-only, Cypher-inspired query engine for JSON property graphs."""

from __future__ import annotations

import json
import math
import re
import time
from collections import defaultdict
from dataclasses import dataclass, field
from functools import cmp_to_key

AGGREGATES = {"count", "sum", "avg", "min", "max", "collect"}
FUNCTIONS = {
    "tolower": (1, 1),
    "lower": (1, 1),
    "toupper": (1, 1),
    "upper": (1, 1),
    "size": (1, 1),
    "length": (1, 1),
    "id": (1, 1),
    "type": (1, 1),
    "labels": (1, 1),
    "nodes": (1, 1),
    "relationships": (1, 1),
    "degree": (1, 2),
    "coalesce": (1, 32),
    "abs": (1, 1),
    **{name: (1, 1) for name in AGGREGATES},
}
TOKEN_PATTERN = re.compile(
    r"(?P<space>\s+)|(?P<comment>//[^\n]*|/\*[\s\S]*?\*/)"
    r"|(?P<number>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)"
    r"|(?P<parameter>\$[A-Za-z_]\w*)|(?P<name>[A-Za-z_]\w*)"
    r"|(?P<symbol>->|<-|<=|>=|<>|!=|\.\.|[()\[\]{},.:;|+*/%<>=-])"
)


class QueryError(ValueError):
    def __init__(self, message: str, position: int | None = None):
        super().__init__(message)
        self.position = position

    def details(self, source: str) -> dict:
        result = {
            "message": str(self),
            "code": "QUERY_LIMIT" if isinstance(self, QueryLimitError) else "QUERY_ERROR",
        }
        if self.position is not None:
            result.update(
                position=self.position,
                line=source.count("\n", 0, self.position) + 1,
                column=self.position - source.rfind("\n", 0, self.position),
            )
        return result


class QueryLimitError(QueryError):
    pass


@dataclass(frozen=True)
class Token:
    kind: str
    value: object
    position: int
    end: int


@dataclass(frozen=True)
class Expression:
    kind: str
    value: object = None
    args: tuple = ()
    position: int = field(default=0, compare=False)


@dataclass
class NodePattern:
    name: str | None
    label: str | None
    properties: dict


@dataclass
class EdgePattern:
    name: str | None
    types: tuple
    direction: str
    minimum: int
    maximum: int
    variable_length: bool
    properties: dict


@dataclass
class Pattern:
    name: str | None
    nodes: list
    edges: list


@dataclass
class MatchClause:
    patterns: list
    optional: bool
    introduced: set
    where: Expression | None


@dataclass
class Projection:
    items: list
    distinct: bool
    where: Expression | None
    order: list
    skip: Expression | None
    limit: Expression | None
    final: bool


def tokenize(source: str) -> list[Token]:
    if not isinstance(source, str) or not source.strip():
        raise QueryError("Enter a GraphQuery statement.")
    if len(source) > 16000:
        raise QueryLimitError("Query text exceeds 16,000 characters.")
    tokens = []
    position = 0
    while position < len(source):
        start = position
        if source[position] in "'\"`":
            quote = source[position]
            position += 1
            pieces = []
            while position < len(source):
                character = source[position]
                position += 1
                if character == quote:
                    if position < len(source) and source[position] == quote:
                        pieces.append(quote)
                        position += 1
                        continue
                    break
                if character == "\\" and quote != "`":
                    if position >= len(source):
                        raise QueryError("Unterminated string escape.", start)
                    escape = source[position]
                    position += 1
                    escapes = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\", "'": "'", '"': '"'}
                    if escape not in escapes:
                        raise QueryError(f"Unsupported escape: \\{escape}.", position - 2)
                    character = escapes[escape]
                pieces.append(character)
            else:
                raise QueryError("Unterminated quoted value.", start)
            tokens.append(
                Token("quoted" if quote == "`" else "string", "".join(pieces), start, position)
            )
        else:
            match = TOKEN_PATTERN.match(source, position)
            if not match:
                raise QueryError(f"Unexpected character {source[position]!r}.", position)
            position = match.end()
            kind = match.lastgroup
            if kind in {"space", "comment"}:
                continue
            value = match.group()
            if kind == "number":
                if len(value) > 128:
                    raise QueryError("Numeric literal exceeds 128 characters.", start)
                value = (
                    float(value) if any(character in value for character in ".eE") else int(value)
                )
                if isinstance(value, float) and not math.isfinite(value):
                    raise QueryError("Number must be finite.", start)
            elif kind == "parameter":
                value = value[1:]
            tokens.append(Token(kind, value, start, position))
        if len(tokens) > 4000:
            raise QueryLimitError("Query exceeds 4,000 tokens.")
    tokens.append(Token("end", "", len(source), len(source)))
    return tokens


def walk(expression: Expression):
    yield expression
    for argument in expression.args:
        yield from walk(argument)


def has_aggregate(expression: Expression) -> bool:
    return any(item.kind == "call" and item.value[0] in AGGREGATES for item in walk(expression))


class Parser:
    def __init__(self, source: str, max_hops: int):
        self.source = source
        self.tokens = tokenize(source)
        self.cursor = 0
        self.scope = {}
        self.max_hops = max_hops
        self.depth = 0

    @property
    def current(self) -> Token:
        return self.tokens[self.cursor]

    def at(self, value: str) -> bool:
        return (
            self.current.kind in {"name", "symbol"}
            and str(self.current.value).upper() == value.upper()
        )

    def accept(self, value: str) -> bool:
        if self.at(value):
            self.cursor += 1
            return True
        return False

    def expect(self, value: str) -> None:
        if not self.accept(value):
            raise QueryError(
                f"Expected {value}, found {self.current.value or 'end of query'!r}.",
                self.current.position,
            )

    def name(self) -> str:
        token = self.current
        if token.kind not in {"name", "quoted"} or not token.value:
            raise QueryError("Expected an identifier.", token.position)
        self.cursor += 1
        return str(token.value)

    def register(self, name: str | None, kind: str) -> None:
        if name is None:
            return
        previous = self.scope.get(name)
        if previous and previous not in {kind, "value"}:
            raise QueryError(
                f"Variable {name!r} is already bound as {previous}.", self.current.position
            )
        self.scope[name] = kind

    def validate(
        self, expression: Expression, scope: dict | None = None, aggregates: bool = False
    ) -> None:
        scope = self.scope if scope is None else scope
        for item in walk(expression):
            if item.kind == "variable" and item.value not in scope:
                raise QueryError(f"Unknown variable {item.value!r}.", item.position)
            if item.kind == "call" and item.value[0] in AGGREGATES:
                if not aggregates:
                    raise QueryError(
                        "Aggregates are only allowed in WITH or RETURN projections.", item.position
                    )
                if any(has_aggregate(argument) for argument in item.args):
                    raise QueryError("Nested aggregate functions are unsupported.", item.position)

    def expression(self, minimum: int = 0) -> Expression:
        self.depth += 1
        if self.depth > 48:
            raise QueryLimitError("Expression nesting exceeds 48 levels.", self.current.position)
        try:
            token = self.current
            if self.accept("NOT"):
                left = Expression("unary", "NOT", (self.expression(3),), token.position)
            elif self.accept("-") or self.accept("+"):
                left = Expression("unary", token.value, (self.expression(6),), token.position)
            elif self.accept("("):
                left = self.expression()
                self.expect(")")
            elif self.accept("["):
                arguments = []
                if not self.at("]"):
                    arguments.append(self.expression())
                    while self.accept(","):
                        arguments.append(self.expression())
                self.expect("]")
                left = Expression("list", args=tuple(arguments), position=token.position)
            elif self.accept("{"):
                properties = self.properties(after_open=True)
                left = Expression(
                    "map", tuple(properties), tuple(properties.values()), token.position
                )
            elif token.kind in {"number", "string", "parameter"}:
                self.cursor += 1
                left = Expression(
                    "parameter" if token.kind == "parameter" else "literal",
                    token.value,
                    position=token.position,
                )
            elif self.at("TRUE") or self.at("FALSE") or self.at("NULL"):
                self.cursor += 1
                left = Expression(
                    "literal",
                    {"TRUE": True, "FALSE": False, "NULL": None}[str(token.value).upper()],
                    position=token.position,
                )
            elif token.kind in {"name", "quoted"}:
                name = self.name()
                if self.accept("("):
                    function = name.lower()
                    if function not in FUNCTIONS:
                        raise QueryError(f"Unknown function {name!r}.", token.position)
                    distinct = self.accept("DISTINCT")
                    arguments = []
                    if self.accept("*"):
                        if function != "count" or distinct:
                            raise QueryError("Only count(*) accepts a wildcard.", token.position)
                        arguments.append(Expression("star"))
                    elif not self.at(")"):
                        arguments.append(self.expression())
                        while self.accept(","):
                            arguments.append(self.expression())
                    self.expect(")")
                    lower, upper = FUNCTIONS[function]
                    if not lower <= len(arguments) <= upper or (
                        distinct and function not in AGGREGATES
                    ):
                        raise QueryError(f"Invalid arguments for {name}().", token.position)
                    left = Expression(
                        "call", (function, distinct), tuple(arguments), token.position
                    )
                else:
                    left = Expression("variable", name, position=token.position)
            else:
                raise QueryError("Expected an expression.", token.position)
            while True:
                if self.accept("."):
                    left = Expression("property", self.name(), (left,), token.position)
                    continue
                if self.accept("["):
                    index = self.expression()
                    self.expect("]")
                    left = Expression("index", args=(left, index), position=token.position)
                    continue
                operator = (
                    str(self.current.value).upper()
                    if self.current.kind in {"name", "symbol"}
                    else ""
                )
                precedence = {
                    "OR": 1,
                    "AND": 2,
                    "=": 3,
                    "!=": 3,
                    "<>": 3,
                    "<": 3,
                    ">": 3,
                    "<=": 3,
                    ">=": 3,
                    "IN": 3,
                    "IS": 3,
                    "CONTAINS": 3,
                    "STARTS": 3,
                    "ENDS": 3,
                    "+": 4,
                    "-": 4,
                    "*": 5,
                    "/": 5,
                    "%": 5,
                }.get(operator, -1)
                if precedence < minimum:
                    break
                self.cursor += 1
                if operator == "IS":
                    negated = self.accept("NOT")
                    self.expect("NULL")
                    left = Expression(
                        "unary", "IS NOT NULL" if negated else "IS NULL", (left,), token.position
                    )
                    continue
                if operator in {"STARTS", "ENDS"}:
                    self.expect("WITH")
                    operator += " WITH"
                right = self.expression(precedence + 1)
                left = Expression("binary", operator, (left, right), token.position)
            return left
        finally:
            self.depth -= 1

    def properties(self, after_open: bool = False) -> dict:
        if not after_open:
            self.expect("{")
        result = {}
        if not self.at("}"):
            while True:
                key = self.name()
                if key in result:
                    raise QueryError(f"Duplicate property {key!r}.", self.current.position)
                self.expect(":")
                result[key] = self.expression()
                if not self.accept(","):
                    break
        self.expect("}")
        return result

    def node(self) -> NodePattern:
        self.expect("(")
        name = self.name() if self.current.kind in {"name", "quoted"} else None
        self.register(name, "node")
        label = self.name() if self.accept(":") else None
        properties = self.properties() if self.at("{") else {}
        self.expect(")")
        return NodePattern(name, label, properties)

    def pattern(self) -> Pattern:
        name = None
        if self.current.kind in {"name", "quoted"} and self.tokens[self.cursor + 1].value == "=":
            name = self.name()
            self.expect("=")
            self.register(name, "path")
        nodes = [self.node()]
        edges = []
        while self.at("-") or self.at("<-"):
            incoming = self.accept("<-")
            if not incoming:
                self.expect("-")
            variable = None
            types = []
            minimum = maximum = 1
            variable_length = False
            properties = {}
            if self.accept("["):
                variable = self.name() if self.current.kind in {"name", "quoted"} else None
                if self.accept(":"):
                    types.append(self.name())
                    while self.accept("|"):
                        self.accept(":")
                        types.append(self.name())
                if self.accept("*"):
                    variable_length = True
                    if self.current.kind != "number" or type(self.current.value) is not int:
                        raise QueryError(
                            "Paths need an explicit bound, for example *1..3 or *2.",
                            self.current.position,
                        )
                    minimum = maximum = self.current.value
                    self.cursor += 1
                    if self.accept(".."):
                        if self.current.kind != "number" or type(self.current.value) is not int:
                            raise QueryError(
                                "A path upper bound is required.", self.current.position
                            )
                        maximum = self.current.value
                        self.cursor += 1
                    if not 0 <= minimum <= maximum <= self.max_hops:
                        raise QueryError(
                            f"Path bounds must satisfy 0 <= minimum <= maximum <= {self.max_hops}.",
                            self.current.position,
                        )
                if self.at("{"):
                    properties = self.properties()
                self.expect("]")
            self.register(variable, "edges" if variable_length else "edge")
            direction = "in" if incoming else "out" if self.accept("->") else "any"
            if direction != "out":
                self.expect("-")
            edges.append(
                EdgePattern(
                    variable, tuple(types), direction, minimum, maximum, variable_length, properties
                )
            )
            nodes.append(self.node())
            if len(edges) > 12:
                raise QueryLimitError("A pattern can contain at most 12 relationship segments.")
        return Pattern(name, nodes, edges)

    def projection(self, final: bool) -> Projection:
        distinct = self.accept("DISTINCT")
        items = []
        if self.accept("*"):
            items = [(Expression("variable", name), name) for name in self.scope]
            if not items:
                raise QueryError("No variables are available for RETURN *.", self.current.position)
        else:
            while True:
                start = self.current.position
                expression = self.expression()
                end = self.tokens[self.cursor - 1].end
                self.validate(expression, aggregates=True)
                explicit_alias = self.accept("AS")
                alias = (
                    self.name()
                    if explicit_alias
                    else expression.value
                    if expression.kind == "variable"
                    else self.source[start:end].strip()
                )
                if not final and expression.kind != "variable" and not explicit_alias:
                    raise QueryError("WITH expressions require an AS alias.", start)
                items.append((expression, alias))
                if not self.accept(","):
                    break
        names = [alias for expression, alias in items]
        if len(names) != len(set(names)):
            raise QueryError("Projection column names must be unique. Use AS aliases.")
        aggregate = any(has_aggregate(expression) for expression, alias in items)
        for expression, _alias in items:
            if has_aggregate(expression):
                self.validate_group_expression(expression)
        output_scope = {
            alias: self.scope.get(expression.value, "value")
            if expression.kind == "variable"
            else "value"
            for expression, alias in items
        }
        where = None
        if not final and self.accept("WHERE"):
            where = self.expression()
            self.validate(where, output_scope)
        order = []
        if self.accept("ORDER"):
            self.expect("BY")
            while True:
                expression = self.expression()
                self.validate(
                    expression,
                    output_scope if aggregate or distinct else {**self.scope, **output_scope},
                )
                descending = self.accept("DESC")
                if not descending:
                    self.accept("ASC")
                order.append((expression, descending))
                if not self.accept(","):
                    break
        skip = self.expression() if self.accept("SKIP") else None
        limit = self.expression() if self.accept("LIMIT") else None
        for expression in (skip, limit):
            if expression:
                self.validate(expression, {})
        self.scope = output_scope
        return Projection(items, distinct, where, order, skip, limit, final)

    def validate_group_expression(self, expression: Expression) -> None:
        if expression.kind == "call" and expression.value[0] in AGGREGATES:
            return
        if expression.kind == "variable":
            raise QueryError(
                "Keep grouping expressions separate from aggregates; combine them in a following WITH.",
                expression.position,
            )
        for argument in expression.args:
            self.validate_group_expression(argument)

    def parse(self) -> list:
        clauses = []
        while True:
            if len(clauses) >= 24:
                raise QueryLimitError("Query exceeds 24 clauses.")
            optional = self.accept("OPTIONAL")
            if optional or self.at("MATCH"):
                self.expect("MATCH")
                previous_scope = dict(self.scope)
                patterns = [self.pattern()]
                while self.accept(","):
                    patterns.append(self.pattern())
                    if len(patterns) > 12:
                        raise QueryLimitError("A MATCH clause supports at most 12 patterns.")
                for pattern in patterns:
                    for item in [*pattern.nodes, *pattern.edges]:
                        for expression in item.properties.values():
                            self.validate(expression, {})
                where = self.expression() if self.accept("WHERE") else None
                if where:
                    self.validate(where)
                clauses.append(
                    MatchClause(patterns, optional, set(self.scope) - set(previous_scope), where)
                )
            elif self.accept("WITH"):
                clauses.append(self.projection(final=False))
            elif self.accept("RETURN"):
                clauses.append(self.projection(final=True))
                self.accept(";")
                if self.current.kind != "end":
                    raise QueryError(
                        "Only one read-only statement is allowed; unexpected trailing input.",
                        self.current.position,
                    )
                return clauses
            else:
                raise QueryError(
                    "Expected MATCH, OPTIONAL MATCH, WITH, or RETURN. Queries must end with RETURN.",
                    self.current.position,
                )


@dataclass(frozen=True)
class Entity:
    kind: str
    identifier: str


@dataclass(frozen=True)
class PathValue:
    nodes: tuple
    edges: tuple


@dataclass
class Row:
    values: dict
    nodes: frozenset = frozenset()
    edges: frozenset = frozenset()


@dataclass(frozen=True)
class QueryLimits:
    max_hops: int = 6
    max_rows: int = 1000
    max_intermediate_rows: int = 20000
    max_steps: int = 250000
    timeout_seconds: float = 2.0
    max_result_bytes: int = 4 * 1024 * 1024


def number(value: object) -> bool:
    return type(value) in {int, float}


def canonical(value: object):
    if value is None:
        return ("null",)
    if isinstance(value, Entity):
        return (value.kind, value.identifier)
    if isinstance(value, PathValue):
        return ("path", value.nodes, value.edges)
    if number(value):
        return ("number", value)
    if isinstance(value, dict):
        return ("map", tuple(sorted((key, canonical(item)) for key, item in value.items())))
    if isinstance(value, (list, tuple)):
        return ("list", tuple(canonical(item) for item in value))
    return (type(value).__name__, value)


def truth(value: object) -> bool | None:
    if value is None or type(value) is bool:
        return value
    raise QueryError("Boolean expressions require TRUE, FALSE, or NULL.")


def compare(left: object, right: object) -> int:
    if left is None or right is None:
        return (left is None) - (right is None)
    if number(left) and number(right):
        return (left > right) - (left < right)
    if type(left) is type(right) and isinstance(left, (str, bool)):
        return (left > right) - (left < right)
    raise QueryError("Ordering requires comparable numbers, strings, or booleans.")


class QueryEngine:
    def __init__(self, graph: dict, limits: QueryLimits | None = None):
        self.limits = limits or QueryLimits()
        self.nodes = {node["id"]: node for node in graph["nodes"]}
        self.edges = {edge["id"]: edge for edge in graph["edges"]}
        self.labels = defaultdict(list)
        self.outgoing = defaultdict(list)
        self.incoming = defaultdict(list)
        self.adjacent = defaultdict(list)
        for identifier, node in self.nodes.items():
            self.labels[node["type"]].append(identifier)
        for identifier, edge in self.edges.items():
            self.outgoing[edge["source"]].append(identifier)
            self.incoming[edge["target"]].append(identifier)
            self.adjacent[edge["source"]].append(identifier)
            if edge["target"] != edge["source"]:
                self.adjacent[edge["target"]].append(identifier)

    def execute(self, source: str, parameters: dict | None = None) -> dict:
        parameters = {} if parameters is None else parameters
        if not isinstance(parameters, dict) or any(not isinstance(key, str) for key in parameters):
            raise QueryError("Parameters must be a JSON object with string keys.")
        try:
            try:
                encoded = json.dumps(parameters, allow_nan=False)
            except (ValueError, TypeError) as error:
                raise QueryError("Parameters must contain finite JSON values.") from error
            if len(encoded) > 64000:
                raise QueryLimitError("Parameters exceed 64,000 characters.")
            run = Execution(self, parameters)
            clauses = Parser(source, self.limits.max_hops).parse()
            for clause in clauses:
                expressions = [clause.where] if clause.where else []
                if isinstance(clause, MatchClause):
                    expressions.extend(
                        expression
                        for pattern in clause.patterns
                        for item in [*pattern.nodes, *pattern.edges]
                        for expression in item.properties.values()
                    )
                else:
                    expressions.extend(expression for expression, alias in clause.items)
                    expressions.extend(expression for expression, descending in clause.order)
                    expressions.extend(
                        expression for expression in [clause.skip, clause.limit] if expression
                    )
                for expression in expressions:
                    for item in walk(expression):
                        if item.kind == "parameter" and item.value not in parameters:
                            raise QueryError(f"Missing parameter ${item.value}.", item.position)
            return run.execute(clauses)
        except RecursionError as error:
            raise QueryLimitError("Query or data nesting is too deep.") from error
        except (TypeError, OverflowError) as error:
            raise QueryError(f"Unsupported value: {error}") from error


class Execution:
    def __init__(self, engine: QueryEngine, parameters: dict):
        self.engine = engine
        self.parameters = parameters
        self.started = time.monotonic()
        self.steps = 0
        self.peak_rows = 0

    def tick(self) -> None:
        self.steps += 1
        if self.steps > self.engine.limits.max_steps:
            raise QueryLimitError(
                "Query exceeded its work budget. Narrow the initial MATCH or reduce path depth."
            )
        if (
            self.steps % 64 == 0
            and time.monotonic() - self.started > self.engine.limits.timeout_seconds
        ):
            raise QueryLimitError("Query timed out. Narrow the initial MATCH or reduce path depth.")

    def check_rows(self, rows: list) -> None:
        self.peak_rows = max(self.peak_rows, len(rows))
        if len(rows) > self.engine.limits.max_intermediate_rows:
            raise QueryLimitError(
                "Too many intermediate rows. Filter earlier with MATCH ... WHERE or WITH ... LIMIT."
            )

    def property(self, value: object, key: str):
        if value is None:
            return None
        if isinstance(value, Entity):
            data = (
                self.engine.nodes[value.identifier]
                if value.kind == "node"
                else self.engine.edges[value.identifier]
            )
            return data[key] if key in data else data.get("properties", {}).get(key)
        if isinstance(value, dict):
            return value.get(key)
        raise QueryError(f"Cannot read property {key!r} from this value.")

    def evaluate(self, expression: Expression, values: dict, group: list[Row] | None = None):
        self.tick()
        kind = expression.kind
        if kind == "literal":
            return expression.value
        if kind == "variable":
            return values.get(expression.value)
        if kind == "parameter":
            if expression.value not in self.parameters:
                raise QueryError(f"Missing parameter ${expression.value}.", expression.position)
            return self.parameters[expression.value]
        if kind == "property":
            return self.property(self.evaluate(expression.args[0], values, group), expression.value)
        if kind == "list":
            return [self.evaluate(argument, values, group) for argument in expression.args]
        if kind == "map":
            return {
                key: self.evaluate(argument, values, group)
                for key, argument in zip(expression.value, expression.args, strict=False)
            }
        if kind == "index":
            container = self.evaluate(expression.args[0], values, group)
            index = self.evaluate(expression.args[1], values, group)
            if container is None or index is None:
                return None
            if isinstance(container, dict) and isinstance(index, str):
                return container.get(index)
            if isinstance(container, (list, tuple, str)) and type(index) is int:
                return container[index] if -len(container) <= index < len(container) else None
            raise QueryError(
                "Indexing requires a list/string and integer, or a map and string key.",
                expression.position,
            )
        if kind == "unary":
            value = self.evaluate(expression.args[0], values, group)
            if expression.value == "IS NULL":
                return value is None
            if expression.value == "IS NOT NULL":
                return value is not None
            if expression.value == "NOT":
                return None if truth(value) is None else not value
            if value is None:
                return None
            if not number(value):
                raise QueryError("Unary arithmetic requires a number.", expression.position)
            return -value if expression.value == "-" else value
        if kind == "binary":
            operator = expression.value
            left = self.evaluate(expression.args[0], values, group)
            if operator in {"AND", "OR"}:
                left = truth(left)
                if operator == "AND" and left is False:
                    return False
                if operator == "OR" and left is True:
                    return True
                right = truth(self.evaluate(expression.args[1], values, group))
                if operator == "AND":
                    return (
                        False if right is False else None if left is None or right is None else True
                    )
                return True if right is True else None if left is None or right is None else False
            right = self.evaluate(expression.args[1], values, group)
            if left is None or right is None:
                return None
            if operator in {"=", "!=", "<>"}:
                equal = canonical(left) == canonical(right)
                return equal if operator == "=" else not equal
            if operator in {"<", ">", "<=", ">="}:
                comparison = compare(left, right)
                return {
                    "<": comparison < 0,
                    ">": comparison > 0,
                    "<=": comparison <= 0,
                    ">=": comparison >= 0,
                }[operator]
            if operator == "IN":
                if not isinstance(right, (list, tuple)):
                    raise QueryError("IN requires a list on the right.", expression.position)
                if any(canonical(left) == canonical(item) for item in right if item is not None):
                    return True
                return None if None in right else False
            if operator in {"CONTAINS", "STARTS WITH", "ENDS WITH"}:
                if not isinstance(left, str) or not isinstance(right, str):
                    raise QueryError(f"{operator} requires strings.", expression.position)
                return (
                    right in left
                    if operator == "CONTAINS"
                    else left.startswith(right)
                    if operator == "STARTS WITH"
                    else left.endswith(right)
                )
            if operator == "+" and isinstance(left, str) and isinstance(right, str):
                if len(left) + len(right) > 100000:
                    raise QueryLimitError("Computed string is too large.")
                return left + right
            if not number(left) or not number(right):
                raise QueryError(
                    "Arithmetic requires numbers; + also concatenates two strings.",
                    expression.position,
                )
            if operator in {"/", "%"} and right == 0:
                raise QueryError("Division by zero.", expression.position)
            result = {
                "+": lambda: left + right,
                "-": lambda: left - right,
                "*": lambda: left * right,
                "/": lambda: left / right,
                "%": lambda: left % right,
            }[operator]()
            if (
                isinstance(result, float)
                and not math.isfinite(result)
                or isinstance(result, int)
                and result.bit_length() > 4096
            ):
                raise QueryLimitError("Computed number is too large.")
            return result
        if kind == "call":
            name, distinct = expression.value
            if name in AGGREGATES:
                if group is None:
                    raise QueryError("Aggregate used outside a projection.", expression.position)
                if expression.args[0].kind == "star":
                    return len(group)
                items = [self.evaluate(expression.args[0], row.values) for row in group]
                items = [item for item in items if item is not None]
                if distinct:
                    unique = {}
                    for item in items:
                        unique.setdefault(canonical(item), item)
                    items = list(unique.values())
                if name == "count":
                    return len(items)
                if name == "collect":
                    return items
                if name in {"sum", "avg"}:
                    if not all(number(item) for item in items):
                        raise QueryError(f"{name}() requires numeric values.", expression.position)
                    result = sum(items)
                    if name == "avg":
                        result = result / len(items) if items else None
                    if isinstance(result, float) and not math.isfinite(result):
                        raise QueryError("Aggregate produced a non-finite number.")
                    return result
                if not items:
                    return None
                return sorted(items, key=cmp_to_key(compare), reverse=name == "max")[0]
            if name == "coalesce":
                for argument in expression.args:
                    value = self.evaluate(argument, values, group)
                    if value is not None:
                        return value
                return None
            arguments = [self.evaluate(argument, values, group) for argument in expression.args]
            value = arguments[0]
            if value is None:
                return None
            if name in {"tolower", "lower", "toupper", "upper"}:
                if not isinstance(value, str):
                    raise QueryError(f"{name}() requires a string.", expression.position)
                return value.lower() if name in {"tolower", "lower"} else value.upper()
            if name == "size" and isinstance(value, (str, list, tuple, dict)):
                return len(value)
            if name == "abs" and number(value):
                return abs(value)
            if name in {"length", "nodes", "relationships"} and isinstance(value, PathValue):
                return (
                    len(value.edges)
                    if name == "length"
                    else list(value.nodes if name == "nodes" else value.edges)
                )
            if name in {"id", "type", "labels", "degree"} and isinstance(value, Entity):
                if name == "id":
                    return value.identifier
                if name == "type":
                    return self.property(value, "type")
                if value.kind == "node":
                    if name == "labels":
                        return [self.property(value, "type")]
                    if len(arguments) == 2 and not isinstance(arguments[1], str):
                        raise QueryError("degree() relationship type must be a string.")
                    return sum(
                        1
                        for identifier in self.engine.adjacent[value.identifier]
                        if len(arguments) == 1
                        or self.engine.edges[identifier]["type"] == arguments[1]
                    )
            raise QueryError(f"Unsupported argument type for {name}().", expression.position)
        raise QueryError("Unsupported expression.", expression.position)

    def matches_properties(self, entity: Entity, properties: dict, values: dict) -> bool:
        for key, expression in properties.items():
            actual = self.property(entity, key)
            expected = self.evaluate(expression, values)
            if actual is None or expected is None or canonical(actual) != canonical(expected):
                return False
        return True

    def bind(self, values: dict, name: str | None, value: object) -> dict | None:
        if name is None:
            return values
        if name in values:
            return values if canonical(values[name]) == canonical(value) else None
        return {**values, name: value}

    def bind_node(self, pattern: NodePattern, identifier: str, values: dict) -> dict | None:
        self.tick()
        if pattern.label and self.engine.nodes[identifier]["type"] != pattern.label:
            return None
        entity = Entity("node", identifier)
        bound = self.bind(values, pattern.name, entity)
        if bound is None or not self.matches_properties(entity, pattern.properties, bound):
            return None
        return bound

    def match_pattern(self, pattern: Pattern, row: Row, used: frozenset):
        first = pattern.nodes[0]
        if first.name and first.name in row.values:
            value = row.values[first.name]
            candidates = (
                [value.identifier] if isinstance(value, Entity) and value.kind == "node" else []
            )
        elif first.label:
            candidates = self.engine.labels.get(first.label, [])
        else:
            candidates = self.engine.nodes
        for identifier in candidates:
            bound = self.bind_node(first, identifier, row.values)
            if bound is not None:
                yield from self.match_chain(
                    pattern,
                    0,
                    identifier,
                    Row(bound, row.nodes | {identifier}, row.edges),
                    used,
                    (Entity("node", identifier),),
                    (),
                )

    def match_chain(
        self,
        pattern: Pattern,
        index: int,
        identifier: str,
        row: Row,
        used: frozenset,
        path_nodes: tuple,
        path_edges: tuple,
    ):
        if index == len(pattern.edges):
            bound = self.bind(row.values, pattern.name, PathValue(path_nodes, path_edges))
            if bound is not None:
                yield Row(bound, row.nodes, row.edges), used
            return
        edge_pattern = pattern.edges[index]
        for endpoint, segment_nodes, segment_edges in self.traverse(
            identifier, edge_pattern, used, row.values
        ):
            value = list(segment_edges) if edge_pattern.variable_length else segment_edges[0]
            bound = self.bind(row.values, edge_pattern.name, value)
            if bound is None:
                continue
            bound = self.bind_node(pattern.nodes[index + 1], endpoint, bound)
            if bound is None:
                continue
            node_ids = frozenset(node.identifier for node in segment_nodes)
            edge_ids = frozenset(edge.identifier for edge in segment_edges)
            next_row = Row(bound, row.nodes | node_ids, row.edges | edge_ids)
            yield from self.match_chain(
                pattern,
                index + 1,
                endpoint,
                next_row,
                used | edge_ids,
                path_nodes + segment_nodes,
                path_edges + segment_edges,
            )

    def traverse(self, start: str, pattern: EdgePattern, used: frozenset, values: dict):
        stack = [(start, (), (), used)]
        while stack:
            self.tick()
            identifier, nodes, edges, visited = stack.pop()
            if len(edges) >= pattern.minimum:
                yield identifier, nodes, edges
            if len(edges) == pattern.maximum:
                continue
            adjacency = (
                self.engine.outgoing
                if pattern.direction == "out"
                else self.engine.incoming
                if pattern.direction == "in"
                else self.engine.adjacent
            )
            for edge_id in reversed(adjacency.get(identifier, [])):
                self.tick()
                if edge_id in visited:
                    continue
                data = self.engine.edges[edge_id]
                if pattern.types and data["type"] not in pattern.types:
                    continue
                entity = Entity("edge", edge_id)
                if not self.matches_properties(entity, pattern.properties, values):
                    continue
                endpoint = data["target"] if data["source"] == identifier else data["source"]
                stack.append(
                    (
                        endpoint,
                        nodes + (Entity("node", endpoint),),
                        edges + (entity,),
                        visited | {edge_id},
                    )
                )

    def match_patterns(self, patterns: list, index: int, row: Row, used: frozenset):
        if index == len(patterns):
            yield row
            return
        for matched, matched_edges in self.match_pattern(patterns[index], row, used):
            yield from self.match_patterns(patterns, index + 1, matched, matched_edges)

    def match(self, clause: MatchClause, rows: list[Row]) -> list[Row]:
        result = []
        for row in rows:
            found = False
            for matched in self.match_patterns(clause.patterns, 0, row, frozenset()):
                self.tick()
                if (
                    clause.where is None
                    or truth(self.evaluate(clause.where, matched.values)) is True
                ):
                    found = True
                    result.append(matched)
                    self.check_rows(result)
            if not found and clause.optional:
                result.append(
                    Row({**row.values, **dict.fromkeys(clause.introduced)}, row.nodes, row.edges)
                )
                self.check_rows(result)
        return result

    def project(self, clause: Projection, rows: list[Row]) -> list[Row]:
        aggregate = any(has_aggregate(expression) for expression, alias in clause.items)
        groups = {}
        if aggregate:
            keys = [
                expression for expression, alias in clause.items if not has_aggregate(expression)
            ]
            if not keys:
                groups[()] = []
            for row in rows:
                key = tuple(canonical(self.evaluate(expression, row.values)) for expression in keys)
                groups.setdefault(key, []).append(row)
        else:
            groups = {index: [row] for index, row in enumerate(rows)}
        projected = []
        unique = {}
        for group in groups.values():
            self.tick()
            previous = group[0].values if group else {}
            values = {
                alias: self.evaluate(expression, previous, group if aggregate else None)
                for expression, alias in clause.items
            }
            if clause.where and truth(self.evaluate(clause.where, values)) is not True:
                continue
            nodes = frozenset().union(*(row.nodes for row in group))
            edges = frozenset().union(*(row.edges for row in group))
            row = Row(values, nodes, edges)
            if clause.distinct:
                key = canonical(values)
                if key in unique:
                    existing = unique[key]
                    existing.nodes |= nodes
                    existing.edges |= edges
                    continue
                unique[key] = row
            order_values = values if aggregate or clause.distinct else {**previous, **values}
            sort_keys = [
                self.evaluate(expression, order_values) for expression, descending in clause.order
            ]
            projected.append((row, sort_keys))
            self.check_rows(projected)
        if clause.order:

            def compare_rows(left, right):
                self.tick()
                for index, (_expression, descending) in enumerate(clause.order):
                    result = compare(left[1][index], right[1][index])
                    if result:
                        return -result if descending else result
                return 0

            projected.sort(key=cmp_to_key(compare_rows))
        skip = self.page_number(clause.skip, 0)
        limit = self.page_number(clause.limit, len(projected))
        return [row for row, keys in projected[skip : skip + limit]]

    def page_number(self, expression: Expression | None, default: int) -> int:
        value = default if expression is None else self.evaluate(expression, {})
        if type(value) is not int or value < 0:
            raise QueryError(
                "SKIP and LIMIT require non-negative integers.",
                expression.position if expression else None,
            )
        return value

    def serialize(self, value: object):
        self.tick()
        if isinstance(value, Entity):
            data = (
                self.engine.nodes[value.identifier]
                if value.kind == "node"
                else self.engine.edges[value.identifier]
            )
            return {**data, "$type": "node" if value.kind == "node" else "relationship"}
        if isinstance(value, PathValue):
            return {
                "$type": "path",
                "nodes": [self.serialize(node) for node in value.nodes],
                "relationships": [self.serialize(edge) for edge in value.edges],
            }
        if isinstance(value, (list, tuple)):
            return [self.serialize(item) for item in value]
        if isinstance(value, dict):
            return {key: self.serialize(item) for key, item in value.items()}
        return value

    def execute(self, clauses: list) -> dict:
        rows = [Row({})]
        for clause in clauses:
            rows = (
                self.match(clause, rows)
                if isinstance(clause, MatchClause)
                else self.project(clause, rows)
            )
        columns = [alias for expression, alias in clauses[-1].items]
        result = []
        node_ids = set()
        edge_ids = set()
        byte_count = 0
        for row in rows[: self.engine.limits.max_rows]:
            values = [self.serialize(row.values[column]) for column in columns]
            byte_count += len(
                json.dumps(values, ensure_ascii=False, allow_nan=False).encode("utf-8")
            )
            if byte_count > self.engine.limits.max_result_bytes:
                if not result:
                    raise QueryLimitError(
                        "A result row exceeds the response size limit. Return scalar properties instead of full entities."
                    )
                break
            result.append(values)
            node_ids.update(row.nodes)
            edge_ids.update(row.edges)
        return {
            "language": "GraphQuery/1",
            "columns": columns,
            "rows": result,
            "graph": {"node_ids": sorted(node_ids), "edge_ids": sorted(edge_ids)},
            "truncated": len(result) < len(rows),
            "stats": {
                "rows": len(result),
                "total_rows": len(rows),
                "elapsed_ms": round((time.monotonic() - self.started) * 1000, 2),
                "work": self.steps,
                "peak_intermediate_rows": self.peak_rows,
            },
        }
