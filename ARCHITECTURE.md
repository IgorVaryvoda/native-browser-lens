# Sirv Lens architecture

Lens captures browser defects with their evidence, lets a person review them, and files them.
This branch replaces both earlier lines (the Swift/SwiftUI/GTK app and the 0.2.x Windows/Linux builds).
They stay readable in git history as a reference for edge cases; no code or data carries over.

## Processes

```
 Browser (each profile)                     Per user
┌───────────────────────────┐  native    ┌───────────┐  local    ┌─────────────────────────┐
│ Extension (WXT, MV3)      │ messaging  │ lens      │  socket / │ lens daemon (lensd)     │
│  collector, side panel    │◄──────────►│ (shim)    │◄─────────►│  SQLite + blobs         │
│  notebook, review         │            └───────────┘  pipe     │  OS secret store        │
└───────────────────────────┘            ┌───────────┐           │  VibeQ outbox, Codex,   │
                           AI agents ───►│ lens mcp  │◄─────────►│  dictation, export,     │
                           people ──────►│ lens CLI  │           │  updates                │
                                         └───────────┘           └─────────────────────────┘
```

- **Extension**: the only UI, in the browser's side panel (Firefox: sidebar), next to the defect.
  One codebase for Chrome, Edge, Brave, Chromium and Firefox. Stores deliver and update it.
- **`lens`**: one Rust binary. The browser starts it as the native messaging host (shim); it relays
  frames to the daemon and starts the daemon when none runs. `lens daemon` is the daemon; the other
  subcommands are the CLI.
- **The daemon** is the only process that opens the notebook. One per user, guarded by a lock file,
  so any number of browser profiles, CLIs and agents share one store with no file mailboxes.

## Protocol

`src/protocol.rs` is the single definition. `cargo test` generates the TypeScript in
`extension/src/protocol/`; CI fails when the committed TypeScript differs. Frames are a u32 length
in native byte order plus JSON, the same on the browser pipe and the daemon socket. Replies are
capped at 1 MiB for every client, because Chrome refuses larger host messages; large blobs move in
chunks.

## Platforms

| | macOS | Windows | Linux |
|---|---|---|---|
| Data | `~/Library/Application Support/Sirv Lens` | `%LOCALAPPDATA%\Sirv\Lens` | `$XDG_DATA_HOME/sirv-lens` |
| Daemon endpoint | Unix socket, `0600`, in a `0700` folder | Named pipe, DACL: owner only | Unix socket in `$XDG_RUNTIME_DIR/sirv-lens` |
| Secrets | Keychain | Credential Manager | Secret Service; no file fallback |
| Host registration | Manifest per installed browser | Manifest + HKCU key per browser | Manifest per installed browser |
| Daemon outlives the shim | Own process group | Detached, breaks away from the browser's job | Own process group |

`LENS_HOME` puts all data and the endpoint under one folder (tests, portable runs). Binaries never
live in the data folder.

## Browsers

| Browser | Level | Why |
|---|---|---|
| Chrome, Edge, Brave, Chromium | Full | `debugger` (CDP) |
| Firefox | Limited | No `debugger`; `webRequest` and page probes |
| Safari | Not supported | No CDP |

## Decisions

1. Native side in Rust: one static binary, no runtime to ship; `keyring`, `interprocess`,
   `rusqlite`, `rmcp`, `whisper-rs`; release and updates as in Press (`cargo-packager`).
2. VibeQ filing over REST with an idempotency key and a durable outbox. MCP is for agents.
3. Recording: rrweb first; `tabCapture` + `MediaRecorder` for canvas, WebGL and video pages.
4. Dictation: the side panel records, the daemon transcribes locally with Whisper.
5. Codex runs in the daemon, in a temporary git worktree, with reviewed evidence only.
6. No capture outside the browser.
7. Updates: stores for the extension; a signed `latest.json` for `lens`, installed when the person
   says so; package-manager installs leave updates to the package manager.
8. No migration from earlier lines.

## Phases

1. Specification: protocol, data model, threat model, feature list from both earlier lines.
2. **Native core** (done): daemon, shim, CLI, store, endpoint, secret-store status, registration,
   CI on all three systems, end-to-end test with a real Chromium.
3. **Extension** (most done): collector (debugger and webRequest, redaction, ring buffer),
   projects with granted origins, capture with screenshot and evidence, annotations (Konva,
   perfect-freehand), rrweb recording and replay, notes with revisions, review. Still open: the
   collector state across service-worker restarts.
4. **Integrations** (started): review and export (done), VibeQ filing through a durable outbox
   (done: frozen attempt, member binding, reconciliation, missing-only uploads, receipt checks;
   the token lives in the OS secret store or LENS_VIBEQ_TOKEN). Still open: Codex
   investigation and fixes, the MCP server, dictation.
5. Release: CI matrix with signing, Chrome Web Store and AMO listings, package channels, installers.
6. Removal of the earlier lines and branches.

## Open checks

- Windows: the daemon must survive Chrome closing the host's job, and the pipe DACL must refuse
  another account. A pipe that another account creates first is refused by design: the daemon
  creates only the first instance; the client opens the pipe at identification level (no
  impersonation) and accepts it only when the pipe object's owner SID is its token's user or its
  token's default owner (Administrators for an elevated administrator). Another non-admin
  account's pipe matches neither; another administrator could already read the process. A test
  with two accounts is still open.
- Side panel microphone permission may need a one-time normal extension tab.
- Screenshots show typed text as pixels. Recordings mask inputs and evidence is redacted, but the
  review before filing must make the person check the screenshots and mask what is private.
- Native messaging from Flatpak and Snap browsers, per format.
