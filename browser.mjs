import { History } from './history.mjs';

const ui = Object.fromEntries(['answer', 'hangup', 'ring', 'status', 'audio', 'history', 'context']
  .map((id) => [id, document.getElementById(id)]));
const token = location.hash.slice(1) || sessionStorage.getItem('demo-token');
if (token) sessionStorage.setItem('demo-token', token);
history.replaceState(null, '', '/');
let active = null;
let incoming = null;
let transcript = new History();
let peer, channel, microphone, limitTimer;
let ringTimer, ringAudio;
const ringTones = new Set();
let finishing = false;
let resultToReturn = null;
let responseActive = false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function status(text) { ui.status.textContent = text; }
function playRing() {
  if (!ringAudio || ringAudio.state !== 'running') return;
  const tone = ringAudio.createOscillator();
  const gain = ringAudio.createGain();
  tone.frequency.value = 600;
  gain.gain.setValueAtTime(0, ringAudio.currentTime);
  gain.gain.linearRampToValueAtTime(.06, ringAudio.currentTime + .02);
  gain.gain.setValueAtTime(.06, ringAudio.currentTime + .7);
  gain.gain.linearRampToValueAtTime(0, ringAudio.currentTime + .8);
  tone.connect(gain).connect(ringAudio.destination);
  ringTones.add(tone);
  tone.onended = () => { ringTones.delete(tone); tone.disconnect(); gain.disconnect(); };
  tone.start();
  tone.stop(ringAudio.currentTime + .8);
}
function stopRing() {
  clearInterval(ringTimer);
  for (const tone of ringTones) tone.stop();
  ringTones.clear();
  document.body.classList.remove('ringing');
  document.title = 'Agent voice call';
}
function startRing(call) {
  incoming = call;
  ui.context.value = call.context;
  transcript = new History();
  render();
  ui.answer.disabled = ui.hangup.disabled = false;
  document.body.classList.add('ringing');
  document.title = 'Incoming call — Agent voice call';
  status('Incoming call from your agent. Answer to talk, or hang up to decline.');
  playRing();
  ringTimer = setInterval(playRing, 2500);
}
ui.ring.onclick = async () => {
  try {
    ringAudio ||= new AudioContext();
    await ringAudio.resume();
    ui.ring.textContent = 'Ringing sound enabled';
    ui.ring.disabled = true;
    if (incoming) playRing();
  } catch (error) {
    ui.ring.textContent = `Enable ringing sound (retry: ${error.message})`;
  }
};
function render() {
  ui.history.textContent = transcript.snapshot()
    .map((item) => `${item.role === 'user' ? 'You' : 'OpenAI'}: ${item.text || 'Transcribing…'}`)
    .join('\n\n') || 'Your transcript will appear here.';
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
    signal: options.signal || AbortSignal.timeout(40_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(text);
  return options.sdp ? text : JSON.parse(text);
}
function cleanup() {
  clearTimeout(limitTimer);
  microphone?.getTracks().forEach((track) => track.stop());
  channel?.close();
  peer?.close();
  peer = channel = microphone = null;
  ui.audio.srcObject = null;
  ui.answer.disabled = ui.hangup.disabled = true;
}

async function returnResult() {
  try {
    const result = await api(`/calls/${active.id}/finish`, { method: 'POST', body: JSON.stringify(resultToReturn) });
    status(result.error ? `Call ${result.status}: ${result.error}`
      : result.status === 'declined' ? 'Call declined. Waiting for the next call.' : 'Call ended. Transcript sent to the agent.');
    active = null;
    resultToReturn = null;
    finishing = false;
  } catch (error) {
    status(`Transcript delivery failed: ${error.message}. Press Hang up to retry.`);
    ui.hangup.disabled = false;
  }
}

async function finish(callStatus = 'ended', error = '') {
  if (!active || finishing) return;
  finishing = true;
  stopRing();
  ui.answer.disabled = ui.hangup.disabled = true;
  const hadChannel = channel?.readyState === 'open';
  const wasResponding = responseActive;
  if (hadChannel) {
    status('Finishing pending transcription…');
    microphone.getTracks().forEach((track) => { track.enabled = false; });
    if (responseActive) channel.send(JSON.stringify({ type: 'response.cancel' }));
    try {
      await api(`/calls/${active.id}/stop-tools`, { method: 'POST', body: '{}',
        signal: AbortSignal.timeout(2000) });
    } catch {
      transcript.failed = true;
      error ||= 'Could not stop file tools before hang-up';
    }
    // Muted media supplies silence so VAD can commit the final spoken turn.
    await sleep(1000);
    const deadline = Date.now() + 5000;
    while ((transcript.pending.size || transcript.speaking) && Date.now() < deadline) await sleep(100);
  }
  resultToReturn = { status: callStatus, error, history: transcript.snapshot(),
    incomplete: callStatus === 'failed' || wasResponding || transcript.failed ||
      transcript.pending.size > 0 || transcript.speaking };
  cleanup();
  render();
  await returnResult();
}

ui.answer.onclick = async () => {
  if (!incoming || active) return;
  const call = incoming;
  active = call;
  incoming = null;
  stopRing();
  ui.answer.disabled = true;
  ui.hangup.disabled = false;
  transcript = new History();
  responseActive = false;
  render();
  status('Requesting microphone access and connecting…');
  const isCurrent = () => active?.id === call.id && !finishing;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!isCurrent()) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    microphone = stream;
    const connection = peer = new RTCPeerConnection();
    microphone.getTracks().forEach((track) => connection.addTrack(track, microphone));
    connection.ontrack = ({ streams }) => {
      if (!isCurrent()) return;
      ui.audio.srcObject = streams[0];
      ui.audio.play().catch(() => status('Press play in the audio controls to hear the assistant.'));
    };
    connection.onconnectionstatechange = () => {
      if (isCurrent() && connection.connectionState === 'failed') finish('failed', 'WebRTC connection failed');
    };
    const events = channel = connection.createDataChannel('oai-events');
    events.onmessage = ({ data }) => {
      if (active?.id !== call.id) return;
      const event = JSON.parse(data);
      transcript.receive(event);
      if (event.type === 'response.created') responseActive = true;
      if (event.type === 'response.done') responseActive = false;
      render();
      const toolResponseCollision = event.error?.code === 'conversation_already_has_active_response' &&
        event.error.event_id?.startsWith('tools_');
      if (event.type === 'error' && !toolResponseCollision) finish('failed', event.error?.message || 'Realtime error');
    };
    events.onopen = () => {
      if (!isCurrent()) return;
      status('Connected. Talk to your agent’s voice assistant.');
      ui.hangup.disabled = false;
      events.send(JSON.stringify({ type: 'response.create' }));
      clearTimeout(limitTimer);
      limitTimer = setTimeout(() => finish('ended', 'Ten-minute demo limit reached'), 600_000);
    };
    events.onclose = () => { if (isCurrent()) finish('failed', 'Realtime data channel closed'); };
    await connection.setLocalDescription(await connection.createOffer());
    const deadline = Date.now() + 10_000;
    while (isCurrent() && connection.iceGatheringState !== 'complete' && Date.now() < deadline) await sleep(100);
    if (!isCurrent()) return;
    if (connection.iceGatheringState !== 'complete') throw new Error('ICE gathering timed out');
    const answer = await api(`/calls/${call.id}/connect`, { method: 'POST',
      headers: { 'Content-Type': 'application/sdp' }, body: connection.localDescription.sdp, sdp: true });
    if (!isCurrent()) return;
    await connection.setRemoteDescription({ type: 'answer', sdp: answer });
    if (isCurrent() && events.readyState !== 'open') {
      limitTimer = setTimeout(() => finish('failed', 'Voice connection timed out'), 20_000);
    }
  } catch (error) {
    if (isCurrent()) await finish('failed', error.message);
  }
};
ui.hangup.onclick = () => {
  if (resultToReturn) return returnResult();
  if (incoming && !active) {
    active = incoming;
    incoming = null;
    return finish('declined');
  }
  return finish();
};

async function poll() {
  if (!token) return status('Open the full URL printed by the server, including its #token.');
  try {
    const call = await api('/current');
    if (!finishing) {
      if (active) {
        if (!call || call.id !== active.id || ['ended', 'declined', 'failed'].includes(call.status)) {
          await finish('failed', call?.error || 'Call ended on the server');
        }
      } else if (call?.status === 'ringing') {
        if (incoming?.id !== call.id) {
          stopRing();
          startRing(call);
        }
      } else if (incoming) {
        incoming = null;
        stopRing();
        ui.answer.disabled = ui.hangup.disabled = true;
        status(call?.error || 'Call is no longer available. Waiting for the next call.');
      } else if (ui.status.textContent === 'Connecting to the call server…' ||
          ui.status.textContent.startsWith('Cannot reach the call server:')) {
        status('Waiting for an incoming call from your agent.');
      }
    }
  } catch (error) {
    status(`Cannot reach the call server: ${error.message}. Retrying…`);
  } finally {
    setTimeout(poll, 1000);
  }
}
poll();
window.addEventListener('beforeunload', (event) => {
  if (active) { event.preventDefault(); event.returnValue = ''; }
});
