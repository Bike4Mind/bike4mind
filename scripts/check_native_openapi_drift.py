"""Reports how far the native clients' committed OpenAPI snapshots have fallen behind the server spec.

A snapshot is the server spec after the client's own `strip_overlay_literals.py` (the first step of its
`make generate-client`), so "matches" is decided by running that exact script on a copy of the server
spec and comparing the bytes. Nothing here re-derives the stripping rules.

Advisory by design: drift is reported as markdown on stdout and the exit code stays 0. Exit 2 means the
check itself could not run (unreadable spec, stripping failed), which the workflow surfaces as a warning.
A client whose directory is absent from the checkout is skipped with a note.

Usage: python3 -I scripts/check_native_openapi_drift.py [--repo-root DIR] [--server-spec PATH]
"""

import argparse
import json
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

MARKER = "<!-- native-openapi-drift -->"
HTTP_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
MAX_LISTED = 25


@dataclass(frozen=True)
class NativeClient:
    name: str
    snapshot: str
    strip_script: str
    regenerate: str


CLIENTS = (
    NativeClient(
        "iOS",
        "apps/ios/Packages/B4MClient/openapi.json",
        "apps/ios/Packages/B4MClient/Scripts/strip_overlay_literals.py",
        "cd apps/ios && make generate-client SPEC_REF=origin/main",
    ),
    NativeClient(
        "Android",
        "apps/android/client/openapi.json",
        "apps/android/client/scripts/strip_overlay_literals.py",
        "cd apps/android && make generate-client SPEC_REF=origin/main",
    ),
)


def strip_like_client(client, server_spec, root, workdir):
    """Returns the server spec as the client's generate-client would store it."""
    copy = workdir / f"{client.name.lower()}-expected.json"
    copy.write_bytes(server_spec.read_bytes())
    subprocess.run(
        [
            sys.executable,
            "-I",
            str(root / client.strip_script),
            str(copy),
            str(root / "scripts/check-no-overlay-literals.sh"),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return copy


def operations(spec):
    found = {}
    for path, item in (spec.get("paths") or {}).items():
        for method in HTTP_METHODS:
            if method in item:
                found[f"{method.upper()} {path}"] = item[method]
    return found


def property_names(schema):
    props = schema.get("properties") if isinstance(schema, dict) else None
    return set(props) if isinstance(props, dict) else set()


def required_names(schema):
    required = schema.get("required") if isinstance(schema, dict) else None
    return set(required) if isinstance(required, list) else set()


def describe_schema_change(old, new):
    parts = []
    added = sorted(property_names(new) - property_names(old))
    removed = sorted(property_names(old) - property_names(new))
    newly_required = sorted(required_names(new) - required_names(old))
    if added:
        parts.append("added " + ", ".join(f"`{n}`" for n in added))
    if removed:
        parts.append("removed " + ", ".join(f"`{n}`" for n in removed))
    if newly_required:
        parts.append("now required " + ", ".join(f"`{n}`" for n in newly_required))
    return "; ".join(parts) or "other change"


def listed(items):
    shown = [f"- {item}" for item in items[:MAX_LISTED]]
    if len(items) > MAX_LISTED:
        shown.append(f"- ... and {len(items) - MAX_LISTED} more")
    return shown


def summarize(snapshot_spec, expected_spec):
    """Per-section drift lines, from the snapshot's point of view (old = snapshot, new = server)."""
    lines = []
    old_ops, new_ops = operations(snapshot_spec), operations(expected_spec)
    sections = (
        ("Operations in the server spec but not the snapshot", [f"`{k}`" for k in sorted(set(new_ops) - set(old_ops))]),
        ("Operations in the snapshot but gone from the server spec", [f"`{k}`" for k in sorted(set(old_ops) - set(new_ops))]),
        ("Operations whose definition changed", [f"`{k}`" for k in sorted(k for k in set(old_ops) & set(new_ops) if old_ops[k] != new_ops[k])]),
    )
    old_schemas = (snapshot_spec.get("components") or {}).get("schemas") or {}
    new_schemas = (expected_spec.get("components") or {}).get("schemas") or {}
    changed_schemas = [
        f"`{k}`: {describe_schema_change(old_schemas[k], new_schemas[k])}"
        for k in sorted(set(old_schemas) & set(new_schemas))
        if old_schemas[k] != new_schemas[k]
    ]
    sections += (
        ("Schemas in the server spec but not the snapshot", [f"`{k}`" for k in sorted(set(new_schemas) - set(old_schemas))]),
        ("Schemas in the snapshot but gone from the server spec", [f"`{k}`" for k in sorted(set(old_schemas) - set(new_schemas))]),
        ("Schemas whose definition changed", changed_schemas),
    )
    for title, items in sections:
        if items:
            lines += [f"{title} ({len(items)}):", *listed(items), ""]
    return lines


def check_client(client, server_spec, root, workdir):
    """Returns (status, markdown lines). status is one of: skipped, in-sync, drifted."""
    if not (root / client.snapshot).is_file():
        return "skipped", [f"Skipped: `{client.snapshot}` is not in this checkout."]
    expected = strip_like_client(client, server_spec, root, workdir)
    snapshot = root / client.snapshot
    if expected.read_bytes() == snapshot.read_bytes():
        return "in-sync", ["In sync with the server spec."]
    lines = summarize(json.loads(snapshot.read_text("utf-8")), json.loads(expected.read_text("utf-8")))
    lines += ["To refresh the snapshot and the generated client:", "", "```bash", client.regenerate, "```"]
    return "drifted", lines


def build_report(results):
    drifted = [name for name, (status, _) in results if status == "drifted"]
    if drifted:
        headline = "The server OpenAPI spec has moved on from: " + ", ".join(drifted) + "."
    else:
        headline = "Every native client snapshot matches the server OpenAPI spec."
    out = [MARKER, "### Native client OpenAPI snapshots", "", headline, ""]
    for name, (status, lines) in results:
        out += [f"#### {name} ({status})", "", *lines, ""]
    if drifted:
        out += [
            "This check is advisory and does not block the PR. Additive changes (new fields, new enum values) "
            "still decode on the native clients; removed or renamed fields, changed types and new required "
            "fields do not, so regenerate before such a change ships to the apps.",
            "",
        ]
    return "\n".join(out)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--server-spec", type=Path, default=None)
    args = parser.parse_args(argv)
    root = args.repo_root.resolve()
    server_spec = (args.server_spec or root / "apps/client/public/openapi.json").resolve()
    if not server_spec.is_file():
        print(f"server spec not found: {server_spec}", file=sys.stderr)
        return 2
    try:
        with tempfile.TemporaryDirectory() as tmp:
            results = [(c.name, check_client(c, server_spec, root, Path(tmp))) for c in CLIENTS]
    except (subprocess.CalledProcessError, json.JSONDecodeError) as error:
        detail = getattr(error, "stderr", None) or str(error)
        print(f"drift check could not run: {detail}", file=sys.stderr)
        return 2
    print(build_report(results))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
