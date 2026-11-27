#!/usr/bin/env bash
# Fails when app code uses a raw system red or the asset-catalog accent instead of Tokens.Palette
# (Bike4Mind/DesignSystem/DesignTokens.swift). Black/white canvases and the Widgets target are not checked.
set -euo pipefail

cd "$(dirname "$0")/.."

hits=$(grep -rnE '(Color\.|[(:, ]\.)(red|accentColor)\b' --include='*.swift' \
  Bike4Mind CaptureUI ShareExtension ActivityIntents \
  | grep -v '^Bike4Mind/DesignSystem/DesignTokens.swift:' \
  | grep -v 'Tests/' || true)

if [[ -n "$hits" ]]; then
  echo "Raw colors found; use Tokens.Palette.destructive / Tokens.Palette.brand instead:" >&2
  echo "$hits" >&2
  exit 1
fi
