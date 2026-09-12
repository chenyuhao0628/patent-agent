#!/usr/bin/env python3
"""Convert DOCX text to reviewable Markdown without silently overwriting files."""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree as ET


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
REVISION_MODES = {"accepted", "original"}
REVISION_CONTAINERS = {
    f"{W}ins",
    f"{W}del",
    f"{W}moveFrom",
    f"{W}moveTo",
}
KNOWN_HEADINGS = {
    "发明名称": 1,
    "说明书": 1,
    "权利要求书": 1,
    "说明书摘要": 1,
    "摘要": 1,
    "技术领域": 2,
    "背景技术": 2,
    "发明内容": 2,
    "附图说明": 2,
    "具体实施方式": 2,
    "要解决的技术问题": 3,
    "技术方案": 3,
    "有益效果": 3,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert a DOCX file to Markdown.")
    parser.add_argument("input", help="Source .docx file")
    parser.add_argument("-o", "--output", help="Destination .md file")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite an existing output file. Never use this for the source/formal version.",
    )
    parser.add_argument(
        "--revision-mode",
        choices=sorted(REVISION_MODES),
        help="Required when tracked revisions are present: accepted or original.",
    )
    return parser.parse_args()


@dataclass(frozen=True)
class ConversionResult:
    markdown: str
    warnings: tuple[str, ...]
    revision_mode: str | None


def revision_container_visible(tag: str, revision_mode: str | None) -> bool:
    if tag in {f"{W}ins", f"{W}moveTo"}:
        return revision_mode == "accepted"
    if tag in {f"{W}del", f"{W}moveFrom"}:
        return revision_mode == "original"
    return True


def paragraph_text(paragraph: ET.Element, revision_mode: str | None = None) -> str:
    pieces: list[str] = []

    def collect(node: ET.Element) -> None:
        if node.tag in REVISION_CONTAINERS and not revision_container_visible(
            node.tag, revision_mode
        ):
            return
        if node.tag in {f"{W}t", f"{M}t"} or (
            node.tag == f"{W}delText" and revision_mode == "original"
        ):
            pieces.append(node.text or "")
        elif node.tag == f"{W}tab":
            pieces.append("\t")
        elif node.tag in {f"{W}br", f"{W}cr"}:
            pieces.append("\n")
        for child in node:
            collect(child)

    collect(paragraph)
    return "".join(pieces).strip()


def style_levels(archive: zipfile.ZipFile) -> dict[str, int]:
    try:
        root = ET.fromstring(archive.read("word/styles.xml"))
    except KeyError:
        return {}

    levels: dict[str, int] = {}
    for style in root.findall(f"{W}style"):
        style_id = style.get(f"{W}styleId")
        if not style_id:
            continue
        name_node = style.find(f"{W}name")
        name = name_node.get(f"{W}val", "") if name_node is not None else ""
        outline = style.find(f".//{W}outlineLvl")
        if outline is not None and outline.get(f"{W}val", "").isdigit():
            levels[style_id] = min(int(outline.get(f"{W}val")) + 1, 6)
            continue
        match = re.search(r"(?:Heading|标题)\s*([1-6])", name, re.I)
        if match:
            levels[style_id] = int(match.group(1))
    return levels


def heading_level(paragraph: ET.Element, text: str, levels: dict[str, int]) -> int | None:
    if text in KNOWN_HEADINGS:
        return KNOWN_HEADINGS[text]
    style = paragraph.find(f"./{W}pPr/{W}pStyle")
    if style is None:
        return None
    return levels.get(style.get(f"{W}val", ""))


def list_info(paragraph: ET.Element) -> tuple[str, int] | None:
    num_id = paragraph.find(f"./{W}pPr/{W}numPr/{W}numId")
    level = paragraph.find(f"./{W}pPr/{W}numPr/{W}ilvl")
    if num_id is None:
        return None
    return (
        num_id.get(f"{W}val", "0"),
        int(level.get(f"{W}val", "0")) if level is not None else 0,
    )


