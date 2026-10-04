import { History } from './history.mjs';
import { createCallEnding } from './end-call.mjs';

const ui = Object.fromEntries(['answer', 'reject', 'hangup', 'audio', 'status', 'heading', 'badge', 'context', 'history', 'context-panel', 'voice']
  .map((id) => [id, document.getElementById(id)]));
const api = window.voiceCall;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let call = null, transcript = new History(), peer, channel, microphone, responseActive = false;
let finishing = false, ringTimer, ringAudio, pendingResult, callEnding;
let defaultVoice, nextVoice;
const tones = new Set();

function setStatus(text) { ui.status.textContent = text; }
function render() {
  const messages = transcript.snapshot();
  if (!messages.length) {
    ui.history.innerHTML = '<p class="empty">Your words and the assistant’s replies will appear here.</p>';
    return;
  }
  ui.history.replaceChildren(...messages.map((item) => {
    const message = document.createElement('article');
    message.className = `message ${item.role}`;
    const speaker = document.createElement('span');
    speaker.className = 'speaker';
    speaker.textContent = item.role === 'user' ? 'YOU' : 'ASSISTANT';
    const text = document.createElement('p');
    text.textContent = item.text || 'Transcribing…';
    message.append(speaker, text);
    return message;
  }));
  ui.history.scrollTop = ui.history.scrollHeight;
}
function playRing() {
  if (ringAudio?.state !== 'running') return;
  const tone = ringAudio.createOscillator(), gain = ringAudio.createGain();
  tone.frequency.value = 620;
  gain.gain.setValueAtTime(0, ringAudio.currentTime);
  gain.gain.linearRampToValueAtTime(.06, ringAudio.currentTime + .02);
  gain.gain.setValueAtTime(.06, ringAudio.currentTime + .65);
  gain.gain.linearRampToValueAtTime(0, ringAudio.currentTime + .8);
  tone.connect(gain).connect(ringAudio.destination);
  tones.add(tone);
  tone.onended = () => { tones.delete(tone); tone.disconnect(); gain.disconnect(); };
  tone.start(); tone.stop(ringAudio.currentTime + .8);
}
function stopRing() {
  clearInterval(ringTimer);
  for (const tone of tones) tone.stop();
  tones.clear();
  document.body.classList.remove('ringing');
}
async function startRing(id) {
  try {
    ringAudio ||= new AudioContext();
    await ringAudio.resume();
    if (call?.id !== id || call.status !== 'ringing') return;
    playRing();
    ringTimer = setInterval(playRing, 2500);
  } catch { setStatus('Incoming call. Audio ringing is unavailable; use Answer or Reject.'); }
}
function cleanup() {
  callEnding?.stop();
  microphone?.getTracks().forEach((track) => track.stop());
  channel?.close(); peer?.close();
  microphone = peer = channel = null;
  ui.audio.srcObject = null;
  ui.answer.disabled = ui.reject.disabled = true;
  ui.voice.disabled = true;
  ui.hangup.hidden = true;
}
async function deliverResult() {
  const id = call.id, result = pendingResult;
  try {
    await api.finish(id, result);
    if (call?.id === id && pendingResult === result) pendingResult = null;
  } catch {
    if (call?.id !== id) return;
    setStatus('Could not return the transcript. Press Hang up to retry.');
    ui.hangup.hidden = false;
    ui.hangup.disabled = false;
  }
}
async function finish(status = 'ended', error = '', closeAfter = false) {
  if (!call || finishing) return;
  finishing = true;
  const id = call.id;
  const stillFinishing = () => call?.id === id && !['ended', 'declined', 'failed'].includes(call.status);
  stopRing();
  ui.answer.disabled = ui.reject.disabled = ui.hangup.disabled = true;
  ui.voice.disabled = true;
  const wasResponding = responseActive;
  try { await api.stopTools(id); } catch { if (stillFinishing()) transcript.failed = true; }
  if (!stillFinishing()) return;
  if (channel?.readyState === 'open') {
    setStatus('Finishing pending transcription…');
    microphone.getTracks().forEach((track) => { track.enabled = false; });
    if (responseActive) channel.send(JSON.stringify({ type: 'response.cancel' }));
    await sleep(1000);
    const deadline = Date.now() + 5000;
    while (stillFinishing() && (transcript.pending.size || transcript.speaking) && Date.now() < deadline) await sleep(100);
  }
  if (!stillFinishing()) return;
  pendingResult = { status, error, close_after: closeAfter, history: transcript.snapshot(),
    incomplete: status === 'failed' || wasResponding || transcript.failed || transcript.pending.size > 0 || transcript.speaking };
  cleanup(); render();
  await deliverResult();
}

