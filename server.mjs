import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFileTools } from './file-tools.mjs';
import { attachFileTools } from './realtime-tools.mjs';
import { negotiateVoice } from './voice-session.mjs';

const terminalStates = new Set(['ended', 'declined', 'failed']);
const validContext = (context) => typeof context === 'string' && context.trim() && context.length <= 10_000;

function reply(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 256_000) throw new Error('Request body too large');
  }
  return text;
}

export function createDemo({ token, apiKey, model = 'gpt-realtime', request = fetch,
  answerTimeout = 120_000, toolsRoot = fileURLToPath(new URL('./test-docs/', import.meta.url)),
  connectTools }) {
  const calls = new Map();
  const timers = new Map();
  const sidebands = new Map();
  const executeFileTool = toolsRoot ? createFileTools(toolsRoot) : null;
  let current = null;
  const assets = new Map([
    ['/', ['index.html', 'text/html']],
    ['/browser.mjs', ['browser.mjs', 'text/javascript']],
    ['/history.mjs', ['history.mjs', 'text/javascript']],
    ['/scenarios.mjs', ['scenarios.mjs', 'text/javascript']],
  ]);

  function finishCall(call, result) {
    if (!terminalStates.has(call.status)) {
      for (const timer of timers.get(call.id) || []) clearTimeout(timer);
      timers.delete(call.id);
      Object.assign(call, result, { ended_at: new Date().toISOString() });
      sidebands.get(call.id)?.close();
      sidebands.delete(call.id);
    }
    return call;
  }
  function expire(call, error) {
    finishCall(call, { status: 'failed', incomplete: true, error });
  }

  const server = createServer(async (req, res) => {
    try {
      const host = `127.0.0.1:${res.socket.localPort}`;
      if (req.headers.host !== host ||
          (req.headers.origin && req.headers.origin !== `http://${host}`)) {
        return reply(res, 403, { error: 'Use the printed loopback URL' });
      }
      if (req.method === 'GET' && assets.has(req.url)) {
        const [name, type] = assets.get(req.url);
        return reply(res, 200, await readFile(new URL(name, import.meta.url)), type);
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        return reply(res, 401, { error: 'Invalid DEMO_TOKEN' });
      }
      if (req.method === 'POST' && req.url === '/calls') {
        const { context, timeout_ms = 900_000 } = JSON.parse(await body(req));
        if (!validContext(context)) {
          return reply(res, 400, { error: 'context must contain 1–10000 characters' });
        }
        if (!Number.isInteger(timeout_ms) || timeout_ms < 1000 || timeout_ms > 3_600_000) {
          return reply(res, 400, { error: 'timeout_ms must be an integer between 1000 and 3600000' });
        }
        if (current && !terminalStates.has(current.status)) {
          return reply(res, 409, { error: 'A call is already pending or active' });
        }
        current = { id: randomUUID(), context, status: 'ringing',
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + timeout_ms).toISOString(), history: [], incomplete: false };
        calls.set(current.id, current);
        const call = current;
        timers.set(call.id, [
          setTimeout(() => expire(call, 'Call was not answered in time'), Math.min(answerTimeout, timeout_ms)).unref(),
          setTimeout(() => expire(call, 'Call time limit reached'), timeout_ms).unref(),
        ]);
        if (calls.size > 50) calls.delete(calls.keys().next().value);
        return reply(res, 201, current);
      }
      if (req.method === 'GET' && req.url === '/current') return reply(res, 200, current);
      const match = /^\/calls\/([\w-]+)(?:\/(connect|finish|stop-tools))?$/.exec(req.url);
      const call = match && calls.get(match[1]);
      if (!call) return reply(res, 404, { error: 'Call not found' });
      if (req.method === 'GET' && !match[2]) return reply(res, 200, call);
      if (req.method === 'PATCH' && !match[2]) {
        if (call.status !== 'ringing') return reply(res, 409, { error: 'Context is fixed once a call starts' });
        const { context } = JSON.parse(await body(req));
        if (!validContext(context)) return reply(res, 400, { error: 'context must contain 1–10000 characters' });
        call.context = context;
        return reply(res, 200, call);
      }

      if (req.method === 'POST' && match[2] === 'connect') {
        if (call.status !== 'ringing') return reply(res, 409, { error: 'Call already answered' });
        if (!apiKey) return reply(res, 503, { error: 'Set OPENAI_API_KEY on the server' });
        const sdp = await body(req);
        if (!sdp.startsWith('v=0')) return reply(res, 400, { error: 'Invalid SDP offer' });
        if (call.status !== 'ringing') return reply(res, 409, { error: 'Call already answered' });
        call.status = 'connecting';
        clearTimeout(timers.get(call.id)?.[0]);
        try {
          const { answer, callId } = await negotiateVoice({ sdp, context: call.context,
            apiKey, model, withTools: Boolean(executeFileTool), request });
          if (call.status !== 'connecting') throw new Error('Call ended during connection');
          if (executeFileTool) {
            const sideband = attachFileTools({ callId, apiKey, execute: executeFileTool,
              connect: connectTools, onFailure: (message) => expire(call, message) });
            sidebands.set(call.id, sideband);
            await sideband.ready;
            if (call.status !== 'connecting') throw new Error('Call ended during connection');
          }
          call.status = 'active';
          return reply(res, 200, answer, 'application/sdp');
        } catch (error) {
          expire(call, error.message);
          return reply(res, 502, { error: error.message });
        }
      }
      if (req.method === 'POST' && match[2] === 'stop-tools') {
        if (call.status === 'connecting') return reply(res, 409, { error: 'Call is still connecting' });
        sidebands.get(call.id)?.close();
        sidebands.delete(call.id);
        return reply(res, 200, { stopped: true });
      }
      if (req.method === 'POST' && match[2] === 'finish') {
        const result = JSON.parse(await body(req));
        if (!terminalStates.has(result.status) || !Array.isArray(result.history) ||
            typeof result.incomplete !== 'boolean' || result.history.length > 1000 ||
            result.history.some((item) => !item || !['user', 'assistant'].includes(item.role) ||
              typeof item.text !== 'string' || typeof item.id !== 'string')) {
          return reply(res, 400, { error: 'Invalid call result' });
        }
        return reply(res, 200, finishCall(call, { status: result.status, history: result.history,
          incomplete: result.incomplete, error: String(result.error || '') }));
      }
      reply(res, 405, { error: 'Method not allowed' });
    } catch (error) {
      reply(res, 400, { error: error.message });
    }
  });
  server.on('close', () => {
    for (const handles of timers.values()) for (const timer of handles) clearTimeout(timer);
    timers.clear();
    for (const sideband of sidebands.values()) sideband.close();
    sidebands.clear();
  });
  return server;
}

