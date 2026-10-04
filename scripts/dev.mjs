import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function prepareDevelopment({ directory = root, run = runCommand } = {}) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const fingerprint = createHash('sha256').update(await readFile(join(directory, 'package-lock.json')))
    .update(JSON.stringify(manifest.dependencies)).digest('hex');
  const marker = join(directory, 'node_modules', '.voice-call-dev-lock');
  const missing = Object.keys(manifest.dependencies).some((name) => !existsSync(join(directory, 'node_modules', name, 'package.json')));
  if (missing || !existsSync(marker) || readFileSync(marker, 'utf8') !== fingerprint) {
    console.log('Preparing development dependencies…');
    await run('npm', ['ci'], directory);
    await writeFile(marker, fingerprint);
  }
  if (!existsSync(join(directory, 'node_modules', 'electron', 'dist', 'electron'))) {
    console.log('Preparing the Electron runtime…');
    await run('npm', ['exec', '--', 'install-electron', '--no'], directory);
  }
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function main() {
  if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
  // Development always uses this checkout's runtime and sample documents.
  delete process.env.VOICE_CALL_ELECTRON_PATH;
  if (!process.env.OPENAI_API_KEY) console.warn('OPENAI_API_KEY is unset. Set it in your environment or ignored .env before answering a call.');
  const port = Number(process.env.VOICE_CALL_DEV_PORT || 7357);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('VOICE_CALL_DEV_PORT must be between 1 and 65535');
  await prepareDevelopment();
  const { startDevelopment } = await import('../dev-server.mjs');
  const development = await startDevelopment({ port });
  console.log(`Development MCP: ${development.origin}/mcp`);
  console.log(`Voice documents: ${join(root, 'test-docs')}`);
  console.log('Ready. Ask your agent to call you. Manually closing the window or pressing Ctrl+C stops development.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    development.close().catch(() => { process.exitCode = 1; });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    console.error('If Ubuntu blocks Electron, run: sh scripts/setup-sandbox.sh "$PWD/node_modules/electron/dist/electron"');
    process.exitCode = 1;
  });
}
