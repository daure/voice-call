import { cp, mkdir, readFile, writeFile, mkdtemp, rm, chmod, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = manifest.version;
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build on Linux x86_64.');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable package version.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('Tag must match package.json.');

const name = 'voice-call-x86_64-unknown-linux-gnu';
const output = join(root, 'dist');
await mkdir(output, { recursive: true });
const work = await mkdtemp(join(output, '.build-'));
const bundle = join(work, name);
const nodeVersion = '24.15.0';
const nodeChecksum = '472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6';

function run(command, args, cwd = root, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function download(url, path) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} from ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
}
async function checkFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (/^(\.env(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx))$/.test(entry.name)) throw new Error(`Forbidden release filename: ${entry.name}`);
    if (entry.isDirectory()) await checkFiles(path);
    else if (entry.isFile() && (await lstat(path)).size < 2_000_000) {
      const text = await readFile(path, 'utf8');
      if (/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}|\bgh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{32,}/.test(text)) {
        throw new Error(`Potential secret in release file: ${entry.name}`);
      }
    }
  }
}

try {
  await mkdir(join(bundle, 'app'), { recursive: true });
  const sources = ['package.json', 'package-lock.json', 'mcp.mjs', 'session-root.mjs', 'server.mjs', 'voice-session.mjs',
    'file-tools.mjs', 'file-activity.mjs', 'realtime-tools.mjs', 'history.mjs', 'end-call.mjs', 'browser.mjs', 'index.html', 'scenarios.mjs', 'test-docs'];
  for (const source of sources) await cp(join(root, source), join(bundle, 'app', source), { recursive: true });
  await mkdir(join(bundle, 'app', 'desktop'));
  for (const source of ['caller.mjs', 'control.mjs', 'main.mjs', 'preload.cjs', 'renderer.mjs', 'index.html', 'style.css']) {
    await cp(join(root, 'desktop', source), join(bundle, 'app', 'desktop', source));
  }
  await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], join(bundle, 'app'));
  // Electron is shipped as a runtime, not an npm bootstrap that can download on startup.
  for (const dependency of ['electron', '@electron', '@electron-internal', '@types']) {
    await rm(join(bundle, 'app', 'node_modules', dependency), { recursive: true, force: true });
  }
  await rm(join(bundle, 'app', 'node_modules', '.bin'), { recursive: true, force: true });
  await mkdir(join(bundle, 'runtime'), { recursive: true });
  await cp(join(root, 'node_modules', 'electron', 'dist'), join(bundle, 'runtime', 'electron'), { recursive: true });
  await chmod(join(bundle, 'runtime', 'electron', 'chrome-sandbox'), 0o755);
  const nodeArchive = join(work, 'node.tar.xz');
  await download(`https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz`, nodeArchive);
  if (await checksum(nodeArchive) !== nodeChecksum) throw new Error('Node runtime checksum mismatch.');
  await run('tar', ['-xJf', nodeArchive, '-C', work]);
  await mkdir(join(bundle, 'runtime', 'node', 'bin'), { recursive: true });
  await cp(join(work, `node-v${nodeVersion}-linux-x64`, 'bin', 'node'), join(bundle, 'runtime', 'node', 'bin', 'node'));
  await cp(join(work, `node-v${nodeVersion}-linux-x64`, 'LICENSE'), join(bundle, 'runtime', 'node', 'LICENSE'));
  await mkdir(join(bundle, 'bin'));
  await cp(join(root, 'scripts', 'launcher.sh'), join(bundle, 'bin', 'voice-call'));
  await cp(join(root, 'scripts', 'setup-sandbox.sh'), join(bundle, 'bin', 'setup-sandbox'));
  await chmod(join(bundle, 'bin', 'voice-call'), 0o755);
  await chmod(join(bundle, 'bin', 'setup-sandbox'), 0o755);
  await writeFile(join(bundle, 'VERSION'), `${version}\n`);
  for (const file of ['README.md', 'LICENSE']) await cp(join(root, file), join(bundle, file));
  await checkFiles(bundle);
  const archive = `${name}.tar.xz`;
  await run('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '-cJf', join(output, archive), name], work,
    { ...process.env, XZ_OPT: '-T2 -3' });
  const installer = (await readFile(join(root, 'scripts', 'installer.sh'), 'utf8')).replaceAll('@VERSION@', version);
  await writeFile(join(output, 'voice-call-installer.sh'), installer, { mode: 0o755 });
  await writeFile(join(output, 'SHA256SUMS'), `${await checksum(join(output, archive))}  ${archive}\n${await checksum(join(output, 'voice-call-installer.sh'))}  voice-call-installer.sh\n`);
  console.log(`Release ${version} built in dist/ (Node ${nodeVersion}, Electron ${manifest.dependencies.electron}).`);
} finally { await rm(work, { recursive: true, force: true }); }
