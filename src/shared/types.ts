export interface Workspace {
  kind?: 'editor' | 'terminal';
  terminalId?: string;
  id: string;
  root: string;
  name: string;
}
export interface SavedWorkspace {
  kind?: 'editor' | 'terminal';
  terminal?: boolean;
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
  problems?: { path: string; line: number; column: number; severity: number; message: string; source: string }[];
  diagnosticsVersion?: number;
  scrollCursor?: { row: number; column: number };
  diagnostics?: Record<string, number>;
  references?: ReferenceList;
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
export interface ReferenceList {
  version: number;
  loading: boolean;
  error: string;
  items: { path: string; line: number; column: number; text: string }[];
}
export interface ReferencePreview {
  first: number;
  line: number;
  lines: { text: string; color: string }[][];
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
  | { type: 'hover'; id: string; markdown: string; filetype: string; codeBlocks: ReferencePreview['lines'][] }
  | { type: 'filesChanged'; id: string }
  | { type: 'redraw'; id: string; events: Redraw }
  | { type: 'state'; id: string; state: SessionState }
  | { type: 'exit'; id: string }
  | { type: 'error'; id: string; message: string };
export interface GitChange {
  path: string;
  original?: string;
  status: string;
  staged: boolean;
}

export interface GitStatus {
  root: string;
  branch: string;
  changes: GitChange[];
}

export interface NidoAPI {
  gitHistory(id: string, skip: number): Promise<GitCommitEntry[]>;
  gitCommitFiles(id: string, hash: string): Promise<string[]>;
  gitCommitDiff(id: string, hash: string, path: string): Promise<string>;
  gitBranches(id: string): Promise<GitBranchEntry[]>;
  gitSwitch(id: string, name: string, create: boolean): Promise<void>;
  gitStatus(id: string): Promise<GitStatus>;
  gitDiff(id: string, path: string, staged: boolean): Promise<string>;
  gitStage(id: string, path: string, staged: boolean): Promise<void>;
  gitCommit(id: string, message: string): Promise<string>;
  restoreWorkspaces(): Promise<{ workspaces: Workspace[]; active: string; errors: string[] }>;
  workspaceLayout(ids: string[], active: string): Promise<void>;
  createWorkspace(path: string, kind?: 'editor' | 'terminal'): Promise<Workspace | null>;
  openTerminal(id: string): Promise<Workspace>;
  restartTerminal(id: string): Promise<void>;
  browseFolders(path?: string): Promise<{ path: string; parent: string; folders: FileEntry[] }>;
  closeWorkspace(id: string): Promise<boolean>;
  attach(id: string, columns: number, rows: number): Promise<void>;
  resize(id: string, columns: number, rows: number): Promise<void>;
  input(id: string, keys: string): Promise<void>;
  openDocumentation(url: string): Promise<void>;
  click(id: string, row: number, column: number): Promise<void>;
  scroll(id: string, lines: number, follow?: boolean, pixel?: boolean): Promise<void>;
  paste(id: string, text: string): Promise<void>;
  pasteClipboard(id: string): Promise<void>;
  files(id: string, relative: string): Promise<FileEntry[]>;
  findFiles(id: string): Promise<FileEntry[]>;
  openFile(id: string, relative: string): Promise<void>;
  openReference(id: string, index: number, version: number): Promise<void>;
  openProblem(id: string, index: number, version: number): Promise<void>;
  previewReference(id: string, index: number, version: number): Promise<ReferencePreview>;
  selectBuffer(id: string, buffer: number): Promise<void>;
  closeBuffer(id: string, buffer: number): Promise<boolean>;
  save(id: string, format?: boolean): Promise<void>;
  debug(id: string, action: DebugAction, target?: number): Promise<void>;
  setLineEnding(id: string, format: 'LF' | 'CRLF'): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  onEvent(callback: (event: NidoEvent) => void): () => void;
}

export interface GitCommitEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitBranchEntry {
  name: string;
  current: boolean;
  remote: boolean;
}
