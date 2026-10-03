import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';
import electron from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DesktopCaller } from '../desktop/caller.mjs';
import { createVoiceMcp } from '../mcp.mjs';

let child, testReady, serial = 0;
const commands = new Map();
const caller = new DesktopCaller({ launch: () => {
  const env = { ...process.env };
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
const server = createVoiceMcp({ caller });
const client = new Client({ name: 'desktop-test', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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
  await waitFor(`document.getElementById('context').textContent === ${JSON.stringify(context)} && !document.getElementById('answer').disabled`);
  return { result };
};

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await caller.open();
  await testReady;
  assert.deepEqual((await command('inspect')).preferences, { sandbox: true, nodeIntegration: false, contextIsolation: true });
  assert.equal(await evaluate('typeof process'), 'undefined');
  assert.equal(await evaluate('typeof require'), 'undefined');
  const waiting = await ring('Discuss the mock deployment.');
  await waitFor('window.ringSounds > 0');
  assert.equal(await evaluate('window.microphoneRequests'), 0);
  assert.equal(await evaluate("document.getElementById('context-panel').open"), false);
  assert.equal(await evaluate("document.body.classList.contains('ringing')"), true);
  await command('screenshot', { path: '/tmp/opencode/voice-call-incoming.png' });
  await evaluate("document.getElementById('answer').click()");
  await waitFor("document.getElementById('badge').textContent === 'Live'");
  assert.equal(await evaluate("document.body.classList.contains('ringing')"), false);
  await evaluate("document.getElementById('hangup').click()");
  const result = await waiting.result;
  assert.equal(result.structuredContent.status, 'ended');
  assert.deepEqual(result.structuredContent.history.map((item) => item.text), ['Hello.', 'Hi there.']);
  assert.equal(result.structuredContent.incomplete, false);
  assert.equal((await command('inspect')).visible, true);
  await waitFor("document.getElementById('history').textContent.includes('Hi there.')");
  await command('screenshot', { path: '/tmp/opencode/voice-call-complete.png' });
  const recovered = await client.callTool({ name: 'get-call', arguments: { id: result.structuredContent.id } });
  assert.deepEqual(recovered.structuredContent, result.structuredContent);

  const rejected = await ring('Reject the mock call.');
  await evaluate("document.getElementById('reject').click()");
  assert.equal((await rejected.result).structuredContent.status, 'declined');
  assert.equal(await evaluate('window.microphoneRequests'), 1);

  const race = await ring('Finish while microphone permission is pending.');
  await evaluate("window.delayMicrophone = true; document.getElementById('answer').click()");
  await waitFor("typeof window.resolveMicrophone === 'function'");
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
  console.log('Desktop verification passed: sandbox, MCP launch, ringing, Answer/Reject, transcript, review window, permission race, cancellation, provider errors, window close.');
  console.log('Screenshots: /tmp/opencode/voice-call-incoming.png and /tmp/opencode/voice-call-complete.png');
} finally {
  clearTimeout(deadline);
  await client.close();
  await server.close();
  caller.close();
}
