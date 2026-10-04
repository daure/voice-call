import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DesktopCaller } from '../desktop/caller.mjs';
import { VoiceControl } from '../desktop/control.mjs';
import { startDevelopment } from '../dev-server.mjs';
import { prepareDevelopment } from '../scripts/dev.mjs';

function desktop() {
  const child = new EventEmitter();
  child.connected = true;
  child.kill = () => { if (child.connected) { child.connected = false; child.emit('exit'); } };
  let shown = false, launches = 0;
  const control = new VoiceControl({ apiKey: 'offline-key', toolsRoot: null,
    onChange: (call) => child.emit('message', { type: 'progress', call }),
    onResult: (call) => child.emit('message', { type: 'result', call }),
    request: async () => new Response('v=0\r\nmock-answer') });
  child.send = (message, callback) => {
    if (message.type === 'show') shown = true;
    if (message.type === 'call') control.incoming(message.call);
    if (message.type === 'cancel') control.cancel(message.id, message.error);
    callback?.();
  };
  const caller = new DesktopCaller({ requireDisplay: false, startupTimeout: 1000, launch: () => {
    launches++;
    queueMicrotask(() => child.emit('message', { type: 'ready' }));
    return child;
  } });
  return { caller, child, control, shown: () => shown, launches: () => launches };
}
async function connect(t, origin) {
  const client = new Client({ name: 'development-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
  await client.connect(transport);
  t.after(() => client.close());
  return { client, transport };
}
function call(client, options = {}) {
  let received;
  const progress = new Promise((resolve) => { received = resolve; });
  const result = client.callTool({ name: 'take-call', arguments: { context: 'Explore the dummy files.' } }, undefined,
    { timeout: 5000, onprogress: received, ...options });
  return { result, progress };
}
async function waitFor(condition) {
  const end = Date.now() + 2000;
  while (!condition()) { assert.ok(Date.now() < end, 'Development state did not settle'); await sleep(5); }
}

test('development opens one window and shares the real call lifecycle across HTTP MCP clients', { timeout: 10_000 }, async (t) => {
  const fixture = desktop();
  const development = await startDevelopment({ port: 0, caller: fixture.caller });
  t.after(() => development.close());
  assert.equal(fixture.shown(), true);
  assert.equal(fixture.control.call, null);
  const { client: first } = await connect(t, development.origin);
  const { client: second } = await connect(t, development.origin);
  assert.deepEqual((await first.listTools()).tools.map((tool) => tool.name), ['take-call', 'get-call']);
  const prefix = 'Project briefing:\n', suffix = '\nFinal facts.';
  const context = `${prefix}${'\u0001'.repeat(100_000 - prefix.length - suffix.length)}${suffix}`;
  let progress;
  const began = new Promise((resolve) => { progress = resolve; });
  const waiting = { result: first.callTool({ name: 'take-call', arguments: { context } }, undefined,
    { timeout: 5000, onprogress: progress }) };
  await Promise.race([began, waiting.result.then((result) => {
    throw new Error(`Call ended before ringing: ${JSON.stringify(result)}`);
  })]);
  await waitFor(() => fixture.control.call?.status === 'ringing');
  assert.equal(fixture.control.call.context, context);
  const busy = await second.callTool({ name: 'take-call', arguments: { context: 'Another call.' } });
  assert.equal(busy.isError, true);
  assert.match(busy.content[0].text, /already pending or active/);
  const id = fixture.control.call.id;
  fixture.control.request = async (_url, options) => {
    const session = JSON.parse(options.body.get('session'));
    assert.ok(session.instructions.endsWith(context));
    assert.match(session.instructions, /Speak English/);
    return new Response('v=0\r\nmock-answer');
  };
  fixture.control.begin(id);
  await fixture.control.connect(id, 'v=0\r\nmock-offer');
  const history = [{ id: 'u', role: 'user', text: 'Read the poem.' }];
  fixture.control.finish(id, { status: 'ended', history, incomplete: false });
  assert.deepEqual((await waiting.result).structuredContent.history, history);
  assert.deepEqual((await second.callTool({ name: 'get-call', arguments: { id } })).structuredContent.history, history);
  assert.equal(fixture.launches(), 1);
  assert.equal(fixture.child.connected, true);
});

test('HTTP MCP cancellation and session termination release their own calls without closing the shared window', { timeout: 10_000 }, async (t) => {
  const fixture = desktop();
  const development = await startDevelopment({ port: 0, caller: fixture.caller });
  t.after(() => development.close());
  const { client: owner, transport: ownerTransport } = await connect(t, development.origin);
  const { transport: idleTransport } = await connect(t, development.origin);
  const abort = new AbortController();
  const waiting = call(owner, { signal: abort.signal });
  await waiting.progress;
  await waitFor(() => fixture.control.call?.status === 'ringing');
  await idleTransport.terminateSession();
  assert.equal(fixture.control.call.status, 'ringing');
  const cancelled = assert.rejects(waiting.result, /abort|cancel/i);
  abort.abort(); await cancelled;
  await waitFor(() => fixture.control.call.status === 'failed');
  assert.equal(fixture.child.connected, true);
  const next = call(owner);
  await next.progress;
  await waitFor(() => fixture.control.call.status === 'ringing');
  const id = fixture.control.call.id;
  const terminated = assert.rejects(next.result);
  await ownerTransport.terminateSession();
  await terminated;
  await waitFor(() => fixture.control.call.status === 'failed');
  assert.equal((await fixture.caller.get(id)).incomplete, true);
  assert.equal(fixture.child.connected, true);
});

test('development rejects browser origins, DNS rebinding, unknown sessions, and oversized requests', async (t) => {
  const fixture = desktop();
  const development = await startDevelopment({ port: 0, caller: fixture.caller });
  t.after(() => development.close());
  const endpoint = `${development.origin}/mcp`;
  assert.equal((await fetch(endpoint, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(endpoint, { headers: { Origin: development.origin } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = request(endpoint, { headers: { Host: 'malicious.example' } }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(endpoint, { headers: { 'Mcp-Session-Id': 'unknown' } })).status, 404);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: 'x'.repeat(1_000_001) })).status, 413);
  assert.equal(fixture.control.call, null);
});

test('closing the development window stops its HTTP listener', async () => {
  const fixture = desktop();
  const development = await startDevelopment({ port: 0, caller: fixture.caller });
  const port = development.server.address().port;
  const closed = once(development.server, 'close');
  fixture.child.kill();
  await closed;
  await development.close();
  const replacement = createServer();
  await new Promise((resolve, reject) => { replacement.once('error', reject); replacement.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve) => replacement.close(resolve));
});

test('an occupied development port leaves the existing listener alone and opens no window', async (t) => {
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const fixture = desktop();
  await assert.rejects(startDevelopment({ port: occupied.address().port, caller: fixture.caller }), { code: 'EADDRINUSE' });
  assert.equal(fixture.launches(), 0);
  assert.equal(occupied.listening, true);
});

test('development prepares missing dependencies and Electron once, then refreshes them when the lockfile changes', async (t) => {
  const directory = await mkdtemp('/tmp/opencode/voice-call-dev-prepare-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ dependencies: { electron: '44.5.1', zod: '4.6.5' } }));
  await writeFile(join(directory, 'package-lock.json'), '{}');
  const commands = [];
  const run = async (command, args, cwd) => {
    assert.equal(command, 'npm'); assert.equal(cwd, directory);
    commands.push(args);
    if (args[0] === 'ci') {
      await rm(join(directory, 'node_modules'), { recursive: true, force: true });
      for (const name of ['electron', 'zod']) {
        await mkdir(join(directory, 'node_modules', name), { recursive: true });
        await writeFile(join(directory, 'node_modules', name, 'package.json'), '{}');
      }
    } else {
      await mkdir(join(directory, 'node_modules', 'electron', 'dist'), { recursive: true });
      await writeFile(join(directory, 'node_modules', 'electron', 'dist', 'electron'), 'mock executable');
    }
  };
  await prepareDevelopment({ directory, run });
  await prepareDevelopment({ directory, run });
  assert.deepEqual(commands, [['ci'], ['exec', '--', 'install-electron', '--no']]);
  await writeFile(join(directory, 'package-lock.json'), '{"version":"updated"}');
  await prepareDevelopment({ directory, run });
  assert.deepEqual(commands.slice(2), [['ci'], ['exec', '--', 'install-electron', '--no']]);
});
