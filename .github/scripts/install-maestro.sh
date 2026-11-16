#!/usr/bin/env bash
# Installs the pinned Maestro CLI (MAESTRO_VERSION / MAESTRO_SHA256 from the workflow env) and puts it on PATH
# for the later steps of a GitHub Actions job.
set -euo pipefail

: "${MAESTRO_VERSION:?}" "${MAESTRO_SHA256:?}"
dir="${RUNNER_TEMP:-/tmp}/maestro-install"
mkdir -p "$dir"
curl -fsSL -o "$dir/maestro.zip" "https://github.com/mobile-dev-inc/Maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip"
echo "${MAESTRO_SHA256}  $dir/maestro.zip" | shasum -a 256 -c -
unzip -q "$dir/maestro.zip" -d "$dir"
echo "$dir/maestro/bin" >> "${GITHUB_PATH:?}"
