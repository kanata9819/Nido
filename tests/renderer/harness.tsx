import { createRoot } from 'react-dom/client';
import type { ComponentProps } from 'react';
import type {
  DebugState,
  FavoriteWorkspace,
  NidoAPI,
  NidoEvent,
  ReferenceList,
  Workspace
} from '../../src/shared/types';
import App from '../../src/renderer/src/App';
import typescriptPack from '../../resources/nido/language-packs/typescript/pack.json';
import rustPack from '../../resources/nido/language-packs/rust/pack.json';
import denoPack from '../../resources/nido/language-packs/deno/pack.json';
import ExplorerCommands from '../../src/renderer/src/components/ExplorerCommands';
import FolderPicker from '../../src/renderer/src/components/FolderPicker';
import GitBrowser from '../../src/renderer/src/components/GitBrowser';
import GitDiff from '../../src/renderer/src/components/GitDiff';
import TimeMachine from '../../src/renderer/src/components/TimeMachine';
import Notification from '../../src/renderer/src/components/Notification';
import ReferencesPanel from '../../src/renderer/src/components/ReferencesPanel';
import DebugPanel from '../../src/renderer/src/components/DebugPanel';
import MarkdownPreview from '../../src/renderer/src/components/MarkdownPreview';
import PaletteItems from '../../src/renderer/src/components/PaletteItems';
import type { Item } from '../../src/renderer/src/types';
import { Favorites, GitBadges, Completion, Settings, SessionUpdates } from './Probes';
import type { SessionSettings } from '../../src/renderer/src/hooks/useSessionSettings';
import '../../src/renderer/src/assets/global.css';
import '../../src/renderer/src/assets/themes.css';

interface HarnessProps {
  debugState?: DebugState;
  workspaces: Workspace[];
  settings: SessionSettings;
  workspaceId: string;
  initialPath: string;
  favorites: FavoriteWorkspace[];
  references: ReferenceList;
  path: string;
  diff: string;
  paletteItems: Item[];
  paletteSelection: number;
  request?: ComponentProps<typeof ExplorerCommands>['request'];
}

interface Call {
  method: string;
  args: unknown[];
}

interface Harness {
  calls: Call[];
  pending: Call[];
  emit: (event: NidoEvent) => void;
  render: (updates: Partial<HarnessProps>) => void;
  settle: (method: string, index: number, value: unknown, reject?: boolean) => void;
}

declare global {
  interface Window {
    rendererTest: Harness;
  }
}

const parameters = new URLSearchParams(location.search);
const deferred = new Set(parameters.get('defer')?.split(',') || []);
const listeners = new Set<(event: NidoEvent) => void>();
const calls: Call[] = [];
const symbolVersions = new Map<string, number>();
const pending: (Call & { resolve: (value: unknown) => void; reject: (value: unknown) => void })[] =
  [];
