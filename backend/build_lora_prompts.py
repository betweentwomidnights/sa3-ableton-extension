#!/usr/bin/env python3
"""Build an SA3 prompt dice pool from a LoRA training caption folder."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys


_BPM_TAIL = re.compile(r"[,;]?\s*\d+(?:\.\d+)?\s*bpm.*$", re.IGNORECASE | re.DOTALL)


def prompt_from_caption(text: str) -> str:
    prompt = _BPM_TAIL.sub("", text).strip()
    return prompt.strip(" ,;\t\r\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True, help="LoRA registry name")
    parser.add_argument("--captions-dir", required=True, help="Folder with SA3 training .txt sidecars")
    parser.add_argument(
        "--out-dir",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts"),
        help="Prompt JSON output directory",
    )
    parser.add_argument("--bucket", default="instrumental", help="Prompt dice bucket")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing prompt JSON")
    args = parser.parse_args()

    if not os.path.isdir(args.captions_dir):
        sys.exit(f"captions-dir not found: {args.captions_dir}")

    os.makedirs(args.out_dir, exist_ok=True)
    out_path = os.path.join(args.out_dir, f"{args.name}.json")
    if os.path.exists(out_path) and not args.force:
        sys.exit(f"{out_path} exists; refusing to clobber curated prompts (use --force)")

    seen = set()
    prompts: list[str] = []
    txts = sorted(filename for filename in os.listdir(args.captions_dir) if filename.endswith(".txt"))
    for filename in txts:
        with open(os.path.join(args.captions_dir, filename), encoding="utf-8") as handle:
            prompt = prompt_from_caption(handle.read())
        if not prompt:
            continue
        key = prompt.lower()
        if key in seen:
            continue
        seen.add(key)
        prompts.append(prompt)

    payload = {
        "version": 1,
        "source": {
            "lora": args.name,
            "captions_dir": args.captions_dir,
            "files": len(txts),
            "unique_prompts": len(prompts),
        },
        "dice": {args.bucket: prompts},
    }
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(
        f"wrote {out_path}: {len(prompts)} unique prompts from {len(txts)} captions "
        f"-> dice.{args.bucket}"
    )
    if prompts:
        suffix = " ..." if len(prompts) > 12 else ""
        print("  " + " | ".join(prompts[:12]) + suffix)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
