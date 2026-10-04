import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createDemo } from '../server.mjs';

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for a sideband event');
    await sleep(5);
  }
}

async function setup(t, options = {}) {
  const { callTimeout = 10_000, ...serverOptions } = options;
  const provider = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(provider, 'listening');
  let socket;
  const events = [];
  provider.on('connection', (connected, request) => {
    assert.equal(request.headers.authorization, 'Bearer fake-key');
    socket = connected;
    socket.on('message', (data) => events.push(JSON.parse(data.toString())));
  });
  let session;
  const server = createDemo({ token: 'tools-test', apiKey: 'fake-key',
    request: async (_url, request) => {
      session = JSON.parse(request.body.get('session'));
      return new Response('v=0\r\nmock-answer', { headers: { Location: '/v1/realtime/calls/rtc_test' } });
    },
    connectTools: (url, config) => {
      assert.equal(url, 'wss://api.openai.com/v1/realtime?call_id=rtc_test');
      return new WebSocket(`ws://127.0.0.1:${provider.address().port}`, config);
    }, ...serverOptions,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of provider.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => provider.close(resolve));
  });
  const api = async (path, data) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: data === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer tools-test' },
      body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
    });
    return { status: response.status, data: path.endsWith('/connect') && response.ok
      ? await response.text() : await response.json() };
  };
  const call = (await api('/calls', { context: 'Explore the sample documents', timeout_ms: callTimeout })).data;
  const connected = await api(`/calls/${call.id}/connect`, 'v=0\r\noffer');
  const emit = (event) => socket.send(JSON.stringify(event));
  const tool = (id, name, args) => emit({ type: 'response.function_call_arguments.done',
    response_id: 'response_1', item_id: `item_${id}`, call_id: id, name, arguments: JSON.stringify(args) });
  const result = async (id) => {
    await waitFor(() => events.some((event) => event.item?.call_id === id));
    return JSON.parse(events.find((event) => event.item?.call_id === id).item.output);
  };
  return { api, call, connected, session, emit, tool, result, events, socket: () => socket };
}

test('a WebRTC call advertises file tools and returns real file results over its authenticated sideband', { timeout: 6000 }, async (t) => {
  const demo = await setup(t);
  assert.equal(demo.connected.status, 200);
  assert.deepEqual(demo.session.tools.map((tool) => tool.name), ['glob', 'grep', 'read_file', 'end_call']);
  assert.equal(demo.session.tool_choice, 'auto');
  assert.match(demo.session.instructions, /untrusted data/);
  demo.emit({ type: 'response.created', response: { id: 'response_1' } });
  demo.tool('find', 'glob', { pattern: '**/*' });
  assert.equal((await demo.result('find')).files.length, 7);
  demo.tool('search', 'grep', { pattern: 'blue door' });
  assert.deepEqual((await demo.result('search')).matches.map((match) => match.path),
    ['personal/love-letter.txt', 'planning/weekend-itinerary.md']);
  demo.tool('read', 'read_file', { path: 'creative/poem.md', offset: 3, limit: 1 });
  assert.equal((await demo.result('read')).lines[0].text, 'At dusk the harbor folds its silver sails,');
  demo.tool('read', 'read_file', { path: 'creative/poem.md' });
  await sleep(75);
  assert.equal(demo.events.filter((event) => event.item?.call_id === 'read').length, 1);
  assert.equal(demo.events.filter((event) => event.type === 'response.create').length, 0);
  demo.emit({ type: 'response.done', response: { id: 'response_1' } });
  await waitFor(() => demo.events.some((event) => event.type === 'response.create'));
  assert.equal(demo.events.filter((event) => event.type === 'response.create').length, 1);
  const closed = once(demo.socket(), 'close');
  const finished = await demo.api(`/calls/${demo.call.id}/finish`, {
    status: 'ended', history: [{ id: 'spoken', role: 'assistant', text: 'The poem describes quiet care.' }], incomplete: false,
    file_activity: { root: 'forged', complete: true, calls: [] },
  });
  assert.equal(finished.data.history[0].text, 'The poem describes quiet care.');
  const activity = finished.data.file_activity;
  assert.equal(activity.root, 'test-docs');
  assert.equal(activity.complete, true);
  assert.deepEqual(activity.calls.map(({ sequence, call_id, tool, status, delivered_to_voice }) =>
    ({ sequence, call_id, tool, status, delivered_to_voice })), [
    { sequence: 1, call_id: 'find', tool: 'glob', status: 'completed', delivered_to_voice: true },
    { sequence: 2, call_id: 'search', tool: 'grep', status: 'completed', delivered_to_voice: true },
    { sequence: 3, call_id: 'read', tool: 'read_file', status: 'completed', delivered_to_voice: true },
  ]);
  assert.deepEqual(activity.calls[0].arguments, { pattern: '**/*' });
  assert.equal(activity.calls[0].result.files.length, 7);
  assert.deepEqual(activity.calls[1].result.matches.map(({ path }) => path),
    ['personal/love-letter.txt', 'planning/weekend-itinerary.md']);
  assert.equal(activity.calls[1].result.matches.every((match) => Number.isInteger(match.line) && !('text' in match)), true);
  assert.deepEqual(activity.calls[2].result, { path: 'creative/poem.md', line_ranges: [[3, 3]],
    total_lines: 21, next_offset: 4, truncated: true });
  assert.doesNotMatch(JSON.stringify(activity), /At dusk the harbor/);
  assert.deepEqual((await demo.api(`/calls/${demo.call.id}`)).data.file_activity, activity);
  await closed;
});

