#!/usr/bin/env bash
# Checks that the checked-out PR head already carries the changeset the auto-changeset bot
# would produce for PR_TITLE: runs generate-changeset.sh with its push redirected to a
# throwaway remote and `gh` stubbed out, and fails if the generator commits anything.
# One generator, so the verdict can never disagree with what the bot writes.
#
# Mutates the checkout (new branch, commits), so run it on a disposable CI checkout.
# Env: PR_TITLE, PR_NUMBER, REPO (optional). Needs origin/main fetched.
# Exit: 0 = head matches, 1 = head would change, 2 = the generator itself failed.

set -euo pipefail

: "${PR_TITLE:?}" "${PR_NUMBER:?}"
GENERATOR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/generate-changeset.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git init -q --bare "$TMP/sink.git"
git checkout -q -B verify-changeset
git push -q -u "$TMP/sink.git" verify-changeset

mkdir "$TMP/bin"
printf '#!/bin/sh\nexit 1\n' >"$TMP/bin/gh"
chmod +x "$TMP/bin/gh"

BEFORE=$(git rev-parse HEAD)
if ! PATH="$TMP/bin:$PATH" GH_TOKEN='' REPO="${REPO:-}" \
  GIT_AUTHOR_NAME='changeset verifier' GIT_AUTHOR_EMAIL='verifier@localhost' \
  GIT_COMMITTER_NAME='changeset verifier' GIT_COMMITTER_EMAIL='verifier@localhost' \
  bash "$GENERATOR"; then
  echo "::error::The changeset generator failed while verifying PR #${PR_NUMBER}."
  exit 2
fi

if [ "$(git rev-parse HEAD)" = "$BEFORE" ]; then
  echo "Changeset for PR #${PR_NUMBER} matches the PR title and diff."
  exit 0
fi

echo "The auto-changeset bot would commit this to the PR head:"
git diff --stat "$BEFORE" HEAD
git diff "$BEFORE" HEAD -- .changeset
exit 1
