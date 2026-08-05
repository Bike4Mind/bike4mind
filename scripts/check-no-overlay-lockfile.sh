#!/usr/bin/env bash
# Fails if pnpm-lock.yaml references any packages/premium/ path.
#
# The premium overlay dirs are gitignored, but pnpm-workspace.yaml globs them as
# workspace members, so a plain `pnpm install` on a machine with an overlay
# hydrated writes the overlay's importer blocks (package names + dependency
# sets) into the TRACKED lockfile. Committing that publishes private overlay
# structure to this public repo, disguised as ordinary lockfile churn.
#
# The tracked lockfile must always be generated with packages/premium/ empty.
# Run in CI on every PR (lockfile-integrity.yml) and locally via husky
# pre-commit (--staged mode, which checks the staged copy of the lockfile).
#
# Usage: check-no-overlay-lockfile.sh [--staged]

set -euo pipefail

LOCKFILE="pnpm-lock.yaml"
MODE="worktree"
if [ "${1:-}" = "--staged" ]; then
  MODE="staged"
fi

if [ "$MODE" = "staged" ]; then
  # Only relevant when the commit actually touches the lockfile. --quiet exits
  # nonzero when staged changes exist; unlike piping --name-only into grep -q,
  # it cannot be flipped by an early-exit SIGPIPE under pipefail.
  if git diff --cached --quiet -- "$LOCKFILE"; then
    echo "✅ Lockfile not staged; overlay lockfile check skipped."
    exit 0
  fi
  # A staged deletion leaves no index blob to scan (git show would die).
  if ! git ls-files --error-unmatch --cached "$LOCKFILE" >/dev/null 2>&1; then
    echo "✅ Lockfile staged for deletion; nothing to scan."
    exit 0
  fi
  matches=$(git show ":$LOCKFILE" | grep -n "packages/premium/" || true)
else
  matches=$(grep -n "packages/premium/" "$LOCKFILE" || true)
fi

if [ -n "$matches" ]; then
  echo "❌ ERROR: $LOCKFILE references premium overlay packages:"
  echo ""
  echo "$matches" | head -10 | sed 's/^/  /'
  echo ""
  echo "The tracked lockfile must be generated WITHOUT overlays hydrated."
  echo "Fix options:"
  echo "  1. Restore the tracked lockfile: pnpm lockfile:restore"
  echo "  2. Or empty packages/premium/ and re-run: pnpm install"
  echo ""
  echo "See CONTRIBUTING.md \"Premium overlays and the tracked lockfile\"."
  exit 1
fi

echo "✅ No premium overlay paths in $LOCKFILE."
