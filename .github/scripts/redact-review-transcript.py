#!/usr/bin/env python3
"""Strip private content out of a pr-bot-review execution transcript.

Used by .github/workflows/pr-bot-review.yml, which uploads the result as a
workflow artifact so a run that posted no review can be diagnosed. Artifacts on
a public repo are world-downloadable, so two things must not survive:

  1. The bot-review skill body, fetched at run time from the PRIVATE
     b4m-devtools repo. Any JSON string carrying a verbatim run of it is
     replaced wholesale.
  2. Credentials. Actions masks secrets in logs but NOT in artifacts.

Detection is by fixed-width windows rather than whole lines, so a skill line
split across two JSON strings is still caught as long as each piece keeps a
WINDOW-length verbatim run. Residual risk: a paraphrase, or fragments shorter
than WINDOW, are not detectable. Redaction is deliberately blunt because the
transcript's diagnostic value (turn count, tool calls, where it stopped) does
not depend on the quoted text.

Exits non-zero on anything it cannot redact confidently; the workflow treats
that as "do not upload".
"""

import json
import re
import sys

REDACTED = "[redacted: bot-review skill content]"
WINDOW = 30

TOKEN_PATTERNS = [
    re.compile(r"\bgh[psuor]_[A-Za-z0-9]{16,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bsk-ant-[A-Za-z0-9\-_]{16,}"),
]


def windows(text):
    return {text[i:i + WINDOW] for i in range(len(text) - WINDOW + 1)}


def carries_private(value, private):
    return any(value[i:i + WINDOW] in private for i in range(len(value) - WINDOW + 1))


def scrub_string(value, private):
    if carries_private(value, private):
        return REDACTED
    for pattern in TOKEN_PATTERNS:
        value = pattern.sub("[redacted: credential]", value)
    return value


def scrub(node, private, seen):
    """Rewrites string values; `seen` collects every text the backstop must clear.

    Dict keys are recorded but never rewritten - a needle in a key is a shape we
    do not expect, so the backstop should refuse the upload rather than mangle
    the structure.
    """
    if isinstance(node, str):
        cleaned = scrub_string(node, private)
        seen.append(cleaned)
        return cleaned
    if isinstance(node, list):
        return [scrub(item, private, seen) for item in node]
    if isinstance(node, dict):
        seen.extend(node.keys())
        return {key: scrub(item, private, seen) for key, item in node.items()}
    return node


def main(argv):
    if len(argv) != 4:
        print(f"usage: {argv[0]} <execution-file> <skill-file> <dest>", file=sys.stderr)
        return 2
    src, skill_path, dest = argv[1:]

    try:
        with open(skill_path, encoding="utf-8") as handle:
            skill = handle.read()
    except OSError as err:
        print(f"cannot read skill file for redaction: {err}", file=sys.stderr)
        return 1

    private = set()
    for line in skill.splitlines():
        private |= windows(line.strip())
    if not private:
        print("skill file yielded no redaction fingerprints", file=sys.stderr)
        return 1

    with open(src, encoding="utf-8", errors="replace") as handle:
        raw = handle.read()

    seen = []
    try:
        cleaned = json.dumps(scrub(json.loads(raw), private, seen))
    except json.JSONDecodeError:
        # The action has shipped both a JSON array and JSONL; handle either.
        lines = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                lines.append(json.dumps(scrub(json.loads(line), private, seen)))
            except json.JSONDecodeError:
                print("execution file is neither JSON nor JSONL", file=sys.stderr)
                return 1
        cleaned = "\n".join(lines)

    # Checked against the scrubbed leaves, not against `cleaned`: JSON escaping
    # (`"` -> `\"`) hides a fingerprint from the serialized form.
    surviving = sum(1 for text in seen if carries_private(text, private))
    if surviving:
        print(f"{surviving} private fingerprint(s) survived redaction", file=sys.stderr)
        return 1

    with open(dest, "w", encoding="utf-8") as handle:
        handle.write(cleaned)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
