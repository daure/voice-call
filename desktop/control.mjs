import { basename } from 'node:path';
import { z } from 'zod';
import { createFileTools } from '../file-tools.mjs';
import { attachFileTools } from '../realtime-tools.mjs';
import { negotiateVoice, REALTIME_VOICES, DEFAULT_REALTIME_VOICE } from '../voice-session.mjs';
import { emptyFileActivity } from '../file-activity.mjs';

const historySchema = z.array(z.object({ id: z.string().max(200), role: z.enum(['user', 'assistant']),
  text: z.string().max(100_000), interrupted: z.boolean().optional(),
  transcription_pending: z.boolean().optional() })).max(1000);
const resultSchema = z.object({ status: z.enum(['ended', 'declined', 'failed']),
  history: historySchema, incomplete: z.boolean(), error: z.string().max(2000).default(''),
  close_after: z.boolean().default(false) });

export class VoiceControl {
  constructor({ onChange, onResult, request = fetch, connectTools,
    apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
    voice = process.env.OPENAI_REALTIME_VOICE?.trim() || DEFAULT_REALTIME_VOICE,
    toolsRoot = process.cwd() }) {
    Object.assign(this, { onChange, onResult, request, connectTools, apiKey, model, voice });
    this.execute = toolsRoot ? createFileTools(toolsRoot) : null;
    this.defaultToolsRoot = toolsRoot;
    this.toolsRoot = toolsRoot ? basename(toolsRoot) : null;
    this.call = null;
    this.sideband = null;
  }

  incoming(call, toolsRoot = this.defaultToolsRoot) {
    if (this.call && !['ended', 'declined', 'failed'].includes(this.call.status)) throw new Error('A call is already active');
    this.stop();
    const root = this.defaultToolsRoot === null ? null : toolsRoot;
    const execute = root ? createFileTools(root) : null;
    this.execute = execute;
    this.toolsRoot = root ? basename(root) : null;
    this.controller = new AbortController();
    this.call = { ...call, voice: this.voice, file_activity: emptyFileActivity(this.toolsRoot) };
    this.onChange(this.call);
  }

  current(id) {
    if (!this.call || this.call.id !== id) throw new Error('Call is no longer current');
    return this.call;
  }

  begin(id, voice = this.voice) {
    const call = this.current(id);
    if (call.status !== 'ringing') throw new Error('Call already answered');
    if (!REALTIME_VOICES.includes(voice)) throw new Error(`OPENAI_REALTIME_VOICE must be one of: ${REALTIME_VOICES.join(', ')}`);
    call.voice = voice;
    call.status = 'connecting';
    this.onChange(call);
  }

  async connect(id, sdp) {
    const call = this.current(id);
    const signal = this.controller.signal;
    if (call.status !== 'connecting' || this.connecting === signal) throw new Error('Call is not ready to connect');
    this.connecting = signal;
    try {
      const { answer, callId } = await negotiateVoice({ sdp, context: call.context,
        apiKey: this.apiKey, model: this.model, voice: call.voice,
        withTools: Boolean(this.execute), request: this.request, signal });
      signal.throwIfAborted();
      if (this.execute) {
        this.sideband = attachFileTools({ callId, apiKey: this.apiKey, execute: this.execute,
          fileActivity: call.file_activity, onActivity: () => this.onChange(call),
          connect: this.connectTools, onFailure: (error) => this.cancel(id, error) });
        await this.sideband.ready;
      }
      signal.throwIfAborted();
      call.status = 'active';
      this.onChange(call);
      return answer;
    } catch (error) {
      if (this.execute) call.file_activity.complete = false;
      throw error;
    } finally { if (this.connecting === signal) this.connecting = null; }
  }

  stop() {
    this.controller?.abort();
    this.sideband?.close();
    this.sideband = null;
  }

  finish(id, result) {
    const call = this.current(id);
    if (['ended', 'declined', 'failed'].includes(call.status)) return call;
    if (JSON.stringify(result).length > 256_000) throw new Error('Call result exceeds the size limit');
    const { close_after, ...parsed } = resultSchema.parse(result);
    if (parsed.status === 'declined' && call.status !== 'ringing') throw new Error('Only a ringing call can be rejected');
    this.stop();
    Object.assign(call, parsed, { ended_at: new Date().toISOString() });
    this.onChange(call);
    this.onResult(call, { closeAfter: close_after && parsed.status === 'ended' });
    return call;
  }

  cancel(id, error) {
    if (this.call?.id !== id) return;
    return this.finish(id, { status: 'failed', error, history: [], incomplete: true });
  }
}
