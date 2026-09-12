#!/usr/bin/env python3
"""Audit declared semantic and scope deltas in a patent revision ledger."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


REQUIRED_COLUMNS = [
    "change_id",
    "location",
    "before",
    "after",
    "change_level",
    "added_relations",
    "removed_relations",
    "scope_effect",
    "authorization",
    "source_basis",
    "status",
]
ALLOWED_LEVELS = {"A", "B", "C"}
ALLOWED_SCOPE_EFFECTS = {"none", "narrowed", "broadened", "uncertain"}
ALLOWED_STATUSES = {"confirmed", "awaiting-confirmation", "blocked"}
RELATION_TERMS = (
    "设置于",
    "设置在",
    "位于",
    "固定于",
    "固定在",
    "连接于",
    "密封连接",
    "连通",
    "导向",
    "限位",
    "防脱",
    "抗转",
    "驱动",
    "传递",
    "承受",
    "先于",
    "随后",
    "保持",
)


@dataclass(frozen=True)
class Finding:
    severity: str
    code: str
    row: int
    message: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit a revision semantic-delta CSV.")
    parser.add_argument("ledger", help="Revision semantic-delta CSV")
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    return parser.parse_args()


def is_none(value: str) -> bool:
    normalized = value.strip()
    return normalized.lower() == "none" or bool(
        re.fullmatch(r"N/A\s*[:：]\s*\S+", normalized, re.I)
    )


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

    seen_ids: set[str] = set()
    for row_number, row in enumerate(rows, start=2):
        change_id = (row.get("change_id") or "").strip()
        location = (row.get("location") or "").strip()
        before = (row.get("before") or "").strip()
        after = (row.get("after") or "").strip()
        level = (row.get("change_level") or "").strip().upper()
        added = (row.get("added_relations") or "").strip()
        removed = (row.get("removed_relations") or "").strip()
        scope_effect = (row.get("scope_effect") or "").strip()
        authorization = (row.get("authorization") or "").strip()
        source_basis = (row.get("source_basis") or "").strip()
        status = (row.get("status") or "").strip()

        for column, value in (
            ("change_id", change_id),
            ("location", location),
            ("before", before),
            ("after", after),
            ("added_relations", added),
            ("removed_relations", removed),
            ("authorization", authorization),
            ("source_basis", source_basis),
        ):
            if not value:
                findings.append(
                    Finding("ERROR", "MISSING_VALUE", row_number, f"{column}为空。")
                )
        if change_id in seen_ids:
            findings.append(
                Finding("ERROR", "DUPLICATE_CHANGE_ID", row_number, f"修改编号重复：{change_id}")
            )
        seen_ids.add(change_id)

        if level not in ALLOWED_LEVELS:
            findings.append(
                Finding(
                    "ERROR",
                    "INVALID_CHANGE_LEVEL",
                    row_number,
                    "change_level必须为A、B或C。",
                )
            )
        if scope_effect not in ALLOWED_SCOPE_EFFECTS:
            findings.append(
                Finding(
                    "ERROR",
                    "INVALID_SCOPE_EFFECT",
                    row_number,
                    f"scope_effect必须为：{', '.join(sorted(ALLOWED_SCOPE_EFFECTS))}。",
                )
            )
        if status not in ALLOWED_STATUSES:
            findings.append(
                Finding(
                    "ERROR",
                    "INVALID_STATUS",
                    row_number,
                    f"status必须为：{', '.join(sorted(ALLOWED_STATUSES))}。",
                )
            )

        relation_changed = not is_none(added) or not is_none(removed)
        if level in {"A", "B"} and relation_changed:
            findings.append(
                Finding(
                    "ERROR",
                    "RELATION_CHANGE_REQUIRES_C",
                    row_number,
                    "新增或删除技术关系不能作为A级或B级修改，须按C级确认。",
                )
            )
        if level in {"A", "B"} and scope_effect in {"narrowed", "broadened", "uncertain"}:
            findings.append(
                Finding(
                    "ERROR",
                    "SCOPE_EFFECT_REQUIRES_C",
                    row_number,
                    "保护范围发生变化或无法确定时，须按C级修改。",
                )
            )
        if level == "C" and authorization != "confirmed":
            findings.append(
                Finding(
                    "ERROR",
                    "UNCONFIRMED_C_CHANGE",
                    row_number,
                    "C级修改必须具有confirmed授权记录。",
                )
            )
        if status == "confirmed" and level == "C" and authorization != "confirmed":
            findings.append(
                Finding(
                    "ERROR",
                    "CONFIRMED_WITHOUT_AUTHORIZATION",
                    row_number,
                    "修改状态不能在缺少C级授权时标记为confirmed。",
                )
            )
        if before == after and before:
            findings.append(
                Finding("WARNING", "NO_TEXT_DELTA", row_number, "修改前后文本相同。")
            )

        automatically_added = [
            term for term in RELATION_TERMS if term in after and term not in before
        ]
        for term in automatically_added:
            if is_none(added) or term not in added:
                findings.append(
                    Finding(
                        "WARNING",
                        "UNDECLARED_RELATION_TERM",
                        row_number,
                        f"修改后新增关系词“{term}”，但added_relations未明确记录。",
                    )
                )

    if not rows:
        findings.append(Finding("ERROR", "EMPTY_LEDGER", 1, "语义增量台账没有记录。"))
    return findings, len(rows)


def main() -> int:
    args = parse_args()
    path = Path(args.ledger).expanduser().resolve()
    if not path.is_file():
        print(f"ERROR: 文件不存在：{path}", file=sys.stderr)
        return 2
    findings, rows = audit(path)
    errors = sum(item.severity == "ERROR" for item in findings)
    warnings = sum(item.severity == "WARNING" for item in findings)
    result = {
        "rows_checked": rows,
        "errors": errors,
        "warnings": warnings,
        "findings": [asdict(item) for item in findings],
        "scope_note": "仅检查已声明语义变化、权限和若干精确关系词；保护范围和原始支持仍须全文人工判断。",
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for item in findings:
            print(f"{item.severity} {item.code} row={item.row} {item.message}")
        print(f"Checked {rows} change row(s): {errors} error(s), {warnings} warning(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
