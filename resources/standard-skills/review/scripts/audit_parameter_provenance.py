#!/usr/bin/env python3
"""Audit traceability of claim parameter ranges and exact values."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


REQUIRED_COLUMNS = [
    "claim_id",
    "parameter",
    "proposed_value",
    "lower_source",
    "upper_source",
    "complete_combination_source",
    "test_condition",
    "mosaic_risk",
    "status",
]
ALLOWED_STATUS = {"confirmed", "awaiting-applicant-confirmation", "unsupported"}


@dataclass(frozen=True)
class Finding:
    severity: str
    code: str
    row: int
    message: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit claim parameter provenance CSV.")
    parser.add_argument("matrix", help="Parameter provenance CSV")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def looks_like_range(value: str) -> bool:
    return bool(re.search(r"\d\s*(?:-|–|—|~|～|至)\s*\d", value))


def audit(path: Path) -> tuple[list[Finding], int]:
    findings: list[Finding] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames or []
        for column in REQUIRED_COLUMNS:
            if column not in headers:
                findings.append(Finding("ERROR", "MISSING_COLUMN", 1, f"缺少必需列：{column}"))
        if findings:
            return findings, 0

        count = 0
        for row_number, row in enumerate(reader, start=2):
            count += 1
            for column in ("claim_id", "parameter", "proposed_value", "complete_combination_source"):
                if not (row.get(column) or "").strip():
                    findings.append(
                        Finding("ERROR", "MISSING_VALUE", row_number, f"{column}为空。")
                    )
            proposed = (row.get("proposed_value") or "").strip()
            lower = (row.get("lower_source") or "").strip()
            upper = (row.get("upper_source") or "").strip()
            if looks_like_range(proposed) and (not lower or not upper):
                findings.append(
                    Finding(
                        "ERROR",
                        "UNTRACED_RANGE_ENDPOINT",
                        row_number,
                        "范围参数的上下限均必须有原始支持来源。",
                    )
                )
            if not looks_like_range(proposed) and not (
                row.get("complete_combination_source") or ""
            ).strip():
                findings.append(
                    Finding(
                        "ERROR",
                        "UNTRACED_EXACT_VALUE",
                        row_number,
                        "确定值必须指向完整实际实施方式。",
                    )
                )
            mosaic = (row.get("mosaic_risk") or "").strip().lower()
            if mosaic not in {"yes", "no"}:
                findings.append(
                    Finding("ERROR", "INVALID_MOSAIC_FLAG", row_number, "mosaic_risk必须为yes或no。")
                )
            elif mosaic == "yes":
                findings.append(
                    Finding(
                        "ERROR",
                        "MOSAIC_COMBINATION_RISK",
                        row_number,
                        "不同实施例的端点或条件可能被拼接为未经整体公开的组合。",
                    )
                )
            status = (row.get("status") or "").strip()
            if status not in ALLOWED_STATUS:
                findings.append(
                    Finding(
                        "ERROR",
                        "INVALID_STATUS",
                        row_number,
                        f"status必须为：{', '.join(sorted(ALLOWED_STATUS))}。",
                    )
                )
            if status == "confirmed" and not (row.get("test_condition") or "").strip():
                findings.append(
                    Finding(
                        "WARNING",
                        "MISSING_TEST_CONDITION",
                        row_number,
                        "已确认参数缺少测试或适用条件；如该参数无需测试，应填写N/A及理由。",
                    )
                )
    if count == 0:
        findings.append(Finding("ERROR", "EMPTY_MATRIX", 1, "参数来源表没有记录。"))
    return findings, count


def main() -> int:
    args = parse_args()
    path = Path(args.matrix).expanduser().resolve()
    if not path.is_file():
        print(f"ERROR: 文件不存在：{path}", file=sys.stderr)
        return 2
    findings, rows = audit(path)
    errors = sum(item.severity == "ERROR" for item in findings)
    warnings = sum(item.severity == "WARNING" for item in findings)
    if args.json:
        print(
            json.dumps(
                {
                    "rows_checked": rows,
                    "errors": errors,
                    "warnings": warnings,
                    "findings": [asdict(item) for item in findings],
                    "scope_note": "仅检查参数来源记录的完整性，不判断原始公开范围或法律结论。",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for item in findings:
            print(f"{item.severity} {item.code} row={item.row} {item.message}")
        print(f"Checked {rows} parameter row(s): {errors} error(s), {warnings} warning(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
