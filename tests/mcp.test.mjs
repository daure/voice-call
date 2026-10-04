import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDemo } from '../server.mjs';
import { WebSocket, WebSocketServer } from 'ws';

async function connect(t, options = {}) {
  const server = createDemo({ token: 'mcp-test', apiKey: 'fake-key', toolsRoot: null,
    request: async () => new Response('v=0\r\nmock-answer'), ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'voice-call-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../mcp.mjs', import.meta.url)), '--web'],
    env: { ...process.env, PORT: String(server.address().port), DEMO_TOKEN: 'mcp-test' }, stderr: 'pipe' });
  t.after(async () => {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await client.connect(transport);
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(`${origin}${path}`, { method,
      headers: { Authorization: 'Bearer mcp-test' },
      body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data) });
    assert.equal(response.ok, true);
    return path.endsWith('/connect') ? response.text() : response.json();
  };
  return { client, api };
}

function startCall(client, options = {}, arguments_ = {
  context: 'The checkout deployment failed.', questions: ['Should we roll it back?'],
}) {
  let progressReceived;
  const progress = new Promise((resolve) => { progressReceived = resolve; });
  const result = client.callTool({ name: 'take-call', arguments: arguments_ }, undefined,
    { timeout: 5000, onprogress: progressReceived, ...options });
  return { result, progress };
}

test('take-call waits across stdio until hang-up and returns the transcript and file activity', { timeout: 10_000 }, async (t) => {
  const provider = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => provider.once('listening', resolve));
  t.after(async () => {
    for (const socket of provider.clients) socket.terminate();
    await new Promise((resolve) => provider.close(resolve));
  });
  let socket;
  provider.on('connection', (connection) => { socket = connection; });
  let instructions;
  const { client, api } = await connect(t, {
    toolsRoot: fileURLToPath(new URL('../test-docs/', import.meta.url)),
    connectTools: () => new WebSocket(`ws://127.0.0.1:${provider.address().port}`),
    request: async (_url, options) => {
    instructions = JSON.parse(options.body.get('session')).instructions;
    return new Response('v=0\r\nmock-answer', { headers: { Location: '/v1/realtime/calls/rtc_mcp' } });
  } });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['take-call', 'get-call']);
  const briefing = `Project evidence:\n${'Known fact: the previous release is healthy.\n'.repeat(2000)}End of briefing.`;
  const waiting = startCall(client, {}, { context: briefing, questions: ['Should we roll it back?'] });
  let settled = false;
  waiting.result.then(() => { settled = true; });
  const progress = await Promise.race([waiting.progress, waiting.result.then((result) => {
    throw new Error(`Call ended before ringing: ${JSON.stringify(result)}`);
  })]);
  const call = await api('/current');
  assert.equal(call.status, 'ringing');
  assert.match(progress.message, new RegExp(call.id));
  assert.equal(call.context, `${briefing}\n\nQuestions to resolve:\n1. Should we roll it back?`);
  assert.equal(settled, false);
  assert.equal(await api(`/calls/${call.id}/connect`, 'POST', 'v=0\r\nmock-offer'), 'v=0\r\nmock-answer');
  assert.match(instructions, /Should we roll it back\?/);
  assert.match(instructions, /on behalf of another AI agent/);
  assert.match(instructions, /Speak English/);
  assert.match(instructions, /only when the user explicitly asks/);
  assert.ok(instructions.endsWith(call.context));
  const output = new Promise((resolve) => socket.on('message', (data) => {
    const event = JSON.parse(data);
    if (event.item?.call_id === 'files') resolve(JSON.parse(event.item.output));
  }));
  socket.send(JSON.stringify({ type: 'response.function_call_arguments.done',
    call_id: 'files', name: 'glob', arguments: '{"pattern":"**/*"}' }));
  assert.equal((await output).files.length, 7);
  assert.equal(settled, false);
  const history = [{ id: 'a', role: 'assistant', text: 'Should we roll it back?' },
    { id: 'u', role: 'user', text: 'Yes, roll it back.' }];
  await api(`/calls/${call.id}/finish`, 'POST', { status: 'ended', history, incomplete: false });
  const result = await waiting.result;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.id, call.id);
  assert.deepEqual(result.structuredContent.history, history);
  assert.equal(result.structuredContent.incomplete, false);
  assert.equal(result.structuredContent.file_activity.root, 'test-docs');
  assert.equal(result.structuredContent.file_activity.complete, true);
  assert.equal(result.structuredContent.file_activity.calls[0].result.files.length, 7);
  assert.equal(result.structuredContent.file_activity.calls[0].delivered_to_voice, true);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const recovered = await client.callTool({ name: 'get-call', arguments: { id: call.id } });
  assert.deepEqual(recovered.structuredContent, result.structuredContent);
});

