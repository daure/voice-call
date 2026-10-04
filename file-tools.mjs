import { constants, realpathSync, statSync } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, matchesGlob, relative, sep } from 'node:path';
import { z } from 'zod';

const text = z.string().min(1).max(200);
const schemas = {
  glob: z.object({ pattern: text, limit: z.number().int().min(1).max(100).default(50) }).strict(),
  grep: z.object({ pattern: text, include: text.default('**/*'),
    case_sensitive: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(30) }).strict(),
  read_file: z.object({ path: z.string().min(1).max(500),
    offset: z.number().int().min(1).max(100_000).default(1),
    limit: z.number().int().min(1).max(200).default(100) }).strict(),
};
const descriptions = {
  glob: 'Find files by root-relative glob using *, ** and ? only, e.g. **/*.md or src/*.rs. Discovery excludes hidden files, symlinks, and generated node_modules and target folders. Results are bounded; truncated means some results were omitted.',
  grep: 'Find literal text (not regex) in UTF-8 files. Returns root-relative paths, 1-based line numbers and matching text. include is a glob; search is case-insensitive by default. Reports skipped files and truncation.',
  read_file: 'Read a UTF-8 file using its root-relative path. offset is a 1-based line number. Returns numbered lines and next_offset when more remains. Files must be regular, non-linked and at most 128 KiB.',
};
export const fileToolDefinitions = Object.entries(schemas).map(([name, schema]) => ({
  type: 'function', name, description: descriptions[name],
  parameters: z.toJSONSchema(schema, { target: 'draft-7' }),
}));

function safeRelative(value) {
  if (isAbsolute(value) || value.includes('\\') || value.includes('\0') ||
      value.split('/').some((part) => part === '..' || part.startsWith('.'))) {
    throw new Error('Use a root-relative path or glob without hidden names or parent traversal');
  }
  return value;
}

export function createFileTools(directory) {
  const root = realpathSync(directory);
  if (!statSync(root).isDirectory()) throw new Error('File tool root must be a directory');

  async function checkedPath(path) {
    safeRelative(path);
    let target = root;
    for (const part of path.split('/').filter(Boolean)) {
      target = join(target, part);
      if ((await lstat(target)).isSymbolicLink()) throw new Error('Symlinks are not accessible');
    }
    return target;
  }

  async function readText(path, signal) {
    signal?.throwIfAborted();
    const target = await checkedPath(path);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Only regular, non-linked files are accessible');
      if (stat.size > 128 * 1024) throw new Error('File exceeds the 128 KiB limit');
      // Validate the opened descriptor to catch a parent-directory symlink swap on Linux.
      const opened = await realpath(process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : target);
      const location = relative(root, opened);
      if (isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) {
        throw new Error('File is outside the tool root');
      }
      const buffer = Buffer.alloc(128 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      signal?.throwIfAborted();
      if (bytesRead > 128 * 1024) throw new Error('File exceeds the 128 KiB limit');
      if (buffer.subarray(0, bytesRead).includes(0)) throw new Error('Binary files are not accessible');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async function listFiles(signal) {
    const files = [];
    let visited = 0, truncated = false;
    async function walk(path = '', depth = 0) {
      const target = path ? await checkedPath(path) : root;
      const entries = await opendir(target);
      for await (const entry of entries) {
        signal?.throwIfAborted();
        if (++visited > 1000) { truncated = true; break; }
        if (entry.name.startsWith('.') || entry.isSymbolicLink() ||
            (entry.isDirectory() && ['node_modules', 'target'].includes(entry.name))) continue;
        const child = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isFile()) files.push(child);
        else if (entry.isDirectory()) {
          if (depth >= 16) truncated = true;
          else await walk(child, depth + 1);
        }
        if (visited > 1000) break;
      }
    }
    await walk();
    return { files: files.sort(), truncated };
  }

  return async function execute(name, arguments_, signal) {
    if (!Object.hasOwn(schemas, name)) throw new Error('Unknown file tool');
    const parsed = schemas[name].safeParse(arguments_);
    if (!parsed.success) throw new Error('Invalid file tool arguments');
    const args = parsed.data;
    if (name === 'read_file') {
      const content = await readText(args.path, signal);
      const lines = content ? content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
      const selected = [];
      let size = 0;
      for (let index = args.offset - 1; index < lines.length && selected.length < args.limit; index++) {
        const line = lines[index].slice(0, 1000);
        if (size + line.length > 12_000) break;
        selected.push({ line: index + 1, text: line, truncated: line.length < lines[index].length });
        size += line.length;
      }
      const next = args.offset + selected.length;
      return { path: args.path, lines: selected, total_lines: lines.length,
        truncated: next <= lines.length || selected.some((line) => line.truncated),
        next_offset: next <= lines.length ? next : null };
    }
    const pattern = safeRelative(name === 'glob' ? args.pattern : args.include);
    if (/[{}\[\]()!]/.test(pattern)) throw new Error('Use a basic glob with *, ** or ?');
    const listing = await listFiles(signal);
    const files = listing.files.filter((path) => matchesGlob(path, pattern));
    if (name === 'glob') {
      let size = 0;
      const selected = [];
      for (const path of files) {
        if (selected.length >= args.limit || size + path.length > 12_000) break;
        selected.push(path);
        size += path.length;
      }
      return { files: selected, truncated: listing.truncated || selected.length < files.length };
    }
    const matches = [], skipped_files = [];
    let truncated = listing.truncated, size = 0;
    const needle = args.case_sensitive ? args.pattern : args.pattern.toLowerCase();
    for (const path of files) {
      let content;
      try { content = await readText(path, signal); }
      catch {
        signal?.throwIfAborted();
        if (skipped_files.length < 20) skipped_files.push(path.slice(0, 500));
        truncated = true;
        continue;
      }
      for (const [index, line] of content.split('\n').entries()) {
        if (!(args.case_sensitive ? line : line.toLowerCase()).includes(needle)) continue;
        if (matches.length >= args.limit || size + Math.min(line.length, 1000) > 12_000) {
          return { matches, skipped_files, truncated: true };
        }
        matches.push({ path, line: index + 1, text: line.slice(0, 1000), truncated: line.length > 1000 });
        size += Math.min(line.length, 1000);
        if (line.length > 1000) truncated = true;
      }
    }
    return { matches, skipped_files, truncated };
  };
}
