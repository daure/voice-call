import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo, trigger } from '../server.mjs';
import { History } from '../history.mjs';

async function demo(t, options = {}) {
  const server = createDemo({ token: 'test-token', apiKey: 'fake-key', toolsRoot: null, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = (path, method = 'GET', data, headers = {}) => fetch(`${origin}${path}`, {
    method, headers: { Authorization: 'Bearer test-token', ...headers },
    body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data),
  });
  return { origin, api };
}

test('event caller receives the ordered history after hang-up', async (t) => {
  const { origin, api } = await demo(t, { request: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
    assert.equal(options.headers.Authorization, 'Bearer fake-key');
    const session = JSON.parse(options.body.get('session'));
    assert.equal(session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
    assert.match(session.instructions, /Deployment failed/);
    return new Response('v=0\r\nmock-answer');
  } });
  const waiting = trigger({ origin, token: 'test-token', context: 'Deployment failed', timeout: 5000 });
  let call;
  while (!call) { call = await (await api('/current')).json(); }
  assert.equal(call.status, 'ringing');
  assert.equal((await api('/calls', 'POST', { context: 'second event' })).status, 409);
  const connected = await api(`/calls/${call.id}/connect`, 'POST', 'v=0\r\nmock-offer');
  assert.equal(await connected.text(), 'v=0\r\nmock-answer');
  assert.equal((await api(`/calls/${call.id}/connect`, 'POST', 'v=0')).status, 409);
  const history = [{ id: 'a', role: 'assistant', text: 'Should I roll back?' },
    { id: 'u', role: 'user', text: 'Yes.' }];
  await api(`/calls/${call.id}/finish`, 'POST', { status: 'ended', history, incomplete: false });
  const result = await waiting;
  assert.equal(result.status, 'ended');
  assert.deepEqual(result.history, history);
  assert.equal(result.incomplete, false);
  assert.ok(result.ended_at);
});

test('authentication and origin checks protect billable endpoints', async (t) => {
  const { origin, api } = await demo(t);
  assert.equal((await fetch(`${origin}/current`)).status, 401);
  assert.equal((await api('/calls', 'POST', { context: 'event' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await api('/calls', 'POST', { context: '' })).status, 400);
  assert.equal((await api('/calls', 'POST', '{broken')).status, 400);
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /fake-key|test-token/);
});

test('upstream rejection returns a failed call to the caller', async (t) => {
  const { api } = await demo(t, { request: async () => new Response('Access denied', { status: 403 }) });
  const call = await (await api('/calls', 'POST', { context: 'event' })).json();
  assert.equal((await api(`/calls/${call.id}/connect`, 'POST', 'v=0')).status, 502);
  const result = await (await api(`/calls/${call.id}`)).json();
  assert.equal(result.status, 'failed');
  assert.match(result.error, /OpenAI HTTP 403/);
});

test('editable context configures the assistant before the call starts', async (t) => {
  let instructions;
  const { api } = await demo(t, { request: async (_url, options) => {
    instructions = JSON.parse(options.body.get('session')).instructions;
    return new Response('v=0\r\nmock-answer');
  } });
  const call = await (await api('/calls', 'POST', { context: 'Original event context' })).json();
  assert.equal((await api(`/calls/${call.id}`, 'PATCH', { context: ' ' })).status, 400);
  const updated = await (await api(`/calls/${call.id}`, 'PATCH', {
    context: 'Explain bug BILL-218: an invoice date shows the previous day.',
  })).json();
  assert.equal(updated.context, 'Explain bug BILL-218: an invoice date shows the previous day.');
  assert.equal((await api(`/calls/${call.id}/connect`, 'POST', 'v=0')).status, 200);
  assert.match(instructions, /Immediately begin speaking/);
  assert.match(instructions, /Explain bug BILL-218/);
  assert.equal((await api(`/calls/${call.id}`, 'PATCH', { context: 'Another scenario' })).status, 409);
});

test('declined calls return an empty history and allow another event', async (t) => {
  const { api } = await demo(t);
  const call = await (await api('/calls', 'POST', { context: 'event' })).json();
  assert.equal((await api(`/calls/${call.id}/finish`, 'POST', { status: 'ended', history: [null], incomplete: false })).status, 400);
  const result = await (await api(`/calls/${call.id}/finish`, 'POST', { status: 'declined', history: [], incomplete: false })).json();
  assert.equal(result.status, 'declined');
  assert.deepEqual(result.history, []);
  assert.equal((await api('/calls', 'POST', { context: 'next event' })).status, 201);
});

test('a connected call expires at its total deadline without a browser finish', { timeout: 5000 }, async (t) => {
  const { api } = await demo(t, { request: async () => new Response('v=0\r\nmock-answer') });
  assert.equal((await api('/calls', 'POST', { context: 'event', timeout_ms: 0 })).status, 400);
  const call = await (await api('/calls', 'POST', { context: 'event', timeout_ms: 1000 })).json();
  assert.equal((await api(`/calls/${call.id}/connect`, 'POST', 'v=0')).status, 200);
  let result;
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = await (await api(`/calls/${call.id}`)).json();
  } while (result.status === 'active');
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Call time limit reached');
  assert.equal(result.incomplete, true);
  assert.equal((await api('/calls', 'POST', { context: 'next event' })).status, 201);
});

test('transcription completion order does not change conversation order', () => {
  const history = new History();
  history.receive({ type: 'response.output_audio_transcript.done', item_id: 'assistant', transcript: 'Okay.' });
  history.receive({ type: 'conversation.item.added', previous_item_id: 'user', item: { id: 'assistant', type: 'message', role: 'assistant' } });
  history.receive({ type: 'input_audio_buffer.committed', item_id: 'user', previous_item_id: null });
  assert.equal(history.pending.size, 1);
  history.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user', transcript: 'Roll back.' });
  history.receive({ type: 'conversation.item.truncated', item_id: 'assistant' });
  assert.deepEqual(history.snapshot().map((item) => [item.role, item.text]), [['user', 'Roll back.'], ['assistant', 'Okay.']]);
  assert.equal(history.snapshot()[1].interrupted, true);
  assert.equal(history.pending.size, 0);
  history.receive({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'other' });
  assert.equal(history.failed, true);
});
