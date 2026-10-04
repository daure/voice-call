import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallEnding } from '../end-call.mjs';
import { voiceSession } from '../voice-session.mjs';

function ending() {
  const sent = [];
  let finished = 0;
  const handler = createCallEnding({ send: (event) => sent.push(event), finish: () => finished++ });
  return { handler, sent, finished: () => finished,
    emit: (type, extra = {}) => handler.receive({ type, response_id: 'goodbye', response: { id: 'goodbye' }, ...extra }),
    request: () => handler.receive({ type: 'response.function_call_arguments.done', name: 'end_call',
      call_id: 'hangup', response_id: 'goodbye', arguments: '{}' }) };
}

test('voice sessions offer hang-up even when file tools are disabled', () => {
  const session = voiceSession('Discuss the deployment.', undefined, false);
  assert.deepEqual(session.tools.map((tool) => tool.name), ['end_call']);
  assert.match(session.instructions, /say a brief goodbye, then immediately call end_call/);
});

test('hang-up waits for goodbye playback after generation finishes and executes once', () => {
  const call = ending();
  call.emit('response.created');
  call.emit('output_audio_buffer.started');
  call.request();
  call.request();
  assert.equal(call.sent.length, 1);
  assert.deepEqual(call.sent[0].item, { type: 'function_call_output', call_id: 'hangup', output: '{"ending":true}' });
  call.emit('response.done');
  call.emit('response.output_audio.done');
  call.emit('output_audio_buffer.stopped', { response_id: 'earlier' });
  assert.equal(call.finished(), 0);
  call.emit('output_audio_buffer.stopped');
  call.emit('output_audio_buffer.stopped');
  call.request();
  assert.equal(call.finished(), 1);
});

test('hang-up completes after a tool-only response with already drained goodbye audio', () => {
  const call = ending();
  call.emit('output_audio_buffer.started', { response_id: 'earlier' });
  call.emit('output_audio_buffer.stopped', { response_id: 'earlier' });
  call.request();
  assert.equal(call.finished(), 0);
  call.emit('response.done');
  assert.equal(call.finished(), 1);
});

test('interrupted goodbye audio permits hang-up when the response finishes', () => {
  const call = ending();
  call.emit('response.created');
  call.emit('output_audio_buffer.started');
  call.request();
  call.emit('output_audio_buffer.cleared');
  assert.equal(call.finished(), 0);
  call.emit('response.done');
  assert.equal(call.finished(), 1);
});

test('manual cleanup disables a pending assistant hang-up', () => {
  const call = ending();
  call.request();
  call.handler.stop();
  call.emit('response.done');
  assert.equal(call.finished(), 0);
});

test('normal conversation and file tool calls keep the call open', () => {
  const call = ending();
  call.emit('response.created');
  call.emit('output_audio_buffer.started');
  call.emit('response.function_call_arguments.done', { name: 'glob', call_id: 'files', arguments: '{}' });
  call.emit('response.done');
  call.emit('output_audio_buffer.stopped');
  assert.equal(call.finished(), 0);
  assert.deepEqual(call.sent, []);
});
