"""Bounded, offline DOCX extraction and graph JSON validation."""

from __future__ import annotations

import hashlib
import json
import math
import re
import zipfile
import zlib
from collections import Counter
from datetime import UTC, datetime
from itertools import combinations
from pathlib import Path
from xml.etree import ElementTree

from defusedxml.common import DefusedXmlException
from defusedxml.ElementTree import fromstring

WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NAMESPACES = {"w": WORD_NAMESPACE}
MAX_XML_BYTES = 32 * 1024 * 1024
MAX_JSON_BYTES = 50 * 1024 * 1024
WORD_PATTERN = re.compile(r"[^\W\d_][\w]*(?:[-'][^\W\d_][\w]*)*", re.UNICODE)
STOP_WORDS = set(
    """a about above after again against all also am an and any are aren't as at
    be because been before being below between both but by can cannot could did
    do does doing don't down during each few for from further get gets got had
    has have having he her here hers herself him himself his how however i if in
    into is isn't it its itself just may me might more most much must my myself
    no nor not now of off on once only or other our ours ourselves out over own
    same she should so some such than that the their theirs them themselves then
    there these they this those through to too under until up us use used using
    uses very via was we were what when where which while who whom why will with
    within without would you your yours yourself yourselves also one two three
    example examples include includes including following new many well across
    document section table figure page need needs provide provides based make
    makes made different every first second third often together information
    can’t don’t doesn’t isn’t it’s that's that’s""".split()
)


def stable_id(kind: str, value: str) -> str:
    return f"{kind}_{hashlib.sha256(value.encode('utf-8')).hexdigest()[:20]}"


def read_xml(archive: zipfile.ZipFile, member: str) -> ElementTree.Element:
    entry = archive.getinfo(member)
    if entry.file_size > MAX_XML_BYTES:
        raise ValueError(f"DOCX member {member} exceeds the 32 MiB limit.")
    content = archive.read(entry)
    if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
        raise ValueError("DOCX XML must not contain DTDs or entity declarations.")
    return fromstring(content, forbid_dtd=True, forbid_entities=True, forbid_external=True)


def paragraph_text(element: ElementTree.Element) -> str:
    pieces = []
    for child in element.iter():
        if child.tag == f"{{{WORD_NAMESPACE}}}t":
            pieces.append(child.text or "")
        elif child.tag in {f"{{{WORD_NAMESPACE}}}tab", f"{{{WORD_NAMESPACE}}}br"}:
            pieces.append(" ")
    return " ".join("".join(pieces).split())


def heading_level(element: ElementTree.Element) -> int | None:
    outline = element.find("w:pPr/w:outlineLvl", NAMESPACES)
    if outline is not None:
        value = outline.get(f"{{{WORD_NAMESPACE}}}val", "")
        if value.isdigit() and 0 <= int(value) <= 8:
            return int(value) + 1
    return None


