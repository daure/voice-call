import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';
import electron from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DesktopCaller } from '../desktop/caller.mjs';
import { startDevelopment } from '../dev-server.mjs';
import { REALTIME_VOICES } from '../voice-session.mjs';

let child, testReady, serial = 0;
const commands = new Map();
const caller = new DesktopCaller({ launch: () => {
  const env = { ...process.env, OPENAI_REALTIME_VOICE: 'coral' };
  delete env.OPENAI_API_KEY;
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electron, [fileURLToPath(new URL('./desktop-fixture.mjs', import.meta.url))], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stderr.on('data', (data) => process.stderr.write(data));
  testReady = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message?.type === 'test-ready') resolve();
      if (message?.type === 'test-result') {
        const command = commands.get(message.id);
        if (!command) return;
        commands.delete(message.id);
        message.error ? command.reject(new Error(message.error)) : command.resolve(message.value);
      }
    });
    child.once('exit', () => reject(new Error('Electron fixture exited during startup')));
    child.once('error', reject);
  });
  return child;
} });
let development;
const client = new Client({ name: 'desktop-test', version: '1.0.0' });
const deadline = setTimeout(() => { console.error('Desktop verification timed out'); caller.close(); process.exit(1); }, 40_000);

const command = (action, extra = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  commands.set(id, { resolve, reject });
  child.send({ type: 'test', id, action, ...extra });
});
const evaluate = (code) => command('eval', { code });
const waitFor = async (code) => {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await evaluate(code)) return;
    await sleep(25);
  }
  throw new Error(`Renderer condition timed out: ${code}`);
};
const ring = async (context, options = {}) => {
  const result = client.callTool({ name: 'take-call', arguments: { context } }, undefined, { timeout: 15_000, ...options });
  await caller.open();
  await testReady;
  await waitFor(`document.getElementById('context').textContent === ${JSON.stringify(context)} && !document.getElementById('answer').disabled`);
  return { result };
};

