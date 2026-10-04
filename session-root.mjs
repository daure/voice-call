import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const run = promisify(execFile);

export async function resolveSessionRoot(meta, { signal, cwd = process.cwd(), request = run } = {}) {
  signal?.throwIfAborted();
  const sessionID = meta?.['ai.opencode/sessionID'];
  let directory = cwd;
  if (sessionID !== undefined) {
    if (typeof sessionID !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(sessionID) || sessionID.length > 200) {
      throw new Error('Invalid invoking OpenCode session ID');
    }
    try {
      const { stdout } = await request('opencode', ['api', 'get', `/api/session/${sessionID}`], {
        signal, timeout: 10_000, maxBuffer: 256_000, encoding: 'utf8',
      });
      const session = JSON.parse(stdout).data;
      if (session?.id !== sessionID) throw new Error('Session ID mismatch');
      directory = session.location?.directory;
    } catch {
      signal?.throwIfAborted();
      throw new Error('Could not resolve the calling OpenCode session directory. Ensure the opencode CLI can access the same server as the caller.');
    }
  }
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0') || directory.length > 4096) {
    throw new Error('The calling session must have an absolute working directory');
  }
  try {
    const root = await realpath(directory);
    if (!(await stat(root)).isDirectory()) throw new Error('Not a directory');
    signal?.throwIfAborted();
    return root;
  } catch {
    signal?.throwIfAborted();
    throw new Error('The calling session working directory is unavailable');
  }
}
