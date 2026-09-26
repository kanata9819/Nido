import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from 'electron'
import { join } from 'node:path'
import { Session } from './session'
import { readLayout, writeLayout } from './persistence'
import type { NidoEvent, Workspace } from '../shared/types'

const sessions = new Map<string, Session>()
const neovimResources = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
let window: BrowserWindow
let closing = false
let prompting = false
let order: string[] = []
let active = ''
let restoration: Promise<{ workspaces: Workspace[]; active: string; errors: string[] }> | undefined
const send = (event: NidoEvent): void => {
  if (window && !window.isDestroyed()) window.webContents.send('nido:event', event)
  if (event.type === 'exit') sessions.delete(event.id)
}
function session(id: unknown): Session {
  if (typeof id !== 'string' || !sessions.has(id))
    throw new Error('Workspace is no longer running.')
  return sessions.get(id)!
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4_000_000) throw new Error('Invalid text.')
  return value
}
function integer(value: unknown, max = 1_000_000): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max)
    throw new Error('Invalid number.')
  return Number(value)
}
async function confirmClose(s: Session): Promise<boolean> {
  if (!(await s.modified())) return true
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Unsaved changes',
    message: `Save changes in ${s.workspace.name}?`,
    detail:
      'Save all files before closing this workspace. Untitled buffers need a filename (:w path).',
    buttons: ['Save all', 'Cancel', 'Discard changes'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (response === 1) return false
  if (response === 0) await s.saveAll()
  return true
}

app.setName('Nido')
app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  window = new BrowserWindow({
    title: 'Nido',
    width: 1440,
    height: 940,
    minWidth: 850,
    minHeight: 560,
    backgroundColor: '#191e23',
    frame: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (closing) return
    event.preventDefault()
    if (prompting) return
    prompting = true
    void (async () => {
      try {
        if (restoration) await restoration
        for (const s of sessions.values()) if (!(await confirmClose(s))) return
        const ids = [
          ...order.filter((id) => sessions.has(id)),
          ...[...sessions.keys()].filter((id) => !order.includes(id))
        ]
        await writeLayout(join(app.getPath('userData'), 'workspaces.json'), {
          version: 1,
          workspaces: await Promise.all(ids.map((id) => session(id).snapshot())),
          active: Math.max(0, ids.indexOf(active))
        })
        closing = true
        await Promise.all([...sessions.values()].map((s) => s.stop()))
        window.close()
      } catch (error) {
        await dialog.showMessageBox(window, { type: 'error', message: String(error) })
      } finally {
        prompting = false
      }
    })()
  })

  // Only the application renderer may invoke the explicit API below.
  const handle = (name: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(`nido:${name}`, (event, ...args: unknown[]) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        throw new Error('Untrusted sender.')
      return fn(...args)
    })
  }
  handle('restore', () => {
    restoration ??= (async () => {
      const errors: string[] = []
      try {
        const saved = await readLayout(join(app.getPath('userData'), 'workspaces.json'))
        for (const [index, workspace] of saved.workspaces.entries()) {
          try {
            const s = await Session.create(workspace.root, send, neovimResources)
            sessions.set(s.workspace.id, s)
            errors.push(...(await s.restore(workspace)))
            if (index === saved.active) active = s.workspace.id
          } catch (error) {
            errors.push(`${workspace.root}: ${String(error)}`)
          }
        }
      } catch (error) {
        errors.push(`Workspace restore failed: ${String(error)}`)
      }
      order = [...sessions.keys()]
      active ||= order[0] || ''
      return { workspaces: [...sessions.values()].map((s) => s.workspace), active, errors }
    })()
    return restoration
  })
  handle('layout', (ids, selected) => {
    if (
      !Array.isArray(ids) ||
      !ids.every((id) => typeof id === 'string' && sessions.has(id)) ||
      new Set(ids).size !== ids.length ||
      typeof selected !== 'string' ||
      (selected !== '' && !ids.includes(selected))
    )
      throw new Error('Invalid workspace layout.')
    order = ids
    active = selected
  })
  handle('create', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open a workspace in Nido',
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    const s = await Session.create(result.filePaths[0], send, neovimResources)
    sessions.set(s.workspace.id, s)
    return s.workspace
  })
  handle('close', async (id) => {
    const s = session(id)
    if (!(await confirmClose(s))) return false
    await s.stop()
    sessions.delete(s.workspace.id)
    send({ type: 'exit', id: s.workspace.id })
    return true
  })
  handle('attach', (id, columns, rows) =>
    session(id).attach(integer(columns, 1000), integer(rows, 500))
  )
  handle('resize', (id, columns, rows) =>
    session(id).resize(integer(columns, 1000), integer(rows, 500))
  )
  handle('input', (id, keys) => session(id).input(text(keys)))
  handle('paste', (id, value) => session(id).paste(text(value)))
  handle('pasteClipboard', async (id) => session(id).paste(await clipboard.readText()))
  handle('files', (id, path) => session(id).files(text(path)))
  handle('findFiles', (id) => session(id).findFiles())
  handle('openFile', (id, path) => session(id).openFile(text(path)))
  handle('selectBuffer', (id, buffer) => session(id).selectBuffer(integer(buffer)))
  handle('closeBuffer', async (id, value) => {
    const s = session(id),
      buffer = integer(value)
    if (await s.bufferModified(buffer)) {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        message: 'Discard this file’s unsaved changes?',
        buttons: ['Cancel', 'Discard'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (response !== 1) return false
    }
    await s.closeBuffer(buffer, true)
    return true
  })
  handle('save', (id) => session(id).save())
  handle('window', (action) => {
    if (action === 'minimize') window.minimize()
    else if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize()
    else if (action === 'close') window.close()
    else throw new Error('Unknown window action.')
  })
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
})
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => {
  for (const s of sessions.values()) s.process.kill()
})
