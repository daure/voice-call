# Agent voice call MCP

A local stdio MCP server opens a Linux Electron app and rings the user. **Answer** connects a native OpenAI Realtime voice assistant to discuss the calling agent's context and questions. **Reject** returns a declined call. **Hang up** returns the transcript to MCP and leaves the window open for review. Initial context is available in a collapsible panel.

Say "goodbye" or "you can hang up now" to end an answered call by voice. The assistant says a brief goodbye and invokes its internal `end_call` tool. The desktop app and browser wait for goodbye audio playback to finish, then disconnect and return the transcript and file activity. The desktop app exits after returning the result; MCP stays available and launches a fresh app for the next call. This tool is available even with file tools disabled; MCP exposes `take-call` and `get-call`.

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

`voice-call doctor` checks desktop libraries, environment, and the Electron sandbox without making a provider request. If Ubuntu reports "No usable sandbox", run `voice-call setup-sandbox`, then repeat the doctor check. Sandbox setup is a one-time sudo operation per installation directory: its AppArmor profile matches `versions/*/runtime/electron/electron` under that directory, covering future local builds, releases, and rollbacks. Moving the installation to another directory requires setup for the new location. Anyone able to create or replace a matching user-owned executable inherits the exception. It does not disable AppArmor globally or give the app root access. The installer checks persistent profile configuration; the doctor checks the live runtime.

Rerun the installer to update and reconnect MCP. Existing MCP processes continue using their original version, so updates do not interrupt active calls. Old version directories remain available for rollback. Reinstall an older version with `VOICE_CALL_VERSION` and reconnect. The directory-scoped sandbox profile covers every installed version. The archive, installer, and `SHA256SUMS` are also available on the [Releases page](https://github.com/daure/voice-call/releases).

Typical Ubuntu runtime dependencies are `libgtk-3-0t64`, `libnss3`, `libgbm1`, and `libasound2t64`; a normal desktop installation usually has them. The doctor command names missing libraries. SHA-256 catches corruption, not a compromised release publisher: the installer and checksum file share GitHub's trust boundary.

## MCP configuration

```bash
export OPENAI_API_KEY='your-api-key'
```

Make the key available to the process that launches MCP, including OpenCode's background service when used. Its environment must also have `DISPLAY` or `WAYLAND_DISPLAY` and access to the desktop audio session. Keep credentials out of source control. `OPENAI_REALTIME_MODEL` defaults to `gpt-realtime`; transcription uses `gpt-4o-mini-transcribe`. `OPENAI_REALTIME_VOICE` selects the output voice and defaults to `shimmer` when unset or blank.

Merge this OpenCode V2 configuration into the client's configuration. If its service cannot find your shell PATH, replace `voice-call` with the absolute path to `~/.local/bin/voice-call` (JSON does not expand `~`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "voice-call": {
        "type": "local",
        "command": ["voice-call", "mcp"],
        "environment": {
          "OPENAI_API_KEY": "{env:OPENAI_API_KEY}",
          "OPENAI_REALTIME_VOICE": "shimmer"
        },
        "timeout": { "execution": 960000 }
      }
    }
  }
}
```

Reconnect the MCP server after configuration. Check its connection with `opencode mcp list`. Other MCP clients can run `voice-call mcp` over stdio; set their tool execution timeout above the requested call duration.

For OpenCode calls, file tools use the invoking session's active working directory, including a moved session or worktree. OpenCode sends `_meta["ai.opencode/sessionID"]`; before ringing, voice-call reads that session's `location.directory` through `opencode api get /api/session/SESSION_ID`. The MCP process needs the `opencode` CLI on PATH and access to the same authenticated OpenCode server as the caller. Lookup failures reject the call rather than guessing a directory. The read-only root is pinned for the call; the next call resolves it again. The MCP config's folder and the app's installation folder do not select this root. Clients without OpenCode session metadata use the MCP process's launch directory.

Change `environment.OPENAI_REALTIME_VOICE` to choose `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, or `cedar`. Unsupported names fail locally before any provider request. Reconnect MCP after changing the value; the voice is fixed for each call once audio starts. This setting selects the voice, not its cadence: request speaking style in the briefing or during the conversation.

Choose any supported voice from **Assistant voice** while the desktop app is idle or ringing. An idle selection carries into the next call; a ringing selection applies to that call. The picker starts with the MCP-configured voice, locks when answering starts, and returns to the configured default when the call finishes. Changing the selection does not access the microphone or contact OpenAI. Trials use normal paid Realtime calls when answered. Set `OPENAI_REALTIME_VOICE` to your favourite voice for a permanent default.

