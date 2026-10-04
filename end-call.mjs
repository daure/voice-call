export const endCallTool = {
  type: 'function', name: 'end_call',
  description: 'End the current call when the user says goodbye or asks you to hang up. Say a brief goodbye before calling this tool. The app waits for audio playback to finish and returns the transcript.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

export function createCallEnding({ send, finish }) {
  const responses = new Set(), playback = new Set();
  let requested = false, stopped = false;
  return {
    stop() { stopped = true; },
    receive(event) {
      if (stopped) return;
      if (event.type === 'response.created') responses.add(event.response?.id);
      if (event.type === 'response.done') responses.delete(event.response?.id);
      if (event.type === 'output_audio_buffer.started') playback.add(event.response_id);
      if (['output_audio_buffer.stopped', 'output_audio_buffer.cleared'].includes(event.type)) {
        playback.delete(event.response_id);
      }
      if (event.type === 'response.function_call_arguments.done' && event.name === endCallTool.name &&
          event.call_id && event.response_id && !requested) {
        requested = true;
        responses.add(event.response_id);
        send({ type: 'conversation.item.create', item: { type: 'function_call_output',
          call_id: event.call_id, output: JSON.stringify({ ending: true }) } });
      }
      // response.done ends generation; WebRTC audio can still be playing.
      if (requested && !responses.size && !playback.size) {
        stopped = true;
        finish();
      }
    },
  };
}
