import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { getCall, trigger } from './server.mjs';
import { DesktopCaller } from './desktop/caller.mjs';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const toolResult = (call) => ({
  content: [{ type: 'text', text: JSON.stringify(call) }],
  structuredContent: call,
  isError: call.status === 'failed',
});

export function createVoiceMcp({ origin, token, caller }) {
  const desktop = caller || (!origin && new DesktopCaller());
  const server = new McpServer({ name: 'voice-call', version });
  server.registerTool('take-call', {
    title: 'Call the user',
    description: (desktop ? 'Open the Linux Voice Call app, ring the user, and wait for Answer/Reject or hang-up. '
      : 'Ring the user’s open voice-call webpage and wait for them to answer and hang up. ')
      + 'A voice assistant discusses the supplied context and questions. Returns the ordered user/assistant '
      + 'transcript, call ID, status, and incomplete flag. Only one pending or active call is allowed. '
      + 'Unanswered calls expire after two minutes. Configure the MCP client timeout above timeout_seconds.',
    inputSchema: {
      context: z.string().trim().min(1).max(10_000).describe('Facts, purpose, and relevant context for the call.'),
      questions: z.array(z.string().trim().min(1).max(1000)).max(20).default([])
        .describe('Questions for the voice assistant to ask one at a time.'),
      timeout_seconds: z.number().int().min(30).max(3600).default(900)
        .describe('Maximum total wait, including ringing and conversation; defaults to 15 minutes.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ context, questions, timeout_seconds }, extra) => {
    const initialContext = questions.length
      ? `${context}\n\nQuestions to resolve:\n${questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}`
      : context;
    if (initialContext.length > 10_000) {
      return { isError: true, content: [{ type: 'text', text: 'Combined context and questions must fit within 10000 characters.' }] };
    }
    let progress = 0;
    const call = await (desktop ? desktop.trigger.bind(desktop) : trigger)({ origin, token, context: initialContext, timeout: timeout_seconds * 1000,
      signal: extra.signal, onProgress: async (current) => {
        const progressToken = extra._meta?.progressToken;
        if (progressToken === undefined) return;
        await extra.sendNotification({ method: 'notifications/progress', params: {
          progressToken, progress: ++progress, message: `Call ${current.id}: ${current.status}`,
        } });
      } });
    return toolResult(call);
  });
  server.registerTool('get-call', {
    description: 'Retrieve a voice call’s current status or final transcript by ID after a disconnected wait.',
    inputSchema: { id: z.string().uuid().describe('Call ID from take-call progress or its result.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id }) => toolResult(await (desktop ? desktop.get(id) : getCall({ origin, token }, id))));
  if (desktop) server.server.onclose = () => desktop.close();
  return server;
}

async function main() {
  let options = {};
  if (process.argv.includes('--web')) {
    const token = process.env.DEMO_TOKEN;
    if (!token) throw new Error('Set DEMO_TOKEN to the token used by the website server');
    const port = Number(process.env.PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
    options = { origin: `http://127.0.0.1:${port}`, token };
  }
  const server = createVoiceMcp(options);
  process.stdin.once('end', () => server.close());
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close().finally(() => process.exit()));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