def read_docx(path: Path) -> list[dict]:
    if path.suffix.lower() != ".docx":
        raise ValueError("Input must be a .docx file; legacy .doc files are unsupported.")
    try:
        with zipfile.ZipFile(path) as archive:
            if len(archive.infolist()) > 2000:
                raise ValueError("DOCX archive contains too many members.")
            document = read_xml(archive, "word/document.xml")
            styles = {}
            if "word/styles.xml" in archive.namelist():
                for style in read_xml(archive, "word/styles.xml").findall("w:style", NAMESPACES):
                    style_id = style.get(f"{{{WORD_NAMESPACE}}}styleId", "")
                    name = style.find("w:name", NAMESPACES)
                    style_name = (
                        name.get(f"{{{WORD_NAMESPACE}}}val", "") if name is not None else ""
                    )
                    match = re.fullmatch(r"heading\s*([1-9])", style_name, re.IGNORECASE)
                    styles[style_id] = heading_level(style) or (int(match[1]) if match else None)
            body = document.find("w:body", NAMESPACES)
            if body is None:
                raise ValueError("DOCX has no document body.")
            blocks = []
            table_number = 0

            def append_paragraph(paragraph: ElementTree.Element) -> None:
                content = paragraph_text(paragraph)
                if not content:
                    return
                style = paragraph.find("w:pPr/w:pStyle", NAMESPACES)
                style_id = style.get(f"{{{WORD_NAMESPACE}}}val", "") if style is not None else ""
                match = re.fullmatch(r"heading\s*([1-9])", style_id, re.IGNORECASE)
                level = (
                    heading_level(paragraph)
                    or styles.get(style_id)
                    or (int(match[1]) if match else None)
                )
                blocks.append({"text": content, "kind": "paragraph", "heading_level": level})

            def visit(element: ElementTree.Element) -> None:
                nonlocal table_number
                if element.tag == f"{{{WORD_NAMESPACE}}}p":
                    append_paragraph(element)
                elif element.tag == f"{{{WORD_NAMESPACE}}}tbl":
                    table_number += 1
                    for row_number, row in enumerate(element.findall("w:tr", NAMESPACES), start=1):
                        cells = [
                            " ".join(
                                paragraph_text(paragraph)
                                for paragraph in cell.iter(f"{{{WORD_NAMESPACE}}}p")
                            )
                            for cell in row.findall("w:tc", NAMESPACES)
                        ]
                        if any(cell.strip() for cell in cells):
                            blocks.append(
                                {
                                    "text": " | ".join(cells),
                                    "kind": "table_row",
                                    "table": table_number,
                                    "row": row_number,
                                }
                            )
                else:
                    for child in element:
                        visit(child)

            visit(body)
    except (
        zipfile.BadZipFile,
        zlib.error,
        KeyError,
        ElementTree.ParseError,
        RuntimeError,
        NotImplementedError,
        DefusedXmlException,
    ) as error:
        raise ValueError(f"Cannot read DOCX: {error}") from error
    if not blocks:
        raise ValueError("The DOCX contains no readable paragraphs or table rows.")
    return blocks


def concept_candidates(content: str) -> tuple[Counter, dict[str, str]]:
    words = WORD_PATTERN.findall(content)
    counts = Counter()
    labels = {}
    for word in words:
        normalized = word.casefold().strip("-'")
        if len(normalized) >= 3 and normalized not in STOP_WORDS:
            counts[normalized] += 1
            labels.setdefault(
                normalized,
                word if any(character.isupper() for character in word[1:]) else normalized,
            )
    return counts, labels


