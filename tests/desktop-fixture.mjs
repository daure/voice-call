import { app } from 'electron';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createDesktop } from '../desktop/main.mjs';

async function run() {
  const userData = await mkdtemp('/tmp/opencode/voice-call-test-');
  app.setPath('userData', userData);
  const { window, control } = await createDesktop({ apiKey: 'offline-key', toolsRoot: null,
    request: async (_url, options) => {
      const instructions = JSON.parse(options.body.get('session')).instructions;
      if (instructions.includes('quota-test')) return new Response('credit_balance_exhausted', { status: 429 });
      return new Response('v=0\r\nmock-answer');
    } });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !['voice-app:', 'file:', 'devtools:'].includes(new URL(details.url).protocol) });
  });
  await window.webContents.executeJavaScript(await readFile(new URL('./desktop-mocks.js', import.meta.url), 'utf8'));
  process.on('message', async (message) => {
    if (message?.type !== 'test') return;
    try {
      let value;
      if (message.action === 'eval') value = await window.webContents.executeJavaScript(message.code);
      if (message.action === 'inspect') value = { visible: window.isVisible(), preferences: {
        sandbox: window.webContents.getLastWebPreferences().sandbox,
        nodeIntegration: window.webContents.getLastWebPreferences().nodeIntegration,
        contextIsolation: window.webContents.getLastWebPreferences().contextIsolation,
      }, state: control.call?.status, toolsStopped: control.sideband === null };
      if (message.action === 'screenshot') {
        await writeFile(message.path, (await window.webContents.capturePage()).toPNG());
        value = message.path;
      }
      if (message.action === 'close') { window.close(); return; }
      process.send({ type: 'test-result', id: message.id, value });
    } catch (error) { process.send({ type: 'test-result', id: message.id, error: error.message }); }
  });
  process.send({ type: 'test-ready' });
  app.on('quit', () => { rm(userData, { recursive: true, force: true }).catch(() => {}); });
}
run().catch((error) => { console.error(error); app.exit(1); });
