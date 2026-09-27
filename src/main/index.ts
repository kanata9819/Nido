import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'node:path';
import { Session } from './session';
import { registerHandlers, type AppState } from './handlers';
import type { NidoEvent } from '../shared/types';

const sessions = new Map<string, Session>();
const neovimResources = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources');
let window: BrowserWindow;
const state: AppState = { order: [], active: '', restoration: undefined, prompting: false, closing: false };
const send = (event: NidoEvent): void => {
  if (window && !window.isDestroyed()) {
    window.webContents.send('nido:event', event);
  }
  if (event.type === 'exit') {
    sessions.delete(event.id);
  }
};

app.setName('Nido');
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    icon: join(neovimResources, 'icon.png'),
    title: 'Nido',
    width: 1440,
    height: 940,
    minWidth: 850,
    minHeight: 560,
    backgroundColor: '#141414',
    frame: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window.show());
  registerHandlers({ window, sessions, state, neovimResources, send });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  for (const s of sessions.values()) s.process.kill();
});
