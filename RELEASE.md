Linux desktop voice companion for MCP agents, with native OpenAI Realtime audio.

## Voice Call v1.0.2

- Say goodbye to end a call after the assistant's farewell audio finishes. Manual hang-up retains the review window.
- Choose the assistant voice before answering; `OPENAI_REALTIME_VOICE` defaults to `shimmer`.
- Read project files within the invoking OpenCode session's active directory, including moved sessions and worktrees.
- Inspect ordered file-tool activity alongside the transcript, with relative paths, line ranges, errors, and delivery status.
- Supply briefings up to 100,000 characters, subject to provider token limits. Wait acknowledgements use “Okay.”
- Develop with `npm start` and loopback HTTP MCP; package the checkout with `npm run install:app`.
- Use one Ubuntu sandbox setup per installation directory across builds, updates, and rollbacks.

## Install on Ubuntu 24.04+ x86_64

```sh
installer="$(mktemp)"
curl --proto '=https' --tlsv1.2 -fLsS \
  https://github.com/daure/voice-call/releases/latest/download/voice-call-installer.sh \
  -o "$installer" && sh "$installer"
rm -f "$installer"
export PATH="$HOME/.local/bin:$PATH"
voice-call doctor
```

Node.js and Electron are bundled. The installer checks the archive's SHA-256 and installs to your home directory without sudo. Ubuntu may need `voice-call setup-sandbox` once per installation directory. It uses sudo to load an AppArmor exception for that directory's `versions/*/runtime/electron/electron`, covering future updates and rollbacks. It does not disable sandboxing globally. Anyone able to create or replace a matching executable inherits the exception.

Configure your MCP client to run `voice-call mcp`, with `OPENAI_API_KEY` available in its launch environment. OpenCode V2 configuration and troubleshooting are in the README. Credentials are not shipped or stored by the installer. Calls use paid API credits.

The app rings with Answer/Reject controls, shows context in an accordion, and retains the transcript window after hang-up. Voice file tools are read-only and confined to the invoking OpenCode session's active working directory at call start. The MCP process resolves that directory through the OpenCode CLI and needs access to the same server as the caller. Retrieved project file contents go to OpenAI.

Offline tests cover call lifecycle, cancellation, deadlines, file boundaries, sandboxed desktop interactions, fresh installation, bundled stdio MCP, checksum rejection, and the shipped desktop. Live microphone, speaker, and provider behavior require a paid call; they are not verified by mock-provider tests.

Rerun the installer to update and reconnect MCP. Sandbox setup persists for the installation directory; moving it requires setup for the new location. Manual archives and `SHA256SUMS` are available below. SHA-256 detects corrupt downloads; the checksum file and installer share the GitHub release's trust boundary.
