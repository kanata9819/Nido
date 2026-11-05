// Entry point of the Electron main process. It creates the window, registers the IPC
// handlers (handlers.ts) and loads the renderer.
import { app, BrowserWindow, Menu, screen } from 'electron';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { autoUpdater } from 'electron-updater';
import { Updates } from './updater';
import { Session } from './session';
import { registerHandlers, type AppState } from './handlers';
import type { NidoEvent } from '../shared/types';
import { readLayout } from './persistence';

// Running workspaces, keyed by workspace ID. Each Session owns one Neovim process.
const sessions = new Map<string, Session>();
// Bundled Neovim and language packs live in different places when packaged and in development.
const neovimResources = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources');
let window: BrowserWindow;
// Application state such as workspace order and the active workspace, shared by the handlers.
const state: AppState = {
  order: [],
  active: '',
  restoration: undefined,
  prompting: false,
  closing: false
};
// Send an event to the renderer, where nidoEvents.ts receives it.
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
  // Reuse the saved window size within the work area, or default to 1440×940.
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
    // The renderer cannot use Node.js directly; it only gets window.nido from src/preload/index.ts.
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // Block new windows, navigation and permission requests such as the camera.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  );
  const publishWindowState = (): void =>
    send({ type: 'windowState', state: { maximized: window.isMaximized() } });
  window.on('maximize', publishWindowState);
  window.on('unmaximize', publishWindowState);
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
  let prepareToQuit: () => Promise<boolean> = async () => false;
  const installed =
    process.platform === 'win32' &&
    app.isPackaged &&
    existsSync(join(dirname(process.execPath), 'Uninstall nido.exe'));
  // Automatic updates apply only to Windows builds installed by the installer.
  const updates = new Updates(autoUpdater, {
    currentVersion: app.getVersion(),
    enabled: installed,
    publish: (update) => send({ type: 'update', state: update }),
    notify: (message, severity) =>
      send({
        type: 'notification',
        id: state.active,
        title: 'Nido update',
        message,
        severity
      }),
    prepareToQuit: () => prepareToQuit(),
    recover: () => {
      if (window.isDestroyed()) {
        return;
      }
      state.closing = false;
      state.restoration = undefined;
      sessions.clear();
      window.reload();
    }
  });
  prepareToQuit = registerHandlers({ window, sessions, state, neovimResources, send, updates });
  window.webContents.once('did-finish-load', () => {
    if (installed) {
      const timer = setTimeout(() => void updates.check(false), 5000);
      window.once('closed', () => clearTimeout(timer));
    }
  });
  // Load the renderer from the Vite dev server in development, or from the built files.
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
});
app.on('window-all-closed', () => app.quit());
// Stop every workspace's Neovim and terminal on quit.
app.on('will-quit', () => {
  for (const s of sessions.values()) {
    s.terminal?.process.kill();
    s.process.kill();
  }
});
