#!/usr/bin/env bash
# Every local check, in order; the first failure stops it. Run before each commit.
#   scripts/check.sh          Rust, TypeScript, unit tests, both browser builds
#   scripts/check.sh --e2e    also the end-to-end test (needs Chromium)
set -euo pipefail
cd "$(dirname "$0")/.."

cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked   # also regenerates extension/src/protocol; CI checks it is committed

cd extension
pnpm compile
pnpm test
pnpm build:firefox >/dev/null
if [[ "${1:-}" == "--e2e" ]]; then
  (cd .. && cargo build --locked)
  LENS_E2E=1 pnpm build >/dev/null
  pnpm test:e2e
else
  pnpm build >/dev/null
fi
echo "All checks passed."
