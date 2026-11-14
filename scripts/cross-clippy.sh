#!/usr/bin/env bash
# Clippy for Windows and macOS from Linux, so platform code is checked before CI runs it.
# Needs zig as the C compiler for the bundled C code: `zig` on PATH, ZIG=/path/to/zig, or
# `pip install ziglang` (then python3 -m ziglang). Without zig it says so and exits 0.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${ZIG:-}" ]]; then zig=("$ZIG")
elif command -v zig >/dev/null; then zig=(zig)
elif python3 -c 'import ziglang' 2>/dev/null; then zig=(python3 -m ziglang)
else echo "cross-clippy: zig not found; skipped (CI still checks every platform)"; exit 0; fi

tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT
wrap() { # name, zig target; drops the --target flags cc-rs passes, which zig spells differently
  cat > "$tools/$1" <<SCRIPT
#!/bin/sh
for a; do shift; case "\$a" in --target=*|-arch|arm64|-mmacosx-version-min=*) ;; *) set -- "\$@" "\$a";; esac; done
exec ${zig[*]} cc -target $2 "\$@"
SCRIPT
  chmod +x "$tools/$1"
}
wrap cc-windows x86_64-windows-gnu
wrap cc-macos aarch64-macos
printf '#!/bin/sh\nexec %s ar "$@"\n' "${zig[*]}" > "$tools/ar" && chmod +x "$tools/ar"

rustup target add x86_64-pc-windows-gnu aarch64-apple-darwin >/dev/null
RUSTC_WRAPPER= CC_x86_64_pc_windows_gnu="$tools/cc-windows" AR_x86_64_pc_windows_gnu="$tools/ar" \
  cargo clippy --all-targets --locked --target x86_64-pc-windows-gnu -- -D warnings
RUSTC_WRAPPER= CC_aarch64_apple_darwin="$tools/cc-macos" AR_aarch64_apple_darwin="$tools/ar" \
  cargo clippy --all-targets --locked --target aarch64-apple-darwin -- -D warnings
echo "cross-clippy: Windows and macOS are clean."
