#!/usr/bin/env python3
"""Fails if a workflow interpolates ${{ ... }} inside a step's `run:` body.

GitHub substitutes ${{ }} into the script text before bash parses it, so any
value carrying shell metacharacters changes what the script does. Passing the
value through `env:` and reading it as "$VAR" hands it to bash as data instead.

The rule is deliberately shaped as "no interpolation at all" rather than "no
interpolation of untrusted values": which expressions are attacker-influenceable
changes as triggers and inputs change, so a per-expression judgement rots while
a blanket rule does not.

Stdlib only, so it cannot degrade into a silent skip on a runner without PyYAML.
Scanning is indentation-based, which is why it reports the `run:` line rather
than the offending line within the script.

Run in CI on every PR (ci.yml) and locally via husky pre-commit.

To add a legitimate exception, add the workflow filename to EXEMPT with a
comment saying why and when it goes away.
"""

import re
import sys
from pathlib import Path

WORKFLOWS = Path(".github/workflows")

# Empty on purpose. An entry here is a workflow the rule is not actually holding
# on, so it needs a comment saying why and when it goes away.
EXEMPT: set[str] = set()

RUN_KEY = re.compile(r"^(\s*)(?:-\s+)?run:\s*(\S.*)?$")
STEPS_KEY = re.compile(r"^(\s*)steps:\s*$")
BLOCK_SCALAR = re.compile(r"^[|>][+-]?\d*$")
EXPR = re.compile(r"\$\{\{\s*(.*?)\s*\}\}", re.DOTALL)


def run_bodies(lines):
    """Yield (line_number, body_text) for every `run:` value in a workflow.

    Only `run:` keys inside a `steps:` block count. A job may itself be named
    `run`, which sits at job-key indentation and is not a script.
    """
    i = 0
    steps_indent = None
    while i < len(lines):
        line = lines[i]
        stripped_indent = len(line) - len(line.lstrip())
        steps_match = STEPS_KEY.match(line)
        if steps_match:
            steps_indent = len(steps_match.group(1))
            i += 1
            continue
        if line.strip() and steps_indent is not None and stripped_indent <= steps_indent:
            steps_indent = None
        match = RUN_KEY.match(line)
        if not match or steps_indent is None:
            i += 1
            continue
        indent = len(match.group(1))
        if indent <= steps_indent:
            i += 1
            continue
        first = match.group(2) or ""
        start = i
        collected = [] if BLOCK_SCALAR.match(first.strip()) else [first]
        # Both a block scalar and a wrapped inline scalar continue on the
        # following lines that are indented deeper than the `run:` key itself.
        i += 1
        while i < len(lines):
            line = lines[i]
            if line.strip() and (len(line) - len(line.lstrip())) <= indent:
                break
            collected.append(line)
            i += 1
        yield start + 1, "\n".join(collected)


def main() -> int:
    violations = []
    for path in sorted(list(WORKFLOWS.glob("*.yml")) + list(WORKFLOWS.glob("*.yaml"))):
        if path.name in EXEMPT:
            continue
        lines = path.read_text().split("\n")
        for line_number, body in run_bodies(lines):
            if "${{" not in body:
                continue
            for expr in sorted(set(EXPR.findall(body))):
                violations.append((path, line_number, expr))

    if not violations:
        print("OK: no ${{ }} interpolation inside any run: body")
        return 0

    print("ERROR: workflow steps interpolate ${{ }} directly into a run: body.\n")
    print("GitHub substitutes these before bash parses the script. Move each value")
    print("to the step's env: block and read it as \"$VAR\" instead:\n")
    print("      - name: Example")
    print("        env:")
    print("          MY_VALUE: ${{ inputs.something }}")
    print("        run: echo \"$MY_VALUE\"\n")
    for path, line_number, expr in violations:
        print(f"  {path}:{line_number}  ->  ${{{{ {expr} }}}}")
    print(f"\n{len(violations)} violation(s)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