test('file errors return to the model without leaking absolute host paths or failing the voice call', { timeout: 6000 }, async (t) => {
  const demo = await setup(t);
  for (const [id, name, args] of [
    ['escape', 'read_file', { path: '../server.mjs' }],
    ['missing', 'read_file', { path: 'missing.txt' }],
    ['unknown', 'bash', { command: 'pwd' }],
    ['invalid', 'glob', { pattern: '*', limit: 500 }],
  ]) {
    demo.tool(id, name, args);
    const output = await demo.result(id);
    assert.equal(typeof output.error, 'string');
    assert.doesNotMatch(output.error, /\/home\/|fake-key|private material/);
  }
  assert.equal((await demo.api(`/calls/${demo.call.id}`)).data.status, 'active');
  demo.emit({ type: 'response.function_call_arguments.done', call_id: 'malformed', name: 'glob', arguments: '{bad' });
  assert.equal(typeof (await demo.result('malformed')).error, 'string');
  const activity = (await demo.api(`/calls/${demo.call.id}`)).data.file_activity;
  assert.equal(activity.calls.length, 5);
  assert.equal(activity.calls.every((entry) => entry.status === 'failed' && entry.delivered_to_voice && typeof entry.error === 'string'), true);
  assert.deepEqual(activity.calls.at(-1).arguments, null);
  assert.equal(activity.calls.at(-1).error, 'Invalid file tool arguments');
  assert.doesNotMatch(JSON.stringify(activity), /\/home\/|fake-key|private material/);
});

test('pending tool results wait for user speech and the automatic response can consume them', { timeout: 6000 }, async (t) => {
  const demo = await setup(t);
  demo.emit({ type: 'input_audio_buffer.speech_started' });
  demo.tool('find', 'glob', { pattern: '**/*.txt' });
  assert.deepEqual((await demo.result('find')).files, ['personal/love-letter.txt']);
  await sleep(75);
  assert.equal(demo.events.filter((event) => event.type === 'response.create').length, 0);
  demo.emit({ type: 'input_audio_buffer.speech_stopped' });
  demo.emit({ type: 'response.created', response: { id: 'automatic' } });
  demo.emit({ type: 'response.done', response: { id: 'automatic' } });
  await sleep(75);
  assert.equal(demo.events.filter((event) => event.type === 'response.create').length, 0);
});

test('a response collision defers the tool continuation until the active response finishes', { timeout: 6000 }, async (t) => {
  const demo = await setup(t);
  demo.tool('find', 'glob', { pattern: '**/*' });
  await demo.result('find');
  await waitFor(() => demo.events.some((event) => event.type === 'response.create'));
  const request = demo.events.find((event) => event.type === 'response.create');
  demo.emit({ type: 'response.created', response: { id: 'racing' } });
  demo.emit({ type: 'error', error: { code: 'conversation_already_has_active_response', event_id: request.event_id } });
  demo.emit({ type: 'response.done', response: { id: 'racing' } });
  await waitFor(() => demo.events.filter((event) => event.type === 'response.create').length === 2);
  assert.equal((await demo.api(`/calls/${demo.call.id}`)).data.status, 'active');
});