test('a busy call rejects a second caller while decline releases the first wait', { timeout: 10_000 }, async (t) => {
  const { client, api } = await connect(t);
  const waiting = startCall(client);
  await waiting.progress;
  const call = await api('/current');
  const busy = await client.callTool({ name: 'take-call', arguments: { context: 'Another request' } });
  assert.equal(busy.isError, true);
  assert.match(busy.content[0].text, /already pending or active/);
  assert.equal((await api('/current')).id, call.id);
  await api(`/calls/${call.id}/finish`, 'POST', { status: 'declined', history: [], incomplete: false });
  const result = await waiting.result;
  assert.equal(result.structuredContent.status, 'declined');
  assert.deepEqual(result.structuredContent.history, []);
  assert.deepEqual(result.structuredContent.file_activity, { root: null, complete: true, calls: [] });
});

test('MCP cancellation ends ringing and releases the call slot', { timeout: 10_000 }, async (t) => {
  const { client, api } = await connect(t);
  const controller = new AbortController();
  const waiting = startCall(client, { signal: controller.signal });
  await waiting.progress;
  const rejected = assert.rejects(waiting.result, /cancel|abort/i);
  controller.abort();
  await rejected;
  let call;
  for (let attempt = 0; attempt < 100; attempt++) {
    call = await api('/current');
    if (call.status === 'failed') break;
    await sleep(10);
  }
  assert.equal(call.status, 'failed');
  assert.equal(call.error, 'Calling agent cancelled the call');
  assert.equal(call.incomplete, true);
  const next = await api('/calls', 'POST', { context: 'Next request' });
  assert.equal(next.status, 'ringing');
  await api(`/calls/${next.id}/finish`, 'POST', { status: 'declined', history: [], incomplete: false });
});

test('unanswered calls return a failed result and allow another call', { timeout: 10_000 }, async (t) => {
  const { client, api } = await connect(t, { answerTimeout: 20 });
  const waiting = startCall(client);
  const result = await waiting.result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 'failed');
  assert.equal(result.structuredContent.error, 'Call was not answered in time');
  assert.equal(result.structuredContent.incomplete, true);
  const next = await api('/calls', 'POST', { context: 'Another request' });
  assert.equal(next.status, 'ringing');
});

test('invalid tool input does not ring the website', { timeout: 10_000 }, async (t) => {
  const { client, api } = await connect(t);
  for (const arguments_ of [{ context: ' ' }, { context: 'Event', timeout_seconds: 0 },
    { context: 'x'.repeat(100_001) }, { context: 'x'.repeat(100_000), questions: ['Question'] }]) {
    const result = await client.callTool({ name: 'take-call', arguments: arguments_ });
    assert.equal(result.isError, true);
    assert.equal(await api('/current'), null);
  }
});

test('default stdio MCP advertises the desktop and needs no website token', { timeout: 10_000 }, async (t) => {
  const env = { ...process.env };
  for (const key of ['DEMO_TOKEN', 'OPENAI_API_KEY', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[key];
  const client = new Client({ name: 'desktop-stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../mcp.mjs', import.meta.url))], env, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.match(tools.find((tool) => tool.name === 'take-call').description, /Linux Voice Call app/);
  const result = await client.callTool({ name: 'take-call', arguments: { context: 'Check the desktop session.' } });
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /Linux desktop session/);
  const recovered = await client.callTool({ name: 'get-call', arguments: { id: result.structuredContent.id } });
  assert.deepEqual(recovered.structuredContent, result.structuredContent);
});
