import { app, BrowserWindow, Menu, screen } from 'electron';
import { join } from 'node:path';
import { Session } from './session';
import { registerHandlers, type AppState } from './handlers';
import type { NidoEvent } from '../shared/types';
import { readLayout } from './persistence';

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
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const saved = await readLayout(join(app.getPath('userData'), 'workspaces.json'))
    .then((layout) => layout.window)
    .catch(() => undefined); // Workspace restoration reports invalid saved data to the user.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const validSize =
    saved &&
    Number.isSafeInteger(saved.width) &&
    saved.width > 0 &&
    Number.isSafeInteger(saved.height) &&
    saved.height > 0;
  const minWidth = Math.min(850, area.width);
  const minHeight = Math.min(560, area.height);
  const width = Math.min(area.width, Math.max(minWidth, validSize ? saved.width : 1440));
  const height = Math.min(area.height, Math.max(minHeight, validSize ? saved.height : 940));
  window = new BrowserWindow({
    icon: join(neovimResources, 'icon.png'),
    title: 'Nido',
    width,
    height,
    minWidth,
    minHeight,
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
  window.once('ready-to-show', () => {
    window.show();
    // Compensate for Windows DPI rounding so saved sizes do not grow on each restart.
    let requestedWidth = width;
    let requestedHeight = height;
    for (let attempt = 0; attempt < 3; attempt++) {
      window.setSize(requestedWidth, requestedHeight);
      const [actualWidth, actualHeight] = window.getSize();
      if (actualWidth === width && actualHeight === height) {
        break;
      }
      requestedWidth -= actualWidth - width;
      requestedHeight -= actualHeight - height;
    }
    if (saved?.maximized === true) {
      window.maximize();
    }
  });
  registerHandlers({ window, sessions, state, neovimResources, send });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  for (const s of sessions.values()) {
    s.terminal?.process.kill();
    s.process.kill();
  }
});
