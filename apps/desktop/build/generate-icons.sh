#!/usr/bin/env bash
#
# Regenerate the desktop app icons from icon.svg.
#
#   ./apps/desktop/build/generate-icons.sh
#
# macOS only: it uses Quick Look (qlmanage) to rasterise the SVG and iconutil to pack the
# .icns. ImageMagick's own SVG renderer silently drops the gradient-filled paths that make
# up the whole wheel, so qlmanage (WebKit) is the rasteriser and ImageMagick only ever
# handles the resulting PNG.
#
# Requires: qlmanage, iconutil (both system), magick (brew install imagemagick).

set -euo pipefail

cd "$(dirname "$0")"

SRC="icon.svg"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Rasterise well above the largest output so the downsamples stay clean.
RENDER=2048
cp "$SRC" "$WORK/icon.svg"
qlmanage -t -s "$RENDER" -o "$WORK" "$WORK/icon.svg" >/dev/null 2>&1

# Quick Look flattens onto white, so the mark's transparent corners come back opaque. The
# mark is a disc that fills its viewBox exactly, so a circular mask restores them; the two
# pixels of slack drop the white fringe the flatten left on the disc's antialiased rim.
magick "$WORK/icon.svg.png" \
  \( -size "${RENDER}x${RENDER}" xc:black -fill white \
     -draw "circle $((RENDER / 2)),$((RENDER / 2)) $((RENDER / 2)),2" \) \
  -alpha off -compose CopyOpacity -composite "$WORK/master.png"

# Inset the disc rather than letting it bleed. 824/1024 is Apple's icon grid, which every
# other macOS icon is drawn to; Windows and Linux have no such grid and only want the mark
# to stop short of the edge.
MACOS_INSET=0.8047
OTHER_INSET=0.92

emit() { # emit <size> <inset> <dest>
  local size="$1" inset="$2" dest="$3" inner
  inner=$(printf '%.0f' "$(echo "$size * $inset" | bc -l)")
  magick "$WORK/master.png" -resize "${inner}x${inner}" \
    -background none -gravity center -extent "${size}x${size}" \
    -strip "$dest"
}

# macOS .icns
ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET"
for pair in 16:1 16:2 32:1 32:2 128:1 128:2 256:1 256:2 512:1 512:2; do
  base="${pair%%:*}"
  scale="${pair##*:}"
  px=$((base * scale))
  if [ "$scale" = 1 ]; then
    name="icon_${base}x${base}.png"
  else
    name="icon_${base}x${base}@2x.png"
  fi
  emit "$px" "$MACOS_INSET" "$ICONSET/$name"
done
iconutil --convert icns --output icon.icns "$ICONSET"

# Windows .ico
ICO_LAYERS=()
for px in 16 24 32 48 64 128 256; do
  emit "$px" "$OTHER_INSET" "$WORK/ico_${px}.png"
  ICO_LAYERS+=("$WORK/ico_${px}.png")
done
magick "${ICO_LAYERS[@]}" -colors 256 icon.ico

# Linux
emit 512 "$OTHER_INSET" icon.png

# The renderer's favicon. Electron does not apply it to the window, but it is what the page
# shows anywhere it is opened as a page (devtools, electron-vite preview).
emit 256 "$OTHER_INSET" ../src/renderer/favicon.png

echo "wrote icon.icns, icon.ico, icon.png, ../src/renderer/favicon.png"
