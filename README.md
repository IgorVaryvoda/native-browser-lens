# Sirv Lens

Capture browser defects with their evidence, review them, and file them. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## Develop

Requirements: Rust (the version in `rust-toolchain.toml` installs by itself), Node.js 24, pnpm,
and Chromium for the end-to-end test.

```sh
cargo test                      # Rust tests; also regenerates extension/src/protocol
cargo build
lens register                   # target/debug/lens: register with your installed browsers
cd extension
pnpm install
pnpm build                      # .output/chrome-mv3; pnpm build:firefox for Firefox
LENS_E2E=1 pnpm build && pnpm test:e2e   # real Chromium, extension, shim, daemon, fixture site
```

Load `extension/.output/chrome-mv3` with **Load unpacked** in `chrome://extensions` and click the
Lens button. `lens status` shows the data folder and the daemon; `lens stop` stops the daemon.
