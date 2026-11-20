"""Drops overlay-only enum values from the committed OpenAPI snapshot, in place.

The server spec lists every registered tool name, including ones that only exist when a premium
overlay is installed. The repo guard (scripts/check-no-overlay-literals.sh) rejects those literals in
any tracked file outside its shrink-only allowlist, so the snapshot cannot carry them. Dropping them
changes nothing downstream: open_enums.py removes every string `enum` before generation anyway.

The pattern is read from the guard script itself so the two cannot drift. Any match left after the
enum pass (a description, a path) fails the run instead of being silently rewritten.
Run by `make generate-client`. Usage: python3 strip_overlay_literals.py <spec.json> <guard-script>
"""

import base64
import json
import re
import sys


def load_pattern(guard_script):
    with open(guard_script, encoding="utf-8") as handle:
        match = re.search(r"^PATTERN_B64='([^']+)'", handle.read(), re.MULTILINE)
    if match is None:
        sys.exit(f"strip_overlay_literals: no PATTERN_B64 in {guard_script}")
    return re.compile(base64.b64decode(match.group(1)).decode("utf-8"))


def strip_enum_values(node, pattern):
    if isinstance(node, dict):
        values = node.get("enum")
        if isinstance(values, list):
            node["enum"] = [v for v in values if not (isinstance(v, str) and pattern.search(v))]
        for value in node.values():
            strip_enum_values(value, pattern)
    elif isinstance(node, list):
        for value in node:
            strip_enum_values(value, pattern)


def main(spec_path, guard_script):
    pattern = load_pattern(guard_script)
    with open(spec_path, encoding="utf-8") as handle:
        spec = json.load(handle)
    strip_enum_values(spec, pattern)
    # Matches the formatting of apps/client/public/openapi.json, so an untouched spec round-trips byte for byte.
    output = json.dumps(spec, indent=2, ensure_ascii=False) + "\n"
    leftover = pattern.search(output)
    if leftover is not None:
        sys.exit(f"strip_overlay_literals: overlay literal outside an enum at offset {leftover.start()}")
    with open(spec_path, "w", encoding="utf-8") as handle:
        handle.write(output)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: strip_overlay_literals.py <spec.json> <guard-script>")
    main(sys.argv[1], sys.argv[2])
