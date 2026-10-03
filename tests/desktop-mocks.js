window.sentEvents = [];
window.microphoneRequests = window.stoppedTracks = window.ringSounds = 0;
window.pageErrors = [];
window.addEventListener('error', (event) => window.pageErrors.push(event.message));
window.addEventListener('unhandledrejection', (event) => window.pageErrors.push(String(event.reason)));
const NativeAudioContext = window.AudioContext;
window.AudioContext = class extends NativeAudioContext {
  createOscillator() { window.ringSounds++; return super.createOscillator(); }
};
Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
  value: async () => {
    window.microphoneRequests++;
    if (window.denyMicrophone) throw new Error('Microphone permission denied');
    const track = { enabled: true, stop() { window.stoppedTracks++; } };
    const stream = { getTracks: () => [track] };
    if (window.delayMicrophone) return new Promise((resolve) => { window.resolveMicrophone = () => resolve(stream); });
    return stream;
  },
});
window.RTCPeerConnection = class {
  iceGatheringState = 'complete';
  addTrack() {}
  createDataChannel() {
    return this.channel = { readyState: 'connecting', send(data) { window.sentEvents.push(JSON.parse(data)); },
      close() { this.readyState = 'closed'; this.onclose?.(); } };
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\nmock-offer' }; }
  async setLocalDescription(offer) { this.localDescription = offer; }
  async setRemoteDescription() {
    const channel = this.channel;
    channel.readyState = 'open';
    channel.onopen();
    for (const event of [
      { type: 'response.created' },
      { type: 'input_audio_buffer.committed', item_id: 'u', previous_item_id: null },
      { type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: 'Hello.' },
      { type: 'conversation.item.added', previous_item_id: 'u', item: { id: 'a', type: 'message', role: 'assistant' } },
      { type: 'response.output_audio_transcript.done', item_id: 'a', transcript: 'Hi there.' },
      { type: 'response.done' },
      { type: 'error', error: { code: 'conversation_already_has_active_response', event_id: 'tools_test' } },
    ]) channel.onmessage({ data: JSON.stringify(event) });
  }
  close() {}
};
true;
