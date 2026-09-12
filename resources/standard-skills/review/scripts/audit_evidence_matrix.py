#!/usr/bin/env python3
"""Audit a structured embodiment/comparative-example evidence matrix."""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


ID_COLUMNS = {"sample_id", "sample_type"}
EVIDENCE_COLUMNS = [
    "composition_or_structure",
    "process",
    "mechanical_or_primary_performance",
    "microstructure_or_morphology",
    "dimension_or_residual_stress",
    "time_or_energy",
]
REQUIRED_COLUMNS = [*ID_COLUMNS, *EVIDENCE_COLUMNS, "proof_purpose"]


@dataclass(frozen=True)
class Finding:
    severity: str
    code: str
    row: int
    column: str
    message: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit a patent evidence coverage CSV.")
    parser.add_argument("matrix", help="Evidence matrix CSV")
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    return parser.parse_args()


def validate_cell(value: str) -> str | None:
    value = value.strip()
    if not value:
        return "单元格为空；必须填写数据/位置、同X、N/A：理由或缺失：P级。"
    if re.fullmatch(r"N/?A", value, re.I):
        return "N/A必须附具体理由。"
    if value.upper().startswith("N/A") and not re.search(r"[:：]\s*\S", value):
        return "N/A必须使用“N/A：理由”。"
    if value.startswith("同") and len(value) <= 1:
        return "“同”必须指明具体实施例或对比例。"
    if value.startswith("缺失") and not re.search(r"P[0-3]", value, re.I):
        return "缺失项必须标注P0至P3风险级别。"
    return None


def audit(path: Path) -> tuple[list[Finding], int]:
    findings: list[Finding] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames or []
        for column in REQUIRED_COLUMNS:
            if column not in headers:
                findings.append(
                    Finding("ERROR", "MISSING_COLUMN", 1, column, f"缺少必需列：{column}")
                )
        if findings:
            return findings, 0

        seen: set[str] = set()
        count = 0
        for line_number, row in enumerate(reader, start=2):
            count += 1
            sample_id = (row.get("sample_id") or "").strip()
            sample_type = (row.get("sample_type") or "").strip()
            if not sample_id:
                findings.append(
                    Finding("ERROR", "MISSING_SAMPLE_ID", line_number, "sample_id", "样品编号为空。")
                )
            elif sample_id in seen:
                findings.append(
                    Finding("ERROR", "DUPLICATE_SAMPLE_ID", line_number, "sample_id", f"样品编号重复：{sample_id}")
                )
            seen.add(sample_id)
            if sample_type not in {"实施例", "对比例", "实验组", "其他"}:
                findings.append(
                    Finding(
                        "ERROR",
                        "INVALID_SAMPLE_TYPE",
                        line_number,
                        "sample_type",
                        "样品类型必须为实施例、对比例、实验组或其他。",
                    )
                )
            for column in EVIDENCE_COLUMNS:
                problem = validate_cell(row.get(column) or "")
                if problem:
                    findings.append(
                        Finding("ERROR", "INCOMPLETE_EVIDENCE_CELL", line_number, column, problem)
                    )
            if not (row.get("proof_purpose") or "").strip():
                findings.append(
                    Finding(
                        "ERROR",
                        "MISSING_PROOF_PURPOSE",
                        line_number,
                        "proof_purpose",
                        "未说明该样品的证明目的。",
                    )
                )
    if count == 0:
        findings.append(Finding("ERROR", "EMPTY_MATRIX", 1, "", "证据矩阵没有样品行。"))
    return findings, count


def main() -> int:
    args = parse_args()
    path = Path(args.matrix).expanduser().resolve()
    if not path.is_file():
        print(f"ERROR: 文件不存在：{path}", file=sys.stderr)
        return 2
    findings, rows = audit(path)
    if args.json:
        print(
            json.dumps(
                {
                    "rows_checked": rows,
                    "errors": len(findings),
                    "findings": [asdict(item) for item in findings],
                    "scope_note": "仅检查结构化证据覆盖完整性，不判断技术真实性或创造性。",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for item in findings:
            print(f"{item.severity} {item.code} row={item.row} column={item.column} {item.message}")
        print(f"Checked {rows} sample row(s): {len(findings)} error(s).")
        print("Scope: structured evidence coverage only.")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