try {
  development = await startDevelopment({ port: 0, caller });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${development.origin}/mcp`)));
  await testReady;
  assert.equal((await command('inspect')).visible, true);
  assert.deepEqual((await command('inspect')).preferences, { sandbox: true, nodeIntegration: false, contextIsolation: true });
  assert.equal(await evaluate('typeof process'), 'undefined');
  assert.equal(await evaluate('typeof require'), 'undefined');
  assert.deepEqual(await evaluate("Array.from(document.getElementById('voice').options, option => option.value)"), [...REALTIME_VOICES]);
  assert.equal(await evaluate("document.getElementById('voice').value"), 'coral');
  assert.equal(await evaluate("document.getElementById('voice').disabled"), false);
  await evaluate("document.getElementById('voice').value = 'cedar'; document.getElementById('voice').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate('window.microphoneRequests'), 0);
  assert.equal((await command('inspect')).negotiatedVoice, undefined);
  await command('screenshot', { path: '/tmp/opencode/voice-call-idle.png' });
  const waiting = await ring('Discuss the mock deployment.');
  await waitFor('window.ringSounds > 0');
  assert.equal(await evaluate('window.microphoneRequests'), 0);
  assert.equal(await evaluate("document.getElementById('context-panel').open"), false);
  assert.equal(await evaluate("document.body.classList.contains('ringing')"), true);
  assert.equal(await evaluate("document.getElementById('voice').disabled"), false);
  assert.equal(await evaluate("document.getElementById('voice').value"), 'cedar');
  await command('screenshot', { path: '/tmp/opencode/voice-call-incoming.png' });
  await evaluate("document.getElementById('answer').click()");
  await waitFor("document.getElementById('badge').textContent === 'Live'");
  assert.equal(await evaluate("document.body.classList.contains('ringing')"), false);
  assert.equal(await evaluate("document.getElementById('voice').disabled"), true);
  assert.equal((await command('inspect')).negotiatedVoice, 'cedar');
  await assert.rejects(evaluate(`window.voiceCall.begin(${JSON.stringify(caller.waiting.call.id)}, 'ash')`), /Call already answered/);
  await evaluate("document.getElementById('hangup').click()");
  const result = await waiting.result;
  assert.equal(result.structuredContent.status, 'ended');
  assert.deepEqual(result.structuredContent.history.map((item) => item.text), ['Hello.', 'Hi there.']);
  assert.equal(result.structuredContent.incomplete, false);
  assert.equal((await command('inspect')).visible, true);
  await waitFor("document.getElementById('history').textContent.includes('Hi there.')");
  assert.equal(await evaluate("document.getElementById('voice').disabled"), false);
  assert.equal(await evaluate("document.getElementById('voice').value"), 'coral');
  await command('screenshot', { path: '/tmp/opencode/voice-call-complete.png' });
  const recovered = await client.callTool({ name: 'get-call', arguments: { id: result.structuredContent.id } });
  assert.deepEqual(recovered.structuredContent, result.structuredContent);

  const rejected = await ring('Reject the mock call.');
  assert.equal(await evaluate("document.getElementById('voice').value"), 'coral');
  assert.equal(await evaluate("document.getElementById('voice').disabled"), false);
  await evaluate("document.getElementById('reject').click()");
  assert.equal((await rejected.result).structuredContent.status, 'declined');
  assert.equal(await evaluate('window.microphoneRequests'), 1);

  const farewell = await ring('Say goodbye and end this call.');
  await evaluate("document.getElementById('answer').click()");
  await waitFor("document.getElementById('badge').textContent === 'Live'");
  await evaluate(`(() => {
    const emit = (event) => window.voiceChannel.onmessage({ data: JSON.stringify(event) });
    emit({ type: 'response.created', response: { id: 'goodbye' } });
    emit({ type: 'output_audio_buffer.started', response_id: 'goodbye' });
    emit({ type: 'conversation.item.added', previous_item_id: 'a', item: { id: 'bye', type: 'message', role: 'assistant' } });
    emit({ type: 'response.output_audio_transcript.done', item_id: 'bye', transcript: 'Goodbye!' });
    emit({ type: 'response.function_call_arguments.done', response_id: 'goodbye', call_id: 'end', name: 'end_call', arguments: '{}' });
    emit({ type: 'response.done', response: { id: 'goodbye' } });
  })()`);
  await sleep(1200);
  assert.equal((await command('inspect')).state, 'active');
  const farewellChild = child;
  const farewellExited = once(farewellChild, 'exit');
  await evaluate("window.voiceChannel.onmessage({ data: JSON.stringify({ type: 'output_audio_buffer.stopped', response_id: 'goodbye' }) })");
  const farewellResult = (await farewell.result).structuredContent;
  assert.equal(farewellResult.status, 'ended');
  assert.equal(farewellResult.incomplete, false);
  assert.equal(farewellResult.history.at(-1).text, 'Goodbye!');
  await farewellExited;
  assert.equal(caller.child, null);
  assert.equal(development.server.listening, true);
  const recoveredFarewell = await client.callTool({ name: 'get-call', arguments: { id: farewellResult.id } });
  assert.deepEqual(recoveredFarewell.structuredContent, farewellResult);

  const race = await ring('Finish while microphone permission is pending.');
  assert.notEqual(child, farewellChild);
  await evaluate("window.delayMicrophone = true; document.getElementById('answer').click()");
  await waitFor("typeof window.resolveMicrophone === 'function'");
  assert.equal(await evaluate("document.getElementById('voice').disabled"), true);
  await evaluate("document.getElementById('hangup').click()");
  assert.equal((await race.result).structuredContent.status, 'ended');
  const stoppedBefore = await evaluate('window.stoppedTracks');
  await evaluate('window.delayMicrophone = false; window.resolveMicrophone()');
  await waitFor(`window.stoppedTracks > ${stoppedBefore}`);

  const quota = await ring('quota-test');
  await evaluate("document.getElementById('answer').click()");
  assert.match((await quota.result).structuredContent.error, /credit_balance_exhausted/);
  await waitFor("document.getElementById('status').textContent.includes('credit_balance_exhausted')");

  const denied = await ring('Microphone denied.');
  await evaluate("window.denyMicrophone = true; document.getElementById('answer').click()");
  assert.match((await denied.result).structuredContent.error, /Microphone permission denied/);
  await evaluate('window.denyMicrophone = false');

  const abort = new AbortController();
  const cancelled = await ring('Cancel during transcription draining.', { signal: abort.signal });
  await evaluate("document.getElementById('answer').click()");
  await waitFor("document.getElementById('badge').textContent === 'Live'");
  await evaluate("document.getElementById('hangup').click()");
  await waitFor("document.getElementById('status').textContent.includes('Finishing pending')");
  const aborted = assert.rejects(cancelled.result, /abort|cancel/i);
  abort.abort(); await aborted;
  await waitFor("document.getElementById('badge').textContent === 'Failed'");
  const next = await ring('Next call remains ringing during the old drain.');
  await sleep(1200);
  assert.equal(await evaluate("document.getElementById('badge').textContent"), 'Incoming');
  await evaluate("document.getElementById('reject').click()");
  assert.equal((await next.result).structuredContent.status, 'declined');

  assert.deepEqual(await evaluate('window.pageErrors'), []);
  const closed = await ring('Closing the window rejects a ringing call.');
  const exited = once(child, 'exit');
  child.send({ type: 'test', action: 'close' });
  assert.equal((await closed.result).structuredContent.status, 'declined');
  await exited;
  console.log('Desktop verification passed: development HTTP MCP, idle window, sandbox, ringing, per-call voice picker, configured voice reset, locked voice during connection and speech, Answer/Reject, assistant goodbye, automatic app exit, result retention, app relaunch, manual hang-up review window, permission race, cancellation, provider errors, window close.');
  console.log('Screenshots: /tmp/opencode/voice-call-incoming.png and /tmp/opencode/voice-call-complete.png');
} finally {
  clearTimeout(deadline);
  await client.close();
  await development?.close();
  caller.close();
}
