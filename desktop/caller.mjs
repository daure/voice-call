import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

// Electron's package entrypoint can download its runtime and write to MCP stdout.
const electron = process.env.VOICE_CALL_ELECTRON_PATH ||
  join(dirname(createRequire(import.meta.url).resolve('electron/package.json')), 'dist', 'electron');

const terminal = new Set(['ended', 'declined', 'failed']);

export class DesktopCaller {
  constructor({ launch, entry = fileURLToPath(new URL('./main.mjs', import.meta.url)),
    answerTimeout = 120_000, startupTimeout = 20_000, requireDisplay = true } = {}) {
    this.launch = launch || (() => {
      if (!existsSync(electron)) throw new Error('Install the Electron runtime first: npm exec -- install-electron --no');
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      return spawn(electron, [entry, '--mcp'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    });
    this.answerTimeout = answerTimeout;
    this.startupTimeout = startupTimeout;
    this.requireDisplay = requireDisplay;
    this.calls = new Map();
    this.child = null;
    this.ready = null;
    this.waiting = null;
  }

  send(message) {
    if (!this.child?.connected) return;
    this.child.send(message, (error) => {
      if (error && this.waiting) this.finish({ status: 'failed', error: 'Desktop app connection failed', incomplete: true });
    });
  }

  async open() {
    if (this.ready) return this.ready;
    if (this.requireDisplay && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error('The MCP process needs a Linux desktop session (DISPLAY or WAYLAND_DISPLAY)');
    }
    const child = this.child = this.launch();
    // Electron diagnostics must never enter the MCP protocol's stdout stream.
    child.stdout?.resume();
    child.stderr?.resume();
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Desktop app did not start; check the Electron sandbox and desktop session'));
        child.kill();
      }, this.startupTimeout);
      child.on('message', (message) => {
        if (child !== this.child) return;
        if (message?.type === 'ready') { clearTimeout(timer); resolve(); }
        const waiting = this.waiting;
        if (!waiting || message?.call?.id !== waiting.call.id) return;
        if (message.type === 'progress' && ['ringing', 'connecting', 'active'].includes(message.call.status)) {
          waiting.call.status = message.call.status;
          if (message.call.status !== 'ringing') clearTimeout(waiting.answerTimer);
          waiting.progress();
        }
        if (message.type === 'result' && terminal.has(message.call.status)) this.finish(message.call);
      });
      const exited = () => {
        clearTimeout(timer);
        reject(new Error('Desktop app closed; check the Electron sandbox and desktop session'));
        if (child !== this.child) return;
        this.child = this.ready = null;
        if (this.waiting) this.finish({ status: 'failed', error: 'Desktop window closed before the call finished', incomplete: true });
      };
      child.once('error', exited);
      child.once('exit', exited);
      child.once('disconnect', () => { exited(); child.kill(); });
    });
    return this.ready;
  }

  finish(result) {
    const waiting = this.waiting;
    if (!waiting) return;
    clearTimeout(waiting.answerTimer);
    clearTimeout(waiting.deadlineTimer);
    clearInterval(waiting.progressTimer);
    waiting.signal?.removeEventListener('abort', waiting.abort);
    Object.assign(waiting.call, { status: result.status, history: result.history || [],
      incomplete: Boolean(result.incomplete), error: String(result.error || ''), ended_at: new Date().toISOString() });
    this.waiting = null;
    waiting.resolve(waiting.call);
  }

  async trigger({ context, timeout = 900_000, signal, onProgress = async () => {} }) {
    signal?.throwIfAborted();
    if (this.waiting) throw new Error('A call is already pending or active');
    const call = { id: randomUUID(), context, status: 'ringing', created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + timeout).toISOString(), history: [], incomplete: false };
    this.calls.set(call.id, call);
    if (this.calls.size > 50) this.calls.delete(this.calls.keys().next().value);
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const stop = (error) => {
      if (this.waiting?.call.id !== call.id) return;
      this.send({ type: 'cancel', id: call.id, error });
      this.finish({ status: 'failed', error, incomplete: true });
    };
    const progress = () => Promise.resolve(onProgress(call)).catch(() => {});
    const abort = () => stop('Calling agent cancelled the call');
    this.waiting = { call, resolve, progress, signal, abort,
      answerTimer: setTimeout(() => stop('Call was not answered in time'), Math.min(timeout, this.answerTimeout)),
      deadlineTimer: setTimeout(() => stop('Call time limit reached'), timeout),
      progressTimer: setInterval(progress, 10_000) };
    signal?.addEventListener('abort', abort, { once: true });
    progress();
    this.open().then(() => {
      if (this.waiting?.call.id === call.id) this.send({ type: 'call', call });
    }).catch((error) => {
      if (this.waiting?.call.id === call.id) this.finish({ status: 'failed', error: error.message, incomplete: true });
    });
    return result;
  }

  async get(id) {
    const call = this.calls.get(id);
    if (!call) throw new Error('Call not found');
    return call;
  }

  close() {
    if (this.waiting) this.finish({ status: 'failed', error: 'MCP connection closed', incomplete: true });
    this.send({ type: 'shutdown' });
    this.child?.kill();
  }
}
