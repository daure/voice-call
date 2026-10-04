import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DesktopCaller } from './desktop/caller.mjs';
import { createVoiceMcp } from './mcp.mjs';
import { MAX_CALL_REQUEST_BYTES } from './voice-session.mjs';

export async function startDevelopment({ port = 7357, caller = new DesktopCaller() } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('VOICE_CALL_DEV_PORT must be between 1 and 65535');
  const sessions = new Map(), connections = new Set();
  let stopping;
  const reply = (response, status, error) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error }));
  };
  const http = createServer(async (request, response) => {
    if (request.headers.host !== `127.0.0.1:${http.address()?.port}` || request.headers.origin !== undefined) {
      return reply(response, 403, 'Only origin-free loopback MCP clients are allowed');
    }
    if (request.url !== '/mcp') return reply(response, 404, 'MCP is available at /mcp');
    const id = request.headers['mcp-session-id'];
    let connection = id && sessions.get(id);
    try {
      if (id && !connection) return reply(response, 404, 'MCP session not found');
      if (!connection) {
        if (request.method !== 'POST') return reply(response, 400, 'Initialize an MCP session first');
        if (connections.size >= 32) return reply(response, 429, 'Too many development MCP sessions');
        const server = createVoiceMcp({ caller, closeCallerOnDisconnect: false });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          maxRequestBodySize: MAX_CALL_REQUEST_BYTES,
          onsessioninitialized: (sessionId) => sessions.set(sessionId, connection) });
        connection = { server, transport };
        connections.add(connection);
        await server.connect(transport);
        const onclose = transport.onclose;
        transport.onclose = () => {
          onclose?.();
          connections.delete(connection);
          sessions.delete(transport.sessionId);
        };
        response.once('finish', () => { if (!transport.sessionId) server.close().catch(() => {}); });
      }
      await connection.transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) reply(response, 500, 'Development MCP request failed');
      else response.end();
    }
  });
  async function close() {
    if (stopping) return stopping;
    stopping = Promise.resolve().then(async () => {
      caller.close();
      await Promise.allSettled([...connections].map(({ server }) => server.close()));
      if (http.listening) {
        const closed = new Promise((resolve) => http.close(resolve));
        http.closeAllConnections();
        await closed;
      }
    });
    return stopping;
  }
  try {
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, '127.0.0.1', resolve);
    });
    await caller.show();
    caller.once('closed', () => { close().catch(() => {}); });
    return { server: http, caller, origin: `http://127.0.0.1:${http.address().port}`, close };
  } catch (error) { await close(); throw error; }
}
