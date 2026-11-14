#!/bin/sh
# Installs Sirv Lens for the current user on macOS or Linux, then registers it with the browsers.
#
#   curl -fsSL https://github.com/VKrachun/native-browser-lens/releases/latest/download/install.sh | sh
#   sh install.sh 0.2.0        # a specific version
#   LENS_DOWNLOAD_BASE=http://127.0.0.1:8000 sh install.sh 0.2.0   # a local release folder (tests)
#
# It writes one file, ~/.local/bin/lens (LENS_BIN_DIR changes it), plus the browsers' per-user
# native messaging manifests. Remove Lens with: lens unregister && rm ~/.local/bin/lens
set -eu

repo=${LENS_REPO:-VKrachun/native-browser-lens}
bin_dir=${LENS_BIN_DIR:-$HOME/.local/bin}
version=${1:-}
die() { echo "install.sh: $1" >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=x86_64-unknown-linux-musl ;;
  Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-musl ;;
  Darwin-arm64) target=aarch64-apple-darwin ;;
  Darwin-x86_64) target=x86_64-apple-darwin ;;
  *) die "no Lens build for $(uname -s) $(uname -m)" ;;
esac
command -v curl >/dev/null || die "curl is required"
if command -v sha256sum >/dev/null; then sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null; then sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "sha256sum or shasum is required"; fi

if [ -n "${LENS_DOWNLOAD_BASE:-}" ]; then
  [ -n "$version" ] || die "LENS_DOWNLOAD_BASE needs a version argument"
elif [ -z "$version" ]; then
  # /releases/latest redirects to the tag: no API call, no JSON parsing.
  tag=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") ||
    die "GitHub is unreachable"
  version=${tag##*/v}
fi
base=${LENS_DOWNLOAD_BASE:-https://github.com/$repo/releases/download/v$version}
asset="sirv-lens-$version-$target.tar.gz"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
echo "Downloading Lens $version for $target"
curl -fsSL -o "$work/$asset" "$base/$asset" || die "cannot download $asset"
curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" || die "cannot download SHA256SUMS"
# "hash  file" or "hash *file" (binary mode), depending on the tool that wrote it.
expected=$(awk -v asset="$asset" '{ name = $2; sub(/^\*/, "", name); if (name == asset) print $1 }' "$work/SHA256SUMS")
[ -n "$expected" ] || die "SHA256SUMS does not list $asset"
[ "$(sum "$work/$asset")" = "$expected" ] || die "the download does not match SHA256SUMS; nothing was installed"

tar -xzf "$work/$asset" -C "$work"
mkdir -p "$bin_dir"
# Replace through a rename, so a running daemon keeps its old file until it restarts.
install -m 0755 "$work/sirv-lens-$version-$target/lens" "$bin_dir/.lens.new"
mv -f "$bin_dir/.lens.new" "$bin_dir/lens"
"$bin_dir/lens" stop >/dev/null 2>&1 || true
"$bin_dir/lens" register

echo
echo "Lens $version is installed in $bin_dir/lens."
case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "Add $bin_dir to your PATH to use the lens command." ;; esac
echo "Next: add the Lens extension to your browser, open a site, and click the Lens button."
