#!/bin/sh
# Install Switchback, the local-first coding agent from Harville Labs.
#
#   curl -fsSL https://switchback.sh/install.sh | sh
#   curl -fsSL https://switchback.sh/install.sh | sh -s -- --vscode
#
# Options:
#   --version <x.y.z>   or SWITCHBACK_VERSION       a specific release (default: the latest)
#   --dir <path>        or SWITCHBACK_INSTALL_DIR   where to put `switchback` (default: ~/.local/bin)
#   --vscode                                     also install the VS Code extension
#
# It downloads one binary for this machine from the GitHub release, checks it
# against the release's SHA256SUMS, and puts it in place. It never uses sudo and never edits your
# shell profile; if the directory isn't on your PATH, it says what to add.
#
# The source is scripts/install.sh in https://github.com/Harville-Labs/switchback;
# app.switchback.sh serves it, and scripts/install.ps1 is the Windows
# counterpart. SWITCHBACK_DOWNLOAD_URL and SWITCHBACK_RELEASES_API point it at a
# mirror (or a test server) instead of GitHub.

set -eu

# Everything runs from main at the bottom, so a download that's cut off
# partway through executes nothing.

say() { printf '%s\n' "$*"; }
fail() {
  printf 'switchback install: %s\n' "$*" >&2
  exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
Install Switchback: curl -fsSL https://switchback.sh/install.sh | sh -s -- [options]

  --version <x.y.z>   a specific release (default: the latest)     SWITCHBACK_VERSION
  --dir <path>        where to put `switchback` (default: ~/.local/bin) SWITCHBACK_INSTALL_DIR
  --vscode            also install the VS Code extension
  -h, --help          show this help

VS Code extension: https://marketplace.visualstudio.com/items?itemName=isaiah-harville.switchback
              or: https://open-vsx.org/extension/isaiah-harville/switchback
EOF
}

# fetch <url> <file>: fails on any HTTP error. HTTPS only unless the server
# itself was given as http:// (a local test server).
fetch() {
  if has curl; then
    curl --proto "$PROTO" --tlsv1.2 --fail --silent --show-error --location --retry 2 \
      --output "$2" "$1"
  elif has wget; then
    if [ "$PROTO" = '=https' ]; then
      wget --quiet --https-only --output-document="$2" "$1"
    else
      wget --quiet --output-document="$2" "$1"
    fi
  else
    fail 'needs curl or wget to download Switchback.'
  fi
}

sha256() {
  if has sha256sum; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif has shasum; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail 'needs sha256sum or shasum to verify the download.'
  fi
}

# verify <dir> <file>: check <dir>/<file> against <dir>/SHA256SUMS.
verify() {
  expected=$(awk -v f="$2" '$2 == f || $2 == "*" f { print $1; exit }' "$1/SHA256SUMS")
  [ -n "$expected" ] || fail "release $VERSION lists no checksum for $2."
  actual=$(sha256 "$1/$2")
  [ "$actual" = "$expected" ] ||
    fail "$2 doesn't match its checksum (expected $expected, got $actual). Nothing was installed; try again."
}

detect_platform() {
  case $(uname -s) in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    MINGW* | MSYS* | CYGWIN*)
      fail "this script is for macOS and Linux. On Windows, run this in PowerShell: irm https://switchback.sh/install.ps1 | iex" ;;
    *) fail "Switchback has no build for $(uname -s). It runs on macOS, Linux, and Windows." ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) ARCH=x64 ;;
    arm64 | aarch64) ARCH=arm64 ;;
    *) fail "Switchback has no build for $(uname -m) processors (only x64 and arm64)." ;;
  esac
  # A shell running under Rosetta reports x86_64 on an Apple silicon Mac.
  if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    ARCH=arm64
  fi
  if [ "$OS" = linux ] && { ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then
    fail "Switchback's Linux builds need glibc; Alpine and other musl systems aren't supported yet."
  fi
}

path_hint() {
  case ":${PATH}:" in
    *":$1:"*) return 0 ;;
  esac
  say ''
  say "$1 isn't on your PATH. Add it, then open a new terminal:"
  case $(basename "${SHELL:-sh}") in
    zsh) say "  echo 'export PATH=\"$1:\$PATH\"' >> ~/.zshrc" ;;
    bash)
      if [ "$OS" = darwin ]; then rc='~/.bash_profile'; else rc='~/.bashrc'; fi
      say "  echo 'export PATH=\"$1:\$PATH\"' >> $rc"
      ;;
    fish) say "  fish_add_path $1" ;;
    *) say "  export PATH=\"$1:\$PATH\"   (in your shell's startup file)" ;;
  esac
}

