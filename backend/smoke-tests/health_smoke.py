#!/usr/bin/env python3
"""Check that the SA3 backend is reachable without loading the model."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def request_json(url: str, timeout: int = 10) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(text)
        except ValueError:
            payload = {"error": text}
        payload["http_status"] = exc.code
        return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8006")
    args = parser.parse_args()

    health = request_json(f"{args.base_url.rstrip('/')}/health")
    print(json.dumps(health, indent=2, sort_keys=True))

    if health.get("status") != "healthy":
        print("backend did not report healthy status", file=sys.stderr)
        return 1

    runtime_errors = health.get("runtime_import_errors") or {}
    if runtime_errors:
        print(
            "backend is reachable; full SA3 runtime is not installed yet: "
            + ", ".join(sorted(runtime_errors)),
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
