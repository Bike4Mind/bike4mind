#!/usr/bin/env python3
"""Strip private content out of a pr-bot-review execution transcript.

Used by .github/workflows/pr-bot-review.yml, which uploads the result as a
workflow artifact so a run that posted no review can be diagnosed. Artifacts on
a public repo are world-downloadable, so two things must not survive:

  1. The bot-review skill body, fetched at run time from the PRIVATE
     b4m-devtools repo. Any JSON string quoting a substantial line of it is
     replaced wholesale.
  2. Credentials. Actions masks secrets in logs but NOT in artifacts.

Residual risk: a paraphrase of the skill that quotes no long line verbatim is
not detectable and would survive. Redaction is deliberately blunt because the
transcript's diagnostic value (turn count, tool calls, where it stopped) does
not depend on the quoted text.

Exits non-zero on anything it cannot redact confidently; the workflow treats
that as "do not upload".
"""

import json
import re
import sys

REDACTED = "[redacted: bot-review skill content]"
MIN_NEEDLE_LEN = 30

TOKEN_PATTERNS = [
    re.compile(r"\bgh[psuor]_[A-Za-z0-9]{16,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bsk-ant-[A-Za-z0-9\-_]{16,}"),
]


def scrub_string(value, needles):
    if any(needle in value for needle in needles):
        return REDACTED
    for pattern in TOKEN_PATTERNS:
        value = pattern.sub("[redacted: credential]", value)
    return value


def scrub(node, needles):
    if isinstance(node, str):
        return scrub_string(node, needles)
    if isinstance(node, list):
        return [scrub(item, needles) for item in node]
    if isinstance(node, dict):
        return {key: scrub(item, needles) for key, item in node.items()}
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

    needles = {line.strip() for line in skill.splitlines() if len(line.strip()) >= MIN_NEEDLE_LEN}
    if not needles:
        print("skill file yielded no redaction needles", file=sys.stderr)
        return 1

    with open(src, encoding="utf-8", errors="replace") as handle:
        raw = handle.read()

    try:
        cleaned = json.dumps(scrub(json.loads(raw), needles))
    except json.JSONDecodeError:
        # The action has shipped both a JSON array and JSONL; handle either.
        lines = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                lines.append(json.dumps(scrub(json.loads(line), needles)))
            except json.JSONDecodeError:
                print("execution file is neither JSON nor JSONL", file=sys.stderr)
                return 1
        cleaned = "\n".join(lines)

    surviving = [needle for needle in needles if needle in cleaned]
    if surviving:
        print(f"{len(surviving)} private needle(s) survived redaction", file=sys.stderr)
        return 1

    with open(dest, "w", encoding="utf-8") as handle:
        handle.write(cleaned)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
