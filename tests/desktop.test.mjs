import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { DesktopCaller } from '../desktop/caller.mjs';
import { VoiceControl } from '../desktop/control.mjs';
import { WebSocketServer, WebSocket } from 'ws';
import { createVoiceMcp } from '../mcp.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fileURLToPath } from 'node:url';

function desktop(t, options = {}) {
  const child = new EventEmitter();
  child.connected = true;
  child.kill = () => { child.connected = false; child.emit('exit'); };
  const control = new VoiceControl({ apiKey: 'offline-key', toolsRoot: null,
    onChange: (call) => child.emit('message', { type: 'progress', call }),
    onResult: (call) => child.emit('message', { type: 'result', call }),
    request: async () => new Response('v=0\r\nmock-answer') });
  child.send = (message, callback) => {
    if (message.type === 'call') control.incoming(message.call);
    if (message.type === 'cancel') control.cancel(message.id, message.error);
    callback?.();
  };
  const caller = new DesktopCaller({ requireDisplay: false, startupTimeout: 1000,
    launch: () => { queueMicrotask(() => child.emit('message', { type: 'ready' })); return child; }, ...options });
  t.after(() => caller.close());
  return { caller, control, child };
}

test('desktop hang-up returns the transcript while the app remains open for review', async (t) => {
  const { caller, control, child } = desktop(t);
  const waiting = caller.trigger({ context: 'Discuss the deployment.' });
  await caller.open();
  await sleep(0);
  const { id } = control.call;
  control.begin(id);
  assert.equal(await control.connect(id, 'v=0\r\nmock-offer'), 'v=0\r\nmock-answer');
  assert.equal((await caller.get(id)).status, 'active');
  const history = [{ id: 'a', role: 'assistant', text: 'Roll back?' }, { id: 'u', role: 'user', text: 'Yes.' }];
  control.finish(id, { status: 'ended', history, incomplete: false });
  assert.deepEqual((await waiting).history, history);
  assert.equal(child.connected, true);
  assert.equal(control.call.status, 'ended');
  assert.equal(caller.waiting, null);
});

test('desktop calls use the configured voice, default to shimmer, and reject unsupported voices before contacting OpenAI', async (t) => {
  const original = process.env.OPENAI_REALTIME_VOICE;
  t.after(() => {
    if (original === undefined) delete process.env.OPENAI_REALTIME_VOICE;
    else process.env.OPENAI_REALTIME_VOICE = original;
  });
  for (const configured of [undefined, ' ', 'marin', 'cedar', ' coral ', 'unknown']) {
    if (configured === undefined) delete process.env.OPENAI_REALTIME_VOICE;
    else process.env.OPENAI_REALTIME_VOICE = configured;
    let sent = false;
    const control = new VoiceControl({ apiKey: 'offline-key', toolsRoot: null,
      onChange() {}, onResult() {}, request: async (_url, options) => {
        sent = true;
        const session = JSON.parse(options.body.get('session'));
        assert.equal(session.audio.output.voice, configured?.trim() || 'shimmer');
        return new Response('v=0\r\nmock-answer');
      } });
    control.incoming({ id: 'voice-test', context: 'Discuss the deployment.', status: 'ringing' });
    if (configured === 'unknown') {
      assert.throws(() => control.begin('voice-test'), /OPENAI_REALTIME_VOICE must be one of:/);
      assert.equal(control.call.status, 'ringing');
      assert.equal(sent, false);
    } else {
      control.begin('voice-test');
      assert.equal(await control.connect('voice-test', 'v=0\r\nmock-offer'), 'v=0\r\nmock-answer');
      assert.equal(sent, true);
    }
    control.stop();
  }
});

