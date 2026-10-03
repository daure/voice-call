import { app, BrowserWindow, ipcMain, protocol, net, Notification } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VoiceControl } from './control.mjs';

const origin = 'voice-app://local';
protocol.registerSchemesAsPrivileged([{ scheme: 'voice-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

export async function createDesktop(options = {}) {
  app.setName('Voice Call');
  await app.whenReady();
  const assets = new Map([
    ['/index.html', new URL('./index.html', import.meta.url)],
    ['/style.css', new URL('./style.css', import.meta.url)],
    ['/renderer.mjs', new URL('./renderer.mjs', import.meta.url)],
    ['/history.mjs', new URL('../history.mjs', import.meta.url)],
  ]);
  protocol.handle('voice-app', (request) => {
    const url = new URL(request.url);
    const asset = url.protocol === 'voice-app:' && url.host === 'local' && assets.get(url.pathname);
    return asset ? net.fetch(pathToFileURL(fileURLToPath(asset)).href) : new Response('Not found', { status: 404 });
  });
  const window = new BrowserWindow({ title: 'Voice Call', width: 680, height: 740, minWidth: 420,
    minHeight: 520, show: false, backgroundColor: '#141821', autoHideMenuBar: true,
    webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' } });
  let closing = false, closeTimer;
  const sendParent = (message, callback) => {
    if (process.connected) process.send(message, callback);
    else callback?.();
  };
  const control = new VoiceControl({ ...options,
    onChange: (call) => {
      window.webContents.send('voice:call', call);
      if (!['ended', 'declined', 'failed'].includes(call.status)) sendParent({ type: 'progress', call });
    },
    onResult: (call) => sendParent({ type: 'result', call }, () => { if (closing && !window.isDestroyed()) window.destroy(); }),
  });
  const allowedSender = (event) => event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === `${origin}/index.html`;
  const handle = (name, action) => ipcMain.handle(`voice:${name}`, (event, ...args) => {
    if (!allowedSender(event)) throw new Error('Untrusted desktop IPC sender');
    return action(...args);
  });
  handle('ready', () => { sendParent({ type: 'ready' }); if (!process.send) window.show(); });
  handle('begin', (id) => control.begin(id));
  handle('connect', (id, sdp) => control.connect(id, sdp));
  handle('stop-tools', (id) => { control.current(id); control.stop(); });
  handle('finish', (id, result) => control.finish(id, result));
  const ownMedia = (contents, permission, details) => contents === window.webContents &&
    contents.getURL() === `${origin}/index.html` && permission === 'media' &&
    control.call?.status === 'connecting' && !details?.mediaTypes?.includes('video') &&
    details?.mediaType !== 'video';
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => ownMedia(contents, permission, details));
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(ownMedia(contents, permission, details)));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== `${origin}/index.html`) event.preventDefault(); });
  window.webContents.on('render-process-gone', () => {
    if (control.call) control.cancel(control.call.id, 'Desktop renderer stopped unexpectedly');
    window.destroy();
  });
  window.on('close', (event) => {
    if (control.call && !['ended', 'declined', 'failed'].includes(control.call.status)) {
      event.preventDefault();
      closing = true;
      closeTimer ||= setTimeout(() => {
        control.cancel(control.call.id, 'Desktop window closed before transcription finished');
        window.destroy();
      }, 8000);
      window.webContents.send('voice:close-request');
    }
  });
  window.on('closed', () => { clearTimeout(closeTimer); control.stop(); app.quit(); });
  app.on('before-quit', () => control.stop());
  process.on('disconnect', () => { control.stop(); window.destroy(); });
  process.on('message', (message) => {
    if (message?.type === 'shutdown') return window.destroy();
    if (message?.type === 'cancel') return control.cancel(message.id, message.error);
    if (message?.type !== 'call') return;
    try {
      control.incoming(message.call);
      closing = false;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      if (Notification.isSupported()) {
        const notification = new Notification({ title: 'Incoming voice call',
          body: 'Your agent is calling. Open Voice Call to answer or reject.', silent: true });
        notification.on('click', () => { window.show(); window.focus(); });
        notification.show();
      }
      options.onIncomingCall?.(message.call, window);
    } catch {
      sendParent({ type: 'result', call: { ...message.call, status: 'failed', history: [],
        incomplete: true, error: 'Could not open the incoming call' } });
    }
  });
  await window.loadURL(`${origin}/index.html`);
  return { window, control };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createDesktop().catch(() => { console.error('Could not start Voice Call'); app.exit(1); });
}