const workspace = { id: 'alpha', root: '/alpha', name: 'Alpha' };
const defaults: Record<string, unknown> = {
  windowState: { maximized: false },
  wslDistributions: [],
  availableTerminalShells: ['auto', 'powershell.exe', 'cmd.exe'],
  favoriteWorkspaces: [],
  restoreWorkspaces: { workspaces: [workspace], active: 'alpha', errors: [] },
  files: [],
  findFiles: [],
  searchText: { matches: [], truncated: false },
  languagePacks: {
    packs: [typescriptPack, rustPack, denoPack].map((pack) => ({
      ...pack,
      bundled: true,
      enabled: true,
      status: 'ready'
    })),
    errors: []
  },
  markdownPreview: { token: '1:1', path: '/alpha/notes.md', text: '# Preview' },
  inputMode: 'n',
  gitStatus: {
    root: '/alpha',
    branch: 'main',
    changes: [
      { path: 'first.ts', status: 'M', staged: false },
      { path: 'second.ts', status: 'M', staged: false }
    ]
  },
  gitDiff: '',
  gitHistory: { commits: [], total: 0 },
  gitBranches: [],
  highlightSources: [[], []],
  previewReference: { first: 1, line: 1, lines: [[{ text: 'preview', color: '#fff' }]] },
  browseFolders: {
    path: '/alpha',
    parent: '/',
    folders: [
      { name: 'first', path: '/alpha/first', directory: true },
      { name: 'second', path: '/alpha/second', directory: true }
    ]
  }
};
window.nido = new Proxy({} as NidoAPI, {
  get(_target, method: string) {
    if (method === 'onEvent') {
      return (listener: (event: NidoEvent) => void): (() => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
    }
    return (...args: unknown[]): Promise<unknown> => {
      calls.push({ method, args });
      if (deferred.has(method)) {
        return new Promise((resolve, reject) => pending.push({ method, args, resolve, reject }));
      }
      if (method === 'findSymbols') {
        const id = String(args[0]);
        const version = (symbolVersions.get(id) ?? 0) + 1;
        symbolVersions.set(id, version);
        return Promise.resolve(version);
      }
      if (method === 'attach') {
        queueMicrotask(() => {
          window.rendererTest.emit({
            type: 'redraw',
            id: String(args[0]),
            events: [
              ['grid_resize', [1, Number(args[1]), Number(args[2])]],
              ['grid_line', [1, 0, 0, Array.from('hello', (text) => [text, 0])]],
              ['flush']
            ]
          });
        });
      }
      return Promise.resolve(defaults[method]);
    };
  }
});

const noop = (): void => {};
const root = createRoot(document.getElementById('root')!);
let props: HarnessProps = {
  workspaces: [workspace],
  settings: {
    clipboardSharing: true,
    relativeLineNumbers: true,
    editorConfig: true,
    methodSeparators: false,
    wordWrap: false
  },
  workspaceId: 'alpha',
  initialPath: '/alpha',
  favorites: [],
  path: 'first.ts',
  diff: '@@ -1 +1 @@\n-before\n+after',
  paletteItems: [],
  paletteSelection: 0,
  references: {
    version: 1,
    loading: false,
    error: '',
    items: [1, 2].map((index) => ({
      path: `/alpha/file-${index}.ts`,
      line: index,
      column: 1,
      text: `reference ${index}`
    }))
  }
};
function setPaletteSelection(update: number | ((index: number) => number)): void {
  render({
    paletteSelection: typeof update === 'function' ? update(props.paletteSelection) : update
  });
}
function render(updates: Partial<HarnessProps>): void {
  props = { ...props, ...updates };
  switch (parameters.get('view')) {
    case 'palette':
      root.render(
        <PaletteItems
          panel="problems"
          filtered={props.paletteItems}
          selection={props.paletteSelection}
          query=""
          loading={false}
          setQuery={noop}
          setSelection={setPaletteSelection}
        />
      );
      break;
    case 'markdown':
      root.render(
        <MarkdownPreview workspaceId={props.workspaceId} onClose={noop} focusEditor={noop} />
      );
      break;
    case 'debug':
      root.render(
        <>
          <button>Outside debugger</button>
          <DebugPanel state={props.debugState} focusTick={1} action={noop} onClose={noop} />
        </>
      );
      break;
    case 'app':
      root.render(<App />);
      break;
    case 'settings':
      root.render(<Settings workspaces={props.workspaces} settings={props.settings} />);
      break;
    case 'session-updates':
      root.render(<SessionUpdates />);
      break;
    case 'favorites':
      root.render(<Favorites workspace={workspace} />);
      break;
    case 'badges':
      root.render(<GitBadges workspaceId={props.workspaceId} />);
      break;
    case 'completion':
      root.render(<Completion />);
      break;
    case 'folders':
      root.render(
        <FolderPicker
          initialPath={props.initialPath}
          favorites={props.favorites}
          favoriteBusy={false}
          busy={false}
          onOpenFavorite={noop}
          onRemoveFavorite={noop}
          onOpen={noop}
        />
      );
      break;
    case 'git':
      root.render(
        <GitBrowser key={props.workspaceId} workspaceId={props.workspaceId} onClose={noop} />
      );
      break;
    case 'highlight':
      root.render(
        <GitDiff
          workspaceId={props.workspaceId}
          path={props.path}
          diff={props.diff}
          label="Diff"
          beforeLabel="Before"
          afterLabel="After"
        />
      );
      break;
    case 'history':
      root.render(
        <div style={{ display: 'flex', height: '100%' }}>
          <TimeMachine key={props.workspaceId} workspaceId={props.workspaceId} onClose={noop} />
        </div>
      );
      break;
    case 'notification':
      root.render(<Notification workspaceId={props.workspaceId} animations={true} />);
      break;
    case 'explorer':
      root.render(
        <ExplorerCommands
          workspaceId={props.workspaceId}
          request={props.request}
          commands={[]}
          onClose={noop}
          onDone={noop}
        />
      );
      break;
    case 'references':
      root.render(
        <>
          <div id="editor-preview-host" style={{ position: 'relative', height: 300 }} />
          <ReferencesPanel
            workspaceId={props.workspaceId}
            state={props.references}
            root="/alpha"
            visible={true}
            focusTick={0}
            animations={false}
            onClose={noop}
            onOpen={noop}
          />
        </>
      );
      break;
    default:
      throw new Error('Unknown renderer test view');
  }
}
window.rendererTest = {
  calls,
  pending,
  render,
  emit(event) {
    if ((event.type === 'state' || event.type === 'statePatch') && event.state.symbols) {
      symbolVersions.set(
        event.id,
        Math.max(symbolVersions.get(event.id) ?? 0, event.state.symbols.version)
      );
    }
    if (event.type === 'exit') symbolVersions.delete(event.id);
    for (const listener of listeners) listener(event);
  },
  settle(method, index, value, reject = false) {
    const call = pending.filter((entry) => entry.method === method)[index];
    if (!call) throw new Error(`No pending ${method} request at index ${index}`);
    pending.splice(pending.indexOf(call), 1);
    if (reject) call.reject(value);
    else call.resolve(value);
  }
};
render({});