def table_markdown(table: ET.Element, revision_mode: str | None = None) -> list[str]:
    rows: list[list[str]] = []
    for row in table.findall(f"./{W}tr"):
        cells: list[str] = []
        for cell in row.findall(f"./{W}tc"):
            parts = [
                paragraph_text(paragraph, revision_mode)
                for paragraph in cell.findall(f".//{W}p")
                if paragraph_text(paragraph, revision_mode)
            ]
            cells.append("<br>".join(parts).replace("|", "\\|"))
        if cells:
            rows.append(cells)
    if not rows:
        return []
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    output = ["| " + " | ".join(rows[0]) + " |"]
    output.append("| " + " | ".join(["---"] * width) + " |")
    output.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    return output


def iter_blocks(
    parent: ET.Element, revision_mode: str | None = None
) -> Iterator[ET.Element]:
    """Yield paragraphs and tables in document order, including content controls."""
    for child in parent:
        if child.tag in REVISION_CONTAINERS and not revision_container_visible(
            child.tag, revision_mode
        ):
            continue
        if child.tag in {f"{W}p", f"{W}tbl"}:
            yield child
            continue
        yield from iter_blocks(child, revision_mode)


def blocks_markdown(
    parent: ET.Element, levels: dict[str, int], revision_mode: str | None = None
) -> list[str]:
    blocks: list[str] = []
    counters: dict[tuple[str, int], int] = {}
    for child in iter_blocks(parent, revision_mode):
        if child.tag == f"{W}p":
            text = paragraph_text(child, revision_mode)
            if not text:
                continue
            level = heading_level(child, text, levels)
            if level is not None:
                blocks.append(f"{'#' * level} {text}")
                continue
            numbering = list_info(child)
            if numbering and not re.match(r"^\d+[.、]\s*", text):
                counters[numbering] = counters.get(numbering, 0) + 1
                indent = "  " * numbering[1]
                text = f"{indent}{counters[numbering]}. {text}"
            blocks.append(text)
        else:
            table = table_markdown(child, revision_mode)
            if table:
                blocks.append("\n".join(table))
    return blocks


def supplemental_notes(
    archive: zipfile.ZipFile,
    part_name: str,
    title: str,
    levels: dict[str, int],
    revision_mode: str | None = None,
) -> list[str]:
    if part_name not in archive.namelist():
        return []
    root = ET.fromstring(archive.read(part_name))
    sections: list[str] = []
    for note in root:
        raw_id = note.get(f"{W}id", "")
        if raw_id.startswith("-"):
            continue
        blocks = blocks_markdown(note, levels, revision_mode)
        if blocks:
            sections.append(f"### {title}{raw_id or ''}\n\n" + "\n\n".join(blocks))
    if not sections:
        return []
    return [f"## {title}", *sections]


