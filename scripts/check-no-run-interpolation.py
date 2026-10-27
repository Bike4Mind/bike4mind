#!/usr/bin/env python3
"""Fails if a step interpolates ${{ ... }} into script text.

Scanned: `run:` bodies and the `with: script:` bodies of actions/github-script
steps, in .github/workflows/*.yml|yaml and in composite actions anywhere under
.github/actions (action.yml or action.yaml).

GitHub substitutes ${{ }} into the script text before bash (or node) parses it,
so any value carrying metacharacters changes what the script does. Passing the
value through `env:` and reading it as "$VAR" (or process.env.VAR) hands it to
the script as data instead.

The rule is deliberately shaped as "no interpolation at all" rather than "no
interpolation of untrusted values": which expressions are attacker-influenceable
changes as triggers and inputs change, so a per-expression judgement rots while
a blanket rule does not.

Stdlib only, so it cannot degrade into a silent skip on a runner without PyYAML.
Scanning is indentation-based, which is why it reports the `run:` or `script:`
line rather than the offending line within the script.

Run in CI on every PR (ci.yml) and locally via husky pre-commit.

To add a legitimate exception, add the workflow filename to EXEMPT with a
comment saying why and when it goes away.
"""

import re
import sys
from pathlib import Path

WORKFLOWS = Path(".github/workflows")
ACTIONS = Path(".github/actions")

# Empty on purpose. An entry here is a workflow the rule is not actually holding
# on, so it needs a comment saying why and when it goes away.
EXEMPT: set[str] = set()

RUN_KEY = re.compile(r"^(\s*)(?:-\s+)?run:\s*(\S.*)?$")
SCRIPT_KEY = re.compile(r"^(\s*)script:\s*(\S.*)?$")
STEP_ITEM = re.compile(r"^(\s*)-\s")
# Owner and repo names in `uses:` are case-insensitive on GitHub.
GITHUB_SCRIPT = re.compile(r"^\s*(?:-\s+)?uses:\s*['\"]?actions/github-script@", re.IGNORECASE)
STEPS_KEY = re.compile(r"^(\s*)steps:\s*$")
BLOCK_SCALAR = re.compile(r"^[|>][+-]?\d*$")
EXPR = re.compile(r"\$\{\{\s*(.*?)\s*\}\}", re.DOTALL)


def in_steps(line, steps_indent):
    """True while `line` is still inside a `steps:` block opened at steps_indent.

    YAML lets the list items sit at the key's own indentation (`steps:` then `- run:`),
    so a `-` item at that indentation is still inside the block.
    """
    indent = len(line) - len(line.lstrip())
    return indent > steps_indent or (indent == steps_indent and STEP_ITEM.match(line) is not None)


def run_bodies(lines):
    """Yield (line_number, body_text) for every `run:` value in a workflow.

    Only `run:` keys inside a `steps:` block count. A job may itself be named
    `run`, which sits at job-key indentation and is not a script.
    """
    i = 0
    steps_indent = None
    while i < len(lines):
        line = lines[i]
        steps_match = STEPS_KEY.match(line)
        if steps_match:
            steps_indent = len(steps_match.group(1))
            i += 1
            continue
        if line.strip() and steps_indent is not None and not in_steps(line, steps_indent):
            steps_indent = None
        match = RUN_KEY.match(line)
        if not match or steps_indent is None:
            i += 1
            continue
        indent = len(match.group(1))
        start = i
        body, i = scalar_body(lines, i, indent, match.group(2))
        yield start + 1, body


def scalar_body(lines, i, indent, first):
    """Return (body_text, next_index) for the scalar value whose key is on line i."""
    first = first or ""
    collected = [] if BLOCK_SCALAR.match(first.strip()) else [first]
    # Both a block scalar and a wrapped inline scalar continue on the
    # following lines that are indented deeper than the key itself.
    i += 1
    while i < len(lines):
        line = lines[i]
        if line.strip() and (len(line) - len(line.lstrip())) <= indent:
            break
        collected.append(line)
        i += 1
    return "\n".join(collected), i


def steps(lines):
    """Yield (first_index, end_index) for each list item of every `steps:` block."""
    i = 0
    while i < len(lines):
        steps_match = STEPS_KEY.match(lines[i])
        if not steps_match:
            i += 1
            continue
        steps_indent = len(steps_match.group(1))
        item_indent = None
        start = None
        i += 1
        while i < len(lines):
            line = lines[i]
            if line.strip() and not in_steps(line, steps_indent):
                break
            item = STEP_ITEM.match(line)
            if item and (item_indent is None or len(item.group(1)) == item_indent):
                item_indent = len(item.group(1))
                if start is not None:
                    yield start, i
                start = i
            i += 1
        if start is not None:
            yield start, i


def github_script_bodies(lines):
    """Yield (line_number, body_text) for the `script:` input of each actions/github-script step."""
    for start, end in steps(lines):
        step = lines[start:end]
        if not any(GITHUB_SCRIPT.match(line) for line in step):
            continue
        item_indent = len(STEP_ITEM.match(step[0]).group(1))
        for offset, line in enumerate(step):
            match = SCRIPT_KEY.match(line)
            if match and len(match.group(1)) > item_indent:
                body, _ = scalar_body(step, offset, len(match.group(1)), match.group(2))
                yield start + offset + 1, body


def main() -> int:
    violations = []
    workflows = sorted(list(WORKFLOWS.glob("*.yml")) + list(WORKFLOWS.glob("*.yaml")))
    actions = sorted(list(ACTIONS.rglob("action.yml")) + list(ACTIONS.rglob("action.yaml")))
    for path in workflows + actions:
        if path in workflows and path.name in EXEMPT:
            continue
        lines = path.read_text().split("\n")
        bodies = list(run_bodies(lines)) + list(github_script_bodies(lines))
        for line_number, body in sorted(bodies):
            if "${{" not in body:
                continue
            for expr in sorted(set(EXPR.findall(body))):
                violations.append((path, line_number, expr))

    if not violations:
        print("OK: no ${{ }} interpolation inside any run: or github-script script: body")
        return 0

    print("ERROR: steps interpolate ${{ }} directly into a run: or script: body.\n")
    print("GitHub substitutes these before the script is parsed. Move each value")
    print("to the step's env: block and read it as \"$VAR\" (or process.env.VAR")
    print("in a github-script script:) instead:\n")
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