api.onCall((incoming) => {
  if (call?.id !== incoming.id) {
    stopRing(); cleanup();
    call = incoming;
    finishing = responseActive = false;
    pendingResult = null;
    transcript = new History();
    ui.context.textContent = call.context;
    ui['context-panel'].open = false;
    render();
    ui.answer.hidden = ui.reject.hidden = false;
    ui.answer.disabled = ui.reject.disabled = false;
    ui.answer.disabled = ui.voice.options.length === 0;
    ui.voice.value = nextVoice ?? call.voice;
    nextVoice = undefined;
    ui.voice.disabled = false;
    ui.hangup.hidden = true;
    document.body.classList.add('ringing');
    ui.heading.textContent = 'Your agent is calling.';
    ui.badge.textContent = 'Incoming';
    setStatus('Answer to talk, or reject to return the call to your agent.');
    startRing(call.id);
    return;
  }
  call = incoming;
  if (['connecting', 'active'].includes(call.status)) ui.voice.disabled = true;
  if (['ended', 'declined', 'failed'].includes(call.status)) {
    finishing = true;
    stopRing(); cleanup();
    ui.voice.value = defaultVoice;
    ui.voice.disabled = false;
    if (call.history?.length) {
      transcript = new History();
      for (const item of call.history) transcript.items.set(item.id, item);
    }
    render();
    ui.heading.textContent = call.status === 'declined' ? 'Call rejected.' : call.status === 'failed' ? 'Call interrupted.' : 'Conversation complete.';
    ui.badge.textContent = call.status === 'failed' ? 'Failed' : 'Finished';
    setStatus(call.error || (call.status === 'declined' ? 'Your agent received the rejection.' : 'Transcript returned to your agent. You can review it here.'));
  }
});
ui.answer.onclick = async () => {
  if (!call || call.status !== 'ringing' || finishing) return;
  const id = call.id;
  const voice = ui.voice.value;
  stopRing();
  ui.answer.disabled = ui.reject.disabled = true;
  ui.voice.disabled = true;
  ui.answer.hidden = ui.reject.hidden = true;
  ui.hangup.hidden = false; ui.hangup.disabled = false;
  setStatus('Requesting microphone access…');
  ui.badge.textContent = 'Connecting';
  const isCurrent = () => call?.id === id && !finishing && !['ended', 'declined', 'failed'].includes(call.status);
  try {
    await api.begin(id, voice);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!isCurrent()) { stream.getTracks().forEach((track) => track.stop()); return; }
    microphone = stream;
    const connection = peer = new RTCPeerConnection();
    stream.getTracks().forEach((track) => connection.addTrack(track, stream));
    connection.ontrack = ({ streams }) => {
      if (!isCurrent()) return;
      ui.audio.srcObject = streams[0];
      ui.audio.play().catch(() => setStatus('Could not play assistant audio. Check your output device.'));
    };
    connection.onconnectionstatechange = () => {
      if (isCurrent() && connection.connectionState === 'failed') finish('failed', 'WebRTC connection failed');
    };
    const events = channel = connection.createDataChannel('oai-events');
    callEnding = createCallEnding({ send: (event) => events.send(JSON.stringify(event)), finish: () => finish('ended', '', true) });
    events.onmessage = ({ data }) => {
      if (call?.id !== id) return;
      let event;
      try { event = JSON.parse(data); }
      catch { finish('failed', 'Invalid Realtime event'); return; }
      transcript.receive(event);
      if (event.type === 'response.created') responseActive = true;
      if (event.type === 'response.done') responseActive = false;
      render();
      if (!finishing) callEnding.receive(event);
      const collision = event.error?.code === 'conversation_already_has_active_response' && event.error.event_id?.startsWith('tools_');
      if (event.type === 'error' && !collision) finish('failed', event.error?.message || 'Realtime error');
    };
    events.onopen = () => {
      if (!isCurrent()) return;
      ui.heading.textContent = 'You’re connected.';
      ui.badge.textContent = 'Live';
      setStatus('Talk naturally. You can interrupt the assistant at any time.');
      events.send(JSON.stringify({ type: 'response.create' }));
    };
    events.onclose = () => { if (isCurrent()) finish('failed', 'Realtime data channel closed'); };
    await connection.setLocalDescription(await connection.createOffer());
    const deadline = Date.now() + 10_000;
    while (isCurrent() && connection.iceGatheringState !== 'complete' && Date.now() < deadline) await sleep(100);
    if (!isCurrent()) return;
    if (connection.iceGatheringState !== 'complete') throw new Error('ICE gathering timed out');
    const answer = await api.connect(id, connection.localDescription.sdp);
    if (isCurrent()) await connection.setRemoteDescription({ type: 'answer', sdp: answer });
  } catch (error) { if (isCurrent()) await finish('failed', error.message); }
};
ui.reject.onclick = () => finish('declined');
ui.hangup.onclick = () => pendingResult ? deliverResult() : finish();
ui.voice.onchange = () => {
  if (!call || ['ended', 'declined', 'failed'].includes(call.status)) nextVoice = ui.voice.value;
};
api.onCloseRequest(() => pendingResult ? deliverResult() : finish(call?.status === 'ringing' ? 'declined' : 'ended'));
const settings = await api.ready();
defaultVoice = settings.voice;
ui.voice.replaceChildren(...settings.voices.map((voice) => {
  const option = document.createElement('option');
  option.value = option.textContent = voice;
  return option;
}));
ui.voice.value = call?.voice ?? settings.voice;
ui.voice.disabled = Boolean(call && ['connecting', 'active'].includes(call.status));
if (call?.status === 'ringing' && !finishing) ui.answer.disabled = false;
