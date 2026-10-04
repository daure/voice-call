import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const setup = fileURLToPath(new URL('../scripts/setup-sandbox.sh', import.meta.url));
async function executable(path) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'test executable');
  return path;
}
function profile(path) {
  const result = spawnSync('sh', [setup, '--print', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('sandbox policy covers future versions only inside the selected installation directory', async (t) => {
  const temp = await mkdtemp('/tmp/opencode/voice-call-sandbox-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const install = join(temp, 'voice-call');
  const first = await executable(join(install, 'versions', '1.0.1-local-first', 'runtime', 'electron', 'electron'));
  const second = await executable(join(install, 'versions', '2.0.0', 'runtime', 'electron', 'electron'));
  const policy = profile(first);
  assert.equal(profile(second), policy);
  assert.ok(policy.includes(`"${install}/versions/*/runtime/electron/electron"`));
  assert.match(policy, /profile voice-call-installed-[a-f0-9]{16}/);
  assert.match(policy, /userns,/);
  assert.doesNotMatch(policy, /\*\*/);
  const other = await executable(join(temp, 'other-app', 'versions', '1.0.1', 'runtime', 'electron', 'electron'));
  assert.notEqual(profile(other), policy);
  const alias = join(temp, 'current');
  await symlink(join(install, 'versions', '2.0.0'), alias);
  assert.equal(profile(join(alias, 'runtime', 'electron', 'electron')), policy);
  const parser = spawnSync('apparmor_parser', ['--skip-kernel-load', '--skip-cache'], { input: policy, encoding: 'utf8' });
  if (parser.error?.code !== 'ENOENT') assert.equal(parser.status, 0, parser.stderr);
});

test('development sandbox policy covers one exact executable and rejects unsafe paths', async (t) => {
  const temp = await mkdtemp('/tmp/opencode/voice-call-sandbox-dev-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const path = await executable(join(temp, 'node_modules', 'electron', 'dist', 'electron'));
  const policy = profile(path);
  assert.ok(policy.includes(`profile voice-call-electron "${path}"`));
  assert.doesNotMatch(policy, /\*/);
  const unsafe = await executable(join(temp, 'untrusted*path', 'electron'));
  const rejected = spawnSync('sh', [setup, '--print', unsafe], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /requires an executable path containing only/);
});
