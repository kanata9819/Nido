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
  lsp?: string;
  empty?: boolean;
  buffers: BufferInfo[];
  current: number;
  mode: string;
  line: number;
  column: number;
  filetype: string;
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
  createWorkspace(): Promise<Workspace | null>;
  closeWorkspace(id: string): Promise<boolean>;
  attach(id: string, columns: number, rows: number): Promise<void>;
  resize(id: string, columns: number, rows: number): Promise<void>;
  input(id: string, keys: string): Promise<void>;
  paste(id: string, text: string): Promise<void>;
  pasteClipboard(id: string): Promise<void>;
  files(id: string, relative: string): Promise<FileEntry[]>;
  findFiles(id: string): Promise<FileEntry[]>;
  openFile(id: string, relative: string): Promise<void>;
  selectBuffer(id: string, buffer: number): Promise<void>;
  closeBuffer(id: string, buffer: number): Promise<boolean>;
  save(id: string): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  onEvent(callback: (event: NidoEvent) => void): () => void;
}
