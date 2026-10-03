Linux desktop voice companion for MCP agents, with native OpenAI Realtime audio.

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

Node.js and Electron are bundled. The installer checks the archive's SHA-256 and installs to your home directory without sudo. Ubuntu may need `voice-call setup-sandbox`, which uses sudo to load a narrowly scoped AppArmor exception. It does not disable sandboxing globally. Any replacement at that executable path inherits the exception.

Configure your MCP client to run `voice-call mcp`, with `OPENAI_API_KEY` available in its launch environment. OpenCode V2 configuration and troubleshooting are in the README. Credentials are not shipped or stored by the installer. Calls use paid API credits.

The app rings with Answer/Reject controls, shows context in an accordion, and retains the transcript window after hang-up. Voice file tools are read-only and confined to the seven bundled fictional documents.

Offline tests cover call lifecycle, cancellation, deadlines, file boundaries, sandboxed desktop interactions, fresh installation, bundled stdio MCP, checksum rejection, and the shipped desktop. Live microphone, speaker, and provider behavior require a paid call; they are not verified by mock-provider tests.

Rerun the installer to update, reconnect MCP, and repeat sandbox setup if the installed version changed. Manual archives and `SHA256SUMS` are available below. SHA-256 detects corrupt downloads; the checksum file and installer share the GitHub release's trust boundary.
