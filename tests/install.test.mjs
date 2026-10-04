import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, chmod, readdir, readlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'voice-call-x86_64-unknown-linux-gnu';
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;

test('local installation updates same-version source snapshots and preserves prior builds on failure', async (t) => {
  const temp = await mkdtemp('/tmp/opencode/voice-call-local-install-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const assets = join(temp, 'assets'), source = join(temp, 'source');
  const bundle = join(source, name), installDir = join(temp, 'installed'), binDir = join(temp, 'bin');
  await mkdir(join(bundle, 'bin'), { recursive: true });
  await mkdir(assets);
  await writeFile(join(bundle, 'VERSION'), `${version}\n`);
  await cp(join(root, 'scripts', 'launcher.sh'), join(bundle, 'bin', 'voice-call'));
  await cp(join(root, 'scripts', 'setup-sandbox.sh'), join(bundle, 'bin', 'setup-sandbox'));
  await mkdir(join(bundle, 'runtime', 'electron'), { recursive: true });
  await writeFile(join(bundle, 'runtime', 'electron', 'electron'), 'fixture runtime');
  await chmod(join(bundle, 'bin', 'voice-call'), 0o755);
  const existingVersion = join(installDir, 'versions', version);
  await mkdir(existingVersion, { recursive: true });
  await writeFile(join(existingVersion, 'published-marker'), 'preserve published version');
  const fakeBin = join(temp, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'curl'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, VOICE_CALL_VERSION: version,
    VOICE_CALL_LOCAL_ASSETS: assets, VOICE_CALL_INSTALL_DIR: installDir, VOICE_CALL_BIN_DIR: binDir };
  const install = () => spawnSync('sh', [join(root, 'scripts', 'installer.sh')], { env, encoding: 'utf8', timeout: 15_000 });
  const success = () => { const result = install(); assert.equal(result.status, 0, result.stderr); };
  async function build(text) {
    await writeFile(join(bundle, 'source-marker'), text);
    const archive = join(assets, `${name}.tar.xz`);
    const tar = spawnSync('tar', ['-cJf', archive, '-C', source, name], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(join(assets, 'SHA256SUMS'), `${hash}  ${name}.tar.xz\n`);
    return join(installDir, 'versions', `${version}-local-${hash}`);
  }

  const first = await build('first checkout snapshot');
  success();
  assert.equal(await readlink(join(installDir, 'current')), first);
  assert.equal(await readFile(join(first, 'source-marker'), 'utf8'), 'first checkout snapshot');
  success();
  assert.equal(await readlink(join(installDir, 'current')), first);
  const second = await build('edited checkout snapshot');
  assert.notEqual(second, first);
  success();
  assert.equal(await readlink(join(installDir, 'current')), second);
  assert.equal(await readFile(join(second, 'source-marker'), 'utf8'), 'edited checkout snapshot');
  assert.equal(await readFile(join(first, 'source-marker'), 'utf8'), 'first checkout snapshot');
  assert.equal(await readFile(join(existingVersion, 'published-marker'), 'utf8'), 'preserve published version');
  assert.equal(await readlink(join(binDir, 'voice-call')), join(installDir, 'current', 'bin', 'voice-call'));
  const cli = spawnSync(join(binDir, 'voice-call'), ['--version'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), `voice-call ${version}`);
  const sandboxPolicy = (destination) => {
    const result = spawnSync('sh', [join(destination, 'bin', 'setup-sandbox'), '--print',
      join(destination, 'runtime', 'electron', 'electron')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(sandboxPolicy(second), sandboxPolicy(first));
  assert.ok(sandboxPolicy(second).includes(`"${installDir}/versions/*/runtime/electron/electron"`));

  await writeFile(join(assets, 'SHA256SUMS'), `${'0'.repeat(64)}  ${name}.tar.xz\n`);
  const corrupt = install();
  assert.notEqual(corrupt.status, 0);
  assert.match(corrupt.stderr, /checksum verification failed/);
  assert.equal(await readlink(join(installDir, 'current')), second);
  assert.deepEqual((await readdir(installDir)).filter((entry) => entry.startsWith('.staging.')), []);
});