test('desktop voice overrides apply to one call and lock when answering starts', async (t) => {
  const voices = [];
  const control = new VoiceControl({ apiKey: 'offline-key', voice: 'coral', toolsRoot: null,
    onChange() {}, onResult() {}, request: async (_url, options) => {
      voices.push(JSON.parse(options.body.get('session')).audio.output.voice);
      return new Response('v=0\r\nmock-answer');
    } });
  t.after(() => control.stop());
  control.incoming({ id: 'first', context: 'Try a voice.', status: 'ringing' });
  assert.equal(control.call.voice, 'coral');
  for (const voice of ['unknown', '', null, { voice: 'cedar' }]) {
    assert.throws(() => control.begin('first', voice), /must be one of:/);
    assert.equal(control.call.status, 'ringing');
    assert.equal(control.call.voice, 'coral');
  }
  assert.deepEqual(voices, []);
  control.begin('first', 'cedar');
  assert.throws(() => control.begin('first', 'ash'), /Call already answered/);
  await control.connect('first', 'v=0\r\nmock-offer');
  assert.throws(() => control.begin('first', 'ash'), /Call already answered/);
  assert.deepEqual(voices, ['cedar']);
  control.finish('first', { status: 'ended', history: [], incomplete: false });
  control.incoming({ id: 'second', context: 'Use the default.', status: 'ringing' });
  assert.equal(control.call.voice, 'coral');
  assert.throws(() => control.begin('first', 'ash'), /Call is no longer current/);
  control.begin('second');
  await control.connect('second', 'v=0\r\nmock-offer');
  assert.deepEqual(voices, ['cedar', 'coral']);
});

test('rejecting a desktop call uses no provider connection and releases the call slot', async (t) => {
  const { caller, control } = desktop(t);
  control.request = () => { throw new Error('Reject must not contact OpenAI'); };
  const waiting = caller.trigger({ context: 'Reject me.' });
  await caller.open(); await sleep(0);
  await assert.rejects(caller.trigger({ context: 'Busy.' }), /already pending or active/);
  control.finish(control.call.id, { status: 'declined', history: [], incomplete: false });
  assert.equal((await waiting).status, 'declined');
  const next = caller.trigger({ context: 'Next.' });
  await sleep(0);
  control.finish(control.call.id, { status: 'declined', history: [], incomplete: false });
  assert.equal((await next).context, 'Next.');
});

test('desktop cancellation resolves even while the app is still starting', async (t) => {
  const { caller, child } = desktop(t, { launch: () => child });
  const abort = new AbortController();
  const waiting = caller.trigger({ context: 'Waiting for startup.', signal: abort.signal });
  abort.abort();
  const result = await waiting;
  assert.equal(result.error, 'Calling agent cancelled the call');
  assert.equal(result.incomplete, true);
});

test('desktop calls enforce both the ringing and total conversation deadlines', async (t) => {
  const { caller, control } = desktop(t, { answerTimeout: 30 });
  assert.equal((await caller.trigger({ context: 'Unanswered.' })).error, 'Call was not answered in time');
  const active = caller.trigger({ context: 'Answered.', timeout: 100 });
  await sleep(0);
  control.begin(control.call.id);
  await control.connect(control.call.id, 'v=0\r\nmock-offer');
  assert.equal((await active).error, 'Call time limit reached');
  assert.equal(control.call.status, 'failed');
});

test('desktop process loss fails the pending call and the next call launches a fresh app', async (t) => {
  const { caller, control, child } = desktop(t);
  const waiting = caller.trigger({ context: 'Interrupted.' });
  await caller.open(); await sleep(0);
  child.emit('exit');
  assert.equal((await waiting).error, 'Desktop window closed before the call finished');
  control.finish(control.call.id, { status: 'failed', history: [], incomplete: true });
  const next = caller.trigger({ context: 'Fresh app.' });
  await caller.open(); await sleep(0);
  control.finish(control.call.id, { status: 'declined', history: [], incomplete: false });
  assert.equal((await next).status, 'declined');
});

