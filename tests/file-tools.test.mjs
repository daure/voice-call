import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileTools } from '../file-tools.mjs';

const samples = fileURLToPath(new URL('../test-docs/', import.meta.url));

async function workspace(t) {
  const directory = await mkdtemp('/tmp/opencode/voice-files-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'docs');
  await mkdir(root);
  return { directory, root, execute: createFileTools(root) };
}

test('the voice assistant discovers, searches, and reads the seven sample documents', async () => {
  const execute = createFileTools(samples);
  const listing = await execute('glob', { pattern: '**/*' });
  assert.deepEqual(listing, { files: [
    'business/use-case.md', 'creative/poem.md', 'operations/incident-report.md',
    'personal/love-letter.txt', 'planning/garden-notes.md', 'planning/weekend-itinerary.md',
    'reference/reading-list.md',
  ], truncated: false });
  const search = await execute('grep', { pattern: 'BLUE DOOR' });
  assert.deepEqual(search.matches.map((match) => match.path),
    ['personal/love-letter.txt', 'planning/weekend-itinerary.md']);
  assert.equal(search.truncated, false);
  assert.deepEqual(search.skipped_files, []);
  assert.equal((await execute('grep', { pattern: 'BLUE DOOR', case_sensitive: true })).matches.length, 0);
  const poem = await execute('read_file', { path: 'creative/poem.md', offset: 3, limit: 2 });
  assert.deepEqual(poem.lines, [
    { line: 3, text: 'At dusk the harbor folds its silver sails,', truncated: false },
    { line: 4, text: 'And gulls draw commas in the cooling sky.', truncated: false },
  ]);
  assert.equal(poem.next_offset, 5);
  assert.equal(poem.truncated, true);
  assert.equal((await execute('read_file', { path: 'business/use-case.md' })).truncated, false);
  const budget = await execute('grep', { pattern: 'EUR 6,200', include: 'business/*.md' });
  assert.equal(budget.matches.length, 1);
  assert.equal(budget.matches[0].line, 17);
  const source = (await readFile(join(samples, budget.matches[0].path), 'utf8')).split('\n');
  assert.equal(budget.matches[0].text, source[budget.matches[0].line - 1]);
});

test('project searches reach source files without spending the discovery budget on generated folders', async (t) => {
  const { root, execute } = await workspace(t);
  for (const name of ['target', 'node_modules']) {
    await mkdir(join(root, name));
    for (let index = 0; index < 1100; index++) await writeFile(join(root, name, `${index}.rs`), 'generated poll_rules');
  }
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'rules.rs'), 'pub fn poll_rules() {}\n');
  assert.deepEqual(await execute('grep', { include: '**/*.rs', pattern: 'poll_rules', limit: 50 }), {
    matches: [{ path: 'src/rules.rs', line: 1, text: 'pub fn poll_rules() {}', truncated: false }],
    skipped_files: [], truncated: false,
  });
  assert.deepEqual(await execute('glob', { pattern: '**/*.rs' }), { files: ['src/rules.rs'], truncated: false });
});

test('file tools reject traversal, hidden paths, unsafe globs, and invalid arguments', async (t) => {
  const { execute } = await workspace(t);
  for (const path of ['../server.mjs', '/etc/passwd', 'a/../../secret', 'a\\secret', '.env', 'a/.secret', 'bad\0name']) {
    await assert.rejects(execute('read_file', { path }), /root-relative/);
  }
  for (const pattern of ['../*', '/**/*', '.env', '**/{a,b}', '**/!(secret)', '**/[abc]']) {
    await assert.rejects(execute('glob', { pattern }), /root-relative|basic glob/);
  }
  await assert.rejects(execute('grep', { pattern: 'x', include: '../*' }), /root-relative/);
  for (const name of ['bash', '__proto__', 'constructor']) {
    await assert.rejects(execute(name, {}), /Unknown file tool/);
  }
  for (const args of [{}, { pattern: '' }, { pattern: '*', limit: 101 }, { pattern: '*', path: '/etc' }]) {
    await assert.rejects(execute('glob', args), /Invalid file tool arguments/);
  }
  await assert.rejects(execute('read_file', { path: 'x', offset: 0 }), /Invalid file tool arguments/);
});

