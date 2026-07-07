#!/usr/bin/env bash
# Clone premium overlay packages into their workspace locations for local development.
# Iterates every repo pinned in premium-overlay.lock.json (no per-package edit needed
# when a new overlay is added) and hydrates each at its pinned ref. The workspace dir
# is derived by stripping the 'b4m-' prefix: b4m-overwatch -> packages/premium/overwatch.
# Per overlay: no-op if it already exists; no-op if your gh CLI lacks access to that
# repo (open-core devs skip everything). After cloning, run `pnpm install`.
#
# Usage: pnpm bootstrap:premium
#
# Env (override the org, or select which overlays to hydrate):
#   PREMIUM_OVERLAY_OWNER=Bike4Mind   # GitHub org/owner the overlays are cloned from
#   PREMIUM_OVERLAYS=optihashi,libreoncology
#                                     # Comma-separated short names (the packages/premium/<name>
#                                     # dir names) to hydrate. Unset = all overlays pinned in the
#                                     # lock file (default). Set to an empty string to hydrate none.
set -euo pipefail

LOCK_FILE="premium-overlay.lock.json"

cd "$(git rev-parse --show-toplevel)"

if [ ! -f "${LOCK_FILE}" ]; then
  echo "Error: ${LOCK_FILE} not found" >&2
  exit 1
fi

# Emit one "repo<TAB>ref" line per key in the lock file. Guard the command
# substitution explicitly: a failure here does not trip `set -e` in an assignment,
# so bad JSON would otherwise yield an empty list and a silent no-op.
pairs=$(python3 -c "import json; print('\n'.join(f'{k}\t{v}' for k, v in json.load(open('${LOCK_FILE}')).items()))") \
  || { echo "Error: could not read ${LOCK_FILE} (bad JSON or file not found)." >&2; exit 1; }

if [ -z "${pairs}" ]; then
  echo "No premium overlays pinned in ${LOCK_FILE} — nothing to bootstrap."
  exit 0
fi

# Overlay selection: unset PREMIUM_OVERLAYS means "all" (existing default behavior).
# Setting it (even to "") switches to selection mode, matched against short names
# derived from this run's own lock-file keys - never a second, hardcodable list.
select_all=1
requested=""
if [ "${PREMIUM_OVERLAYS+set}" = "set" ]; then
  select_all=0
  requested=$(echo "${PREMIUM_OVERLAYS}" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' || true)
fi

cloned=0 present=0 skipped=0 unselected=0

while IFS=$'\t' read -r key ref; do
  [ -n "${key}" ] || continue

  # Reject a malformed key before it is spliced into the repo name and (via the
  # derived overlay_dir) into rm -rf in the ERR trap. Keys are maintainer-controlled
  # lockfile entries, but validate anyway: require the 'b4m-' prefix and repo-safe
  # characters so a key like 'b4m-..' or 'b4m-foo/../bar' can't escape packages/premium/.
  if ! echo "${key}" | grep -qE '^b4m-[A-Za-z0-9_][A-Za-z0-9._-]*$' || echo "${key}" | grep -q '\.\.'; then
    echo "Error: malformed key in ${LOCK_FILE}: ${key}" >&2
    exit 1
  fi

  # Short name (e.g. b4m-overwatch -> overwatch) is what PREMIUM_OVERLAYS selects by,
  # matching the packages/premium/<name> dir name used everywhere else.
  short="${key#b4m-}"

  if [ "${select_all}" -eq 0 ] && ! printf '%s\n' "${requested}" | grep -qxF "${short}"; then
    unselected=$((unselected + 1))
    continue
  fi

  repo="${PREMIUM_OVERLAY_OWNER:-Bike4Mind}/${key}"
  # Workspace dir: strip the 'b4m-' prefix (b4m-overwatch -> overwatch).
  overlay_dir="packages/premium/${short}"

  # Reject a malformed ref before it reaches git checkout: a leading '-' would be
  # parsed as an option, and '..' is path traversal. Accept a 40-char SHA or a
  # branch/tag starting alphanumeric.
  if ! echo "${ref}" | grep -qE '^([0-9a-f]{40}|[A-Za-z0-9_][A-Za-z0-9._/-]*)$' || echo "${ref}" | grep -q '\.\.'; then
    echo "Error: malformed ${key} ref in ${LOCK_FILE}: ${ref}" >&2
    exit 1
  fi

  if [ -d "${overlay_dir}" ]; then
    echo "✓ ${key}: already present at ${overlay_dir} (refresh: rm -rf ${overlay_dir} && pnpm bootstrap:premium)"
    present=$((present + 1))
    continue
  fi

  if ! gh repo view "${repo}" --json name >/dev/null 2>&1; then
    echo "– ${key}: no access to ${repo} — skipping (open-core forks build without this premium overlay)."
    skipped=$((skipped + 1))
    continue
  fi

  # If checkout fails after a successful clone, remove the partial overlay rather
  # than leaving it at the default branch — a later run would see the directory,
  # report "already present", and mask the wrong-ref state. Scoped to this overlay
  # so a failure here does not wipe an overlay cloned earlier in the loop.
  cleanup_on_error() { rm -rf "${overlay_dir}"; }
  trap cleanup_on_error ERR

  echo "Cloning ${repo} at ${ref}..."
  gh repo clone "${repo}" "${overlay_dir}"
  git -C "${overlay_dir}" checkout "${ref}"
  trap - ERR
  cloned=$((cloned + 1))
done <<< "${pairs}"

# Typo guard: warn about any requested name that matched no key in the lock file,
# comparing against this run's own lock-derived short names (never a second list).
if [ "${select_all}" -eq 0 ] && [ -n "${requested}" ]; then
  available=$(printf '%s\n' "${pairs}" | cut -f1 | sed 's/^b4m-//')
  while IFS= read -r name; do
    [ -n "${name}" ] || continue
    if ! printf '%s\n' "${available}" | grep -qxF "${name}"; then
      echo "Warning: PREMIUM_OVERLAYS requested '${name}', which matches no key in ${LOCK_FILE}. Available: $(printf '%s' "${available}" | tr '\n' ' ')" >&2
    fi
  done <<< "${requested}"
fi

echo "Premium overlay bootstrap: ${cloned} cloned, ${present} already present, ${skipped} skipped (no access), ${unselected} unselected."
if [ "${cloned}" -gt 0 ]; then
  echo "Run 'pnpm install' to wire up the workspace."
fi
