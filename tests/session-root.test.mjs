import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DesktopCaller } from '../desktop/caller.mjs';
import { VoiceControl } from '../desktop/control.mjs';
import { createVoiceMcp } from '../mcp.mjs';
import { resolveSessionRoot } from '../session-root.mjs';

async function directories(t) {
  const temp = await mkdtemp('/tmp/opencode/voice-call-session-root-');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const roots = ['launch', 'first', 'second'].map((name) => join(temp, name));
  for (const root of roots) {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'rules.rs'), `${basename(root)}: poll_rules\n`);
  }
  return roots;
}

test('session metadata resolves the current directory on every call and lookup failures never fall back to the launch directory', async (t) => {
  const [launch, first, second] = await directories(t);
  const meta = { 'ai.opencode/sessionID': 'ses_current' };
  let directory = first;
  const request = async (command, args, options) => {
    assert.equal(command, 'opencode');
    assert.deepEqual(args, ['api', 'get', '/api/session/ses_current']);
    assert.equal(options.timeout, 10_000);
    return { stdout: JSON.stringify({ data: { id: 'ses_current', location: { directory } } }) };
  };
  assert.equal(await resolveSessionRoot(meta, { cwd: launch, request }), first);
  directory = second;
  assert.equal(await resolveSessionRoot(meta, { cwd: launch, request }), second);
  for (const stdout of ['not-json', '{}', JSON.stringify({ data: { id: 'ses_other', location: { directory: launch } } })]) {
    await assert.rejects(resolveSessionRoot(meta, { cwd: launch, request: async () => ({ stdout }) }), /Could not resolve/);
  }
  await assert.rejects(resolveSessionRoot(meta, { cwd: launch, request: async () => { throw new Error('Private diagnostics'); } }),
    { message: 'Could not resolve the calling OpenCode session directory. Ensure the opencode CLI can access the same server as the caller.' });
  for (const value of [null, '', 'relative/path', join(first, 'missing'), join(first, 'src', 'rules.rs')]) {
    directory = value;
    await assert.rejects(resolveSessionRoot(meta, { cwd: launch, request }), /working directory/);
  }
  for (const sessionID of [null, '', 'ses_../../private', {}, 'ses_' + 'x'.repeat(200)]) {
    await assert.rejects(resolveSessionRoot({ 'ai.opencode/sessionID': sessionID }, { request: () => assert.fail('Must not launch a command') }),
      /Invalid invoking OpenCode session ID/);
  }
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(resolveSessionRoot(meta, { signal: abort.signal, request: () => assert.fail('Must not launch a command') }), /abort/i);
  assert.equal(await resolveSessionRoot(undefined, { cwd: launch, request: () => assert.fail('Non-OpenCode clients use their launch directory') }), launch);
});

test('shared desktop MCP confines each call to its invoking session directory, including moved sessions', async (t) => {
  const [launch, first, second] = await directories(t);
  const locations = new Map([['ses_first', first], ['ses_second', second]]);
  const child = new EventEmitter();
  child.connected = true;
  child.kill = () => { child.connected = false; child.emit('exit'); };
  const control = new VoiceControl({ toolsRoot: launch,
    onChange: (call) => child.emit('message', { type: 'progress', call }),
    onResult: (call) => child.emit('message', { type: 'result', call }) });
  child.send = (message, callback) => {
    if (message.type === 'call') control.incoming(message.call, message.toolsRoot);
    callback?.();
  };
  const caller = new DesktopCaller({ requireDisplay: false,
    launch: () => { queueMicrotask(() => child.emit('message', { type: 'ready' })); return child; } });
  const server = createVoiceMcp({ caller, resolveRoot: (meta, options) => resolveSessionRoot(meta, {
    ...options, cwd: launch, request: async (_command, args) => {
      const id = args[2].split('/').at(-1);
      if (!locations.has(id)) throw new Error('Session not found');
      return { stdout: JSON.stringify({ data: { id, location: { directory: locations.get(id) } } }) };
    },
  }) });
  const client = new Client({ name: 'session-directory-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); caller.close(); });

  for (const [sessionID, root] of [['ses_first', first], ['ses_second', second], ['ses_first', second]]) {
    locations.set(sessionID, root);
    let ringing;
    const began = new Promise((resolve) => { ringing = resolve; });
    const result = client.callTool({ name: 'take-call', arguments: { context: 'Inspect poll_rules.' },
      _meta: { 'ai.opencode/sessionID': sessionID } }, undefined, { timeout: 5000, onprogress: ringing });
    await Promise.race([began, result.then((value) => { throw new Error(JSON.stringify(value)); })]);
    await caller.open();
    await sleep(0);
    assert.equal(control.call.file_activity.root, basename(root));
    const matches = await control.execute('grep', { include: '**/*.rs', pattern: 'poll_rules', limit: 50 });
    assert.deepEqual(matches.matches, [{ path: 'src/rules.rs', line: 1, text: `${basename(root)}: poll_rules`, truncated: false }]);
    await assert.rejects(control.execute('read_file', { path: '../launch/src/rules.rs' }), /root-relative/);
    await assert.rejects(control.execute('read_file', { path: join(launch, 'src', 'rules.rs') }), /root-relative/);
    control.finish(control.call.id, { status: 'declined', history: [], incomplete: false });
    assert.equal((await result).structuredContent.file_activity.root, basename(root));
  }
  const prior = control.call;
  const failed = await client.callTool({ name: 'take-call', arguments: { context: 'Lookup must fail closed.' },
    _meta: { 'ai.opencode/sessionID': 'ses_missing' } });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /Could not resolve the calling OpenCode session directory/);
  assert.equal(control.call, prior);
  const busyCall = caller.trigger({ context: 'Busy.', toolsRoot: first });
  await caller.open();
  await sleep(0);
  const active = control.call;
  const busy = await client.callTool({ name: 'take-call', arguments: { context: 'Other session.' },
    _meta: { 'ai.opencode/sessionID': 'ses_second' } });
  assert.equal(busy.isError, true);
  assert.equal(control.call, active);
  assert.equal(control.call.file_activity.root, basename(first));
  control.finish(active.id, { status: 'declined', history: [], incomplete: false });
  await busyCall;
});
