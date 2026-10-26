#!/usr/bin/env python3
"""Replace the E2E edge-allow token with a placeholder in Playwright output before upload.

Traces and HTML-report data record request headers verbatim, and the report artifact is
readable by anyone who can read this repo. Zips are scrubbed recursively, and the HTML
report's inline base64 zip is decoded, scrubbed and re-encoded. Fails closed: exits non-zero
if any archive cannot be parsed or any form of the token survives, and the workflow skips
every upload and ingest step in that case.

Usage: scrub-e2e-token.py <dir-or-file>...   (token from E2E_WAF_BYPASS_TOKEN; unset = no-op)
"""
import base64
import io
import os
import re
import sys
import urllib.parse
import zipfile
from pathlib import Path

PLACEHOLDER = b"[scrubbed]"
MEDIA = {".webm", ".png", ".jpg", ".mp4"}
B64_BLOB = re.compile(rb"data:application/zip;base64,([A-Za-z0-9+/=]+)")


def scrub_zip_bytes(data, token):
    with zipfile.ZipFile(io.BytesIO(data)) as src:
        items = [(info, src.read(info.filename)) for info in src.infolist()]
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for info, body in items:
            dst.writestr(info, scrub_bytes(info.filename, body, token))
    return out.getvalue()


def scrub_bytes(name, data, token):
    if data[:2] == b"PK":
        return scrub_zip_bytes(data, token)
    if name.endswith((".html", ".htm")):
        data = B64_BLOB.sub(
            lambda m: b"data:application/zip;base64,"
            + base64.b64encode(scrub_zip_bytes(base64.b64decode(m.group(1)), token)),
            data,
        )
    return data.replace(token, PLACEHOLDER)


def leaked(data, token):
    forms = {token, urllib.parse.quote(token.decode(), safe="").encode()}
    for shift in range(3):
        forms.add(base64.b64encode(b"x" * shift + token)[4:-4])
    return any(f in data for f in forms)


def main(paths):
    token = os.environ.get("E2E_WAF_BYPASS_TOKEN", "").encode()
    if not token:
        return 0
    failures = []
    for root in map(Path, paths):
        files = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]
        for f in files:
            if f.suffix in MEDIA:
                continue
            try:
                data = f.read_bytes()
                cleaned = scrub_bytes(f.name, data, token)
                if cleaned != data:
                    f.write_bytes(cleaned)
                if leaked(cleaned, token):
                    failures.append(f"{f}: token form survives")
            except Exception as exc:  # fail closed on anything unparseable
                failures.append(f"{f}: {exc}")
    for line in failures:
        print(f"::error::scrub failed: {line}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
