#!/usr/bin/env python3
"""Audit a structured claim-element dependency and antecedent ledger."""

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
    "depends_on",
    "element",
    "element_role",
    "antecedent_claim",
    "wording",
    "relation_change",
    "notes",
]
ALLOWED_ROLES = {"new", "inherited", "reintroduced", "uncertain"}
ALLOWED_RELATION_CHANGES = {"none", "added", "removed", "changed", "uncertain"}


@dataclass(frozen=True)
class Finding:
    severity: str
    code: str
    row: int
    message: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit a claim-element dependency and antecedent CSV ledger."
    )
    parser.add_argument("ledger", help="Claim element ledger CSV")
    parser.add_argument("--json", action="store_true", help="Emit JSON")
    return parser.parse_args()


def parse_claim_numbers(value: str) -> tuple[list[int], bool]:
    value = value.strip()
    if not value:
        return [], True
    parts = [item for item in re.split(r"[、，,;；/\s]+", value) if item]
    if not all(re.fullmatch(r"\d+", item) for item in parts):
        return [], False
    return [int(item) for item in parts], True


def ancestors(claim: int, parents: dict[int, set[int]]) -> set[int]:
    result: set[int] = set()
    pending = list(parents.get(claim, set()))
    while pending:
        parent = pending.pop()
        if parent in result:
            continue
        result.add(parent)
        pending.extend(parents.get(parent, set()))
    return result


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

    parents: dict[int, set[int]] = {}
    parsed_rows: list[tuple[int, dict[str, str], int, list[int]]] = []
    for row_number, row in enumerate(rows, start=2):
        raw_claim = (row.get("claim_id") or "").strip()
        if not re.fullmatch(r"\d+", raw_claim):
            findings.append(
                Finding("ERROR", "INVALID_CLAIM_ID", row_number, "claim_id必须为正整数。")
            )
            continue
        claim = int(raw_claim)
        raw_parents = (row.get("depends_on") or "").strip()
        claim_parents, valid_parents = parse_claim_numbers(raw_parents)
        if not valid_parents:
            findings.append(
                Finding(
                    "ERROR",
                    "INVALID_DEPENDENCY",
                    row_number,
                    "depends_on只能填写在前权利要求编号，多个编号用逗号分隔。",
                )
            )
            claim_parents = []
        for parent in claim_parents:
            if parent >= claim:
                findings.append(
                    Finding(
                        "ERROR",
                        "FORWARD_DEPENDENCY",
                        row_number,
                        f"权利要求{claim}不能引用自身或在后的权利要求{parent}。",
                    )
                )
        previous = parents.setdefault(claim, set(claim_parents))
        if previous != set(claim_parents):
            findings.append(
                Finding(
                    "ERROR",
                    "INCONSISTENT_DEPENDENCY",
                    row_number,
                    f"权利要求{claim}在不同台账行使用了不一致的depends_on。",
                )
            )
        parsed_rows.append((row_number, row, claim, claim_parents))

    element_claims: dict[str, set[int]] = {}
    for _, row, claim, _ in parsed_rows:
        element = (row.get("element") or "").strip()
        if element:
            element_claims.setdefault(element, set()).add(claim)

    for row_number, row, claim, _ in parsed_rows:
        element = (row.get("element") or "").strip()
        role = (row.get("element_role") or "").strip()
        wording = (row.get("wording") or "").strip()
        relation_change = (row.get("relation_change") or "").strip()
        antecedent_raw = (row.get("antecedent_claim") or "").strip()

        if not element:
            findings.append(
                Finding("ERROR", "MISSING_ELEMENT", row_number, "技术对象element为空。")
            )
        if not wording:
            findings.append(
                Finding("ERROR", "MISSING_WORDING", row_number, "未记录权利要求实际措辞。")
            )
        if role not in ALLOWED_ROLES:
            findings.append(
                Finding(
                    "ERROR",
                    "INVALID_ELEMENT_ROLE",
                    row_number,
                    f"element_role必须为：{', '.join(sorted(ALLOWED_ROLES))}。",
                )
            )
            continue
        if relation_change not in ALLOWED_RELATION_CHANGES:
            findings.append(
                Finding(
                    "ERROR",
                    "INVALID_RELATION_CHANGE",
                    row_number,
                    f"relation_change必须为：{', '.join(sorted(ALLOWED_RELATION_CHANGES))}。",
                )
            )
        elif relation_change != "none":
            findings.append(
                Finding(
                    "WARNING",
                    "RELATION_CHANGE_REVIEW_REQUIRED",
                    row_number,
                    "本行声明关系发生变化，须进入语义增量和保护范围复核。",
                )
            )

        if role == "new":
            if antecedent_raw:
                findings.append(
                    Finding(
                        "ERROR",
                        "NEW_ELEMENT_HAS_ANTECEDENT",
                        row_number,
                        "首次引入的技术对象不应填写antecedent_claim。",
                    )
                )
            if "所述" in wording:
                findings.append(
                    Finding(
                        "WARNING",
                        "NEW_WITH_DEFINITE_REFERENCE",
                        row_number,
                        "首次引入措辞包含“所述”，请核对是否缺少前置基础。",
                    )
                )
            continue

        if role == "uncertain":
            findings.append(
                Finding(
                    "WARNING",
                    "UNCERTAIN_ELEMENT_IDENTITY",
                    row_number,
                    "无法确定是否为同一技术对象，须结合全文和附图人工确认。",
                )
            )
            continue

        if not re.fullmatch(r"\d+", antecedent_raw):
            findings.append(
                Finding(
                    "ERROR",
                    "MISSING_ANTECEDENT_CLAIM",
                    row_number,
                    "继承或重复引入的技术对象必须填写antecedent_claim。",
                )
            )
            continue
        antecedent = int(antecedent_raw)
        path_ancestors = ancestors(claim, parents)
        if antecedent not in path_ancestors:
            findings.append(
                Finding(
                    "ERROR",
                    "ANTECEDENT_OUTSIDE_DEPENDENCY_PATH",
                    row_number,
                    f"权利要求{antecedent}不在权利要求{claim}的实际依赖路径上。",
                )
            )
        if antecedent not in element_claims.get(element, set()):
            findings.append(
                Finding(
                    "ERROR",
                    "ELEMENT_NOT_FOUND_IN_ANTECEDENT",
                    row_number,
                    f"未在权利要求{antecedent}的台账行中找到同名技术对象“{element}”。",
                )
            )
        if "所述" not in wording:
            findings.append(
                Finding(
                    "WARNING",
                    "POSSIBLE_MISSING_DEFINITE_REFERENCE",
                    row_number,
                    "继承对象的措辞未包含“所述”；请人工核对回指是否仍然唯一。",
                )
            )
        if role == "reintroduced":
            findings.append(
                Finding(
                    "WARNING",
                    "REINTRODUCED_ELEMENT",
                    row_number,
                    "已继承的技术对象被再次作为新对象引入，可能造成对象数量或指代不清。",
                )
            )

    if not rows:
        findings.append(Finding("ERROR", "EMPTY_LEDGER", 1, "权利要求要素台账没有记录。"))
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
        "scope_note": "仅审计结构化要素台账和依赖路径；对象同一性、必要特征及保护范围须人工复核。",
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for item in findings:
            print(f"{item.severity} {item.code} row={item.row} {item.message}")
        print(f"Checked {rows} ledger row(s): {errors} error(s), {warnings} warning(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