test('an aborted SDP request cannot activate or block a later desktop call', async () => {
  let release;
  const control = new VoiceControl({ apiKey: 'offline', toolsRoot: null,
    onChange() {}, onResult() {}, request: () => new Promise((resolve) => { release = resolve; }) });
  control.incoming({ id: 'old', context: 'Old.', status: 'ringing' });
  control.begin('old');
  const old = assert.rejects(control.connect('old', 'v=0\r\noffer'), /abort/i);
  control.cancel('old', 'Cancelled');
  control.incoming({ id: 'new', context: 'New.', status: 'ringing' });
  control.begin('new');
  control.request = async () => new Response('v=0\r\nnew-answer');
  assert.equal(await control.connect('new', 'v=0\r\noffer'), 'v=0\r\nnew-answer');
  release(new Response('v=0\r\nold-answer'));
  await old;
  assert.equal(control.call.id, 'new');
  assert.equal(control.call.status, 'active');
  control.stop();
});

test('desktop MCP returns app-recorded file activity alongside the transcript and retains it for get-call', async (t) => {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => provider.once('listening', resolve));
  t.after(() => provider.close());
  let socket;
  const connected = new Promise((resolve) => provider.once('connection', (connection) => { socket = connection; resolve(); }));
  const results = [];
  const child = new EventEmitter();
  child.connected = true;
  child.kill = () => { child.connected = false; child.emit('exit'); };
  const control = new VoiceControl({ apiKey: 'offline-key', toolsRoot: fileURLToPath(new URL('../test-docs/', import.meta.url)),
    onChange: (call) => child.emit('message', { type: 'progress', call }),
    onResult: (call, { closeAfter }) => {
      results.push(call);
      child.emit('message', { type: 'result', call, close_after: closeAfter });
      if (closeAfter) child.kill();
    },
    request: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
      assert.equal(options.headers.Authorization, 'Bearer offline-key');
      const session = JSON.parse(options.body.get('session'));
      assert.equal(session.model, 'gpt-realtime');
      assert.equal(session.audio.output.voice, 'shimmer');
      assert.deepEqual(session.tools.map((tool) => tool.name), ['glob', 'grep', 'read_file', 'end_call']);
      assert.match(session.instructions, /Explore the documents/);
      return new Response('v=0\r\nanswer', { headers: { location: '/v1/realtime/calls/rtc_desktop' } });
    }, connectTools: (url, options) => {
      assert.equal(url, 'wss://api.openai.com/v1/realtime?call_id=rtc_desktop');
      return new WebSocket(`ws://127.0.0.1:${provider.address().port}`, options);
    } });
  t.after(() => control.stop());
  child.send = (message, callback) => {
    if (message.type === 'call') control.incoming(message.call);
    if (message.type === 'cancel') control.cancel(message.id, message.error);
    callback?.();
  };
  const caller = new DesktopCaller({ requireDisplay: false,
    launch: () => { queueMicrotask(() => child.emit('message', { type: 'ready' })); return child; } });
  const server = createVoiceMcp({ caller });
  const client = new Client({ name: 'file-activity-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  let progress;
  const began = new Promise((resolve) => { progress = resolve; });
  const waiting = client.callTool({ name: 'take-call', arguments: { context: 'Explore the documents.' } }, undefined,
    { onprogress: progress });
  await began;
  await caller.open();
  await sleep(0);
  const id = control.call.id;
  control.begin(id);
  await control.connect(id, 'v=0\r\noffer');
  await connected;
  const toolOutput = new Promise((resolve) => socket.on('message', (data) => {
    const event = JSON.parse(data);
    if (event.type === 'conversation.item.create') resolve(JSON.parse(event.item.output));
  }));
  socket.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'files', name: 'glob', arguments: '{"pattern":"**/*"}' }));
  assert.equal((await toolOutput).files.length, 7);
  const closed = new Promise((resolve) => socket.once('close', resolve));
  const history = [{ id: 'spoken', role: 'assistant', text: 'I found seven documents.' }];
  control.finish(id, { status: 'ended', history, incomplete: false, close_after: true,
    file_activity: { root: 'forged', complete: true, calls: [] } });
  await closed;
  assert.equal(results.length, 1);
  const returned = await waiting;
  assert.deepEqual(returned.structuredContent.history, history);
  assert.equal(returned.structuredContent.file_activity.root, 'test-docs');
  assert.equal(returned.structuredContent.file_activity.complete, true);
  assert.equal(returned.structuredContent.file_activity.calls[0].result.files.length, 7);
  assert.equal(returned.structuredContent.file_activity.calls[0].delivered_to_voice, true);
  assert.equal(caller.child, null);
  assert.equal('close_after' in returned.structuredContent, false);
  assert.deepEqual(JSON.parse(returned.content[0].text), returned.structuredContent);
  const recovered = await client.callTool({ name: 'get-call', arguments: { id } });
  assert.deepEqual(recovered.structuredContent.file_activity, returned.structuredContent.file_activity);
});

