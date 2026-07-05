#!/usr/bin/env bash
#
# dev:reset — clean up a wedged westLumina5 local dev environment.
#
# WHEN TO USE: you Ctrl-C'd `pnpm edev` / `pnpm dev` but the dev processes didn't die
# (they orphan to PID 1 and keep spraying watch-build output into a now-dead terminal),
# AND/OR the client throws a phantom "Module not found: Can't resolve '@bike4mind/...'"
# for a workspace package that is actually built — the tell-tale sign that Turbopack's
# .next/dev cache froze a STALE failed resolution during a core:dev rebuild gap (the
# watcher deletes+recreates dist/* on each rebuild; Turbopack can cache the gap).
#
# WHAT IT DOES (idempotent — safe to run anytime, even with nothing running):
#   1. Kills ONLY this repo's dev processes, matched by b4m-specific command patterns
#      plus the :3000 listener. The patterns are deliberately narrow so this can NEVER
#      hit other projects on the machine — erikbethkedotcom portfolio (:3009),
#      4xciv, or @bike4mind/cc-bridge — their command lines don't match.
#   2. Removes apps/client/.next (the Turbopack dev cache). It regenerates on next start;
#      the first build is slower but the phantom module-not-found is gone.
#
# It does NOT touch SST state/locks. For a wedged DEPLOY lock, use `pnpm sst:unlock:force`
# — that is a different failure class (this script is for orphaned dev procs + stale cache).
#
# Run from repo root:  pnpm dev:reset      (then restart with `pnpm edev`)
#
# Context: incident 2026-06-28 — orphaned next/core:dev watchers (PPID 1, un-Ctrl-C-able)
# plus a 32GB stale apps/client/.next/dev that served a frozen "@bike4mind/services not
# found" even though the package was built and linked the whole time.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Fail fast if we can't reach the repo root — never run the rm -rf below from the wrong cwd.
cd "$ROOT" || { echo "❌ could not cd to repo root: $ROOT"; exit 1; }

echo "🧹 dev:reset — cleaning up westLumina5 local dev"
echo ""

# 1. Kill this repo's dev processes. Each pattern is unique to westLumina5 so it cannot
#    match sibling projects:
#      core:dev            -> `pnpm core:dev` (this repo's script name)
#      filter ./b4m-core   -> the parallel core watch-builds
#      filter client dev   -> `pnpm --filter client dev` (the client next dev; portfolio
#                             uses 'filter portfolio dev', cc-bridge 'filter @bike4mind/cc-bridge')
#      for-env local ./dev -> the `edev` launcher (./for-env local ./dev)
#      sst dev             -> the SST multiplexer that `./dev` starts (no other project here uses it)
# NOTE: pgrep -f treats these as REGEX, so literal dots are escaped (\.) — an unescaped '.'
# would match any char and widen the pattern, undermining the "deliberately narrow" guarantee.
PATTERNS=(
  'core:dev'
  'filter \./b4m-core'
  'filter client dev'
  'for-env local \./dev'
  'sst dev'
)

# pgrep matches that exclude this script's own pid (and the pnpm wrapper that spawned it).
match_pids() {
  pgrep -f "$1" 2>/dev/null | grep -vx "$$" || true
}

for pat in "${PATTERNS[@]}"; do
  pids=$(match_pids "$pat")
  if [ -n "$pids" ]; then
    echo "  • SIGTERM [$pat]: $(echo "$pids" | tr '\n' ' ')"
    # shellcheck disable=SC2086  # intentional: $pids is newline-separated PIDs to word-split
    kill $pids 2>/dev/null || true
  fi
done

# The next-server on :3000 is this repo's client (portfolio is :3009, cc-bridge elsewhere),
# so freeing the port by listener is safe and catches any next tree the patterns missed.
# -sTCP:LISTEN restricts to the LISTENING server only — never a browser tab or other client
# merely *connected* to :3000; -nP skips slow DNS/port-name lookups.
port_pids=$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$port_pids" ]; then
  echo "  • SIGTERM :3000 listener: $(echo "$port_pids" | tr '\n' ' ')"
  # shellcheck disable=SC2086  # intentional: $port_pids is newline-separated PIDs to word-split
  kill $port_pids 2>/dev/null || true
fi

# Grace period, then SIGKILL anything that ignored SIGTERM (orphaned watchers often do).
sleep 2
for pat in "${PATTERNS[@]}"; do
  pids=$(match_pids "$pat")
  if [ -n "$pids" ]; then
    echo "  • SIGKILL survivor [$pat]: $(echo "$pids" | tr '\n' ' ')"
    # shellcheck disable=SC2086  # intentional: $pids is newline-separated PIDs to word-split
    kill -9 $pids 2>/dev/null || true
  fi
done
leftover=$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null || true)
# shellcheck disable=SC2086  # intentional: $leftover is newline-separated PIDs to word-split
[ -n "$leftover" ] && { echo "  • SIGKILL :3000 survivor: $leftover"; kill -9 $leftover 2>/dev/null || true; }

if lsof -nP -iTCP:3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "  ⚠️  something is STILL on :3000 — inspect: lsof -nP -iTCP:3000 -sTCP:LISTEN"
else
  echo "  ✓ :3000 is free"
fi

echo ""

# 2. Clear the Turbopack dev cache — the phantom-module-not-found fix.
if [ -d apps/client/.next ]; then
  size=$(du -sh apps/client/.next 2>/dev/null | cut -f1)
  echo "🗑  removing apps/client/.next (${size:-unknown})"
  rm -rf apps/client/.next
  echo "  ✓ cache cleared (regenerates on next start)"
else
  echo "🗑  apps/client/.next already gone"
fi

echo ""
echo "✅ dev:reset complete.  Restart with:  pnpm edev"
echo ""
echo "ℹ️  Old terminal still misbehaving after the kill?"
echo "    • Garbled output, no prompt  →  tty left in raw mode: blind-type  reset  then Ctrl-J."
echo "    • Codes like '24;30M' / '65;24;30M' spraying on repeat  →  the dead TUI left the pane"
echo "      in MOUSE-REPORT mode; those bytes are generated by your MOUSE MOVING over the pane"
echo "      (they also shred any 'reset' you type). Fix: park the mouse OFF the window so the"
echo "      spray stops, press Ctrl-C, then type  reset  and Enter."
echo "    • Or just close the pane — no dev procs remain, so nothing is lost."
echo "    Habit: run 'pnpm edev' in a pane you're willing to close — then a dirty TUI exit is"
echo "    a one-move fix (the terminal state dies with the pane)."
