import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDemo } from '../server.mjs';

const server = createDemo({ token: 'offline-test', apiKey: 'fake-key', toolsRoot: null,
  request: async () => new Response('v=0\r\nmock-answer') });
const client = new Client({ name: 'voice-browser-test', version: '1.0.0' });
const execute = promisify(execFile);
const run = async (...args) => {
  const { stdout } = await execute('playwright-cli', ['-s=voice-call-test', ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 60_000, maxBuffer: 1_000_000,
  });
  if (args[0] === 'run-code') {
    const match = /^### Result\n(.+)$/m.exec(stdout);
    assert.ok(match, `Browser validation did not return a result:\n${stdout}`);
    const result = JSON.parse(match[1]);
    assert.deepEqual(result.pageErrors, []);
    console.log(match[1]);
  } else {
    console.log(stdout.split('### Ran Playwright code')[0].trim());
  }
};

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(18787, '127.0.0.1', resolve);
  });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../mcp.mjs', import.meta.url)), '--web'],
    env: { ...process.env, DEMO_TOKEN: 'offline-test', PORT: '18787' }, stderr: 'pipe' }));
  await run('open', 'about:blank');
  const waiting = client.callTool({ name: 'take-call', arguments: {
    context: 'MCP browser integration', questions: ['Can you hear me?'],
  } }, undefined, { timeout: 30_000 });
  const [, result] = await Promise.all([run('run-code', '--filename=tests/browser-check.js'), waiting]);
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.status, 'ended');
  assert.equal(result.structuredContent.context, 'MCP browser integration\n\nQuestions to resolve:\n1. Can you hear me?');
  assert.deepEqual(result.structuredContent.history.map((item) => [item.role, item.text]),
    [['user', 'Hello.'], ['assistant', 'Hi there.']]);
  assert.equal(result.structuredContent.incomplete, false);
  console.log('MCP → browser ringing → answer → hang up → transcript: passed (mocked voice provider).');
} finally {
  await client.close();
  await new Promise((resolve) => server.close(resolve));
  await run('close');
}
