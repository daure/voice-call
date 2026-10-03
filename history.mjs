export class History {
  items = new Map();
  pending = new Set();
  failed = false;
  speaking = false;

  item(id, role = 'user') {
    if (!this.items.has(id)) this.items.set(id, { id, role, text: '', previous: null });
    return this.items.get(id);
  }

  receive(event) {
    if (['conversation.item.added', 'conversation.item.created'].includes(event.type)) {
      const source = event.item;
      if (source?.type === 'message') {
        const item = this.item(source.id, source.role);
        item.role = source.role;
        item.previous = event.previous_item_id ?? item.previous;
      }
    }
    if (event.type === 'input_audio_buffer.speech_started') this.speaking = true;
    if (event.type === 'input_audio_buffer.speech_stopped') this.speaking = false;
    if (event.type === 'input_audio_buffer.committed') {
      this.item(event.item_id).previous = event.previous_item_id ?? null;
      this.pending.add(event.item_id);
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      this.item(event.item_id).text = event.transcript;
      this.pending.delete(event.item_id);
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      this.pending.delete(event.item_id);
      this.failed = true;
    }
    if (event.type === 'response.output_item.added' && event.item?.type === 'message') {
      this.item(event.item.id, event.item.role);
    }
    if (['response.output_audio_transcript.delta', 'response.audio_transcript.delta'].includes(event.type)) {
      this.item(event.item_id, 'assistant').text += event.delta;
    }
    if (['response.output_audio_transcript.done', 'response.audio_transcript.done'].includes(event.type)) {
      this.item(event.item_id, 'assistant').text = event.transcript;
    }
    if (event.type === 'conversation.item.truncated') {
      this.item(event.item_id, 'assistant').interrupted = true;
    }
  }

  snapshot() {
    const ordered = [];
    const visited = new Set();
    const visit = (item) => {
      if (visited.has(item.id)) return;
      visited.add(item.id);
      if (this.items.has(item.previous)) visit(this.items.get(item.previous));
      ordered.push(item);
    };
    for (const item of this.items.values()) visit(item);
    return ordered.filter((item) => ['user', 'assistant'].includes(item.role))
      .map(({ previous, ...item }) => ({ ...item,
        transcription_pending: this.pending.has(item.id) }));
  }
}
