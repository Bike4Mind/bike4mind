#!/usr/bin/env bash
# Resolve which publishable packages an auto-changeset should bump.
#
# The changed-file list (read from stdin) is the only source of truth. A PR title
# scope must never on its own bump a package the diff does not touch: that shipped
# version bumps and changelog entries for packages a PR never modified. The scope
# argument is therefore used only for reporting -- when it names a publishable
# package with no changed files, "unmatched-scope: <name>" goes to stderr so the
# caller can tell the author instead of silently guessing.
#
# Usage: git diff --name-only BASE HEAD | resolve-changeset-packages.sh "$SCOPE"
# Stdout: one package name per line, sorted. Stderr: diagnostics.
#
# Kept free of bash 4 features (associative arrays) so it runs under the bash 3.2
# that ships with macOS, where contributors verify it. See
# .github/workflows/auto-changeset.yml for the caller and
# resolve-changeset-packages.test.sh for the cases this must satisfy.

set -euo pipefail

SCOPE="${1:-}"

ignore_list=""
if [ -f .changeset/config.json ]; then
  ignore_list=$(python3 -c '
import json, sys
print("\n".join(json.load(open(sys.argv[1])).get("ignore", [])))
' .changeset/config.json 2>/dev/null || echo "")
fi

# Lines of "<dir><TAB><package name>".
publishable=""
for pkg_json in b4m-core/*/package.json apps/*/package.json packages/*/package.json; do
  [ -f "$pkg_json" ] || continue
  dir=$(dirname "$pkg_json")

  fields=$(python3 -c '
import json, sys
p = json.load(open(sys.argv[1]))
print(p.get("name", ""), "publishConfig" in p, bool(p.get("private", False)))
' "$pkg_json")
  name=$(printf '%s' "$fields" | cut -d' ' -f1)
  has_publish=$(printf '%s' "$fields" | cut -d' ' -f2)
  is_private=$(printf '%s' "$fields" | cut -d' ' -f3)

  [ -n "$name" ] || continue
  [ "$has_publish" = "True" ] || continue
  [ "$is_private" = "False" ] || continue
  if [ -n "$ignore_list" ] && printf '%s\n' "$ignore_list" | grep -qxF "$name"; then
    continue
  fi

  publishable="${publishable}${dir}	${name}
"
  echo "  Publishable: $dir -> $name" >&2
done

if [ -z "$publishable" ]; then
  echo "::warning::No publishable packages found in workspace." >&2
  exit 0
fi

changed=""
while IFS= read -r file || [ -n "$file" ]; do
  [ -n "$file" ] || continue
  while IFS="	" read -r dir name; do
    [ -n "$dir" ] || continue
    case "$file" in
      "$dir"/*)
        changed="${changed}${name}
"
        break
        ;;
    esac
  done <<EOF
$publishable
EOF
done

changed=$(printf '%s' "$changed" | sed '/^$/d' | sort -u)

if [ -n "$SCOPE" ]; then
  IFS=',' read -r -a scopes <<<"$SCOPE"
  for s in "${scopes[@]}"; do
    s=$(printf '%s' "$s" | tr -d ' ')
    [ -n "$s" ] || continue
    pkg=$(printf '%s' "$publishable" |
      awk -F"	" -v s="$s" '{ short = $2; sub(/.*\//, "", short); if (short == s) print $2 }' |
      head -1)
    [ -n "$pkg" ] || continue
    if ! printf '%s\n' "$changed" | grep -qxF "$pkg"; then
      echo "unmatched-scope: $pkg" >&2
    fi
  done
fi

if [ -n "$changed" ]; then
  printf '%s\n' "$changed"
fi
