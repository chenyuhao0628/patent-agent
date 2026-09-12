#!/usr/bin/env python3
"""Audit a structured claim/specification/flowchart method-step crosswalk."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


REQUIRED_COLUMNS = [
    "step_id",
    "claim_text",
    "spec_text",
    "figure_text",
    "pre_state",
    "post_state",
    "prerequisites",
    "status",
    "notes",
]
ALLOWED_STATUS = {
    "aligned",
    "meaning-difference",
    "order-conflict",
    "missing",
    "awaiting-confirmation",
}


@dataclass(frozen=True)
class Finding:
    severity: str
    code: str
    row: int
    message: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit a method-step crosswalk CSV.")
    parser.add_argument("crosswalk", help="Method-step crosswalk CSV")
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    return parser.parse_args()


def filled_or_na(value: str) -> bool:
    value = value.strip()
    if not value:
        return False
    if value.upper().startswith("N/A"):
        return bool(re.search(r"[:：]\s*\S", value))
    return True


def audit(path: Path) -> tuple[list[Finding], int]:
    findings: list[Finding] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames or []
        for column in REQUIRED_COLUMNS:
            if column not in headers:
                findings.append(
                    Finding("ERROR", "MISSING_COLUMN", 1, f"缺少必需列：{column}")
                )
        if findings:
            return findings, 0
        rows = list(reader)

    step_numbers: list[int] = []
    seen: set[int] = set()
    for row_number, row in enumerate(rows, start=2):
        step_id = (row.get("step_id") or "").strip().upper()
        match = re.fullmatch(r"S(\d+)", step_id)
        if not match:
            findings.append(
                Finding("ERROR", "INVALID_STEP_ID", row_number, "step_id必须使用S1、S2等格式。")
            )
        else:
            number = int(match.group(1))
            step_numbers.append(number)
            if number in seen:
                findings.append(
                    Finding("ERROR", "DUPLICATE_STEP_ID", row_number, f"步骤编号重复：S{number}")
                )
            seen.add(number)

        for column in (
            "claim_text",
            "spec_text",
            "figure_text",
            "pre_state",
            "post_state",
            "prerequisites",
        ):
            if not filled_or_na(row.get(column) or ""):
                findings.append(
                    Finding(
                        "ERROR",
                        "INCOMPLETE_STEP_CELL",
                        row_number,
                        f"{column}为空，或N/A没有填写理由。",
                    )
                )

        status = (row.get("status") or "").strip()
        if status not in ALLOWED_STATUS:
            findings.append(
                Finding(
                    "ERROR",
                    "INVALID_ALIGNMENT_STATUS",
                    row_number,
                    f"status必须为：{', '.join(sorted(ALLOWED_STATUS))}。",
                )
            )
        elif status != "aligned":
            findings.append(
                Finding(
                    "ERROR",
                    "UNRESOLVED_STEP_CONFLICT",
                    row_number,
                    f"步骤对照尚未闭合：{status}。",
                )
            )

    if rows and step_numbers:
        expected = list(range(1, len(step_numbers) + 1))
        if step_numbers != expected:
            findings.append(
                Finding(
                    "ERROR",
                    "NON_SEQUENTIAL_STEPS",
                    2,
                    f"步骤应按S1连续排列，实际为：{step_numbers}。",
                )
            )
    if not rows:
        findings.append(Finding("ERROR", "EMPTY_CROSSWALK", 1, "方法步骤对照表没有记录。"))
    return findings, len(rows)


def main() -> int:
    args = parse_args()
    path = Path(args.crosswalk).expanduser().resolve()
    if not path.is_file():
        print(f"ERROR: 文件不存在：{path}", file=sys.stderr)
        return 2
    findings, rows = audit(path)
    errors = sum(item.severity == "ERROR" for item in findings)
    result = {
        "rows_checked": rows,
        "errors": errors,
        "findings": [asdict(item) for item in findings],
        "scope_note": "仅检查步骤编号、栏目完整性和已声明冲突；不自动判断步骤语义等同或安全性。",
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for item in findings:
            print(f"{item.severity} {item.code} row={item.row} {item.message}")
        print(f"Checked {rows} step row(s): {errors} error(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
