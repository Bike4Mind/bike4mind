#!/usr/bin/env python3
"""Replace the E2E edge-allow token with a placeholder in Playwright output before upload.

Traces and HTML-report data record request headers verbatim, and the report artifact is
readable by anyone who can read this repo. Usage: scrub-e2e-token.py <dir-or-file>...
The token comes from E2E_WAF_BYPASS_TOKEN; with no token set this is a no-op.
"""
import os
import sys
import zipfile
from pathlib import Path

PLACEHOLDER = b"[scrubbed]"


def scrub_bytes(data, token):
    return data.replace(token, PLACEHOLDER)


def scrub_zip(path, token):
    with zipfile.ZipFile(path) as src:
        items = [(info, src.read(info.filename)) for info in src.infolist()]
    if not any(token in data for _, data in items):
        return
    tmp = path.with_suffix(path.suffix + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
        for info, data in items:
            dst.writestr(info, scrub_bytes(data, token))
    tmp.replace(path)


def scrub_file(path, token):
    if path.suffix == ".zip":
        scrub_zip(path, token)
        return
    data = path.read_bytes()
    if token in data:
        path.write_bytes(scrub_bytes(data, token))


def main(paths):
    token = os.environ.get("E2E_WAF_BYPASS_TOKEN", "").encode()
    if not token:
        return 0
    for root in map(Path, paths):
        files = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]
        for f in files:
            if f.suffix in {".webm", ".png", ".jpg", ".mp4"}:
                continue
            scrub_file(f, token)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
