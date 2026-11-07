#!/usr/bin/env bash
# GNU timeout's --signal=KILL applies the deadline to the whole process group.
set -eu

for candidate in gnutimeout timeout; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  version=$("$candidate" --version 2>/dev/null) || continue
  case "$version" in
    *'(GNU coreutils)'*) exec "$candidate" "$@" ;;
  esac
done

echo 'GNU coreutils timeout is required to enforce the Chromium installation deadline' >&2
exit 1