MCP launches Electron when a call needs a window. Manual hang-up leaves the window open for review and reuse; assistant hang-up returns the result and exits Electron. It sends call state over an inherited private IPC channel. The desktop workflow requires neither an HTTP listener nor a shared website token. `voice-call desktop` opens the idle app for inspection; calls must use the MCP-managed instance. On Wayland, the compositor may refuse automatic focus, so ringing and a desktop notification also announce the call.

## Development

Requires Node.js 22.20+. From a checkout:

```bash
npm start
```

The command prepares npm dependencies and the Electron runtime, opens the desktop window, and serves development MCP at `http://127.0.0.1:7357/mcp`. Dependencies refresh when the lockfile changes. Each OpenCode call reads within its invoking session's active directory, resolved through the development process's OpenCode CLI connection. Set `OPENAI_API_KEY` and optional `OPENAI_REALTIME_VOICE` in the launching shell or a Git-ignored `.env` in the checkout; existing environment values take precedence. Restart development after changing the voice. The key and voice belong to the development process, so the remote MCP entry does not pass environment settings.

This checkout's `opencode.json` points to the development endpoint. Start `npm start`, reconnect that MCP server in OpenCode, then ask the agent to call you. Manual hang-up retains the transcript in the window. Assistant hang-up exits the app while the development server retains the result and accepts later calls. Manually closing the window or pressing Ctrl+C stops the development server. Set `VOICE_CALL_DEV_PORT` to select another port and update the client URL to match.

The endpoint accepts origin-free clients on IPv4 loopback, rejects browser origins and unexpected Host headers, and allows at most 32 MCP sessions. Local processes can call it without authentication and retrieve retained transcripts; run it only on a trusted machine. One shared desktop supports one pending or active call across all sessions. Terminating a client's MCP session cancels its own call while keeping the development window available to other clients. Losing one HTTP connection does not terminate its MCP session; cancellation, session termination, or deadlines release the call.

For stdio development, use `["node", "/absolute/path/voice-call/mcp.mjs"]` as the client command; it launches its own window. `npm run desktop` opens an independent idle window. If Ubuntu blocks the development executable, inspect and run `sh scripts/setup-sandbox.sh "$PWD/node_modules/electron/dist/electron"`. This uses sudo and the same scoped permission as an installed release.

Electron's renderer runs sandboxed with context isolation and without Node integration; the preload exposes a narrow call-control bridge. The main process validates IPC senders, blocks external navigation and popups, and permits audio capture only while connecting an answered call. The API key stays in the main process. Verify the development sandbox with `node_modules/.bin/electron --version`; do not disable sandboxing to work around a failed setup.

### Install the checkout locally

```bash
npm run install:app
```

The command prepares dependencies, packages the current source and `test-docs/`, and installs the resulting bundle as `~/.local/bin/voice-call`. Uncommitted source edits are included. Builds fetch npm dependencies and a checksum-verified Node runtime; installation uses local artifacts from `dist/`. The source allowlist excludes credentials, `.env`, and client configuration. Configure other projects with the installed stdio MCP command shown above.

Local builds use `versions/<version>-local-<archive-sha256>/`, so edited source can be installed under the same package version. Each build stays immutable, published version directories remain available, and a successful install switches the current symlink. Failed builds or checksum checks preserve the current installation. Rerun the command after source edits, reconnect MCP, and run `voice-call doctor`. The one-time Ubuntu sandbox setup covers all builds within the installation directory. Installation does not change OpenCode configuration or store API keys.

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

`context` is required. `questions` defaults to an empty list. Combined context and appended questions must fit within 100,000 characters; HTTP requests are bounded to 1,000,000 bytes to accommodate UTF-8 and JSON escaping. `timeout_seconds` defaults to 900 and accepts 30–3600 seconds, including ringing and conversation. The example client timeout covers the default; increase it for longer calls.

Send a self-contained briefing with project background, goals, current state, evidence or excerpts, constraints, prior decisions, attempted approaches, risks, and open questions. The voice assistant receives this briefing in its session instructions and retains it as background throughout the call. It can explore files within the call's read-only root but cannot see the calling agent's chat history or files outside that root. Include relevant excerpts to prime the discussion and exclude secrets. It opens with “Hi, I’m calling to <purpose>. Are you ready?”, describes the purpose in 3–8 words, and waits for confirmation before discussing the topic.

