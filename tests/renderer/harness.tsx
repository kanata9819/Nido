import { createRoot } from 'react-dom/client';
import type { ComponentProps } from 'react';
import type { FavoriteWorkspace, NidoAPI, NidoEvent, ReferenceList } from '../../src/shared/types';
import App from '../../src/renderer/src/App';
import ExplorerCommands from '../../src/renderer/src/components/ExplorerCommands';
import FolderPicker from '../../src/renderer/src/components/FolderPicker';
import GitBrowser from '../../src/renderer/src/components/GitBrowser';
import GitDiff from '../../src/renderer/src/components/GitDiff';
import Notification from '../../src/renderer/src/components/Notification';
import ReferencesPanel from '../../src/renderer/src/components/ReferencesPanel';
import { Favorites, GitBadges, Completion } from './Probes';
import '../../src/renderer/src/assets/global.css';
import '../../src/renderer/src/assets/themes.css';

interface HarnessProps {
    workspaceId: string;
    initialPath: string;
    favorites: FavoriteWorkspace[];
    references: ReferenceList;
    path: string;
    diff: string;
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
const pending: (Call & { resolve: (value: unknown) => void; reject: (value: unknown) => void })[] =
    [];
const workspace = { id: 'alpha', root: '/alpha', name: 'Alpha' };
const defaults: Record<string, unknown> = {
    favoriteWorkspaces: [],
    restoreWorkspaces: { workspaces: [workspace], active: 'alpha', errors: [] },
    files: [],
    gitStatus: {
        root: '/alpha',
        branch: 'main',
        changes: [
            { path: 'first.ts', status: 'M', staged: false },
            { path: 'second.ts', status: 'M', staged: false }
        ]
    },
    gitDiff: '',
    gitHistory: [],
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
                return new Promise((resolve, reject) =>
                    pending.push({ method, args, resolve, reject })
                );
            }
            return Promise.resolve(defaults[method]);
        };
    }
});

const noop = (): void => {};
const root = createRoot(document.getElementById('root')!);
let props: HarnessProps = {
    workspaceId: 'alpha',
    initialPath: '/alpha',
    favorites: [],
    path: 'first.ts',
    diff: '@@ -1 +1 @@\n-before\n+after',
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
function render(updates: Partial<HarnessProps>): void {
    props = { ...props, ...updates };
    switch (parameters.get('view')) {
        case 'app':
            root.render(<App />);
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
                <GitBrowser
                    key={props.workspaceId}
                    workspaceId={props.workspaceId}
                    onClose={noop}
                />
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