async function callRequest({ origin, token }, path, options = {}) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const response = await fetch(`${origin}${path}`, { ...options, headers, signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

export function getCall(options, id) {
  return callRequest(options, `/calls/${encodeURIComponent(id)}`);
}

export async function trigger({ origin, token, context, timeout = 900_000, signal,
  onProgress = async () => {} }) {
  signal?.throwIfAborted();
  const api = (path, options) => callRequest({ origin, token }, path, options);
  const call = await api('/calls', { method: 'POST', body: JSON.stringify({ context, timeout_ms: timeout }) });
  const deadline = Date.now() + timeout;
  let lastStatus, nextProgress = 0;
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const result = await api(`/calls/${call.id}`, { signal });
      if (terminalStates.has(result.status)) return result;
      if (result.status !== lastStatus || Date.now() >= nextProgress) {
        await onProgress(result);
        lastStatus = result.status;
        nextProgress = Date.now() + 10_000;
      }
      await sleep(Math.min(1000, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
    return await api(`/calls/${call.id}/finish`, { method: 'POST', body: JSON.stringify({
      status: 'failed', history: [], incomplete: true, error: 'Timed out waiting for the call',
    }) });
  } catch (error) {
    try {
      await api(`/calls/${call.id}/finish`, { method: 'POST', body: JSON.stringify({
        status: 'failed', history: [], incomplete: true,
        error: signal?.aborted ? 'Calling agent cancelled the call' : error.message,
      }) });
    } catch (cleanupError) {
      console.error(`Could not finish call ${call.id}: ${cleanupError.message}`);
    }
    throw new Error(`${error.message}. Call ID: ${call.id}; retrieve it with get-call.`, { cause: error });
  }
}

async function main() {
  const port = Number(process.env.PORT || 8787);
  const origin = `http://127.0.0.1:${port}`;
  if (process.argv[2] === 'call') {
    if (!process.env.DEMO_TOKEN) throw new Error('Set DEMO_TOKEN to the server token');
    const result = await trigger({ origin, token: process.env.DEMO_TOKEN,
      context: process.argv.slice(3).join(' ') || 'Your test event fired. Ask me what to do next.',
      onProgress: (call) => console.error(`Call ${call.id}: ${call.status}. Answer in the browser.`) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY before starting');
  const token = process.env.DEMO_TOKEN || randomBytes(24).toString('hex');
  const server = createDemo({ token, apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime' });
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Open ${origin}/#${token}\nEnable ringing, then answer incoming calls and hang up to return the transcript.`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
