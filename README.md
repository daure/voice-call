# Agent voice call MCP

A local stdio MCP server opens a Linux Electron app and rings the user. **Answer** connects a native OpenAI Realtime voice assistant to discuss the calling agent's context and questions. **Reject** returns a declined call. **Hang up** returns the transcript to MCP and leaves the window open for review. Initial context is available in a collapsible panel.

Requires a Linux desktop session, a microphone and speakers, and an OpenAI API key with billing and Realtime access. Answering starts paid API usage, billed separately from ChatGPT subscriptions.

## Install

Prebuilt releases target **Ubuntu 24.04 or newer on x86_64**. Node.js and Electron are bundled; Node, npm, a compiler, and a checkout are not needed on the target machine.

```bash
installer="$(mktemp)"
curl --proto '=https' --tlsv1.2 -fLsS \
  https://github.com/daure/voice-call/releases/latest/download/voice-call-installer.sh \
  -o "$installer" && sh "$installer"
rm -f "$installer"
export PATH="$HOME/.local/bin:$PATH"
voice-call doctor
```

The installer verifies SHA-256 before staging the archive. It installs versioned bundles in `${XDG_DATA_HOME:-$HOME/.local/share}/voice-call/versions/` and exposes `voice-call` through `~/.local/bin`. It does not require sudo or store credentials. Add `~/.local/bin` to your shell's PATH permanently if needed. Override locations with absolute `VOICE_CALL_INSTALL_DIR` and `VOICE_CALL_BIN_DIR` values; use `VOICE_CALL_VERSION=1.0.1` to choose a published version.

`voice-call doctor` checks desktop libraries, environment, and the Electron sandbox without making a provider request. If Ubuntu reports "No usable sandbox", run `voice-call setup-sandbox`, then repeat the doctor check. Sandbox setup uses sudo to install a path-scoped AppArmor profile; any replacement of that user-owned executable inherits the exception. It does not disable AppArmor globally or give the app root access. Repeat setup after installing a different version.

