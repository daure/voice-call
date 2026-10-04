import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { attachFileTools } from '../realtime-tools.mjs';
import { createFileActivity, emptyFileActivity } from '../file-activity.mjs';

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for file activity');
    await sleep(5);
  }
}

async function setup(t, execute) {
  const provider = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(provider, 'listening');
  let socket;
  const events = [];
  provider.on('connection', (connection) => {
    socket = connection;
    socket.on('message', (data) => events.push(JSON.parse(data.toString())));
  });
  const data = emptyFileActivity('test-docs');
  const sideband = attachFileTools({ callId: 'rtc_audit', apiKey: 'offline', execute, fileActivity: data,
    onFailure: (error) => assert.fail(error),
    connect: () => new WebSocket(`ws://127.0.0.1:${provider.address().port}`) });
  t.after(async () => {
    sideband.close();
    for (const client of provider.clients) client.terminate();
    await new Promise((resolve) => provider.close(resolve));
  });
  await sideband.ready;
  const emit = (event) => socket.send(JSON.stringify(event));
  const tool = (id, name = 'glob') => emit({ type: 'response.function_call_arguments.done',
    response_id: 'response_1', call_id: id, name, arguments: '{"pattern":"**/*"}' });
  return { data, sideband, events, tool, emit };
}

test('concurrent file activity keeps request order and records rejected work', async (t) => {
  const releases = new Map();
  const demo = await setup(t, (_name, args) => new Promise((resolve) => releases.set(args.pattern, resolve)));
  for (const [id, pattern] of [['first', 'one'], ['second', 'two'], ['third', 'three'], ['rejected', 'four']]) {
    demo.emit({ type: 'response.function_call_arguments.done', call_id: id, name: 'glob', arguments: JSON.stringify({ pattern }) });
  }
  await waitFor(() => demo.data.calls.length === 4 && demo.data.calls[3].delivered_to_voice);
  assert.equal(demo.data.calls[3].status, 'failed');
  assert.equal(demo.data.calls[3].error, 'At most three file tools can run at once');
  releases.get('two')({ files: ['two.md'], truncated: false });
  releases.get('three')({ files: [], truncated: false });
  releases.get('one')({ files: ['one.md'], truncated: true });
  await waitFor(() => demo.data.calls.every((entry) => entry.delivered_to_voice));
  demo.sideband.close();
  assert.equal(demo.data.complete, true);
  assert.deepEqual(demo.data.calls.map((entry) => entry.call_id), ['first', 'second', 'third', 'rejected']);
  assert.deepEqual(demo.data.calls.map((entry) => entry.sequence), [1, 2, 3, 4]);
  assert.deepEqual(demo.data.calls[1].result, { files: ['two.md'], truncated: false });
  assert.deepEqual(demo.data.calls[2].result, { files: [], truncated: false });
});

for (const method of ['manual hang-up', 'assistant hang-up']) {
  test(`${method} records cancelled file work and freezes late results`, async (t) => {
    let release;
    const demo = await setup(t, () => new Promise((resolve) => { release = resolve; }));
    demo.tool('pending');
    await waitFor(() => demo.data.calls.length === 1);
    if (method === 'assistant hang-up') demo.tool('end', 'end_call');
    else demo.sideband.close();
    await waitFor(() => demo.data.calls[0].status === 'cancelled');
    const snapshot = structuredClone(demo.data);
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.calls[0].delivered_to_voice, false);
    assert.equal(snapshot.calls.length, 1);
    release({ files: ['late.md'], truncated: false });
    await sleep(75);
    assert.deepEqual(demo.data, snapshot);
    assert.equal(demo.events.some((event) => event.item?.call_id === 'pending'), false);
  });
}

test('delivery is recorded only after successful transport and unresolved delivery has incomplete coverage', () => {
  const log = createFileActivity({ data: emptyFileActivity('docs') });
  const entry = log.begin({ call_id: 'files', name: 'glob' }, { pattern: '*' });
  log.finish(entry, { files: ['a.md'], truncated: false });
  log.sending(entry);
  assert.equal(entry.delivered_to_voice, false);
  log.delivered(entry);
  assert.equal(entry.delivered_to_voice, true);
  const pending = log.begin({ call_id: 'pending', name: 'glob' }, { pattern: '*' });
  log.finish(pending, { files: [], truncated: false });
  log.sending(pending);
  log.stop();
  assert.equal(log.data.complete, false);
  log.delivered(pending);
  assert.equal(pending.delivered_to_voice, false);
});

test('activity size limits report omitted metadata without copying file text', () => {
  const log = createFileActivity({ data: emptyFileActivity('docs') });
  for (let index = 0; index < 100; index++) {
    const entry = log.begin({ call_id: `call_${index}`, name: 'grep' }, { pattern: 'needle' });
    log.finish(entry, { matches: Array.from({ length: 100 }, (_, line) => ({
      path: `${'folder/'.repeat(20)}file.md`, line: line + 1, text: 'private document text', truncated: false,
    })), skipped_files: [], truncated: false });
  }
  log.stop();
  assert.equal(log.data.complete, false);
  assert.equal(log.data.calls.some((entry) => entry.result_omitted), true);
  assert.ok(Buffer.byteLength(JSON.stringify(log.data)) < 256 * 1024);
  assert.doesNotMatch(JSON.stringify(log.data), /private document text/);
});
