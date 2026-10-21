#!/bin/sh
# Install or update Bike4Mind Desktop:
#   curl -fsSL https://github.com/Bike4Mind/desktop-releases/releases/latest/download/install.sh | sh
# Optional: B4M_VERSION=0.6.0 pins a release, B4M_INSTALL_DIR overrides the install folder,
# B4M_NO_LAUNCH=1 skips opening the app on macOS.
set -eu

REPO="${B4M_RELEASE_REPOSITORY:-Bike4Mind/desktop-releases}"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Bike4Mind install failed: %s\n' "$*" >&2
  exit 1
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

resolve_tag() {
  if [ -n "${B4M_VERSION:-}" ]; then
    printf 'desktop-v%s' "${B4M_VERSION#v}"
    return
  fi
  url=$(curl -fsSIL --retry 3 --proto '=https' -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest") || fail "could not reach GitHub"
  tag=${url##*/}
  case "$tag" in
    desktop-v[0-9]*) printf '%s' "$tag" ;;
    *) fail "no published release found in $REPO" ;;
  esac
}

install_mac() {
  dir=${B4M_INSTALL_DIR:-}
  if [ -z "$dir" ]; then
    if [ -w /Applications ]; then dir=/Applications; else dir="$HOME/Applications"; fi
  fi
  mkdir -p "$dir"
  mount="$work/mount"
  mkdir "$mount"
  hdiutil attach "$1" -readonly -nobrowse -noautoopen -quiet -mountpoint "$mount" ||
    fail "could not open the disk image"
  staged="$dir/.Bike4Mind.app.partial"
  rm -rf "$staged"
  if ! ditto "$mount/Bike4Mind.app" "$staged"; then
    hdiutil detach "$mount" -quiet || true
    rm -rf "$staged"
    fail "could not copy the app into $dir"
  fi
  hdiutil detach "$mount" -quiet || true
  # curl never quarantines a download; clear the flag in case a proxy or MDM policy added one.
  xattr -dr com.apple.quarantine "$staged" 2>/dev/null || true
  codesign --verify --deep --strict "$staged" || {
    rm -rf "$staged"
    fail "the downloaded app failed signature verification"
  }
  dest="$dir/Bike4Mind.app"
  running=no
  if pgrep -f "$dest/Contents/MacOS/Bike4Mind" >/dev/null 2>&1; then running=yes; fi
  rm -rf "$dest"
  mv "$staged" "$dest"
  say "Installed Bike4Mind $version to $dest"
  if [ "$running" = yes ]; then
    say "Bike4Mind is running. Quit and reopen it to use $version."
  elif [ -z "${B4M_NO_LAUNCH:-}" ]; then
    open "$dest"
  fi
}

install_linux() {
  data="${XDG_DATA_HOME:-$HOME/.local/share}"
  dir=${B4M_INSTALL_DIR:-$data/bike4mind}
  bin="$HOME/.local/bin"
  mkdir -p "$dir" "$bin" "$data/applications"
  dest="$dir/Bike4Mind.AppImage"
  chmod 755 "$1"
  mv -f "$1" "$dest"
  ln -sf "$dest" "$bin/bike4mind"
  cat >"$data/applications/bike4mind.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Bike4Mind
Exec="$dest" %U
Terminal=false
Categories=Development;Utility;
EOF
  say "Installed Bike4Mind $version to $dest"
  if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    say "AppImages need FUSE 2. On Ubuntu or Debian: sudo apt install libfuse2t64 (or libfuse2)"
  fi
  case ":$PATH:" in
    *":$bin:"*) say "Start it from your app menu or run: bike4mind" ;;
    *) say "Start it from your app menu or run: $bin/bike4mind" ;;
  esac
}

main() {
  command -v curl >/dev/null 2>&1 || fail "curl is required"
  os=$(uname -s)
  arch=$(uname -m)
  case "$os/$arch" in
    Darwin/arm64) suffix=arm64.dmg ;;
    Darwin/x86_64)
      # A Rosetta shell reports x86_64 on Apple Silicon.
      if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
        suffix=arm64.dmg
      else
        fail "Intel Macs are not supported yet"
      fi
      ;;
    Linux/x86_64) suffix=x64.AppImage ;;
    *) fail "unsupported platform $os/$arch" ;;
  esac

  tag=$(resolve_tag)
  version=${tag#desktop-v}
  base="https://github.com/$REPO/releases/download/$tag"
  name="Bike4Mind-$version-$suffix"
  work=$(mktemp -d "${TMPDIR:-/tmp}/bike4mind.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  trap 'exit 130' INT TERM

  curl -fsSL --retry 3 --proto '=https' -o "$work/SHA256SUMS.txt" "$base/SHA256SUMS.txt" ||
    fail "release $tag was not found"
  expected=$(awk -v n="$name" '$2 == n { print $1 }' "$work/SHA256SUMS.txt")
  [ -n "$expected" ] || fail "$name is not part of release $tag"
  say "Downloading Bike4Mind $version..."
  curl -fL --retry 3 --proto '=https' --progress-bar -o "$work/$name" "$base/$name" ||
    fail "could not download $name"
  [ "$(sha256 "$work/$name")" = "$expected" ] || fail "checksum mismatch for $name"

  case "$os" in
    Darwin) install_mac "$work/$name" ;;
    Linux) install_linux "$work/$name" ;;
  esac
}

# Wrapped in main so a truncated `curl | sh` download runs nothing.
main "$@"