Rerun the installer to update and reconnect MCP. Existing MCP processes continue using their original version, so updates do not interrupt active calls. Old version directories remain available for rollback. Reinstall an older version with `VOICE_CALL_VERSION` and reconnect; run sandbox setup for that version too. The archive, installer, and `SHA256SUMS` are also available on the [Releases page](https://github.com/daure/voice-call/releases).

Typical Ubuntu runtime dependencies are `libgtk-3-0t64`, `libnss3`, `libgbm1`, and `libasound2t64`; a normal desktop installation usually has them. The doctor command names missing libraries. SHA-256 catches corruption, not a compromised release publisher: the installer and checksum file share GitHub's trust boundary.

## MCP configuration

```bash
export OPENAI_API_KEY='your-api-key'
```

Make the key available to the process that launches MCP, including OpenCode's background service when used. Its environment must also have `DISPLAY` or `WAYLAND_DISPLAY` and access to the desktop audio session. Keep credentials out of source control. `OPENAI_REALTIME_MODEL` defaults to `gpt-realtime`; transcription uses `gpt-4o-mini-transcribe` and output uses the `marin` voice.

Merge this OpenCode V2 configuration into the client's configuration. If its service cannot find your shell PATH, replace `voice-call` with the absolute path to `~/.local/bin/voice-call` (JSON does not expand `~`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "voice-call": {
        "type": "local",
        "command": ["voice-call", "mcp"],
        "environment": { "OPENAI_API_KEY": "{env:OPENAI_API_KEY}" },
        "timeout": { "execution": 960000 }
      }
    }
  }
}
```

Reconnect the MCP server after configuration. Check its connection with `opencode mcp list`. Other MCP clients can run `voice-call mcp` over stdio; set their tool execution timeout above the requested call duration.

MCP launches Electron on the first call and reuses the window for later calls. It sends call state over an inherited private IPC channel. The desktop workflow requires neither an HTTP listener nor a shared website token. `voice-call desktop` opens the idle app for inspection; calls must use the MCP-managed instance. On Wayland, the compositor may refuse automatic focus, so ringing and a desktop notification also announce the call.

## Development

Requires Node.js 22.20+. From a checkout:

```bash
npm ci
npm exec -- install-electron --no
npm run desktop
```

Source-based MCP uses `["node", "/absolute/path/voice-call/mcp.mjs"]`. If Ubuntu blocks the development executable, inspect and run `sh scripts/setup-sandbox.sh "$PWD/node_modules/electron/dist/electron"`. This uses sudo and the same scoped permission as an installed release.

Electron's renderer runs sandboxed with context isolation and without Node integration; the preload exposes a narrow call-control bridge. The main process validates IPC senders, blocks external navigation and popups, and permits audio capture only while connecting an answered call. The API key stays in the main process. Verify the development sandbox with `node_modules/.bin/electron --version`; do not disable sandboxing to work around a failed setup.

### Release

```bash
npm test
npm run test:desktop
npm run build:release
npm run test:release
```

The Linux x86_64 build uses a source allowlist, production npm dependencies, Electron 44.5.1, and Node 24.15.0 verified against a pinned upstream SHA-256. It writes a `.tar.xz`, a version-pinned installer, and `SHA256SUMS` into ignored `dist/`. Bundled runtime licenses and dependency license files travel with the archive.

GitHub Actions checks syntax, scans source/history with Gitleaks, runs offline tests and sandboxed desktop tests, then builds and verifies tagged releases on Ubuntu 24.04. It also smoke-tests the shipped desktop and installer before publishing. To release, update `package.json` and its lockfile version, commit on `main`, create an immutable `vX.Y.Z` tag matching the package version, and push the branch and tag. The workflow's built-in token publishes the assets; no provider key is needed. Main-branch pushes run checks without publishing.

## MCP tools

### `take-call`

```json
{
  "context": "The checkout deployment failed. The previous release is healthy and has no schema incompatibilities.",
  "questions": ["Should we roll back?", "Who should receive the incident update?"],
  "timeout_seconds": 900
}
```

`context` is required. `questions` defaults to an empty list. Combined context and questions must fit within 10,000 characters. `timeout_seconds` defaults to 900 and accepts 30–3600 seconds, including ringing and conversation. The example client timeout covers the default; increase it for longer calls.

The tool returns JSON as both text and structured content: `id`, `context`, `status`, timestamps, `history`, `incomplete`, and any `error`. History contains ordered `user` and `assistant` messages. Terminal statuses are `ended`, `declined`, and `failed`; failures set MCP `isError`. Progress notifications include the call ID and state, with updates at state changes or approximately every ten seconds while waiting.

### `get-call`

Supply `{"id":"CALL_UUID"}` to retrieve a call's current status or final transcript. The ID is available in `take-call` progress notifications and results. The same MCP process must remain running.

## Read-only voice tools

The Realtime assistant can explore `test-docs/` using three local tools. The Electron main process attaches an authenticated sideband WebSocket to the same OpenAI session and executes tool requests. Microphone and speaker audio remain on WebRTC. Tools run asynchronously, so conversation can continue while results are pending.

| Tool | Arguments | Result |
| --- | --- | --- |
| `glob` | `pattern`, optional `limit` (default 50, maximum 100) | Root-relative file paths; supports `*`, `**`, and `?` |
| `grep` | Literal `pattern`, optional `include` glob, `case_sensitive`, `limit` | Matching paths, 1-based line numbers, and text; defaults to all files, case-insensitive, 30 matches |
| `read_file` | Root-relative `path`, optional 1-based `offset`, `limit` | Numbered lines, total line count, and `next_offset`; defaults to 100 lines, maximum 200 |

The root is fixed to this project's `test-docs/`, independent of the process's working directory. Its seven fictional documents include a poem, a business use case, a love letter, a weekend itinerary, an incident report, a reading list, and garden notes. The sample documents contain cross-references for multi-file searches.

Tool results go to OpenAI and count toward context usage. Only place documents in this directory that you permit the assistant to read. Parent traversal, absolute paths, hidden names, symlinks, hard-linked files, binary input, and invalid UTF-8 are rejected or excluded. Keep this an operator-owned directory: these checks are not an OS sandbox against hostile concurrent filesystem changes.

Files are limited to 128 KiB. Reads and matches clip lines at 1,000 characters and text output at 12,000 characters. Discovery visits at most 1,000 entries and 17 directory levels; `truncated` and `skipped_files` indicate partial results. A call permits at most 100 tool requests and three concurrent executions. Tool errors are returned to the model; sideband connection failures fail the call. Hang-up stops file tools before draining transcription. Cancellation, expiry, and shutdown also close the sideband.

Try asking "Read the poem aloud", "What is the reservation desk's first-year value?", "Which documents mention the blue door?", or "Can you read ../server.mjs?" The last request must be rejected. The voice assistant can inspect documents but cannot execute commands or change files.

## Limits and failure handling

1. One call can be pending or active per MCP process. Unanswered calls expire after two minutes; the total deadline applies to answered calls too.
2. MCP cancellation, disconnection, deadlines, and desktop process loss end the wait and mark the call failed. These failures can return an empty, incomplete transcript. Disconnecting MCP closes its desktop window.
3. Closing a ringing window declines the call. Closing an answered window drains transcription before returning its result and exiting. An unresponsive renderer has an eight-second close fallback. If transcript delivery fails, press **Hang up** again to retry.
4. History lives in MCP and renderer memory, with at most 50 calls retained by MCP. Restarting loses it. A later call replaces the transcript shown in the review window.
5. Input transcription is asynchronous and may differ from what the model heard. Hang-up allows up to six seconds to drain transcription. `incomplete` flags pending or failed transcription, cancelled assistant generation, and connection failures. Assistant transcripts can contain generated words not played before hang-up or interruption; `interrupted` marks reported truncation.
6. The renderer supplies the transcript, so it is not an authoritative audit trail. Durable event capture is needed for production. The returned transcript contains spoken messages, not a separate file-tool audit log. The voice assistant cannot perform the calling agent's actions.

## Offline verification

```bash
npm test
npm run test:desktop
```

`npm test` covers call lifecycle, real stdio MCP, desktop cancellation and deadlines, file access boundaries, and tool results through a local WebSocket provider. The desktop test requires a Linux desktop and working sandbox; it launches the actual Electron window through MCP, mocks microphone/WebRTC/provider responses, and verifies ringing, Answer/Reject, the transcript, review-window retention, permission races, cancellation during draining, errors, and window closure. It removes `OPENAI_API_KEY` from its child environment and makes no billable requests. Screenshots are written to `/tmp/opencode/voice-call-incoming.png` and `/tmp/opencode/voice-call-complete.png`.

Live provider access, microphone capture, speaker output, and voice quality require a separate paid call.

## Optional browser demo

The loopback browser workflow uses a separate HTTP server and shared token:

```bash
export OPENAI_API_KEY='your-api-key'
export DEMO_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")"
npm start
```

Open the printed URL including `#token`, click **Enable ringing sound**, and keep the tab open. The context box shows the caller's context and questions. **Answer** requests microphone access. **Hang up** declines a ringing call or ends an answered call. Configure its MCP client to launch `node /absolute/path/voice-call/mcp.mjs --web` with the same `DEMO_TOKEN` and `PORT` (default `8787`). The website server owns the API key and sideband tools.

Authenticated HTTP callers can `POST /calls` with `{"context":"Ask me whether to roll back."}` and poll `GET /calls/RETURNED_ID` using `Authorization: Bearer TOKEN`. Optional `timeout_ms` accepts 1000–3600000 and defaults to 900000. Terminal callers can run:

```bash
DEMO_TOKEN='token-from-the-printed-URL' node server.mjs call 'The deployment failed. Ask me whether to roll back.'
```

The server binds to loopback; do not expose it to the internet. Browser calls have an additional ten-minute connection limit. Keep the tab open until delivery succeeds; press **Hang up** again to retry a failed delivery.

For the headed browser regression test, install `playwright-cli` and its browser prerequisites, leave port 18787 available, then run `npm run test:browser`. It tests the browser workflow with mocked voice APIs and no billable requests.
