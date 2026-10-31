#!/usr/bin/env bash
# Prints the commit the "changed lines" guards in ci.yml diff against: the ASCII checks in
# `repo-guards`, the gitleaks range scan in `secret-scan` and the leak-shapes check in `leak-shapes`.
# All three call this, so they always agree on what a change added.
#
# Inputs arrive as env, never interpolated into a run body: BASE_REF is a branch name, and git
# permits `;`, `$()`, backticks, `|` and quotes in a ref.
#   EVENT_BASE  pull_request.base.sha || merge_group.base_sha || push `before`
#   BASE_REF    pull_request.base.ref (empty outside pull_request)
#
# `pull_request.base.sha` is the base-branch head recorded when the PR was opened - NOT the fork
# point, and it does not move as the base branch advances. On a long-lived PR every commit main
# gained since is attributed to the PR: a PR opened 83 commits back once failed on em-dashes that
# were already on main, in files it never touched.
#
# The real base is the merge base of the base branch and the checkout. On a `pull_request` run the
# checkout is the merge ref, so this resolves to the base-branch tip and the diff is exactly the
# PR's net contribution. Falls back to EVENT_BASE for push / merge_group, and to the empty string
# if nothing resolves - callers treat empty as "scan everything", never "check nothing".
set -euo pipefail

resolved="${EVENT_BASE:-}"
if [ -n "${BASE_REF:-}" ]; then
  if git fetch --no-tags --quiet origin "$BASE_REF" 2>/dev/null; then
    if merge_base=$(git merge-base FETCH_HEAD HEAD 2>/dev/null); then
      resolved="$merge_base"
    fi
  fi
fi

echo "Guards diff against ${resolved:-<whole tree>} (event base was ${EVENT_BASE:-<none>})" >&2
printf '%s\n' "$resolved"
