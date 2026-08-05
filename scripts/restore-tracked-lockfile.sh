#!/usr/bin/env bash
# Restores the tracked pnpm-lock.yaml after an install with a premium overlay hydrated.
#
# packages/premium/* is a live workspace glob (see pnpm-workspace.yaml), so `pnpm
# install` on a machine with an overlay hydrated rewrites pnpm-lock.yaml to include
# the overlay's importer blocks. That must never reach this PUBLIC repo
# (check-no-overlay-lockfile.sh is the hard gate, in CI and pre-commit), and it also
# should not sit in the worktree dirtying every unrelated branch and diff.
#
# Restoring is safe: node_modules was already linked by the install that rewrote the
# lockfile, and nothing reads the lockfile again until the next install. The next
# overlay-hydrated install rewrites it again - re-run this script.
#
# See CONTRIBUTING.md "Premium overlays and the tracked lockfile".

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

LOCKFILE="pnpm-lock.yaml"

# Compare against HEAD, not the index, so a lockfile already staged for commit is
# still seen as changed. `git checkout HEAD -- <path>` resets index and worktree
# together, so one restore clears both.
if git diff --quiet HEAD -- "$LOCKFILE"; then
  echo "✅ $LOCKFILE matches HEAD; nothing to restore."
  exit 0
fi

if ! git diff HEAD -- "$LOCKFILE" | grep -q "^+.*packages/premium/"; then
  echo "ℹ️  $LOCKFILE differs from HEAD but adds no packages/premium/ paths."
  echo "   This looks like a real dependency change, so it was left untouched."
  exit 0
fi

echo "Overlay paths found in $LOCKFILE; restoring the tracked copy from HEAD."
echo "Discarding these changes:"
git diff --stat HEAD -- "$LOCKFILE" | sed 's/^/  /'
git checkout HEAD -- "$LOCKFILE"
echo "✅ Restored $LOCKFILE from HEAD."
echo ""
echo "If you also meant to change a real dependency, empty packages/premium/ first,"
echo "then re-run pnpm install so the lockfile is regenerated overlay-free."