test('desktop process loss retains the latest file activity and marks its coverage incomplete', async (t) => {
  const { caller, control, child } = desktop(t);
  const waiting = caller.trigger({ context: 'Read a document.' });
  await caller.open(); await sleep(0);
  const activity = { root: 'test-docs', complete: true, calls: [
    { sequence: 1, call_id: 'finished', tool: 'glob', arguments: { pattern: '**/*' },
      status: 'completed', delivered_to_voice: true, result: { files: ['creative/poem.md'], truncated: false } },
    { sequence: 2, call_id: 'pending', tool: 'read_file', arguments: { path: 'creative/poem.md' },
      status: 'running', delivered_to_voice: false },
  ] };
  child.emit('message', { type: 'progress', call: { ...control.call, status: 'active', file_activity: activity } });
  child.emit('exit');
  const result = await waiting;
  assert.equal(result.file_activity.complete, false);
  assert.deepEqual(result.file_activity.calls[0], activity.calls[0]);
  assert.equal(result.file_activity.calls[1].status, 'cancelled');
  assert.equal(result.file_activity.calls[1].delivered_to_voice, false);
  assert.equal(activity.calls[1].status, 'running');
  assert.deepEqual((await caller.get(result.id)).file_activity, result.file_activity);
});

test('automatic app exit preserves the result and late exit events cannot interrupt a relaunched call', async (t) => {
  const children = [];
  const caller = new DesktopCaller({ requireDisplay: false, launch: () => {
    const child = new EventEmitter();
    child.connected = true;
    child.kill = () => { child.connected = false; child.emit('exit'); };
    child.send = (message, callback) => {
      if (message.type === 'call') child.call = message.call;
      callback?.();
    };
    children.push(child);
    queueMicrotask(() => child.emit('message', { type: 'ready' }));
    return child;
  } });
  t.after(() => caller.close());
  let closed = 0;
  caller.on('closed', () => closed++);
  const first = caller.trigger({ context: 'Say goodbye.' });
  await caller.open(); await sleep(0);
  const old = children[0];
  const history = [{ id: 'goodbye', role: 'assistant', text: 'Goodbye!' }];
  old.emit('message', { type: 'result', close_after: true,
    call: { ...old.call, status: 'ended', history, incomplete: false } });
  const ended = await first;
  assert.deepEqual(ended.history, history);
  assert.equal(caller.child, null);
  const next = caller.trigger({ context: 'Next call.' });
  await caller.open(); await sleep(0);
  const current = children[1];
  old.emit('exit');
  old.emit('disconnect');
  assert.equal(closed, 0);
  assert.equal(caller.child, current);
  assert.equal(caller.waiting.call.id, current.call.id);
  assert.deepEqual((await caller.get(ended.id)).history, history);
  current.emit('message', { type: 'result', call: { ...current.call, status: 'declined', history: [], incomplete: false } });
  assert.equal((await next).status, 'declined');
  current.kill();
  assert.equal(closed, 1);
});
