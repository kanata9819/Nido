export interface Workspace {
  id: string;
  root: string;
  name: string;
}
export interface SavedWorkspace {
  root: string;
  files: { path: string; line: number; column: number }[];
  current: string;
}
export interface BufferInfo {
  id: number;
  name: string;
  modified: boolean;
}
export interface SessionState {
  debug?: DebugState;
  lineEnding?: 'LF' | 'CRLF' | 'Mixed' | 'CR';
  lsp?: string;
  lspProgress?: string;
  empty?: boolean;
  buffers: BufferInfo[];
  current: number;
  mode: string;
  line: number;
  column: number;
  filetype: string;
}
export type DebugAction = 'start' | 'breakpoint' | 'over' | 'into' | 'out' | 'pause' | 'stop' | 'launch';
export interface DebugState {
  terminal?: string;
  status: 'idle' | 'building' | 'starting' | 'running' | 'paused' | 'finished' | 'error' | 'select';
  output: string;
  location?: string;
  variables: { name: string; value: string; type: string }[];
  targets: { name: string; path: string }[];
}
export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
}
export type Redraw = [string, ...unknown[][]][];
export type NidoEvent =
  | { type: 'redraw'; id: string; events: Redraw }
  | { type: 'state'; id: string; state: SessionState }
  | { type: 'exit'; id: string }
  | { type: 'error'; id: string; message: string };
export interface NidoAPI {
  restoreWorkspaces(): Promise<{ workspaces: Workspace[]; active: string; errors: string[] }>;
  workspaceLayout(ids: string[], active: string): Promise<void>;
  createWorkspace(path: string): Promise<Workspace | null>;
  browseFolders(path?: string): Promise<{ path: string; parent: string; folders: FileEntry[] }>;
  closeWorkspace(id: string): Promise<boolean>;
  attach(id: string, columns: number, rows: number): Promise<void>;
  resize(id: string, columns: number, rows: number): Promise<void>;
  input(id: string, keys: string): Promise<void>;
  scroll(id: string, lines: number): Promise<void>;
  paste(id: string, text: string): Promise<void>;
  pasteClipboard(id: string): Promise<void>;
  files(id: string, relative: string): Promise<FileEntry[]>;
  findFiles(id: string): Promise<FileEntry[]>;
  openFile(id: string, relative: string): Promise<void>;
  selectBuffer(id: string, buffer: number): Promise<void>;
  closeBuffer(id: string, buffer: number): Promise<boolean>;
  save(id: string): Promise<void>;
  debug(id: string, action: DebugAction, target?: number): Promise<void>;
  setLineEnding(id: string, format: 'LF' | 'CRLF'): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  onEvent(callback: (event: NidoEvent) => void): () => void;
}
