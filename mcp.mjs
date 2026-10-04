import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { getCall, trigger } from './server.mjs';
import { DesktopCaller } from './desktop/caller.mjs';
import { MAX_CONTEXT_CHARACTERS } from './voice-session.mjs';
import { resolveSessionRoot } from './session-root.mjs';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const toolResult = (call) => ({
  content: [{ type: 'text', text: JSON.stringify(call) }],
  structuredContent: call,
  isError: call.status === 'failed',
});

export function createVoiceMcp({ origin, token, caller, closeCallerOnDisconnect = true, resolveRoot = resolveSessionRoot }) {
  const desktop = caller || (!origin && new DesktopCaller());
  const disconnected = new AbortController();
  const server = new McpServer({ name: 'voice-call', version });
  server.registerTool('take-call', {
    title: 'Call the user',
    description: (desktop ? 'Open the Linux Voice Call app, ring the user, and wait for Answer/Reject or hang-up. '
      : 'Ring the user’s open voice-call webpage and wait for them to answer and hang up. ')
      + 'Prime the voice assistant with a detailed, self-contained briefing: project background, goals, current state, '
      + 'relevant evidence or excerpts, constraints, decisions already made, attempted approaches, risks, and open questions. '
      + 'The voice assistant cannot see this agent’s conversation. It can explore files read-only within the calling OpenCode session’s active working directory. '
      + 'Include the facts needed to reason about the topic, not just a short call summary; exclude secrets. '
      + 'The conversation starts in English. Returns the ordered user/assistant '
      + 'transcript, call ID, status, incomplete flag, and file_activity: ordered file tool requests, '
      + 'arguments, result paths/line ranges, errors, and delivery flags. Only one pending or active call is allowed. '
      + 'Unanswered calls expire after two minutes. Configure the MCP client timeout above timeout_seconds.',
    inputSchema: {
      context: z.string().trim().min(1).max(MAX_CONTEXT_CHARACTERS)
        .describe('Detailed briefing for the voice assistant: background, goals, evidence, constraints, decisions, attempted approaches, and unresolved issues. Up to 100000 characters including appended questions; provider token limits also apply. Include relevant excerpts because the voice assistant cannot access the calling agent’s conversation. Exclude secrets.'),
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
    if (initialContext.length > MAX_CONTEXT_CHARACTERS) {
      return { isError: true, content: [{ type: 'text', text: `Combined context and questions must fit within ${MAX_CONTEXT_CHARACTERS} characters.` }] };
    }
    const signal = desktop ? AbortSignal.any([extra.signal, disconnected.signal]) : extra.signal;
    if (!desktop && extra._meta?.['ai.opencode/sessionID'] !== undefined) {
      throw new Error('OpenCode session-relative file access requires desktop MCP, not the optional browser demo.');
    }
    const toolsRoot = desktop ? await resolveRoot(extra._meta, { signal }) : undefined;
    signal?.throwIfAborted();
    let progress = 0;
    const call = await (desktop ? desktop.trigger.bind(desktop) : trigger)({ origin, token, context: initialContext, timeout: timeout_seconds * 1000,
      toolsRoot, signal, onProgress: async (current) => {
        const progressToken = extra._meta?.progressToken;
        if (progressToken === undefined) return;
        await extra.sendNotification({ method: 'notifications/progress', params: {
          progressToken, progress: ++progress, message: `Call ${current.id}: ${current.status}`,
        } });
      } });
    return toolResult(call);
  });
  server.registerTool('get-call', {
    description: 'Retrieve a voice call’s current status, transcript, and file_activity by ID after a disconnected wait.',
    inputSchema: { id: z.string().uuid().describe('Call ID from take-call progress or its result.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id }) => toolResult(await (desktop ? desktop.get(id) : getCall({ origin, token }, id))));
  if (desktop) server.server.onclose = () => {
    disconnected.abort();
    if (closeCallerOnDisconnect) desktop.close();
  };
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
