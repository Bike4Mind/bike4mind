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

if [ -f "$INDEX_FILE" ] && [ -f "$EMBEDDINGS_FILE" ]; then
  # Extract slugs from both files and compare
  # Uses node since jq may not be installed
  MISSING=$(node -e "
    const idx = JSON.parse(require('fs').readFileSync('$INDEX_FILE','utf-8'));
    const emb = JSON.parse(require('fs').readFileSync('$EMBEDDINGS_FILE','utf-8'));
    const embSlugs = new Set(emb.chunks.map(c => c.slug));
    const missing = idx.entries.filter(e => !embSlugs.has(e.slug)).map(e => e.slug);
    if (missing.length) {
      console.log(missing.join('\n'));
    }
  " 2>/dev/null || true)

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
    return 1
  fi
fi
