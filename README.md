# Sirv Lens

Capture browser defects with their evidence, review them, and file them. See
[ARCHITECTURE.md](ARCHITECTURE.md).

## Install

Download the installer for your computer from the [latest release](https://github.com/VKrachun/native-browser-lens/releases/latest).
Each installs for your user only, without administrator rights.

| Computer | Installer | Then |
| --- | --- | --- |
| Mac | `Sirv-Lens-VERSION-macos-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel) | Drag Sirv Lens to Applications and open it. |
| Windows | `Sirv-Lens-VERSION-windows-x64-setup.exe` | Run it; Sirv Lens opens at the end. |
| Ubuntu, Debian | `sirv-lens_VERSION_amd64.deb` | Open it in Software, or `sudo apt install ./sirv-lens_VERSION_amd64.deb`, then open Sirv Lens. |
| Arch | `sirv-lens-VERSION-linux-x86_64-pacman.tar.gz` | Contains a `PKGBUILD` for `makepkg -si`. |
| Any Linux | `Sirv-Lens-VERSION-linux-x86_64.AppImage` | Allow it to run as a program (file Properties, Permissions), then open it. |

The first time Sirv Lens opens, it sets itself up: it starts at login with a tray icon, registers
with your browsers, and opens a page that shows how to add the browser extension. Open Sirv Lens
again to see that page. In a terminal, `lens open` does the same and `lens doctor` checks each step.

Prefer the terminal? `curl -fsSL https://github.com/VKrachun/native-browser-lens/releases/latest/download/install.sh | sh`
(PowerShell: `irm https://github.com/VKrachun/native-browser-lens/releases/latest/download/install.ps1 | iex`).

Make the installers for the computer you are on with `node scripts/package.mjs --formats <formats>`
(`app,dmg`, `nsis`, or `appimage,deb,pacman`; add `--gpu vulkan` or `--gpu metal` for the GPU
speech program). The release workflow builds all of them for a `v*` tag.

## Website

`site/` is lens.sirv.studio: the landing page, privacy policy, permissions, terms and support (the
pages the extension stores ask for), served by Cloudflare Workers static assets. Put the installers
in `site/downloads/` (not committed), then `node site/deploy.mjs` assembles `site/dist/` with a
download manifest, SHA256SUMS and an Arch PKGBUILD, and deploys (`--dry-run` only assembles).

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

## Agents (MCP)

`lens mcp` serves reviewed defects over stdio: `list_reviews`, `get_review` and
`read_review_file` (the rendered screenshots, redacted evidence and opted-in recordings). It reads
only what a person reviewed and changes nothing.

```sh
claude mcp add lens -- lens mcp
codex mcp add lens -- lens mcp
```

## VibeQ

Add the VibeQ address and your personal token in Lens Settings. The token stays in the system
secret store; `LENS_VIBEQ_TOKEN` overrides it for CI and automation. Filing a review again after
an error is always safe: Lens reconciles with VibeQ first and never creates a second task.