def build_graph(
    path: Path,
    max_concepts: int = 80,
    concepts_per_passage: int = 6,
    source_name: str | None = None,
) -> dict:
    if max_concepts < 1 or concepts_per_passage < 1:
        raise ValueError("Concept limits must be positive integers.")
    blocks = read_docx(path)
    source = Path(source_name or path.name)
    if len(blocks) > 10000:
        raise ValueError("DOCX exceeds the 10,000 text-block limit.")
    document_digest = hashlib.sha256(path.read_bytes()).hexdigest()
    document_id = stable_id("document", document_digest)
    nodes = [
        {
            "id": document_id,
            "label": source.stem,
            "type": "Document",
            "properties": {"filename": source.name, "sha256": document_digest},
        }
    ]
    edges = []
    passages = []
    section_stack = [(0, document_id)]

    def add_edge(
        source: str, target: str, relationship: str, properties: dict | None = None
    ) -> None:
        edges.append(
            {
                "id": stable_id("edge", f"{source}:{relationship}:{target}"),
                "source": source,
                "target": target,
                "type": relationship,
                "properties": properties or {},
            }
        )

    for position, block in enumerate(blocks, start=1):
        level = block.get("heading_level")
        node_type = "Section" if level else "Passage"
        node_id = stable_id(node_type.lower(), f"{document_digest}:{position}")
        content = block["text"]
        label = content if len(content) <= 75 else content[:72] + "…"
        properties = {**block, "position": position, "document_id": document_id}
        properties.pop("heading_level", None)
        if level:
            properties["level"] = level
            while section_stack[-1][0] >= level:
                section_stack.pop()
        nodes.append({"id": node_id, "label": label, "type": node_type, "properties": properties})
        add_edge(section_stack[-1][1], node_id, "CONTAINS")
        if level:
            section_stack.append((level, node_id))
        passages.append((node_id, content))

    candidates = []
    labels = {}
    document_frequency = Counter()
    total_frequency = Counter()
    for node_id, content in passages:
        counts, passage_labels = concept_candidates(content)
        candidates.append((node_id, counts))
        labels.update(passage_labels)
        document_frequency.update(counts.keys())
        total_frequency.update(counts)

    def score(term: str, frequency: int) -> float:
        return (1 + math.log(frequency)) * (
            1 + math.log((1 + len(passages)) / (1 + document_frequency[term]))
        )

    ranked = sorted(total_frequency, key=lambda term: (-score(term, total_frequency[term]), term))
    allowed = set(ranked[:max_concepts])
    mentions = Counter()
    co_occurrences = {}
    for node_id, counts in candidates:
        selected = sorted(
            allowed.intersection(counts), key=lambda term: (-score(term, counts[term]), term)
        )[:concepts_per_passage]
        for term in selected:
            concept_id = stable_id("concept", term)
            add_edge(node_id, concept_id, "MENTIONS", {"occurrences": counts[term]})
            mentions[term] += 1
        for left, right in combinations(sorted(selected), 2):
            evidence = co_occurrences.setdefault((left, right), [])
            evidence.append(node_id)
    for term in sorted(mentions):
        nodes.append(
            {
                "id": stable_id("concept", term),
                "label": labels[term],
                "type": "Concept",
                "properties": {
                    "normalized": term,
                    "occurrences": total_frequency[term],
                    "passage_count": mentions[term],
                    "extraction": "keyword",
                },
            }
        )
    for (left, right), evidence in sorted(co_occurrences.items()):
        add_edge(
            stable_id("concept", left),
            stable_id("concept", right),
            "CO_OCCURS_WITH",
            {"weight": len(evidence), "evidence": evidence},
        )
    return {
        "schema_version": 1,
        "metadata": {
            "title": source.stem,
            "source": source.name,
            "created_at": datetime.now(UTC).isoformat(),
            "extraction": "offline-keyword-cooccurrence",
            "description": "Concepts are keywords. Co-occurrence means terms appear in the same passage, not a verified semantic relationship.",
            "settings": {
                "max_concepts": max_concepts,
                "concepts_per_passage": concepts_per_passage,
            },
        },
        "nodes": nodes,
        "edges": edges,
    }


def validate_graph(graph: object) -> dict:
    if (
        not isinstance(graph, dict)
        or type(graph.get("schema_version")) is not int
        or graph["schema_version"] != 1
    ):
        raise ValueError("Graph must be an object with schema_version: 1.")
    if not isinstance(graph.get("metadata", {}), dict):
        raise ValueError("Graph metadata must be an object.")
    if not isinstance(graph.get("nodes"), list) or not graph["nodes"]:
        raise ValueError("Graph nodes must be a non-empty array.")
    if not isinstance(graph.get("edges"), list):
        raise ValueError("Graph edges must be an array.")
    node_ids = set()
    edge_ids = set()
    for collection, identifiers, fields in (
        (graph["nodes"], node_ids, ("id", "label", "type")),
        (graph["edges"], edge_ids, ("id", "source", "target", "type")),
    ):
        for item in collection:
            if not isinstance(item, dict) or any(
                not isinstance(item.get(field), str) or not item[field].strip() for field in fields
            ):
                raise ValueError(
                    f"Each graph item requires non-empty strings: {', '.join(fields)}."
                )
            if item["id"] in identifiers:
                raise ValueError(f"Duplicate graph ID: {item['id']}")
            if not isinstance(item.get("properties", {}), dict):
                raise ValueError(f"Properties must be an object: {item['id']}")
            identifiers.add(item["id"])
    for edge in graph["edges"]:
        if edge["source"] not in node_ids or edge["target"] not in node_ids:
            raise ValueError(f"Edge references an unknown node: {edge['id']}")
    return graph


def reject_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON number: {value}")


def load_graph(path: Path) -> dict:
    if path.stat().st_size > MAX_JSON_BYTES:
        raise ValueError("Graph JSON exceeds the 50 MiB limit.")
    return validate_graph(
        json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_json_constant)
    )
