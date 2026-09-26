import { contextBridge, ipcRenderer } from 'electron';
import type { NidoAPI, NidoEvent } from '../shared/types';

const api: NidoAPI = {
  restoreWorkspaces: () => ipcRenderer.invoke('nido:restore'),
  workspaceLayout: (ids, active) => ipcRenderer.invoke('nido:layout', ids, active),
  createWorkspace: () => ipcRenderer.invoke('nido:create'),
  closeWorkspace: (id) => ipcRenderer.invoke('nido:close', id),
  attach: (id, columns, rows) => ipcRenderer.invoke('nido:attach', id, columns, rows),
  resize: (id, columns, rows) => ipcRenderer.invoke('nido:resize', id, columns, rows),
  input: (id, keys) => ipcRenderer.invoke('nido:input', id, keys),
  scroll: (id, lines) => ipcRenderer.invoke('nido:scroll', id, lines),
  paste: (id, text) => ipcRenderer.invoke('nido:paste', id, text),
  pasteClipboard: (id) => ipcRenderer.invoke('nido:pasteClipboard', id),
  files: (id, path) => ipcRenderer.invoke('nido:files', id, path),
  findFiles: (id) => ipcRenderer.invoke('nido:findFiles', id),
  openFile: (id, path) => ipcRenderer.invoke('nido:openFile', id, path),
  selectBuffer: (id, buffer) => ipcRenderer.invoke('nido:selectBuffer', id, buffer),
  closeBuffer: (id, buffer) => ipcRenderer.invoke('nido:closeBuffer', id, buffer),
  save: (id) => ipcRenderer.invoke('nido:save', id),
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
