#!/usr/bin/env python3
"""Validate patent version bundle membership, status, and SHA-256 hashes."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path


STATUSES = {
    "formal-source",
    "internal-record",
    "compiled-data",
    "awaiting-applicant-confirmation",
    "submission-ready",
}
ROLES = {"formal-source", "internal-record", "figure-asset", "output", "build-source"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit a patent version bundle JSON manifest.")
    parser.add_argument("manifest", help="Version manifest JSON")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    args = parse_args()
    manifest_path = Path(args.manifest).expanduser().resolve()
    if not manifest_path.is_file():
        print(f"ERROR: 清单不存在：{manifest_path}", file=sys.stderr)
        return 2
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: 无法读取JSON清单：{exc}", file=sys.stderr)
        return 2

    findings: list[dict[str, str]] = []
    status = manifest.get("status")
    if status not in STATUSES:
        findings.append({"code": "INVALID_STATUS", "message": f"无效版本状态：{status}"})
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        findings.append({"code": "NO_FILES", "message": "版本清单没有文件记录。"})
        files = []

    roles: set[str] = set()
    seen: set[Path] = set()
    for entry in files:
        if not isinstance(entry, dict):
            findings.append({"code": "INVALID_ENTRY", "message": "文件记录必须是对象。"})
            continue
        role = str(entry.get("role", ""))
        roles.add(role)
        if role not in ROLES:
            findings.append({"code": "INVALID_ROLE", "message": f"无效文件角色：{role}"})
        path = (manifest_path.parent / str(entry.get("path", ""))).resolve()
        if path in seen:
            findings.append({"code": "DUPLICATE_PATH", "message": f"重复文件：{path}"})
        seen.add(path)
        if not path.is_file():
            findings.append({"code": "MISSING_FILE", "message": f"文件不存在：{path}"})
            continue
        expected = str(entry.get("sha256", "")).lower()
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            findings.append({"code": "MISSING_HASH", "message": f"缺少有效SHA-256：{path}"})
            continue
        actual = sha256(path)
        if actual != expected:
            findings.append(
                {"code": "HASH_MISMATCH", "message": f"哈希不匹配：{path}，实际为{actual}"}
            )

    if "formal-source" not in roles:
        findings.append({"code": "NO_FORMAL_SOURCE", "message": "版本包缺少formal-source。"})
    if status == "submission-ready" and manifest.get("contains_compiled_data", False):
        findings.append(
            {
                "code": "COMPILED_DATA_NOT_CONFIRMED",
                "message": "含未确认编制数据的版本不能标记为submission-ready。",
            }
        )

    result = {
        "version": manifest.get("version"),
        "status": status,
        "files_declared": len(files),
        "errors": len(findings),
        "findings": findings,
        "scope_note": "仅检查版本成员、状态和文件完整性，不判断专利实质质量。",
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for item in findings:
            print(f"ERROR {item['code']} {item['message']}")
        print(f"Checked {len(files)} bundle file(s): {len(findings)} error(s).")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
