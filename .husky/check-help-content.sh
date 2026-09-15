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

# Block commit if the two artifacts disagree about accessLevel. That field is the only
# gate keeping admin-only help docs out of a non-admin user's Help AI chat answers:
# apps/client/server/help/retrieval.ts filters on it in both paths - embeddings chunks in
# the vector search, index entries in the keyword fallback. The check above compares slug
# SETS, so an artifact with every chunk relabeled 'public' is byte-indistinguishable from
# a correct one as far as it is concerned, and a partial regenerate, a hand-edit, or a bad
# merge resolution on a one-line-JSON artifact ships a silent access-control regression.
# Two assertions close that:
#   1. every chunk's accessLevel matches its index entry's. Requiring the entry to exist
#      also covers the direction the check above does not: it asserts index -> embeddings,
#      so a chunk whose slug is absent from the index is unguarded, and at runtime such a
#      chunk is still scored and served on its own accessLevel.
#   2. no slug in the admin category carries anything but 'admin', which catches the case
#      where both artifacts agree on the wrong level.
# Both artifacts are already known to parse and to hold array-shaped entries/chunks - the
# block above exits non-zero otherwise - so this re-read can assume that much. It does NOT
# verify per-record shape, so a record missing `slug` still throws here; the fail-closed
# wrapper below is what turns that into a blocked commit rather than a pass.
if ! LEVEL_VIOLATIONS=$(node -e "
    const idx = JSON.parse(require('fs').readFileSync('$INDEX_FILE','utf-8'));
    const emb = JSON.parse(require('fs').readFileSync('$EMBEDDINGS_FILE','utf-8'));
    const expected = new Map(idx.entries.map(e => [e.slug, e.accessLevel]));

    // Counted per slug rather than listed per chunk: a mislabeled article has dozens of
    // chunks and one remedy, so a whole-artifact relabel stays readable.
    const counts = new Map();
    for (const c of emb.chunks) {
      const want = expected.get(c.slug);
      // has() rather than a lone undefined check: an entry present but missing accessLevel
      // would otherwise be misreported as having no entry at all.
      const problem =
        !expected.has(c.slug)
          ? 'has no help-index.json entry, so nothing constrains its accessLevel'
          : want === undefined
            ? 'has a help-index.json entry with no accessLevel, so parity cannot be checked'
            : c.accessLevel !== want
              ? 'embeddings say ' + c.accessLevel + ', index says ' + want
              : null;
      if (problem !== null) {
        const key = c.slug + ': ' + problem;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }

    // Compares the top path segment, not an 'admin/' prefix: vectorize-help-content.ts
    // collapses a directory index to the directory itself, so a docs-site/docs/admin/index.md
    // yields the bare slug 'admin' and a prefix test would wave it through. Mirrors
    // CATEGORY_ACCESS_LEVELS in packages/scripts/help/loadHelpArticles.ts - keep in sync.
    const misfiled = new Set();
    for (const [artifact, records] of [['help-index.json', idx.entries], ['help-embeddings.json', emb.chunks]]) {
      for (const r of records) {
        if (r.slug.split('/')[0] === 'admin' && r.accessLevel !== 'admin') {
          misfiled.add(r.slug + ' in ' + artifact + ': accessLevel is ' + r.accessLevel + ', expected admin');
        }
      }
    }

    const lines = [
      ...[...counts].map(([key, n]) => key + ' (' + n + (n === 1 ? ' chunk)' : ' chunks)')),
      ...misfiled,
    ];
    if (lines.length) {
      console.log(lines.join('\n'));
    }
  "); then
  echo ""
  echo "❌ Could not compare help accessLevel across the two artifacts (see the error above)."
  echo "   The artifact is unreadable or malformed - regenerate it:"
  echo "     pnpm --filter @bike4mind/scripts help:regenerate"
  echo ""
  exit 1
fi

if [ -n "$LEVEL_VIOLATIONS" ]; then
  echo ""
  echo "❌ Help artifacts disagree about accessLevel - it is the only thing keeping admin-only docs out of a non-admin user's Help AI chat answers:"
  echo "$LEVEL_VIOLATIONS" | while read -r violation; do
    echo "   • $violation"
  done
  echo ""
  echo "   To fix, regenerate both artifacts from the corpus:"
  echo "     OPENAI_API_KEY=sk-... pnpm --filter @bike4mind/scripts help:regenerate"
  echo "   Then stage help-index.json and help-embeddings.json and commit again."
  echo ""
  exit 1
fi

exit 0
