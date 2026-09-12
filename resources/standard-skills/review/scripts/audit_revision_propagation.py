#!/usr/bin/env python3
"""Check that revised terms propagated across declared text artifacts."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit revision propagation manifest.")
    parser.add_argument("manifest", help="JSON manifest")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


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
    corpus: list[str] = []
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        findings.append({"code": "NO_FILES", "message": "清单未声明待检查文件。"})
        files = []
    for raw in files:
        path = (manifest_path.parent / str(raw)).resolve()
        if not path.is_file():
            findings.append({"code": "MISSING_FILE", "message": f"文件不存在：{path}"})
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            findings.append(
                {
                    "code": "NON_TEXT_FILE",
                    "message": f"不能直接检查非UTF-8文本：{path}；请先转换/OCR并将结果列入清单。",
                }
            )
            continue
        corpus.append(text)
        for term in manifest.get("forbidden_terms", []):
            if term and str(term) in text:
                findings.append(
                    {"code": "STALE_TERM", "message": f"{path}仍包含旧表述：{term}"}
                )

    joined = "\n".join(corpus)
    for term in manifest.get("required_terms", []):
        if term and str(term) not in joined:
            findings.append(
                {"code": "MISSING_REQUIRED_TERM", "message": f"全部声明文件中未发现新表述：{term}"}
            )

    result = {
        "files_declared": len(files),
        "errors": len(findings),
        "findings": findings,
        "scope_note": "仅检查清单声明的精确字符串；附图内文字须先OCR或人工核验。",
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for item in findings:
            print(f"ERROR {item['code']} {item['message']}")
        print(f"Checked {len(files)} declared file(s): {len(findings)} error(s).")
        print("Scope: exact-string propagation only; image text requires OCR/manual review.")
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
