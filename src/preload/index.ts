import { contextBridge, ipcRenderer } from 'electron';
import type { NidoAPI, NidoEvent } from '../shared/types';

const api: NidoAPI = {
  highlightSources: (id, path, before, after) => ipcRenderer.invoke('nido:highlightSources', id, path, before, after),
  gitHistory: (id, skip) => ipcRenderer.invoke('nido:gitHistory', id, skip),
  gitCommitFiles: (id, hash) => ipcRenderer.invoke('nido:gitCommitFiles', id, hash),
  gitCommitDiff: (id, hash, path) => ipcRenderer.invoke('nido:gitCommitDiff', id, hash, path),
  gitBranches: (id) => ipcRenderer.invoke('nido:gitBranches', id),
  gitSwitch: (id, name, create) => ipcRenderer.invoke('nido:gitSwitch', id, name, create),
  gitStatus: (id) => ipcRenderer.invoke('nido:gitStatus', id),
  gitDiff: (id, path, staged) => ipcRenderer.invoke('nido:gitDiff', id, path, staged),
  gitStage: (id, path, staged) => ipcRenderer.invoke('nido:gitStage', id, path, staged),
  gitCommit: (id, message) => ipcRenderer.invoke('nido:gitCommit', id, message),
  restoreWorkspaces: () => ipcRenderer.invoke('nido:restore'),
  workspaceLayout: (ids, active) => ipcRenderer.invoke('nido:layout', ids, active),
  createWorkspace: (path, kind) => ipcRenderer.invoke('nido:create', path, kind),
  openTerminal: (id) => ipcRenderer.invoke('nido:openTerminal', id),
  restartTerminal: (id) => ipcRenderer.invoke('nido:restartTerminal', id),
  browseFolders: (path) => ipcRenderer.invoke('nido:browseFolders', path),
  closeWorkspace: (id) => ipcRenderer.invoke('nido:close', id),
  attach: (id, columns, rows) => ipcRenderer.invoke('nido:attach', id, columns, rows),
  resize: (id, columns, rows) => ipcRenderer.invoke('nido:resize', id, columns, rows),
  input: (id, keys) => ipcRenderer.invoke('nido:input', id, keys),
  setClipboardSharing: (id, enabled) => ipcRenderer.invoke('nido:clipboardSharing', id, enabled),
  openDocumentation: (url) => ipcRenderer.invoke('nido:openDocumentation', url),
  click: (id, row, column) => ipcRenderer.invoke('nido:click', id, row, column),
  scroll: (id, lines, follow, pixel) => ipcRenderer.invoke('nido:scroll', id, lines, follow, pixel),
  paste: (id, text) => ipcRenderer.invoke('nido:paste', id, text),
  pasteClipboard: (id) => ipcRenderer.invoke('nido:pasteClipboard', id),
  files: (id, path) => ipcRenderer.invoke('nido:files', id, path),
  findFiles: (id) => ipcRenderer.invoke('nido:findFiles', id),
  openFile: (id, path) => ipcRenderer.invoke('nido:openFile', id, path),
  openReference: (id, index, version) => ipcRenderer.invoke('nido:openReference', id, index, version),
  openProblem: (id, index, version) => ipcRenderer.invoke('nido:openProblem', id, index, version),
  previewReference: (id, index, version) => ipcRenderer.invoke('nido:previewReference', id, index, version),
  selectBuffer: (id, buffer) => ipcRenderer.invoke('nido:selectBuffer', id, buffer),
  closeBuffer: (id, buffer) => ipcRenderer.invoke('nido:closeBuffer', id, buffer),
  save: (id, format) => ipcRenderer.invoke('nido:save', id, format),
  debug: (id, action, target) => ipcRenderer.invoke('nido:debug', id, action, target),
  setLineEnding: (id, format) => ipcRenderer.invoke('nido:setLineEnding', id, format),
  windowAction: (action) => ipcRenderer.invoke('nido:window', action),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: NidoEvent): void => callback(event);
    ipcRenderer.on('nido:event', listener);
    return () => ipcRenderer.removeListener('nido:event', listener);
  }
};
contextBridge.exposeInMainWorld('nido', api);
