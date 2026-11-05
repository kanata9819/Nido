// メインプロセスの入口。Electronが起動すると最初にこのファイルが実行される。
// ウィンドウを作り、IPCの窓口（handlers.ts）を登録して、画面（レンダラー）を読み込む。
// 全体の流れは docs/architecture.ja.md を参照。
import { app, BrowserWindow, Menu, screen } from 'electron';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { autoUpdater } from 'electron-updater';
import { Updates } from './updater';
import { Session } from './session';
import { registerHandlers, type AppState } from './handlers';
import type { NidoEvent } from '../shared/types';
import { readLayout } from './persistence';

// 起動中のワークスペースの一覧。キーはワークスペースID、値はそのNeovimを管理するSession。
const sessions = new Map<string, Session>();
// 同梱のNeovimや言語パックが置いてある場所。配布版と開発中で場所が違う。
const neovimResources = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources');
let window: BrowserWindow;
// アプリ全体の状態（タブの並び順、表示中のワークスペースなど）。各IPCの窓口で共有する。
const state: AppState = {
  order: [],
  active: '',
  restoration: undefined,
  prompting: false,
  closing: false
};
// メインプロセスからレンダラーへイベントを送る。レンダラー側では nidoEvents.ts が受け取る。
const send = (event: NidoEvent): void => {
  if (window && !window.isDestroyed()) {
    window.webContents.send('nido:event', event);
  }
  if (event.type === 'exit') {
    sessions.delete(event.id);
  }
};

app.setName('Nido');
// Electronの準備ができたら、ウィンドウを作る。
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const saved = await readLayout(join(app.getPath('userData'), 'workspaces.json'))
    .then((layout) => layout.window)
    .catch(() => undefined); // Workspace restoration reports invalid saved data to the user.
  // 前回のウィンドウの大きさを、画面に収まる範囲で使う。保存がなければ 1440×940。
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
    // 安全のため、レンダラーからNode.jsを直接使えないようにする。
    // レンダラーが使えるのは preload（src/preload/index.ts）が用意した window.nido だけ。
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 新しいウィンドウを開く、別のページへ移動する、カメラなどの権限を求める、をすべて禁止する。
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
  // 自動アップデートは、インストーラーで入れたWindows版のときだけ有効にする。
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
  // レンダラーから呼ばれるIPCの窓口をすべて登録する。
  prepareToQuit = registerHandlers({ window, sessions, state, neovimResources, send, updates });
  window.webContents.once('did-finish-load', () => {
    if (installed) {
      const timer = setTimeout(() => void updates.check(false), 5000);
      window.once('closed', () => clearTimeout(timer));
    }
  });
  // 開発中はViteの開発サーバーから、配布版はビルド済みのファイルから画面を読み込む。
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
});
app.on('window-all-closed', () => app.quit());
// 終了するときは、ワークスペースのNeovimとターミナルをすべて止める。
app.on('will-quit', () => {
  for (const s of sessions.values()) {
    s.terminal?.process.kill();
    s.process.kill();
  }
});
