#!/usr/bin/env python3
"""Check deterministic formatting of Chinese patent application Markdown."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


SUPPORTED_SUFFIXES = {".md", ".txt"}
REQUIRED_SPEC_SECTIONS = ("技术领域", "背景技术", "发明内容", "具体实施方式")


@dataclass(frozen=True)
class Finding:
    severity: str
    code: str
    file: str
    line: int
    message: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check deterministic formatting of formal Chinese patent files."
    )
    parser.add_argument("paths", nargs="+", help="Formal Markdown/text files or directories")
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    parser.add_argument(
        "--fail-on-warning",
        action="store_true",
        help="Return nonzero when warnings are present",
    )
    return parser.parse_args()


def collect_files(raw_paths: list[str]) -> list[Path]:
    files: set[Path] = set()
    for raw in raw_paths:
        path = Path(raw).expanduser().resolve()
        if not path.exists():
            raise FileNotFoundError(path)
        if path.is_file():
            if path.suffix.lower() in SUPPORTED_SUFFIXES:
                files.add(path)
            continue
        for candidate in path.rglob("*"):
            if (
                candidate.is_file()
                and candidate.suffix.lower() in SUPPORTED_SUFFIXES
                and not any(part.startswith(".") for part in candidate.parts)
            ):
                files.add(candidate.resolve())
    return sorted(files)


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def add_finding(
    findings: list[Finding],
    severity: str,
    code: str,
    path: Path,
    text: str,
    offset: int,
    message: str,
) -> None:
    findings.append(
        Finding(severity, code, str(path), line_number(text, offset), message)
    )


def claim_region(path: Path, text: str) -> tuple[str, int] | None:
    headings = list(
        re.finditer(r"(?m)^\s*(?:#{1,6}\s*)?权利要求书\s*$", text)
    )
    if headings:
        heading = headings[-1]
        start = heading.end()
        next_heading = re.search(r"(?m)^#{1,6}\s+\S", text[start:])
        end = start + next_heading.start() if next_heading else len(text)
        return text[start:end], start
    if "权利要求" in path.stem:
        return text, 0
    return None


def has_heading(text: str, name: str) -> bool:
    return bool(
        re.search(rf"(?m)^\s*(?:#{{1,6}}\s*)?{re.escape(name)}\s*$", text)
    )


def extract_claims(region: str, base_offset: int) -> list[tuple[int, str, int]]:
    starts = list(re.finditer(r"(?m)^\s*(\d+)[.、]\s*", region))
    claims: list[tuple[int, str, int]] = []
    for index, match in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else len(region)
        claims.append(
            (
                int(match.group(1)),
                region[match.end() : end].strip(),
                base_offset + match.end(),
            )
        )
    return claims


def audit_claims(path: Path, text: str, findings: list[Finding]) -> None:
    located = claim_region(path, text)
    if located is None:
        return
    region, base_offset = located
    claims = extract_claims(region, base_offset)
    if not claims:
        add_finding(
            findings,
            "ERROR",
            "NO_CLAIMS",
            path,
            text,
            base_offset,
            "检测到权利要求书，但未识别到编号权利要求。",
        )
        return

    numbers = [number for number, _, _ in claims]
    expected = list(range(1, len(numbers) + 1))
    if numbers != expected:
        add_finding(
            findings,
            "ERROR",
            "CLAIM_NUMBERING",
            path,
            text,
            claims[0][2],
            f"权利要求编号应连续从1开始，实际为{numbers}。",
        )

    number_set = set(numbers)
    for number, content, offset in claims:
        if not content:
            add_finding(
                findings,
                "ERROR",
                "EMPTY_CLAIM",
                path,
                text,
                offset,
                f"权利要求{number}内容为空。",
            )
            continue

        if content.count("。") != 1 or not content.endswith("。"):
            add_finding(
                findings,
                "WARNING",
                "CLAIM_PERIOD",
                path,
                text,
                offset,
                f"权利要求{number}应仅在结尾使用一个句号。",
            )

        for ref_match in re.finditer(
            r"权利要求\s*([0-9、，,和或至到\-—~～\s]+)", content
        ):
            referenced = [int(value) for value in re.findall(r"\d+", ref_match.group(1))]
            for ref in referenced:
                if ref not in number_set:
                    add_finding(
                        findings,
                        "ERROR",
                        "MISSING_CLAIM_REFERENCE",
                        path,
                        text,
                        offset + ref_match.start(),
                        f"权利要求{number}引用了不存在的权利要求{ref}。",
                    )
                elif ref >= number:
                    add_finding(
                        findings,
                        "ERROR",
                        "FORWARD_CLAIM_REFERENCE",
                        path,
                        text,
                        offset + ref_match.start(),
                        f"权利要求{number}引用了自身或在后的权利要求{ref}。",
                    )


def audit_sections(
    files: list[Path], contents: dict[Path, str], findings: list[Finding]
) -> None:
    formal_text = "\n".join(contents.values())
    if not formal_text:
        return

    has_specification = any(
        has_heading(formal_text, section) for section in REQUIRED_SPEC_SECTIONS
    )
    if not has_specification:
        return

    for section in REQUIRED_SPEC_SECTIONS:
        if not has_heading(formal_text, section):
            findings.append(
                Finding(
                    "WARNING",
                    "MISSING_SECTION",
                    str(files[0]),
                    1,
                    f"正式申请文件中未发现说明书章节：{section}",
                )
            )

    names = [path.stem for path in files]
    components = (
        ("权利要求书", "MISSING_CLAIMS_COMPONENT"),
        ("说明书摘要", "MISSING_ABSTRACT_COMPONENT"),
    )
    for component, code in components:
        if not has_heading(formal_text, component) and not any(
            component in name for name in names
        ):
            findings.append(
                Finding(
                    "WARNING",
                    code,
                    str(files[0]),
                    1,
                    f"正式申请文件中未发现：{component}",
                )
            )


def main() -> int:
    args = parse_args()
    try:
        files = collect_files(args.paths)
    except FileNotFoundError as exc:
        print(f"ERROR: 路径不存在：{exc}", file=sys.stderr)
        return 2

    if not files:
        print("ERROR: 未找到.md或.txt正式申请文件。", file=sys.stderr)
        return 2

    findings: list[Finding] = []
    contents: dict[Path, str] = {}
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            findings.append(
                Finding("ERROR", "READ_ERROR", str(path), 1, "文件不是有效的UTF-8文本。")
            )
            continue
        contents[path] = text
        audit_claims(path, text, findings)

    audit_sections(files, contents, findings)
    findings.sort(
        key=lambda item: (item.severity != "ERROR", item.file, item.line, item.code)
    )

    errors = sum(item.severity == "ERROR" for item in findings)
    warnings = sum(item.severity == "WARNING" for item in findings)
    if args.json:
        print(
            json.dumps(
                {
                    "files_checked": len(files),
                    "errors": errors,
                    "warnings": warnings,
                    "findings": [asdict(item) for item in findings],
                    "scope_note": "仅检查确定性格式；内容质量由模型全文复核。",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for item in findings:
            print(
                f"{item.severity} {item.code} {item.file}:{item.line} {item.message}"
            )
        print(f"Checked {len(files)} file(s): {errors} error(s), {warnings} warning(s).")
        print("Scope: deterministic formatting only; model full-text review is required.")

    if errors or (args.fail_on_warning and warnings):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