The assistant starts in English and switches languages only on the user's explicit request during the call. Accents, background audio, quoted text, and document language do not determine the response language. This is a model instruction, not an audio-language guarantee; verify it in a live call.

The character cap is an application bound, not a token allowance. The default `gpt-realtime` model has a 32k-token context window; instructions, tool schemas, and conversation share provider limits. Token usage varies by language and content, so dense briefings may exceed provider limits even below the character cap. Provider rejection fails the call without silently clipping the briefing. Larger briefings also increase input-token costs and leave less space for conversation history.

The tool returns JSON as both text and structured content: `id`, `context`, `status`, timestamps, `history`, `file_activity`, `incomplete`, and any `error`. History contains ordered `user` and `assistant` messages. Terminal statuses are `ended`, `declined`, and `failed`; failures set MCP `isError`. Progress notifications include the call ID and state, with updates during the call or approximately every ten seconds while waiting.

### `get-call`

Supply `{"id":"CALL_UUID"}` to retrieve a call's current status, transcript, and file activity. The ID is available in `take-call` progress notifications and results. The same MCP process must remain running.

### File activity

The tool executor records `file_activity` for desktop and browser calls. It contains a root label (the working directory's basename; `null` when file tools are disabled), a coverage flag `complete`, and ordered `calls`. Each entry has:

| Field | Meaning |
| --- | --- |
| `sequence`, `call_id`, `tool` | Request order, provider function-call ID, and tool name; duplicate IDs are recorded once |
| `arguments` | Submitted search patterns, paths, offsets, and limits; `null` for malformed JSON |
| `status` | `running` during execution, then `completed`, `failed`, or `cancelled` |
| `delivered_to_voice` | The result's WebSocket send completed successfully; it does not prove provider acceptance or assistant use |
| `result` | Metadata from a successful operation: glob paths; grep matching paths/line numbers, clipping flags and skipped files; read path, returned `line_ranges`, `total_lines`, `next_offset`, and `truncated` |
| `error` | A failed or cancelled operation's error |

Result metadata contains file references rather than document text. Grep paths identify returned matches, not every file scanned. Paths are relative to the labeled root; the log does not expose the root's absolute host path. Submitted arguments retain the assistant's search text and requested paths.

`complete` describes log coverage, independently of transcript `incomplete` and result `truncated`. It is false when the sideband fails, transport delivery remains uncertain, the desktop process is lost, or logging limits omit metadata. Logs retain at most 100 requests within a 256 KiB budget; `arguments_omitted`, `result_omitted`, or `error_omitted` identify omitted fields. Pending work becomes `cancelled` at hang-up. Calls without file requests return an empty `calls` array. The app owns this log; renderer-supplied file activity cannot override it.

## Read-only voice tools

The Realtime assistant can explore the calling session's working directory using three local tools. The Electron main process attaches an authenticated sideband WebSocket to the same OpenAI session and executes tool requests. Microphone and speaker audio remain on WebRTC. Tools run asynchronously, so conversation can continue while results are pending.

| Tool | Arguments | Result |
| --- | --- | --- |
| `glob` | `pattern`, optional `limit` (default 50, maximum 100) | Root-relative file paths; supports `*`, `**`, and `?` |
| `grep` | Literal `pattern`, optional `include` glob, `case_sensitive`, `limit` | Matching paths, 1-based line numbers, and text; defaults to all files, case-insensitive, 30 matches |
| `read_file` | Root-relative `path`, optional 1-based `offset`, `limit` | Numbered lines, total line count, and `next_offset`; defaults to 100 lines, maximum 200 |

All file paths are relative to the per-call root, so `src/service/rules.rs` refers to that path within the invoking session's directory. Calls from different sessions share the desktop but keep separate roots; a busy call rejects another caller without changing its root. Root selection travels over private MCP-to-desktop IPC, not model-controlled tool arguments or renderer input.

Tool results go to OpenAI and count toward context usage. Only use sessions whose working directory you permit the voice assistant to read. Parent traversal, absolute paths, hidden names, symlinks, hard-linked files, binary input, and invalid UTF-8 are rejected or excluded. Discovery skips `node_modules` and `target` directories so generated artifacts do not exhaust the search budget; explicit reads of regular files there remain subject to the same boundaries. Git ignore rules are not a confidentiality boundary: non-hidden project files may contain secrets, so keep sensitive files outside the accessible root. Keep this an operator-owned directory: these checks are not an OS sandbox against hostile concurrent filesystem changes.

Files are limited to 128 KiB. Reads and matches clip lines at 1,000 characters and text output at 12,000 characters. Discovery visits at most 1,000 entries and 17 directory levels; `truncated` and `skipped_files` indicate partial results. A call permits at most 100 tool requests and three concurrent executions. Tool errors are returned to the model; sideband connection failures fail the call. Hang-up stops file tools before draining transcription. Cancellation, expiry, and shutdown also close the sideband.

Try asking "Find poll_rules in the Rust source", "Read the matching function", or "Can you read ../private.txt?" Parent-directory reads are rejected. The voice assistant can inspect files but cannot execute commands or change them.

## Limits and failure handling

1. One call can be pending or active per MCP process. Unanswered calls expire after two minutes; the total deadline applies to answered calls too.
2. MCP cancellation, session termination, deadlines, and desktop process loss end the wait and mark the call failed. These failures can return an empty, incomplete transcript. Disconnecting stdio MCP closes its desktop window; the development server owns its shared window independently of clients.
3. Closing a ringing window declines the call. Closing an answered window drains transcription before returning its result and exiting. An unresponsive renderer has an eight-second close fallback. If transcript delivery fails, press **Hang up** again to retry.
4. History lives in MCP and renderer memory, with at most 50 calls retained by MCP. Restarting loses it. A later call replaces the transcript shown in the review window.
5. Input transcription is asynchronous and may differ from what the model heard. Hang-up allows up to six seconds to drain transcription. `incomplete` flags pending or failed transcription, cancelled assistant generation, and connection failures. Assistant transcripts can contain generated words not played before hang-up or interruption; `interrupted` marks reported truncation.
6. The renderer supplies the spoken transcript; the tool executor supplies file activity. Both live in memory and require durable event capture for a production audit trail. The voice assistant cannot perform the calling agent's actions.

## Offline verification

```bash
npm test
npm run test:desktop
```

`npm test` covers call lifecycle, real stdio and development HTTP MCP, shared-window ownership, session cancellation, request boundaries, dependency preparation, desktop deadlines, file access boundaries, and tool results through a local WebSocket provider. The desktop test requires a Linux desktop and working sandbox; it opens the actual development window and connects through HTTP MCP. It mocks microphone/WebRTC/provider responses and verifies ringing, Answer/Reject, the transcript, review-window retention, permission races, cancellation during draining, errors, and window closure. It removes `OPENAI_API_KEY` from its child environment and makes no billable requests. Screenshots are written to `/tmp/opencode/voice-call-incoming.png` and `/tmp/opencode/voice-call-complete.png`.

Live provider access, microphone capture, speaker output, and voice quality require a separate paid call.

## Optional browser demo

The loopback browser workflow uses a separate HTTP server and shared token:

```bash
export OPENAI_API_KEY='your-api-key'
export DEMO_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")"
npm run demo
```

Open the printed URL including `#token`, click **Enable ringing sound**, and keep the tab open. The context box shows the caller's context and questions. **Answer** requests microphone access. **Hang up** declines a ringing call or ends an answered call. Demo clients without OpenCode session metadata can launch `node /absolute/path/voice-call/mcp.mjs --web` with the same `DEMO_TOKEN` and `PORT` (default `8787`). The website server owns the API key and sideband tools, which read the seven fictional documents in bundled `test-docs/`. OpenCode sessions use desktop MCP or the development desktop endpoint for session-relative file access; the optional browser demo rejects their session-aware calls.

Authenticated HTTP callers can `POST /calls` with `{"context":"Ask me whether to roll back."}` and poll `GET /calls/RETURNED_ID` using `Authorization: Bearer TOKEN`. Optional `timeout_ms` accepts 1000–3600000 and defaults to 900000. Terminal callers can run:

```bash
DEMO_TOKEN='token-from-the-printed-URL' node server.mjs call 'The deployment failed. Ask me whether to roll back.'
```

The server binds to loopback; do not expose it to the internet. Browser calls have an additional ten-minute connection limit. Keep the tab open until delivery succeeds; press **Hang up** again to retry a failed delivery.

For the headed browser regression test, install `playwright-cli` and its browser prerequisites, leave port 18787 available, then run `npm run test:browser`. It tests the browser workflow with mocked voice APIs and no billable requests.