install_vscode() {
  vsix="switchback-vscode-$VERSION-$OS-$ARCH.vsix"
  say "Downloading the VS Code extension ($vsix)"
  fetch "$BASE/v$VERSION/$vsix" "$TMP/$vsix"
  verify "$TMP" "$vsix"
  for editor in code code-insiders codium cursor; do
    if has "$editor"; then
      "$editor" --install-extension "$TMP/$vsix" --force >/dev/null ||
        fail "$editor couldn't install the extension. Install $BASE/v$VERSION/$vsix from VS Code's Extensions view (… > Install from VSIX)."
      say "Installed the extension in $editor."
      return 0
    fi
  done
  say "No VS Code command line (code) found. Download $BASE/v$VERSION/$vsix and"
  say "install it from the Extensions view (… > Install from VSIX)."
}

RELEASES=https://github.com/Harville-Labs/switchback/releases

main() {
  VERSION=${SWITCHBACK_VERSION:-}
  DIR=${SWITCHBACK_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}
  BASE=${SWITCHBACK_DOWNLOAD_URL:-$RELEASES/download}
  BASE=${BASE%/}
  API=${SWITCHBACK_RELEASES_API:-https://api.github.com/repos/Harville-Labs/switchback/releases}
  VSCODE=
  while [ $# -gt 0 ]; do
    case $1 in
      --version) [ $# -ge 2 ] || fail '--version needs a value'; VERSION=$2; shift 2 ;;
      --version=*) VERSION=${1#*=}; shift ;;
      --dir) [ $# -ge 2 ] || fail '--dir needs a value'; DIR=$2; shift 2 ;;
      --dir=*) DIR=${1#*=}; shift ;;
      --vscode) VSCODE=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) fail "unknown option $1 (see --help)" ;;
    esac
  done
  case $BASE in
    https://*) PROTO='=https' ;;
    http://*) PROTO='=http,https' ;;
    *) fail "SWITCHBACK_DOWNLOAD_URL must be an http(s) URL, not $BASE" ;;
  esac

  detect_platform
  TMP=$(mktemp -d 2>/dev/null || mktemp -d -t switchback)
  trap 'rm -rf "$TMP"' EXIT
  trap 'rm -rf "$TMP"; exit 130' INT TERM

  if [ -z "$VERSION" ]; then
    # The newest release, prereleases included (GitHub's "latest" skips them,
    # and every 0.x release is one). Splitting on commas copes with JSON
    # whether or not it's pretty-printed.
    fetch "$API?per_page=1" "$TMP/releases" ||
      fail "couldn't look up the latest release (GitHub's API allows 60 lookups an hour per address). Choose one with --version; see $RELEASES."
    VERSION=$(tr ',' '\n' <"$TMP/releases" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
    [ -n "$VERSION" ] || fail "found no Switchback releases at $API."
  fi
  VERSION=${VERSION#v}
  case $VERSION in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) fail "\"$VERSION\" isn't a Switchback version (expected something like 0.5.0)." ;;
  esac

  file="switchback-$VERSION-$OS-$ARCH"
  say "Downloading Switchback $VERSION for $OS-$ARCH"
  fetch "$BASE/v$VERSION/SHA256SUMS" "$TMP/SHA256SUMS" ||
    fail "couldn't find Switchback $VERSION. See $RELEASES for releases."
  fetch "$BASE/v$VERSION/$file" "$TMP/$file"
  verify "$TMP" "$file"

  mkdir -p "$DIR" 2>/dev/null && [ -w "$DIR" ] ||
    fail "can't write to $DIR. Choose a directory you own with --dir."
  chmod 755 "$TMP/$file"
  mv -f "$TMP/$file" "$DIR/switchback"
  if [ "$OS" = darwin ]; then
    # Builds aren't notarized yet; a quarantine flag would make Gatekeeper refuse them.
    xattr -d com.apple.quarantine "$DIR/switchback" 2>/dev/null || true
  fi
  installed=$("$DIR/switchback" --version 2>/dev/null) ||
    fail "$DIR/switchback was installed but doesn't run. Please report this with the output of: $DIR/switchback --version"
  say "Installed Switchback $installed to $DIR/switchback"

  [ -z "$VSCODE" ] || install_vscode

  found=$(command -v switchback 2>/dev/null || true)
  if [ -n "$found" ] && [ "$found" != "$DIR/switchback" ]; then
    say ''
    say "Note: $found comes first on your PATH, so \`switchback\` runs that copy. Remove it, or put $DIR first."
  fi
  path_hint "$DIR"
  say ''
  say 'Next: run `switchback init` to choose your models, then `switchback` in a project.'
}

main "$@"
