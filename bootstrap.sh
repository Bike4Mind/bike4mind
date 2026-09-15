#!/usr/bin/env bash
# Bootstrap a Claude Code worktree (or fresh checkout) for development.
# Idempotent — safe to re-run.
#
# Steps:
#   1. pnpm i -r                            (install workspace deps)
#   2. Copy gitignored b4m-core sst-env.d.ts from main checkout (worktree only)
#   3. pnpm turbo:core:build                (cached after first run)
#   4. pnpm sst install                     (generate .sst/platform/ — no AWS)
#
# Core must be built BEFORE `sst install` because sst.config.ts → ./infra
# imports @bike4mind/infra; without dist/, esbuild fails with
# "Failed to build sst.config.ts".

set -euo pipefail

if [[ "$PWD" == *"/.claude/worktrees/"* ]]; then
  MAIN_REPO="${PWD%/.claude/worktrees/*}"
  IS_WORKTREE=1
else
  MAIN_REPO="$PWD"
  IS_WORKTREE=0
fi

if [[ -d node_modules && -d .sst/platform ]]; then
  echo "✓ Already bootstrapped (node_modules + .sst/platform exist)"
  exit 0
fi

echo "→ Bootstrapping at $PWD"

if [[ ! -d node_modules ]]; then
  echo "  • pnpm i -r"
  pnpm i -r --prefer-offline
fi

if [[ "$IS_WORKTREE" == "1" && -d "$MAIN_REPO/b4m-core" ]]; then
  echo "  • Copying b4m-core sst-env.d.ts from $MAIN_REPO"
  while IFS= read -r src; do
    rel="${src#$MAIN_REPO/}"
    dest="$PWD/$rel"
    if [[ ! -f "$dest" && -d "$(dirname "$dest")" ]]; then
      cp "$src" "$dest"
    fi
  done < <(find "$MAIN_REPO/b4m-core" -name "sst-env.d.ts" -not -path "*/node_modules/*" 2>/dev/null || true)
fi

echo "  • pnpm turbo:core:build"
pnpm turbo:core:build

if [[ ! -d .sst/platform ]]; then
  echo "  • pnpm sst install"
  pnpm sst install
fi

echo "✓ Bootstrap complete"
