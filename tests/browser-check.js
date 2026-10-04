async (page) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.sentEvents = [];
    window.microphoneRequests = window.stoppedTracks = window.ringSounds = 0;
    const AudioContext = window.AudioContext;
    window.AudioContext = class extends AudioContext {
      createOscillator() { window.ringSounds++; return super.createOscillator(); }
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        window.microphoneRequests++;
        if (window.denyMicrophone) throw new Error('Microphone permission denied');
        const track = { enabled: true, stop() { window.stoppedTracks++; } };
        const stream = { getTracks: () => [track] };
        if (window.delayMicrophone) return new Promise((resolve) => {
          window.resolveMicrophone = () => resolve(stream);
        });
        return stream;
      },
    });
    window.RTCPeerConnection = class {
      iceGatheringState = 'complete';
      addTrack() {}
      createDataChannel() {
        return window.voiceChannel = this.channel = { readyState: 'connecting', send(data) { window.sentEvents.push(JSON.parse(data)); },
          close() { this.readyState = 'closed'; this.onclose?.(); } };
      }
      async createOffer() { return { type: 'offer', sdp: 'v=0\r\nmock' }; }
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
  });
  let rejectConnection = false;
  let rejectFinish = false;
  let stoppedTools = 0;
  await page.route('**/calls/*/stop-tools', (route) => {
    stoppedTools++;
    return route.continue();
  });
  await page.route('**/calls/*/connect', (route) => rejectConnection
    ? route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'OpenAI HTTP 429: credit_balance_exhausted' }) })
    : route.continue());
  await page.route('**/calls/*/finish', (route) => {
    if (rejectFinish) {
      rejectFinish = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Delivery unavailable"}' });
    }
    return route.continue();
  });
  await page.goto('http://127.0.0.1:18787/#offline-test');
  const buttons = await page.locator('button').allTextContents();
  if (buttons.join('|') !== 'Enable ringing sound|Answer|Hang up') throw new Error(`Unexpected controls: ${buttons}`);
  const headers = { Authorization: 'Bearer offline-test' };
  const current = async () => (await page.request.get('http://127.0.0.1:18787/current', { headers })).json();
  const prepare = async (context) => {
    const response = await page.request.post('http://127.0.0.1:18787/calls', { headers, data: { context } });
    if (response.status() !== 201) throw new Error(await response.text());
    const call = await response.json();
    await page.waitForFunction((context) => !document.getElementById('answer').disabled &&
      document.getElementById('context').value === context, context);
    return call;
  };
  const waitConnected = () => page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Connected'));
  const waitEnded = () => page.waitForFunction(() => document.getElementById('status').textContent.includes('Transcript sent to the agent'));
  await page.waitForFunction(() => !document.getElementById('answer').disabled);
  if (!await page.locator('body').evaluate((element) => element.classList.contains('ringing'))) throw new Error('Incoming call is not visibly ringing');
  if (!(await page.title()).startsWith('Incoming call')) throw new Error('Tab title does not show incoming call');
  if (await page.evaluate(() => window.microphoneRequests) !== 0) throw new Error('Microphone requested before answering');
  if (!await page.locator('#context').evaluate((element) => element.readOnly)) throw new Error('Caller context is editable');
  await page.locator('#ring').click();
  await page.waitForFunction(() => window.ringSounds > 0);
  const original = await current();
  await page.locator('#answer').click();
  await waitConnected();
  if ((await current()).status !== 'active') throw new Error('Answer did not connect the pending call');
  if (await page.locator('body').evaluate((element) => element.classList.contains('ringing'))) throw new Error('Ringing continues after answer');
  await page.locator('#hangup').click();
  await waitEnded();
  const result = await current();
  if (result.id !== original.id || result.context !== original.context || result.status !== 'ended' ||
      result.history.map((item) => item.text).join('|') !== 'Hello.|Hi there.' || result.incomplete) {
    throw new Error(JSON.stringify(result));
  }
  if (!(await page.locator('#history').textContent()).includes('You: Hello.')) throw new Error('Transcript is not displayed');

  await prepare('Decline this incoming call.');
  await page.locator('#hangup').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Call declined'));
  const declined = await current();
  if (declined.status !== 'declined' || declined.history.length) throw new Error('Decline result is invalid');
  if (await page.evaluate(() => window.microphoneRequests) !== 1) throw new Error('Declining requested microphone access');

  await prepare('Say goodbye and end this call.');
  await page.locator('#answer').click();
  await waitConnected();
  await page.evaluate(() => {
    const emit = (event) => window.voiceChannel.onmessage({ data: JSON.stringify(event) });
    emit({ type: 'response.created', response: { id: 'goodbye' } });
    emit({ type: 'output_audio_buffer.started', response_id: 'goodbye' });
    emit({ type: 'conversation.item.added', previous_item_id: 'a', item: { id: 'bye', type: 'message', role: 'assistant' } });
    emit({ type: 'response.output_audio_transcript.done', item_id: 'bye', transcript: 'Goodbye!' });
    emit({ type: 'response.function_call_arguments.done', response_id: 'goodbye', call_id: 'end', name: 'end_call', arguments: '{}' });
    emit({ type: 'response.done', response: { id: 'goodbye' } });
  });
  await page.waitForTimeout(1200);
  if ((await current()).status !== 'active') throw new Error('Assistant hung up before goodbye playback finished');
  await page.evaluate(() => window.voiceChannel.onmessage({ data: JSON.stringify({ type: 'output_audio_buffer.stopped', response_id: 'goodbye' }) }));
  await waitEnded();
  const farewell = await current();
  if (farewell.status !== 'ended' || farewell.incomplete || farewell.history.at(-1).text !== 'Goodbye!') throw new Error(JSON.stringify(farewell));

  await prepare('Retry transcript delivery.');
  await page.locator('#answer').click();
  await waitConnected();
  rejectFinish = true;
  await page.locator('#hangup').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Transcript delivery failed'));
  await page.locator('#hangup').click();
  await waitEnded();
  if ((await current()).history.length !== 2) throw new Error('Retry lost the transcript');

  const cancelled = await prepare('The agent will cancel this call.');
  await page.request.post(`http://127.0.0.1:18787/calls/${cancelled.id}/finish`, { headers,
    data: { status: 'failed', history: [], incomplete: true, error: 'Calling agent cancelled the call' } });
  await page.waitForFunction(() => document.getElementById('answer').disabled &&
    !document.body.classList.contains('ringing'));

  await prepare('Hang up while waiting for microphone permission.');
  await page.evaluate(() => { window.delayMicrophone = true; });
  await page.locator('#answer').click();
  await page.waitForFunction(() => typeof window.resolveMicrophone === 'function');
  await page.locator('#hangup').click();
  await waitEnded();
  const stoppedBefore = await page.evaluate(() => window.stoppedTracks);
  await page.evaluate(() => { window.delayMicrophone = false; window.resolveMicrophone(); });
  await page.waitForFunction((before) => window.stoppedTracks > before, stoppedBefore);

  await prepare('Test an upstream rejection.');
  rejectConnection = true;
  await page.locator('#answer').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('credit_balance_exhausted'));
  rejectConnection = false;
  await prepare('Test microphone permission denied.');
  await page.evaluate(() => { window.denyMicrophone = true; });
  await page.locator('#answer').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Microphone permission denied'));
  const starts = await page.evaluate(() => window.sentEvents.filter((event) => event.type === 'response.create').length);
  if (starts !== 3) throw new Error(`Expected three connected calls, got ${starts}`);
  if (stoppedTools !== starts) throw new Error('Hang-up did not stop tools for each connected call');
  if (errors.length) throw new Error(errors.join('; '));
  return { incomingCall: 'passed', ringing: 'passed', answerAndHangup: 'passed', contextPreserved: true,
    decline: 'passed', deliveryRetry: 'passed', cancellation: 'passed', permissionRace: 'passed',
    quotaError: 'displayed', microphoneError: 'displayed', toolsStoppedOnHangup: true,
    toolResponseCollision: 'handled', assistantHangup: 'waits for goodbye playback', pageErrors: errors };
}
