// preload：レンダラー（画面）とメインプロセスをつなぐ窓口。
// レンダラーはNode.jsやElectronを直接使えないので、ここで用意した関数（window.nido.◯◯）だけを使う。
// 各関数は 'nido:◯◯' というIPCをメインプロセスに送り、src/main/handlers.ts などの handle('◯◯') が受け取る。
// 引数や戻り値の型は src/shared/types.ts の NidoAPI に書いてある。
import { contextBridge, ipcRenderer } from 'electron';
import type { NidoAPI, NidoEvent } from '../shared/types';

const api: NidoAPI = {
  languagePacks: (id) => ipcRenderer.invoke('nido:languagePacks', id),
  setLanguagePackEnabled: (id, enabled) =>
    ipcRenderer.invoke('nido:setLanguagePackEnabled', id, enabled),
  installLanguagePack: () => ipcRenderer.invoke('nido:installLanguagePack'),
  reloadLanguagePacks: () => ipcRenderer.invoke('nido:reloadLanguagePacks'),
  openLanguagePackFolder: () => ipcRenderer.invoke('nido:openLanguagePackFolder'),
  wslDistributions: () => ipcRenderer.invoke('nido:wslDistributions'),
  availableTerminalShells: () => ipcRenderer.invoke('nido:availableTerminalShells'),
  setHistoryEnabled: (enabled) => ipcRenderer.invoke('nido:historyEnabled', enabled),
  history: (id) => ipcRenderer.invoke('nido:history', id),
  historyPreview: (id, path, version) =>
    ipcRenderer.invoke('nido:historyPreview', id, path, version),
  historyRestore: (id, path, version, token) =>
    ipcRenderer.invoke('nido:historyRestore', id, path, version, token),
  highlightSources: (id, path, before, after) =>
    ipcRenderer.invoke('nido:highlightSources', id, path, before, after),
  gitHistory: (id, skip) => ipcRenderer.invoke('nido:gitHistory', id, skip),
  gitCommitFiles: (id, hash) => ipcRenderer.invoke('nido:gitCommitFiles', id, hash),
  gitCommitDiff: (id, hash, path) => ipcRenderer.invoke('nido:gitCommitDiff', id, hash, path),
  gitBranches: (id) => ipcRenderer.invoke('nido:gitBranches', id),
  gitSwitch: (id, name, create) => ipcRenderer.invoke('nido:gitSwitch', id, name, create),
  gitStatus: (id) => ipcRenderer.invoke('nido:gitStatus', id),
  gitDiff: (id, path, staged) => ipcRenderer.invoke('nido:gitDiff', id, path, staged),
  gitStage: (id, path, staged) => ipcRenderer.invoke('nido:gitStage', id, path, staged),
  gitStageAll: (id) => ipcRenderer.invoke('nido:gitStageAll', id),
  gitCommit: (id, message) => ipcRenderer.invoke('nido:gitCommit', id, message),
  restoreWorkspaces: (shell) => ipcRenderer.invoke('nido:restore', shell),
  workspaceLayout: (ids, active) => ipcRenderer.invoke('nido:layout', ids, active),
  favoriteWorkspaces: () => ipcRenderer.invoke('nido:favorites'),
  setWorkspaceFavorite: (path, kind, enabled) =>
    ipcRenderer.invoke('nido:favorite', path, kind, enabled),
  createWorkspace: (path, kind, shell) => ipcRenderer.invoke('nido:create', path, kind, shell),
  openTerminal: (id, shell) => ipcRenderer.invoke('nido:openTerminal', id, shell),
  restartTerminal: (id, shell) => ipcRenderer.invoke('nido:restartTerminal', id, shell),
  browseFolders: (path, distribution) =>
    ipcRenderer.invoke('nido:browseFolders', path, distribution),
  closeWorkspace: (id) => ipcRenderer.invoke('nido:close', id),
  attach: (id, columns, rows) => ipcRenderer.invoke('nido:attach', id, columns, rows),
  resize: (id, columns, rows) => ipcRenderer.invoke('nido:resize', id, columns, rows),
  input: (id, keys) => ipcRenderer.invoke('nido:input', id, keys),
  inputMode: (id) => ipcRenderer.invoke('nido:inputMode', id),
  selectCompletion: (id, index) => ipcRenderer.invoke('nido:selectCompletion', id, index),
  markdownPreview: (id, token) => ipcRenderer.invoke('nido:markdownPreview', id, token),
  setClipboardSharing: (id, enabled) => ipcRenderer.invoke('nido:clipboardSharing', id, enabled),
  setEditorConfig: (id, enabled) => ipcRenderer.invoke('nido:editorConfig', id, enabled),
  setWordWrap: (id, enabled) => ipcRenderer.invoke('nido:wordWrap', id, enabled),
  setMethodSeparators: (id, enabled) => ipcRenderer.invoke('nido:methodSeparators', id, enabled),
  setRelativeLineNumbers: (id, enabled) =>
    ipcRenderer.invoke('nido:relativeLineNumbers', id, enabled),
  openDocumentation: (url) => ipcRenderer.invoke('nido:openDocumentation', url),
  click: (id, row, column) => ipcRenderer.invoke('nido:click', id, row, column),
  scroll: (id, lines, follow, pixel, columns) =>
    ipcRenderer.invoke('nido:scroll', id, lines, follow, pixel, columns),
  prefetchScroll: (id, down) => ipcRenderer.invoke('nido:prefetchScroll', id, down),
  jumpSticky: (id, window, buffer, line) =>
    ipcRenderer.invoke('nido:jumpSticky', id, window, buffer, line),
  paste: (id, text) => ipcRenderer.invoke('nido:paste', id, text),
  pasteClipboard: (id) => ipcRenderer.invoke('nido:pasteClipboard', id),
  files: (id, path) => ipcRenderer.invoke('nido:files', id, path),
  watchDirectories: (id, paths) => ipcRenderer.invoke('nido:watchDirectories', id, paths),
  fileAction: (id, action, path, target) =>
    ipcRenderer.invoke('nido:fileAction', id, action, path, target),
  findFiles: (id, query) => ipcRenderer.invoke('nido:findFiles', id, query),
  searchText: (id, query, options) => ipcRenderer.invoke('nido:searchText', id, query, options),
  previewReplacement: (id, token, replacement, selected) =>
    ipcRenderer.invoke('nido:previewReplacement', id, token, replacement, selected),
  applyReplacement: (id, token) => ipcRenderer.invoke('nido:applyReplacement', id, token),
  cancelFindFiles: (id) => ipcRenderer.invoke('nido:cancelFindFiles', id),
  openFile: (id, path, line, column) => ipcRenderer.invoke('nido:openFile', id, path, line, column),
  findSymbols: (id) => ipcRenderer.invoke('nido:findSymbols', id),
  openSymbol: (id, index, version) => ipcRenderer.invoke('nido:openSymbol', id, index, version),
  openReference: (id, index, version) =>
    ipcRenderer.invoke('nido:openReference', id, index, version),
  openProblem: (id, index, version) => ipcRenderer.invoke('nido:openProblem', id, index, version),
  previewReference: (id, index, version) =>
    ipcRenderer.invoke('nido:previewReference', id, index, version),
  selectBuffer: (id, buffer) => ipcRenderer.invoke('nido:selectBuffer', id, buffer),
  closeBuffer: (id, buffer) => ipcRenderer.invoke('nido:closeBuffer', id, buffer),
  moveBuffer: (id, buffer, target) => ipcRenderer.invoke('nido:moveBuffer', id, buffer, target),
  reopenBuffer: (id) => ipcRenderer.invoke('nido:reopenBuffer', id),
  save: (id, format) => ipcRenderer.invoke('nido:save', id, format),
  debug: (id, action, target) => ipcRenderer.invoke('nido:debug', id, action, target),
  setLineEnding: (id, format) => ipcRenderer.invoke('nido:setLineEnding', id, format),
  setTheme: (theme) => ipcRenderer.invoke('nido:theme', theme),
  setLanguage: (language) => ipcRenderer.invoke('nido:language', language),
  updateState: () => ipcRenderer.invoke('nido:updateState'),
  updateAction: (action) => ipcRenderer.invoke('nido:updateAction', action),
  windowState: () => ipcRenderer.invoke('nido:windowState'),
  windowAction: (action) => ipcRenderer.invoke('nido:window', action),
  // メインプロセスからのイベント（画面の再描画、通知など）を受け取る。
  // 戻り値の関数を呼ぶと受け取りをやめる。レンダラーでは nidoEvents.ts がこれを使う。
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: NidoEvent): void => callback(event);
    ipcRenderer.on('nido:event', listener);
    return () => ipcRenderer.removeListener('nido:event', listener);
  }
};
// レンダラーから window.nido として使えるようにする。
contextBridge.exposeInMainWorld('nido', api);
