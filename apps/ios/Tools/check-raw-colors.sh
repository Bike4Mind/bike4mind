#!/usr/bin/env bash
# Fails when app code uses a raw system red (.red, .systemRed) or the asset-catalog accent (.accentColor)
# instead of the palette tokens. Black/white canvases and the Widgets target are not checked.
set -euo pipefail

cd "$(dirname "$0")/.."

dirs=(Bike4Mind CaptureUI ShareExtension ActivityIntents)
for d in "${dirs[@]}"; do
  if [[ ! -d "$d" ]]; then
    echo "check-raw-colors: scan directory '$d' not found; update Tools/check-raw-colors.sh" >&2
    exit 2
  fi
done

# A leading dot not preceded by an identifier or closing bracket is an implicit member (.red, [.red, Color(.systemRed)).
pattern='(^|[^][:alnum:]_)!?])\.(red|systemRed|accentColor)\b|(Color|UIColor)\.(red|systemRed|accentColor)\b'

set +e
raw=$(grep -rnE "$pattern" --include='*.swift' "${dirs[@]}")
rc=$?
set -e
if [[ $rc -gt 1 ]]; then
  echo "check-raw-colors: grep failed (exit $rc)" >&2
  exit "$rc"
fi

hits=$(printf '%s\n' "$raw" | grep -v -e '^Bike4Mind/DesignSystem/DesignTokens.swift:' -e 'Tests/' -e '^$' || true)

if [[ -n "$hits" ]]; then
  echo "Raw colors found. Use Tokens.Palette.destructive / Tokens.Palette.brand (Bike4Mind/DesignSystem/DesignTokens.swift)" >&2
  echo "in the app, or BrandTheme.destructive / BrandTheme.accent (B4MKit) in CaptureUI, ShareExtension and ActivityIntents:" >&2
  echo "$hits" >&2
  exit 1
fi
