#!/usr/bin/env sh
# Check if help articles changed but generated help files weren't regenerated.
#
# Warns (non-blocking) when docs-site/docs/{features,admin}/ markdown files are staged
# but help-index.json or help-embeddings.json aren't also staged.

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR)

# Check if any user-facing help articles were modified
DOCS_CHANGED=$(echo "$STAGED_FILES" | grep -c '^docs-site/docs/\(features\|admin\)/.*\.md$' || true)

if [ "$DOCS_CHANGED" -gt 0 ]; then
  INDEX_STAGED=$(echo "$STAGED_FILES" | grep -c 'apps/client/app/generated/help-index.json' || true)
  EMBEDDINGS_STAGED=$(echo "$STAGED_FILES" | grep -c 'apps/client/app/generated/help-embeddings.json' || true)

  if [ "$INDEX_STAGED" -eq 0 ] || [ "$EMBEDDINGS_STAGED" -eq 0 ]; then
    echo ""
    echo "⚠️  Help articles changed but generated files may be stale:"

    if [ "$INDEX_STAGED" -eq 0 ]; then
      echo "   • help-index.json not updated — run: pnpm --filter @bike4mind/scripts help:build-index"
    fi
    if [ "$EMBEDDINGS_STAGED" -eq 0 ]; then
      echo "   • help-embeddings.json not updated — run: OPENAI_API_KEY=sk-... pnpm --filter @bike4mind/scripts help:vectorize"
    fi

    echo ""
    echo "   Then stage the generated files and amend your commit."
    echo ""
  fi
fi

# Block commit if help-index.json has articles missing from help-embeddings.json.
# This prevents deploying an index update without matching embeddings, which would
# leave the Help AI chat unable to find content the user expects it to know.
INDEX_FILE="apps/client/app/generated/help-index.json"
EMBEDDINGS_FILE="apps/client/app/generated/help-embeddings.json"

# Both artifacts are git-tracked, so absence means someone deleted one - fail rather
# than skip. This block used to be wrapped in `if [ -f ] && [ -f ]`, which turned a
# deleted artifact into a silent pass.
if [ ! -f "$INDEX_FILE" ] || [ ! -f "$EMBEDDINGS_FILE" ]; then
  echo ""
  echo "❌ A generated help artifact is missing:"
  [ -f "$INDEX_FILE" ] || echo "   • $INDEX_FILE"
  [ -f "$EMBEDDINGS_FILE" ] || echo "   • $EMBEDDINGS_FILE"
  echo ""
  echo "   Both are git-tracked. Restore the file, or regenerate:"
  echo "     pnpm --filter @bike4mind/scripts help:regenerate"
  echo ""
  exit 1
fi

# `if ! MISSING=$(...)` so a throw fails the check. This was `2>/dev/null || true`,
# which collapsed a corrupt artifact, a missing `chunks` key, or an unreadable file
# into an empty MISSING - read downstream as "nothing missing" - so the gate passed
# silently on exactly the inputs it exists to catch. Nothing else would have caught it
# either: apps/client/server/help/retrieval.ts reads this same file at RUNTIME and
# fails quiet in the same shape (catch -> warn -> keyword fallback), and it is not a
# build-time import, so a truncated artifact does not redden the build. stderr is left
# unredirected so node's own parse error is what the reader sees.
# Uses node since jq may not be installed.
if ! MISSING=$(node -e "
    const idx = JSON.parse(require('fs').readFileSync('$INDEX_FILE','utf-8'));
    const emb = JSON.parse(require('fs').readFileSync('$EMBEDDINGS_FILE','utf-8'));
    if (!Array.isArray(idx.entries) || !Array.isArray(emb.chunks)) {
      throw new Error('unexpected artifact shape: expected idx.entries[] and emb.chunks[]');
    }
    const embSlugs = new Set(emb.chunks.map(c => c.slug));
    const missing = idx.entries.filter(e => !embSlugs.has(e.slug)).map(e => e.slug);
    if (missing.length) {
      console.log(missing.join('\n'));
    }
  "); then
  echo ""
  echo "❌ Could not compare the help index against the embeddings (see the error above)."
  echo "   The artifact is unreadable or malformed - regenerate it:"
  echo "     pnpm --filter @bike4mind/scripts help:regenerate"
  echo ""
  exit 1
fi

if [ -n "$MISSING" ]; then
  echo ""
  echo "❌ Help index has articles with no embeddings — the Help AI chat won't be able to answer questions about them:"
  echo "$MISSING" | while read -r slug; do
    echo "   • $slug"
  done
  echo ""
  echo "   To fix, run:"
  echo "     pnpm --filter @bike4mind/scripts help:bundle-content"
  echo "     OPENAI_API_KEY=sk-... pnpm --filter @bike4mind/scripts help:vectorize"
  echo "   Then stage help-embeddings.json and commit again."
  echo ""
  # exit, not return: the pre-commit hook invokes this as a subprocess, so `return` at
  # top level is an error and the non-zero status would be lost.
  exit 1
fi

exit 0
