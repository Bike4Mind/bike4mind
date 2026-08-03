#!/usr/bin/env bash
# Fails if pnpm-lock.yaml references any packages/premium/ path OR any
# dependency from a private MillionOnMars GitHub repo.
#
# TWO classes of leak are blocked:
#
#   1. packages/premium/ importer blocks — pnpm-workspace.yaml globs the
#      premium dirs, so `pnpm install` with an overlay hydrated writes the
#      overlay's importer block (package names + dependency sets) into the
#      TRACKED lockfile, publishing private overlay structure.
#
#   2. @milliononmars/ scoped packages (e.g. @milliononmars/hydra) — overlay
#      packages can depend on private scoped packages in this org. Those git
#      resolutions appear in a separate section of the lockfile that contains
#      no "packages/premium/" string, so check (1) alone does not catch them.
#      Grep (2) closes that gap. Note: unscoped MillionOnMars tarball forks
#      (e.g. react-use-websocket) are already in the public lockfile and are
#      intentionally excluded from this check — only @milliononmars/ scoped
#      packages are private.
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
  CONTENT=$(git show ":$LOCKFILE")
  matches=$(echo "$CONTENT" | grep -in "packages/premium/\|@milliononmars/" || true)
else
  matches=$(grep -in "packages/premium/\|@milliononmars/" "$LOCKFILE" || true)
fi

if [ -n "$matches" ]; then
  echo "❌ ERROR: $LOCKFILE references premium overlay packages or private dependencies:"
  echo ""
  echo "$matches" | head -10 | sed 's/^/  /'
  echo ""
  echo "The tracked lockfile must be generated WITHOUT overlays hydrated."
  echo "Fix options:"
  echo "  1. Restore the committed lockfile: git checkout origin/main -- $LOCKFILE"
  echo "  2. Or empty packages/premium/ and re-run: pnpm install"
  exit 1
fi

echo "✅ No premium overlay paths or private dependencies in $LOCKFILE."