def conversion_warnings(
    archive: zipfile.ZipFile,
    document_root: ET.Element,
    revision_mode: str | None = None,
) -> list[str]:
    names = set(archive.namelist())
    warnings: list[str] = []

    math_count = len(document_root.findall(f".//{M}oMath")) + len(
        document_root.findall(f".//{M}oMathPara")
    )
    if math_count:
        warnings.append(
            f"检测到{math_count}处Office数学公式；已提取公式文本，但必须对照原DOCX或渲染页核对结构、上下标和符号。"
        )

    media = sorted(name for name in names if name.startswith("word/media/"))
    drawings = len(document_root.findall(f".//{W}drawing")) + len(
        document_root.findall(f".//{W}pict")
    )
    if media or drawings:
        warnings.append(
            f"检测到嵌入媒体/图形（媒体文件{len(media)}个，图形节点{drawings}个）；Markdown不代表附图内容，必须检查原DOCX或渲染页。"
        )

    insertions = len(document_root.findall(f".//{W}ins"))
    deletions = len(document_root.findall(f".//{W}del"))
    moves = len(document_root.findall(f".//{W}moveFrom")) + len(
        document_root.findall(f".//{W}moveTo")
    )
    if insertions or deletions or moves:
        mode_label = revision_mode or "未选择"
        warnings.append(
            f"检测到修订痕迹；转换稿使用{mode_label}修订视图，必须确认审查版本并核对原DOCX或渲染页。"
        )

    headers = [name for name in names if re.fullmatch(r"word/header\d+\.xml", name)]
    footers = [name for name in names if re.fullmatch(r"word/footer\d+\.xml", name)]
    if headers or footers:
        warnings.append(
            f"检测到页眉/页脚（{len(headers)}/{len(footers)}个）；其内容未并入正文，必要时对照原DOCX核验。"
        )

    if "word/comments.xml" in names:
        warnings.append("检测到批注；批注未并入正式正文，必须区分正式申请文本与内部意见。")
    if any(name.startswith("word/embeddings/") for name in names):
        warnings.append("检测到嵌入对象；其内容无法可靠转为Markdown，必须检查原DOCX。")
    return warnings


def revision_counts(document_root: ET.Element) -> dict[str, int]:
    return {
        "ins": len(document_root.findall(f".//{W}ins")),
        "del": len(document_root.findall(f".//{W}del")),
        "moveFrom": len(document_root.findall(f".//{W}moveFrom")),
        "moveTo": len(document_root.findall(f".//{W}moveTo")),
    }


def convert(source: Path, revision_mode: str | None = None) -> ConversionResult:
    with zipfile.ZipFile(source) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        levels = style_levels(archive)
        if revision_mode is not None and revision_mode not in REVISION_MODES:
            raise ValueError(
                f"无效的修订模式：{revision_mode}。可选值为 accepted 或 original。"
            )
        counts = revision_counts(root)
        if any(counts.values()) and revision_mode is None:
            raise ValueError(
                "检测到修订痕迹；请显式指定 --revision-mode accepted 或 --revision-mode original。"
            )
        body = root.find(f"{W}body")
        blocks = (
            blocks_markdown(body, levels, revision_mode) if body is not None else []
        )
        blocks.extend(
            supplemental_notes(archive, "word/footnotes.xml", "脚注", levels, revision_mode)
        )
        blocks.extend(
            supplemental_notes(archive, "word/endnotes.xml", "尾注", levels, revision_mode)
        )
        warnings = conversion_warnings(archive, root, revision_mode)

    markdown = "\n\n".join(blocks).rstrip()
    if markdown:
        markdown += "\n"
    return ConversionResult(markdown, tuple(warnings), revision_mode)


def default_destination(source: Path) -> Path:
    output_dir = Path(tempfile.mkdtemp(prefix="patent-docx-"))
    return output_dir / f"{source.stem}.md"


def write_markdown(destination: Path, markdown: str, force: bool = False) -> None:
    if destination.exists() and not force:
        raise FileExistsError(
            f"目标文件已存在，未覆盖：{destination}。请更换输出路径；只有过程文件才能显式使用--force。"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(markdown, encoding="utf-8")


def main() -> int:
    args = parse_args()
    source = Path(args.input).expanduser().resolve()
    if source.suffix.lower() != ".docx" or not source.is_file():
        raise SystemExit("ERROR: 输入必须是存在的.docx文件。")
    destination = (
        Path(args.output).expanduser().resolve()
        if args.output
        else default_destination(source)
    )
    try:
        result = convert(source, args.revision_mode)
        write_markdown(destination, result.markdown, args.force)
    except (FileExistsError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(destination)
    for warning in result.warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    if result.revision_mode:
        print(f"WARNING: 修订模式：{result.revision_mode}。", file=sys.stderr)
    if result.warnings:
        print(
            "WARNING: 转换稿不得作为唯一审查依据；完成所列原DOCX/渲染核验后再作全文结论。",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
