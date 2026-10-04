import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { endCallTool } from './end-call.mjs';
import { createFileActivity } from './file-activity.mjs';

export function attachFileTools({ callId, apiKey, execute, onFailure, fileActivity, onActivity,
  connect = (url, options) => new WebSocket(url, options) }) {
  const socket = connect(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 10_000, maxPayload: 2_000_000,
  });
  const controller = new AbortController();
  const activity = createFileActivity({ data: fileActivity, onChange: onActivity });
  const seen = new Set(), responses = new Set();
  let stopped = false, ending = false, speaking = false, pending = false, running = 0, continuation;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timeout = setTimeout(() => fail('File tool connection timed out'), 10_000);

  function close() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    clearTimeout(continuation);
    activity.stop();
    controller.abort();
    rejectReady(new Error('File tool connection closed'));
    socket.terminate();
  }
  function fail(message) {
    if (stopped) return;
    activity.incomplete();
    rejectReady(new Error(message));
    close();
    onFailure(message);
  }
  function send(event, onSent) {
    if (stopped || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(event), (error) => {
      onSent?.(error);
      if (error) fail('Could not send a file tool result');
    });
    return true;
  }
  function continueResponse() {
    clearTimeout(continuation);
    continuation = setTimeout(() => {
      if (!pending || stopped || ending || speaking || responses.size) return;
      pending = false;
      send({ type: 'response.create', event_id: `tools_${randomUUID()}` });
    }, 50);
  }
  async function run(event) {
    if (!event.call_id || seen.has(event.call_id)) return;
    if (seen.size >= 100) { activity.incomplete(); return fail('File tool call limit reached'); }
    seen.add(event.call_id);
    let args = null, argumentError;
    try {
      if (typeof event.arguments !== 'string' || event.arguments.length > 4000) throw new Error();
      args = JSON.parse(event.arguments);
    } catch { argumentError = 'Invalid file tool arguments'; }
    const entry = activity.begin(event, args);
    let output;
    if (argumentError) output = { error: argumentError };
    else if (running >= 3) output = { error: 'At most three file tools can run at once' };
    else {
      running++;
      try {
        output = await execute(event.name, args, controller.signal);
      } catch (error) {
        // Avoid leaking absolute host paths through filesystem error messages.
        output = { error: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'File or directory not found'
          : error.code ? 'File could not be accessed' : error.message };
      } finally { running--; }
    }
    activity.finish(entry, output);
    if (ending || stopped) return;
    activity.sending(entry);
    if (send({ type: 'conversation.item.create', item: {
      type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(output),
    } }, (error) => activity.delivered(entry, error))) {
      pending = true;
      continueResponse();
    }
  }

  socket.on('open', () => { clearTimeout(timeout); resolveReady(); });
  socket.on('error', () => fail('File tool connection failed'));
  socket.on('close', () => fail('File tool connection closed unexpectedly'));
  socket.on('message', (data) => {
    if (stopped) return;
    let event;
    try { event = JSON.parse(data.toString()); }
    catch { return fail('Invalid event from the file tool connection'); }
    if (event.type === 'response.created') { responses.add(event.response.id); pending = false; }
    if (event.type === 'response.done') { responses.delete(event.response.id); continueResponse(); }
    if (event.type === 'input_audio_buffer.speech_started') speaking = true;
    if (event.type === 'input_audio_buffer.speech_stopped') { speaking = false; continueResponse(); }
    if (event.type === 'response.function_call_arguments.done') {
      if (event.name === endCallTool.name) {
        ending = true;
        pending = false;
        clearTimeout(continuation);
        activity.stop();
        controller.abort();
      } else if (!ending) run(event).catch(() => fail('File tool execution failed'));
    }
    if (event.type === 'error') {
      if (event.error?.code === 'conversation_already_has_active_response' &&
          event.error.event_id?.startsWith('tools_')) pending = true;
      else fail(`Realtime file tool error: ${event.error?.code || 'unknown'}`);
    }
  });
  return { ready, close };
}