test('file tools exclude symlinks and reject hard-linked files and directories', async (t) => {
  const { directory, root, execute } = await workspace(t);
  await writeFile(join(directory, 'outside.txt'), 'private material');
  await writeFile(join(root, 'public.txt'), 'public material');
  await writeFile(join(root, '.secret'), 'hidden material');
  await symlink(join(directory, 'outside.txt'), join(root, 'escape.txt'));
  await symlink(directory, join(root, 'escape-dir'));
  await symlink(join(root, 'public.txt'), join(root, 'inside.txt'));
  await link(join(directory, 'outside.txt'), join(root, 'hard.txt'));
  assert.deepEqual((await execute('glob', { pattern: '**/*' })).files, ['hard.txt', 'public.txt']);
  for (const path of ['escape.txt', 'inside.txt', 'escape-dir/outside.txt']) {
    await assert.rejects(execute('read_file', { path }), /Symlinks/);
  }
  await assert.rejects(execute('read_file', { path: 'hard.txt' }), /non-linked/);
  await mkdir(join(root, 'folder'));
  await assert.rejects(execute('read_file', { path: 'folder' }), /regular/);
  const search = await execute('grep', { pattern: 'material' });
  assert.deepEqual(search.matches.map((match) => match.text), ['public material']);
  assert.deepEqual(search.skipped_files, ['hard.txt']);
  assert.equal(search.truncated, true);
});

test('file tools report bounded results, skipped input, and line pagination', async (t) => {
  const { root, execute } = await workspace(t);
  await writeFile(join(root, 'a.txt'), 'needle one\r\nneedle two\r\n');
  await writeFile(join(root, 'b.txt'), 'needle three\n');
  await writeFile(join(root, 'empty.txt'), '');
  await writeFile(join(root, 'binary.bin'), Buffer.from([65, 0, 66]));
  await writeFile(join(root, 'invalid.bin'), Buffer.from([0xff]));
  await writeFile(join(root, 'large.txt'), 'x'.repeat(128 * 1024 + 1));
  assert.equal((await execute('glob', { pattern: '**/*', limit: 1 })).truncated, true);
  const search = await execute('grep', { pattern: 'needle', limit: 1 });
  assert.deepEqual(search.matches, [{ path: 'a.txt', line: 1, text: 'needle one\r', truncated: false }]);
  assert.equal(search.truncated, true);
  assert.deepEqual((await execute('read_file', { path: 'a.txt', offset: 2, limit: 1 })).lines,
    [{ line: 2, text: 'needle two', truncated: false }]);
  assert.equal((await execute('read_file', { path: 'a.txt', offset: 2 })).next_offset, null);
  assert.deepEqual((await execute('read_file', { path: 'empty.txt' })).lines, []);
  assert.deepEqual((await execute('read_file', { path: 'a.txt', offset: 20 })).lines, []);
  for (const path of ['binary.bin', 'invalid.bin', 'large.txt']) {
    await assert.rejects(execute('read_file', { path }));
  }
  const missing = await execute('grep', { pattern: 'absent' });
  assert.deepEqual(missing.matches, []);
  assert.deepEqual(missing.skipped_files, ['binary.bin', 'invalid.bin', 'large.txt']);
  assert.equal(missing.truncated, true);
  await writeFile(join(root, 'long.txt'), `${'x'.repeat(2000)}\n${'line\n'.repeat(220)}`);
  const long = await execute('read_file', { path: 'long.txt', limit: 200 });
  assert.equal(long.lines.length, 200);
  assert.equal(long.lines[0].text.length, 1000);
  assert.equal(long.lines[0].truncated, true);
  assert.equal(long.next_offset, 201);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(execute('grep', { pattern: 'x' }, controller.signal), /abort/i);
});
