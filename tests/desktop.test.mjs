import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { DesktopCaller } from '../desktop/caller.mjs';
import { VoiceControl } from '../desktop/control.mjs';
import { WebSocketServer, WebSocket } from 'ws';

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

test('desktop negotiation configures native voice and attaches confined file tools to the same session', async (t) => {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => provider.once('listening', resolve));
  t.after(() => provider.close());
  let socket;
  const connected = new Promise((resolve) => provider.once('connection', (connection) => { socket = connection; resolve(); }));
  const results = [];
  const control = new VoiceControl({ apiKey: 'offline-key', onChange() {}, onResult: (call) => results.push(call),
    request: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
      assert.equal(options.headers.Authorization, 'Bearer offline-key');
      const session = JSON.parse(options.body.get('session'));
      assert.equal(session.model, 'gpt-realtime');
      assert.equal(session.audio.output.voice, 'marin');
      assert.deepEqual(session.tools.map((tool) => tool.name), ['glob', 'grep', 'read_file']);
      assert.match(session.instructions, /Explore the documents/);
      return new Response('v=0\r\nanswer', { headers: { location: '/v1/realtime/calls/rtc_desktop' } });
    }, connectTools: (url, options) => {
      assert.equal(url, 'wss://api.openai.com/v1/realtime?call_id=rtc_desktop');
      return new WebSocket(`ws://127.0.0.1:${provider.address().port}`, options);
    } });
  t.after(() => control.stop());
  control.incoming({ id: 'call', context: 'Explore the documents.', status: 'ringing' });
  control.begin('call');
  await control.connect('call', 'v=0\r\noffer');
  await connected;
  const toolOutput = new Promise((resolve) => socket.on('message', (data) => {
    const event = JSON.parse(data);
    if (event.type === 'conversation.item.create') resolve(JSON.parse(event.item.output));
  }));
  socket.send(JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'files', name: 'glob', arguments: '{"pattern":"**/*"}' }));
  assert.equal((await toolOutput).files.length, 7);
  const closed = new Promise((resolve) => socket.once('close', resolve));
  control.finish('call', { status: 'ended', history: [], incomplete: false });
  await closed;
  assert.equal(results.length, 1);
});
