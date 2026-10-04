import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, readlink, readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const temp = await mkdtemp('/tmp/opencode/voice-call-release-');
const assets = join(root, 'dist');
const archive = 'voice-call-x86_64-unknown-linux-gnu.tar.xz';
const home = join(temp, 'home');
const fakeBin = join(temp, 'fake-bin');
const installDir = join(home, '.local', 'share', 'voice-call');
const binary = join(home, '.local', 'bin', 'voice-call');
const env = { ...process.env, HOME: home, PATH: `${fakeBin}:/usr/bin:/bin`,
  XDG_DATA_HOME: join(home, '.local', 'share'), VOICE_CALL_BIN_DIR: join(home, '.local', 'bin'),
  VOICE_CALL_INSTALL_DIR: installDir, RELEASE_ASSETS: assets };
for (const key of ['OPENAI_API_KEY', 'DEMO_TOKEN', 'DISPLAY', 'WAYLAND_DISPLAY', 'VOICE_CALL_VERSION', 'VOICE_CALL_ELECTRON_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key];
function run(command, args, overrides = {}) {
  const result = spawnSync(command, args, { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 120_000 });
  if (result.error) throw result.error;
  return result;
}
function success(result) { assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout; }
const install = (overrides) => run('sh', [join(assets, 'voice-call-installer.sh')], overrides);

async function desktopSmoke(bundle) {
  const sessionRoot = join(temp, 'session-source');
  await mkdir(sessionRoot);
  await writeFile(join(sessionRoot, 'rules.rs'), 'fn poll_rules() {}\n');
  const executable = join(bundle, 'runtime', 'electron', 'electron');
  if (process.env.CI === 'true') {
    const setup = spawnSync('sh', [join(root, 'scripts', 'setup-sandbox.sh'), executable], { encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  }
  const guiEnv = { ...process.env, OPENAI_API_KEY: '' };
  delete guiEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [join(bundle, 'app', 'desktop', 'main.mjs'), '--mcp'], {
    env: guiEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let diagnostics = '';
  child.stderr.on('data', (data) => { diagnostics = (diagnostics + data).slice(-4000); });
  const id = randomUUID();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Packaged desktop timed out: ${diagnostics}`)), 20_000);
      child.on('message', (message) => {
         if (message?.type === 'ready') child.send({ type: 'call', call: { id, context: 'Offline packaged desktop smoke test.',
          status: 'ringing', history: [], incomplete: false }, toolsRoot: sessionRoot });
         if (message?.type === 'progress' && message.call?.status === 'ringing') {
          assert.equal(message.call.file_activity.root, 'session-source');
          child.send({ type: 'cancel', id, error: 'Offline smoke test complete' });
        }
        if (message?.type === 'result') {
          try {
            assert.equal(message.call.id, id);
            assert.equal(message.call.status, 'failed');
             assert.equal(message.call.error, 'Offline smoke test complete');
            assert.equal(message.call.file_activity.root, 'session-source');
            clearTimeout(timer); resolve();
          } catch (error) { clearTimeout(timer); reject(error); }
        }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Packaged desktop closed: ${diagnostics}`)); });
    });
  } finally { child.kill(); }
}

try {
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, 'curl'), await readFile(new URL('./fixtures/release-curl.sh', import.meta.url)), { mode: 0o755 });
  assert.match(success(install()), /Installed voice-call/);
  assert.equal(success(run(binary, ['--version'])).trim(), `voice-call ${version}`);
  assert.match(success(run(binary, ['--help'])), /Run the stdio MCP server/);
  const originalTarget = await readlink(join(installDir, 'current'));
  assert.match(success(install()), /Installed voice-call/);
  assert.equal(await readlink(join(installDir, 'current')), originalTarget);
  const client = new Client({ name: 'release-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: binary, args: ['mcp'], env, stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['take-call', 'get-call']);
    const result = await client.callTool({ name: 'take-call', arguments: { context: 'No desktop in this test.' } });
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /Linux desktop session/);
  } finally { await client.close(); }

  const corruptAssets = join(temp, 'corrupt');
  await mkdir(corruptAssets);
  await cp(join(assets, archive), join(corruptAssets, archive));
  await writeFile(join(corruptAssets, 'SHA256SUMS'), `${'0'.repeat(64)}  ${archive}\n`);
  const corrupt = install({ RELEASE_ASSETS: corruptAssets });
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /checksum verification failed/);
  assert.equal(await readlink(join(installDir, 'current')), originalTarget);
  assert.equal(success(run(binary, ['--version'])).trim(), `voice-call ${version}`);
  assert.deepEqual((await readdir(installDir)).filter((name) => name.startsWith('.staging.')), []);
  const conflictingBin = join(temp, 'conflicting-bin');
  await mkdir(conflictingBin);
  await writeFile(join(conflictingBin, 'voice-call'), 'owned by another app');
  assert.match(install({ VOICE_CALL_BIN_DIR: conflictingBin }).stderr, /unrelated voice-call executable/);
  assert.equal(await readFile(join(conflictingBin, 'voice-call'), 'utf8'), 'owned by another app');
  if (process.env.VOICE_CALL_SMOKE_GUI === '1') await desktopSmoke(originalTarget);
  console.log('Release verification passed: fresh install, bundled runtimes, MCP stdio without system Node/npm, repeat install, checksum rejection, destination protection, staging cleanup.');
  if (process.env.VOICE_CALL_SMOKE_GUI === '1') console.log('Installed desktop launch, ringing and cancellation passed (no provider calls).');
} finally { await rm(temp, { recursive: true, force: true }); }