test('sideband failure ends the call and permits the next incoming call', { timeout: 6000 }, async (t) => {
  const demo = await setup(t);
  demo.tool('find', 'glob', { pattern: '**/*' });
  await demo.result('find');
  demo.socket().terminate();
  await waitFor(() => demo.socket().readyState === WebSocket.CLOSED);
  let call;
  for (let attempt = 0; attempt < 100; attempt++) {
    call = (await demo.api(`/calls/${demo.call.id}`)).data;
    if (call.status === 'failed') break;
    await sleep(5);
  }
  assert.equal(call.status, 'failed');
  assert.equal(call.incomplete, true);
  assert.equal(call.file_activity.complete, false);
  assert.equal(call.file_activity.calls[0].delivered_to_voice, true);
  assert.match(call.error, /File tool connection/);
  assert.equal((await demo.api('/calls', { context: 'Next call' })).status, 201);
});

test('a missing provider call ID fails initialization rather than offering unusable tools', { timeout: 6000 }, async (t) => {
  const demo = await setup(t, { request: async () => new Response('v=0\r\nanswer') });
  assert.equal(demo.connected.status, 502);
  assert.match(demo.connected.data.error, /valid Realtime call ID/);
  assert.equal((await demo.api(`/calls/${demo.call.id}`)).data.status, 'failed');
});

test('caller cancellation closes the sideband', { timeout: 6000 }, async (t) => {
  const demo = await setup(t);
  const closed = once(demo.socket(), 'close');
  await demo.api(`/calls/${demo.call.id}/finish`, {
    status: 'failed', history: [], incomplete: true, error: 'Calling agent cancelled the call',
  });
  await closed;
  assert.equal((await demo.api(`/calls/${demo.call.id}`)).data.error, 'Calling agent cancelled the call');
});

test('a call deadline closes its sideband without a browser hang-up', { timeout: 6000 }, async (t) => {
  const demo = await setup(t, { callTimeout: 1000 });
  assert.equal(demo.connected.status, 200);
  await once(demo.socket(), 'close');
  const call = (await demo.api(`/calls/${demo.call.id}`)).data;
  assert.equal(call.status, 'failed');
  assert.equal(call.error, 'Call time limit reached');
});

test('hang-up stops file tools before the browser drains its transcript', { timeout: 6000 }, async (t) => {
  const demo = await setup(t);
  demo.tool('find', 'glob', { pattern: '**/*', limit: 1 });
  await demo.result('find');
  const closed = once(demo.socket(), 'close');
  const stopped = await demo.api(`/calls/${demo.call.id}/stop-tools`, {});
  assert.equal(stopped.status, 200);
  await closed;
  assert.equal((await demo.api(`/calls/${demo.call.id}`)).data.status, 'active');
  const finished = await demo.api(`/calls/${demo.call.id}/finish`, {
    status: 'ended', history: [], incomplete: false,
  });
  assert.equal(finished.data.status, 'ended');
  assert.equal(finished.data.file_activity.complete, true);
  assert.deepEqual(finished.data.file_activity.calls[0].result, { files: ['business/use-case.md'], truncated: true });
});

test('assistant hang-up leaves execution to the WebRTC client and suppresses file tool continuations', { timeout: 6000 }, async (t) => {
  const demo = await setup(t);
  demo.emit({ type: 'response.created', response: { id: 'response_1' } });
  demo.tool('find', 'glob', { pattern: '**/*' });
  await demo.result('find');
  demo.tool('hangup', 'end_call', {});
  demo.emit({ type: 'response.done', response: { id: 'response_1' } });
  demo.tool('late', 'glob', { pattern: '**/*' });
  await sleep(100);
  assert.equal(demo.events.filter((event) => event.type === 'response.create').length, 0);
  assert.deepEqual(demo.events.filter((event) => event.item).map((event) => event.item.call_id), ['find']);
  assert.equal((await demo.api(`/calls/${demo.call.id}`)).data.status, 'active');
});
